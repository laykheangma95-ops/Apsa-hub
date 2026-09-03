-- APSA — Migration Verification Queries
-- File: supabase/verify-migrations.sql
-- Purpose: Run these queries in the Supabase SQL Editor (as service role)
--          to confirm migrations 001–008 were applied correctly.
--
-- Run via: Supabase Dashboard → SQL Editor → New query → paste and execute

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Table existence — one row per table expected after all 8 migrations
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  tablename,
  tableowner
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles',
    'organizations',
    'roles',
    'permissions',
    'role_permissions',
    'workspaces',
    'locations',
    'memberships',
    'audit_logs'
  )
ORDER BY tablename;

-- Expected: 9 rows (one per table)

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RLS enabled — every table must have relrowsecurity = true
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  c.relname   AS table_name,
  c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'profiles',
    'organizations',
    'roles',
    'permissions',
    'role_permissions',
    'workspaces',
    'locations',
    'memberships',
    'audit_logs'
  )
ORDER BY c.relname;

-- Expected: all rows show rls_enabled = true

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS policies count — at least one policy per table
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  schemaname,
  tablename,
  COUNT(*) AS policy_count
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles',
    'organizations',
    'roles',
    'permissions',
    'role_permissions',
    'workspaces',
    'locations',
    'memberships',
    'audit_logs'
  )
GROUP BY schemaname, tablename
ORDER BY tablename;

-- Expected: 9 rows, each with policy_count ≥ 1

-- ────────────────────────────────────────────────────────────────────────────
-- 4. System roles seeded (migration 003)
-- ────────────────────────────────────────────────────────────────────────────
SELECT id, name, system_role
FROM public.roles
WHERE organization_id IS NULL
ORDER BY name;

-- Expected: 5 rows — Customer Service, Manager, Owner, Cashier, Sales

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Permission count (migration 003)
-- ────────────────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS permission_count FROM public.permissions;

-- Expected: 37

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Role↔permission mapping — OWNER should have all 37 permissions
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  r.name AS role,
  r.system_role,
  COUNT(rp.permission_id) AS permission_count
FROM public.roles r
LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
WHERE r.organization_id IS NULL
GROUP BY r.id, r.name, r.system_role
ORDER BY permission_count DESC;

-- Expected:
--   Owner         — 37 permissions
--   Manager       — ~32 permissions
--   Sales         — ~15 permissions
--   Cashier       — ~12 permissions
--   Customer Svc  — ~8 permissions

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Triggers present — key triggers from migrations 001, 005, 006, 008
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  trigger_name,
  event_object_table AS table_name,
  action_timing,
  event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
    'on_auth_user_created',                      -- migration 001
    'set_updated_at_profiles',                   -- migration 001
    'check_location_workspace_org',              -- migration 005
    'check_membership_role_org',                 -- migration 006
    'enforce_last_owner_protection',             -- migration 006
    'audit_logs_no_update',                      -- migration 008
    'audit_logs_no_delete'                       -- migration 008
  )
ORDER BY event_object_table, trigger_name;

-- Note: trigger names may differ slightly from migration file TRIGGER names —
-- check migration files if a trigger is not found.

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Enum types created
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  typname AS enum_name,
  array_agg(enumlabel ORDER BY enumsortorder) AS values
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN (
    'user_status',
    'org_status',
    'workspace_type',
    'location_type',
    'membership_status',
    'system_role_key',
    'risk_level',
    'audit_resource_type'
  )
GROUP BY typname
ORDER BY typname;

-- Expected: 8 enum types

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Supabase migration tracking — if using supabase CLI, this table tracks applied migrations
-- ────────────────────────────────────────────────────────────────────────────
SELECT name, executed_at
FROM supabase_migrations.schema_migrations
ORDER BY executed_at;

-- Note: this table only exists if migrations were applied via `supabase db push`.
-- If applied manually via SQL Editor, this table will be empty or absent — that's OK.

-- ────────────────────────────────────────────────────────────────────────────
-- 10. Audit log append-only guard — confirm UPDATE and DELETE are blocked
-- ────────────────────────────────────────────────────────────────────────────
-- Run this and expect an error:
-- UPDATE public.audit_logs SET action = 'tampered' WHERE id = gen_random_uuid();
-- Expected error: "audit_log_immutable: audit log entries cannot be modified"
--
-- DELETE FROM public.audit_logs WHERE id = gen_random_uuid();
-- Expected error: "audit_log_immutable: audit log entries cannot be deleted"
--
-- These tests must be run manually in the SQL Editor as they are expected to fail.

SELECT 'Migration verification complete. Check results above against expected values.' AS status;
