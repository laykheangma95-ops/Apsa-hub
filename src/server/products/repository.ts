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
import { catalogIdentifierSearch } from "@/lib/catalog-search";
import { escapeLikePattern } from "@/lib/customer-search";
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
  ListProductsPageOptions,
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

// ── Catalogue list pages (keyset) ─────────────────────────────────────────────

/**
 * One page of the organization's catalogue, newest first: `opts.limit` rows of
 * (created_at DESC, id DESC) strictly after `opts.before`, narrowed to one
 * status, optionally one category, and optionally a search.
 *
 * Why a keyset and not an offset: a product created while a merchant pages
 * lands at the TOP and pushes every row down by one, so "skip 50" would hand
 * back the last row of the previous page a second time. A position keyed on
 * the row itself does not move. Products are never deleted (products_no_delete,
 * migration 018) and nothing writes created_at after insert, so every product
 * keeps one fixed place in this order. A bulk insert in ONE transaction gives
 * every row the same created_at (now() is the transaction's start), which is
 * why `id` breaks the tie and why the cursor carries both.
 *
 * Every read is ANDed with the server-resolved organization first, so neither
 * the cursor nor the category nor the search can reach another tenant's rows.
 * No filter grammar is ever assembled from a value that crossed the network:
 * the cursor, the category and the search pattern are each bound as an
 * ordinary parameter of their own filter.
 *
 * Search is a UNION of narrower reads rather than one `.or()`: one read per
 * searched field (Khmer name, English name, and an ACTIVE variant's name, SKU
 * or barcode — the variant fields through PostgREST's inner embed, so a product
 * qualifies when at least one of its variants matches). Each read is itself a
 * keyset read of `limit` rows in the same order, so the first `limit` rows of
 * their merge are exactly the first `limit` rows of the union: a product can
 * only be among the union's first N if it is among the first N of a read that
 * found it. Merging dedupes a product that more than one field matched.
 */
export async function listProductsPage(
  organizationId: string,
  opts: ListProductsPageOptions,
): Promise<ProductRow[]> {
  const scoped = (columns = "*") => {
    let query = db
      .from("products")
      .select(columns)
      .eq("organization_id", organizationId)
      .eq("status", opts.status);
    if (opts.category_id) query = query.eq("category_id", opts.category_id);
    return query;
  };

  const search = opts.search ?? "";
  const reads = search === "" ? [() => scoped()] : searchReads(scoped, search);
  const results = await Promise.all(reads.map((read) => keysetRead(read, opts)));
  return newestFirst(results.flat(), opts.limit);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped `db` chain, see the file header
type ProductQuery = (columns?: string) => any;

/**
 * The searched fields, one read each. The name pattern and the identifier
 * pattern differ only by Khmer digits read as ASCII (see
 * src/lib/catalog-search.ts); the LIKE metacharacters a merchant typed are
 * escaped, so "100%" searches for that text instead of matching everything.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
function searchReads(scoped: ProductQuery, search: string): (() => any)[] {
  const pattern = `%${escapeLikePattern(search)}%`;
  const identifierPattern = `%${escapeLikePattern(catalogIdentifierSearch(search))}%`;
  const throughVariant = (column: "name" | "sku" | "barcode", value: string) => () =>
    scoped("*, product_variants!inner(product_id)")
      .eq("product_variants.status", "ACTIVE")
      .ilike(`product_variants.${column}`, value);
  return [
    () => scoped().ilike("name_km", pattern),
    () => scoped().ilike("name_en", pattern),
    throughVariant("name", pattern),
    throughVariant("sku", identifierPattern),
    throughVariant("barcode", identifierPattern),
  ];
}

/**
 * `limit` rows of one read, newest first, strictly after `before`.
 *
 * Two reads rather than one `.or()` filter when continuing: the boundary is
 *   created_at = c AND id < i     (products that share the cursor's instant)
 *   created_at < c                (everything older)
 * and the first group sorts entirely before the second. Each binds the cursor
 * as an ordinary parameter — the same shape as the Orders list
 * (src/server/orders/repository.ts listOrdersBefore).
 */
async function keysetRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  filtered: () => any,
  opts: Pick<ListProductsPageOptions, "before" | "limit">,
): Promise<ProductRow[]> {
  const queries = opts.before
    ? [
        filtered()
          .eq("created_at", opts.before.createdAt)
          .lt("id", opts.before.id)
          .order("id", { ascending: false })
          .limit(opts.limit),
        filtered()
          .lt("created_at", opts.before.createdAt)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(opts.limit),
      ]
    : [
        filtered()
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(opts.limit),
      ];
  const results = await Promise.all(queries);
  const rows: ProductRow[] = [];
  for (const result of results) {
    if (result.error) {
      throw new Error(`listProductsPage: ${(result.error as { message: string }).message}`);
    }
    for (const row of (result.data ?? []) as (ProductRow & { product_variants?: unknown })[]) {
      // The inner embed exists only to narrow the read; it is not product data.
      const { product_variants: _embed, ...product } = row;
      rows.push(product as ProductRow);
    }
  }
  return rows;
}

/**
 * A timestamptz's text as a number of microseconds, so rows from different
 * reads compare exactly as PostgreSQL ordered them. A Date would drop the
 * microseconds; comparing the text would depend on how many fractional digits
 * PostgREST happened to print.
 */
export function timestamptzMicros(value: string): number {
  const match =
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value,
    );
  if (!match) throw new Error(`Unrecognized timestamptz: ${value}`);
  const zone = match[3]!;
  const offset = zone === "Z" || zone.includes(":") || zone.length > 3 ? zone : `${zone}:00`;
  const millis = Date.parse(`${match[1]!.replace(" ", "T")}${offset}`);
  if (Number.isNaN(millis)) throw new Error(`Unrecognized timestamptz: ${value}`);
  return millis * 1000 + Number((match[2] ?? "").padEnd(6, "0"));
}

/** (created_at DESC, id DESC), each product once, at most `limit`. */
function newestFirst(rows: ProductRow[], limit: number): ProductRow[] {
  const unique = new Map<string, { row: ProductRow; at: number }>();
  for (const row of rows) {
    if (!unique.has(row.id)) unique.set(row.id, { row, at: timestamptzMicros(row.created_at) });
  }
  return [...unique.values()]
    .sort((a, b) => b.at - a.at || (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0))
    .slice(0, limit)
    .map((entry) => entry.row);
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

/** Product ids per variant read: 100 UUIDs keep the request URL near 4 KB. */
export const VARIANT_READ_PRODUCT_IDS = 100;
/**
 * Rows per variant read. Equal to Supabase's default PostgREST max_rows, so a
 * read never asks for more than the API will return; a full read is followed
 * by another rather than taken as the end.
 */
export const VARIANT_READ_ROWS = 1000;
/** Variant reads in flight at once for one call. */
const VARIANT_READ_CONCURRENCY = 4;

/**
 * List all active variants for the given products, oldest first.
 * Used to build the product list and the POS product grid without N+1.
 *
 * Two bounds the single `.in()` read this replaces did not respect:
 *
 *   - URL size. PostgREST takes `in.(…)` in the query string; one UUID costs
 *     about 39 bytes there, so a list of a few hundred products builds a URL
 *     that proxies in front of the API may refuse. Ids are sent in groups of
 *     VARIANT_READ_PRODUCT_IDS.
 *   - Row cap. A response is cut at PostgREST's max_rows without an error, so
 *     a page of products with many variants each could silently lose some.
 *     Each group is read in id order, VARIANT_READ_ROWS at a time, continuing
 *     after the last id until a read comes back short.
 */
export async function listVariantsByOrg(
  organizationId: string,
  productIds: string[],
): Promise<ProductVariantRow[]> {
  if (productIds.length === 0) return [];

  const groups: string[][] = [];
  for (let start = 0; start < productIds.length; start += VARIANT_READ_PRODUCT_IDS) {
    groups.push(productIds.slice(start, start + VARIANT_READ_PRODUCT_IDS));
  }

  const rows: ProductVariantRow[] = [];
  let next = 0;
  async function worker() {
    while (next < groups.length) {
      const group = groups[next++]!;
      let after: string | null = null;
      for (;;) {
        let query = db
          .from("product_variants")
          .select("*")
          .eq("organization_id", organizationId)
          .in("product_id", group)
          .eq("status", "ACTIVE");
        if (after) query = query.gt("id", after);
        const { data, error } = await query
          .order("id", { ascending: true })
          .limit(VARIANT_READ_ROWS);
        if (error) throw new Error(`listVariantsByOrg: ${(error as { message: string }).message}`);
        const batch = (data ?? []) as ProductVariantRow[];
        rows.push(...batch);
        if (batch.length < VARIANT_READ_ROWS) break;
        after = batch[batch.length - 1]!.id;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(VARIANT_READ_CONCURRENCY, groups.length) }, worker),
  );

  // Oldest first within each product, as before; id settles a shared instant.
  // Display order only, so an unparseable timestamp falls back to its text
  // rather than failing the whole read.
  const at = (value: string) => {
    try {
      return timestamptzMicros(value);
    } catch {
      return null;
    }
  };
  return rows
    .map((row) => ({ row, at: at(row.created_at) }))
    .sort((a, b) => {
      const byTime =
        a.at !== null && b.at !== null
          ? a.at - b.at
          : a.row.created_at < b.row.created_at
            ? -1
            : a.row.created_at > b.row.created_at
              ? 1
              : 0;
      return byTime || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
    })
    .map((entry) => entry.row);
}
