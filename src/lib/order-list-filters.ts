/**
 * The Orders screen's eight filters — vocabulary and meaning.
 *
 * Safe to bundle for the browser, and imported by the server: the browser
 * names a filter, the server decides what it means. The browser never filters
 * rows itself; `orderMatchesListFilter` is the specification the repository's
 * SQL is tested against (src/tests/orders-filters-mounted.runtime.ts), not a
 * client-side filter.
 *
 * ── WHY THESE EIGHT ─────────────────────────────────────────────────────────
 *
 * An order carries three independent axes (src/server/orders/state-machine.ts):
 * lifecycle (draft / confirmed / completed / cancelled), payment (unpaid /
 * pending / paid / failed) and fulfillment (unfulfilled / processing /
 * fulfilled / cancelled). Every filter here is a predicate over those columns
 * of the orders table and nothing else.
 *
 * Six filters walk one order's progress (lifecycle × fulfillment) and are a
 * PARTITION: every order matches exactly one of them —
 *
 *   draft       lifecycle draft,     fulfillment not cancelled
 *   to_pack     lifecycle confirmed, fulfillment unfulfilled
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
 * One filter is on a DIFFERENT axis and overlaps the others on purpose:
 *
 *   awaiting_payment   lifecycle not cancelled, payment unpaid or pending
 *
 * A cash-on-delivery sale is confirmed, unpaid and being packed at once. Forcing
 * payment into the progress partition would hide that order from "To pack" — the
 * packer's list — or from "Awaiting payment". The predicate is exactly the one
 * Home counts as "Orders awaiting payment" (src/server/home/repository.ts), so
 * the two never disagree.
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
  "draft",
  "to_pack",
  "processing",
  "fulfilled",
  "completed",
  "cancelled",
] as const;

export type OrderListFilter = (typeof ORDER_LIST_FILTERS)[number];

export const DEFAULT_ORDER_LIST_FILTER: OrderListFilter = "all";

/** The progress filters — the six that partition every order. */
export const ORDER_PROGRESS_FILTERS: readonly OrderListFilter[] = [
  "draft",
  "to_pack",
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

/** The three status columns a filter reads, exactly as the orders table holds them. */
export interface OrderListFilterAxes {
  lifecycle: "draft" | "confirmed" | "completed" | "cancelled";
  payment: "unpaid" | "pending" | "paid" | "failed";
  fulfillment: "unfulfilled" | "processing" | "fulfilled" | "cancelled";
}

/**
 * Whether one order belongs under `filter`. The specification of the SQL in
 * src/server/orders/repository.ts (applyOrderListFilter): a test runs both over
 * every combination of the three axes and requires the same answer.
 */
export function orderMatchesListFilter(
  filter: OrderListFilter,
  { lifecycle, payment, fulfillment }: OrderListFilterAxes,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "awaiting_payment":
      return lifecycle !== "cancelled" && (payment === "unpaid" || payment === "pending");
    case "draft":
      return lifecycle === "draft" && fulfillment !== "cancelled";
    case "to_pack":
      return lifecycle === "confirmed" && fulfillment === "unfulfilled";
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
