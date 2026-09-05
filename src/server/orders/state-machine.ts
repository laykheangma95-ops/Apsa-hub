/**
 * Authoritative Order state machine.
 *
 * Pure: no DB, no auth context, no I/O. Everything here is a total function of
 * its arguments, so the transition rules can be tested exhaustively and reused
 * by every future caller (POS, chat-to-order, payment webhooks, delivery) with
 * no chance of a second, divergent copy of the rules appearing.
 *
 * ── THREE AXES, NOT ONE ──────────────────────────────────────────────────────
 *
 * MVP_ROADMAP.md §13 sketches a single flat status list
 * (DRAFT / PENDING_PAYMENT / PAID / CONFIRMED / PACKING / READY_FOR_DELIVERY /
 * IN_TRANSIT / DELIVERED / CANCELLED / RETURNED / REFUNDED). That list mixes
 * three independent facts and cannot express an ordinary Cambodian COD sale,
 * which is simultaneously confirmed, unpaid and being packed. The existing APSA
 * UI already separates payment from fulfillment (src/types/index.ts), so this
 * machine keeps those two axes and adds a third — lifecycle — for what neither
 * carries: whether the order is a committed sale, and whether it was cancelled.
 *
 *   lifecycle   — is this a real sale?      draft -> confirmed -> completed
 *                                                 \-> cancelled
 *   payment     — has the money arrived?    unpaid/pending/paid/failed
 *   fulfillment — did the goods arrive?     unfulfilled/processing/fulfilled
 *
 * ── MOCK NAMES THAT WERE NOT ADOPTED ─────────────────────────────────────────
 *
 * The mock UI's fulfillment values (confirmed, packing, ready, in_transit,
 * delivered) are two different things wearing one name. "confirmed" is a
 * lifecycle fact and moves to that axis. packing / ready / in_transit are
 * courier-granularity states; ARCHITECTURE.md requires provider abstractions
 * with no courier vocabulary in domain types, so they belong to the Delivery
 * domain, which will drive this coarse axis:
 *
 *   packing | ready | in_transit  ->  processing
 *   delivered                     ->  fulfilled
 *
 * The mock's payment value "pending_payment" becomes `unpaid` (no attempt yet)
 * versus `pending` (an attempt is in flight) — one word for two states was the
 * reason the mock could not tell "customer has not paid" from "the transfer is
 * clearing". `partially_paid`, `refunded` and `partially_refunded` are absent:
 * all three require the Payment Records domain (Phase 8) to mean anything, and
 * a status that no code can reach is a status that lies to whoever reads it.
 *
 * ── FUTURE INVENTORY TRIGGER POINT ───────────────────────────────────────────
 *
 * See STOCK_CONSUMING_TRANSITION / STOCK_RELEASING_TRANSITION below. Nothing in
 * this phase calls the Inventory domain; the point is identified, exported and
 * asserted by tests so the integration lands in exactly one place.
 */

// ── Status vocabularies (must match migration 023's enums exactly) ────────────

export const ORDER_LIFECYCLE_STATUSES = ["draft", "confirmed", "completed", "cancelled"] as const;

export const ORDER_PAYMENT_STATUSES = ["unpaid", "pending", "paid", "failed"] as const;

export const ORDER_FULFILLMENT_STATUSES = [
  "unfulfilled",
  "processing",
  "fulfilled",
  "cancelled",
] as const;

export type OrderLifecycleStatus = (typeof ORDER_LIFECYCLE_STATUSES)[number];
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];
export type OrderFulfillmentStatus = (typeof ORDER_FULFILLMENT_STATUSES)[number];

export type OrderStatusAxis = "lifecycle" | "payment" | "fulfillment";

// ── Transition tables ─────────────────────────────────────────────────────────
//
// Every table is exhaustive: a status maps to the complete set of statuses that
// may follow it. An empty set means terminal. Anything not listed is invalid —
// there is no default-allow anywhere in this file.

/**
 * LIFECYCLE
 *
 *   draft     -> confirmed   the merchant commits to the sale
 *                            *** STOCK-CONSUMING TRANSITION (future) ***
 *   draft     -> cancelled   abandoned before it was ever a sale
 *   confirmed -> completed   paid AND fulfilled (guarded — see below)
 *   confirmed -> cancelled   a committed sale is called off
 *                            *** STOCK-RELEASING TRANSITION (future) ***
 *   completed                terminal
 *   cancelled                terminal
 *
 * There is no confirmed -> draft edge. Un-committing a sale would have to
 * un-consume stock, un-do a payment, and re-open a closed decision; a merchant
 * who changes their mind cancels and re-creates. Making that impossible now is
 * cheaper than discovering later that some code path relies on it.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<OrderLifecycleStatus, readonly OrderLifecycleStatus[]>
> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * PAYMENT
 *
 *   unpaid  -> pending   an attempt is in flight (KHQR shown, transfer claimed)
 *   unpaid  -> paid      cash taken at the counter — no intermediate state
 *   unpaid  -> failed    an attempt was made and rejected
 *   pending -> paid      confirmed
 *   pending -> failed    rejected or expired
 *   pending -> unpaid    the attempt was abandoned; back to square one
 *   failed  -> pending   retry
 *   failed  -> paid      retried and succeeded (or settled in cash instead)
 *   failed  -> unpaid    give up on the attempt without closing the order
 *   paid                 terminal IN THIS PHASE
 *
 * `paid` is terminal only because refunds do not exist yet. When the Payment
 * Records domain lands it gains exits to `refunded` / `partially_refunded`;
 * until then, leaving it open would mean an order could silently walk back out
 * of paid with no refund record to explain where the money went.
 */
export const PAYMENT_TRANSITIONS: Readonly<
  Record<OrderPaymentStatus, readonly OrderPaymentStatus[]>
> = {
  unpaid: ["pending", "paid", "failed"],
  pending: ["paid", "failed", "unpaid"],
  paid: [],
  failed: ["pending", "paid", "unpaid"],
};

/**
 * FULFILLMENT
 *
 *   unfulfilled -> processing   picking/packing has started
 *   unfulfilled -> fulfilled    handed straight over (the POS counter case)
 *   unfulfilled -> cancelled    nothing was ever sent
 *   processing  -> fulfilled    the customer has it
 *   processing  -> unfulfilled  packing stopped; back in the queue
 *   processing  -> cancelled    called off mid-pack
 *   fulfilled                   terminal IN THIS PHASE
 *   cancelled                   terminal
 *
 * `fulfilled` is terminal because the exit from it is `returned`, and a return
 * is not a status change — it is goods coming back, stock going up and money
 * going out. Modelling it as an edge here, with none of that behind it, would
 * let an order claim a return that never happened.
 */
export const FULFILLMENT_TRANSITIONS: Readonly<
  Record<OrderFulfillmentStatus, readonly OrderFulfillmentStatus[]>
> = {
  unfulfilled: ["processing", "fulfilled", "cancelled"],
  processing: ["fulfilled", "unfulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

/** Lifecycle states after which no transition on any axis is accepted. */
export const TERMINAL_LIFECYCLE_STATUSES: readonly OrderLifecycleStatus[] = [
  "completed",
  "cancelled",
];

// ── The future Inventory integration point ────────────────────────────────────
//
// Exported as data rather than described only in prose so that a test can
// assert it, and so the integration has one unambiguous place to attach.

/**
 * The transition at which an order commits stock.
 *
 * NOT `paid`: cash on delivery dominates Cambodian social commerce, so the
 * money often arrives days after the goods leave. Consuming stock at payment
 * would let a merchant confirm ten COD orders for one item, because none of
 * them is paid yet.
 *
 * NOT `fulfilled`: by then the goods are already with the customer. Stock
 * decremented at fulfillment was oversold at every moment before it, and the
 * merchant discovers the shortage while packing — the exact failure APSA exists
 * to prevent.
 *
 * `draft -> confirmed` is the moment the merchant commits the goods to this
 * customer, and therefore the moment those units stop being available to anyone
 * else. It is also the one transition both channels share: a POS sale confirms
 * at checkout, a chat order when the merchant accepts it.
 *
 * NOT WIRED IN THIS PHASE. When it is, confirmOrder() writes one
 * inventory_movements row per line (movement_type 'sale', quantity_delta
 * -quantity, reference_type 'order', reference_id the order id) in the same
 * transaction as the status change.
 */
export const STOCK_CONSUMING_TRANSITION = {
  axis: "lifecycle",
  from: "draft",
  to: "confirmed",
  plannedMovementType: "sale",
  implemented: false,
} as const;

/**
 * The mirror of the above: cancelling a confirmed order releases the units it
 * was holding. Migration 021's idempotency index already keys on
 * (organization_id, variant_id, movement_type, reference_type, reference_id),
 * so this 'return' movement coexists with the original 'sale' for the same
 * order rather than colliding with it.
 *
 * A draft -> cancelled cancellation releases nothing, because a draft never
 * consumed anything.
 *
 * NOT WIRED IN THIS PHASE.
 */
export const STOCK_RELEASING_TRANSITION = {
  axis: "lifecycle",
  from: "confirmed",
  to: "cancelled",
  plannedMovementType: "return",
  implemented: false,
} as const;

// ── Query helpers ─────────────────────────────────────────────────────────────

export function isValidLifecycleTransition(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus,
): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isValidPaymentTransition(
  from: OrderPaymentStatus,
  to: OrderPaymentStatus,
): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function isValidFulfillmentTransition(
  from: OrderFulfillmentStatus,
  to: OrderFulfillmentStatus,
): boolean {
  return FULFILLMENT_TRANSITIONS[from].includes(to);
}

export function isTerminalLifecycle(status: OrderLifecycleStatus): boolean {
  return TERMINAL_LIFECYCLE_STATUSES.includes(status);
}

// ── Who may perform each transition ───────────────────────────────────────────
//
// Permission keys only — the check itself is the caller's, against a
// server-verified AuthorizationContext. Keeping the mapping here (rather than
// inline in the service) means the answer to "who can cancel an order" is in
// the same file as "when can an order be cancelled".
//
// Keys are those already defined by PERMISSIONS_MATRIX.md §14 and seeded by
// migrations 003 and 025. No key is invented here.

/**
 * The permission required to move `lifecycle` to a given status.
 *
 * `completed` requires nothing beyond orders.update: it is a conclusion drawn
 * from payment and fulfillment already being final, not an independent decision
 * — and the DB refuses it unless both really are (migration 024).
 */
export const LIFECYCLE_TRANSITION_PERMISSIONS: Readonly<
  Record<OrderLifecycleStatus, string | null>
> = {
  draft: null, // no edge leads back to draft
  confirmed: "orders.confirm",
  cancelled: "orders.cancel",
  completed: "orders.update",
};

/**
 * Every payment_status transition requires payments.confirm ("Manually confirm
 * payments", high risk — migration 003).
 *
 * Marking an order failed or pending is the same manual money-handling
 * authority as marking it paid: whoever can say "the transfer arrived" is
 * whoever can say "it did not". Finer keys (payments.record, payments.mark_cod,
 * payments.override_status from §17) arrive with the Payment Records domain,
 * which is what makes them distinguishable.
 */
export const PAYMENT_TRANSITION_PERMISSION = "payments.confirm";

/**
 * Fulfillment transitions are "updating the order" — orders.update (migration
 * 003) — except cancelling, which is orders.cancel wherever it appears.
 */
export const FULFILLMENT_TRANSITION_PERMISSIONS: Readonly<Record<OrderFulfillmentStatus, string>> =
  {
    unfulfilled: "orders.update",
    processing: "orders.update",
    fulfilled: "orders.update",
    cancelled: "orders.cancel",
  };
