-- Migration: 011_customers
-- Purpose: Customer entity — the first real merchant business record in APSA.
-- Tables: customers
-- Classification: tenant-private (scoped to organization_id)
-- RLS: all operations require active membership in the customer's organization
-- Tenant ownership: organization_id (server-enforced, never trusted from client)
-- Rollback: DROP TABLE public.customers CASCADE; DROP TYPE public.customer_status;

-- ── customers ─────────────────────────────────────────────────────────────────

CREATE TYPE public.customer_status AS ENUM ('active', 'archived');

CREATE TABLE public.customers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  primary_phone    TEXT,
  primary_email    TEXT,
  status           public.customer_status NOT NULL DEFAULT 'active',
  language         TEXT,
  first_seen_at    TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_customers_organization_id ON public.customers(organization_id);
CREATE INDEX idx_customers_org_status      ON public.customers(organization_id, status);
CREATE INDEX idx_customers_primary_phone   ON public.customers(organization_id, primary_phone)
  WHERE primary_phone IS NOT NULL;
CREATE INDEX idx_customers_primary_email   ON public.customers(organization_id, primary_email)
  WHERE primary_email IS NOT NULL;
CREATE INDEX idx_customers_created_at      ON public.customers(organization_id, created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- Active members of the organization can read its customers.
CREATE POLICY "customers_select_member"
  ON public.customers FOR SELECT
  USING (public.is_active_member_of(organization_id));

-- Active members can create customers for their own organization.
-- organization_id must equal an org the user is an active member of.
CREATE POLICY "customers_insert_member"
  ON public.customers FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Active members can update customers in their own organization.
CREATE POLICY "customers_update_member"
  ON public.customers FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

-- Only active members can archive (soft-delete) customers in their organization.
-- Hard DELETE is not permitted via RLS — only status = 'archived' is the pattern.
CREATE POLICY "customers_no_delete"
  ON public.customers FOR DELETE
  USING (false);
