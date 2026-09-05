/**
 * Order service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Validate that referenced customer/variant/location belong to the caller's org.
 *   4. Delegate raw DB operations to the repository (which uses transactional RPCs).
 *   5. Map DB rows to domain API shapes.
 *
 * ── ARCHITECTURE INVARIANTS ──────────────────────────────────────────────────
 *
 * SERVER-AUTHORITATIVE PRICING. There is no function here that accepts a price,
 * a line total, a subtotal or a total. CreateOrderInput has no field for one.
 * Prices are read from product_variants inside the create RPC and every
 * monetary value is derived there, with DB CHECK constraints (migration 023)
 * refusing to store a total that is not the arithmetic result of its parts. A
 * client cannot state what something costs; it can only say what it wants.
 *
 * NO ARBITRARY UPDATES. There is no updateOrder(patch) here and no generic
 * update in the repository. Status changes go through the three transition
 * functions below, each of which validates the current state against the
 * authoritative state machine, checks the permission for that specific target
 * state, and records an immutable history row in the same transaction as the
 * change. An order's status cannot move without leaving evidence of who moved
 * it and from where.
 *
 * MONEY. Integer minor units everywhere. Domain shapes expose Money
 * ({ amount, currency }) exactly as the Product domain does. No floating-point
 * arithmetic occurs on any monetary value in this file — the only arithmetic is
 * in SQL, on BIGINTs.
 *
 * ── INVENTORY INTEGRATION (WIRED, AND DELIBERATELY NOT FROM HERE) ────────────
 *
 * transitionLifecycleStatus() to `confirmed` consumes stock, and from
 * `confirmed` to `cancelled` releases it. Neither writes the ledger from this
 * file. Both movements are written by transition_order_status_v1 (migration
 * 026) inside the SAME transaction as the status change, because the failure
 * this prevents has no recovery: an application that transitions the order and
 * then calls the Inventory domain can crash between the two calls and leave a
 * confirmed order whose stock never moved, with nothing in either record to say
 * which one is wrong.
 *
 * This file therefore does NOT import @/server/inventory. That is an
 * authorization property as much as a structural one — going through
 * inventory/service.ts would demand `inventory.adjust` from every cashier who
 * confirms a sale. The human action is the order transition (orders.confirm /
 * orders.cancel); the movement is its trusted consequence. Manual stock
 * adjustments keep their own permission and their mandatory audit, untouched.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLog } from "@/server/auth/audit";
import type { Money, Currency } from "@/types";
import * as repo from "./repository";
import {
  isValidLifecycleTransition,
  isValidPaymentTransition,
  isValidFulfillmentTransition,
  isTerminalLifecycle,
  LIFECYCLE_TRANSITION_PERMISSIONS,
  PAYMENT_TRANSITION_PERMISSION,
  FULFILLMENT_TRANSITION_PERMISSIONS,
  type OrderLifecycleStatus,
  type OrderPaymentStatus,
  type OrderFulfillmentStatus,
  type OrderStatusAxis,
} from "./state-machine";
import { ORDER_SOURCES } from "./types";
import type {
  OrderRow,
  OrderItemRow,
  OrderStatusHistoryRow,
  OrderSourceDb,
  ListOrdersOptions,
} from "./types";

// ── Exported domain types ─────────────────────────────────────────────────────

export interface OrderLineDetail {
  id: string;
  productId: string;
  variantId: string;
  /** What the catalog said at sale time — never re-read from the live product. */
  productName: string;
  variantName: string | null;
  sku: string | null;
  unitPrice: Money;
  quantity: number;
  lineTotal: Money;
}

export interface OrderSummary {
  id: string;
  organizationId: string;
  /** Human-readable business reference (DATA_MODEL.md §45). Never a lookup key. */
  orderNumber: string;
  customerId: string | null;
  locationId: string | null;
  source: OrderSourceDb;
  currency: Currency;
  subtotal: Money;
  discount: Money;
  delivery: Money;
  total: Money;
  lifecycleStatus: OrderLifecycleStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Opaque provenance only — see migration 030. Never a Conversation FK. */
  sourceConversationRef: string | null;
}

export interface OrderStatusHistoryEntry {
  id: string;
  axis: OrderStatusAxis;
  fromStatus: string;
  toStatus: string;
  changedBy: string | null;
  reason: string | null;
  changedAt: string;
}

export interface OrderDetail extends OrderSummary {
  items: OrderLineDetail[];
  statusHistory: OrderStatusHistoryEntry[];
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function toMoney(amount: number, currency: string): Money {
  return { amount, currency: currency as Currency };
}

function mapOrder(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    locationId: row.location_id,
    source: row.source,
    currency: row.currency as Currency,
    subtotal: toMoney(row.subtotal_minor, row.currency),
    discount: toMoney(row.discount_minor, row.currency),
    delivery: toMoney(row.delivery_minor, row.currency),
    total: toMoney(row.total_minor, row.currency),
    lifecycleStatus: row.lifecycle_status,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceConversationRef: row.source_conversation_ref ?? null,
  };
}

function mapLine(row: OrderItemRow, currency: string): OrderLineDetail {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    productName: row.product_name_snapshot,
    variantName: row.variant_name_snapshot,
    sku: row.sku_snapshot,
    unitPrice: toMoney(row.unit_price_minor, currency),
    quantity: row.quantity,
    lineTotal: toMoney(row.line_total_minor, currency),
  };
}

function mapHistory(row: OrderStatusHistoryRow): OrderStatusHistoryEntry {
  return {
    id: row.id,
    axis: row.axis,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedBy: row.changed_by,
    reason: row.reason,
    changedAt: row.changed_at,
  };
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Best-effort audit write that genuinely cannot fail the operation it describes.
 *
 * auditLog() documents itself as never throwing on DB failures, but it can
 * still throw before it gets that far — constructing the service-role client
 * raises when the server environment is incomplete. An order that a merchant
 * has already taken money for must not be reported as failed because the audit
 * trail could not be written; the failure is logged loudly instead.
 *
 * Mandatory, fail-closed audits (MANDATORY_AUDIT_ACTIONS — refunds, payment
 * overrides) must NOT go through here. This phase performs none of them.
 */
async function bestEffortAudit(
  ctx: AuthorizationContext,
  payload: Parameters<typeof auditLog>[1],
): Promise<void> {
  try {
    await auditLog(ctx, payload);
  } catch (err) {
    console.error(
      "[APSA] order audit_log write failed (best-effort):",
      err instanceof Error ? err.message : String(err),
      { action: payload.action, organizationId: ctx.organizationId },
    );
  }
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/**
 * Maps the create RPC's business-outcome envelope to HTTP-shaped errors.
 *
 * Every cross-tenant outcome is reported as a plain 404 with no detail about
 * what was actually found: telling a caller "that customer belongs to another
 * organization" would confirm the id is real, which is the whole payload of an
 * IDOR probe.
 */
function createFailureToError(result: { status: string; variant_id?: string }): Error {
  switch (result.status) {
    case "no_items":
      return badRequest("An order must contain at least one item");
    case "invalid_quantity":
      return badRequest("Each item quantity must be a positive integer");
    case "invalid_discount":
      return badRequest("Discount must be a non-negative integer minor amount");
    case "discount_exceeds_subtotal":
      return badRequest("Discount cannot exceed the order subtotal");
    case "customer_not_found":
      return notFound("Customer not found");
    case "location_not_found":
      return notFound("Location not found");
    case "variant_not_found":
      return notFound("Product variant not found");
    case "product_variant_mismatch":
      return badRequest("variant_id does not belong to the given product_id");
    case "variant_not_sellable":
      return conflict("Product variant is not active and cannot be sold");
    case "currency_mismatch":
      return conflict("All items must be priced in the organization's currency");
    case "organization_not_found":
      return notFound("Organization not found");
    default:
      return new Error(`Order creation failed: ${result.status}`);
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreateOrderServiceInput {
  source: OrderSourceDb;
  items: Array<{ variantId: string; quantity: number; productId?: string | undefined }>;
  customerId?: string | null | undefined;
  locationId?: string | null | undefined;
  /**
   * Integer minor units in the ORGANIZATION's currency. This is an input to the
   * calculation, not a total: the RPC bounds it to 0 ≤ discount ≤ subtotal and
   * derives the total itself.
   */
  discountMinor?: number | undefined;
  /**
   * Opaque provenance identifier for the conversation this order came from
   * (Conversation -> Order linkage). Not a Conversation FK — no production
   * Conversation table exists yet (see migration 030's own comment). This is
   * a bare identifier, never conversation content: passing anything longer
   * than a plausible id is rejected rather than silently truncated.
   */
  sourceConversationRef?: string | null | undefined;
}

/** Provenance identifiers are short opaque ids, never a place to smuggle content. */
const SOURCE_CONVERSATION_REF_MAX_LENGTH = 200;

/**
 * Create a new order in `draft` lifecycle state.
 *
 * A new order is always draft/unpaid/unfulfilled. It is not a sale until
 * someone with orders.confirm confirms it — which is also the transition that
 * will consume stock. Creating and confirming in one step would mean anyone who
 * can build a cart can commit inventory.
 *
 * Validation order:
 *   1. Caller holds orders.create.
 *   2. Source is a known enum member.
 *   3. At least one item; every quantity is a positive integer.
 *   4. A discount, if non-zero, requires orders.apply_discount.
 *   5. Customer/location/variant ownership is checked against the caller's org
 *      BEFORE the write, so a cross-org id is rejected here as well as by the
 *      RPC and the DB triggers behind it.
 *   6. The RPC creates order + lines atomically, pricing them from the catalog.
 */
export async function createOrder(
  ctx: AuthorizationContext,
  input: CreateOrderServiceInput,
): Promise<OrderDetail> {
  ctx.require("orders.create");

  if (!ORDER_SOURCES.includes(input.source)) {
    throw badRequest(`Invalid order source: ${String(input.source)}`);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw badRequest("An order must contain at least one item");
  }

  for (const line of input.items) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw badRequest("Each item quantity must be a positive integer");
    }
  }

  const discountMinor = input.discountMinor ?? 0;
  if (!Number.isInteger(discountMinor) || discountMinor < 0) {
    throw badRequest("Discount must be a non-negative integer minor amount");
  }
  // Giving money away is its own authority (PERMISSIONS_MATRIX.md §14).
  if (discountMinor > 0) {
    ctx.require("orders.apply_discount");
  }

  const sourceConversationRef = input.sourceConversationRef?.trim() || null;
  if (sourceConversationRef && sourceConversationRef.length > SOURCE_CONVERSATION_REF_MAX_LENGTH) {
    throw badRequest(
      `sourceConversationRef must be at most ${SOURCE_CONVERSATION_REF_MAX_LENGTH} characters`,
    );
  }

  // Tenant ownership, checked before the write. The RPC and the DB triggers
  // check the same things; this layer exists so the caller gets a precise 404
  // instead of a raw SQL error, and so a cross-org id never reaches the
  // transaction at all.
  if (input.customerId) {
    const customer = await repo.findCustomerForOrg(ctx.organizationId, input.customerId);
    if (!customer) throw notFound("Customer not found");
  }

  if (input.locationId) {
    const location = await repo.findLocationForOrg(ctx.organizationId, input.locationId);
    if (!location) throw notFound("Location not found");
  }

  for (const line of input.items) {
    const variant = await repo.findVariantForOrg(ctx.organizationId, line.variantId);
    if (!variant) throw notFound("Product variant not found");
    if (line.productId && variant.product_id !== line.productId) {
      throw badRequest("variant_id does not belong to the given product_id");
    }
  }

  const result = await repo.createOrder(ctx.organizationId, ctx.userId, {
    source: input.source,
    items: input.items.map((line) => ({
      variant_id: line.variantId,
      quantity: line.quantity,
      product_id: line.productId,
    })),
    customer_id: input.customerId ?? null,
    location_id: input.locationId ?? null,
    discount_minor: discountMinor,
    source_conversation_ref: sourceConversationRef,
  });

  if (result.status !== "success" || !result.order_id) {
    throw createFailureToError(result);
  }

  const detail = await loadDetail(ctx.organizationId, result.order_id);
  if (!detail) {
    // The RPC reported success, so the row exists. Reaching here means the read
    // that follows it failed, not that the order was lost.
    throw new Error("Order was created but could not be read back");
  }

  // Best-effort audit. orders.create is not in MANDATORY_AUDIT_ACTIONS — a
  // failed audit write must not destroy a completed sale the merchant has
  // already taken money for. High-risk order actions that DO block on audit are
  // refunds, which this phase does not build.
  await bestEffortAudit(ctx, {
    action: "orders.create",
    resourceType: "orders",
    resourceId: detail.id,
    afterJson: {
      order_number: detail.orderNumber,
      source: detail.source,
      currency: detail.currency,
      subtotal_minor: detail.subtotal.amount,
      discount_minor: detail.discount.amount,
      total_minor: detail.total.amount,
      item_count: detail.items.length,
      ...(detail.sourceConversationRef
        ? { source_conversation_ref: detail.sourceConversationRef }
        : {}),
    },
  });

  return detail;
}

// ── Transitions ───────────────────────────────────────────────────────────────

/**
 * Shared prelude for all three axes: load the order org-scoped, and refuse
 * anything at all once the lifecycle is terminal.
 */
async function loadTransitionTarget(ctx: AuthorizationContext, orderId: string): Promise<OrderRow> {
  const order = await repo.findOrderById(ctx.organizationId, orderId);
  if (!order) throw notFound("Order not found");

  if (isTerminalLifecycle(order.lifecycle_status)) {
    throw conflict(`Order is ${order.lifecycle_status} and can no longer be modified`);
  }
  return order;
}

/** Maps the transition RPC's non-success envelopes to HTTP-shaped errors. */
function transitionFailureToError(result: { status: string; current?: string }): Error {
  switch (result.status) {
    case "not_found":
      return notFound("Order not found");
    case "stale":
      // Someone transitioned it between our read and our write.
      return conflict(
        `Order status changed concurrently (now ${result.current ?? "unknown"}) — re-read and retry`,
      );
    case "no_change":
      return conflict("Order is already in that status");
    case "terminal":
      return conflict("Order is in a terminal state and can no longer be modified");
    case "preconditions_unmet":
      return conflict("An order can only be completed once it is both paid and fulfilled");
    default:
      return new Error(`Order transition failed: ${result.status}`);
  }
}

/**
 * Move the order's lifecycle status.
 *
 * *** INVENTORY CONSEQUENCE (written by the DB, in the same transaction) ***
 *   draft -> confirmed              one 'sale'   movement per line (-quantity)
 *   confirmed -> cancelled          one 'return' movement per consumed line (+quantity)
 *   draft -> cancelled              nothing: a draft never consumed anything
 *
 * The quantity is always the PERSISTED order_items.quantity. There is no
 * quantity parameter on this function, on the repository call, or on the RPC —
 * a caller has no way to state how much stock to move, only which order to
 * transition. Stock availability is not checked: APSA's ledger permits a
 * negative derived balance and this phase deliberately does not introduce a
 * reservation or oversell policy (see migration 026).
 *
 * See ./state-machine (STOCK_CONSUMING_TRANSITION / STOCK_RELEASING_TRANSITION)
 * for the authoritative description, and migration 026 for the implementation.
 */
export async function transitionLifecycleStatus(
  ctx: AuthorizationContext,
  orderId: string,
  to: OrderLifecycleStatus,
  reason?: string | null,
): Promise<OrderDetail> {
  const permission = LIFECYCLE_TRANSITION_PERMISSIONS[to];
  if (!permission) {
    throw badRequest(`Orders cannot be moved to lifecycle status '${to}'`);
  }
  // Permission is checked before the order is loaded, so an unauthorized caller
  // cannot use timing or error shape to learn whether an order id is real.
  ctx.require(permission);

  const order = await loadTransitionTarget(ctx, orderId);
  const from = order.lifecycle_status;

  if (!isValidLifecycleTransition(from, to)) {
    throw conflict(`Cannot move order lifecycle from '${from}' to '${to}'`);
  }

  const result = await repo.transitionStatus(
    ctx.organizationId,
    orderId,
    "lifecycle",
    from,
    to,
    ctx.userId,
    reason ?? null,
  );

  if (result.status !== "success") throw transitionFailureToError(result);

  // The RPC reports how many inventory movements its transaction wrote. Record
  // it on the order's audit entry so the stock consequence of a lifecycle
  // change is legible from the order's own trail, without inventing a second
  // audit action for something no human performed.
  const stockMovements = result.stock_movements ?? 0;

  await bestEffortAudit(ctx, {
    action: to === "cancelled" ? "orders.cancel" : "orders.update",
    resourceType: "orders",
    resourceId: orderId,
    beforeJson: { lifecycle_status: from },
    afterJson: { lifecycle_status: to, inventory_movements_written: stockMovements },
    ...(reason ? { reason } : {}),
  });

  return requireDetail(ctx.organizationId, orderId);
}

/**
 * Move the order's payment status.
 *
 * Every target requires payments.confirm: whoever may declare that money
 * arrived is the same authority as whoever may declare that it did not.
 */
export async function transitionPaymentStatus(
  ctx: AuthorizationContext,
  orderId: string,
  to: OrderPaymentStatus,
  reason?: string | null,
): Promise<OrderDetail> {
  ctx.require(PAYMENT_TRANSITION_PERMISSION);

  const order = await loadTransitionTarget(ctx, orderId);
  const from = order.payment_status;

  if (!isValidPaymentTransition(from, to)) {
    throw conflict(`Cannot move payment status from '${from}' to '${to}'`);
  }

  const result = await repo.transitionStatus(
    ctx.organizationId,
    orderId,
    "payment",
    from,
    to,
    ctx.userId,
    reason ?? null,
  );

  if (result.status !== "success") throw transitionFailureToError(result);

  await bestEffortAudit(ctx, {
    action: "payments.confirm",
    resourceType: "orders",
    resourceId: orderId,
    beforeJson: { payment_status: from },
    afterJson: { payment_status: to },
    ...(reason ? { reason } : {}),
  });

  return requireDetail(ctx.organizationId, orderId);
}

/** Move the order's fulfillment status. */
export async function transitionFulfillmentStatus(
  ctx: AuthorizationContext,
  orderId: string,
  to: OrderFulfillmentStatus,
  reason?: string | null,
): Promise<OrderDetail> {
  ctx.require(FULFILLMENT_TRANSITION_PERMISSIONS[to]);

  const order = await loadTransitionTarget(ctx, orderId);
  const from = order.fulfillment_status;

  if (!isValidFulfillmentTransition(from, to)) {
    throw conflict(`Cannot move fulfillment status from '${from}' to '${to}'`);
  }

  const result = await repo.transitionStatus(
    ctx.organizationId,
    orderId,
    "fulfillment",
    from,
    to,
    ctx.userId,
    reason ?? null,
  );

  if (result.status !== "success") throw transitionFailureToError(result);

  await bestEffortAudit(ctx, {
    action: "orders.update",
    resourceType: "orders",
    resourceId: orderId,
    beforeJson: { fulfillment_status: from },
    afterJson: { fulfillment_status: to },
    ...(reason ? { reason } : {}),
  });

  return requireDetail(ctx.organizationId, orderId);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

async function loadDetail(organizationId: string, orderId: string): Promise<OrderDetail | null> {
  const order = await repo.findOrderById(organizationId, orderId);
  if (!order) return null;

  const [items, history] = await Promise.all([
    repo.listOrderItems(organizationId, orderId),
    repo.listStatusHistory(organizationId, orderId),
  ]);

  return {
    ...mapOrder(order),
    items: items.map((line) => mapLine(line, order.currency)),
    statusHistory: history.map(mapHistory),
  };
}

async function requireDetail(organizationId: string, orderId: string): Promise<OrderDetail> {
  const detail = await loadDetail(organizationId, orderId);
  if (!detail) throw notFound("Order not found");
  return detail;
}

/**
 * Fetch one order with its lines and status history.
 *
 * Org-scoped: an order belonging to another organization produces exactly the
 * same 404 as one that does not exist, so a guessed UUID reveals nothing.
 */
export async function getOrderById(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<OrderDetail> {
  ctx.require("orders.read");
  return requireDetail(ctx.organizationId, orderId);
}

/** Orders newest first, org-scoped, optionally filtered. Summaries only — no line items. */
export async function listOrders(
  ctx: AuthorizationContext,
  opts: ListOrdersOptions = {},
): Promise<OrderSummary[]> {
  ctx.require("orders.read");
  const rows = await repo.listOrders(ctx.organizationId, opts);
  return rows.map(mapOrder);
}
