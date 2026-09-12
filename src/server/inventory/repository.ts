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

/** Per-location stock rows for a variant. Empty array means zero movements recorded. */
export async function getVariantStockRows(
  organizationId: string,
  variantId: string,
): Promise<InventoryStockRow[]> {
  const { data, error } = await db
    .from("inventory_stock")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("variant_id", variantId);

  if (error) throw new Error(`getVariantStockRows: ${(error as { message: string }).message}`);
  return (data ?? []) as InventoryStockRow[];
}

/**
 * Per-location stock rows for a batch of variants, in ONE query per chunk.
 *
 * Chunked rather than one query per variant: the org-wide list would otherwise
 * be a textbook N+1. `IN_CHUNK_SIZE` bounds both the request URL length and the
 * row count of any single response, so a merchant with many variants across
 * many locations cannot silently run into PostgREST's own row ceiling.
 *
 * A chunk that comes back exactly full is reported through `truncated` rather
 * than quietly dropping rows — a stock figure computed from a truncated ledger
 * read would be wrong, and wrong stock must never be presented as fact.
 */
const IN_CHUNK_SIZE = 100;
/** Per-chunk row ceiling. 100 variants would need >50 locations each to reach it. */
const STOCK_ROWS_PER_CHUNK = 5000;

export async function listStockRowsForVariants(
  organizationId: string,
  variantIds: readonly string[],
): Promise<{ rows: InventoryStockRow[]; truncated: boolean }> {
  if (variantIds.length === 0) return { rows: [], truncated: false };

  const rows: InventoryStockRow[] = [];
  let truncated = false;

  for (let start = 0; start < variantIds.length; start += IN_CHUNK_SIZE) {
    const chunk = variantIds.slice(start, start + IN_CHUNK_SIZE);
    const { data, error } = await db
      .from("inventory_stock")
      .select("*")
      .eq("organization_id", organizationId)
      .in("variant_id", chunk)
      .limit(STOCK_ROWS_PER_CHUNK);

    if (error) {
      throw new Error(`listStockRowsForVariants: ${(error as { message: string }).message}`);
    }
    const chunkRows = (data ?? []) as InventoryStockRow[];
    if (chunkRows.length >= STOCK_ROWS_PER_CHUNK) truncated = true;
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
