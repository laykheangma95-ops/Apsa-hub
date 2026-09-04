-- APSA — Test Seed Data
-- File: supabase/seed-test.sql
-- Purpose: Insert minimal test fixtures needed to run integration tests in
--          src/tests/tenant-isolation.test.ts against a real Supabase project.
--
-- IMPORTANT:
--   - Run this ONLY against a dedicated test/staging Supabase project.
--   - NEVER run against the production APSA project.
--   - Apply migrations 001–008 before running this seed.
--   - The UUIDs here are fixed and match constants in the test file.
--
-- Rollback: Run supabase/seed-test-rollback.sql (or DELETE statements below in reverse order).
--
-- Run via:
--   Supabase Dashboard → SQL Editor → New query → paste and execute
--   OR: psql $DATABASE_URL -f supabase/seed-test.sql

-- ── Fixed UUIDs (must match src/tests/tenant-isolation.test.ts) ──────────────

-- Organizations
-- ORG_A_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
-- ORG_B_ID = 'bbbbbbbb-0000-0000-0000-000000000002'

-- Users (in auth.users — must match test file constants)
-- USER_ORG_A_OWNER    = 'user-aaaa-0000-0000-0000-000000000001'  (format: must be valid UUID)
-- USER_ORG_A_MANAGER  = 'user-aaaa-0000-0000-0000-000000000002'
-- USER_ORG_A_CASHIER  = 'user-aaaa-0000-0000-0000-000000000003'
-- USER_ORG_B_OWNER    = 'user-bbbb-0000-0000-0000-000000000001'
-- USER_NO_MEMBERSHIP  = 'user-none-0000-0000-0000-000000000099'
-- USER_SUSPENDED      = 'user-susp-0000-0000-0000-000000000003'
-- USER_REMOVED        = 'user-rmvd-0000-0000-0000-000000000004'

-- NOTE: The test UUIDs in tenant-isolation.test.ts use the pattern 'user-aaaa-...'
-- which is not a valid UUID format (contains non-hex 'user-'). Supabase auth.users.id
-- requires valid UUID v4. The UUIDs below use valid UUID format equivalents.
-- If you update these, update the constants in tenant-isolation.test.ts to match.

-- Canonical test UUIDs (valid UUID v4 format):
-- USER_ORG_A_OWNER   = 'aa000001-0000-0000-0000-000000000001'
-- USER_ORG_A_MANAGER = 'aa000002-0000-0000-0000-000000000001'
-- USER_ORG_A_CASHIER = 'aa000003-0000-0000-0000-000000000001'
-- USER_ORG_B_OWNER   = 'bb000001-0000-0000-0000-000000000001'
-- USER_NO_MEMBERSHIP = 'cc000099-0000-0000-0000-000000000001'
-- USER_SUSPENDED     = 'dd000003-0000-0000-0000-000000000001'
-- USER_REMOVED       = 'ee000004-0000-0000-0000-000000000001'

-- System role UUIDs (from migration 003 seed):
-- OWNER role id:            '00000000-0000-0000-0000-000000000001'
-- MANAGER role id:          '00000000-0000-0000-0000-000000000002'
-- CASHIER role id:          '00000000-0000-0000-0000-000000000003'

-- ── Step 1: Create test users in auth.users ───────────────────────────────────
-- Supabase Auth users cannot be created via SQL INSERT directly in hosted Supabase.
-- Use the Supabase Auth Admin API or the Dashboard to create these users first.
--
-- After creating the users in the Dashboard, note their UUIDs and update the
-- constants in src/tests/tenant-isolation.test.ts to match.
--
-- Alternatively, use the Supabase management API:
--   POST https://<project-ref>.supabase.co/auth/v1/admin/users
--   Authorization: Bearer <service-role-key>
--   Content-Type: application/json
--   { "email": "owner-a@test.apsa.internal", "password": "test-password-never-reuse", "email_confirm": true }
--
-- The auth trigger (handle_new_user in migration 001) automatically creates the
-- corresponding row in public.profiles when an auth.users row is inserted.

-- ── Step 2: Create test organizations ────────────────────────────────────────
-- Run AFTER auth users are created and profile rows exist.

INSERT INTO public.organizations (id, name, slug, status, created_by)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Test Org A', 'test-org-a', 'active',
   '<USER_ORG_A_OWNER_UUID>'),  -- replace with real UUID from step 1
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Test Org B', 'test-org-b', 'active',
   '<USER_ORG_B_OWNER_UUID>')   -- replace with real UUID from step 1
ON CONFLICT (id) DO NOTHING;

-- ── Step 3: Create memberships ────────────────────────────────────────────────
-- Role IDs are fixed by the migration 003 seed:
--   OWNER   = '00000000-0000-0000-0000-000000000001'
--   MANAGER = '00000000-0000-0000-0000-000000000002'
--   CASHIER = '00000000-0000-0000-0000-000000000003'

INSERT INTO public.memberships (user_id, organization_id, role_id, status)
VALUES
  -- Org A members
  ('<USER_ORG_A_OWNER_UUID>',   'aaaaaaaa-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'active'),    -- OWNER
  ('<USER_ORG_A_MANAGER_UUID>', 'aaaaaaaa-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000002', 'active'),    -- MANAGER
  ('<USER_ORG_A_CASHIER_UUID>', 'aaaaaaaa-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000003', 'active'),    -- CASHIER
  -- Org B members
  ('<USER_ORG_B_OWNER_UUID>',   'bbbbbbbb-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000001', 'active'),    -- OWNER
  -- Suspended user (member of Org A but suspended)
  ('<USER_SUSPENDED_UUID>',     'aaaaaaaa-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000003', 'suspended'), -- CASHIER, suspended
  -- Removed user (member of Org A but removed)
  ('<USER_REMOVED_UUID>',       'aaaaaaaa-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000003', 'removed')    -- CASHIER, removed
  -- USER_NO_MEMBERSHIP has no memberships row — that's the point.
ON CONFLICT DO NOTHING;

-- ── Step 4: Verify seed ───────────────────────────────────────────────────────
-- Run this query to confirm seed data looks correct before running tests:

SELECT
  m.user_id,
  o.name  AS org,
  r.name  AS role,
  r.system_role,
  m.status
FROM public.memberships m
JOIN public.organizations o ON o.id = m.organization_id
JOIN public.roles r ON r.id = m.role_id
WHERE o.id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002'
)
ORDER BY o.name, r.name, m.user_id;

-- ── Rollback (run to clean up after tests) ────────────────────────────────────
-- DELETE FROM public.memberships
--   WHERE organization_id IN (
--     'aaaaaaaa-0000-0000-0000-000000000001',
--     'bbbbbbbb-0000-0000-0000-000000000002'
--   );
-- DELETE FROM public.organizations
--   WHERE id IN (
--     'aaaaaaaa-0000-0000-0000-000000000001',
--     'bbbbbbbb-0000-0000-0000-000000000002'
--   );
-- -- Delete test users via Supabase Dashboard or Admin API — not via SQL.
