/**
 * Analytics application service — backend/read-model foundation phase.
 *
 * No route or UI consumes this yet (see src/server/analytics/types.ts for why
 * Staff Performance is not here at all). Every export requires `analytics.read`
 * — the one analytics permission that actually exists (migration 003) and is
 * granted to OWNER/MANAGER/SALES. That is coarser than PERMISSIONS_MATRIX.md
 * §21's aspirational per-category keys (analytics.sales/products/customers/
 * profit), which have no migration; using the one real key rather than
 * inventing finer ones follows CLAUDE.md §6 ("do not silently add a new
 * permission"). CustomerSummary deliberately carries no PII (counts only), so
 * granting it to SALES does not leak anything customers.read itself would not.
 *
 * ── TWO LAYERS OF AUTHORIZATION, NOT ONE ─────────────────────────────────────
 * `analytics.read` admits a caller to the Analytics domain. It does NOT admit
 * them to money. Because `analytics.read` is granted to SALES, gating monetary
 * totals on it alone would have handed every Sales member the org's collected,
 * refunded and outstanding balances — strictly wider than what the same member
 * can already see on Home, where money sits behind `orders.read` AND
 * `payments.reconcile`. Analytics imports that boundary (`canReadFinancials`)
 * from the Home domain rather than restating or re-deciding it, so there is
 * exactly one definition of "may see money" in the codebase. No new permission
 * and no migration is introduced (CLAUDE.md §6).
 *
 * Denied money is WITHHELD, not zeroed: the `finance` section reports
 * `permission_denied` and `TopSellingItem.grossAmount` is `null`. Every
 * non-financial metric — order counts, status mixes, delivery state mix,
 * quantity ranking, customer cohort — is unaffected by the financial boundary
 * and still answers for a caller holding only `analytics.read`.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { canReadFinancials, rangeBounds } from "@/server/home/service";
import type { HomeSection } from "@/types";
import * as repo from "./repository";
import type {
  AnalyticsFinancialTotals,
  AnalyticsRange,
  BusinessSummary,
  CustomerSummary,
  TopSellingItem,
} from "./types";

const DEFAULT_TOP_SELLING_LIMIT = 20;
const MAX_TOP_SELLING_LIMIT = 100;

export interface AnalyticsDependencies {
  listQualifyingOrders: typeof repo.listQualifyingOrders;
  getOrderStatusCounts: typeof repo.getOrderStatusCounts;
  getSettlementTotals: typeof repo.getSettlementTotals;
  getPaymentMethodCounts: typeof repo.getPaymentMethodCounts;
  getDeliveryStatusCounts: typeof repo.getDeliveryStatusCounts;
  listTopSellingItems: typeof repo.listTopSellingItems;
  getCustomerCohort: typeof repo.getCustomerCohort;
}

const defaultDependencies: AnalyticsDependencies = {
  listQualifyingOrders: repo.listQualifyingOrders,
  getOrderStatusCounts: repo.getOrderStatusCounts,
  getSettlementTotals: repo.getSettlementTotals,
  getPaymentMethodCounts: repo.getPaymentMethodCounts,
  getDeliveryStatusCounts: repo.getDeliveryStatusCounts,
  listTopSellingItems: repo.listTopSellingItems,
  getCustomerCohort: repo.getCustomerCohort,
};

/**
 * Resolves one independently-authorized section. Mirrors Home's `section()`:
 * a denial or an outage in one section can never falsify another, and a denial
 * is reported as a denial rather than as data.
 */
async function section<T>(allowed: boolean, load: () => Promise<T>): Promise<HomeSection<T>> {
  if (!allowed) return { status: "permission_denied" };
  try {
    return { status: "available", data: await load() };
  } catch {
    return { status: "error" };
  }
}

/**
 * repeatOrderCount / (qualifyingOrderCount - unattributedOrderCount).
 * Returns null rather than a manufactured 0 when no order in the period
 * carries a customer_id at all — the rate is genuinely undefined then, not zero.
 */
export function computeRepeatOrderRate(
  qualifyingOrderCount: number,
  unattributedOrderCount: number,
  repeatOrderCount: number,
): number | null {
  const attributedOrderCount = qualifyingOrderCount - unattributedOrderCount;
  if (attributedOrderCount <= 0) return null;
  return repeatOrderCount / attributedOrderCount;
}

export async function getBusinessSummary(
  ctx: AuthorizationContext,
  range: AnalyticsRange = "today",
  dependencies: AnalyticsDependencies = defaultDependencies,
): Promise<BusinessSummary> {
  ctx.require("analytics.read");

  const bounds = rangeBounds(range);
  const orders = await dependencies.listQualifyingOrders(ctx.organizationId, bounds);

  const [statusCounts, finance, paymentMethodCounts, deliveryResult] = await Promise.all([
    dependencies.getOrderStatusCounts(ctx.organizationId, bounds),
    // Not merely masked after the fact — the settlement read is never issued
    // for an unauthorized caller, so protected money is not even loaded.
    section<AnalyticsFinancialTotals>(canReadFinancials(ctx), () =>
      dependencies.getSettlementTotals(ctx.organizationId, orders),
    ),
    dependencies.getPaymentMethodCounts(ctx.organizationId, bounds),
    section(ctx.can("delivery.read"), () =>
      dependencies.getDeliveryStatusCounts(ctx.organizationId, bounds),
    ),
  ]);

  // An unresolved latest attempt makes the mix incomplete, not wrong-but-certain.
  const delivery: BusinessSummary["delivery"] =
    deliveryResult.status === "available"
      ? deliveryResult.data.unresolved
        ? { status: "truncated" }
        : { status: "available", data: { statusCounts: deliveryResult.data.statusCounts } }
      : deliveryResult;

  return {
    range,
    from: bounds.from,
    until: bounds.until,
    orderCount: orders.length,
    finance,
    lifecycleStatusCounts: statusCounts.lifecycleStatusCounts,
    paymentStatusCounts: statusCounts.paymentStatusCounts,
    fulfillmentStatusCounts: statusCounts.fulfillmentStatusCounts,
    refundStatusCounts: statusCounts.refundStatusCounts,
    paymentMethodCounts,
    delivery,
  };
}

export async function getTopSellingItems(
  ctx: AuthorizationContext,
  range: AnalyticsRange = "today",
  limit = DEFAULT_TOP_SELLING_LIMIT,
  dependencies: AnalyticsDependencies = defaultDependencies,
): Promise<TopSellingItem[]> {
  ctx.require("analytics.read");
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_TOP_SELLING_LIMIT);
  const bounds = rangeBounds(range);
  const orders = await dependencies.listQualifyingOrders(ctx.organizationId, bounds);
  const ranked = await dependencies.listTopSellingItems(ctx.organizationId, orders, boundedLimit);

  // Ranking is quantity-only and currency-independent, so the list and its
  // order are identical either way; only the money field is withheld.
  const showMoney = canReadFinancials(ctx);
  return ranked.map((item) => ({ ...item, grossAmount: showMoney ? item.grossAmount : null }));
}

export async function getCustomerSummary(
  ctx: AuthorizationContext,
  range: AnalyticsRange = "today",
  dependencies: AnalyticsDependencies = defaultDependencies,
): Promise<CustomerSummary> {
  ctx.require("analytics.read");
  const bounds = rangeBounds(range);
  const orders = await dependencies.listQualifyingOrders(ctx.organizationId, bounds);
  const cohort = await dependencies.getCustomerCohort(ctx.organizationId, orders, bounds);

  return {
    range,
    totalCustomers: cohort.totalCustomers,
    newCustomers: cohort.newCustomers,
    repeatCustomers: cohort.repeatCustomers,
    unattributedOrderCount: cohort.unattributedOrderCount,
    repeatOrderCount: cohort.repeatOrderCount,
    repeatOrderRate: computeRepeatOrderRate(
      orders.length,
      cohort.unattributedOrderCount,
      cohort.repeatOrderCount,
    ),
  };
}
