/**
 * Read-time Home aggregates over established transactional sources.
 * Every query is tenant-scoped and every unbounded row set is walked to its
 * exact Content-Range count; a PostgREST row cap can therefore never turn a
 * partial response into an authoritative Home number.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { Money } from "@/types";
import type {
  HomeActiveVariantRow,
  HomeOrderIdRow,
  HomeSettlementRow,
  HomeStockRow,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setHomeRepositoryDbForTests(testDb: unknown): () => void {
  const previous = db;
  db = testDb;
  return () => {
    db = previous;
  };
}

function errorMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

const PAGE_SIZE = 500;
const SETTLEMENT_CHUNK_SIZE = 100;

export interface CompletePage<T> {
  rows: T[];
  total: number;
}

/**
 * Collect a counted PostgREST result without assuming how many rows the server
 * permits in one response. If the count changes mid-read, fail closed instead
 * of displaying a number assembled from inconsistent snapshots.
 */
export async function collectCompletePages<T>(
  fetchPage: (offset: number, requested: number) => Promise<CompletePage<T>>,
  requested = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  let expectedTotal: number | null = null;

  while (expectedTotal === null || rows.length < expectedTotal) {
    const page = await fetchPage(rows.length, requested);
    if (!Number.isInteger(page.total) || page.total < 0) {
      throw new Error("Home aggregate returned no exact row count");
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) {
      throw new Error("Home aggregate changed while it was being read");
    }
    if (page.rows.length === 0) {
      if (rows.length === expectedTotal) break;
      throw new Error("Home aggregate ended before its exact row count");
    }
    rows.push(...page.rows);
  }

  if (rows.length !== expectedTotal) {
    throw new Error("Home aggregate exceeded its exact row count");
  }
  return rows;
}

async function requireExactCount(label: string, query: PromiseLike<unknown>): Promise<number> {
  const result = (await query) as { count: number | null; error: unknown };
  if (result.error) throw new Error(`${label}: ${errorMessage(result.error)}`);
  if (result.count === null) throw new Error(`${label}: exact count unavailable`);
  return result.count;
}

export interface HomeOrderSummary {
  periodCount: number;
  awaitingPaymentCount: number;
  actionNeededCount: number;
}

export async function getHomeOrderSummary(
  organizationId: string,
  range: { from: string; until: string },
): Promise<HomeOrderSummary> {
  const baseCount = () =>
    db
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);

  const [periodCount, awaitingPaymentCount, actionNeededCount] = await Promise.all([
    requireExactCount(
      "getHome period orders",
      baseCount().gte("created_at", range.from).lt("created_at", range.until),
    ),
    requireExactCount(
      "getHome orders awaiting payment",
      baseCount().neq("lifecycle_status", "cancelled").in("payment_status", ["unpaid", "pending"]),
    ),
    requireExactCount(
      "getHome orders needing action",
      baseCount()
        .neq("lifecycle_status", "cancelled")
        .or("lifecycle_status.eq.draft,fulfillment_status.eq.unfulfilled"),
    ),
  ]);

  return { periodCount, awaitingPaymentCount, actionNeededCount };
}

async function listPeriodOrderIds(
  organizationId: string,
  range: { from: string; until: string },
): Promise<HomeOrderIdRow[]> {
  const rows = await collectCompletePages<HomeOrderIdRow>(async (offset, requested) => {
    const { data, error, count } = await db
      .from("orders")
      .select("id, created_at", { count: "exact" })
      .eq("organization_id", organizationId)
      .gte("created_at", range.from)
      .lt("created_at", range.until)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + requested - 1);
    if (error) throw new Error(`getHome finance orders: ${errorMessage(error)}`);
    if (count === null) throw new Error("getHome finance orders: exact count unavailable");
    return { rows: (data ?? []) as HomeOrderIdRow[], total: count };
  });

  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("getHome finance orders: duplicate order during pagination");
  }
  return rows;
}

export function sumSettlementsByCurrency(rows: HomeSettlementRow[]): Money[] {
  const totals = new Map<Money["currency"], number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.net_minor);
  }
  return Array.from(totals, ([currency, amount]) => ({ currency, amount })).sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/**
 * Lifetime Payment-ledger net for the cohort of orders created in the selected
 * period. This is deliberately not labeled as money settled during the period.
 */
export async function getNetCollectedForCreatedOrders(
  organizationId: string,
  range: { from: string; until: string },
): Promise<Money[]> {
  const orderIds = (await listPeriodOrderIds(organizationId, range)).map((row) => row.id);
  const settlements: HomeSettlementRow[] = [];

  for (let index = 0; index < orderIds.length; index += SETTLEMENT_CHUNK_SIZE) {
    const chunk = orderIds.slice(index, index + SETTLEMENT_CHUNK_SIZE);
    const { data, error } = await db
      .from("order_payment_totals")
      .select("order_id, organization_id, currency, net_minor")
      .eq("organization_id", organizationId)
      .in("order_id", chunk)
      .order("order_id", { ascending: true });
    if (error) throw new Error(`getHome settlements: ${errorMessage(error)}`);
    const rows = (data ?? []) as HomeSettlementRow[];
    // The view has exactly one row per Order. Missing/duplicate rows mean the
    // financial answer is not provably complete, so Home must show unavailable.
    if (
      rows.length !== chunk.length ||
      new Set(rows.map((row) => row.order_id)).size !== chunk.length
    ) {
      throw new Error("getHome settlements: incomplete order cohort");
    }
    settlements.push(...rows);
  }

  return sumSettlementsByCurrency(settlements);
}

async function listActiveVariants(organizationId: string): Promise<HomeActiveVariantRow[]> {
  const rows = await collectCompletePages<HomeActiveVariantRow>(async (offset, requested) => {
    const { data, error, count } = await db
      .from("product_variants")
      .select("id, product_id, products!inner(status)", { count: "exact" })
      .eq("organization_id", organizationId)
      .eq("products.organization_id", organizationId)
      .eq("status", "ACTIVE")
      .eq("products.status", "ACTIVE")
      .order("id", { ascending: true })
      .range(offset, offset + requested - 1);
    if (error) throw new Error(`getHome active variants: ${errorMessage(error)}`);
    if (count === null) throw new Error("getHome active variants: exact count unavailable");
    return { rows: (data ?? []) as HomeActiveVariantRow[], total: count };
  });

  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("getHome active variants: duplicate variant during pagination");
  }
  return rows;
}

async function listStockRows(organizationId: string): Promise<HomeStockRow[]> {
  return collectCompletePages<HomeStockRow>(async (offset, requested) => {
    const { data, error, count } = await db
      .from("inventory_stock")
      .select("organization_id, product_id, variant_id, location_id, quantity_on_hand", {
        count: "exact",
      })
      .eq("organization_id", organizationId)
      .order("variant_id", { ascending: true })
      .order("location_id", { ascending: true, nullsFirst: true })
      .range(offset, offset + requested - 1);
    if (error) throw new Error(`getHome inventory stock: ${errorMessage(error)}`);
    if (count === null) throw new Error("getHome inventory stock: exact count unavailable");
    return { rows: (data ?? []) as HomeStockRow[], total: count };
  });
}

export function countOutOfStockVariants(
  activeVariants: HomeActiveVariantRow[],
  stockRows: HomeStockRow[],
): number {
  const quantityByVariant = new Map(activeVariants.map((variant) => [variant.id, 0]));
  for (const row of stockRows) {
    if (!quantityByVariant.has(row.variant_id)) continue;
    quantityByVariant.set(
      row.variant_id,
      (quantityByVariant.get(row.variant_id) ?? 0) + row.quantity_on_hand,
    );
  }
  return Array.from(quantityByVariant.values()).filter((quantity) => quantity <= 0).length;
}

/** Active-variant, all-location stock truth; variants with no movements count as zero. */
export async function getOutOfStockVariantCount(organizationId: string): Promise<number> {
  const [activeVariants, stockRows] = await Promise.all([
    listActiveVariants(organizationId),
    listStockRows(organizationId),
  ]);
  return countOutOfStockVariants(activeVariants, stockRows);
}
