/**
 * Product repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id so RLS + application code are both layered.
 *   - Use supabaseAdmin (service-role) so writes bypass row-level RLS; RLS is still
 *     defense-in-depth. The cross-tenant integrity trigger fires on every INSERT/UPDATE
 *     of product_variants regardless of who is writing.
 *
 * `supabaseAdmin as any` is used because product_categories / products / product_variants
 * are not yet in the generated Supabase types (migrations 017-018 not yet applied to live
 * project). After `supabase gen types typescript` is run, remove the cast.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  ProductCategoryRow,
  ProductRow,
  ProductVariantRow,
  CreateProductInput,
  UpdateProductInput,
  CreateVariantInput,
  UpdateVariantInput,
  CreateCategoryInput,
  UpdateCategoryInput,
  ListProductsOptions,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

/** Test-only override for exercising repository functions against a mocked query chain. */
export function setProductRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

/** PostgREST "The result contains 0 rows" — returned by .single() on a genuine no-row. */
const PGRST_NO_ROW = "PGRST116";

// ── Product Categories ─────────────────────────────────────────────────────────

export async function listCategories(
  organizationId: string,
  includeArchived = false,
): Promise<ProductCategoryRow[]> {
  let query = db
    .from("product_categories")
    .select("*")
    .eq("organization_id", organizationId)
    .order("sort_order", { ascending: true })
    .order("name_km", { ascending: true });

  if (!includeArchived) query = query.eq("status", "ACTIVE");

  const { data, error } = await query;
  if (error) throw new Error(`listCategories: ${(error as { message: string }).message}`);
  return (data ?? []) as ProductCategoryRow[];
}

export async function findCategoryById(
  organizationId: string,
  categoryId: string,
): Promise<ProductCategoryRow | null> {
  const { data, error } = await db
    .from("product_categories")
    .select("*")
    .eq("id", categoryId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findCategoryById: ${(error as { message: string }).message}`);
  }
  return data ? (data as ProductCategoryRow) : null;
}

export async function createCategory(
  organizationId: string,
  input: CreateCategoryInput,
): Promise<ProductCategoryRow> {
  const { data, error } = await db
    .from("product_categories")
    .insert({ organization_id: organizationId, ...input })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`createCategory: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as ProductCategoryRow;
}

export async function updateCategory(
  organizationId: string,
  categoryId: string,
  patch: UpdateCategoryInput,
): Promise<ProductCategoryRow | null> {
  const { data, error } = await db
    .from("product_categories")
    .update(patch)
    .eq("id", categoryId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`updateCategory: ${(error as { message: string }).message}`);
  return data ? (data as ProductCategoryRow) : null;
}

// ── Products ──────────────────────────────────────────────────────────────────

export async function listProducts(
  organizationId: string,
  opts: ListProductsOptions = {},
): Promise<ProductRow[]> {
  let query = db
    .from("products")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (opts.status) query = query.eq("status", opts.status);
  if (opts.category_id !== undefined) query = query.eq("category_id", opts.category_id);
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset && opts.limit) {
    query = query.range(opts.offset, opts.offset + opts.limit - 1);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listProducts: ${(error as { message: string }).message}`);
  return (data ?? []) as ProductRow[];
}

export async function findProductById(
  organizationId: string,
  productId: string,
): Promise<ProductRow | null> {
  const { data, error } = await db
    .from("products")
    .select("*")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findProductById: ${(error as { message: string }).message}`);
  }
  return data ? (data as ProductRow) : null;
}

export async function createProduct(
  organizationId: string,
  input: CreateProductInput,
): Promise<ProductRow> {
  const { data, error } = await db
    .from("products")
    .insert({ organization_id: organizationId, ...input })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`createProduct: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as ProductRow;
}

/**
 * Point a product at a new primary image (or clear it with null).
 * Scoped to the caller's organization; the products_image_path_owned CHECK
 * (migration 048) additionally refuses a path outside this org/product.
 * Returns the updated row, or null when the product is not in this org.
 */
export async function setProductImagePath(
  organizationId: string,
  productId: string,
  imagePath: string | null,
): Promise<ProductRow | null> {
  const { data, error } = await db
    .from("products")
    .update({ image_path: imagePath, image_updated_at: new Date().toISOString() })
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`setProductImagePath: ${(error as { message: string }).message}`);
  }
  return data ? (data as ProductRow) : null;
}

// ── Signed-upload tickets (migrations 049 + 050) ──────────────────────────────
//
// One row per signed upload URL issued: permission to attach that exact object
// path and a durable count of UNRESOLVED uploads. State machine (see 050):
// pending -> claimed -> consumed, plus cleaning while a sweep owns the row.
// Every multi-step transition is a single database function so it is atomic;
// the service never reads a ticket and then updates it.

export interface UploadCleanupRow {
  id: string;
  organization_id: string;
  product_id: string;
  object_path: string;
  /** Ownership token of THIS sweep's hold on the row; required to resolve or fail it. */
  cleanup_token: string;
}

export type IssueUploadResult = "ok" | "member_cap" | "org_cap";

function rpcError(name: string, error: unknown): Error {
  return new Error(`${name}: ${(error as { message?: string }).message ?? "rpc failed"}`);
}

/**
 * Atomically enforce the member + organization unresolved-backlog caps and
 * record the ticket (one serialized transaction). Nothing is signed by the
 * caller unless this returns "ok".
 */
export async function issueUploadTicket(t: {
  organizationId: string;
  productId: string;
  issuedBy: string;
  objectPath: string;
  ttlSeconds: number;
  memberCap: number;
  organizationCap: number;
}): Promise<IssueUploadResult> {
  const { data, error } = await db.rpc("issue_product_image_upload_v1", {
    p_org: t.organizationId,
    p_product: t.productId,
    p_user: t.issuedBy,
    p_path: t.objectPath,
    p_ttl_seconds: t.ttlSeconds,
    p_member_cap: t.memberCap,
    p_org_cap: t.organizationCap,
  });
  if (error) throw rpcError("issueUploadTicket", error);
  if (data !== "ok" && data !== "member_cap" && data !== "org_cap") {
    throw new Error("issueUploadTicket: unexpected result");
  }
  return data;
}

/**
 * Atomically claim a live pending ticket (or a claim whose recovery window
 * lapsed) for exactly this org + product + path. Returns the ownership token
 * of THIS claim — every successful claim gets a fresh one — or null when not
 * claimable. The token must accompany release, resolve and finalize.
 */
export async function claimUploadTicket(
  organizationId: string,
  productId: string,
  objectPath: string,
  claimSeconds: number,
): Promise<string | null> {
  const { data, error } = await db.rpc("claim_product_image_upload_v1", {
    p_org: organizationId,
    p_product: productId,
    p_path: objectPath,
    p_claim_seconds: claimSeconds,
  });
  if (error) throw rpcError("claimUploadTicket", error);
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * Atomically mark the claimed ticket consumed AND point the product at the
 * object — only if `claimToken` is the CURRENT claim. Returns { previousPath }
 * (null when the product had no image), or null when the caller does not own
 * the claim (nothing changed).
 */
export async function finalizeUploadTicket(
  organizationId: string,
  productId: string,
  objectPath: string,
  claimToken: string,
): Promise<{ previousPath: string | null } | null> {
  const { data, error } = await db.rpc("finalize_product_image_upload_v1", {
    p_org: organizationId,
    p_product: productId,
    p_path: objectPath,
    p_token: claimToken,
  });
  if (error) throw rpcError("finalizeUploadTicket", error);
  if (data === null || data === undefined) return null;
  return { previousPath: data === "" ? null : (data as string) };
}

/** Give a claim back. Succeeds only for the current claim's token; otherwise a no-op (false). */
export async function releaseUploadClaim(
  organizationId: string,
  productId: string,
  objectPath: string,
  claimToken: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("release_product_image_upload_claim_v1", {
    p_org: organizationId,
    p_product: productId,
    p_path: objectPath,
    p_token: claimToken,
  });
  if (error) throw rpcError("releaseUploadClaim", error);
  return data === true;
}

/** Resolve (delete) the ticket of a rejected upload. Current claim's token only. */
export async function resolveUploadTicket(
  organizationId: string,
  productId: string,
  objectPath: string,
  claimToken: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("resolve_product_image_upload_claim_v1", {
    p_org: organizationId,
    p_product: productId,
    p_path: objectPath,
    p_token: claimToken,
  });
  if (error) throw rpcError("resolveUploadTicket", error);
  return data === true;
}

/**
 * Take a bounded batch of eligible tickets for cleanup (server housekeeping,
 * across tenants; nothing returned reaches a client). Rows whose object a
 * product references are resolved as consumed inside the function.
 */
export async function takeUploadTicketsForCleanup(
  limit: number,
  leaseSeconds: number,
): Promise<UploadCleanupRow[]> {
  const { data, error } = await db.rpc("take_product_image_upload_cleanup_v1", {
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw rpcError("takeUploadTicketsForCleanup", error);
  return (data as UploadCleanupRow[] | null) ?? [];
}

/** Delete tickets whose object was deleted; only rows whose (id, cleanup token) is still current. */
export async function resolveCleanedTickets(taken: UploadCleanupRow[]): Promise<number> {
  if (taken.length === 0) return 0;
  const { data, error } = await db.rpc("resolve_product_image_upload_cleanup_v1", {
    p_ids: taken.map((t) => t.id),
    p_tokens: taken.map((t) => t.cleanup_token),
  });
  if (error) throw rpcError("resolveCleanedTickets", error);
  return Array.isArray(data) ? data.length : 0;
}

/** Drop a ticket whose URL was never signed (pending only). */
export async function deleteUnsignedTicket(
  organizationId: string,
  productId: string,
  objectPath: string,
): Promise<void> {
  const { error } = await db
    .from("product_image_uploads")
    .delete()
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .eq("object_path", objectPath)
    .eq("state", "pending");
  if (error) throw rpcError("deleteUnsignedTicket", error);
}

/**
 * Keep failed rows unresolved (still counted), with a retry delay so later rows
 * advance. Token-checked: a sweep that lost the row records nothing. Returns the
 * ids whose error count reached `alertThreshold` on this failure.
 */
export async function recordCleanupFailures(
  failed: UploadCleanupRow[],
  alertThreshold: number,
): Promise<string[]> {
  if (failed.length === 0) return [];
  const { data, error } = await db.rpc("fail_product_image_upload_cleanup_v1", {
    p_ids: failed.map((t) => t.id),
    p_tokens: failed.map((t) => t.cleanup_token),
    p_alert_threshold: alertThreshold,
  });
  if (error) throw rpcError("recordCleanupFailures", error);
  return Array.isArray(data) ? (data as string[]) : [];
}

/** Which of these object paths are some product's CURRENT image. */
export async function findReferencedImagePaths(objectPaths: string[]): Promise<Set<string>> {
  if (objectPaths.length === 0) return new Set();
  const { data, error } = await db
    .from("products")
    .select("image_path")
    .in("image_path", objectPaths);
  if (error) throw new Error(`findReferencedImagePaths: ${(error as { message: string }).message}`);
  return new Set(
    ((data as Array<{ image_path: string | null }>) ?? []).map((r) => r.image_path as string),
  );
}

export async function updateProduct(
  organizationId: string,
  productId: string,
  patch: UpdateProductInput,
): Promise<ProductRow | null> {
  const { data, error } = await db
    .from("products")
    .update(patch)
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`updateProduct: ${(error as { message: string }).message}`);
  return data ? (data as ProductRow) : null;
}

// ── Product Variants ──────────────────────────────────────────────────────────

export async function listVariantsByProduct(
  organizationId: string,
  productId: string,
  includeArchived = false,
): Promise<ProductVariantRow[]> {
  let query = db
    .from("product_variants")
    .select("*")
    .eq("product_id", productId)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (!includeArchived) query = query.eq("status", "ACTIVE");

  const { data, error } = await query;
  if (error) throw new Error(`listVariantsByProduct: ${(error as { message: string }).message}`);
  return (data ?? []) as ProductVariantRow[];
}

export async function findVariantById(
  organizationId: string,
  variantId: string,
): Promise<ProductVariantRow | null> {
  const { data, error } = await db
    .from("product_variants")
    .select("*")
    .eq("id", variantId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findVariantById: ${(error as { message: string }).message}`);
  }
  return data ? (data as ProductVariantRow) : null;
}

/** Exact-match SKU lookup — org-scoped. No fuzzy matching. */
export async function findVariantBySku(
  organizationId: string,
  sku: string,
): Promise<ProductVariantRow | null> {
  if (!sku || !sku.trim()) return null;

  const { data, error } = await db
    .from("product_variants")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("sku", sku.trim())
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (error) throw new Error(`findVariantBySku: ${(error as { message: string }).message}`);
  return data ? (data as ProductVariantRow) : null;
}

/** Exact-match barcode lookup — org-scoped. No fuzzy matching. */
export async function findVariantByBarcode(
  organizationId: string,
  barcode: string,
): Promise<ProductVariantRow | null> {
  if (!barcode || !barcode.trim()) return null;

  const { data, error } = await db
    .from("product_variants")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("barcode", barcode.trim())
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (error) throw new Error(`findVariantByBarcode: ${(error as { message: string }).message}`);
  return data ? (data as ProductVariantRow) : null;
}

/**
 * Whether ANY variant in the org already carries this barcode — regardless of
 * status. Used by the APSA barcode generator's collision check.
 *
 * Status-agnostic on purpose: the uniqueness index
 * (uniq_product_variants_barcode_per_org) covers ARCHIVED variants too, so a
 * generated code that happens to match an archived variant's barcode would still
 * be rejected by the DB on write. Checking only ACTIVE rows (as the lookup path
 * does) would let the generator "confirm" a code that then fails to persist.
 */
export async function barcodeExistsForOrg(
  organizationId: string,
  barcode: string,
): Promise<boolean> {
  if (!barcode || !barcode.trim()) return false;

  const { data, error } = await db
    .from("product_variants")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("barcode", barcode.trim())
    .limit(1);

  if (error) throw new Error(`barcodeExistsForOrg: ${(error as { message: string }).message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function createVariant(
  organizationId: string,
  productId: string,
  input: CreateVariantInput,
): Promise<ProductVariantRow> {
  const { data, error } = await db
    .from("product_variants")
    .insert({ organization_id: organizationId, product_id: productId, ...input })
    .select()
    .single();

  if (error || !data) {
    // Surface unique-constraint violations so the service can return a meaningful error.
    const msg = (error as { message?: string })?.message ?? "no data";
    throw new Error(`createVariant: ${msg}`);
  }
  return data as ProductVariantRow;
}

export async function updateVariant(
  organizationId: string,
  variantId: string,
  patch: UpdateVariantInput,
): Promise<ProductVariantRow | null> {
  const { data, error } = await db
    .from("product_variants")
    .update(patch)
    .eq("id", variantId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) {
    const msg = (error as { message?: string })?.message ?? "unknown";
    throw new Error(`updateVariant: ${msg}`);
  }
  return data ? (data as ProductVariantRow) : null;
}

/**
 * Atomically set a variant's barcode ONLY while it is still NULL — the
 * concurrency-safe write behind APSA barcode generation.
 *
 * The `.is("barcode", null)` predicate is the whole point: two requests that
 * both read a NULL barcode and both try to write can no longer both succeed.
 * The database evaluates the predicate under its own row lock, so exactly one
 * UPDATE matches the row; the loser matches zero rows and gets `null` back —
 * it never overwrites the winner's code. The org-scoped unique index remains
 * the final authority against a cross-variant code collision (surfaced as a
 * thrown unique-violation the caller retries on).
 *
 * Returns the updated row when this call won the write, or null when the
 * barcode was already set (by a concurrent winner) so nothing matched.
 */
export async function updateVariantBarcodeIfNull(
  organizationId: string,
  variantId: string,
  barcode: string,
): Promise<ProductVariantRow | null> {
  const { data, error } = await db
    .from("product_variants")
    .update({ barcode })
    .eq("id", variantId)
    .eq("organization_id", organizationId)
    .is("barcode", null)
    .select()
    .maybeSingle();

  if (error) {
    const msg = (error as { message?: string })?.message ?? "unknown";
    throw new Error(`updateVariantBarcodeIfNull: ${msg}`);
  }
  return data ? (data as ProductVariantRow) : null;
}

/**
 * List all active variants for the products returned by listProducts.
 * Used to build the POS product grid in a single extra query rather than N+1.
 */
export async function listVariantsByOrg(
  organizationId: string,
  productIds: string[],
): Promise<ProductVariantRow[]> {
  if (productIds.length === 0) return [];

  const { data, error } = await db
    .from("product_variants")
    .select("*")
    .eq("organization_id", organizationId)
    .in("product_id", productIds)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`listVariantsByOrg: ${(error as { message: string }).message}`);
  return (data ?? []) as ProductVariantRow[];
}
