-- Migration: 002_organizations
-- Purpose: Core organization entity — the root of multi-tenancy
-- Tables: organizations
-- Classification: tenant-private (each org is isolated)
-- Indexes: slug (unique lookup), created_by, status
-- Constraints: slug unique, status enum, created_by FK to auth.users
-- Tenant ownership: IS the tenant root; no parent organization_id
-- RLS: only active members of an organization can see it
-- Rollback: DROP TABLE public.organizations CASCADE; DROP TYPE public.organization_status;

CREATE TYPE public.organization_status AS ENUM ('active', 'suspended', 'deleted');

CREATE TABLE public.organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name       TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  slug             TEXT NOT NULL,
  business_type    TEXT,
  default_currency TEXT NOT NULL DEFAULT 'USD' CHECK (default_currency IN ('USD', 'KHR')),
  country          TEXT NOT NULL DEFAULT 'KH',
  timezone         TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
  status           public.organization_status NOT NULL DEFAULT 'active',
  created_by       UUID NOT NULL REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organizations_slug_unique UNIQUE (slug),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$')
);

CREATE INDEX idx_organizations_slug ON public.organizations(slug);
CREATE INDEX idx_organizations_created_by ON public.organizations(created_by);
CREATE INDEX idx_organizations_status ON public.organizations(status);

CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Only active members of the organization can see it.
-- Application layer enforces the full authorization chain; RLS is defense-in-depth.
CREATE POLICY "organizations_select_member"
  ON public.organizations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- Only service-role (server) can insert/update/delete organizations.
-- Application code never allows client to write directly.
CREATE POLICY "organizations_insert_service_role"
  ON public.organizations FOR INSERT
  WITH CHECK (false); -- blocked for all JWT-authenticated clients; use service role

CREATE POLICY "organizations_update_service_role"
  ON public.organizations FOR UPDATE
  USING (false);

CREATE POLICY "organizations_delete_service_role"
  ON public.organizations FOR DELETE
  USING (false);
