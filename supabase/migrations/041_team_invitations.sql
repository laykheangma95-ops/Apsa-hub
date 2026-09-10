-- Migration: 041_team_invitations
-- Purpose: Pending staff invitations (email-based), consumed into a real
--          `memberships` row once the invitee has (or creates) an APSA account.
--          Closes the "invitation delivery is missing" gap: memberships.user_id
--          is NOT NULL, so a person without a profile row cannot get a
--          membership directly — this table is the minimal staging area that
--          lets an owner/manager invite someone who has no account yet.
-- Tables: invitations
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: (organization_id, lower(email)) unique WHERE status='pending' (duplicate-invite guard);
--          token_hash unique; (organization_id, status)
-- Constraints: role_id cross-org integrity trigger (mirrors 006_memberships.sql);
--              role_id may never be the system OWNER role — an invitation can
--              never grant ownership (ownership transfer is a separate, not-yet-built,
--              secure workflow per SECURITY.md/PERMISSIONS_MATRIX.md §41)
-- Tenant ownership: organization_id
-- RLS: no direct client SELECT/INSERT/UPDATE/DELETE. Token possession, not RLS,
--      is what proves the right to inspect/accept one invitation — enforced in
--      application code (src/server/team) and the accept_invitation() RPC below,
--      both of which use the service-role or SECURITY DEFINER paths respectively.
-- Rollback: DROP FUNCTION IF EXISTS public.accept_invitation(TEXT);
--           DROP TABLE IF EXISTS public.invitations CASCADE;
--           DROP TYPE IF EXISTS public.invitation_status;
--           DROP FUNCTION IF EXISTS public.check_invitation_role_org_integrity();

CREATE TYPE public.invitation_status AS ENUM ('pending', 'accepted', 'cancelled', 'expired');

CREATE TABLE public.invitations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  role_id               UUID NOT NULL REFERENCES public.roles(id),
  status                public.invitation_status NOT NULL DEFAULT 'pending',
  token_hash            TEXT NOT NULL,
  invited_by            UUID NOT NULL REFERENCES public.profiles(id),
  invited_display_name  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL,
  accepted_at           TIMESTAMPTZ,
  accepted_user_id      UUID REFERENCES public.profiles(id),
  cancelled_at          TIMESTAMPTZ,
  CONSTRAINT invitations_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Only one pending invitation per email per organization at a time — re-inviting
-- the same address while a pending invite exists is handled as a resend
-- (application layer), never as a second row.
CREATE UNIQUE INDEX idx_invitations_org_email_pending
  ON public.invitations(organization_id, lower(email))
  WHERE status = 'pending';

CREATE UNIQUE INDEX idx_invitations_token_hash ON public.invitations(token_hash);
CREATE INDEX idx_invitations_organization_id ON public.invitations(organization_id, status);

-- ── Cross-org + owner-role integrity ─────────────────────────────────────────
-- Mirrors check_membership_role_org_integrity (006_memberships.sql) and adds a
-- second guard specific to invitations: role_id must never resolve to the
-- system OWNER role, since an invitation must never be able to grant ownership.
CREATE OR REPLACE FUNCTION public.check_invitation_role_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = NEW.role_id
      AND (
        r.organization_id IS NULL                     -- system template role
        OR r.organization_id = NEW.organization_id     -- custom role in same org
      )
  ) THEN
    RAISE EXCEPTION 'cross_tenant_violation: role_id must be a system role template or a custom role belonging to the same organization';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = NEW.role_id AND r.system_role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'invalid_invitation_role: an invitation can never grant the OWNER role';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_role_org_integrity
  BEFORE INSERT OR UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.check_invitation_role_org_integrity();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- No direct client access in any direction. Server functions use the
-- service-role client (after AuthorizationContext permission checks) for the
-- owner/manager-facing CRUD, and accept_invitation() below is SECURITY DEFINER
-- so it does not depend on table-level SELECT/UPDATE grants either.
CREATE POLICY "invitations_select_blocked" ON public.invitations FOR SELECT USING (false);
CREATE POLICY "invitations_insert_blocked" ON public.invitations FOR INSERT WITH CHECK (false);
CREATE POLICY "invitations_update_blocked" ON public.invitations FOR UPDATE USING (false);
CREATE POLICY "invitations_delete_blocked" ON public.invitations FOR DELETE USING (false);

-- ── accept_invitation RPC ────────────────────────────────────────────────────
-- Atomic acceptance: verify token + expiry + invited-email match against the
-- AUTHENTICATED caller, then insert the real `memberships` row and mark the
-- invitation consumed, all in one transaction. Mirrors the
-- create_organization_for_founder RPC pattern (009_create_organization_rpc.sql):
-- identity comes from auth.uid() only (never a parameter), SECURITY DEFINER,
-- advisory lock for concurrency safety, explicit REVOKE/GRANT.
--
-- Must be called through a user-scoped client (the caller's own JWT) — never
-- through the service-role client, which would make auth.uid() resolve to
-- NULL and always fail the unauthenticated guard below.
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id     UUID;
  v_user_email  TEXT;
  v_invitation  public.invitations%ROWTYPE;
  v_lock_key    BIGINT;
  v_existing    UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated: auth.uid() is null — caller must be authenticated';
  END IF;

  SELECT email INTO v_user_email FROM public.profiles WHERE id = v_user_id;
  IF v_user_email IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_invitation
  FROM public.invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Advisory lock keyed on the invitation id — serializes concurrent accept
  -- attempts (double-click, two tabs) against the same invitation.
  v_lock_key := ('x' || lpad(substring(v_invitation.id::TEXT, 1, 8), 8, '0'))::BIT(32)::INT;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-read after acquiring the lock: another transaction may have already
  -- consumed this invitation while this one waited.
  SELECT * INTO v_invitation FROM public.invitations WHERE id = v_invitation.id;

  IF v_invitation.status != 'pending' THEN
    RETURN jsonb_build_object('status', 'already_used');
  END IF;

  IF v_invitation.expires_at <= NOW() THEN
    UPDATE public.invitations SET status = 'expired' WHERE id = v_invitation.id;
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  IF lower(v_invitation.email) != lower(v_user_email) THEN
    RETURN jsonb_build_object('status', 'email_mismatch');
  END IF;

  SELECT organization_id INTO v_existing
  FROM public.memberships
  WHERE user_id = v_user_id
    AND organization_id = v_invitation.organization_id
    AND status IN ('active', 'invited')
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.invitations
      SET status = 'accepted', accepted_at = NOW(), accepted_user_id = v_user_id
      WHERE id = v_invitation.id;
    RETURN jsonb_build_object('status', 'already_member', 'org_id', v_invitation.organization_id);
  END IF;

  INSERT INTO public.memberships (user_id, organization_id, role_id, status, invited_by)
  VALUES (v_user_id, v_invitation.organization_id, v_invitation.role_id, 'active', v_invitation.invited_by);

  UPDATE public.invitations
    SET status = 'accepted', accepted_at = NOW(), accepted_user_id = v_user_id
    WHERE id = v_invitation.id;

  RETURN jsonb_build_object('status', 'success', 'org_id', v_invitation.organization_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_invitation(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_invitation(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(TEXT) TO authenticated;
