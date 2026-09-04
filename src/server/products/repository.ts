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
const db = supabaseAdmin as any;

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
