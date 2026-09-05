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
  return (
    code === PG_UNIQUE_VIOLATION ||
    err.message.includes("uniq_inventory_movements_reference")
  );
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
