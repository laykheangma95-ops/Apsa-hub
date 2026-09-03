-- Migration: 006_memberships
-- Purpose: User ↔ Organization membership with role assignment
-- Tables: memberships
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: user_id, organization_id, (user_id, organization_id) unique active
-- Constraints:
--   FK to profiles, organizations, roles
--   status enum
--   cross-org role integrity trigger (role must be system template OR same-org custom role)
--   last-owner protection trigger (cannot demote/deactivate the last active owner)
-- Tenant ownership: organization_id
-- RLS: users can read their own memberships; org active members can list membership roster
-- NOTE: This migration runs AFTER 003_roles_permissions.sql — roles table exists here.
-- Rollback: DROP TABLE public.memberships CASCADE; DROP TYPE public.membership_status;
--           DROP FUNCTION public.check_membership_role_org_integrity();
--           DROP FUNCTION public.enforce_last_owner_protection();

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

-- ── FIX: Cross-org role integrity ────────────────────────────────────────────
-- A membership's role_id must point to EITHER:
--   (A) a system role template (roles.organization_id IS NULL), OR
--   (B) a custom role belonging to the SAME organization as the membership.
-- Without this check, a privileged attacker could assign a custom role from Organization B
-- to a member of Organization A, leaking cross-tenant role mappings.
-- This is enforced at the database level via a trigger, not only in application code.

CREATE OR REPLACE FUNCTION public.check_membership_role_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = NEW.role_id
      AND (
        r.organization_id IS NULL                     -- system template role
        OR r.organization_id = NEW.organization_id    -- custom role in same org
      )
  ) THEN
    RAISE EXCEPTION 'cross_tenant_violation: role_id must be a system role template or a custom role belonging to the same organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_role_org_integrity
  BEFORE INSERT OR UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.check_membership_role_org_integrity();

-- ── FIX: Last-owner protection (database-safe, concurrency-safe) ─────────────
-- Replaces the application-only race-prone count check.
-- This trigger fires BEFORE any UPDATE on memberships.
-- It prevents the last active owner from being:
--   (a) demoted to a non-owner role
--   (b) deactivated / suspended / removed
--
-- Concurrency safety: we acquire an advisory lock keyed on the organization_id before
-- counting, which serializes concurrent ownership mutations for the same org and
-- eliminates the TOCTOU window present in application-level pre-checks.
-- Both concurrent transactions cannot both pass; the second waits, then sees the
-- correct (post-first-commit) owner count.

CREATE OR REPLACE FUNCTION public.enforce_last_owner_protection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_role_id UUID;
  v_was_active_owner BOOLEAN;
  v_will_remain_active_owner BOOLEAN;
  v_other_active_owners INTEGER;
BEGIN
  -- Find the system OWNER role template (organization_id IS NULL).
  SELECT id INTO v_owner_role_id
  FROM public.roles
  WHERE system_role = 'OWNER'
    AND organization_id IS NULL
  LIMIT 1;

  -- No system OWNER role means no constraint to enforce (should not happen in production).
  IF v_owner_role_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Determine if the row WAS an active owner before this update.
  v_was_active_owner := (OLD.role_id = v_owner_role_id AND OLD.status = 'active');

  -- If this row was not previously an active owner, no protection needed.
  IF NOT v_was_active_owner THEN
    RETURN NEW;
  END IF;

  -- Determine if this row WILL still be an active owner after the update.
  v_will_remain_active_owner := (NEW.role_id = v_owner_role_id AND NEW.status = 'active');

  -- If it remains an active owner, no protection needed.
  IF v_will_remain_active_owner THEN
    RETURN NEW;
  END IF;

  -- The row is being demoted or deactivated.
  -- Acquire a transaction-scoped advisory lock on this organization to prevent
  -- concurrent ownership mutations from both passing this check simultaneously.
  -- The lock is automatically released at transaction end (xact_lock).
  PERFORM pg_advisory_xact_lock(
    ('x' || lpad(substring(OLD.organization_id::text, 1, 8), 8, '0'))::bit(32)::int
  );

  -- Count remaining active owners EXCLUDING the current row.
  -- Uses FOR UPDATE to lock competing rows (additional defense against concurrent ops).
  SELECT COUNT(*) INTO v_other_active_owners
  FROM public.memberships
  WHERE organization_id = OLD.organization_id
    AND role_id = v_owner_role_id
    AND status = 'active'
    AND id != OLD.id
  FOR UPDATE;

  IF v_other_active_owners = 0 THEN
    RAISE EXCEPTION 'last_owner_protection: cannot demote or deactivate the last active owner of an organization — at least one active owner must remain';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_last_owner_protection
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_owner_protection();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- Users can read their own memberships (to know which orgs they belong to).
CREATE POLICY "memberships_select_own"
  ON public.memberships FOR SELECT
  USING (user_id = auth.uid());

-- Active members of an organization can see the membership roster of that org.
-- Note: the self-referential EXISTS subquery is safe — it is filtered by user_id = auth.uid()
-- which matches the memberships_select_own policy, preventing infinite recursion.
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
