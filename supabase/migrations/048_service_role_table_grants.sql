-- 048_service_role_table_grants.sql
--
-- WHY THIS EXISTS
--   Migrations 001–036 create their tables and never grant anything to
--   service_role. They rested on Supabase's default privileges for objects the
--   `postgres` role creates in `public`. Those defaults are a property of the
--   hosted project, not of this repository: a project created under Supabase's
--   restricted Data-API defaults (default ACL `Dxtm` — no SELECT/INSERT/UPDATE/
--   DELETE) applies all 47 migrations cleanly and then every server request
--   made with the secret key fails with
--     42501 permission denied for table organizations
--   (found during the fresh-database staging rehearsal). Migrations 024, 037
--   and 045 already made their own objects environment-independent with
--   explicit grants; this migration does the same for everything created
--   before them.
--
-- WHAT IT DOES (additive only — GRANT never removes an existing privilege)
--   * service_role: SELECT, INSERT, UPDATE, DELETE on every base table in
--     `public`; SELECT on every view.
--   * EXCEPT the payment ledger. Migration 040 deliberately revoked
--     INSERT/UPDATE/DELETE on payments, payment_events and payment_evidence
--     from service_role so that payments change only through the
--     record/verify/reverse/refund RPCs. Those three tables receive SELECT
--     only here; re-granting their write privileges would silently undo 040.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No grant to anon or authenticated. Tenant reads by the browser/user-scoped
--     client are a separate, owner-level decision about which tables that client
--     may touch under RLS; widening them here would change the security posture.
--   * No TRUNCATE, REFERENCES or TRIGGER, and no ALTER DEFAULT PRIVILEGES.
--   * No sequences: no table in `public` uses one.
--
-- On a project that already holds the broad defaults this is a no-op.

DO $$
DECLARE
  r RECORD;
  payment_ledger CONSTANT text[] := ARRAY['payments', 'payment_events', 'payment_evidence'];
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v')
    ORDER BY c.relname
  LOOP
    IF r.relkind = 'v' OR r.relname = ANY (payment_ledger) THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', r.relname);
    ELSE
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', r.relname
      );
    END IF;
  END LOOP;
END
$$;
