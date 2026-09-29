-- 048_service_role_table_grants.sql
--
-- WHY THIS EXISTS
--   Migrations 001–036 create their tables and never state which privileges
--   service_role holds on them. They rested on the Supabase project's DEFAULT
--   PRIVILEGES for objects the `postgres` role creates in `public`. Those
--   defaults belong to the hosted project, not to this repository. A project
--   created under Supabase's restricted defaults (default table ACL `Dxtm`:
--   no SELECT / INSERT / UPDATE / DELETE) applies all 47 migrations cleanly and
--   then every server request that uses the secret key fails with
--     42501 permission denied for table organizations
--   (found in the fresh-database staging rehearsal).
--
-- HOW THE THREE GATES DIFFER (they are independent; a request needs all that apply)
--   * Table privileges (GRANT/REVOKE on a table or view): decide whether a role
--     may touch the object at all. THIS migration is only about these.
--   * Row-level security: decides which rows. service_role has BYPASSRLS, so RLS
--     does not restrict it; nothing here enables, disables or changes any policy.
--   * Function EXECUTE grants: decide which RPCs a role may call. Migrations 024,
--     026, 027, 030, 035 and later make EXECUTE explicit for service_role. That is
--     precedent for function grants, NOT for table grants, and it changes nothing
--     about table privileges: a SECURITY DEFINER function runs as its owner, but a
--     SECURITY INVOKER function or trigger runs with the caller's table
--     privileges, so service_role needs them on what those read.
--   Only migrations 037, 040 and 045 grant table privileges to service_role today.
--
-- SCOPE: an explicit, reviewed allowlist. There is deliberately no catalog loop
-- (no pg_class / pg_tables / information_schema scan, no GRANT ... ON ALL TABLES):
-- a table created by any later migration receives nothing from this file and must
-- state its own grants, as 037 and 045 do.
--
-- EVIDENCE for each grant (repository at migration 047):
--   * "code"   — src/server/** and src/api/** issue that operation through the
--                service-role client (supabaseAdmin) on that table.
--   * "trigger"— a SECURITY INVOKER trigger/function reads it while service_role
--                writes another table, so SELECT is required there too.
--   * "verify" — SELECT only, read by scripts/verify-staging.ts (schema-parity
--                probe of every migration table). No server code path reads it.
--                Drop these two lines if staging verification is not wanted.
--
-- NOT GRANTED, on purpose
--   * anon: nothing. authenticated: nothing new. No production server path reads
--     or writes a business table as authenticated (the user-scoped client only
--     validates the session; membership/profile/org reads are service-role).
--   * payments, payment_events, payment_evidence: SELECT only. Migration 040
--     revoked INSERT/UPDATE/DELETE/TRUNCATE from service_role so payments change
--     only through record/verify/reverse/refund_payment_v1. Not re-opened here.
--   * conversations, messages, conversation_read_markers, conversation_participants:
--     already explicit in 037.  order_payment_totals: already explicit in 040.
--     rate_limit_buckets, webhook_event_receipts: already explicit in 045
--     (webhook_event_receipts is SELECT, INSERT, DELETE — never UPDATE).
--   * TRUNCATE / REFERENCES / TRIGGER on anything. No sequences (no table here
--     owns one). No ALTER DEFAULT PRIVILEGES.
--
-- Additive: GRANT never removes a privilege. Re-running it is a no-op. Where the
-- project already holds broad defaults it changes nothing observable.

-- ── Identity, tenancy and access-control reads ───────────────────────────────
GRANT SELECT         ON public.permissions      TO service_role;  -- code
GRANT SELECT         ON public.role_permissions TO service_role;  -- code
GRANT SELECT         ON public.roles            TO service_role;  -- code, trigger
GRANT SELECT         ON public.profiles         TO service_role;  -- code
GRANT SELECT, UPDATE ON public.organizations    TO service_role;  -- code (org profile update)
GRANT SELECT, UPDATE ON public.memberships      TO service_role;  -- code (team role/status), trigger
GRANT SELECT, INSERT, UPDATE ON public.invitations TO service_role;  -- code
GRANT SELECT         ON public.workspaces       TO service_role;  -- verify
GRANT SELECT         ON public.locations        TO service_role;  -- code

-- ── Audit trail (append-only: UPDATE/DELETE are blocked by trigger anyway) ───
GRANT SELECT, INSERT ON public.audit_logs       TO service_role;  -- code (audit.ts insert)

-- ── Customers ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON public.customers            TO service_role;  -- code
GRANT SELECT, INSERT, DELETE ON public.customer_identities  TO service_role;  -- code
GRANT SELECT, INSERT         ON public.customer_notes       TO service_role;  -- code
GRANT SELECT, INSERT         ON public.customer_tags        TO service_role;  -- code
GRANT SELECT, INSERT, DELETE ON public.customer_tag_assignments TO service_role;  -- code
GRANT SELECT                 ON public.customer_addresses   TO service_role;  -- code

-- ── Catalogue ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON public.product_categories TO service_role;  -- code
GRANT SELECT, INSERT, UPDATE ON public.products           TO service_role;  -- code
GRANT SELECT, INSERT, UPDATE ON public.product_variants   TO service_role;  -- code

-- ── Inventory ledger (append-only; stock is derived, never stored) ───────────
GRANT SELECT, INSERT ON public.inventory_movements TO service_role;  -- code
GRANT SELECT         ON public.inventory_stock     TO service_role;  -- code (view)

-- ── Orders (all writes go through the SECURITY DEFINER order RPCs) ───────────
GRANT SELECT ON public.orders                 TO service_role;  -- code
GRANT SELECT ON public.order_items            TO service_role;  -- code
GRANT SELECT ON public.order_status_history   TO service_role;  -- code
GRANT SELECT ON public.order_number_sequences TO service_role;  -- verify (allocated only inside a DEFINER RPC)

-- ── Delivery / fulfillment reads (writes go through RPCs) ────────────────────
GRANT SELECT ON public.deliveries              TO service_role;  -- code
GRANT SELECT ON public.delivery_providers      TO service_role;  -- code
GRANT SELECT ON public.delivery_status_history TO service_role;  -- code

-- ── Payments: READ ONLY. See 040 — mutations are RPC-only. ───────────────────
GRANT SELECT ON public.payments                       TO service_role;  -- code
GRANT SELECT ON public.payment_events                 TO service_role;  -- code
GRANT SELECT ON public.payment_evidence               TO service_role;  -- code
GRANT SELECT ON public.payment_reconciliation_summary TO service_role;  -- code (view)
