-- Migration: 018_products
-- Purpose: Product and ProductVariant entities.
-- Tables: products, product_variants
-- Classification: tenant-private (scoped to organization_id)
-- Money storage: integer minor units (price_amount INTEGER + price_currency TEXT).
--   USD = cents (200 = $2.00), KHR = riel (5000 = 5000 riel).
-- SKU/barcode uniqueness: org-scoped partial unique indexes (NULL values do not conflict).
-- No stock count: inventory is a ledger, not a mutable field (ARCHITECTURE.md).
-- RLS: active members can read and manage products; no hard delete (archive only).
-- Cross-tenant integrity: trigger enforces variant.organization_id == product.organization_id.
-- Data model source: DATA_MODEL.md §30–§32

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE public.product_status AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE public.variant_status AS ENUM ('ACTIVE', 'ARCHIVED');

-- ── products ──────────────────────────────────────────────────────────────────

CREATE TABLE public.products (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- workspace_id scopes to a BUSINESS workspace but is nullable at MVP stage.
  workspace_id     UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  name_km          TEXT NOT NULL CHECK (length(trim(name_km)) > 0),
  name_en          TEXT,
  description_km   TEXT,
  description_en   TEXT,
  -- FK to product_categories; NULL = uncategorized.
  category_id      UUID REFERENCES public.product_categories(id) ON DELETE SET NULL,
  status           public.product_status NOT NULL DEFAULT 'ACTIVE',
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── product_variants ──────────────────────────────────────────────────────────

CREATE TABLE public.product_variants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  -- SKU: merchant-defined code. NULL allowed; when present, unique per org.
  sku              TEXT,
  -- Barcode: EAN-13 / QR / custom. NULL allowed; when present, unique per org.
  barcode          TEXT,
  -- Variant display name, e.g. "Black / S" or "" for single-variant products.
  name             TEXT NOT NULL DEFAULT '',
  -- Money: integer minor units. price_amount=200, price_currency='USD' → $2.00
  price_amount     INTEGER NOT NULL CHECK (price_amount >= 0),
  price_currency   TEXT NOT NULL DEFAULT 'USD' CHECK (price_currency IN ('USD', 'KHR')),
  -- cost is optional; required for margin calculations.
  -- Withheld from API responses unless caller has products.view_cost.
  cost_amount      INTEGER CHECK (cost_amount IS NULL OR cost_amount >= 0),
  cost_currency    TEXT CHECK (cost_currency IS NULL OR cost_currency IN ('USD', 'KHR')),
  -- Weight in grams — for shipping cost estimation. Nullable.
  weight_grams     INTEGER CHECK (weight_grams IS NULL OR weight_grams >= 0),
  status           public.variant_status NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Constraint: if cost is provided, currency must also be provided.
  CONSTRAINT cost_currency_required CHECK (
    (cost_amount IS NULL) = (cost_currency IS NULL)
  )
);

-- ── Uniqueness: org-scoped, null-safe ─────────────────────────────────────────
-- Partial indexes exclude NULL and empty-string values so two products can both
-- have no SKU without conflicting. Same-org duplicate non-null SKUs/barcodes ARE rejected.

CREATE UNIQUE INDEX uniq_product_variants_sku_per_org
  ON public.product_variants(organization_id, sku)
  WHERE sku IS NOT NULL AND sku <> '';

CREATE UNIQUE INDEX uniq_product_variants_barcode_per_org
  ON public.product_variants(organization_id, barcode)
  WHERE barcode IS NOT NULL AND barcode <> '';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_products_org
  ON public.products(organization_id);

CREATE INDEX idx_products_org_status
  ON public.products(organization_id, status);

CREATE INDEX idx_products_org_category
  ON public.products(organization_id, category_id)
  WHERE category_id IS NOT NULL;

CREATE INDEX idx_products_created_at
  ON public.products(organization_id, created_at DESC);

CREATE INDEX idx_product_variants_product
  ON public.product_variants(product_id);

CREATE INDEX idx_product_variants_org
  ON public.product_variants(organization_id);

CREATE INDEX idx_product_variants_org_sku
  ON public.product_variants(organization_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX idx_product_variants_org_barcode
  ON public.product_variants(organization_id, barcode)
  WHERE barcode IS NOT NULL;

-- ── updated_at triggers ───────────────────────────────────────────────────────

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER product_variants_set_updated_at
  BEFORE UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Cross-tenant integrity check ──────────────────────────────────────────────
-- Ensures product_variants.organization_id matches the parent product.organization_id.
-- This prevents cross-tenant variant injection even with supabaseAdmin writes.

CREATE OR REPLACE FUNCTION public.check_variant_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'product_variant organization_id must match the parent product organization_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER variant_org_integrity_check
  BEFORE INSERT OR UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.check_variant_org_integrity();

-- ── Row-Level Security: products ──────────────────────────────────────────────

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "products_select_member"
  ON public.products FOR SELECT
  USING (public.is_active_member_of(organization_id));

-- Application layer checks products.create before this INSERT executes.
CREATE POLICY "products_insert_member"
  ON public.products FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Application layer checks products.update_basic / products.update_price before UPDATE.
CREATE POLICY "products_update_member"
  ON public.products FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

-- Hard DELETE blocked. Use status = 'ARCHIVED'.
CREATE POLICY "products_no_delete"
  ON public.products FOR DELETE
  USING (false);

-- ── Row-Level Security: product_variants ──────────────────────────────────────

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_variants_select_member"
  ON public.product_variants FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "product_variants_insert_member"
  ON public.product_variants FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "product_variants_update_member"
  ON public.product_variants FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "product_variants_no_delete"
  ON public.product_variants FOR DELETE
  USING (false);
