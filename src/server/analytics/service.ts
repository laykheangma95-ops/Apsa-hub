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
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { rangeBounds } from "@/server/home/service";
import type { HomeSection } from "@/types";
import * as repo from "./repository";
import type { AnalyticsRange, BusinessSummary, CustomerSummary, TopSellingItem } from "./types";

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

async function deliverySection<T>(
  allowed: boolean,
  load: () => Promise<T>,
): Promise<HomeSection<T>> {
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

  const [statusCounts, settlement, paymentMethodCounts, delivery] = await Promise.all([
    dependencies.getOrderStatusCounts(ctx.organizationId, bounds),
    dependencies.getSettlementTotals(ctx.organizationId, orders),
    dependencies.getPaymentMethodCounts(ctx.organizationId, bounds),
    deliverySection(ctx.can("delivery.read"), async () => ({
      statusCounts: await dependencies.getDeliveryStatusCounts(ctx.organizationId, bounds),
    })),
  ]);

  return {
    range,
    from: bounds.from,
    until: bounds.until,
    orderCount: orders.length,
    orderedGross: settlement.orderedGross,
    collectedGross: settlement.collectedGross,
    refundedAmount: settlement.refundedAmount,
    outstandingAmount: settlement.outstandingAmount,
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
  return dependencies.listTopSellingItems(ctx.organizationId, orders, boundedLimit);
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
