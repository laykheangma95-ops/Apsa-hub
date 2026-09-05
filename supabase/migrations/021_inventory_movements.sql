-- Migration: 021_inventory_movements
-- Purpose: Inventory movement ledger — the authoritative source of stock truth.
-- Tables: inventory_movements (append-only ledger)
-- View: inventory_stock (live aggregate over the ledger — never a mutable cache)
-- Classification: tenant-private (scoped to organization_id)
--
-- ARCHITECTURE (ARCHITECTURE.md, MVP_ROADMAP inventory phase):
--   Inventory is a ledger, not a mutable stock count field. Stock is derived by
--   summing quantity_delta over inventory_movements. There is no stock column
--   anywhere that is directly UPDATEd — every stock change is a new, immutable
--   INSERT into this table. This table has no UPDATE or DELETE path in normal
--   product flow (RLS blocks both).
--
--   `inventory_stock` is a plain (non-materialized) VIEW, not a cached balance
--   table. It recomputes SUM(quantity_delta) from the ledger on every read.
--   This intentionally avoids a maintained balance column that could drift
--   out of sync under concurrent writes — correctness over premature
--   performance optimization. If/when this needs to scale further, a
--   maintained balance table can be introduced later as an optimization
--   without changing the ledger's meaning (DATA_MODEL.md §40 — "movement
--   history remains authoritative; balance is optimized state").
--
-- V1 movement types (deliberately a subset of the fuller taxonomy sketched in
-- DATA_MODEL.md §39 — purchase/damage/transfer/reservation are POST-MVP per
-- the current build phase's explicit scope):
--   initial, sale, return, manual_adjustment, restock
--
-- Tenant ownership: organization_id
-- Cross-tenant integrity: trigger enforces variant/product/location all belong
--   to the same organization_id as the movement row (mirrors 020's pattern).
-- Idempotency: partial unique index on (organization_id, variant_id,
--   reference_type, reference_id) prevents duplicate movements for the same
--   external/domain event (e.g. a retried order-paid webhook).
-- RLS: active members can read; INSERT is layered defense-in-depth (the
--   application/service layer is authoritative — see src/server/inventory).
--   No UPDATE, no DELETE — the ledger is append-only.

-- ── Enum ──────────────────────────────────────────────────────────────────────

CREATE TYPE public.inventory_movement_type AS ENUM (
  'initial',
  'sale',
  'return',
  'manual_adjustment',
  'restock'
);

-- ── inventory_movements ────────────────────────────────────────────────────────

CREATE TABLE public.inventory_movements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id       UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  -- Nullable: not every merchant/schema stage uses multi-location tracking yet.
  location_id      UUID REFERENCES public.locations(id) ON DELETE SET NULL,
  quantity_delta   INTEGER NOT NULL CHECK (quantity_delta <> 0),
  movement_type    public.inventory_movement_type NOT NULL,
  -- e.g. 'order', 'manual', 'import' — free-form, application-defined.
  reference_type   TEXT,
  reference_id     UUID,
  reason           TEXT,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- reference_type and reference_id must both be present or both absent —
  -- a reference_id without knowing what it refers to is meaningless.
  CONSTRAINT inventory_movements_reference_pair CHECK (
    (reference_type IS NULL) = (reference_id IS NULL)
  )
);

COMMENT ON TABLE public.inventory_movements IS
  'Append-only inventory ledger. Never UPDATE or DELETE rows in normal product flow — stock corrections are new movements, not edits.';

-- ── Idempotency: one movement per (org, variant, reference) ───────────────────
-- Prevents duplicate processing of the same domain/external event (e.g. an
-- order-paid webhook retried after a timeout) from double-counting stock.

CREATE UNIQUE INDEX uniq_inventory_movements_reference
  ON public.inventory_movements(organization_id, variant_id, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_inventory_movements_org
  ON public.inventory_movements(organization_id);

-- Stock computation and movement history for a variant, newest first.
CREATE INDEX idx_inventory_movements_org_variant_created
  ON public.inventory_movements(organization_id, variant_id, created_at DESC);

CREATE INDEX idx_inventory_movements_org_product
  ON public.inventory_movements(organization_id, product_id);

CREATE INDEX idx_inventory_movements_org_location
  ON public.inventory_movements(organization_id, location_id)
  WHERE location_id IS NOT NULL;

CREATE INDEX idx_inventory_movements_org_created_at
  ON public.inventory_movements(organization_id, created_at DESC);

-- ── Cross-tenant integrity check ──────────────────────────────────────────────
-- Ensures variant_id, product_id, and location_id (if set) all belong to the
-- SAME organization_id as the movement, and that variant_id belongs to product_id.
-- This prevents cross-tenant injection even via supabaseAdmin (service-role) writes.

CREATE OR REPLACE FUNCTION public.check_inventory_movement_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_variants
    WHERE id = NEW.variant_id
      AND product_id = NEW.product_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'inventory_movement variant_id must belong to product_id and organization_id (cross_tenant_variant)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'inventory_movement product_id must belong to the same organization (cross_tenant_product)';
  END IF;

  IF NEW.location_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.locations
      WHERE id = NEW.location_id
        AND organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION
        'inventory_movement location_id must belong to the same organization (cross_tenant_location)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Ledger is append-only, so this only needs to fire on INSERT.
CREATE TRIGGER inventory_movement_integrity_check
  BEFORE INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.check_inventory_movement_integrity();

-- ── Row-Level Security ──────────────────────────────────────────────────────────

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_movements_select_member"
  ON public.inventory_movements FOR SELECT
  USING (public.is_active_member_of(organization_id));

-- Application layer (src/server/inventory/service.ts) checks the appropriate
-- inventory.* permission for the movement_type before this INSERT executes.
CREATE POLICY "inventory_movements_insert_member"
  ON public.inventory_movements FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Append-only ledger: no UPDATE, no DELETE, ever, in normal product flow.
CREATE POLICY "inventory_movements_no_update"
  ON public.inventory_movements FOR UPDATE
  USING (false);

CREATE POLICY "inventory_movements_no_delete"
  ON public.inventory_movements FOR DELETE
  USING (false);

-- ── inventory_stock: live derived balance (never a mutable cache) ─────────────
-- security_invoker means this view enforces the RLS of inventory_movements for
-- whichever role queries it, instead of running as the view owner. Defense in
-- depth alongside the application layer's explicit organization_id filtering.

CREATE VIEW public.inventory_stock
WITH (security_invoker = true) AS
SELECT
  organization_id,
  product_id,
  variant_id,
  location_id,
  SUM(quantity_delta)::INTEGER AS quantity_on_hand,
  MAX(created_at) AS last_movement_at
FROM public.inventory_movements
GROUP BY organization_id, product_id, variant_id, location_id;

COMMENT ON VIEW public.inventory_stock IS
  'Live aggregate of inventory_movements. Not a cache — always recomputed from the ledger. Movement history (inventory_movements) is authoritative; this view is derived, optimized-read state.';
