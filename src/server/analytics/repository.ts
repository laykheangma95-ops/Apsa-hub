/**
 * Read-time Analytics aggregates over established transactional sources.
 *
 * Same completeness discipline as src/server/home/repository.ts (reused
 * directly, not re-implemented): every unbounded row set is walked to its
 * exact Content-Range count via `collectCompletePages`, and every "how many
 * have status X" number is an exact DB count, never a client-side count of a
 * possibly-capped page. No query here derives financial truth itself — sums
 * are read from `order_payment_totals` (migration 040), the one authoritative
 * settlement view, exactly as Home does.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { collectCompletePages } from "@/server/home/repository";
import {
  ORDER_FULFILLMENT_STATUSES,
  ORDER_LIFECYCLE_STATUSES,
  ORDER_PAYMENT_STATUSES,
  ORDER_REFUND_STATUSES,
  type OrderFulfillmentStatus,
  type OrderLifecycleStatus,
  type OrderPaymentStatus,
  type OrderRefundStatus,
} from "@/server/orders/state-machine";
import { PAYMENT_METHODS, type PaymentMethod } from "@/server/payments/state-machine";
import { DELIVERY_STATUSES, type DeliveryStatus } from "@/server/deliveries/state-machine";
// The Deliveries domain owns what "this order's current delivery attempt" means.
// Analytics reuses that derivation and defines no competing rule of its own.
import { listDeliveryAttemptRefsForOrders } from "@/server/deliveries/repository";
import type { Currency, Money } from "@/types";
import { QUALIFYING_LIFECYCLE_STATUSES, type AnalyticsBounds, type TopSellingItem } from "./types";

/**
 * A top-selling row as the repository computes it, with `grossAmount` always
 * present. The service masks it to `null` for a caller outside the financial
 * visibility boundary before it becomes a public `TopSellingItem`.
 */
export type TopSellingAggregate = Omit<TopSellingItem, "grossAmount"> & { grossAmount: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setAnalyticsRepositoryDbForTests(testDb: unknown): () => void {
  const previous = db;
  db = testDb;
  return () => {
    db = previous;
  };
}

function errorMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

/** Orders/payment-event chunk size for `.in()` filters — mirrors Home's SETTLEMENT_CHUNK_SIZE. */
const ID_CHUNK_SIZE = 100;

async function requireExactCount(label: string, query: PromiseLike<unknown>): Promise<number> {
  const result = (await query) as { count: number | null; error: unknown };
  if (result.error) throw new Error(`${label}: ${errorMessage(result.error)}`);
  if (result.count === null) throw new Error(`${label}: exact count unavailable`);
  return result.count;
}

export function chunkIds<T>(items: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function toMoneyList(totals: Map<Currency, number>): Money[] {
  return Array.from(totals, ([currency, amount]) => ({ currency, amount })).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

// ── Qualifying order cohort ──────────────────────────────────────────────────

export interface AnalyticsOrderRow {
  id: string;
  currency: Currency;
  total_minor: number;
  customer_id: string | null;
  created_at: string;
}

/** Complete, count-verified list of qualifying (confirmed/completed) orders created in the period. */
export async function listQualifyingOrders(
  organizationId: string,
  bounds: AnalyticsBounds,
): Promise<AnalyticsOrderRow[]> {
  const rows = await collectCompletePages<AnalyticsOrderRow>(async (offset, requested) => {
    const { data, error, count } = await db
      .from("orders")
      .select("id, currency, total_minor, customer_id, created_at", { count: "exact" })
      .eq("organization_id", organizationId)
      .in("lifecycle_status", QUALIFYING_LIFECYCLE_STATUSES)
      .gte("created_at", bounds.from)
      .lt("created_at", bounds.until)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + requested - 1);
    if (error) throw new Error(`listQualifyingOrders: ${errorMessage(error)}`);
    if (count === null) throw new Error("listQualifyingOrders: exact count unavailable");
    return { rows: (data ?? []) as AnalyticsOrderRow[], total: count };
  });

  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("listQualifyingOrders: duplicate order during pagination");
  }
  return rows;
}

// ── Status mixes (every order created in the period, not just qualifying) ───

async function countOrdersByColumn<S extends string>(
  organizationId: string,
  bounds: AnalyticsBounds,
  column: string,
  values: readonly S[],
): Promise<Record<S, number>> {
  const entries = await Promise.all(
    values.map(async (value) => {
      const count = await requireExactCount(
        `countOrdersByColumn(${column}=${value})`,
        db
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq(column, value)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.until),
      );
      return [value, count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<S, number>;
}

export interface OrderStatusCounts {
  lifecycleStatusCounts: Record<OrderLifecycleStatus, number>;
  paymentStatusCounts: Record<OrderPaymentStatus, number>;
  fulfillmentStatusCounts: Record<OrderFulfillmentStatus, number>;
  refundStatusCounts: Record<OrderRefundStatus, number>;
}

export async function getOrderStatusCounts(
  organizationId: string,
  bounds: AnalyticsBounds,
): Promise<OrderStatusCounts> {
  const [lifecycleStatusCounts, paymentStatusCounts, fulfillmentStatusCounts, refundStatusCounts] =
    await Promise.all([
      countOrdersByColumn(organizationId, bounds, "lifecycle_status", ORDER_LIFECYCLE_STATUSES),
      countOrdersByColumn(organizationId, bounds, "payment_status", ORDER_PAYMENT_STATUSES),
      countOrdersByColumn(organizationId, bounds, "fulfillment_status", ORDER_FULFILLMENT_STATUSES),
      countOrdersByColumn(organizationId, bounds, "refund_status", ORDER_REFUND_STATUSES),
    ]);
  return {
    lifecycleStatusCounts,
    paymentStatusCounts,
    fulfillmentStatusCounts,
    refundStatusCounts,
  };
}

export async function getPaymentMethodCounts(
  organizationId: string,
  bounds: AnalyticsBounds,
): Promise<Record<PaymentMethod, number>> {
  const entries = await Promise.all(
    PAYMENT_METHODS.map(async (method) => {
      const count = await requireExactCount(
        `getPaymentMethodCounts(${method})`,
        db
          .from("payments")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("method", method)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.until),
      );
      return [method, count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<PaymentMethod, number>;
}

/** Orders per latest-attempt resolution round trip — mirrors LATEST_ATTEMPT_CHUNK in the Deliveries service. */
const LATEST_ATTEMPT_CHUNK = 50;

/**
 * Every distinct order that had at least one delivery attempt created in the
 * period — complete and count-verified, so a capped page can never shrink the
 * cohort. This is only the COHORT; which attempt is current is decided by the
 * Deliveries domain (see getLatestDeliveryStatusCounts).
 */
export async function listOrderIdsWithDeliveryInPeriod(
  organizationId: string,
  bounds: AnalyticsBounds,
): Promise<string[]> {
  const rows = await collectCompletePages<{ order_id: string }>(async (offset, requested) => {
    const { data, error, count } = await db
      .from("deliveries")
      .select("order_id", { count: "exact" })
      .eq("organization_id", organizationId)
      .gte("created_at", bounds.from)
      .lt("created_at", bounds.until)
      .order("id", { ascending: true })
      .range(offset, offset + requested - 1);
    if (error) throw new Error(`listOrderIdsWithDeliveryInPeriod: ${errorMessage(error)}`);
    if (count === null) {
      throw new Error("listOrderIdsWithDeliveryInPeriod: exact count unavailable");
    }
    return { rows: (data ?? []) as { order_id: string }[], total: count };
  });
  return Array.from(new Set(rows.map((row) => row.order_id)));
}

export interface LatestDeliveryStatusCounts {
  statusCounts: Record<DeliveryStatus, number>;
  /**
   * True when at least one order in the cohort returned no authoritative
   * latest-attempt ref. That absence is UNKNOWN, never FALSE — the caller must
   * surface the counts as incomplete rather than as a certain mix.
   */
  unresolved: boolean;
}

/** Status of specific delivery rows, org-scoped. One row per requested id, proven complete. */
async function readDeliveryStatusesByIds(
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, DeliveryStatus>> {
  const byId = new Map<string, DeliveryStatus>();
  for (const idChunk of chunkIds(ids)) {
    const { data, error } = await db
      .from("deliveries")
      .select("id, status")
      .eq("organization_id", organizationId)
      .in("id", idChunk)
      .order("id", { ascending: true });
    if (error) throw new Error(`readDeliveryStatusesByIds: ${errorMessage(error)}`);
    const rows = (data ?? []) as { id: string; status: DeliveryStatus }[];
    // Exactly one row exists per requested id (they are primary keys we were
    // just handed), so a short response is a capped read, not a real absence.
    if (rows.length !== idChunk.length || new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error("readDeliveryStatusesByIds: incomplete delivery status read");
    }
    for (const row of rows) byId.set(row.id, row.status);
  }
  return byId;
}

/**
 * Delivery status mix counted ONE PER ORDER, on that order's CURRENT attempt.
 *
 * A raw per-attempt count double-reports retried deliveries: an order that
 * failed and was then delivered would show `failed: 1, delivered: 1`, telling
 * the merchant a delivery failed that in fact succeeded. This resolves each
 * order's current attempt through the Deliveries domain's own authoritative
 * derivation (`listDeliveryAttemptRefsForOrders` — newest
 * `created_at DESC, id DESC` row per order, read one bounded `.limit(1)` query
 * at a time so no PostgREST row ceiling can hide it) and counts only that.
 * The same order therefore contributes exactly 1 to exactly one status.
 *
 * The current attempt is the order's latest overall, not its latest within the
 * period — a delivery retried after the period boundary has genuinely
 * superseded the in-period attempt, and reporting the stale one as current
 * would be the very defect this fixes.
 */
export async function getDeliveryStatusCounts(
  organizationId: string,
  bounds: AnalyticsBounds,
): Promise<LatestDeliveryStatusCounts> {
  const statusCounts = Object.fromEntries(DELIVERY_STATUSES.map((status) => [status, 0])) as Record<
    DeliveryStatus,
    number
  >;

  const orderIds = await listOrderIdsWithDeliveryInPeriod(organizationId, bounds);
  if (orderIds.length === 0) return { statusCounts, unresolved: false };

  let unresolved = false;
  const latestIds: string[] = [];
  for (const chunk of chunkIds(orderIds, LATEST_ATTEMPT_CHUNK)) {
    const refs = await listDeliveryAttemptRefsForOrders(organizationId, chunk);
    const latestByOrder = new Map<string, string>();
    for (const ref of refs) latestByOrder.set(ref.order_id, ref.id);
    for (const orderId of chunk) {
      const latestId = latestByOrder.get(orderId);
      if (latestId === undefined) {
        unresolved = true;
        continue;
      }
      latestIds.push(latestId);
    }
  }

  const statusById = await readDeliveryStatusesByIds(organizationId, latestIds);
  for (const id of latestIds) {
    const status = statusById.get(id);
    // Belt-and-braces: readDeliveryStatusesByIds already proves completeness.
    if (status === undefined) {
      unresolved = true;
      continue;
    }
    statusCounts[status] += 1;
  }

  return { statusCounts, unresolved };
}

// ── Settlement sums (order_payment_totals — the one authoritative view) ─────

export interface SettlementTotals {
  orderedGross: Money[];
  collectedGross: Money[];
  refundedAmount: Money[];
  outstandingAmount: Money[];
}

interface SettlementRow {
  order_id: string;
  currency: Currency;
  total_minor: number;
  received_minor: number;
  refunded_minor: number;
}

export async function getSettlementTotals(
  organizationId: string,
  orders: readonly AnalyticsOrderRow[],
): Promise<SettlementTotals> {
  const orderedByCurrency = new Map<Currency, number>();
  for (const order of orders) {
    orderedByCurrency.set(
      order.currency,
      (orderedByCurrency.get(order.currency) ?? 0) + order.total_minor,
    );
  }

  const collectedByCurrency = new Map<Currency, number>();
  const refundedByCurrency = new Map<Currency, number>();
  const outstandingByCurrency = new Map<Currency, number>();

  for (const idChunk of chunkIds(orders.map((order) => order.id))) {
    const { data, error } = await db
      .from("order_payment_totals")
      .select("order_id, currency, total_minor, received_minor, refunded_minor")
      .eq("organization_id", organizationId)
      .in("order_id", idChunk)
      .order("order_id", { ascending: true });
    if (error) throw new Error(`getSettlementTotals: ${errorMessage(error)}`);
    const rows = (data ?? []) as SettlementRow[];
    // The view has exactly one row per Order — same completeness proof Home uses.
    if (
      rows.length !== idChunk.length ||
      new Set(rows.map((row) => row.order_id)).size !== idChunk.length
    ) {
      throw new Error("getSettlementTotals: incomplete order cohort");
    }
    for (const row of rows) {
      collectedByCurrency.set(
        row.currency,
        (collectedByCurrency.get(row.currency) ?? 0) + row.received_minor,
      );
      refundedByCurrency.set(
        row.currency,
        (refundedByCurrency.get(row.currency) ?? 0) + row.refunded_minor,
      );
      const outstanding = Math.max(row.total_minor - row.received_minor, 0);
      outstandingByCurrency.set(
        row.currency,
        (outstandingByCurrency.get(row.currency) ?? 0) + outstanding,
      );
    }
  }

  return {
    orderedGross: toMoneyList(orderedByCurrency),
    collectedGross: toMoneyList(collectedByCurrency),
    refundedAmount: toMoneyList(refundedByCurrency),
    outstandingAmount: toMoneyList(outstandingByCurrency),
  };
}

// ── Top-selling items ─────────────────────────────────────────────────────────

interface AnalyticsOrderItemRow {
  order_id: string;
  product_id: string;
  variant_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  quantity: number;
  line_total_minor: number;
}

async function listOrderItemsForOrders(
  organizationId: string,
  orderIds: readonly string[],
): Promise<AnalyticsOrderItemRow[]> {
  const all: AnalyticsOrderItemRow[] = [];
  for (const idChunk of chunkIds(orderIds)) {
    const rows = await collectCompletePages<AnalyticsOrderItemRow>(async (offset, requested) => {
      const { data, error, count } = await db
        .from("order_items")
        .select(
          "order_id, product_id, variant_id, product_name_snapshot, variant_name_snapshot, quantity, line_total_minor",
          { count: "exact" },
        )
        .eq("organization_id", organizationId)
        .in("order_id", idChunk)
        .order("order_id", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + requested - 1);
      if (error) throw new Error(`listOrderItemsForOrders: ${errorMessage(error)}`);
      if (count === null) throw new Error("listOrderItemsForOrders: exact count unavailable");
      return { rows: (data ?? []) as AnalyticsOrderItemRow[], total: count };
    });
    all.push(...rows);
  }
  return all;
}

/**
 * Code-point comparison, not `localeCompare`. A tie-break must be identical on
 * every machine that runs it; `localeCompare` resolves against an ambient
 * locale and would let two servers rank the same Khmer product names
 * differently.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ranking order for top-selling items: quantity desc, then a deterministic
 * NON-MONETARY tie-break.
 *
 * WHY NO MONEY IN THE TIE-BREAK. These rows are not partitioned by currency,
 * and `grossAmount` is a minor-unit integer in each row's own currency. 20 000
 * riel and 20 000 cents are not comparable quantities, so breaking a quantity
 * tie by `grossAmount` ranked a KHR line above a USD line purely because riel
 * has a smaller unit — an FX judgement made by accident, with no rate and no
 * rate timestamp. Ranking stays currency-independent: snapshot name, then the
 * stable product/variant/currency identifiers, all of which are total and
 * order the list identically whatever the currencies involved.
 *
 * If a future phase wants revenue ranking, it must partition the metric by
 * currency explicitly rather than reintroduce a cross-currency numeric compare.
 */
export function compareTopSellingItems(a: TopSellingAggregate, b: TopSellingAggregate): number {
  return (
    b.quantitySold - a.quantitySold ||
    compareText(a.displayLabel, b.displayLabel) ||
    compareText(a.productId, b.productId) ||
    compareText(a.variantId, b.variantId) ||
    compareText(a.currency, b.currency)
  );
}

/**
 * Aggregates the COMPLETE authorized cohort of order lines before sorting —
 * `limit` only slices the finished aggregate, it never bounds what gets read.
 */
export function aggregateTopSellingItems(
  items: readonly AnalyticsOrderItemRow[],
  currencyByOrder: ReadonlyMap<string, Currency>,
  limit: number,
): TopSellingAggregate[] {
  const totals = new Map<string, TopSellingAggregate>();
  for (const item of items) {
    const currency = currencyByOrder.get(item.order_id);
    if (!currency) continue;
    const key = `${item.product_id}::${item.variant_id}::${currency}`;
    const label = item.variant_name_snapshot
      ? `${item.product_name_snapshot} — ${item.variant_name_snapshot}`
      : item.product_name_snapshot;
    const existing = totals.get(key);
    if (existing) {
      existing.quantitySold += item.quantity;
      existing.grossAmount += item.line_total_minor;
    } else {
      totals.set(key, {
        productId: item.product_id,
        variantId: item.variant_id,
        currency,
        displayLabel: label,
        quantitySold: item.quantity,
        grossAmount: item.line_total_minor,
      });
    }
  }

  return Array.from(totals.values()).sort(compareTopSellingItems);
}

export async function listTopSellingItems(
  organizationId: string,
  orders: readonly AnalyticsOrderRow[],
  limit: number,
): Promise<TopSellingAggregate[]> {
  if (orders.length === 0) return [];
  const currencyByOrder = new Map(orders.map((order) => [order.id, order.currency]));
  const items = await listOrderItemsForOrders(
    organizationId,
    orders.map((order) => order.id),
  );
  return aggregateTopSellingItems(items, currencyByOrder, limit).slice(0, limit);
}

// ── Customer cohort (new vs repeat) ──────────────────────────────────────────

export interface CustomerCohort {
  totalCustomers: number;
  newCustomers: number;
  repeatCustomers: number;
  unattributedOrderCount: number;
  repeatOrderCount: number;
}

/**
 * Distinct customer_ids, among `customerIds`, that already had a qualifying
 * order strictly before `before`. Selects only `customer_id` (not `*`), but
 * still walks every matching row via `collectCompletePages` — a prolific
 * customer's full prior-order count is the cost of never risking a false
 * "new customer" from a capped page.
 */
async function listCustomersWithPriorOrder(
  organizationId: string,
  customerIds: readonly string[],
  before: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const idChunk of chunkIds(customerIds)) {
    const rows = await collectCompletePages<{ customer_id: string }>(async (offset, requested) => {
      const { data, error, count } = await db
        .from("orders")
        .select("customer_id", { count: "exact" })
        .eq("organization_id", organizationId)
        .in("customer_id", idChunk)
        .in("lifecycle_status", QUALIFYING_LIFECYCLE_STATUSES)
        .lt("created_at", before)
        .order("id", { ascending: true })
        .range(offset, offset + requested - 1);
      if (error) throw new Error(`listCustomersWithPriorOrder: ${errorMessage(error)}`);
      if (count === null) throw new Error("listCustomersWithPriorOrder: exact count unavailable");
      return { rows: (data ?? []) as { customer_id: string }[], total: count };
    });
    for (const row of rows) found.add(row.customer_id);
  }
  return found;
}

export async function getCustomerCohort(
  organizationId: string,
  orders: readonly AnalyticsOrderRow[],
  bounds: AnalyticsBounds,
): Promise<CustomerCohort> {
  const attributed = orders.filter(
    (order): order is AnalyticsOrderRow & { customer_id: string } => order.customer_id !== null,
  );
  const unattributedOrderCount = orders.length - attributed.length;
  const distinctCustomerIds = Array.from(new Set(attributed.map((order) => order.customer_id)));

  const priorCustomerIds =
    distinctCustomerIds.length > 0
      ? await listCustomersWithPriorOrder(organizationId, distinctCustomerIds, bounds.from)
      : new Set<string>();

  let repeatCustomers = 0;
  for (const customerId of distinctCustomerIds) {
    if (priorCustomerIds.has(customerId)) repeatCustomers += 1;
  }

  let repeatOrderCount = 0;
  for (const order of attributed) {
    if (priorCustomerIds.has(order.customer_id)) repeatOrderCount += 1;
  }

  return {
    totalCustomers: distinctCustomerIds.length,
    newCustomers: distinctCustomerIds.length - repeatCustomers,
    repeatCustomers,
    unattributedOrderCount,
    repeatOrderCount,
  };
}
