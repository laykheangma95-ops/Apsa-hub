-- Migration: 004_locations
-- Purpose: Physical or virtual locations belonging to a workspace/organization
-- Tables: locations
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: organization_id, workspace_id, status
-- Constraints: organization_id FK, workspace_id FK (nullable), type/status enums
-- Tenant ownership: organization_id
-- RLS: active org members can read; writes via service role only
-- Rollback: DROP TABLE public.locations CASCADE; DROP TYPE ...;

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

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "locations_select_member"
  ON public.locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = locations.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

CREATE POLICY "locations_write_blocked"
  ON public.locations FOR INSERT
  WITH CHECK (false);

CREATE POLICY "locations_update_blocked"
  ON public.locations FOR UPDATE
  USING (false);

CREATE POLICY "locations_delete_blocked"
  ON public.locations FOR DELETE
  USING (false);
