-- Migration: 015_customer_addresses
-- Purpose: Cambodian-first delivery / contact addresses for customers.
-- Tables: customer_addresses
-- Classification: tenant-private (scoped to organization_id)
-- Cambodian address fields (sangkat, khan) are first-class, not crammed into generic fields.
-- Rollback: DROP TABLE public.customer_addresses CASCADE;

CREATE TABLE public.customer_addresses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  label            TEXT,
  house_no         TEXT,
  street           TEXT,
  sangkat          TEXT,
  khan             TEXT,
  city             TEXT,
  province         TEXT,
  country          TEXT NOT NULL DEFAULT 'KH',
  landmark         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_customer_addresses_customer_id
  ON public.customer_addresses(customer_id);

CREATE INDEX idx_customer_addresses_organization_id
  ON public.customer_addresses(organization_id);

-- ── org consistency trigger ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_customer_address_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = NEW.customer_id
      AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_violation: customer_id must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_customer_address_org
  BEFORE INSERT OR UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.check_customer_address_org_integrity();

CREATE TRIGGER customer_addresses_set_updated_at
  BEFORE UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_addresses_select_member"
  ON public.customer_addresses FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "customer_addresses_insert_member"
  ON public.customer_addresses FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_addresses_update_member"
  ON public.customer_addresses FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_addresses_delete_member"
  ON public.customer_addresses FOR DELETE
  USING (public.is_active_member_of(organization_id));
