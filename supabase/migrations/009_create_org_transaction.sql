-- Migration: 009_create_org_transaction
-- Purpose: Atomic organization creation via a single Postgres function.
--          Replaces multiple independent Supabase inserts with a true DB transaction.
-- Function: create_organization_for_founder
-- Safety:
--   - All or nothing — partial state is impossible
--   - Slug uniqueness enforced by DB constraint (not a pre-check race)
--   - No client-controlled IDs: founder_user_id comes from validated auth session server-side
--   - Idempotent on slug collision: raises unique_violation (23505), caller maps to user error
--   - Seeded OWNER role template used (id: 00000000-0000-0000-0000-000000000001)
-- Returns: UUID of the created organization
-- Rollback: DROP FUNCTION public.create_organization_for_founder;

CREATE OR REPLACE FUNCTION public.create_organization_for_founder(
  p_founder_user_id    UUID,
  p_legal_name         TEXT,
  p_slug               TEXT,
  p_display_name       TEXT DEFAULT NULL,
  p_business_type      TEXT DEFAULT NULL,
  p_default_currency   TEXT DEFAULT 'USD',
  p_timezone           TEXT DEFAULT 'Asia/Phnom_Penh'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id           UUID;
  v_workspace_id     UUID;
  v_location_id      UUID;
  v_owner_role_id    UUID  := '00000000-0000-0000-0000-000000000001'; -- system OWNER template
  v_display_name     TEXT;
BEGIN
  -- Validate founder exists in profiles
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_founder_user_id) THEN
    RAISE EXCEPTION 'founder_not_found: user_id % does not exist in profiles', p_founder_user_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Normalise display_name fallback
  v_display_name := COALESCE(NULLIF(TRIM(p_display_name), ''), TRIM(p_legal_name));

  -- ── 1. Create organization ────────────────────────────────────────────────────
  -- DB constraint organizations_slug_unique raises 23505 on collision — caller maps to user error.
  INSERT INTO public.organizations (
    legal_name,
    display_name,
    slug,
    business_type,
    default_currency,
    country,
    timezone,
    status,
    created_by
  ) VALUES (
    TRIM(p_legal_name),
    v_display_name,
    LOWER(TRIM(p_slug)),
    NULLIF(TRIM(p_business_type), ''),
    p_default_currency,
    'KH',
    p_timezone,
    'active',
    p_founder_user_id
  )
  RETURNING id INTO v_org_id;

  -- ── 2. Create OWNER membership for founder ────────────────────────────────────
  INSERT INTO public.memberships (
    user_id,
    organization_id,
    role_id,
    status
  ) VALUES (
    p_founder_user_id,
    v_org_id,
    v_owner_role_id,
    'active'  -- founder is immediately active — no invite required
  );

  -- ── 3. Create default INBOX workspace ────────────────────────────────────────
  INSERT INTO public.workspaces (
    organization_id,
    name,
    type,
    status,
    settings
  ) VALUES (
    v_org_id,
    v_display_name,
    'INBOX',
    'active',
    '{}'
  )
  RETURNING id INTO v_workspace_id;

  -- ── 4. Create default location linked to the workspace ────────────────────────
  INSERT INTO public.locations (
    organization_id,
    workspace_id,
    name,
    type,
    timezone,
    status
  ) VALUES (
    v_org_id,
    v_workspace_id,
    v_display_name,
    'branch',
    p_timezone,
    'active'
  )
  RETURNING id INTO v_location_id;

  -- ── 5. Audit log — org creation ───────────────────────────────────────────────
  INSERT INTO public.audit_logs (
    organization_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    after_json
  ) VALUES (
    v_org_id,
    p_founder_user_id,
    'org.created',
    'organization',
    v_org_id,
    jsonb_build_object(
      'slug',              LOWER(TRIM(p_slug)),
      'legal_name',        TRIM(p_legal_name),
      'display_name',      v_display_name,
      'default_currency',  p_default_currency,
      'workspace_id',      v_workspace_id,
      'location_id',       v_location_id
    )
  );

  RETURN v_org_id;
END;
$$;

-- Revoke public execute — only service role (SECURITY DEFINER owner) can call this.
REVOKE EXECUTE ON FUNCTION public.create_organization_for_founder(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
