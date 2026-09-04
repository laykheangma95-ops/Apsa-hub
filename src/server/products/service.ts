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
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLog } from "@/server/auth/audit";
import * as repo from "./repository";
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

  return products.map((p) =>
    mapProduct(p, variantsByProduct.get(p.id) ?? [], canViewCost),
  );
}

export async function getProductDetail(
  ctx: AuthorizationContext,
  productId: string,
): Promise<ProductDetail> {
  ctx.require("products.read");

  const canViewCost = ctx.can("products.view_cost");
  const [product, variants] = await Promise.all([
    repo.findProductById(ctx.organizationId, productId),
    repo.listVariantsByProduct(ctx.organizationId, productId),
  ]);

  if (!product) {
    throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  }

  return mapProduct(product, variants, canViewCost);
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
    product: mapProduct(product, [variant], canViewCost),
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
    product: mapProduct(product, [variant], canViewCost),
  };
}

export async function createProduct(
  ctx: AuthorizationContext,
  input: CreateProductInput & { initialVariant: CreateVariantInput },
): Promise<ProductDetail> {
  ctx.require("products.create");

  const { initialVariant, ...productInput } = input;

  // Validate money: price_amount must be a non-negative integer.
  if (!Number.isInteger(initialVariant.price_amount) || initialVariant.price_amount < 0) {
    throw Object.assign(
      new Error("price_amount must be a non-negative integer (minor units)"),
      { statusCode: 400 },
    );
  }
  if (initialVariant.cost_amount != null) {
    if (!Number.isInteger(initialVariant.cost_amount) || initialVariant.cost_amount < 0) {
      throw Object.assign(
        new Error("cost_amount must be a non-negative integer (minor units)"),
        { statusCode: 400 },
      );
    }
    if (!initialVariant.cost_currency) {
      throw Object.assign(new Error("cost_currency is required when cost_amount is set"), {
        statusCode: 400,
      });
    }
  }

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
      throw Object.assign(new Error("SKU already exists in this organization"), {
        statusCode: 409,
      });
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw Object.assign(new Error("Barcode already exists in this organization"), {
        statusCode: 409,
      });
    }
    throw err;
  }

  return mapProduct(product, [variant], canViewCost);
}

export async function updateProduct(
  ctx: AuthorizationContext,
  productId: string,
  patch: UpdateProductInput,
): Promise<ProductDetail> {
  ctx.require("products.update_basic");

  const existing = await repo.findProductById(ctx.organizationId, productId);
  if (!existing) {
    throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  }

  const updated = await repo.updateProduct(ctx.organizationId, productId, patch);
  if (!updated) {
    throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  }

  const canViewCost = ctx.can("products.view_cost");
  const variants = await repo.listVariantsByProduct(ctx.organizationId, productId);
  return mapProduct(updated, variants, canViewCost);
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
    throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  }

  const canViewCost = ctx.can("products.view_cost");
  const variants = await repo.listVariantsByProduct(ctx.organizationId, productId, true);
  return mapProduct(updated, variants, canViewCost);
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
    throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  }

  if (!Number.isInteger(input.price_amount) || input.price_amount < 0) {
    throw Object.assign(
      new Error("price_amount must be a non-negative integer (minor units)"),
      { statusCode: 400 },
    );
  }

  const canViewCost = ctx.can("products.view_cost");

  let variant: ProductVariantRow;
  try {
    variant = await repo.createVariant(ctx.organizationId, productId, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("uniq_product_variants_sku_per_org")) {
      throw Object.assign(new Error("SKU already exists in this organization"), {
        statusCode: 409,
      });
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw Object.assign(new Error("Barcode already exists in this organization"), {
        statusCode: 409,
      });
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
  const isChangingPrice =
    patch.price_amount !== undefined || patch.price_currency !== undefined;
  const isChangingCost =
    patch.cost_amount !== undefined || patch.cost_currency !== undefined;

  if (isChangingPrice) ctx.require("products.update_price");
  else ctx.require("products.update_basic");

  if (isChangingCost) ctx.require("products.update_cost");

  const existing = await repo.findVariantById(ctx.organizationId, variantId);
  if (!existing) {
    throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
  }

  if (patch.price_amount !== undefined) {
    if (!Number.isInteger(patch.price_amount) || patch.price_amount < 0) {
      throw Object.assign(
        new Error("price_amount must be a non-negative integer (minor units)"),
        { statusCode: 400 },
      );
    }
  }

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
      throw Object.assign(new Error("SKU already exists in this organization"), {
        statusCode: 409,
      });
    }
    if (msg.includes("uniq_product_variants_barcode_per_org")) {
      throw Object.assign(new Error("Barcode already exists in this organization"), {
        statusCode: 409,
      });
    }
    throw err;
  }

  if (!updated) {
    throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
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
    throw Object.assign(new Error("name_km is required"), { statusCode: 400 });
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
    throw Object.assign(new Error("Category not found"), { statusCode: 404 });
  }

  const updated = await repo.updateCategory(ctx.organizationId, categoryId, patch);
  if (!updated) {
    throw Object.assign(new Error("Category not found"), { statusCode: 404 });
  }

  return mapCategory(updated);
}
