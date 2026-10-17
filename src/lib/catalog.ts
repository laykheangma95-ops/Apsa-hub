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
import type { QueryClient } from "@tanstack/react-query";
import type { CatalogListCursor } from "@/lib/catalog-search";
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
// Partitioned by BOTH the authenticated user AND the organization the server
// resolved for them — never by organization alone. Two members of the same
// organization can hold different permissions (products.view_cost in
// particular), so an organization-only key would let one member's cached cost
// data be read back for another member of the same organization who signs in
// after them in the same browser tab. Both values must come from the
// server-derived route context (/app's beforeLoad guard, via
// Route.useRouteContext()) — never from the capability snapshot (which is
// presentation data, fetched separately, and not the identity boundary) and
// never from client input.

export const CATALOG_QUERY_ROOT = "catalog";

/**
 * The single bounded read Inventory still makes to name its stock rows
 * (src/routes/app.inventory.tsx), which says so on screen when it is full.
 * The Products screen no longer uses it: it pages through the whole catalogue
 * CATALOG_LIST_PAGE_SIZE at a time (listCatalogProductsPage).
 */
export const CATALOG_PAGE_LIMIT = 200;

/** Products per page on the Products screen; the server caps a request at 100. */
export const CATALOG_LIST_PAGE_SIZE = 50;

export const catalogKeys = {
  /** Inventory's bounded one-shot read (CATALOG_PAGE_LIMIT). */
  products: (
    userId: string,
    organizationId: string,
    status: CatalogListStatus,
    categoryId: string | null,
  ) =>
    [CATALOG_QUERY_ROOT, userId, organizationId, "products", status, categoryId ?? "all"] as const,
  /**
   * The Products screen's paged lists (infinite queries: pages plus the
   * cursor that continues them) — the PREFIX of every question's entry.
   * Partitioning the key partitions the cursor with it: a position walked
   * through one principal's catalogue can never continue a request made for
   * another. A sibling of `products`, never the same entry: that one holds a
   * plain array.
   */
  productPages: (userId: string, organizationId: string) =>
    [CATALOG_QUERY_ROOT, userId, organizationId, "product-pages"] as const,
  /**
   * One question's paged list. Status, category and the NORMALIZED search
   * each have their own entry with their own pages and cursor, so a page read
   * for one question can never be shown, or continued, under another.
   */
  productPagesFor: (userId: string, organizationId: string, query: CatalogPageQuery) =>
    [
      CATALOG_QUERY_ROOT,
      userId,
      organizationId,
      "product-pages",
      query.status,
      query.categoryId ?? "all",
      query.search,
    ] as const,
  product: (userId: string, organizationId: string, productId: string) =>
    [CATALOG_QUERY_ROOT, userId, organizationId, "product", productId] as const,
  categories: (userId: string, organizationId: string) =>
    [CATALOG_QUERY_ROOT, userId, organizationId, "categories"] as const,
  /**
   * The same organization's ACTIVE catalog, in the operational UI's own
   * `Product` shape (src/lib/api/index.ts#getPosProducts / #getProducts) —
   * POS, the manual order-create picker, and the Conversation Smart Action
   * variant resolver.
   *
   * A sibling key rather than a reuse of `products` above because the payload
   * is a different shape (the mapped UI `Product`, not the server
   * `CatalogProduct`), and `surface` keeps the three consumers from reading
   * each other's mapped list back. Living under CATALOG_QUERY_ROOT is the
   * point: these are organization catalog reads, so clearCatalogQueries and
   * enforceCatalogCachePrincipal already cover them, and POS cannot flash
   * another organization's catalog after an account switch.
   */
  uiProducts: (
    userId: string,
    organizationId: string,
    surface: "pos" | "order-create" | "smart-action",
  ) => [CATALOG_QUERY_ROOT, userId, organizationId, "ui-products", surface] as const,
};

/** Every catalog cache entry lives under this prefix, in any tab. */
const CATALOG_QUERY_PREFIX = [CATALOG_QUERY_ROOT] as const;

/**
 * The principal (userId + organizationId) whose catalog data this tab's cache
 * currently holds. Keyed by QueryClient, not component state, so it survives
 * the unmount/remount cycle of a client-side sign-out then sign-in — the case
 * where one tab serves two different members of the same organization.
 */
const LAST_CATALOG_PRINCIPAL = new WeakMap<QueryClient, string>();

/**
 * Drop every catalog cache entry, for every principal, in this tab.
 *
 * `removeQueries` (not `invalidateQueries`) is deliberate: invalidation leaves
 * the previous principal's payload — cost included — readable in the cache
 * until a refetch resolves, which is exactly the window a departed member's
 * data must not survive into. Mirrors clearHomeQueries in
 * src/lib/home-query.ts, which this module deliberately parallels.
 *
 * Never throws. Nothing here may block navigation or sign-out.
 */
export function clearCatalogQueries(queryClient: QueryClient): void {
  try {
    queryClient.removeQueries({ queryKey: CATALOG_QUERY_PREFIX });
  } catch {
    // A cache that cannot be pruned must never keep stale data readable by
    // pretending the clear succeeded silently — but it also must never throw
    // and block whatever the caller is doing (navigating, signing out).
  } finally {
    try {
      LAST_CATALOG_PRINCIPAL.delete(queryClient);
    } catch {
      // Ignore — nothing here may block the caller.
    }
  }
}

/**
 * Drop the catalog cache whenever the authenticated principal differs from
 * the one it was filled for, and leave it alone otherwise so ordinary caching
 * still works within one member's session.
 *
 * This is independent, defense-in-depth isolation: it does not replace
 * queryClient.clear() on an explicit sign-out (src/routes/app.settings.tsx),
 * it covers the same case Home's enforceHomeCachePrincipal covers — the
 * global clear failing partway, or a future client-side account switch that
 * does not go through Settings' sign-out path.
 *
 * `userId` and `organizationId` must come from the server-derived route
 * context, never from the capability snapshot or client input — they are a
 * cache partition only, never an authorization claim.
 */
export function enforceCatalogCachePrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  // "/" cannot appear in a UUID, so no two principals can produce one string.
  const principal = `${userId}/${organizationId}`;
  if (LAST_CATALOG_PRINCIPAL.get(queryClient) === principal) return;
  clearCatalogQueries(queryClient);
  LAST_CATALOG_PRINCIPAL.set(queryClient, principal);
}

// ── Money: integer minor units, parsed without floating point ────────────────
//
// MINOR_UNIT_DIGITS / formatMinorUnitsForInput / parseMinorUnits now live in
// src/lib/money.ts, next to MINOR_UNITS and formatMoney, so the Payments UI
// can share the one integer-only parser instead of the Product catalog owning
// a second copy of the same currency facts. Re-exported here so every existing
// catalog-side import keeps working unchanged.
export { MINOR_UNIT_DIGITS, formatMinorUnitsForInput, parseMinorUnits } from "@/lib/money";

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
 * belongs to products.create; createVariant/createProduct check nothing else
 * per field.
 *
 * Editing is stricter, and follows updateVariant's actual authorization
 * exactly (src/server/products/service.ts):
 *
 *   const isChangingPrice = price_amount !== undefined || price_currency !== undefined;
 *   const isChangingCost  = cost_amount  !== undefined || cost_currency  !== undefined;
 *   if (isChangingPrice) ctx.require("products.update_price");
 *   else                 ctx.require("products.update_basic");   // <- fires for a cost-only patch
 *   if (isChangingCost)  ctx.require("products.update_cost");
 *
 * A cost-only edit (no price field in the same patch) does NOT skip the price
 * check into nothing — it falls into the `else`, so the server also demands
 * products.update_basic. Gating cost editing on update_cost + view_cost alone
 * (as this used to) offered an action the server would refuse every time: a
 * member with exactly those two keys but not update_basic would see an
 * enabled Save button that always came back 403. Cost is therefore editable
 * only with all three: products.view_cost (there must be a value to edit),
 * products.update_cost (permission to change it), and products.update_basic
 * (the server's own requirement for any patch that is not a price change).
 *
 * Cost is visible independently of all of that — view_cost alone shows the
 * value read-only. Without view_cost the server does not send a cost at all,
 * so an "edit" could only ever overwrite a value the member cannot see with
 * one they invented; the form sends no cost field in that case.
 */
export function variantFieldAccess(
  permissions: VariantPermissions,
  isEdit: boolean,
): VariantFieldAccess {
  return {
    basicEditable: isEdit ? permissions.canUpdateBasic : permissions.canCreate,
    priceEditable: isEdit ? permissions.canUpdatePrice : permissions.canCreate,
    costVisible: permissions.canViewCost,
    costEditable: isEdit
      ? permissions.canUpdateCost && permissions.canViewCost && permissions.canUpdateBasic
      : permissions.canUpdateCost && permissions.canViewCost,
  };
}

// ── Cost masking (pure) ──────────────────────────────────────────────────────

/**
 * The cost a variant may show THIS render, gated on the CURRENT capability
 * state rather than on what the cached `CatalogVariant` happens to carry.
 *
 * A cached product/variant fetched while the member held products.view_cost
 * survives in the React Query cache — keyed only by userId + organizationId —
 * until the next successful refetch. If that same principal's view_cost is
 * revoked mid-session, the cache is not purged or re-fetched on its own:
 * capabilities and catalog data are two independent queries. Every surface
 * that displays a variant's cost MUST call this helper rather than reading
 * `variant.cost` directly, so a revoked, denied, pending, errored, or
 * identity-mismatched capability state masks the value on the very next
 * render — never waiting on a refetch or an invalidation.
 *
 * `canViewCost` must itself already be fail-closed (false in every
 * CapabilityState other than "ready" — see createCapabilityView), which is
 * exactly what `capabilities.can("products.view_cost")` gives every caller.
 */
export function visibleVariantCost(
  variant: Pick<CatalogVariant, "cost">,
  canViewCost: boolean,
): Money | null {
  return canViewCost ? variant.cost : null;
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

// ── Products screen pages ────────────────────────────────────────────────────

export type { CatalogListCursor };

/** The question one paged list asks. `search` is already normalized. */
export interface CatalogPageQuery {
  status: CatalogListStatus;
  categoryId: string | null;
  search: string;
}

/** What listProductsPageFn returns (src/server/products/service.ts ProductListPage). */
interface ServerCatalogPage {
  products: unknown[];
  nextCursor: CatalogListCursor | null;
  servedAs: { userId: string; organizationId: string };
  query: { status: string; categoryId: string | null; search: string };
}

/** One page of the Products screen, accepted for one principal and one question. */
export interface CatalogPage {
  products: CatalogProduct[];
  /** Null only when the server found nothing further under this question. */
  nextCursor: CatalogListCursor | null;
}

/**
 * A page answered for a different member or organization than the cache entry
 * that asked for it — another tab signed in as someone else, or switched
 * business, between two requests from this screen. The page is discarded
 * before React Query can store it.
 */
export class CatalogPrincipalChangedError extends Error {
  constructor() {
    super("The product list was answered for a different account or business");
    this.name = "CatalogPrincipalChangedError";
  }
}

export function isCatalogPrincipalChanged(err: unknown): boolean {
  return err instanceof CatalogPrincipalChangedError;
}

/**
 * Accept a server page only when it was served for exactly the principal this
 * screen's cache entry belongs to, and answers exactly the question this entry
 * asked. The server authorized the request for whoever its session cookie
 * names; this decides only whether the answer may be filed under THIS key.
 *
 * A question mismatch is never a principal change, so it fails as an ordinary
 * error (and is retried) rather than being shown under the wrong search.
 *
 * So does a page that would continue without moving: a cursor on an empty
 * page, or the very cursor it was asked from. Following either would request
 * the same page forever behind Load more; refusing it shows an error instead.
 */
export function acceptCatalogPage(
  page: ServerCatalogPage,
  expected: { userId: string; organizationId: string },
  query: CatalogPageQuery,
  before: CatalogListCursor | null = null,
): CatalogPage {
  if (
    page.servedAs.userId !== expected.userId ||
    page.servedAs.organizationId !== expected.organizationId
  ) {
    throw new CatalogPrincipalChangedError();
  }
  if (
    page.query.status !== query.status ||
    page.query.categoryId !== query.categoryId ||
    page.query.search !== query.search
  ) {
    throw new Error("The product list was answered for a different search or filter");
  }
  if (
    page.nextCursor &&
    (page.products.length === 0 ||
      (before !== null &&
        page.nextCursor.createdAt === before.createdAt &&
        page.nextCursor.id === before.id))
  ) {
    throw new Error("The product list did not move past the previous page");
  }
  return { products: page.products as CatalogProduct[], nextCursor: page.nextCursor };
}

/**
 * One page of the Products screen — src/routes/app.products.tsx.
 *
 * `before` is the previous page's `nextCursor`, exactly as the server issued
 * it; null asks for the newest page. `expected` is the principal of the cache
 * entry this page will be stored under (the /app route guard's server-derived
 * context). `signal` is React Query's: a search the merchant has already typed
 * past is aborted on the wire, and its answer could not be filed anyway.
 */
export async function listCatalogProductsPage(input: {
  before: CatalogListCursor | null;
  expected: { userId: string; organizationId: string };
  query: CatalogPageQuery;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CatalogPage> {
  const { listProductsPageFn } = await import("@/api/products");
  const page = await listProductsPageFn({
    data: {
      status: input.query.status,
      ...(input.query.categoryId ? { categoryId: input.query.categoryId } : {}),
      ...(input.query.search ? { search: input.query.search } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return acceptCatalogPage(
    page as unknown as ServerCatalogPage,
    input.expected,
    input.query,
    input.before,
  );
}

export type CatalogListErrorKind =
  "principal_changed" | "unauthorized" | "forbidden" | "server_error";

/**
 * What a failed page read means for the list on screen.
 *
 * unauthorized / forbidden / principal_changed are answers about WHO is
 * asking: retrying cannot change them, and rows already on screen must leave
 * it. Anything else (a dropped connection, a 500) is worth a retry.
 */
export function classifyCatalogListError(err: unknown): CatalogListErrorKind {
  if (isCatalogPrincipalChanged(err)) return "principal_changed";
  const code = err instanceof Error ? (err as { statusCode?: unknown }).statusCode : undefined;
  const message = err instanceof Error ? err.message : "";
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  // The service's own crafted copy, when a status code does not survive the
  // RPC boundary — the same fallback classifyOrderError uses.
  if (/^(not authenticated|no active organization membership)$/i.test(message)) {
    return "unauthorized";
  }
  if (/^missing permission:/i.test(message)) return "forbidden";
  return "server_error";
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
