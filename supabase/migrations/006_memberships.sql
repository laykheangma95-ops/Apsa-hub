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
--      via is_active_member_of() SECURITY DEFINER helper (prevents RLS recursion)
-- NOTE: This migration runs AFTER 003_roles_permissions.sql — roles table exists here.
-- Rollback: DROP TABLE public.memberships CASCADE; DROP TYPE public.membership_status;
--           DROP FUNCTION public.check_membership_role_org_integrity();
--           DROP FUNCTION public.enforce_last_owner_protection();
--           DROP FUNCTION public.is_active_member_of(UUID);

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
--
-- FIX (Blocker 2): COUNT(*) cannot be combined with FOR UPDATE — PostgreSQL rejects
-- aggregate queries with locking clauses. The fix wraps the locking SELECT in a
-- subquery so FOR UPDATE applies to the individual row scan, and COUNT(*) aggregates
-- the subquery result. The pg_advisory_xact_lock() already provides the primary
-- concurrency guard; FOR UPDATE on the subquery adds a secondary row-level lock.

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

  -- FIX (Blocker 2): PostgreSQL rejects "SELECT COUNT(*) ... FOR UPDATE" because
  -- FOR UPDATE cannot be applied to aggregate queries. Wrap the locking row scan
  -- in a subquery; COUNT(*) aggregates the subquery result.
  SELECT COUNT(*) INTO v_other_active_owners
  FROM (
    SELECT id
    FROM public.memberships
    WHERE organization_id = OLD.organization_id
      AND role_id = v_owner_role_id
      AND status = 'active'
      AND id != OLD.id
    FOR UPDATE
  ) locked_owners;

  IF v_other_active_owners = 0 THEN
    RAISE EXCEPTION 'last_owner_protection: cannot demote or deactivate the last active owner of an organization — at least one active owner must remain';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_last_owner_protection
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_owner_protection();

-- ── RLS helper: is_active_member_of ──────────────────────────────────────────
-- FIX (Blocker 1): The "memberships_select_org_roster" policy previously contained
-- a self-referential EXISTS subquery directly on public.memberships.
-- PostgreSQL applies RLS to all tables in a policy's USING expression, including
-- recursive references to the same table — this causes infinite RLS recursion and
-- a PostgreSQL error: "stack depth limit exceeded" or infinite loop.
--
-- The fix: wrap the inner membership check in a SECURITY DEFINER function.
-- SECURITY DEFINER functions run as the function owner (postgres), bypassing RLS
-- on the tables they query. This breaks the recursion: the policy on memberships
-- calls is_active_member_of(), which queries memberships without triggering the
-- memberships RLS policy again.
--
-- The function only returns a boolean and does not expose raw membership rows,
-- so the bypass is scoped and safe.

CREATE OR REPLACE FUNCTION public.is_active_member_of(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_organization_id
      AND user_id = auth.uid()
      AND status = 'active'
  )
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- Users can read their own memberships (to know which orgs they belong to).
CREATE POLICY "memberships_select_own"
  ON public.memberships FOR SELECT
  USING (user_id = auth.uid());

-- Active members of an organization can see the membership roster of that org.
-- FIX (Blocker 1): Uses is_active_member_of() SECURITY DEFINER helper instead of
-- a direct self-referential subquery, preventing PostgreSQL RLS infinite recursion.
CREATE POLICY "memberships_select_org_roster"
  ON public.memberships FOR SELECT
  USING (public.is_active_member_of(organization_id));

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
