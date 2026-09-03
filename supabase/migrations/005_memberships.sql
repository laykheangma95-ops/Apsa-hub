-- Migration: 005_memberships
-- Purpose: User ↔ Organization membership with role assignment
-- Tables: memberships
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: user_id, organization_id, (user_id, organization_id) unique active
-- Constraints: FK to profiles, organizations, roles; status enum
-- Tenant ownership: organization_id
-- RLS: users can read their own memberships; org active members can list membership roster
-- Rollback: DROP TABLE public.memberships CASCADE; DROP TYPE ...;

CREATE TYPE public.membership_status AS ENUM ('active', 'invited', 'suspended', 'removed');

CREATE TABLE public.memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id         UUID NOT NULL REFERENCES public.roles(id),
  status          public.membership_status NOT NULL DEFAULT 'invited',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by      UUID REFERENCES public.profiles(id)
);

-- A user can only have ONE active or invited membership per organization.
CREATE UNIQUE INDEX idx_memberships_user_org_active
  ON public.memberships(user_id, organization_id)
  WHERE status IN ('active', 'invited');

CREATE INDEX idx_memberships_user_id ON public.memberships(user_id);
CREATE INDEX idx_memberships_organization_id ON public.memberships(organization_id);
CREATE INDEX idx_memberships_status ON public.memberships(organization_id, status);
CREATE INDEX idx_memberships_role_id ON public.memberships(role_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- Users can read their own memberships (to know which orgs they belong to).
CREATE POLICY "memberships_select_own"
  ON public.memberships FOR SELECT
  USING (user_id = auth.uid());

-- Active members of an organization can see the membership roster of that org.
CREATE POLICY "memberships_select_org_roster"
  ON public.memberships FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m2
      WHERE m2.organization_id = memberships.organization_id
        AND m2.user_id = auth.uid()
        AND m2.status = 'active'
    )
  );

-- Writes blocked for JWT clients — application server manages membership lifecycle.
CREATE POLICY "memberships_write_blocked"
  ON public.memberships FOR INSERT
  WITH CHECK (false);

CREATE POLICY "memberships_update_blocked"
  ON public.memberships FOR UPDATE
  USING (false);

CREATE POLICY "memberships_delete_blocked"
  ON public.memberships FOR DELETE
  USING (false);
