-- Migration: 050_parcels
-- Purpose: Introduce the APSA Parcel entity — a permanent, scannable identity
--          for every physical package an organization ships. Each parcel has an
--          opaque code (APSA:PCL:v1:<token>) printed as QR and Code 128 on the
--          shipping label. Scanning the code resolves to the parcel (and through
--          it, the order) within the scanning user's organization only.
--
-- Domain owner: Fulfillment (parcels are created during packing, resolved
--               during investigation/delivery).
--
-- V1 rule: one active parcel per order per organization. The schema allows
--          multiple parcels per order in the future (split shipments, returns)
--          by using a partial unique index on (org, order) WHERE status <> 'void'
--          rather than a hard 1:1 constraint.
--
-- Tenant safety:
--   - organization_id FK on every row
--   - Cross-tenant trigger: order must belong to the same org
--   - RLS blocks all direct access (SELECT/INSERT/UPDATE/DELETE)
--   - Table grants: service_role only
--   - The parcel_code index is global (no org prefix) because the code is opaque
--     and scanning does not supply an org — the service filters by org after lookup
--
-- Additive only. No existing table, column, policy, function, or grant is changed.

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE public.parcels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  parcel_code     TEXT NOT NULL CHECK (
    char_length(parcel_code) >= 20 AND char_length(parcel_code) <= 100
  ),
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'void')),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.parcels IS
  'Physical package identity. Each row is one scannable parcel with an opaque, permanent code. V1: one active parcel per order; future: split shipments via multiple parcels per order (migration 050).';

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Global unique on the opaque code — the scan-lookup path.
CREATE UNIQUE INDEX uniq_parcels_code
  ON public.parcels(parcel_code);

-- V1 idempotency: at most one non-void parcel per order within an org.
-- Voiding a parcel allows creating a replacement without violating this.
CREATE UNIQUE INDEX uniq_parcels_org_order_active
  ON public.parcels(organization_id, order_id)
  WHERE status <> 'void';

-- Org-scoped listing (newest first).
CREATE INDEX idx_parcels_org_created
  ON public.parcels(organization_id, created_at DESC);

-- Order-scoped lookup (find parcels for an order).
CREATE INDEX idx_parcels_org_order
  ON public.parcels(organization_id, order_id);

-- ── updated_at trigger ───────────────────────────────────────────────────────

CREATE TRIGGER parcels_set_updated_at
  BEFORE UPDATE ON public.parcels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Cross-tenant integrity ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_parcel_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = NEW.order_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_order: parcel order must belong to organization';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_parcel_cross_tenant_refs() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER parcel_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.parcels
  FOR EACH ROW EXECUTE FUNCTION public.check_parcel_cross_tenant_refs();

-- ── Immutability of parcel_code ──────────────────────────────────────────────
-- A parcel code is permanent. Once written, it must never change — reprinting
-- reuses the same code. This trigger enforces that at the database level.

CREATE OR REPLACE FUNCTION public.check_parcel_code_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.parcel_code IS DISTINCT FROM NEW.parcel_code THEN
    RAISE EXCEPTION 'parcel_code is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_parcel_code_immutable() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER parcel_code_immutable_check
  BEFORE UPDATE ON public.parcels
  FOR EACH ROW EXECUTE FUNCTION public.check_parcel_code_immutable();

-- ── Row Level Security ───────────────────────────────────────────────────────
-- All access is service-role mediated. No direct anon/authenticated access.

ALTER TABLE public.parcels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "parcels_select_blocked" ON public.parcels FOR SELECT USING (false);
CREATE POLICY "parcels_insert_blocked" ON public.parcels FOR INSERT WITH CHECK (false);
CREATE POLICY "parcels_update_blocked" ON public.parcels FOR UPDATE USING (false);
CREATE POLICY "parcels_no_delete"      ON public.parcels FOR DELETE USING (false);

-- ── Table grants ─────────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.parcels FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.parcels TO service_role;

-- ── Permissions ──────────────────────────────────────────────────────────────
-- Two new fulfillment capabilities for parcel identity operations.

INSERT INTO public.permissions (key, description, risk_level) VALUES
  (
    'fulfillment.create_parcel',
    'Create a parcel identity for an order (generates the permanent scannable code)',
    'medium'
  ),
  (
    'fulfillment.scan_parcel',
    'Resolve a scanned parcel code to its order and summary (read-only investigation)',
    'low'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Role grants ──────────────────────────────────────────────────────────────
-- fulfillment.create_parcel: OWNER, MANAGER, CASHIER, SALES (packers)
-- fulfillment.scan_parcel:   all operational roles including CUSTOMER_SERVICE

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_cs_id      UUID;
  v_create_id  UUID;
  v_scan_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'            AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER'          AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER'          AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'            AND organization_id IS NULL;
  SELECT id INTO v_cs_id      FROM public.roles WHERE system_role = 'CUSTOMER_SERVICE' AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- fulfillment.create_parcel — packing staff
  SELECT id INTO v_create_id FROM public.permissions WHERE key = 'fulfillment.create_parcel';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id)
      VALUES (v_role, v_create_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- fulfillment.scan_parcel — all operational roles
  SELECT id INTO v_scan_id FROM public.permissions WHERE key = 'fulfillment.scan_parcel';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id)
      VALUES (v_role, v_scan_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
