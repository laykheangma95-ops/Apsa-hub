/**
 * Raw DB row types for the Product domain.
 * These match the columns in migrations 017–018 exactly.
 * Never used in UI — mapped to domain types by the service layer.
 */

export type ProductStatusDb = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type VariantStatusDb = "ACTIVE" | "ARCHIVED";
export type CategoryStatusDb = "ACTIVE" | "ARCHIVED";

export interface ProductCategoryRow {
  id: string;
  organization_id: string;
  parent_id: string | null;
  name_km: string;
  name_en: string | null;
  sort_order: number;
  status: CategoryStatusDb;
  created_at: string;
}

export interface ProductRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name_km: string;
  name_en: string | null;
  description_km: string | null;
  description_en: string | null;
  category_id: string | null;
  status: ProductStatusDb;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductVariantRow {
  id: string;
  organization_id: string;
  product_id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  price_amount: number;
  price_currency: string;
  cost_amount: number | null;
  cost_currency: string | null;
  weight_grams: number | null;
  status: VariantStatusDb;
  created_at: string;
  updated_at: string;
}

/** Joined result: product row + its variants */
export interface ProductWithVariantsRow {
  product: ProductRow;
  variants: ProductVariantRow[];
}

/** Input for creating a product (server-validated, org from auth context) */
export interface CreateProductInput {
  name_km: string;
  name_en?: string | null | undefined;
  description_km?: string | null | undefined;
  description_en?: string | null | undefined;
  category_id?: string | null | undefined;
  workspace_id?: string | null | undefined;
  status?: ProductStatusDb | undefined;
  created_by?: string | null | undefined;
}

/** Input for patching a product (all fields optional) */
export interface UpdateProductInput {
  name_km?: string | undefined;
  name_en?: string | null | undefined;
  description_km?: string | null | undefined;
  description_en?: string | null | undefined;
  category_id?: string | null | undefined;
  status?: ProductStatusDb | undefined;
}

/** Input for creating a variant */
export interface CreateVariantInput {
  sku?: string | null | undefined;
  barcode?: string | null | undefined;
  name?: string | undefined;
  price_amount: number;
  price_currency: string;
  cost_amount?: number | null | undefined;
  cost_currency?: string | null | undefined;
  weight_grams?: number | null | undefined;
}

/** Input for patching a variant */
export interface UpdateVariantInput {
  sku?: string | null | undefined;
  barcode?: string | null | undefined;
  name?: string | undefined;
  price_amount?: number | undefined;
  price_currency?: string | undefined;
  cost_amount?: number | null | undefined;
  cost_currency?: string | null | undefined;
  weight_grams?: number | null | undefined;
  status?: VariantStatusDb | undefined;
}

/** Input for creating a category */
export interface CreateCategoryInput {
  name_km: string;
  name_en?: string | null | undefined;
  parent_id?: string | null | undefined;
  sort_order?: number | undefined;
}

/** Input for patching a category */
export interface UpdateCategoryInput {
  name_km?: string | undefined;
  name_en?: string | null | undefined;
  parent_id?: string | null | undefined;
  sort_order?: number | undefined;
  status?: CategoryStatusDb | undefined;
}

/** Filter options for listing products */
export interface ListProductsOptions {
  status?: ProductStatusDb | undefined;
  category_id?: string | null | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
