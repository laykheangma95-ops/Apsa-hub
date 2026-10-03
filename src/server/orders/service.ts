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
import { publicError } from "@/server/public-domain-error";
import { reportServerError } from "@/server/observability/errors";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLog } from "@/server/auth/audit";
import { RateLimitedError } from "@/server/rate-limit/errors";
import { checkRateLimits } from "@/server/rate-limit/limiter";
import { BACKEND_FAILURE_POLICY, RATE_LIMITS } from "@/server/rate-limit/policies";
import type { Money, Currency } from "@/types";
import * as repo from "./repository";
import {
  isValidLifecycleTransition,
  isValidFulfillmentTransition,
  isTerminalLifecycle,
  LIFECYCLE_TRANSITION_PERMISSIONS,
  FULFILLMENT_TRANSITION_PERMISSIONS,
  type OrderLifecycleStatus,
  type OrderPaymentStatus,
  type OrderRefundStatus,
  type OrderFulfillmentStatus,
  type OrderStatusAxis,
} from "./state-machine";
import { ORDER_CODE_MAX_LENGTH, normalizeOrderCode } from "@/lib/order-code";
import { isReservedOperationalReason } from "@/lib/operational-reasons";
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
  refundStatus: OrderRefundStatus;
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
    refundStatus: row.refund_status ?? "none",
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
    reportServerError(err, {
      event: "orders.best_effort_audit_failed",
      action: payload.action,
      organizationId: ctx.organizationId,
    });
  }
}

function badRequest(message: string): Error {
  return publicError(message, 400);
}

/**
 * Generic transitions accept a free-text reason; a reserved operational marker
 * (e.g. Pack Order's packed reason) may only be written by its owning service.
 */
function rejectReservedReason(reason: string | null | undefined): void {
  if (isReservedOperationalReason(reason)) {
    throw badRequest("This reason is reserved for an internal workflow");
  }
}

function notFound(message: string): Error {
  return publicError(message, 404);
}

function conflict(message: string): Error {
  return publicError(message, 409);
}

// ── Shipping destination snapshot (§4, §19) ────────────────────────────────────

/** Upper bounds mirror the migration-047 CHECK constraints. */
const SHIPPING_NAME_MAX = 200;
const SHIPPING_PHONE_MAX = 40;
const SHIPPING_ADDRESS_MAX = 1000;

/** The normalized snapshot the domain persists. Null address is a valid pickup order. */
export interface NormalizedShippingSnapshot {
  name: string | null;
  phone: string | null;
  address: string | null;
}

/**
 * Trim, collapse internal whitespace, and reject anything carrying control
 * characters or HTML angle brackets — a label prints these verbatim, so they
 * must never smuggle markup or invisible characters (§19: "no HTML/script
 * authority"). Khmer is fully supported: nothing here is ASCII-only.
 */
function cleanShippingText(value: string): string {
  // Map control characters (incl. DEL) to a space by code point, then collapse
  // whitespace — done without a control-character regex on purpose.
  const stripped = [...value]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("");
  return stripped.replace(/\s+/gu, " ").trim();
}

function hasMarkup(value: string): boolean {
  return /[<>]/u.test(value);
}

/** Digits only, across ASCII and Khmer numerals. */
function shippingPhoneDigits(value: string): string {
  const map: Record<string, string> = {
    "០": "0",
    "១": "1",
    "២": "2",
    "៣": "3",
    "៤": "4",
    "៥": "5",
    "៦": "6",
    "៧": "7",
    "៨": "8",
    "៩": "9",
  };
  return [...value]
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/\D/gu, "");
}

/**
 * Phone formatting a merchant may reasonably type: digits (ASCII or Khmer),
 * spaces, and the separators ( ) - . — with one optional leading "+". Anything
 * else (letters, "ext", stray symbols) is decoration a courier cannot dial, so
 * it is rejected rather than stored on a printed label. Not tied to a single
 * national format; the digit count below bounds plausibility.
 */
const SHIPPING_PHONE_FORMAT = /^\+?[\d០-៩\s().-]+$/u;

/**
 * Validate and normalize a shipping destination snapshot.
 *
 * Returns null when nothing at all was supplied (a pickup / no-delivery order —
 * a valid state). When ANY field is supplied the destination is treated as
 * "shipping required", so a recipient name AND an address are both mandatory
 * (§19); the phone is optional but, when present, must be a plausible number.
 * Throws a 400 on any violation — the server owns this validation, never the
 * client (§4).
 */
export function normalizeShippingSnapshot(
  input:
    | {
        name?: string | null | undefined;
        phone?: string | null | undefined;
        address?: string | null | undefined;
      }
    | null
    | undefined,
): NormalizedShippingSnapshot | null {
  if (!input) return null;

  const rawName = typeof input.name === "string" ? cleanShippingText(input.name) : "";
  const rawPhone = typeof input.phone === "string" ? cleanShippingText(input.phone) : "";
  const rawAddress = typeof input.address === "string" ? cleanShippingText(input.address) : "";

  // Nothing supplied at all → no snapshot (pickup order).
  if (!rawName && !rawPhone && !rawAddress) return null;

  if (hasMarkup(rawName) || hasMarkup(rawPhone) || hasMarkup(rawAddress)) {
    throw badRequest("Shipping details must not contain HTML");
  }

  if (!rawName) throw badRequest("A recipient name is required for a shipping destination");
  if (rawName.length > SHIPPING_NAME_MAX) {
    throw badRequest(`Recipient name must be at most ${SHIPPING_NAME_MAX} characters`);
  }

  if (!rawAddress) throw badRequest("A delivery address is required for a shipping destination");
  if (rawAddress.length > SHIPPING_ADDRESS_MAX) {
    throw badRequest(`Delivery address must be at most ${SHIPPING_ADDRESS_MAX} characters`);
  }

  let phone: string | null = null;
  if (rawPhone) {
    if (rawPhone.length > SHIPPING_PHONE_MAX) {
      throw badRequest(`Phone must be at most ${SHIPPING_PHONE_MAX} characters`);
    }
    const digits = shippingPhoneDigits(rawPhone);
    if (!SHIPPING_PHONE_FORMAT.test(rawPhone) || digits.length < 6 || digits.length > 15) {
      throw badRequest("A valid phone number is required");
    }
    phone = rawPhone;
  }

  return { name: rawName, phone, address: rawAddress };
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
    case "invalid_delivery_fee":
      return badRequest("Delivery fee must be a non-negative integer minor amount within bounds");
    case "invalid_idempotency_key":
      return badRequest("A valid idempotency key is required to create an order");
    case "idempotency_conflict":
      // Deliberately carries nothing about the stored order: the key was used
      // for a different request, or by a different member.
      return Object.assign(
        conflict("This idempotency key was already used for a different order request"),
        { code: "idempotency_conflict" },
      );
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
  /**
   * Delivery fee the merchant charges the customer — integer minor units in the
   * ORGANIZATION's currency. An input to the calculation, never a total: the
   * RPC bounds it per currency and adds it into the derived total itself.
   * Never the courier's cost to the merchant.
   */
  deliveryMinor?: number | undefined;
  /**
   * One logical order-creation attempt, generated once by the client and
   * reused on every retry of that attempt (migration 044). A replay returns
   * the order the first attempt created; a reuse for a different request is a
   * 409 idempotency conflict.
   */
  idempotencyKey: string;
  /**
   * Optional order shipping destination — the parcel's authoritative
   * destination, snapshotted onto the order at creation (§4, migration 047).
   * Validated and normalized server-side; folded into the idempotency
   * fingerprint so a retry with a different address is a conflict, not a silent
   * re-address. Omit for an in-store pickup / no-delivery order.
   */
  shipping?:
    | {
        name?: string | null | undefined;
        phone?: string | null | undefined;
        address?: string | null | undefined;
      }
    | undefined;
}

/** Provenance identifiers are short opaque ids, never a place to smuggle content. */
const SOURCE_CONVERSATION_REF_MAX_LENGTH = 200;

/** Same shape the database enforces (orders_idempotency_key_format). */
export const ORDER_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Abuse protection for order creation — NOT a replacement for idempotency.
 *
 *   idempotency (migration 044): the same logical request → one order.
 *   this limit: one member / one organization cannot flood APSA with thousands
 *     of valid, unique requests (limits and rationale: rate-limit/policies.ts).
 *
 * A retry of an order this member ALREADY created under this key is recovery,
 * not volume: when a bucket is full the key is looked up, and a replay is let
 * through to create_order_v2, which returns the stored order. So a merchant
 * whose response was lost can always get their order back, even at the limit.
 */
async function enforceOrderCreateLimit(
  ctx: AuthorizationContext,
  idempotencyKey: string,
): Promise<void> {
  const decision = await checkRateLimits(
    [
      { rule: RATE_LIMITS.orderCreateMember, parts: [ctx.organizationId, ctx.userId] },
      { rule: RATE_LIMITS.orderCreateOrganization, parts: [ctx.organizationId] },
    ],
    undefined,
    { onBackendFailure: BACKEND_FAILURE_POLICY.orderCreate },
  );
  if (decision.allowed) return;
  if (await repo.orderExistsForIdempotencyKey(ctx.organizationId, ctx.userId, idempotencyKey)) {
    return;
  }
  throw new RateLimitedError(decision.retryAfterSeconds);
}

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
 *   6. The RPC creates order + lines atomically, pricing them from the catalog
 *      and adding the bounded delivery fee into the derived total.
 *
 * Idempotency (migration 044): the RPC checks `idempotencyKey` before any
 * catalog validation or write. The same key + same request + same member
 * returns the order the first attempt created (no second order number, no
 * second audit row); the same key with a different request or member is a 409.
 */
export async function createOrder(
  ctx: AuthorizationContext,
  input: CreateOrderServiceInput,
): Promise<OrderDetail> {
  ctx.require("orders.create");

  if (
    typeof input.idempotencyKey !== "string" ||
    !ORDER_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
  ) {
    throw badRequest("A valid idempotency key is required to create an order");
  }

  await enforceOrderCreateLimit(ctx, input.idempotencyKey);

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

  const deliveryMinor = input.deliveryMinor ?? 0;
  if (!Number.isSafeInteger(deliveryMinor) || deliveryMinor < 0) {
    throw badRequest("Delivery fee must be a non-negative integer minor amount within bounds");
  }

  const sourceConversationRef = input.sourceConversationRef?.trim() || null;
  if (sourceConversationRef && sourceConversationRef.length > SOURCE_CONVERSATION_REF_MAX_LENGTH) {
    throw badRequest(
      `sourceConversationRef must be at most ${SOURCE_CONVERSATION_REF_MAX_LENGTH} characters`,
    );
  }

  // The order-authoritative shipping destination, validated and normalized here
  // (the server owns this — §4). null for a pickup order. Its presence — never
  // its values — reaches the audit row below.
  const shipping = normalizeShippingSnapshot(input.shipping);

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
    delivery_minor: deliveryMinor,
    source_conversation_ref: sourceConversationRef,
    idempotency_key: input.idempotencyKey,
    ...(shipping ? { shipping } : {}),
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

  // A replay created nothing, so it records nothing: the first attempt already
  // wrote this order's audit row, and a second one would read as a second sale.
  if (result.replayed) return detail;

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
      delivery_minor: detail.delivery.amount,
      total_minor: detail.total.amount,
      item_count: detail.items.length,
      ...(detail.sourceConversationRef
        ? { source_conversation_ref: detail.sourceConversationRef }
        : {}),
      // PII-safe: record only WHICH shipping fields were captured, never their
      // values (§11 audit). A shipping snapshot is fulfillment PII.
      shipping_snapshot: shipping
        ? {
            name: shipping.name !== null,
            phone: shipping.phone !== null,
            address: shipping.address !== null,
          }
        : false,
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
    case "retry":
      // The order's delivery kept changing during a reopen; nothing was written.
      return conflict("Order delivery changed concurrently — re-read and retry");
    case "no_change":
      return conflict("Order is already in that status");
    case "terminal":
    case "order_terminal":
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
  rejectReservedReason(reason);

  const order = await loadTransitionTarget(ctx, orderId);
  const from = order.lifecycle_status;

  if (!isValidLifecycleTransition(from, to)) {
    throw conflict(`Cannot move order lifecycle from '${from}' to '${to}'`);
  }

  // Confirming creates the order's APSA Parcel inside the same database
  // transaction, under the order lock (migration 057, CORRECTION-003): the
  // confirmation and the parcel commit together or not at all.
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

  // Every confirmed order owns its APSA Parcel from the moment it is confirmed.
  // Migration 057 creates it inside the confirming transaction and reports it
  // back; a database that has not applied 057 yet confirms without one, which
  // left fresh orders with no parcel and a failing parcel label. Then it is
  // created here, still as part of confirmation, idempotently (one active
  // parcel per order is enforced by uniq_parcels_org_order_active). A failure
  // is reported, never swallowed: no label path creates the parcel later.
  if (to === "confirmed" && !result.parcel_id) {
    const { ensureParcelForOrder } = await import("@/server/parcels/service");
    try {
      await ensureParcelForOrder(ctx.organizationId, ctx.userId, orderId);
    } catch (err) {
      reportServerError(err, {
        event: "orders.parcel_generation_failed",
        organizationId: ctx.organizationId,
      });
      throw err;
    }
  }

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
 * @deprecated Retained for caller compatibility. Payment records are the sole
 * financial authority; use the Payment API to record and verify settlement.
 */
export async function transitionPaymentStatus(
  ctx: AuthorizationContext,
  _orderId: string,
  _to: OrderPaymentStatus,
  _reason?: string | null,
): Promise<OrderDetail> {
  ctx.require("payments.manual_confirm");
  throw conflict("Order payment transitions are deprecated; use the Payment domain");
}

/** How many times a reopen is re-run after the RPC reports a concurrent delivery change. */
const REOPEN_ATTEMPTS = 3;

/**
 * reopen_order_fulfillment_v1 returns 'retry' — writing nothing — when the
 * order's active delivery was created or changed between its delivery lookup
 * and its order lock. Each attempt is a fresh transaction that sees the new
 * delivery; if the order keeps changing, the caller gets a retryable conflict.
 */
async function reopenFulfillmentWithRetry(
  ctx: AuthorizationContext,
  orderId: string,
  reason: string | null,
) {
  for (let attempt = 1; ; attempt++) {
    const result = await repo.reopenFulfillment(ctx.organizationId, orderId, ctx.userId, reason);
    if (result.status !== "retry" || attempt >= REOPEN_ATTEMPTS) return result;
  }
}

/** Move the order's fulfillment status. */
export async function transitionFulfillmentStatus(
  ctx: AuthorizationContext,
  orderId: string,
  to: OrderFulfillmentStatus,
  reason?: string | null,
): Promise<OrderDetail> {
  ctx.require(FULFILLMENT_TRANSITION_PERMISSIONS[to]);
  rejectReservedReason(reason);

  const order = await loadTransitionTarget(ctx, orderId);
  const from = order.fulfillment_status;

  if (!isValidFulfillmentTransition(from, to)) {
    throw conflict(`Cannot move fulfillment status from '${from}' to '${to}'`);
  }

  /*
   * Reopening (processing → unfulfilled) means packing must start over: the
   * order's packed state clears and a 'ready' delivery is cancelled in the
   * same transaction, so a reopened order cannot reach Courier Handoff without
   * Pack Order again.
   */
  const result =
    from === "processing" && to === "unfulfilled"
      ? await reopenFulfillmentWithRetry(ctx, orderId, reason ?? null)
      : await repo.transitionStatus(
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

// ── Shipping destination snapshot (set / confirm / correct) ────────────────────

/** Maps the update_order_shipping_v1 envelope to HTTP-shaped errors. */
function shippingUpdateFailureToError(result: { status: string }): Error {
  switch (result.status) {
    case "order_not_found":
      return notFound("Order not found");
    case "order_terminal":
      return conflict("Order is complete or cancelled; its shipping destination cannot be changed");
    case "fulfillment_terminal":
      return conflict(
        "This order is already fulfilled or its delivery is cancelled; its shipping destination can no longer be changed",
      );
    case "invalid_shipping":
      return badRequest("Shipping details are invalid");
    default:
      return new Error(`Shipping update failed: ${result.status}`);
  }
}

/**
 * Set, confirm, or correct an order's shipping destination snapshot before
 * fulfillment (§4, §9, §10).
 *
 * This is the human "Confirm shipping address" / "Edit destination" action:
 *   - an order created before the snapshot existed (no destination) is
 *     confirmed by supplying one, which unblocks its first parcel label; and
 *   - a destination captured at creation is corrected while the parcel is still
 *     on the packing bench.
 *
 * Authorized by orders.update — the narrowest existing fulfillment capability
 * (state-machine.ts already uses it for fulfillment moves), so no new capability
 * is invented. The RPC refuses once lifecycle or fulfillment is terminal, so a
 * shipped/closed parcel's historical destination is never casually rewritten.
 *
 * A destination is REQUIRED here: you cannot "confirm" an order to nowhere. To
 * express a pickup order, simply never open this action.
 *
 * Audit is PII-safe: it records which fields changed presence (from the RPC's
 * booleans), never a raw name, phone or address (§11).
 */
export async function updateOrderShippingSnapshot(
  ctx: AuthorizationContext,
  orderId: string,
  input: {
    name?: string | null | undefined;
    phone?: string | null | undefined;
    address?: string | null | undefined;
  },
): Promise<{ ok: true }> {
  ctx.require("orders.update");

  const shipping = normalizeShippingSnapshot(input);
  if (!shipping) {
    throw badRequest("A shipping destination (recipient name and delivery address) is required");
  }

  const result = await repo.updateOrderShipping(ctx.organizationId, orderId, ctx.userId, shipping);
  if (result.status !== "success") throw shippingUpdateFailureToError(result);

  await bestEffortAudit(ctx, {
    action: "orders.update",
    resourceType: "orders",
    resourceId: orderId,
    // Field NAMES / presence only — never a raw address, name or phone (§11).
    beforeJson: {
      shipping_snapshot: {
        name: result.had_name === true,
        phone: result.had_phone === true,
        address: result.had_address === true,
      },
    },
    afterJson: {
      changed: "shipping_snapshot",
      shipping_snapshot: {
        name: result.has_name === true,
        phone: result.has_phone === true,
        address: result.has_address === true,
      },
    },
  });

  return { ok: true };
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

/**
 * Find one order by the code a merchant reads out loud ("APSA-2026-000123").
 *
 * This is the Orders domain answering about an Order. Before it existed the
 * only way to reach an order from its code was the Delivery list's free-text
 * search, which meant an order with no delivery row was unfindable by the
 * reference printed on its own receipt — and a merchant reading "no results"
 * off a delivery search had no way to know that.
 *
 * Authorization is identical to getOrderById: `orders.read`, and the query is
 * scoped to the organization the server resolved from the caller's membership.
 * Two consequences, both deliberate:
 *
 *   - A code belonging to another organization returns null, exactly as an
 *     unissued code does. Order numbers are unique PER TENANT
 *     (uniq_orders_number_per_org), so the same string is a real order in many
 *     organizations at once and must not be a probe into any of them.
 *   - Null is returned rather than thrown. "No order carries this code" is an
 *     ordinary answer to a search, not a failed request, and the console layer
 *     must be able to tell those two apart (a thrown error means the lookup did
 *     not complete, which is a different sentence on screen).
 *
 * A summary, not a detail: the caller needs the real order id to route to, the
 * code, the total and the three status axes — all of which mapOrder produces
 * from the single row this already read. Loading lines and history for a
 * search result would be two more round trips for data no result card shows.
 * No status, total or payment fact is derived here; every one of them is the
 * stored column, mapped by the same mapOrder every other Order read uses.
 */
export async function findOrderByCode(
  ctx: AuthorizationContext,
  code: string,
): Promise<OrderSummary | null> {
  ctx.require("orders.read");

  const normalized = normalizeOrderCode(code);
  // An empty needle would match nothing anyway; refusing it here keeps a
  // pointless round trip off the database on every cleared search box.
  if (normalized.length === 0 || normalized.length > ORDER_CODE_MAX_LENGTH) return null;

  const row = await repo.findOrderByNumber(ctx.organizationId, normalized);
  return row ? mapOrder(row) : null;
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
