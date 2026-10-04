/**
 * Customer Intelligence V1 — what one customer has actually bought, derived on
 * read from APSA's own authoritative commerce records (migration 060). Nothing
 * here is stored, predicted, scored or inferred from message content.
 *
 * Never import this file from browser-bundled code.
 *
 * ── METRIC DEFINITIONS ───────────────────────────────────────────────────────
 * Tenant: every figure is filtered on the caller's organization (resolved
 * server-side from the active membership) inside the SQL itself. A customer of
 * another organization is "not found".
 *
 * Committed order — orders.lifecycle_status IN ('confirmed','completed'), the
 * same cohort as Analytics' QUALIFYING_LIFECYCLE_STATUSES. Draft orders are not
 * sales yet and are ignored everywhere. Cancelled orders are counted
 * (`cancelledOrderCount`) and contribute NOTHING else — no money, no products,
 * no delivery or return figures.
 *
 *   orderCount            committed orders.
 *   openOrderCount        committed orders still `confirmed` (in fulfilment).
 *   completedOrderCount   committed orders `completed`.
 *   refundedOrderCount    committed orders whose refund_status is partial/full.
 *   firstOrderAt / lastOrderAt   created_at of the first/last committed order;
 *                         null when there is none. Ties on lastOrderAt break
 *                         on order id.
 *   lastOrderProducts     product snapshot labels on the last committed order.
 *   unitsPurchased / distinctProductCount   order_items quantities on committed
 *                         orders. GROSS: a return does not subtract units
 *                         (returns are reported on their own, below).
 *   sourceCounts          committed orders by orders.source (POS / FACEBOOK /
 *                         INSTAGRAM / TELEGRAM / MANUAL), as the order recorded it.
 *   conversationLinkedOrderCount   committed orders with a
 *                         source_conversation_ref — provenance metadata only;
 *                         no message body is read.
 *
 * Money (`money`, one entry PER CURRENCY, never summed or converted — APSA
 * records no exchange rate on orders, so a USD+KHR total would be invented):
 *   ordered       Σ orders.total_minor of committed orders.
 *   received      Σ order_payment_totals.received_minor — principal of payments
 *                 that reached paid/refunded. A COD or pending payment counts
 *                 only once Payments says it was received.
 *   refunded      Σ order_payment_totals.refunded_minor.
 *   netPaid       received − refunded. This is "total spent": what the
 *                 customer has actually paid and kept paid, identical to the
 *                 Payments ledger. A RETURN does not change it; a REFUND does.
 *   outstanding   Σ max(total − received, 0) — still owed (e.g. COD not yet
 *                 collected).
 *   averageOrder  ordered / orderCount in that currency, rounded half-up in
 *                 integer arithmetic.
 *
 * Payments (`payments`): committed orders that have ≥1 payment of a method that
 * was not failed or reversed — "this method was used", not "this much".
 *
 * Delivery (`delivery`): per committed order, the CURRENT state is its newest
 * attempt (created_at DESC, id DESC — the Deliveries domain's own rule);
 * `failedAttemptCount` counts every failed attempt, so a failure followed by a
 * successful redelivery is still visible.
 *
 * Returns (`returns`): customer_returns on committed orders. Partial returns
 * exist (line quantities); `completedReturnedUnits` sums completed return lines.
 *
 * Product affinity (`topProducts`): units per product on committed orders,
 * ranked by units, then orders, then most recent purchase, then product id —
 * deterministic. Labels are the order-line SNAPSHOTS, never the live catalogue,
 * so an archived or renamed product still reads as what was bought.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * The whole read needs `customers.read` AND `orders.read` — the same pair the
 * Customer Detail order history already needs. Each section beyond that reuses
 * an existing grant; a denied section is never read by the database and comes
 * back `permission_denied`, never zero-filled:
 *   money     canReadFinancials (orders.read AND payments.reconcile — Home's and
 *             Analytics' one definition of "may see money") AND
 *             customers.view_sensitive (Customer Detail already hides spend
 *             without it). Both, so neither rule is weakened.
 *   payments  payments.read
 *   delivery  delivery.read
 *   returns   orders.return (with orders.read — the Returns domain's own read gate)
 * No new permission is introduced.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { canReadFinancials } from "@/server/home/service";
import { ORDER_SOURCES, type OrderSourceDb } from "@/server/orders/types";
import { PAYMENT_METHODS, type PaymentMethod } from "@/server/payments/state-machine";
import { DELIVERY_STATUSES, type DeliveryStatus } from "@/server/deliveries/state-machine";
import type { Currency, HomeSection, Money } from "@/types";
import * as repo from "./repository";
import type { PurchaseProfileSections } from "./repository";
import type { PurchaseProfileRow } from "./types";

/** Top products returned to Customer Detail. The SQL also caps this (1–10). */
export const CUSTOMER_TOP_PRODUCTS_LIMIT = 5;

export interface CustomerTopProduct {
  productId: string;
  /** product_name_snapshot from the customer's most recent line for this product. */
  label: string;
  /** The variant snapshot the customer bought most of; null when the line had none. */
  topVariantLabel: string | null;
  /** Distinct variants of this product the customer has bought. */
  variantCount: number;
  units: number;
  orderCount: number;
  lastPurchasedAt: string;
}

export interface CustomerMoney {
  currency: Currency;
  orderCount: number;
  ordered: Money;
  received: Money;
  refunded: Money;
  netPaid: Money;
  outstanding: Money;
  averageOrder: Money;
}

export interface CustomerActivity {
  orderCount: number;
  openOrderCount: number;
  completedOrderCount: number;
  cancelledOrderCount: number;
  refundedOrderCount: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  lastOrderId: string | null;
  lastOrderSource: OrderSourceDb | null;
  lastOrderProducts: string[];
  distinctProductCount: number;
  unitsPurchased: number;
  conversationLinkedOrderCount: number;
  sourceCounts: Partial<Record<OrderSourceDb, number>>;
}

export interface CustomerInsights {
  customerId: string;
  /**
   * False when the customer has no committed order. The UI says "no purchase
   * history yet" instead of rendering a row of zeros.
   */
  hasPurchases: boolean;
  activity: CustomerActivity;
  topProducts: CustomerTopProduct[];
  /** One entry per currency the customer has committed orders in. Never converted. */
  money: HomeSection<CustomerMoney[]>;
  payments: HomeSection<{ methodOrderCounts: Partial<Record<PaymentMethod, number>> }>;
  delivery: HomeSection<{
    ordersWithDelivery: number;
    failedAttemptCount: number;
    currentStatusCounts: Partial<Record<DeliveryStatus, number>>;
  }>;
  returns: HomeSection<{
    returnCount: number;
    returnedOrderCount: number;
    completedReturnCount: number;
    completedReturnedUnits: number;
  }>;
}

export interface CustomerInsightsDependencies {
  getCustomerPurchaseProfile: typeof repo.getCustomerPurchaseProfile;
}

const defaultDependencies: CustomerInsightsDependencies = {
  getCustomerPurchaseProfile: repo.getCustomerPurchaseProfile,
};

/** The sections this caller may see — decided here, from the resolved grants, never from input. */
export function customerInsightSections(ctx: AuthorizationContext): PurchaseProfileSections {
  return {
    money: canReadFinancials(ctx) && ctx.can("customers.view_sensitive"),
    payments: ctx.can("payments.read"),
    delivery: ctx.can("delivery.read"),
    returns: ctx.can("orders.return"),
  };
}

export async function getCustomerInsights(
  ctx: AuthorizationContext,
  customerId: string,
  dependencies: CustomerInsightsDependencies = defaultDependencies,
): Promise<CustomerInsights> {
  ctx.require("customers.read");
  ctx.require("orders.read");

  const sections = customerInsightSections(ctx);
  const row = await dependencies.getCustomerPurchaseProfile(
    ctx.organizationId,
    customerId,
    sections,
    CUSTOMER_TOP_PRODUCTS_LIMIT,
  );
  if (!row.customer_found) throw publicError("Customer not found", 404);
  return toCustomerInsights(customerId, row, sections);
}

// ── Pure mapping ──────────────────────────────────────────────────────────────

/** A count or minor-unit sum from the database: an exact, non-negative safe integer or a hard failure. */
function whole(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`customer insights: ${field} is not a non-negative safe integer`);
  }
  return n;
}

function currencyOf(value: unknown): Currency {
  if (value === "USD" || value === "KHR") return value;
  throw new Error(`customer insights: unknown currency ${String(value)}`);
}

/**
 * ordered / count, rounded half-up, in integer arithmetic (BigInt) — never a
 * floating-point division of money.
 */
export function averageMinor(totalMinor: number, count: number): number {
  if (count <= 0) throw new Error("customer insights: average over zero orders");
  const total = BigInt(totalMinor);
  const n = BigInt(count);
  return Number((total * 2n + n) / (n * 2n));
}

function knownCounts<K extends string>(
  raw: Record<string, unknown> | null | undefined,
  known: readonly K[],
  field: string,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of known) {
    const value = raw?.[key];
    if (value === undefined || value === null) continue;
    const n = whole(value, `${field}.${key}`);
    if (n > 0) out[key] = n;
  }
  return out;
}

function gated<T>(allowed: boolean, value: unknown, build: () => T): HomeSection<T> {
  // Defense in depth: a section the caller may not see is withheld even if
  // the database (wrongly) returned it.
  if (!allowed) return { status: "permission_denied" };
  if (value === null || value === undefined) return { status: "error" };
  return { status: "available", data: build() };
}

export function toCustomerInsights(
  customerId: string,
  row: PurchaseProfileRow,
  sections: PurchaseProfileSections,
): CustomerInsights {
  const a = row.activity;
  if (!a) throw new Error("customer insights: activity missing");

  const orderCount = whole(a.qualifying_order_count, "qualifying_order_count");
  const lastOrderSource = (ORDER_SOURCES as readonly string[]).includes(a.last_order_source ?? "")
    ? (a.last_order_source as OrderSourceDb)
    : null;

  const activity: CustomerActivity = {
    orderCount,
    openOrderCount: whole(a.confirmed_order_count, "confirmed_order_count"),
    completedOrderCount: whole(a.completed_order_count, "completed_order_count"),
    cancelledOrderCount: whole(a.cancelled_order_count, "cancelled_order_count"),
    refundedOrderCount: whole(a.refunded_order_count, "refunded_order_count"),
    firstOrderAt: a.first_order_at ?? null,
    lastOrderAt: a.last_order_at ?? null,
    lastOrderId: a.last_order_id ?? null,
    lastOrderSource,
    lastOrderProducts: (row.last_order_products ?? []).filter(
      (label): label is string => typeof label === "string" && label.trim().length > 0,
    ),
    distinctProductCount: whole(a.distinct_product_count, "distinct_product_count"),
    unitsPurchased: whole(a.total_units, "total_units"),
    conversationLinkedOrderCount: whole(
      a.conversation_linked_order_count,
      "conversation_linked_order_count",
    ),
    sourceCounts: knownCounts(a.source_counts, ORDER_SOURCES, "source_counts"),
  };

  const topProducts: CustomerTopProduct[] = (row.top_products ?? []).map((p) => ({
    productId: p.product_id,
    label: p.product_label,
    topVariantLabel: p.top_variant_label?.trim() ? p.top_variant_label : null,
    variantCount: whole(p.variant_count, "top_products.variant_count"),
    units: whole(p.units, "top_products.units"),
    orderCount: whole(p.order_count, "top_products.order_count"),
    lastPurchasedAt: p.last_purchased_at,
  }));

  const money = gated(sections.money, row.money, () =>
    (row.money ?? []).map((m): CustomerMoney => {
      const currency = currencyOf(m.currency);
      const count = whole(m.order_count, "money.order_count");
      const ordered = whole(m.ordered_minor, "money.ordered_minor");
      const received = whole(m.received_minor, "money.received_minor");
      const refunded = whole(m.refunded_minor, "money.refunded_minor");
      // net = received - refunded can never be negative (a refund is bounded
      // by what was received), but the ledger is the authority, so it is read,
      // not recomputed — and it is the one value allowed to be checked signed.
      const net = Number(m.net_minor);
      if (!Number.isSafeInteger(net)) throw new Error("customer insights: money.net_minor");
      return {
        currency,
        orderCount: count,
        ordered: { amount: ordered, currency },
        received: { amount: received, currency },
        refunded: { amount: refunded, currency },
        netPaid: { amount: net, currency },
        outstanding: { amount: whole(m.outstanding_minor, "money.outstanding_minor"), currency },
        averageOrder: { amount: averageMinor(ordered, count), currency },
      };
    }),
  );

  const payments = gated(sections.payments, row.payments, () => ({
    methodOrderCounts: knownCounts(
      row.payments?.method_order_counts,
      PAYMENT_METHODS,
      "method_order_counts",
    ),
  }));

  const delivery = gated(sections.delivery, row.delivery, () => ({
    ordersWithDelivery: whole(row.delivery!.orders_with_delivery, "orders_with_delivery"),
    failedAttemptCount: whole(row.delivery!.failed_attempt_count, "failed_attempt_count"),
    currentStatusCounts: knownCounts(
      row.delivery!.current_status_counts,
      DELIVERY_STATUSES,
      "current_status_counts",
    ),
  }));

  const returns = gated(sections.returns, row.returns, () => ({
    returnCount: whole(row.returns!.return_count, "return_count"),
    returnedOrderCount: whole(row.returns!.returned_order_count, "returned_order_count"),
    completedReturnCount: whole(row.returns!.completed_return_count, "completed_return_count"),
    completedReturnedUnits: whole(
      row.returns!.completed_returned_units,
      "completed_returned_units",
    ),
  }));

  return {
    customerId,
    hasPurchases: orderCount > 0,
    activity,
    topProducts,
    money,
    payments,
    delivery,
    returns,
  };
}
