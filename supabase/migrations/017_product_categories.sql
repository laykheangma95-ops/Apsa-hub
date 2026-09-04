-- Migration: 017_product_categories
-- Purpose: ProductCategory entity — tenant-owned category tree for organizing products.
-- Tables: product_categories
-- Classification: tenant-private (scoped to organization_id)
-- RLS: active members can read and manage categories; no hard delete (archive only)
-- Tenant ownership: organization_id (server-enforced, never trusted from client)
-- Data model source: DATA_MODEL.md §33 (ProductCategory)
-- Rollback: DROP TABLE public.product_categories CASCADE; DROP TYPE public.category_status;

-- ── Enum ──────────────────────────────────────────────────────────────────────

CREATE TYPE public.category_status AS ENUM ('ACTIVE', 'ARCHIVED');

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE public.product_categories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Optional self-referencing hierarchy for future nested categories (DATA_MODEL.md §33).
  -- MVP: parent_id is always NULL; tree support is schema-ready but not UI-required now.
  parent_id        UUID REFERENCES public.product_categories(id) ON DELETE SET NULL,
  name_km          TEXT NOT NULL CHECK (length(trim(name_km)) > 0),
  name_en          TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  status           public.category_status NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_product_categories_org
  ON public.product_categories(organization_id);

CREATE INDEX idx_product_categories_org_status
  ON public.product_categories(organization_id, status);

CREATE INDEX idx_product_categories_parent
  ON public.product_categories(parent_id)
  WHERE parent_id IS NOT NULL;

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

-- Active org members can read all categories in their org.
CREATE POLICY "product_categories_select_member"
  ON public.product_categories FOR SELECT
  USING (public.is_active_member_of(organization_id));

-- Active org members with appropriate permission can create categories.
-- Application layer enforces products.manage_categories before the INSERT.
CREATE POLICY "product_categories_insert_member"
  ON public.product_categories FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Active org members with appropriate permission can update categories.
CREATE POLICY "product_categories_update_member"
  ON public.product_categories FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

-- Hard DELETE is blocked. Use status = 'ARCHIVED' instead.
CREATE POLICY "product_categories_no_delete"
  ON public.product_categories FOR DELETE
  USING (false);
