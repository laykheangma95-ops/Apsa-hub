import type { AuthorizationContext } from "@/server/auth/authorization";
import { ForbiddenError } from "@/server/auth/authorization";
import { getDeliveryAttentionCount } from "@/server/deliveries/service";
import { getPaymentAttentionCount } from "@/server/payments/reconciliation";
import type { HomeSection, HomeSummary, MetricRange, Money } from "@/types";
import * as repo from "./repository";
import type { HomeRange } from "./types";

const PHNOM_PENH = "Asia/Phnom_Penh";
const PHNOM_PENH_OFFSET_HOURS = 7;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function phnomPenhCalendarDate(now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHNOM_PENH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
  };
}

function localMidnightIso(calendar: Date): string {
  return new Date(
    Date.UTC(
      calendar.getUTCFullYear(),
      calendar.getUTCMonth(),
      calendar.getUTCDate(),
      -PHNOM_PENH_OFFSET_HOURS,
    ),
  ).toISOString();
}

/**
 * Merchant ranges are Cambodia calendar ranges, independent of browser or
 * server timezone. No product convention existed for week start, so Home keeps
 * its original Monday-through-Sunday convention and makes it explicit here.
 */
export function rangeBounds(range: HomeRange, now = new Date()): { from: string; until: string } {
  const local = phnomPenhCalendarDate(now);
  const start = new Date(Date.UTC(local.year, local.month - 1, local.day));

  if (range === "week") {
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  } else if (range === "month") {
    start.setUTCDate(1);
  }

  const until = new Date(start);
  if (range === "today") until.setUTCDate(until.getUTCDate() + 1);
  if (range === "week") until.setUTCDate(until.getUTCDate() + 7);
  if (range === "month") until.setUTCMonth(until.getUTCMonth() + 1);

  return { from: localMidnightIso(start), until: localMidnightIso(until) };
}

export interface HomeDependencies {
  getOrderSummary: typeof repo.getHomeOrderSummary;
  getNetCollected: typeof repo.getNetCollectedForCreatedOrders;
  getOutOfStockCount: typeof repo.getOutOfStockVariantCount;
  getPaymentAttention: typeof getPaymentAttentionCount;
  getDeliveryAttention: typeof getDeliveryAttentionCount;
}

const defaultDependencies: HomeDependencies = {
  getOrderSummary: repo.getHomeOrderSummary,
  getNetCollected: repo.getNetCollectedForCreatedOrders,
  getOutOfStockCount: repo.getOutOfStockVariantCount,
  getPaymentAttention: getPaymentAttentionCount,
  getDeliveryAttention: getDeliveryAttentionCount,
};

async function section<T>(allowed: boolean, load: () => Promise<T>): Promise<HomeSection<T>> {
  if (!allowed) return { status: "permission_denied" };
  try {
    return { status: "available", data: await load() };
  } catch {
    return { status: "error" };
  }
}

/**
 * Authenticated active membership is established before this function. Home
 * admits a member with at least one operational read capability, then resolves
 * every domain independently so one denial or outage cannot falsify the rest.
 */
export async function getHomeSummary(
  ctx: AuthorizationContext,
  range: MetricRange = "today",
  dependencies: HomeDependencies = defaultDependencies,
): Promise<HomeSummary> {
  const canReadOrders = ctx.can("orders.read");
  const canReadPayments = ctx.can("payments.read");
  const canReadInventory = ctx.can("inventory.read");
  const canReadDelivery = ctx.can("delivery.read");

  if (!canReadOrders && !canReadPayments && !canReadInventory && !canReadDelivery) {
    throw new ForbiddenError("Home requires an operational read permission");
  }

  const bounds = rangeBounds(range);
  const [orders, payments, finance, inventory, deliveryResult] = await Promise.all([
    section(canReadOrders, () => dependencies.getOrderSummary(ctx.organizationId, bounds)),
    section(canReadPayments, async () => ({
      needsReviewCount: await dependencies.getPaymentAttention(ctx),
    })),
    section(canReadOrders && ctx.can("payments.reconcile"), async () => ({
      netCollectedForCreatedOrders: (await dependencies.getNetCollected(
        ctx.organizationId,
        bounds,
      )) as Money[],
    })),
    section(canReadInventory, async () => ({
      outOfStockVariantCount: await dependencies.getOutOfStockCount(ctx.organizationId),
    })),
    section(canReadDelivery, () => dependencies.getDeliveryAttention(ctx)),
  ]);

  const delivery: HomeSummary["delivery"] =
    deliveryResult.status === "available"
      ? deliveryResult.data.complete
        ? { status: "available", data: { actionCount: deliveryResult.data.count } }
        : { status: "truncated" }
      : deliveryResult;

  return { range, orders, payments, finance, inventory, delivery };
}
