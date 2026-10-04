-- 061_browser_table_authority_hardening.sql
--
-- Browser / Database Authority Hardening. Browser roles hold NO direct
-- authority over any APSA relation in `public`. Every business read and write
-- goes through the APSA server (service_role), and the only user-token entry
-- points are the two reviewed SECURITY DEFINER RPCs below.
--
-- WHO IS WHO
--   PUBLIC         every role, including any role created later. No table
--                  authority after this migration.
--   anon           a browser request with no session (PostgREST + anon key).
--                  No table authority.
--   authenticated  a browser request carrying a user JWT. No table authority.
--                  EXECUTE on accept_invitation(text) and
--                  create_organization_for_founder(text,text,text,text,text)
--                  (migrations 041 and 009) is deliberately kept.
--   service_role   the APSA server. UNCHANGED: this file never names it in a
--                  REVOKE, and section 4 aborts the migration if its effective
--                  table privileges differ in any way from before.
--   postgres       owner of every APSA relation and the role APSA migrations
--                  run as. UNCHANGED (an owner's privileges are not affected by
--                  revoking from other grantees).
--
-- WHY
--   * Supabase's older project default granted ALL on every new `public` table
--     to anon and authenticated; its newer default still grants TRUNCATE,
--     REFERENCES, TRIGGER (and MAINTAIN on PostgreSQL 17) to both. The staging
--     privilege audit observed exactly that inheritance (Dxtm). RLS does not
--     govern TRUNCATE, REFERENCES, TRIGGER or MAINTAIN at all, and RLS alone is
--     the only thing between an anon key and a table that still carries
--     SELECT / INSERT / UPDATE / DELETE.
--   * No production code path reads or writes a table as anon or authenticated
--     (src/lib/supabase/client.ts is imported nowhere; the user-scoped server
--     client only validates sessions and calls the two RPCs above). Removing
--     the grants therefore changes no APSA behavior; it removes a bypass.
--
-- WHAT THIS MIGRATION DOES
--   1. REVOKE ALL on each of the 44 relations that migrations 001–060 create
--      in `public` (41 tables, 3 views; there are no sequences, materialized
--      views or foreign tables) FROM PUBLIC, anon, authenticated. The list is
--      explicit so review sees every object; src/tests/
--      browser-table-authority.runtime.ts fails if a relation exists that the
--      list omits. REVOKE on a table also revokes every column-level grant.
--   2. ALTER DEFAULT PRIVILEGES FOR ROLE postgres — in schema public and
--      globally — REVOKE ALL ON TABLES and ON SEQUENCES FROM PUBLIC, anon,
--      authenticated. A table, view or sequence a LATER migration creates
--      therefore starts with no browser authority at all; service_role's own
--      default (if the project has one) is untouched, so later migrations keep
--      stating their service_role grants explicitly, as 037/045/048 do.
--   3. Asserts the result: no relation in `public` holds any table- or
--      column-level privilege for PUBLIC, anon or authenticated, and
--      postgres's default ACLs grant them nothing on tables or sequences. A
--      relation this file did not list but that still carries a browser grant
--      (environment drift) ABORTS the migration with its name — it is never
--      silently left open, and never silently revoked without review.
--   4. Asserts service_role keeps every SELECT / INSERT / UPDATE / DELETE it
--      effectively held on a `public` relation before step 1 — so DML the
--      server held only through PUBLIC, or through membership in anon /
--      authenticated, aborts the migration instead of vanishing. The one
--      exception is the payment ledger's INSERT / UPDATE / DELETE: migration
--      040 revoked those from service_role on purpose, so if an environment
--      handed them back through PUBLIC, removing them restores 040. TRUNCATE,
--      REFERENCES and TRIGGER are not server authority (048 grants none).
--
-- POSTGRESQL VERSIONS
--   Only REVOKE ALL is used — never a privilege keyword. On PostgreSQL 15
--   (no MAINTAIN) and 17+ (MAINTAIN) alike, ALL means every table privilege
--   that server knows. Verified on PostgreSQL 17 (PGlite) by the runtime test.
--   aclexplode() and has_table_privilege() exist in every supported version.
--
-- NOT CHANGED, on purpose
--   * Function EXECUTE. Table privileges and EXECUTE are independent. Every
--     business RPC already revokes EXECUTE from PUBLIC/anon/authenticated
--     (checked per function by the runtime test). Trigger functions keep their
--     PUBLIC EXECUTE (a trigger function cannot be called directly), and the
--     RLS helpers is_active_member_of(uuid) / has_audit_access(uuid) keep theirs
--     so policy evaluation can never break. No ALTER DEFAULT PRIVILEGES ON
--     FUNCTIONS.
--   * RLS. No policy is created, changed or dropped; RLS stays enabled as
--     defense in depth.
--   * Schema USAGE on public (PostgREST needs it to resolve the two RPCs).
--   * Default privileges of roles other than postgres (e.g. supabase_admin):
--     APSA migrations do not create objects as those roles, and postgres cannot
--     alter them.
--
-- ROLLBACK
--   There is deliberately no generic rollback. Re-granting browser authority
--   would reopen the bypass, and the pre-061 ACLs differ between environments
--   (staging was restricted-default; production's live ACLs are NOT verified).
--   If a reviewed direct-table exception is ever needed, it is a NEW migration
--   granting exactly that privilege on exactly that relation to exactly one
--   role — never GRANT ALL, never ON ALL TABLES.
--
-- PRODUCTION
--   Do not apply to production without a live read-only privilege snapshot
--   first (relacl, attacl and pg_default_acl for public, plus service_role's
--   effective privileges). Steps 3 and 4 make an unexpected environment abort
--   the transaction instead of half-applying, but they are a backstop for the
--   preflight, not a replacement for it.

-- ── 0. Record service_role's effective DML before any REVOKE ─────────────────
DROP TABLE IF EXISTS pg_temp.apsa_061_service_role_before;
CREATE TEMP TABLE apsa_061_service_role_before AS
SELECT c.oid AS relid, p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f','S')
  AND CASE WHEN c.relkind = 'S'
           THEN p.privilege = 'SELECT' AND has_sequence_privilege('service_role', c.oid, 'SELECT')
           ELSE has_table_privilege('service_role', c.oid, p.privilege) END
  -- 040: payment ledger writes are RPC-only, never service_role authority
  AND NOT (c.relname IN ('payments','payment_events','payment_evidence')
           AND p.privilege IN ('INSERT','UPDATE','DELETE'));

-- ── 1. Every APSA relation: no browser authority ─────────────────────────────

-- Identity, tenancy and access control (001–008, 041)
REVOKE ALL ON TABLE public.profiles         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organizations    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.workspaces       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.locations        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.roles            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.permissions      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.role_permissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.memberships      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitations      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.audit_logs       FROM PUBLIC, anon, authenticated;

-- Customers (010–016)
REVOKE ALL ON TABLE public.customers                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_identities      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_addresses       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_notes           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_tags            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_tag_assignments FROM PUBLIC, anon, authenticated;

-- Customer returns (056)
REVOKE ALL ON TABLE public.customer_returns       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_return_items  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_return_events FROM PUBLIC, anon, authenticated;

-- Catalogue (017–019)
REVOKE ALL ON TABLE public.product_categories FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.products           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.product_variants   FROM PUBLIC, anon, authenticated;

-- Inventory ledger (021, 053) and its derived view
REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.stock_counts        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inventory_stock     FROM PUBLIC, anon, authenticated;  -- view

-- Orders (023)
REVOKE ALL ON TABLE public.orders                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_items            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_status_history   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_number_sequences FROM PUBLIC, anon, authenticated;

-- Delivery and parcels (027, 050)
REVOKE ALL ON TABLE public.delivery_providers      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.deliveries              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.delivery_status_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.parcels                 FROM PUBLIC, anon, authenticated;

-- Payments (034, 040) and their derived views
REVOKE ALL ON TABLE public.payments                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_events                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_evidence               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_reconciliation_summary FROM PUBLIC, anon, authenticated;  -- view
REVOKE ALL ON TABLE public.order_payment_totals           FROM PUBLIC, anon, authenticated;  -- view

-- Conversations (036, 037) — already closed by 037; restated so the list is complete
REVOKE ALL ON TABLE public.conversations             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.messages                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.conversation_participants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.conversation_read_markers FROM PUBLIC, anon, authenticated;

-- Platform operability (045) — already closed by 045; restated so the list is complete
REVOKE ALL ON TABLE public.rate_limit_buckets     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.webhook_event_receipts FROM PUBLIC, anon, authenticated;

-- ── 2. Future relations created by APSA migrations: no browser authority ─────
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- ── 3 + 4. Post-conditions — abort rather than leave a half-hardened state ───
DO $$
DECLARE
  browser oid[] := ARRAY[
    0::oid,                                           -- PUBLIC
    (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
    (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
  ];
  offenders text;
BEGIN
  -- 3a. no table-level browser privilege on any relation in public
  SELECT string_agg(DISTINCT c.relname, ', ' ORDER BY c.relname) INTO offenders
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','p','v','m','f','S')
    AND a.grantee = ANY (browser);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: browser roles still hold table privileges on: % (unreviewed relation — add it to 061 or explain it)', offenders;
  END IF;

  -- 3b. no column-level browser privilege either
  SELECT string_agg(DISTINCT c.relname || '.' || att.attname, ', ') INTO offenders
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE n.nspname = 'public'
    AND a.grantee = ANY (browser);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: browser roles still hold column privileges on: %', offenders;
  END IF;

  -- 3c. postgres's default ACLs give future tables/sequences nothing for browser roles
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
      AND d.defaclobjtype IN ('r','S')
      AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
      AND a.grantee = ANY (browser)
  ) THEN
    RAISE EXCEPTION '061: default privileges for postgres still grant browser roles table/sequence authority';
  END IF;

  -- 4. service_role keeps every piece of DML it held before step 1
  SELECT string_agg(format('%s %s', b.privilege, b.relid::regclass), ', ') INTO offenders
  FROM apsa_061_service_role_before b
  JOIN pg_class c ON c.oid = b.relid
  WHERE NOT CASE WHEN c.relkind = 'S'
                 THEN has_sequence_privilege('service_role', b.relid, 'SELECT')
                 ELSE has_table_privilege('service_role', b.relid, b.privilege) END;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: service_role lost authority it held before 061 (it held it through PUBLIC, anon or authenticated — grant it to service_role explicitly first): %', offenders;
  END IF;
END
$$;

DROP TABLE pg_temp.apsa_061_service_role_before;
