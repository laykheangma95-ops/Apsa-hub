/**
 * Customer Intelligence — pure view rules for Customer Detail.
 *
 * Decides WHAT may be shown from a CustomerInsights payload and the caller's
 * current capability state; the component only renders the answer. Every
 * figure comes from the server (src/server/customers/insights.ts) — nothing is
 * counted, summed or converted here, and money is never combined across
 * currencies.
 *
 * Safe to bundle for the browser (type-only server import).
 */
import type {
  CustomerInsights,
  CustomerInsightsResult,
  CustomerMoney,
  CustomerTopProduct,
} from "@/server/customers/insights";
import type { Money } from "@/types";

export type { CustomerInsights, CustomerInsightsResult, CustomerMoney, CustomerTopProduct };

/** Display order for current delivery states: outcome first, then in-flight. */
const DELIVERY_ORDER = [
  "delivered",
  "in_transit",
  "ready",
  "preparing",
  "pending",
  "failed",
  "cancelled",
] as const;

const PAYMENT_ORDER = ["cash", "khqr", "bank_transfer", "cod"] as const;
const SOURCE_ORDER = ["POS", "FACEBOOK", "INSTAGRAM", "TELEGRAM", "MANUAL"] as const;

export type InsightMoney =
  /** The caller may not see money (server denied, or the grant lapsed since). */
  | { kind: "hidden" }
  /** Could not be loaded — says nothing about the customer. */
  | { kind: "unavailable" }
  /** One line per currency; never summed. Empty when the customer has no committed order. */
  | { kind: "values"; byCurrency: CustomerMoney[] };

/**
 * Money is shown only when BOTH the server returned it and the member may
 * still see sensitive customer values right now (pass `canSensitive`, not
 * `can` — a payload fetched under a since-revoked grant must not keep showing
 * spend).
 */
export function insightMoney(insights: CustomerInsights, sensitiveVisible: boolean): InsightMoney {
  if (!sensitiveVisible || insights.money.status === "permission_denied") return { kind: "hidden" };
  if (insights.money.status !== "available") return { kind: "unavailable" };
  return { kind: "values", byCurrency: insights.money.data };
}

/** The amounts of one money field, one per currency. */
export function moneyLines(
  byCurrency: readonly CustomerMoney[],
  field: "netPaid" | "averageOrder" | "outstanding" | "refunded",
): Money[] {
  return byCurrency.map((m) => m[field]);
}

/** Outstanding balances worth mentioning (non-zero), one per currency. */
export function outstandingLines(byCurrency: readonly CustomerMoney[]): Money[] {
  return moneyLines(byCurrency, "outstanding").filter((m) => m.amount > 0);
}

export interface CountPart<K extends string> {
  key: K;
  count: number;
}

function parts<K extends string>(
  counts: Partial<Record<K, number>>,
  order: readonly K[],
): CountPart<K>[] {
  return order.map((key) => ({ key, count: counts[key] ?? 0 })).filter((part) => part.count > 0);
}

export function deliveryParts(
  insights: CustomerInsights,
): CountPart<(typeof DELIVERY_ORDER)[number]>[] | null {
  if (insights.delivery.status !== "available") return null;
  return parts(insights.delivery.data.currentStatusCounts, DELIVERY_ORDER);
}

export function paymentParts(
  insights: CustomerInsights,
): CountPart<(typeof PAYMENT_ORDER)[number]>[] | null {
  if (insights.payments.status !== "available") return null;
  return parts(insights.payments.data.methodOrderCounts, PAYMENT_ORDER);
}

export function sourceParts(
  insights: CustomerInsights,
): CountPart<(typeof SOURCE_ORDER)[number]>[] {
  return parts(insights.activity.sourceCounts, SOURCE_ORDER);
}

/** "Product A · Black / M" — the variant the customer bought most of, when it has a name. */
export function topProductLabel(product: CustomerTopProduct): string {
  return product.topVariantLabel ? `${product.label} · ${product.topVariantLabel}` : product.label;
}
