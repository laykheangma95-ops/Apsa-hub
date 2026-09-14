/**
 * Read-model types for the Analytics domain — backend/foundation phase only.
 *
 * No UI, no route, no navigation entry ships in this phase. Every DTO here is
 * consumed only by src/server/analytics/service.ts and, through it, by
 * src/api/analytics.ts.
 *
 * Money is always an array of { amount, currency } pairs — never summed across
 * currency. There is no FX conversion anywhere in this domain.
 *
 * ── DELIBERATELY NOT HERE: STAFF PERFORMANCE ─────────────────────────────────
 * PERMISSIONS_MATRIX.md §22 documents a staff-performance permission model
 * (`staff_metrics.read_team`, `staff_metrics.read_self`, `staff_metrics.export`)
 * that has no corresponding migration — no such keys exist in
 * supabase/migrations, and nothing in src/server enforces them. The only
 * analytics permission that actually exists and is enforced (`analytics.read`,
 * seeded in migration 003) is granted to SALES as well as OWNER/MANAGER, which
 * is wider than the matrix's team-wide staff-performance intent (Owner/Manager
 * only) and would let a Sales member see other staff members' payment
 * confirmations and reversals — a CLAUDE.md/SECURITY.md violation. Per
 * CLAUDE.md §6 ("Do not silently add a new permission... STOP before creating
 * a migration"), staff performance is deferred out of this phase rather than
 * gated on a permission that does not fit. See the PR description for the
 * proposed migration.
 */
import type { Currency, HomeSection, Money } from "@/types";
import type {
  OrderFulfillmentStatus,
  OrderLifecycleStatus,
  OrderPaymentStatus,
  OrderRefundStatus,
} from "@/server/orders/state-machine";
import type { PaymentMethod } from "@/server/payments/state-machine";
import type { DeliveryStatus } from "@/server/deliveries/state-machine";

/** Reuses Home's exact Cambodia-calendar range contract — no second implementation. */
export type AnalyticsRange = "today" | "week" | "month";

export interface AnalyticsBounds {
  from: string;
  until: string;
}

/**
 * An order counts toward volume/gross/collected/refunded/outstanding only once
 * it is a committed sale. Draft orders are not yet real; cancelled orders were
 * reversed. This is a narrower cohort than "every order row created in the
 * period" — see lifecycleStatusCounts for the uncut mix.
 */
export const QUALIFYING_LIFECYCLE_STATUSES: readonly OrderLifecycleStatus[] = [
  "confirmed",
  "completed",
];

/**
 * Protected monetary totals for the qualifying order cohort.
 *
 * These are money, so they sit behind the Home domain's established financial
 * visibility boundary (`orders.read` AND `payments.reconcile` — see
 * `canReadFinancials` in src/server/home/service.ts), NOT behind
 * `analytics.read` alone. `analytics.read` is granted to SALES (migration
 * 003); SALES is outside that boundary and must not receive these figures.
 */
export interface AnalyticsFinancialTotals {
  /** Sum of orders.total_minor for qualifying orders, by currency. */
  orderedGross: Money[];
  /**
   * Sum of order_payment_totals.received_minor for qualifying orders, by
   * currency — money received to date (as of now) against orders CREATED in
   * the period. Not "money settled during the period"; a payment recorded
   * after the period boundary still counts, exactly like Home's
   * netCollectedForCreatedOrders. Gross — refunds are reported separately,
   * not netted out here.
   */
  collectedGross: Money[];
  /** Sum of order_payment_totals.refunded_minor for qualifying orders, by currency. */
  refundedAmount: Money[];
  /**
   * Sum of max(total_minor - received_minor, 0) for qualifying orders, by
   * currency — the unpaid/pending balance still owed.
   */
  outstandingAmount: Money[];
}

export interface BusinessSummary {
  range: AnalyticsRange;
  from: string;
  until: string;

  /** Count of qualifying (confirmed/completed) orders created in the period. Non-financial. */
  orderCount: number;

  /**
   * Every monetary total in this summary, or `permission_denied` for a caller
   * outside the financial visibility boundary. Withheld as a section rather
   * than zeroed: a fabricated 0 is indistinguishable from "no sales", which
   * would be a lie to a SALES member reading the page.
   */
  finance: HomeSection<AnalyticsFinancialTotals>;

  /** Every order created in the period, by lifecycle status — not limited to the qualifying cohort. */
  lifecycleStatusCounts: Record<OrderLifecycleStatus, number>;
  /** Every order created in the period, by orders.payment_status (kept in sync with order_payment_totals by migration 040's trigger). */
  paymentStatusCounts: Record<OrderPaymentStatus, number>;
  /** Every order created in the period, by fulfillment status. */
  fulfillmentStatusCounts: Record<OrderFulfillmentStatus, number>;
  /** Every order created in the period, by refund status. */
  refundStatusCounts: Record<OrderRefundStatus, number>;

  /**
   * Payments RECORDED in the period (payments.created_at), by method —
   * independent of when the order they belong to was created. Do not read
   * this as "how orders created in the period were paid".
   */
  paymentMethodCounts: Record<PaymentMethod, number>;

  /**
   * CURRENT delivery state, by status, for every order with at least one
   * delivery attempt created in the period — one count per ORDER, never per
   * raw attempt. An order that failed and was then delivered counts once, as
   * `delivered`. "Current" is the Deliveries domain's own authoritative
   * latest-attempt rule (newest `created_at DESC, id DESC` row per order, read
   * via `listDeliveryAttemptRefsForOrders`); Analytics defines no competing
   * delivery-state rule.
   *
   * `permission_denied` without `delivery.read`; `truncated` when some order's
   * latest attempt could not be resolved (UNKNOWN is never reported as a
   * certain count).
   */
  delivery: HomeSection<{ statusCounts: Record<DeliveryStatus, number> }>;
}

export interface TopSellingItem {
  productId: string;
  variantId: string;
  currency: Currency;
  /** product_name_snapshot (+ variant_name_snapshot) as captured on the order line at sale time — never a live product lookup. */
  displayLabel: string;
  /** Units sold. Non-financial, and the ONLY metric this list is ranked by. */
  quantitySold: number;
  /**
   * Gross line revenue in minor units, denominated in `currency`. Money, so it
   * follows the same financial visibility boundary as `AnalyticsFinancialTotals`:
   * `null` — never 0 — for a caller outside it. Ranking never reads this field
   * (see `compareTopSellingItems`), so the order of the list is identical with
   * or without financial visibility.
   */
  grossAmount: number | null;
}

export interface CustomerSummary {
  range: AnalyticsRange;
  /** Distinct customers attributed to a qualifying order in the period. */
  totalCustomers: number;
  /** Of those, customers with no earlier qualifying order (created_at < range.from). */
  newCustomers: number;
  /** Of those, customers with at least one earlier qualifying order. */
  repeatCustomers: number;
  /** Qualifying orders in the period with no customer_id at all (never counted as a "customer"). */
  unattributedOrderCount: number;
  /** Qualifying orders in the period placed by a repeat customer. */
  repeatOrderCount: number;
  /** repeatOrderCount / (orderCount - unattributedOrderCount); null when that denominator is 0 — never a manufactured 0%. */
  repeatOrderRate: number | null;
}
