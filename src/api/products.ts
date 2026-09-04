/**
 * Product domain server functions — TanStack Start API boundary.
 *
 * Security model:
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - All server-only modules (@/lib/supabase/server, @/server/products/*)
 *     are dynamically imported inside handler bodies so they never enter the client bundle.
 *   - Every handler requires an active session AND a products.* permission before touching data.
 *
 * Money: all price/cost fields use integer minor units (USD = cents, KHR = riel).
 * No floating-point financial arithmetic anywhere in this file.
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

// ── Money schema ──────────────────────────────────────────────────────────────

const currencySchema = z.enum(["USD", "KHR"]);

// ── Internal helper: resolve session + organization ────────────────────────────
// organizationId is NEVER accepted from the caller — always derived from DB membership.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService } = await import("@/server/auth/authorization");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMembership } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();

  if (!rawMembership) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  const membership = rawMembership as { organization_id: string };
  return AuthorizationService.forRequest(session.userId, membership.organization_id);
}

// ── listProductsFn ────────────────────────────────────────────────────────────

export const listProductsFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
        category_id: z.string().uuid().nullish(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(authCtx, {
      status: data?.status,
      category_id: data?.category_id ?? undefined,
      limit: data?.limit,
      offset: data?.offset,
    });
  });

// ── getProductDetailFn ────────────────────────────────────────────────────────

export const getProductDetailFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ id: z.string().uuid("Invalid product ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getProductDetail } = await import("@/server/products/service");
    return getProductDetail(authCtx, data.id);
  });

// ── lookupBySkuFn ─────────────────────────────────────────────────────────────

export const lookupBySkuFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({ sku: z.string().min(1).max(100, "SKU too long") })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { lookupBySku } = await import("@/server/products/service");
    return lookupBySku(authCtx, data.sku);
  });

// ── lookupByBarcodeFn ─────────────────────────────────────────────────────────

export const lookupByBarcodeFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({ barcode: z.string().min(1).max(100, "Barcode too long") })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { lookupByBarcode } = await import("@/server/products/service");
    return lookupByBarcode(authCtx, data.barcode);
  });

// ── createProductFn ───────────────────────────────────────────────────────────

const variantInputSchema = z.object({
  sku: z.string().max(100).nullish(),
  barcode: z.string().max(100).nullish(),
  name: z.string().max(200).optional(),
  price_amount: z
    .number()
    .int("price_amount must be an integer")
    .min(0, "price_amount must be >= 0"),
  price_currency: currencySchema,
  cost_amount: z
    .number()
    .int("cost_amount must be an integer")
    .min(0)
    .nullish(),
  cost_currency: currencySchema.nullish(),
  weight_grams: z.number().int().min(0).nullish(),
});

export const createProductFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        name_km: z.string().min(1).max(500),
        name_en: z.string().max(500).nullish(),
        description_km: z.string().max(5000).nullish(),
        description_en: z.string().max(5000).nullish(),
        category_id: z.string().uuid().nullish(),
        workspace_id: z.string().uuid().nullish(),
        status: z.enum(["DRAFT", "ACTIVE"]).optional(),
        initialVariant: variantInputSchema,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createProduct } = await import("@/server/products/service");
    return createProduct(authCtx, {
      name_km: data.name_km,
      name_en: data.name_en ?? null,
      description_km: data.description_km ?? null,
      description_en: data.description_en ?? null,
      category_id: data.category_id ?? null,
      workspace_id: data.workspace_id ?? null,
      status: data.status,
      initialVariant: {
        sku: data.initialVariant.sku ?? null,
        barcode: data.initialVariant.barcode ?? null,
        name: data.initialVariant.name ?? "",
        price_amount: data.initialVariant.price_amount,
        price_currency: data.initialVariant.price_currency,
        cost_amount: data.initialVariant.cost_amount ?? null,
        cost_currency: data.initialVariant.cost_currency ?? null,
        weight_grams: data.initialVariant.weight_grams ?? null,
      },
    });
  });

// ── updateProductFn ───────────────────────────────────────────────────────────

export const updateProductFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        productId: z.string().uuid("Invalid product ID"),
        name_km: z.string().min(1).max(500).optional(),
        name_en: z.string().max(500).nullish(),
        description_km: z.string().max(5000).nullish(),
        description_en: z.string().max(5000).nullish(),
        category_id: z.string().uuid().nullish(),
        status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateProduct } = await import("@/server/products/service");
    const { productId, ...patch } = data;
    return updateProduct(authCtx, productId, patch);
  });

// ── archiveProductFn ──────────────────────────────────────────────────────────

export const archiveProductFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ productId: z.string().uuid("Invalid product ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { archiveProduct } = await import("@/server/products/service");
    return archiveProduct(authCtx, data.productId);
  });

// ── createVariantFn ───────────────────────────────────────────────────────────

export const createVariantFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({ productId: z.string().uuid("Invalid product ID") })
      .merge(variantInputSchema)
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createVariant } = await import("@/server/products/service");
    const { productId, ...input } = data;
    return createVariant(authCtx, productId, {
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      name: input.name ?? "",
      price_amount: input.price_amount,
      price_currency: input.price_currency,
      cost_amount: input.cost_amount ?? null,
      cost_currency: input.cost_currency ?? null,
      weight_grams: input.weight_grams ?? null,
    });
  });

// ── updateVariantFn ───────────────────────────────────────────────────────────

export const updateVariantFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        variantId: z.string().uuid("Invalid variant ID"),
        sku: z.string().max(100).nullish(),
        barcode: z.string().max(100).nullish(),
        name: z.string().max(200).optional(),
        price_amount: z.number().int().min(0).optional(),
        price_currency: currencySchema.optional(),
        cost_amount: z.number().int().min(0).nullish(),
        cost_currency: currencySchema.nullish(),
        weight_grams: z.number().int().min(0).nullish(),
        status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateVariant } = await import("@/server/products/service");
    const { variantId, ...patch } = data;
    return updateVariant(authCtx, variantId, {
      sku: patch.sku ?? undefined,
      barcode: patch.barcode ?? undefined,
      name: patch.name,
      price_amount: patch.price_amount,
      price_currency: patch.price_currency,
      cost_amount: patch.cost_amount ?? undefined,
      cost_currency: patch.cost_currency ?? undefined,
      weight_grams: patch.weight_grams ?? undefined,
      status: patch.status,
    });
  });

// ── listCategoriesFn ──────────────────────────────────────────────────────────

export const listCategoriesFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({ includeArchived: z.boolean().optional() })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listCategories } = await import("@/server/products/service");
    return listCategories(authCtx, data?.includeArchived ?? false);
  });

// ── createCategoryFn ──────────────────────────────────────────────────────────

export const createCategoryFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        name_km: z.string().min(1).max(200),
        name_en: z.string().max(200).nullish(),
        parent_id: z.string().uuid().nullish(),
        sort_order: z.number().int().min(0).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createCategory } = await import("@/server/products/service");
    return createCategory(authCtx, {
      name_km: data.name_km,
      name_en: data.name_en ?? null,
      parent_id: data.parent_id ?? null,
      sort_order: data.sort_order,
    });
  });

// ── updateCategoryFn ──────────────────────────────────────────────────────────

export const updateCategoryFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        categoryId: z.string().uuid("Invalid category ID"),
        name_km: z.string().min(1).max(200).optional(),
        name_en: z.string().max(200).nullish(),
        parent_id: z.string().uuid().nullish(),
        sort_order: z.number().int().min(0).optional(),
        status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateCategory } = await import("@/server/products/service");
    const { categoryId, ...patch } = data;
    return updateCategory(authCtx, categoryId, patch);
  });
