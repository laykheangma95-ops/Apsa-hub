/**
 * The Orders screen's ten filters — vocabulary and meaning.
 *
 * Safe to bundle for the browser, and imported by the server: the browser
 * names a filter, the server decides what it means. The browser never filters
 * rows itself; `orderMatchesListFilter` is the specification the repository's
 * SQL is tested against (src/tests/orders-filters-mounted.runtime.ts), not a
 * client-side filter.
 *
 * ── WHY THESE TEN ───────────────────────────────────────────────────────────
 *
 * An order carries three independent axes (src/server/orders/state-machine.ts):
 * lifecycle (draft / confirmed / completed / cancelled), payment (unpaid /
 * pending / paid / failed) and fulfillment (unfulfilled / processing /
 * fulfilled / cancelled). The progress filters are predicates over those
 * columns of the orders table and nothing else; the attention views also read
 * the order's deliveries and the packed rule (below).
 *
 * Five filters walk one order's progress (lifecycle × fulfillment). Together
 * with "confirmed, still unfulfilled" — which the column filters do not name,
 * because the packing views below say more about it than a column can — they
 * are a PARTITION: every order matches exactly one of them —
 *
 *   draft       lifecycle draft,     fulfillment not cancelled
 *   processing  lifecycle confirmed, fulfillment processing
 *   fulfilled   lifecycle confirmed, fulfillment fulfilled
 *   completed   lifecycle completed, fulfillment not cancelled
 *   cancelled   lifecycle cancelled  OR  fulfillment cancelled
 *
 * `cancelled` takes both kinds of calling-off — the sale, or its fulfillment
 * (a cancelled fulfillment is terminal, so that order can never complete).
 * `draft` and `completed` give up any cancelled-fulfillment order so that no
 * order appears under two progress filters. (The database completes an order
 * only once it is fulfilled, so a completed order with a cancelled fulfillment
 * should not exist; the clause keeps the partition exact even if one does.)
 *
 * Four filters are the attention views ("Payment due", "Needs preparation",
 * "Packed · Needs delivery", "Packed · Waiting for pickup"), the ones whose
 * counts the screen shows. They overlap the progress filters on purpose:
 *
 *   awaiting_payment   lifecycle not cancelled, payment unpaid, pending or
 *                      failed (PAYMENT_DUE_STATUSES). `pending` holds a partial
 *                      payment as well as one awaiting confirmation (migration
 *                      040: anything received short of the total is pending);
 *                      `failed` means every attempt failed and nothing was
 *                      received, so the money is still due.
 *   to_pack            "Needs preparation" — packing is still required:
 *                      lifecycle confirmed, fulfillment unfulfilled or
 *                      processing, no delivery ready / in transit / delivered,
 *                      and NOT currently packed by order_currently_packed_v1
 *                      (migration 054) — whether or not a delivery was arranged
 *                      first. Served from order_preparation_queue_v1
 *                      (migration 065), so list and count are one predicate.
 *   packed_needs_delivery
 *                      "Packed · Needs delivery" — the same orders still in the
 *                      shop, but currently packed: no delivery arranged, the
 *                      last one failed or was cancelled, or one is pending /
 *                      preparing and was never readied. Delivery recovery, not
 *                      packing work. Disjoint from to_pack and waiting_pickup.
 *   waiting_pickup     lifecycle confirmed, fulfillment neither fulfilled nor
 *                      cancelled, and a delivery of the order is `ready`.
 *                      Migration 054 lets no path ready a delivery unless the
 *                      order is currently packed, and a reopen cancels a ready
 *                      delivery; Courier Handoff (ready → in_transit) is what
 *                      takes it out. So `ready` is exactly "packed, in the shop,
 *                      waiting for the courier". A packed order with no ready
 *                      delivery (none arranged, or the last one failed) is NOT
 *                      waiting for pickup: it is packed_needs_delivery.
 *
 * A cash-on-delivery sale is confirmed, unpaid and being packed at once. Forcing
 * payment into the progress partition would hide that order from "Needs preparation" — the
 * packer's list — or from "Awaiting payment"; a packed COD order waiting for the
 * courier is in both Payment due and Waiting for pickup. The payment predicate
 * is exactly the one Home counts as "Orders awaiting payment"
 * (src/server/home/repository.ts, through PAYMENT_DUE_STATUSES), so the two
 * never disagree.
 *
 * ── WHAT IS NOT A FILTER, AND WHY ───────────────────────────────────────────
 *
 * - "Awaiting confirmation" is not separate from Draft: a draft IS the order
 *   that has not been confirmed. Two chips for one state would mislead.
 * - "Preparing" and "Ready for delivery" are Delivery-domain states. The orders
 *   table holds only `processing` for preparing, ready AND in transit
 *   (migrations 027/054), so a filter claiming either would be false.
 * - "Returned" is a separate Return domain (migration 056) that never changes
 *   an order's status columns, so no order-column predicate can find returns.
 *
 * `refund_status` takes part in no filter.
 */

export const ORDER_LIST_FILTERS = [
  "all",
  "awaiting_payment",
  "to_pack",
  "packed_needs_delivery",
  "waiting_pickup",
  "draft",
  "processing",
  "fulfilled",
  "completed",
  "cancelled",
] as const;

export type OrderListFilter = (typeof ORDER_LIST_FILTERS)[number];

export const DEFAULT_ORDER_LIST_FILTER: OrderListFilter = "all";

/** The attention views, in the order the screen shows them; each carries a count. */
export const ORDER_ATTENTION_FILTERS = [
  "awaiting_payment",
  "to_pack",
  "packed_needs_delivery",
  "waiting_pickup",
] as const;

/** The two views served from order_preparation_queue_v1 (migration 065), by state. */
export const PREPARATION_QUEUE_STATES = {
  to_pack: "needs_packing",
  packed_needs_delivery: "packed_needs_delivery",
} as const;

export type OrderAttentionFilter = (typeof ORDER_ATTENTION_FILTERS)[number];

export function isOrderAttentionFilter(value: unknown): value is OrderAttentionFilter {
  return (
    typeof value === "string" && (ORDER_ATTENTION_FILTERS as readonly string[]).includes(value)
  );
}

/** Payment statuses under which money is still due. Shared with Home's count. */
export const PAYMENT_DUE_STATUSES = ["unpaid", "pending", "failed"] as const;

/** The column progress filters (with confirmed ∧ unfulfilled, a partition of every order). */
export const ORDER_PROGRESS_FILTERS: readonly OrderListFilter[] = [
  "draft",
  "processing",
  "fulfilled",
  "completed",
  "cancelled",
];

export function isOrderListFilter(value: unknown): value is OrderListFilter {
  return typeof value === "string" && (ORDER_LIST_FILTERS as readonly string[]).includes(value);
}

/** A filter from the URL: anything unrecognised is All, never an error. */
export function parseOrderListFilter(value: unknown): OrderListFilter {
  return isOrderListFilter(value) ? value : DEFAULT_ORDER_LIST_FILTER;
}

/** i18n key of each filter's chip label. */
export function orderListFilterLabelKey(filter: OrderListFilter): string {
  return `orderList.filters.${filter}`;
}

/**
 * The three status columns a filter reads, exactly as the orders table holds
 * them, plus the delivery and packing facts the attention views read.
 */
export interface OrderListFilterAxes {
  lifecycle: "draft" | "confirmed" | "completed" | "cancelled";
  payment: "unpaid" | "pending" | "paid" | "failed";
  fulfillment: "unfulfilled" | "processing" | "fulfilled" | "cancelled";
  /** Some delivery of the order is `ready`. Absent → none. */
  readyDelivery?: boolean;
  /** Some delivery of the order is `in_transit` or `delivered`. Absent → none. */
  deliveryOut?: boolean;
  /** order_currently_packed_v1 says the order is packed. Absent → not packed. */
  packed?: boolean;
}

/**
 * Whether one order belongs under `filter`. The specification of the SQL in
 * src/server/orders/repository.ts (applyOrderListFilter): a test runs both over
 * every combination of the three axes and requires the same answer.
 */
export function orderMatchesListFilter(
  filter: OrderListFilter,
  {
    lifecycle,
    payment,
    fulfillment,
    readyDelivery = false,
    deliveryOut = false,
    packed = false,
  }: OrderListFilterAxes,
): boolean {
  // Still in the shop and in the sale: order_preparation_queue_v1's rows.
  const inShop =
    lifecycle === "confirmed" &&
    (fulfillment === "unfulfilled" || fulfillment === "processing") &&
    !readyDelivery &&
    !deliveryOut;
  switch (filter) {
    case "all":
      return true;
    case "awaiting_payment":
      return (
        lifecycle !== "cancelled" && (PAYMENT_DUE_STATUSES as readonly string[]).includes(payment)
      );
    case "draft":
      return lifecycle === "draft" && fulfillment !== "cancelled";
    case "to_pack":
      return inShop && !packed;
    case "packed_needs_delivery":
      return inShop && packed;
    case "waiting_pickup":
      return (
        lifecycle === "confirmed" &&
        fulfillment !== "fulfilled" &&
        fulfillment !== "cancelled" &&
        readyDelivery
      );
    case "processing":
      return lifecycle === "confirmed" && fulfillment === "processing";
    case "fulfilled":
      return lifecycle === "confirmed" && fulfillment === "fulfilled";
    case "completed":
      return lifecycle === "completed" && fulfillment !== "cancelled";
    case "cancelled":
      return lifecycle === "cancelled" || fulfillment === "cancelled";
  }
}
