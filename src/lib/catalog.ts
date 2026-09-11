/**
 * Product catalog — the browser-side boundary for the merchant catalog UI.
 *
 * Every function here is a thin call into an existing server function in
 * `@/api/products`, which resolves the session and the organization from the
 * DB and re-authorizes the action (src/server/products/service.ts). Nothing in
 * this module decides access, and nothing in it talks to Supabase: the server
 * functions are imported dynamically inside the call bodies so no server-only
 * module can be pulled into the browser bundle through this file.
 *
 * There is deliberately NO mock/demo fallback here. The catalog is a
 * production surface: a failure must surface as a failure, never as invented
 * product data (contrast src/lib/api/index.ts#getProducts, whose fallback
 * exists only for the pre-production POS/mock path).
 *
 * Money is integer minor units end to end (USD = cents, KHR = riel). The
 * parser below converts a typed string to minor units with integer arithmetic
 * only — no floating-point financial maths anywhere in this file.
 *
 * Cost is NOT derived here. `variant.cost` is null unless the server decided
 * the caller has products.view_cost; the browser never reconstructs it.
 */
import type { Currency, CompanionColor, Money } from "@/types";

// ── Shapes returned by the server (src/server/products/service.ts) ───────────

export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type VariantStatus = "ACTIVE" | "ARCHIVED";

/** The two lists the catalog screen offers. DRAFT is not authored by this UI. */
export const CATALOG_LIST_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CatalogListStatus = (typeof CATALOG_LIST_STATUSES)[number];

export interface CatalogVariant {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  price: Money;
  /** null whenever the server withheld it — the UI must not fill this in. */
  cost: Money | null;
  weightGrams: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogProduct {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  nameKm: string;
  nameEn: string | null;
  descriptionKm: string | null;
  descriptionEn: string | null;
  categoryId: string | null;
  status: string;
  companion: CompanionColor;
  /** Inventory is a separate domain — always null from the Product domain. */
  stock: null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  variants: CatalogVariant[];
}

export interface CatalogCategory {
  id: string;
  organizationId: string;
  parentId: string | null;
  nameKm: string;
  nameEn: string | null;
  sortOrder: number;
  status: string;
  createdAt: string;
}

// ── Identity ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for the id shape the product server functions accept.
 *
 * A screen uses this to show an honest "not found" for a hand-typed or stale
 * URL instead of firing a request the Zod validator would reject anyway. It is
 * not a security check: an id that passes here is still only ever resolved
 * inside the caller's own organization, server-side. An id belonging to
 * another organization looks exactly like this one and comes back not-found.
 */
export function isCatalogId(id: string): boolean {
  return UUID_RE.test(id);
}

// ── React Query cache identity ───────────────────────────────────────────────
//
// Partitioned by the organization the server resolved for this member (read
// from the capability snapshot, never from the URL), so catalog rows can never
// be served back to a different tenant after an organization switch.

export const CATALOG_QUERY_ROOT = "catalog";

/** One page. Search below is explicitly scoped to what this loaded. */
export const CATALOG_PAGE_LIMIT = 200;

export const catalogKeys = {
  products: (organizationId: string, status: CatalogListStatus, categoryId: string | null) =>
    [CATALOG_QUERY_ROOT, organizationId, "products", status, categoryId ?? "all"] as const,
  product: (organizationId: string, productId: string) =>
    [CATALOG_QUERY_ROOT, organizationId, "product", productId] as const,
  categories: (organizationId: string) =>
    [CATALOG_QUERY_ROOT, organizationId, "categories"] as const,
};

// ── Money: integer minor units, parsed without floating point ────────────────

/** Decimal places a currency's major unit shows. KHR has none — riel is the minor unit. */
export const MINOR_UNIT_DIGITS: Record<Currency, number> = { USD: 2, KHR: 0 };

function minorUnitFactor(currency: Currency): number {
  return currency === "USD" ? 100 : 1;
}

/** Render minor units into an editable field. Integer division only. */
export function formatMinorUnitsForInput(amount: number, currency: Currency): string {
  const digits = MINOR_UNIT_DIGITS[currency];
  if (digits === 0) return String(amount);
  const factor = minorUnitFactor(currency);
  const whole = Math.trunc(amount / factor);
  const fraction = Math.abs(amount % factor);
  return `${whole}.${String(fraction).padStart(digits, "0")}`;
}

/**
 * Parse a typed amount into integer minor units, or null when it is not a
 * valid amount for this currency.
 *
 * Deliberately not `parseFloat(x) * 100`: 19.99 * 100 is 1998.9999999999998 in
 * IEEE-754, and rounding that away is exactly the floating-point money handling
 * ARCHITECTURE.md forbids. The whole and fractional parts are parsed as
 * separate integers and combined with integer arithmetic.
 */
export function parseMinorUnits(input: string, currency: Currency): number | null {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return null;

  const digits = MINOR_UNIT_DIGITS[currency];
  const match = digits === 0 ? /^(\d+)$/.exec(text) : /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;

  const whole = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(whole)) return null;
  if (digits === 0) return whole;

  const fractionText = (match[2] ?? "").padEnd(digits, "0");
  const fraction = fractionText === "" ? 0 : Number.parseInt(fractionText, 10);
  const total = whole * minorUnitFactor(currency) + fraction;
  return Number.isSafeInteger(total) ? total : null;
}

// ── Presentation helpers (pure) ──────────────────────────────────────────────

/**
 * Khmer is the product's required name, so it leads. English is shown beside
 * it when the merchant supplied one — never substituted for a missing Khmer
 * name, which the server refuses to store empty anyway.
 */
export function productPrimaryName(product: Pick<CatalogProduct, "nameKm">): string {
  return product.nameKm;
}

export function categoryLabel(
  category: Pick<CatalogCategory, "nameKm" | "nameEn">,
  language: string,
): string {
  if (language.startsWith("en") && category.nameEn) return category.nameEn;
  return category.nameKm;
}

/**
 * Search the products already loaded into this page — nothing more.
 *
 * This is NOT server search. It cannot see a product outside the page the
 * server returned, and the screen says so next to the field rather than
 * implying the whole catalog was searched.
 */
export function searchLoadedProducts(
  products: readonly CatalogProduct[],
  query: string,
): CatalogProduct[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...products];

  return products.filter((product) => {
    if (product.nameKm.toLowerCase().includes(needle)) return true;
    if ((product.nameEn ?? "").toLowerCase().includes(needle)) return true;
    return product.variants.some(
      (variant) =>
        variant.name.toLowerCase().includes(needle) ||
        (variant.sku ?? "").toLowerCase().includes(needle) ||
        (variant.barcode ?? "").toLowerCase().includes(needle),
    );
  });
}

/** The price the list shows for a product: its first active variant's, or none. */
export function productLeadPrice(product: Pick<CatalogProduct, "variants">): Money | null {
  const active = product.variants.find((variant) => variant.status === "ACTIVE");
  return active?.price ?? product.variants[0]?.price ?? null;
}

// ── Variant form access (pure) ───────────────────────────────────────────────

/**
 * What this member may change, as the server already decided it.
 *
 * These flags shape a form; they authorize nothing. Every field they gate is
 * re-checked by createVariant/updateVariant in src/server/products/service.ts,
 * which requires products.update_price for any price key and
 * products.update_cost for any cost key in the patch.
 */
export interface VariantPermissions {
  canCreate: boolean;
  canUpdateBasic: boolean;
  canUpdatePrice: boolean;
  canUpdateCost: boolean;
  canViewCost: boolean;
}

export interface VariantFieldAccess {
  basicEditable: boolean;
  priceEditable: boolean;
  costVisible: boolean;
  costEditable: boolean;
}

/**
 * Which variant fields the form offers, for a create or an edit.
 *
 * Creating needs a price (the server requires price_amount), so the whole form
 * belongs to products.create. Editing splits: basic fields under
 * products.update_basic, price under products.update_price, cost under
 * products.update_cost.
 *
 * Cost is editable only when it is also visible: without products.view_cost the
 * server does not send the current cost at all, so an "edit" could only ever
 * overwrite a value the member cannot see with one they invented. The form
 * therefore sends no cost field in that case, rather than guessing.
 */
export function variantFieldAccess(
  permissions: VariantPermissions,
  isEdit: boolean,
): VariantFieldAccess {
  return {
    basicEditable: isEdit ? permissions.canUpdateBasic : permissions.canCreate,
    priceEditable: isEdit ? permissions.canUpdatePrice : permissions.canCreate,
    costVisible: permissions.canViewCost,
    costEditable: permissions.canUpdateCost && permissions.canViewCost,
  };
}

// ── Server error classification ──────────────────────────────────────────────

export type CatalogErrorKind =
  "denied" | "not_found" | "duplicate_sku" | "duplicate_barcode" | "invalid_money" | "generic";

/**
 * Classify a thrown product server error into a copy key.
 *
 * Best-effort presentation only. Authorization, tenant scoping and the
 * duplicate-SKU/barcode 409s are all decided server-side; misreading one here
 * picks the wrong sentence, it never lets an action through. In particular a
 * "denied" classification is a message, not a decision — the action already
 * failed on the server before this ran.
 */
export function classifyCatalogError(err: unknown): CatalogErrorKind {
  const message = err instanceof Error ? err.message : "";

  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated" ||
    message === "Owner access required"
  ) {
    return "denied";
  }
  if (/^(Product|Variant|Category) not found$/.test(message)) return "not_found";
  if (message.includes("SKU already exists")) return "duplicate_sku";
  if (message.includes("Barcode already exists")) return "duplicate_barcode";
  if (message.includes("must be a non-negative integer")) return "invalid_money";
  return "generic";
}

/** i18n key for a classified catalog failure. Every kind has Khmer and English copy. */
export function catalogErrorKey(kind: CatalogErrorKind): string {
  return `catalog.error.${kind}`;
}

// ── Server function wrappers ─────────────────────────────────────────────────
//
// Each one dynamically imports the API module so the server-function bundle is
// pulled in only by the screens that use it, and every call keeps its
// organization scope on the server where it belongs.

export interface ListCatalogProductsInput {
  status: CatalogListStatus;
  categoryId?: string | null | undefined;
  limit?: number | undefined;
}

export async function listCatalogProducts(
  input: ListCatalogProductsInput,
): Promise<CatalogProduct[]> {
  const { listProductsFn } = await import("@/api/products");
  const result = await listProductsFn({
    data: {
      status: input.status,
      limit: input.limit ?? CATALOG_PAGE_LIMIT,
      ...(input.categoryId ? { category_id: input.categoryId } : {}),
    },
  });
  return result as unknown as CatalogProduct[];
}

export async function getCatalogProduct(
  productId: string,
  includeArchivedVariants = false,
): Promise<CatalogProduct> {
  const { getProductDetailFn } = await import("@/api/products");
  const result = await getProductDetailFn({
    data: { id: productId, includeArchivedVariants },
  });
  return result as unknown as CatalogProduct;
}

export interface CatalogVariantInput {
  sku: string | null;
  barcode: string | null;
  name: string;
  priceAmount: number;
  priceCurrency: Currency;
  costAmount: number | null;
  costCurrency: Currency | null;
  weightGrams: number | null;
}

export interface CreateCatalogProductInput {
  nameKm: string;
  nameEn: string | null;
  descriptionKm: string | null;
  categoryId: string | null;
  initialVariant: CatalogVariantInput;
}

export async function createCatalogProduct(
  input: CreateCatalogProductInput,
): Promise<CatalogProduct> {
  const { createProductFn } = await import("@/api/products");
  const result = await createProductFn({
    data: {
      name_km: input.nameKm,
      name_en: input.nameEn,
      description_km: input.descriptionKm,
      category_id: input.categoryId,
      initialVariant: {
        sku: input.initialVariant.sku,
        barcode: input.initialVariant.barcode,
        name: input.initialVariant.name,
        price_amount: input.initialVariant.priceAmount,
        price_currency: input.initialVariant.priceCurrency,
        cost_amount: input.initialVariant.costAmount,
        cost_currency: input.initialVariant.costCurrency,
        weight_grams: input.initialVariant.weightGrams,
      },
    },
  });
  return result as unknown as CatalogProduct;
}

export interface UpdateCatalogProductInput {
  productId: string;
  nameKm: string;
  nameEn: string | null;
  descriptionKm: string | null;
  categoryId: string | null;
}

export async function updateCatalogProduct(
  input: UpdateCatalogProductInput,
): Promise<CatalogProduct> {
  const { updateProductFn } = await import("@/api/products");
  const result = await updateProductFn({
    data: {
      productId: input.productId,
      name_km: input.nameKm,
      name_en: input.nameEn,
      description_km: input.descriptionKm,
      category_id: input.categoryId,
    },
  });
  return result as unknown as CatalogProduct;
}

export async function archiveCatalogProduct(productId: string): Promise<CatalogProduct> {
  const { archiveProductFn } = await import("@/api/products");
  const result = await archiveProductFn({ data: { productId } });
  return result as unknown as CatalogProduct;
}

export async function createCatalogVariant(
  productId: string,
  input: CatalogVariantInput,
): Promise<CatalogVariant> {
  const { createVariantFn } = await import("@/api/products");
  const result = await createVariantFn({
    data: {
      productId,
      sku: input.sku,
      barcode: input.barcode,
      name: input.name,
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency,
      cost_amount: input.costAmount,
      cost_currency: input.costCurrency,
      weight_grams: input.weightGrams,
    },
  });
  return result as unknown as CatalogVariant;
}

/**
 * Patch a variant.
 *
 * The caller sends only the fields it was allowed to edit: the server requires
 * products.update_price for any price field and products.update_cost for any
 * cost field, and a member without them must not send those keys at all — an
 * unchanged price resent by a member who cannot change prices would be refused
 * outright. Omitted keys are left untouched.
 */
export interface UpdateCatalogVariantInput {
  variantId: string;
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  weightGrams?: number | null;
  priceAmount?: number;
  priceCurrency?: Currency;
  costAmount?: number | null;
  costCurrency?: Currency | null;
  status?: VariantStatus;
}

export async function updateCatalogVariant(
  input: UpdateCatalogVariantInput,
): Promise<CatalogVariant> {
  const { updateVariantFn } = await import("@/api/products");

  // Only the keys the caller actually set are forwarded, in the server's own
  // wire shape. A key that is absent here is a field the server leaves alone.
  const data: Record<string, unknown> = { variantId: input.variantId };
  if (input.name !== undefined) data["name"] = input.name;
  if (input.sku !== undefined) data["sku"] = input.sku;
  if (input.barcode !== undefined) data["barcode"] = input.barcode;
  if (input.weightGrams !== undefined) data["weight_grams"] = input.weightGrams;
  if (input.priceAmount !== undefined) data["price_amount"] = input.priceAmount;
  if (input.priceCurrency !== undefined) data["price_currency"] = input.priceCurrency;
  if (input.costAmount !== undefined) data["cost_amount"] = input.costAmount;
  if (input.costCurrency !== undefined) data["cost_currency"] = input.costCurrency;
  if (input.status !== undefined) data["status"] = input.status;

  const result = await updateVariantFn({ data });
  return result as unknown as CatalogVariant;
}

export async function listCatalogCategories(includeArchived = false): Promise<CatalogCategory[]> {
  const { listCategoriesFn } = await import("@/api/products");
  const result = await listCategoriesFn({ data: { includeArchived } });
  return result as unknown as CatalogCategory[];
}

export async function createCatalogCategory(input: {
  nameKm: string;
  nameEn: string | null;
}): Promise<CatalogCategory> {
  const { createCategoryFn } = await import("@/api/products");
  const result = await createCategoryFn({
    data: { name_km: input.nameKm, name_en: input.nameEn },
  });
  return result as unknown as CatalogCategory;
}

export async function updateCatalogCategory(input: {
  categoryId: string;
  nameKm?: string;
  nameEn?: string | null;
  status?: "ACTIVE" | "ARCHIVED";
}): Promise<CatalogCategory> {
  const { updateCategoryFn } = await import("@/api/products");

  const data: Record<string, unknown> = { categoryId: input.categoryId };
  if (input.nameKm !== undefined) data["name_km"] = input.nameKm;
  if (input.nameEn !== undefined) data["name_en"] = input.nameEn;
  if (input.status !== undefined) data["status"] = input.status;

  const result = await updateCategoryFn({ data });
  return result as unknown as CatalogCategory;
}
