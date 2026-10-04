-- 061_browser_table_authority_hardening.sql
--
-- Browser / Database Authority Hardening. Browser roles hold NO authority over
-- any APSA relation in `public` — not directly, not through PUBLIC, and not
-- through membership in another role. Every business read and write goes
-- through the APSA server (service_role), and the only user-token entry points
-- are the two reviewed SECURITY DEFINER RPCs below.
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
--   browser-reachable roles
--                  anon, authenticated, and every role either is a member of,
--                  at any depth (pg_auth_members, followed from member to
--                  role). Any membership edge counts — whatever its INHERIT or
--                  SET option — because a member that cannot inherit a role's
--                  privileges may still SET ROLE to it. Conservative on purpose.
--   service_role   the APSA server. This file never names it in a REVOKE, and
--                  step 5 aborts the migration if it would lose any working
--                  table, column or sequence authority.
--   postgres       owner of every APSA relation and the role APSA migrations
--                  run as (`supabase db push`; docs/RELEASE_CHECKLIST.md).
--                  UNCHANGED (revoking from other grantees never touches an
--                  owner's privileges).
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
--   0. Records the browser-reachable roles and service_role's effective
--      authority (table SELECT/INSERT/UPDATE/DELETE, column SELECT/INSERT/
--      UPDATE, sequence USAGE/SELECT/UPDATE) before anything changes.
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
--   3. Creator boundary: aborts unless it runs as postgres and postgres owns
--      every relation in `public` — otherwise some other role is creating
--      APSA relations, and step 2 hardened the wrong role's defaults.
--   4. Asserts EFFECTIVE browser authority is gone: for every browser-
--      reachable role, has_table_privilege / has_column_privilege /
--      has_sequence_privilege (which include PUBLIC and inheritance) must be
--      false for every privilege the server knows, on every relation in
--      `public`, listed or not; and no postgres default ACL (global or public)
--      may grant tables/sequences to PUBLIC or to a browser-reachable role.
--      061 removes only DIRECT grants to PUBLIC/anon/authenticated. Authority
--      that remains — on an unlisted relation, or through another role's
--      grant or membership — ABORTS the migration with the role, privilege and
--      relation named. 061 never revokes from an arbitrary role and never
--      pretends such authority was repaired.
--   5. Asserts service_role keeps every piece of authority recorded in step 0
--      — so authority the server held only through PUBLIC, column grants or
--      membership in a browser role aborts the migration instead of
--      vanishing. The one exception is the payment ledger's INSERT / UPDATE /
--      DELETE: migration 040 revoked those from service_role on purpose, so if
--      an environment handed them back through PUBLIC, removing them restores
--      040. TRUNCATE, REFERENCES and TRIGGER are not server authority (048
--      grants none).
--   Default ACLs of OTHER creator roles (e.g. Supabase's supabase_admin) that
--   reach browser roles are reported with RAISE WARNING, not revoked: postgres
--   cannot alter them, and step 3 guarantees no APSA relation is created by
--   such a role. They are part of the production preflight.
--
-- POSTGRESQL VERSIONS
--   Only REVOKE ALL is used — never a privilege keyword in DDL. On PostgreSQL
--   15 (no MAINTAIN) and 17+ (MAINTAIN) alike, ALL means every table privilege
--   that server knows. The step-4 check asks about 'MAINTAIN' only when
--   server_version_num >= 170000. Verified on PostgreSQL 17 (PGlite) by the
--   runtime test; aclexplode() and the has_*_privilege() functions with oid
--   arguments exist in every supported version.
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
--   * Role memberships and grants to roles other than PUBLIC/anon/
--     authenticated: reported (step 4 aborts), never altered.
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
--   first (relacl, attacl and pg_default_acl for public, pg_auth_members
--   reachable from anon/authenticated, relation owners, plus service_role's
--   effective privileges). Steps 3–5 make an unexpected environment abort the
--   transaction instead of half-applying, but they are a backstop for the
--   preflight, not a replacement for it.

-- ── 0a. Browser-reachable roles: anon, authenticated, and every role they are
--        members of, at any depth ────────────────────────────────────────────
DROP TABLE IF EXISTS pg_temp.apsa_061_browser_roles;
CREATE TEMP TABLE apsa_061_browser_roles AS
WITH RECURSIVE reach(roleid) AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  UNION
  SELECT m.roleid FROM pg_auth_members m JOIN reach r ON m.member = r.roleid
)
SELECT roleid FROM reach;

-- ── 0b. service_role's effective authority before any REVOKE ─────────────────
--        (attnum 0 = the table / sequence itself)
DROP TABLE IF EXISTS pg_temp.apsa_061_service_role_before;
CREATE TEMP TABLE apsa_061_service_role_before AS
SELECT c.oid AS relid, 0::smallint AS attnum, p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f')
  AND has_table_privilege('service_role', c.oid, p.privilege)
  -- 040: payment ledger writes are RPC-only, never service_role authority
  AND NOT (c.relname IN ('payments','payment_events','payment_evidence')
           AND p.privilege IN ('INSERT','UPDATE','DELETE'))
UNION ALL
SELECT c.oid, a.attnum, p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) AS p(privilege)
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f')
  AND has_column_privilege('service_role', c.oid, a.attnum, p.privilege)
  AND NOT (c.relname IN ('payments','payment_events','payment_evidence')
           AND p.privilege IN ('INSERT','UPDATE'))
UNION ALL
SELECT c.oid, 0::smallint, p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p(privilege)
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
  AND has_sequence_privilege('service_role', c.oid, p.privilege);

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


-- ── 3–5. Post-conditions — abort rather than leave a half-hardened state ─────
DO $$
DECLARE
  postgres_oid CONSTANT oid := (SELECT oid FROM pg_roles WHERE rolname = 'postgres');
  table_privs CONSTANT text[] :=
    ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
    || CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  offenders text;
BEGIN
  -- 3. creator boundary: postgres runs this and owns every relation in public
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION '061: must run as postgres, the role that creates APSA relations (running as %)', current_user;
  END IF;
  SELECT string_agg(format('%s (owner %s)', c.oid::regclass, c.relowner::regrole), ', ' ORDER BY c.relname)
    INTO offenders
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','p','v','m','f','S')
    AND c.relowner <> postgres_oid;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: relations in public not owned by postgres — their creator''s default privileges are not hardened by 061: %', offenders;
  END IF;

  -- 4a. EFFECTIVE browser authority on every relation, column and sequence in
  --     public, for every browser-reachable role (has_*_privilege includes
  --     PUBLIC and inherited grants; membership depth is covered by 0a)
  SELECT string_agg(x, '; ') INTO offenders
  FROM (
    SELECT x FROM (
      SELECT format('%s %s on %s', b.roleid::regrole, p.priv, c.oid::regclass) AS x
      FROM apsa_061_browser_roles b
      CROSS JOIN pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(table_privs) AS p(priv)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege(b.roleid, c.oid, p.priv)
      UNION
      SELECT format('%s %s on %s.%s', b.roleid::regrole, p.priv, c.oid::regclass, a.attname)
      FROM apsa_061_browser_roles b
      CROSS JOIN pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p','v','m','f')
        AND has_column_privilege(b.roleid, c.oid, a.attnum, p.priv)
      UNION
      SELECT format('%s %s on sequence %s', b.roleid::regrole, p.priv, c.oid::regclass)
      FROM apsa_061_browser_roles b
      CROSS JOIN pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p(priv)
      WHERE n.nspname = 'public'
        AND c.relkind = 'S'
        AND has_sequence_privilege(b.roleid, c.oid, p.priv)
    ) all_offenders
    ORDER BY x
    LIMIT 40
  ) shown;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: browser authority remains (direct, through PUBLIC, or through role membership): %. 061 revokes only direct PUBLIC/anon/authenticated grants on the listed relations; remove this grant or membership after review, then re-run.', offenders;
  END IF;

  -- 4b. postgres's default ACLs give future tables/sequences nothing that a
  --     browser role can reach
  SELECT string_agg(DISTINCT format('%s/%s: %s %s',
           CASE d.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
           d.defaclobjtype::text,
           CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
           a.privilege_type), '; ')
    INTO offenders
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = postgres_oid
    AND d.defaclobjtype IN ('r','S')
    AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
    AND (a.grantee = 0 OR a.grantee IN (SELECT roleid FROM apsa_061_browser_roles));
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: default privileges for postgres still give future tables/sequences to browser-reachable roles: %', offenders;
  END IF;

  -- 4c. other creators' defaults: reported, not revoked (see header)
  SELECT string_agg(DISTINCT format('%s %s/%s: %s %s', d.defaclrole::regrole,
           CASE d.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
           d.defaclobjtype::text,
           CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
           a.privilege_type), '; ')
    INTO offenders
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole <> postgres_oid
    AND d.defaclobjtype IN ('r','S')
    AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
    AND (a.grantee = 0 OR a.grantee IN (SELECT roleid FROM apsa_061_browser_roles));
  IF offenders IS NOT NULL THEN
    RAISE WARNING '061: roles other than postgres have default privileges reaching browser roles (objects THEY create are not covered by 061; no APSA relation is owned by them): %', offenders;
  END IF;

  -- 5. service_role keeps every piece of authority recorded in 0b
  SELECT string_agg(x, ', ') INTO offenders
  FROM (
    SELECT CASE WHEN b.attnum = 0 THEN format('%s %s', b.privilege, b.relid::regclass)
                ELSE format('%s %s.%s', b.privilege, b.relid::regclass, a.attname) END AS x
    FROM apsa_061_service_role_before b
    JOIN pg_class c ON c.oid = b.relid
    LEFT JOIN pg_attribute a ON a.attrelid = b.relid AND a.attnum = b.attnum AND b.attnum > 0
    WHERE NOT CASE
      WHEN c.relkind = 'S' THEN has_sequence_privilege('service_role', b.relid, b.privilege)
      WHEN b.attnum = 0 THEN has_table_privilege('service_role', b.relid, b.privilege)
      ELSE has_column_privilege('service_role', b.relid, b.attnum, b.privilege)
    END
    ORDER BY b.relid::regclass::text, b.attnum, b.privilege
    LIMIT 40
  ) lost;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '061: service_role lost authority it held before 061 (it held it through PUBLIC, a column grant, or a browser role — grant it to service_role explicitly first): %', offenders;
  END IF;
END
$$;

DROP TABLE pg_temp.apsa_061_browser_roles;
DROP TABLE pg_temp.apsa_061_service_role_before;
