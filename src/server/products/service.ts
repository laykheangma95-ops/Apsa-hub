/**
 * Product service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Delegate raw DB operations to the repository.
 *   4. Map DB rows to domain API shapes.
 *
 * Cost fields (cost_amount, cost_currency) are withheld from API responses
 * unless the caller has products.view_cost. This is enforced here — the UI
 * never decides visibility based on a client-side role check.
 *
 * Price changes are best-effort audited (products.price_change). The operation
 * is NOT blocked if the audit write fails — use auditLogRequired() only for
 * mandatory financial/refund actions.
 *
 * Inventory (stock count) is NOT part of this domain — see ARCHITECTURE.md.
 * Product.stock is always null in the production path.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLog } from "@/server/auth/audit";
import { formatApsaBarcode, APSA_SERIAL_LENGTH } from "@/lib/barcode/apsa-code";
import { isCode128Encodable } from "@/lib/barcode/code128";
import * as repo from "./repository";
import { resolveImageUrls } from "./image-service";
import type {
  ProductRow,
  ProductVariantRow,
  ProductCategoryRow,
  CreateProductInput,
  UpdateProductInput,
  CreateVariantInput,
  UpdateVariantInput,
  CreateCategoryInput,
  UpdateCategoryInput,
  ListProductsOptions,
} from "./types";
import type { Currency, CompanionColor, Money } from "@/types";

// ── Companion color derivation (deterministic, UI-only) ───────────────────────

const COMPANIONS: CompanionColor[] = ["nilo", "minto", "vela", "suri", "luma"];

function deriveCompanion(id: string): CompanionColor {
  const sum = id
    .slice(-12)
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return COMPANIONS[sum % COMPANIONS.length]!;
}

// ── Domain shape builders ─────────────────────────────────────────────────────

function toMoney(amount: number, currency: string): Money {
  return { amount, currency: currency as Currency };
}

/**
 * Reject a manual/manufacturer barcode that Code 128 cannot encode BEFORE it is
 * stored (§14). A value with non-ASCII or control characters would otherwise
 * persist and then crash label generation every time the label is opened — a
 * latent print crash. Common manufacturer formats (EAN/UPC, alphanumeric) all
 * pass; only genuinely unencodable input is refused. An empty/cleared barcode
 * (null / "") is fine and skipped.
 */
function assertBarcodeEncodable(barcode: string | null | undefined): void {
  if (barcode == null) return;
  const trimmed = barcode.trim();
  if (trimmed === "") return;
  if (!isCode128Encodable(trimmed)) {
    throw publicError(
      "Barcode contains characters that cannot be printed as a Code 128 label; use digits and standard letters/symbols only",
      400,
    );
  }
}

// ── Exported domain types ─────────────────────────────────────────────────────

export interface ProductVariantDetail {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  price: Money;
  /** null when caller lacks products.view_cost */
  cost: Money | null;
  weightGrams: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDetail {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  nameKm: string;
  nameEn: string | null;
  descriptionKm: string | null;
  descriptionEn: string | null;
  categoryId: string | null;
  status: string;
  /**
   * Short-lived signed URL of the primary photo, or null. Presentation only —
   * never identity. The storage path is not exposed.
   */
  imageUrl: string | null;
  companion: CompanionColor;
  /** Inventory is a separate domain — stock is always null from the Product domain. */
  stock: null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  variants: ProductVariantDetail[];
}

export interface ProductCategoryDetail {
  id: string;
  organizationId: string;
  parentId: string | null;
  nameKm: string;
  nameEn: string | null;
  sortOrder: number;
  status: string;
  createdAt: string;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapVariant(row: ProductVariantRow, canViewCost: boolean): ProductVariantDetail {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    price: toMoney(row.price_amount, row.price_currency),
    cost:
      canViewCost && row.cost_amount != null && row.cost_currency != null
        ? toMoney(row.cost_amount, row.cost_currency)
        : null,
    weightGrams: row.weight_grams,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProduct(
  product: ProductRow,
  variants: ProductVariantRow[],
  canViewCost: boolean,
): ProductDetail {
  return {
    id: product.id,
    organizationId: product.organization_id,
    workspaceId: product.workspace_id,
    nameKm: product.name_km,
    nameEn: product.name_en,
    descriptionKm: product.description_km,
    descriptionEn: product.description_en,
    categoryId: product.category_id,
    status: product.status,
    imageUrl: null,
    companion: deriveCompanion(product.id),
    stock: null,
    createdBy: product.created_by,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    variants: variants.map((v) => mapVariant(v, canViewCost)),
  };
}

function mapCategory(row: ProductCategoryRow): ProductCategoryDetail {
  return {
    id: row.id,
    organizationId: row.organization_id,
    parentId: row.parent_id,
    nameKm: row.name_km,
    nameEn: row.name_en,
    sortOrder: row.sort_order,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Fill in signed image URLs for already-mapped products (one batch call). */
async function withImageUrls(
  details: ProductDetail[],
  rows: ProductRow[],
): Promise<ProductDetail[]> {
  const urls = await resolveImageUrls(rows);
  for (const d of details) d.imageUrl = urls.get(d.id) ?? null;
  return details;
}

async function mapOneWithImage(
  row: ProductRow,
  variants: ProductVariantRow[],
  canViewCost: boolean,
): Promise<ProductDetail> {
  const [detail] = await withImageUrls([mapProduct(row, variants, canViewCost)], [row]);
  return detail!;
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function getProductCatalog(
  ctx: AuthorizationContext,
  opts: ListProductsOptions = {},
): Promise<ProductDetail[]> {
  ctx.require("products.read");

  const canViewCost = ctx.can("products.view_cost");
  const products = await repo.listProducts(ctx.organizationId, opts);
  if (products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const allVariants = await repo.listVariantsByOrg(ctx.organizationId, productIds);

  const variantsByProduct = new Map<string, ProductVariantRow[]>();
  for (const v of allVariants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  return withImageUrls(
    products.map((p) => mapProduct(p, variantsByProduct.get(p.id) ?? [], canViewCost)),
    products,
  );
}

/**
 * One product, with its variants.
 *
 * `includeArchivedVariants` opts into the archived rows the repository already
 * knows how to return (repo.listVariantsByProduct's own third argument, as
 * archiveProduct below already uses). It defaults to false, so every existing
 * caller — POS, order create, the product list mapper — keeps seeing active
 * variants only. It widens nothing: the read still requires products.read and
 * is still scoped to ctx.organizationId in the repository.
 */
export async function getProductDetail(
  ctx: AuthorizationContext,
  productId: string,
  includeArchivedVariants = false,
): Promise<ProductDetail> {
  ctx.require("products.read");

  const canViewCost = ctx.can("products.view_cost");
  const [product, variants] = await Promise.all([
    repo.findProductById(ctx.organizationId, productId),
    repo.listVariantsByProduct(ctx.organizationId, productId, includeArchivedVariants),
  ]);

  if (!product) {
    throw publicError("Product not found", 404);
  }

  return mapOneWithImage(product, variants, canViewCost);
}

/**
 * Exact-match SKU lookup — org-scoped.
 * Returns the matching variant and its parent product, or null.
 * No fuzzy matching — the lookup must be precise.
 */
export async function lookupBySku(
  ctx: AuthorizationContext,
  sku: string,
): Promise<{ variant: ProductVariantDetail; product: ProductDetail } | null> {
  ctx.require("products.read");

  const canViewCost = ctx.can("products.view_cost");
  const variant = await repo.findVariantBySku(ctx.organizationId, sku);
  if (!variant) return null;

  const product = await repo.findProductById(ctx.organizationId, variant.product_id);
  if (!product) return null;

  return {
    variant: mapVariant(variant, canViewCost),
    product: await mapOneWithImage(product, [variant], canViewCost),
  };
}

/**
 * Exact-match barcode lookup — org-scoped.
 * Returns the matching variant and its parent product, or null.
 * No fuzzy matching — the lookup must be precise.
 */
export async function lookupByBarcode(
  ctx: AuthorizationContext,
  barcode: string,
): Promise<{ variant: ProductVariantDetail; product: ProductDetail } | null> {
  ctx.require("products.read");

  const canViewCost = ctx.can("products.view_cost");
  const variant = await repo.findVariantByBarcode(ctx.organizationId, barcode);
  if (!variant) return null;

  const product = await repo.findProductById(ctx.organizationId, variant.product_id);
  if (!product) return null;

  return {
    variant: mapVariant(variant, canViewCost),
    product: await mapOneWithImage(product, [variant], canViewCost),
  };
}

/**
 * Generate a fresh, org-unique APSA barcode for a variant and persist it.
 *
 * This is the "let APSA generate one" path (session scope §3). Three invariants:
 *
 *   1. NEVER overwrite an existing barcode. A variant that already carries one
 *      (a manufacturer code, or a code entered manually) is left untouched — the
 *      caller must clear it first. Automatic overwrite would silently orphan a
 *      code already printed on stock.
 *   2. UNIQUENESS IS SERVER-CHECKED, never trusted from the client. Each
 *      candidate is re-checked against the live org index (barcodeExistsForOrg,
 *      which is status-agnostic to match the DB unique index) before use, and
 *      the DB unique constraint is the final backstop against a concurrent race.
 *   3. NO PII / NO UUID. The code is APSA + a non-reversible org prefix + random
 *      serial + Luhn check (see src/lib/barcode/apsa-code.ts).
 *
 * `serialFactory` is a test seam; in production it defaults to a crypto RNG.
 */
export interface GenerateBarcodeOptions {
  serialFactory?: () => string;
  maxAttempts?: number;
}

function cryptoRandomSerial(): string {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  // Fold into the serial space (10^APSA_SERIAL_LENGTH). Modulo bias here is
  // irrelevant: the collision check + unique index guarantee correctness; the
  // serial only needs enough spread to make retries rare.
  const modulus = 10 ** APSA_SERIAL_LENGTH;
  return String(buf[0]! % modulus);
}

export async function generateVariantBarcode(
  ctx: AuthorizationContext,
  variantId: string,
  options: GenerateBarcodeOptions = {},
): Promise<ProductVariantDetail> {
  // Assigning a barcode is a basic-field edit (same gate as editing SKU/barcode
  // through updateVariant), not a price or cost change.
  ctx.require("products.update_basic");

  const existing = await repo.findVariantById(ctx.organizationId, variantId);
  if (!existing) {
    throw publicError("Variant not found", 404);
  }
  if (existing.barcode && existing.barcode.trim() !== "") {
    throw publicError("Variant already has a barcode; clear it before generating a new one", 409);
  }

  const serialFactory = options.serialFactory ?? cryptoRandomSerial;
  const maxAttempts = options.maxAttempts ?? 8;
  const canViewCost = ctx.can("products.view_cost");

  /*
   * Each attempt: generate a candidate, then write it with a CONDITIONAL
   * update that only fires while barcode IS STILL NULL (repo.updateVariant-
   * BarcodeIfNull). This closes the race the pre-read check alone left open —
   * two requests that both saw NULL cannot both persist, because the database
   * evaluates "barcode IS NULL" under its own row lock:
   *
   *   - exactly one conditional UPDATE matches the row and wins;
   *   - a concurrent generation that already set the barcode makes this write
   *     match ZERO rows, so we return the EXISTING code rather than clobbering
   *     it (invariant 1 — never overwrite);
   *   - a cross-variant code collision trips the org-unique index and throws;
   *     we retry with a fresh candidate up to maxAttempts (the DB index, not
   *     the pre-read, is the final uniqueness authority).
   *
   * barcodeExistsForOrg stays as a courtesy that avoids most doomed writes, but
   * it is explicitly NOT relied on for correctness.
   */
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = formatApsaBarcode(ctx.organizationId, serialFactory());
    if (await repo.barcodeExistsForOrg(ctx.organizationId, candidate)) continue;

    let written: ProductVariantRow | null;
    try {
      written = await repo.updateVariantBarcodeIfNull(ctx.organizationId, variantId, candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Another variant took this exact code between our check and our write —
      // retry with a fresh candidate rather than overwriting or failing hard.
      if (msg.includes("uniq_product_variants_barcode_per_org")) continue;
      throw err;
    }

    if (written) return mapVariant(written, canViewCost);

    // Zero rows updated: the barcode is no longer NULL because a concurrent
    // generation already set it. Return that persisted code — the first write
    // wins and is never replaced.
    const current = await repo.findVariantById(ctx.organizationId, variantId);
    if (!current) throw publicError("Variant not found", 404);
    if (current.barcode && current.barcode.trim() !== "") {
      return mapVariant(current, canViewCost);
    }
    // Still NULL despite a 0-row conditional write (should not happen) — fall
    // through and try again rather than returning an unbarcoded variant.
  }

  throw publicError("Could not generate a unique barcode; please try again", 503);
}

export async function createProduct(
  ctx: AuthorizationContext,
  input: CreateProductInput & { initialVariant: CreateVariantInput },
): Promise<ProductDetail> {
  ctx.require("products.create");

  const { initialVariant, ...productInput } = input;

  // Validate money: price_amount must be a non-negative integer.
  if (!Number.isInteger(initialVariant.price_amount) || initialVariant.price_amount < 0) {
    throw publicError("price_amount must be a non-negative integer (minor units)", 400);
  }
  if (initialVariant.cost_amount != null) {
    if (!Number.isInteger(initialVariant.cost_amount) || initialVariant.cost_amount < 0) {
      throw publicError("cost_amount must be a non-negative integer (minor units)", 400);
    }
    if (!initialVariant.cost_currency) {
      throw publicError("cost_currency is required when cost_amount is set", 400);
    }
  }
  assertBarcodeEncodable(initialVariant.barcode);

  const canViewCost = ctx.can("products.view_cost");
  const product = await repo.createProduct(ctx.organizationId, {
    ...productInput,
    created_by: ctx.userId,
  });

  let variant: ProductVariantRow;
  try {
    variant = await repo.createVariant(ctx.organizationId, product.id, initialVariant);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uniq_product_variants_sku_per_org")) {
      throw publicError("SKU already exists in this organization", 409);
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw publicError("Barcode already exists in this organization", 409);
    }
    throw err;
  }

  return mapOneWithImage(product, [variant], canViewCost);
}

export async function updateProduct(
  ctx: AuthorizationContext,
  productId: string,
  patch: UpdateProductInput,
): Promise<ProductDetail> {
  ctx.require("products.update_basic");

  const existing = await repo.findProductById(ctx.organizationId, productId);
  if (!existing) {
    throw publicError("Product not found", 404);
  }

  const updated = await repo.updateProduct(ctx.organizationId, productId, patch);
  if (!updated) {
    throw publicError("Product not found", 404);
  }

  const canViewCost = ctx.can("products.view_cost");
  const variants = await repo.listVariantsByProduct(ctx.organizationId, productId);
  return mapOneWithImage(updated, variants, canViewCost);
}

export async function archiveProduct(
  ctx: AuthorizationContext,
  productId: string,
): Promise<ProductDetail> {
  ctx.require("products.archive");

  const updated = await repo.updateProduct(ctx.organizationId, productId, {
    status: "ARCHIVED",
  });
  if (!updated) {
    throw publicError("Product not found", 404);
  }

  const canViewCost = ctx.can("products.view_cost");
  const variants = await repo.listVariantsByProduct(ctx.organizationId, productId, true);
  return mapOneWithImage(updated, variants, canViewCost);
}

export async function createVariant(
  ctx: AuthorizationContext,
  productId: string,
  input: CreateVariantInput,
): Promise<ProductVariantDetail> {
  ctx.require("products.create");

  // Validate product belongs to this org.
  const product = await repo.findProductById(ctx.organizationId, productId);
  if (!product) {
    throw publicError("Product not found", 404);
  }

  if (!Number.isInteger(input.price_amount) || input.price_amount < 0) {
    throw publicError("price_amount must be a non-negative integer (minor units)", 400);
  }
  assertBarcodeEncodable(input.barcode);

  const canViewCost = ctx.can("products.view_cost");

  let variant: ProductVariantRow;
  try {
    variant = await repo.createVariant(ctx.organizationId, productId, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uniq_product_variants_sku_per_org")) {
      throw publicError("SKU already exists in this organization", 409);
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw publicError("Barcode already exists in this organization", 409);
    }
    throw err;
  }

  return mapVariant(variant, canViewCost);
}

export async function updateVariant(
  ctx: AuthorizationContext,
  variantId: string,
  patch: UpdateVariantInput,
): Promise<ProductVariantDetail> {
  // Price changes require products.update_price; basic fields require products.update_basic.
  const isChangingPrice = patch.price_amount !== undefined || patch.price_currency !== undefined;
  const isChangingCost = patch.cost_amount !== undefined || patch.cost_currency !== undefined;

  if (isChangingPrice) ctx.require("products.update_price");
  else ctx.require("products.update_basic");

  if (isChangingCost) ctx.require("products.update_cost");

  const existing = await repo.findVariantById(ctx.organizationId, variantId);
  if (!existing) {
    throw publicError("Variant not found", 404);
  }

  if (patch.price_amount !== undefined) {
    if (!Number.isInteger(patch.price_amount) || patch.price_amount < 0) {
      throw publicError("price_amount must be a non-negative integer (minor units)", 400);
    }
  }
  assertBarcodeEncodable(patch.barcode);

  if (isChangingPrice) {
    // Best-effort price change audit — does NOT block the update on audit failure.
    await auditLog(ctx, {
      action: "products.price_change",
      resourceType: "product_variants",
      resourceId: variantId,
      beforeJson: {
        price_amount: existing.price_amount,
        price_currency: existing.price_currency,
      },
      afterJson: {
        price_amount: patch.price_amount ?? existing.price_amount,
        price_currency: patch.price_currency ?? existing.price_currency,
      },
    });
  }

  const canViewCost = ctx.can("products.view_cost");

  let updated: ProductVariantRow | null;
  try {
    updated = await repo.updateVariant(ctx.organizationId, variantId, patch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uniq_product_variants_sku_per_org")) {
      throw publicError("SKU already exists in this organization", 409);
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw publicError("Barcode already exists in this organization", 409);
    }
    throw err;
  }

  if (!updated) {
    throw publicError("Variant not found", 404);
  }

  return mapVariant(updated, canViewCost);
}

// ── Categories ────────────────────────────────────────────────────────────────

export async function listCategories(
  ctx: AuthorizationContext,
  includeArchived = false,
): Promise<ProductCategoryDetail[]> {
  ctx.require("products.read");
  const rows = await repo.listCategories(ctx.organizationId, includeArchived);
  return rows.map(mapCategory);
}

export async function createCategory(
  ctx: AuthorizationContext,
  input: CreateCategoryInput,
): Promise<ProductCategoryDetail> {
  ctx.require("products.manage_categories");

  if (!input.name_km || !input.name_km.trim()) {
    throw publicError("name_km is required", 400);
  }

  const row = await repo.createCategory(ctx.organizationId, {
    ...input,
    name_km: input.name_km.trim(),
  });
  return mapCategory(row);
}

export async function updateCategory(
  ctx: AuthorizationContext,
  categoryId: string,
  patch: UpdateCategoryInput,
): Promise<ProductCategoryDetail> {
  ctx.require("products.manage_categories");

  const existing = await repo.findCategoryById(ctx.organizationId, categoryId);
  if (!existing) {
    throw publicError("Category not found", 404);
  }

  const updated = await repo.updateCategory(ctx.organizationId, categoryId, patch);
  if (!updated) {
    throw publicError("Category not found", 404);
  }

  return mapCategory(updated);
}
