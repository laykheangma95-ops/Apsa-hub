/**
 * Inventory repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id so RLS + application code are both layered.
 *   - Use supabaseAdmin (service-role) so writes bypass row-level RLS; RLS is still
 *     defense-in-depth. The cross-tenant integrity trigger fires on every INSERT
 *     of inventory_movements regardless of who is writing.
 *
 * The ledger (inventory_movements) is append-only: this file exposes insert and
 * list operations only — no update/delete function exists for movements.
 *
 * `supabaseAdmin as any` is used because inventory_movements / inventory_stock
 * are not yet in the generated Supabase types (migration 021 not yet applied to
 * the live project). After `supabase gen types typescript` is run, remove the cast.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  ActiveVariantIdentityRow,
  InventoryLocationRow,
  InventoryMovementRow,
  InventoryStockRow,
  CreateMovementInput,
  ListMovementsOptions,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

/** Test-only override for exercising repository functions against a mocked query chain. */
export function setInventoryRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

/** PostgREST "The result contains 0 rows" — returned by .single() on a genuine no-row. */
const PGRST_NO_ROW = "PGRST116";
/** Postgres unique_violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

// ── Movements (append-only) ───────────────────────────────────────────────────

export async function insertMovement(
  organizationId: string,
  input: CreateMovementInput,
): Promise<InventoryMovementRow> {
  const { data, error } = await db
    .from("inventory_movements")
    .insert({ organization_id: organizationId, ...input })
    .select()
    .single();

  if (error || !data) {
    const message = (error as { message?: string })?.message ?? "no data";
    const code = (error as { code?: string })?.code;
    const err = new Error(`insertMovement: ${message}`);
    if (code) (err as Error & { code?: string }).code = code;
    throw err;
  }
  return data as InventoryMovementRow;
}

/** True when a repository error represents a duplicate idempotency-reference insert. */
export function isDuplicateReferenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return code === PG_UNIQUE_VIOLATION || err.message.includes("uniq_inventory_movements_reference");
}

export async function listMovements(
  organizationId: string,
  opts: ListMovementsOptions = {},
): Promise<InventoryMovementRow[]> {
  let query = db
    .from("inventory_movements")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (opts.variant_id) query = query.eq("variant_id", opts.variant_id);
  if (opts.product_id) query = query.eq("product_id", opts.product_id);
  if (opts.location_id !== undefined) query = query.eq("location_id", opts.location_id);
  if (opts.movement_type) query = query.eq("movement_type", opts.movement_type);
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset && opts.limit) {
    query = query.range(opts.offset, opts.offset + opts.limit - 1);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listMovements: ${(error as { message: string }).message}`);
  return (data ?? []) as InventoryMovementRow[];
}

export async function findMovementByReference(
  organizationId: string,
  variantId: string,
  referenceType: string,
  referenceId: string,
): Promise<InventoryMovementRow | null> {
  const { data, error } = await db
    .from("inventory_movements")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("variant_id", variantId)
    .eq("reference_type", referenceType)
    .eq("reference_id", referenceId)
    .maybeSingle();

  if (error) {
    throw new Error(`findMovementByReference: ${(error as { message: string }).message}`);
  }
  return data ? (data as InventoryMovementRow) : null;
}

// ── Derived stock (live view — never a mutable cache) ─────────────────────────

/**
 * Rows asked for in one page of a stock read.
 *
 * This is a REQUEST size and nothing more. It is never read back as evidence
 * of completeness — see `drainStockRows` for why that would be unsound.
 */
const STOCK_PAGE_SIZE = 1000;

/**
 * Safety valves: the most rows one stock read will consume before giving up.
 *
 * These are NOT completeness signals either. Reaching one is reported as an
 * explicitly INCOMPLETE read, never as a total. They exist only so that a
 * pathological dataset cannot make a single request walk without bound.
 */
const STOCK_ROW_BUDGET_PER_CHUNK = 20_000;
const STOCK_ROW_BUDGET_PER_VARIANT = 5_000;

/**
 * Identity of one `inventory_stock` row.
 *
 * The view GROUPs BY (organization_id, product_id, variant_id, location_id)
 * and every read here is already scoped to one organization, so
 * (variant_id, location_id) is unique within a result. A UUID contains
 * neither a NUL byte nor the empty string, so no two distinct rows collide.
 */
function stockRowKey(row: InventoryStockRow): string {
  return `${row.variant_id}\u0000${row.location_id ?? ""}`;
}

/** The shape `drainStockRows` needs from a PostgREST query builder. */
interface RangeableQuery {
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Read one filtered `inventory_stock` query to exhaustion, page by page.
 *
 * WHY THIS TERMINAL CONDITION, AND NOT A SIMPLER ONE:
 *
 * PostgREST silently caps every response at the project's `db.max_rows`. A
 * request for 5000 rows against a project capped at 1000 comes back with 1000
 * rows and NO error and NO warning. So:
 *
 *   - "I got fewer rows than I asked for" does NOT prove the data ran out; and
 *   - "I got exactly as many as I asked for" does NOT prove it did not.
 *
 * Any completeness test written against the REQUESTED page size is therefore
 * wrong under a cap that this code cannot see and must not guess. That is the
 * defect this function exists to remove: the previous implementation inferred
 * truncation from `rows.length >= 5000`, which a 1000-row cap makes
 * permanently false — 1100 real rows came back as 1000 rows reported complete,
 * understating stock and inventing zeroes for variants whose rows fell off the
 * end.
 *
 * The only thing that proves a range is exhausted is a page that comes back
 * EMPTY, and that is the terminal condition used here. The offset advances by
 * the number of rows the server ACTUALLY returned rather than the number
 * requested, so a cap of any size >= 1 is absorbed as extra round trips
 * instead of being mistaken for the end of the data. Nothing in this loop
 * depends on `db.max_rows`, on `STOCK_PAGE_SIZE`, or on the two being equal.
 *
 * (An exact `count` plus paged reads would also be deterministic, but the
 * count and the reads are separate statements: rows can change between them.
 * An empty page is self-proving and needs no second source of truth.)
 *
 * Rows are collected into a map keyed by the view's own grouping key, so a row
 * seen on two pages — possible when the ledger is written to mid-read — is
 * counted once instead of doubling a merchant's stock.
 *
 * `complete` is false ONLY when the budget stopped the walk. A caller must
 * never present a total built from an incomplete read as fact.
 */
async function drainStockRows(
  label: string,
  buildQuery: () => RangeableQuery,
  budget: number,
): Promise<{ rows: InventoryStockRow[]; complete: boolean }> {
  const byKey = new Map<string, InventoryStockRow>();
  let offset = 0;

  for (;;) {
    const { data, error } = await buildQuery().range(offset, offset + STOCK_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${label}: ${(error as { message?: string }).message ?? "unknown error"}`);
    }

    const page = (data ?? []) as InventoryStockRow[];
    // An empty page is the only proof that the range is exhausted.
    if (page.length === 0) return { rows: [...byKey.values()], complete: true };

    for (const row of page) byKey.set(stockRowKey(row), row);

    // Advance by what the server actually returned, never by what was asked for.
    offset += page.length;

    if (offset >= budget) return { rows: [...byKey.values()], complete: false };
  }
}

/**
 * Per-location stock rows for a variant. Empty array means zero movements recorded.
 *
 * Paged to exhaustion like every other stock read. A variant held across more
 * locations than the project's row cap would otherwise come back short and the
 * caller would sum a partial ledger into a confident, wrong on-hand total.
 *
 * If the read cannot be completed this THROWS rather than returning rows that
 * understate real stock: this shape has no way to say "partial", and a silent
 * undercount on the variant detail screen is exactly the failure that makes a
 * merchant restock the wrong item.
 */
export async function getVariantStockRows(
  organizationId: string,
  variantId: string,
): Promise<InventoryStockRow[]> {
  const { rows, complete } = await drainStockRows(
    "getVariantStockRows",
    () =>
      db
        .from("inventory_stock")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("variant_id", variantId)
        .order("variant_id", { ascending: true })
        .order("location_id", { ascending: true }) as RangeableQuery,
    STOCK_ROW_BUDGET_PER_VARIANT,
  );

  if (!complete) {
    throw new Error(
      `getVariantStockRows: this variant has more than ${STOCK_ROW_BUDGET_PER_VARIANT} ` +
        `location rows and could not be read completely; refusing to report a partial on-hand total`,
    );
  }
  return rows;
}

/**
 * Per-location stock rows for a batch of variants — chunked by variant, and
 * each chunk paged to exhaustion.
 *
 * Chunked rather than one query per variant: the org-wide list would otherwise
 * be a textbook N+1. `IN_CHUNK_SIZE` bounds the request URL length; it says
 * nothing about how many ROWS a chunk can produce, because that depends on how
 * many locations each variant is held across — which is why every chunk is
 * drained page by page instead of read in one shot.
 *
 * Completeness is proven by `drainStockRows` (an empty terminal page), never
 * inferred from a row count against a requested page size. `truncated` is true
 * only when a chunk hit its safety budget, and a caller must then not present
 * the totals as fact — a stock figure computed from a partial ledger read is
 * wrong, and wrong stock must never be shown to a merchant as certain.
 */
const IN_CHUNK_SIZE = 100;

export async function listStockRowsForVariants(
  organizationId: string,
  variantIds: readonly string[],
): Promise<{ rows: InventoryStockRow[]; truncated: boolean }> {
  if (variantIds.length === 0) return { rows: [], truncated: false };

  const rows: InventoryStockRow[] = [];
  let truncated = false;

  for (let start = 0; start < variantIds.length; start += IN_CHUNK_SIZE) {
    const chunk = variantIds.slice(start, start + IN_CHUNK_SIZE);
    const { rows: chunkRows, complete } = await drainStockRows(
      "listStockRowsForVariants",
      () =>
        db
          .from("inventory_stock")
          .select("*")
          .eq("organization_id", organizationId)
          .in("variant_id", chunk)
          .order("variant_id", { ascending: true })
          .order("location_id", { ascending: true }) as RangeableQuery,
      STOCK_ROW_BUDGET_PER_CHUNK,
    );

    if (!complete) truncated = true;
    rows.push(...chunkRows);
  }

  return { rows, truncated };
}

/**
 * Active variant identity for the whole organization, newest product rows last.
 *
 * Deliberately projects `id` and `product_id` only. The Inventory domain needs
 * to know WHICH variants exist so a variant with no movements can be reported
 * as a truthful 0 rather than absent; it has no business reading a variant's
 * price or cost, so it does not select them. Names and SKUs come from the
 * Product domain's own read, which applies its own permission checks.
 *
 * `limit` is passed as limit+1 by the service so a full page is detectable.
 */
export async function listActiveVariantsForOrg(
  organizationId: string,
  limit: number,
): Promise<ActiveVariantIdentityRow[]> {
  const { data, error } = await db
    .from("product_variants")
    .select("id, product_id")
    .eq("organization_id", organizationId)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`listActiveVariantsForOrg: ${(error as { message: string }).message}`);
  return (data ?? []) as ActiveVariantIdentityRow[];
}

/**
 * Locations for this organization — id, name and status only.
 *
 * The minimum needed to put a human-readable name on a per-location stock row
 * and to offer a destination when receiving stock. No address, no phone, no
 * workspace linkage, and no write path: Location management is not part of
 * this phase and is not smuggled in through the Inventory domain.
 */
export async function listLocationsForOrg(organizationId: string): Promise<InventoryLocationRow[]> {
  const { data, error } = await db
    .from("locations")
    .select("id, name, status")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (error) throw new Error(`listLocationsForOrg: ${(error as { message: string }).message}`);
  return (data ?? []) as InventoryLocationRow[];
}

// ── Cross-domain ownership checks (read-only, org-scoped) ─────────────────────
// Minimal local lookups instead of importing the Product repository, so the
// Inventory domain does not take on a hard module dependency on Product internals.

export async function findVariantForOrg(
  organizationId: string,
  variantId: string,
): Promise<{ id: string; product_id: string; organization_id: string } | null> {
  const { data, error } = await db
    .from("product_variants")
    .select("id, product_id, organization_id")
    .eq("id", variantId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findVariantForOrg: ${(error as { message: string }).message}`);
  }
  return data ?? null;
}

export async function findLocationForOrg(
  organizationId: string,
  locationId: string,
): Promise<{ id: string; organization_id: string } | null> {
  const { data, error } = await db
    .from("locations")
    .select("id, organization_id")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findLocationForOrg: ${(error as { message: string }).message}`);
  }
  return data ?? null;
}
