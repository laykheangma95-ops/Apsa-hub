-- Migration: 005_locations
-- Purpose: Physical or virtual locations belonging to a workspace/organization
-- Tables: locations
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: organization_id, workspace_id, status
-- Constraints: organization_id FK, workspace_id FK (nullable), type/status enums
--              cross-org workspace integrity trigger (FIX: workspace must belong to same org)
-- Tenant ownership: organization_id
-- RLS: SELECT policy referencing memberships is deferred to 007_rls_deferred_member_policies.sql
-- Rollback: DROP TABLE public.locations CASCADE; DROP TYPE public.location_type; DROP TYPE public.location_status;
--           DROP FUNCTION public.check_location_workspace_org_integrity();

CREATE TYPE public.location_type AS ENUM ('branch', 'warehouse', 'virtual');
CREATE TYPE public.location_status AS ENUM ('active', 'closed');

CREATE TABLE public.locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  type            public.location_type NOT NULL DEFAULT 'branch',
  phone           TEXT,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
  status          public.location_status NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_locations_organization_id ON public.locations(organization_id);
CREATE INDEX idx_locations_workspace_id ON public.locations(workspace_id);
CREATE INDEX idx_locations_status ON public.locations(organization_id, status);

-- ── FIX: Cross-org workspace integrity ───────────────────────────────────────
-- A location's workspace_id must point to a workspace that belongs to the SAME organization.
-- Without this, an attacker could link a location to a workspace in another tenant,
-- creating a cross-tenant data integrity hole.
-- This check cannot be expressed as a simple FK constraint (FK only validates existence,
-- not the combination of organization_id matching). A trigger enforces it at the DB level.

CREATE OR REPLACE FUNCTION public.check_location_workspace_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = NEW.workspace_id
        AND w.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'cross_tenant_violation: workspace_id must belong to the same organization as the location';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER locations_workspace_org_integrity
  BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.check_location_workspace_org_integrity();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- NOTE: The SELECT policy that checks active membership is in 007_rls_deferred_member_policies.sql

CREATE POLICY "locations_write_blocked"
  ON public.locations FOR INSERT
  WITH CHECK (false);

CREATE POLICY "locations_update_blocked"
  ON public.locations FOR UPDATE
  USING (false);

CREATE POLICY "locations_delete_blocked"
  ON public.locations FOR DELETE
  USING (false);
