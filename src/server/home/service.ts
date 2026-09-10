import type { AuthorizationContext } from "@/server/auth/authorization";
import type { AttentionItem, HomeSummary, MetricRange, Money } from "@/types";
import * as repo from "./repository";
import type { HomeRange, HomeRows } from "./types";

const PHNOM_PENH = "Asia/Phnom_Penh";

/** Phnom Penh is APSA's merchant default until organization timezone is modeled. */
export function rangeBounds(range: HomeRange, now = new Date()): { from: string; until: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHNOM_PENH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((parts, part) => {
      parts[part.type] = part.value;
      return parts;
    }, {});
  const start = new Date(`${date["year"]}-${date["month"]}-${date["day"]}T00:00:00+07:00`);
  if (range === "week") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (range === "month") start.setUTCDate(1);
  const until = new Date(start);
  if (range === "today") until.setUTCDate(until.getUTCDate() + 1);
  if (range === "week") until.setUTCDate(until.getUTCDate() + 7);
  if (range === "month") until.setUTCMonth(until.getUTCMonth() + 1);
  return { from: start.toISOString(), until: until.toISOString() };
}

function moneyByCurrency(rows: HomeRows["settlements"]): Money[] {
  const totals = new Map<Money["currency"], number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.net_minor);
  return Array.from(totals, ([currency, amount]) => ({ currency, amount })).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/** Pure mapping kept separate so every Home metric has one testable definition. */
export function summarizeHome(
  rows: HomeRows,
  permissions: { financials: boolean; inventory: boolean; delivery: boolean },
): HomeSummary {
  const attention: AttentionItem[] = [];
  const awaitingPayment = rows.activeOrders.filter(
    (order) =>
      order.lifecycle_status !== "cancelled" &&
      (order.payment_status === "unpaid" || order.payment_status === "pending"),
  ).length;
  if (awaitingPayment)
    attention.push({ id: "awaiting_payment", count: awaitingPayment, tone: "warning" });

  const orderActionNeeded = rows.activeOrders.filter(
    (order) => order.lifecycle_status === "draft" || order.fulfillment_status === "unfulfilled",
  ).length;
  if (orderActionNeeded)
    attention.push({ id: "orders_needing_action", count: orderActionNeeded, tone: "warning" });

  if (permissions.inventory) {
    // There is no configured reorder point in the production schema. A live
    // non-positive ledger balance is therefore the only honest stock alert.
    const lowStock = rows.stock.filter((row) => row.quantity_on_hand <= 0).length;
    if (lowStock) attention.push({ id: "low_stock", count: lowStock, tone: "danger" });
  }

  if (permissions.delivery) {
    const deliveryAction = rows.deliveries.filter((delivery) =>
      ["pending", "preparing", "ready", "failed"].includes(delivery.status),
    ).length;
    if (deliveryAction)
      attention.push({ id: "awaiting_delivery", count: deliveryAction, tone: "info" });
  }

  return {
    greetingName: "",
    revenues: permissions.financials ? moneyByCurrency(rows.settlements) : [],
    financialsAvailable: permissions.financials,
    attention,
    metrics: [
      { id: "orders", value: String(rows.periodOrders.length), deltaPercent: null, series: [] },
      { id: "pending_payments", value: String(awaitingPayment), deltaPercent: null, series: [] },
      ...(permissions.delivery
        ? [
            {
              id: "delivery_actions",
              value: String(
                rows.deliveries.filter((delivery) =>
                  ["pending", "preparing", "ready", "failed"].includes(delivery.status),
                ).length,
              ),
              deltaPercent: null,
              series: [],
            },
          ]
        : []),
      ...(permissions.inventory
        ? [
            {
              id: "low_stock",
              value: String(rows.stock.filter((row) => row.quantity_on_hand <= 0).length),
              deltaPercent: null,
              series: [],
            },
          ]
        : []),
    ],
    hasActivity:
      rows.periodOrders.length > 0 ||
      rows.activeOrders.length > 0 ||
      rows.stock.length > 0 ||
      rows.deliveries.length > 0,
  };
}

export async function getHomeSummary(
  ctx: AuthorizationContext,
  range: MetricRange = "today",
): Promise<HomeSummary> {
  // Home is an organization surface. Domain cards are permission-aware so a
  // legitimate limited role receives a truthful partial response, not a mock.
  ctx.require("organization.read");
  const financials = ctx.can("financials.revenue") && ctx.can("payments.reconcile");
  const inventory = ctx.can("inventory.read");
  const delivery = ctx.can("delivery.read");
  const rows = await repo.getHomeRows(ctx.organizationId, rangeBounds(range), {
    includeFinancials: financials,
    includeInventory: inventory,
    includeDelivery: delivery,
  });
  return summarizeHome(rows, { financials, inventory, delivery });
}
