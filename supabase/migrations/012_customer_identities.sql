-- Migration: 012_customer_identities
-- Purpose: Social/channel identity records linking a Customer to a provider account.
-- Tables: customer_identities
-- Classification: tenant-private (scoped to organization_id)
-- Key invariant: (organization_id, provider, provider_user_id) is UNIQUE — one customer
--   per provider account per org. Cross-provider: same person may have multiple rows.
--   Never auto-merge on weak signals; identity resolution is explicit and audited.
-- Providers: FACEBOOK, INSTAGRAM, TELEGRAM, TIKTOK, PHONE, EMAIL, APSA_CONSUMER, MINI_STORE
-- Rollback: DROP TABLE public.customer_identities CASCADE; DROP TYPE public.identity_provider;

-- ── provider enum ────────────────────────────────────────────────────────────

CREATE TYPE public.identity_provider AS ENUM (
  'FACEBOOK',
  'INSTAGRAM',
  'TELEGRAM',
  'TIKTOK',
  'PHONE',
  'EMAIL',
  'APSA_CONSUMER',
  'MINI_STORE'
);

-- ── customer_identities ───────────────────────────────────────────────────────

CREATE TABLE public.customer_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  provider          public.identity_provider NOT NULL,
  provider_user_id  TEXT NOT NULL CHECK (length(trim(provider_user_id)) > 0),
  handle            TEXT,
  display_name      TEXT,
  identity_metadata JSONB,
  confidence        SMALLINT NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Critical uniqueness constraint ───────────────────────────────────────────
-- One provider account can only belong to one customer per organization.
-- This prevents duplicate linking and forces explicit merge for ambiguous cases.
CREATE UNIQUE INDEX idx_customer_identities_provider_unique
  ON public.customer_identities(organization_id, provider, provider_user_id);

-- ── Additional indexes ────────────────────────────────────────────────────────

CREATE INDEX idx_customer_identities_customer_id
  ON public.customer_identities(customer_id);

CREATE INDEX idx_customer_identities_org_provider
  ON public.customer_identities(organization_id, provider);

-- ── org_id consistency trigger ────────────────────────────────────────────────
-- Prevent customer_identity from referencing a customer that belongs to a
-- different organization. Defense-in-depth beyond the application layer.

CREATE OR REPLACE FUNCTION public.check_customer_identity_org_integrity()
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

CREATE TRIGGER check_customer_identity_org
  BEFORE INSERT OR UPDATE ON public.customer_identities
  FOR EACH ROW EXECUTE FUNCTION public.check_customer_identity_org_integrity();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.customer_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_identities_select_member"
  ON public.customer_identities FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "customer_identities_insert_member"
  ON public.customer_identities FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_identities_update_member"
  ON public.customer_identities FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_identities_delete_member"
  ON public.customer_identities FOR DELETE
  USING (public.is_active_member_of(organization_id));
