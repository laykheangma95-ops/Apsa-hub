/**
 * Customer Returns — server-authoritative returns of delivered orders, restocked
 * through the inventory ledger only.
 *
 *   In Transit → Delivered → Return Requested → Return Received → Inspect
 *   (resellable / damaged per line) → Complete Return
 *
 * Nothing moves stock until completion. Completion (migration 056's
 * complete_customer_return_v1) appends, per line, ONE `return` movement of
 * +quantity and — when some units are damaged — ONE `damage` movement of
 * −damaged. Resellable units become available; damaged units are recorded but
 * never sellable. Stock is never written as a number; the balance stays
 * SUM(inventory_movements).
 *
 * Security:
 *   - Every call requires orders.return (PERMISSIONS_MATRIX.md §14; migration
 *     056 seeds it to OWNER + MANAGER) and orders.read, checked before any
 *     lookup.
 *   - Tenant isolation: the organization comes from the AuthorizationContext
 *     only. An order number, order id or return id belonging to another
 *     organization resolves exactly like one that does not exist, here and
 *     again inside every RPC.
 *   - The client never states a movement type, a delta, a product, a location
 *     or a balance. It names an order and per-line quantities (request), and
 *     per-line damaged counts (inspect / complete); the server derives and
 *     re-checks everything else.
 *   - No money, phone or address leaves this module: a return shows order
 *     number, item names and quantities only.
 *
 * Duplicate and race safety (enforced in SQL, see migration 056):
 *   - one request key per requested return; a retry replays, a reused key for a
 *     different request is a conflict;
 *   - receive / inspect / complete are idempotent by state, under row locks;
 *   - completion names the inspection the merchant confirmed, and is refused
 *     as `stale` if it changed in between.
 *
 * Not built here (by instruction): refunds, exchanges, return shipping labels,
 * courier return workflow, warehouse routing, approvals, batch processing,
 * photos, notes, supplier returns.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import {
  MAX_ORDER_NUMBER_LENGTH,
  MAX_RETURN_LINES,
  MAX_RETURN_QUANTITY,
  returnTotals,
  type InspectionLine,
  type RequestReturnResult,
  type ReturnDetail,
  type ReturnDetailResult,
  type ReturnRequestLine,
  type ReturnStepResult,
  type ReturnSummary,
  type ReturnableOrderResult,
} from "@/lib/returns";
import * as repo from "./repository";

/** Most returns one list call returns (newest first). */
export const RETURNS_LIST_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETURNABLE_LIFECYCLES = new Set(["confirmed", "completed"]);

// ── Guards ────────────────────────────────────────────────────────────────────

/** Every returns call: return authority, and the right to see the order. */
function requireReturnAccess(ctx: AuthorizationContext): void {
  ctx.require("orders.return");
  ctx.require("orders.read");
}

function assertRequestLines(lines: readonly ReturnRequestLine[]): void {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_RETURN_LINES) {
    throw publicError(`lines must contain 1 to ${MAX_RETURN_LINES} items`, 400);
  }
  for (const line of lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_RETURN_QUANTITY
    ) {
      throw publicError(
        `quantity must be a whole number between 1 and ${MAX_RETURN_QUANTITY}`,
        400,
      );
    }
  }
}

/** Shape only; ownership and per-line limits are the RPC's to decide. Null = malformed. */
function toInspectionLinesDb(
  lines: readonly InspectionLine[],
): Array<{ return_item_id: string; damaged_quantity: number }> | null {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_RETURN_LINES) return null;
  const out: Array<{ return_item_id: string; damaged_quantity: number }> = [];
  for (const line of lines) {
    if (typeof line.returnItemId !== "string" || !UUID_RE.test(line.returnItemId)) return null;
    if (
      !Number.isInteger(line.damagedQuantity) ||
      line.damagedQuantity < 0 ||
      line.damagedQuantity > MAX_RETURN_QUANTITY
    ) {
      return null;
    }
    out.push({ return_item_id: line.returnItemId, damaged_quantity: line.damagedQuantity });
  }
  return out;
}

// ── Read models ───────────────────────────────────────────────────────────────

function toDetail(
  row: repo.CustomerReturnRow,
  orderNumber: string,
  items: repo.CustomerReturnItemRow[],
  events: repo.CustomerReturnEventRow[],
): ReturnDetail {
  const lines = items.map((item) => ({
    returnItemId: item.id,
    orderItemId: item.order_item_id,
    productName: item.product_name_snapshot,
    variantName: item.variant_name_snapshot,
    sku: item.sku_snapshot,
    quantity: item.quantity,
    damagedQuantity: item.damaged_quantity,
    resellableQuantity:
      item.damaged_quantity === null ? null : item.quantity - item.damaged_quantity,
    returnMovementId: item.return_movement_id,
    damageMovementId: item.damage_movement_id,
  }));
  return {
    returnId: row.id,
    orderId: row.order_id,
    orderNumber,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    history: events.map((event) => ({
      fromStatus: event.from_status,
      toStatus: event.to_status,
      at: event.created_at,
    })),
    totals: returnTotals(lines),
  };
}

async function loadDetail(
  ctx: AuthorizationContext,
  returnId: string,
): Promise<ReturnDetail | null> {
  const row = await repo.findReturn(ctx.organizationId, returnId);
  if (!row) return null;
  const [orders, items, events] = await Promise.all([
    repo.listOrderRefs(ctx.organizationId, [row.order_id]),
    repo.listReturnItems(ctx.organizationId, [row.id]),
    repo.listReturnEvents(ctx.organizationId, row.id),
  ]);
  return toDetail(row, orders[0]?.order_number ?? "", items, events);
}

/** Newest first. Order number and unit count only. */
export async function listCustomerReturns(
  ctx: AuthorizationContext,
): Promise<{ returns: ReturnSummary[] }> {
  requireReturnAccess(ctx);

  const rows = await repo.listReturns(ctx.organizationId, RETURNS_LIST_LIMIT);
  if (rows.length === 0) return { returns: [] };

  const [orders, items] = await Promise.all([
    repo.listOrderRefs(ctx.organizationId, [...new Set(rows.map((row) => row.order_id))]),
    repo.listReturnItems(
      ctx.organizationId,
      rows.map((row) => row.id),
    ),
  ]);
  const orderNumbers = new Map(orders.map((order) => [order.id, order.order_number]));
  const units = new Map<string, number>();
  for (const item of items)
    units.set(item.return_id, (units.get(item.return_id) ?? 0) + item.quantity);

  return {
    returns: rows.map((row) => ({
      returnId: row.id,
      orderId: row.order_id,
      orderNumber: orderNumbers.get(row.order_id) ?? "",
      status: row.status,
      quantity: units.get(row.id) ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export async function getCustomerReturn(
  ctx: AuthorizationContext,
  returnId: string,
): Promise<ReturnDetailResult> {
  requireReturnAccess(ctx);
  if (typeof returnId !== "string" || !UUID_RE.test(returnId)) return { kind: "return_not_found" };

  const detail = await loadDetail(ctx, returnId);
  return detail ? { kind: "return", detail } : { kind: "return_not_found" };
}

/**
 * Find a delivered order by its number and show what can still come back.
 * Read-only; the request RPC re-checks every figure under the order lock.
 */
export async function findReturnableOrder(
  ctx: AuthorizationContext,
  orderNumber: string,
): Promise<ReturnableOrderResult> {
  requireReturnAccess(ctx);

  const trimmed = typeof orderNumber === "string" ? orderNumber.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_ORDER_NUMBER_LENGTH) {
    return { kind: "order_not_found" };
  }

  const order = await repo.findOrderByNumber(ctx.organizationId, trimmed);
  if (!order) return { kind: "order_not_found" };
  if (!RETURNABLE_LIFECYCLES.has(order.lifecycle_status)) return { kind: "order_not_returnable" };
  if (!(await repo.hasDeliveredDelivery(ctx.organizationId, order.id))) {
    return { kind: "order_not_delivered" };
  }

  const items = await repo.listOrderItems(ctx.organizationId, order.id);
  const itemIds = items.map((item) => item.id);
  const [sold, requested] = await Promise.all([
    repo.listSoldOrderItemIds(ctx.organizationId, itemIds),
    repo.listRequestedQuantities(ctx.organizationId, itemIds),
  ]);
  const soldSet = new Set(sold);
  const already = new Map<string, number>();
  for (const row of requested) {
    already.set(row.order_item_id, (already.get(row.order_item_id) ?? 0) + row.quantity);
  }

  return {
    kind: "order",
    order: {
      orderId: order.id,
      orderNumber: order.order_number,
      // A line whose stock never left (no sale movement) cannot come back.
      lines: items
        .filter((item) => soldSet.has(item.id))
        .map((item) => {
          const alreadyReturned = already.get(item.id) ?? 0;
          return {
            orderItemId: item.id,
            productName: item.product_name_snapshot,
            variantName: item.variant_name_snapshot,
            sku: item.sku_snapshot,
            orderedQuantity: item.quantity,
            alreadyReturned,
            returnableQuantity: Math.max(item.quantity - alreadyReturned, 0),
          };
        }),
    },
  };
}

// ── Request ───────────────────────────────────────────────────────────────────

export interface RequestCustomerReturnInput {
  requestKey: string;
  orderId: string;
  lines: ReturnRequestLine[];
}

/**
 * Validation order:
 *   1. orders.return + orders.read — before anything is read.
 *   2. Request key, line shape and quantity bounds.
 *   3. Everything else is decided atomically by request_customer_return_v1:
 *      key replay/conflict → order ownership and lifecycle → delivered →
 *      line ownership, sale movement, remaining quantity → return + history +
 *      audit.
 */
export async function requestCustomerReturn(
  ctx: AuthorizationContext,
  input: RequestCustomerReturnInput,
): Promise<RequestReturnResult> {
  requireReturnAccess(ctx);

  if (typeof input.requestKey !== "string" || !UUID_RE.test(input.requestKey)) {
    throw publicError("request_key must be a UUID", 400);
  }
  assertRequestLines(input.lines);
  if (typeof input.orderId !== "string" || !UUID_RE.test(input.orderId)) {
    return { kind: "order_not_found" };
  }
  if (
    input.lines.some(
      (line) => typeof line.orderItemId !== "string" || !UUID_RE.test(line.orderItemId),
    )
  ) {
    return { kind: "invalid_items" };
  }

  const result = await repo.requestReturn(ctx.organizationId, ctx.userId, {
    request_key: input.requestKey,
    order_id: input.orderId,
    items: input.lines.map((line) => ({
      order_item_id: line.orderItemId,
      quantity: line.quantity,
    })),
  });

  switch (result.status) {
    case "requested":
      return { kind: "requested", returnId: result.return_id, replayed: false };
    case "replayed":
      return { kind: "requested", returnId: result.return_id, replayed: true };
    case "quantity_exceeds_remaining":
      return { kind: "quantity_exceeds_remaining", remaining: result.remaining ?? 0 };
    case "request_conflict":
    case "invalid_items":
    case "order_not_found":
    case "order_not_returnable":
    case "order_not_delivered":
    case "item_not_in_order":
    case "item_not_returnable":
      return { kind: result.status };
  }
}

// ── Receive / inspect / complete ──────────────────────────────────────────────

async function stepResult(
  ctx: AuthorizationContext,
  returnId: string,
  result: repo.ReturnStepRpcResult,
): Promise<ReturnStepResult> {
  switch (result.status) {
    case "received":
    case "inspected":
    case "completed":
    case "replayed": {
      const detail = await loadDetail(ctx, returnId);
      if (!detail) return { kind: "return_not_found" };
      return { kind: "ok", detail, replayed: result.status === "replayed" };
    }
    case "stale": {
      const detail = await loadDetail(ctx, returnId);
      if (!detail) return { kind: "return_not_found" };
      return { kind: "stale", detail };
    }
    case "return_not_found":
    case "not_received":
    case "not_inspected":
    case "already_completed":
    case "invalid_lines":
    case "order_not_returnable":
      return { kind: result.status };
  }
}

/** The parcel is physically back: requested → received. Writes no stock. */
export async function receiveCustomerReturn(
  ctx: AuthorizationContext,
  returnId: string,
): Promise<ReturnStepResult> {
  requireReturnAccess(ctx);
  if (typeof returnId !== "string" || !UUID_RE.test(returnId)) return { kind: "return_not_found" };

  const result = await repo.receiveReturn(ctx.organizationId, ctx.userId, returnId);
  return stepResult(ctx, returnId, result);
}

/**
 * Record the inspection: per line, how many units are damaged (the rest are
 * resellable). Every line exactly once. Re-recordable until completion.
 * Writes no stock.
 */
export async function inspectCustomerReturn(
  ctx: AuthorizationContext,
  input: { returnId: string; lines: InspectionLine[] },
): Promise<ReturnStepResult> {
  requireReturnAccess(ctx);
  if (typeof input.returnId !== "string" || !UUID_RE.test(input.returnId)) {
    return { kind: "return_not_found" };
  }
  const lines = toInspectionLinesDb(input.lines);
  if (lines === null) return { kind: "invalid_lines" };

  const result = await repo.inspectReturn(ctx.organizationId, ctx.userId, input.returnId, lines);
  return stepResult(ctx, input.returnId, result);
}

/**
 * Complete the return: the ledger movements, history and audit, atomically —
 * for exactly the inspection the merchant confirmed (`expected`), or nothing.
 */
export async function completeCustomerReturn(
  ctx: AuthorizationContext,
  input: { returnId: string; expected: InspectionLine[] },
): Promise<ReturnStepResult> {
  requireReturnAccess(ctx);
  if (typeof input.returnId !== "string" || !UUID_RE.test(input.returnId)) {
    return { kind: "return_not_found" };
  }
  const expected = toInspectionLinesDb(input.expected);
  if (expected === null) return { kind: "invalid_lines" };

  const result = await repo.completeReturn(
    ctx.organizationId,
    ctx.userId,
    input.returnId,
    expected,
  );
  return stepResult(ctx, input.returnId, result);
}
