-- Migration: 009_create_organization_rpc
-- Purpose: Atomic organization creation RPC for the founder onboarding flow.
--
-- Security design:
--   - Founder identity derived exclusively from auth.uid() — never accepted as a parameter.
--   - Anonymous callers (auth.uid() IS NULL) are rejected before any data access.
--   - REVOKE EXECUTE FROM PUBLIC + anon; GRANT EXECUTE TO authenticated.
--   - SECURITY DEFINER with SET search_path = public, auth (prevents search_path injection).
--   - One PostgreSQL transaction: advisory lock → membership check → org insert → membership insert.
--   - Advisory lock derived from founder UUID prevents concurrent same-founder races.
--   - Duplicate onboarding by same founder returns deterministic already_member (not slug_taken).
--   - Slug uniqueness enforced by DB constraint (organizations_slug_unique), not a pre-check SELECT.
--   - PG error 23505 (unique_violation) on slug → mapped to slug_taken result.
--
-- Rollback: DROP FUNCTION IF EXISTS public.create_organization_for_founder(TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.create_organization_for_founder(
  p_legal_name    TEXT,
  p_display_name  TEXT,
  p_slug          TEXT,
  p_business_type TEXT    DEFAULT NULL,
  p_currency      TEXT    DEFAULT 'USD'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_founder_id    UUID;
  v_owner_role_id UUID;
  v_org_id        UUID;
  v_existing_org  UUID;
  v_lock_key      BIGINT;
BEGIN
  -- 1. Derive founder identity from JWT — never from parameters.
  v_founder_id := auth.uid();
  IF v_founder_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated: auth.uid() is null — caller must be authenticated';
  END IF;

  -- 2. Acquire transaction-scoped advisory lock keyed on founder UUID.
  --    Serializes concurrent onboarding requests from the same user.
  --    Lock is automatically released when the transaction ends.
  v_lock_key := ('x' || lpad(substring(v_founder_id::TEXT, 1, 8), 8, '0'))::BIT(32)::INT;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 3. After the lock: check for existing active membership.
  --    If the founder already belongs to an org, return deterministic already_member.
  SELECT m.organization_id INTO v_existing_org
  FROM public.memberships m
  WHERE m.user_id = v_founder_id
    AND m.status = 'active'
  LIMIT 1;

  IF v_existing_org IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status',  'already_member',
      'org_id',  v_existing_org
    );
  END IF;

  -- 4. Resolve the system OWNER role template (must exist from migration 003).
  SELECT id INTO v_owner_role_id
  FROM public.roles
  WHERE system_role = 'OWNER'
    AND organization_id IS NULL
  LIMIT 1;

  IF v_owner_role_id IS NULL THEN
    RAISE EXCEPTION 'internal_error: OWNER system role not found — run migration 003 first';
  END IF;

  -- 5. Insert the organization.
  --    Slug uniqueness is enforced by DB constraint organizations_slug_unique (migration 002).
  --    If two different founders race to claim the same slug, the loser gets a 23505 error
  --    which we catch below and map to slug_taken.
  BEGIN
    INSERT INTO public.organizations (
      legal_name,
      display_name,
      slug,
      business_type,
      default_currency,
      created_by
    ) VALUES (
      p_legal_name,
      p_display_name,
      p_slug,
      p_business_type,
      p_currency,
      v_founder_id
    )
    RETURNING id INTO v_org_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- PG 23505 on organizations_slug_unique → slug already taken by another org.
      RETURN jsonb_build_object('status', 'slug_taken');
    WHEN check_violation THEN
      -- DB check constraint (slug_format, currency, etc.) violated.
      RETURN jsonb_build_object('status', 'invalid_input', 'detail', SQLERRM);
  END;

  -- 6. Insert the founder's OWNER membership (active immediately — no invite step).
  INSERT INTO public.memberships (
    user_id,
    organization_id,
    role_id,
    status
  ) VALUES (
    v_founder_id,
    v_org_id,
    v_owner_role_id,
    'active'
  );

  RETURN jsonb_build_object(
    'status',  'success',
    'org_id',  v_org_id,
    'slug',    p_slug
  );
END;
$$;

-- Grant execute to authenticated role only.
-- Anonymous callers are already rejected by the auth.uid() IS NULL guard,
-- but explicit REVOKE + GRANT makes the privilege boundary unambiguous.
REVOKE EXECUTE ON FUNCTION public.create_organization_for_founder(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_organization_for_founder(TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_organization_for_founder(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
