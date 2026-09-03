-- Migration: 004_workspaces
-- Purpose: Workspace entity — logical grouping within an organization (INBOX vs BUSINESS)
-- Tables: workspaces
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: organization_id, type, status
-- Constraints: organization_id FK, type enum, status enum
-- Tenant ownership: organization_id (must match caller's org in application layer)
-- RLS: SELECT policy referencing memberships is deferred to 007_rls_deferred_member_policies.sql
--      because memberships does not exist yet at this point in the migration sequence.
--      Writes are blocked for JWT clients.
-- Rollback: DROP TABLE public.workspaces CASCADE; DROP TYPE public.workspace_type; DROP TYPE public.workspace_status;

CREATE TYPE public.workspace_type AS ENUM ('INBOX', 'BUSINESS');
CREATE TYPE public.workspace_status AS ENUM ('active', 'archived');

CREATE TABLE public.workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            public.workspace_type NOT NULL,
  status          public.workspace_status NOT NULL DEFAULT 'active',
  settings        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspaces_organization_id ON public.workspaces(organization_id);
CREATE INDEX idx_workspaces_type ON public.workspaces(organization_id, type);
CREATE INDEX idx_workspaces_status ON public.workspaces(organization_id, status);

CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- NOTE: The SELECT policy that checks active membership is in 007_rls_deferred_member_policies.sql
-- because the memberships table does not exist yet when this migration runs.

-- Writes blocked for JWT clients; use service-role key server-side.
CREATE POLICY "workspaces_write_blocked"
  ON public.workspaces FOR INSERT
  WITH CHECK (false);

CREATE POLICY "workspaces_update_blocked"
  ON public.workspaces FOR UPDATE
  USING (false);

CREATE POLICY "workspaces_delete_blocked"
  ON public.workspaces FOR DELETE
  USING (false);
