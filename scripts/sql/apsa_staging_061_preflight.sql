-- =============================================================================
-- APSA — STAGING PREFLIGHT FOR MIGRATION 061  (read-only, owner-run)  v2
--
-- Target migration : supabase/migrations/061_browser_table_authority_hardening.sql
-- Pinned to        : main 0cb183ff13619913dc56af668445c28d7b4bcfbf
--
-- RUN ONLY against the confirmed STAGING project, as role postgres.
-- NEVER run it against production.
--
-- WHAT IT DOES
--   One READ ONLY, REPEATABLE READ transaction with bounded timeouts, a single
--   SELECT over system catalogs and privilege functions, then ROLLBACK.
--   The only non-catalog relation it may read is the Supabase CLI migration
--   ledger (supabase_migrations.schema_migrations: version and name only).
--   It reads no business or customer rows, creates nothing (no temp tables),
--   grants and revokes nothing, changes no setting beyond SET LOCAL timeouts,
--   and does not execute any migration.
--
-- HOW TO RUN (all of these are mandatory)
--   * Execute the WHOLE file in ONE request / ONE session. Never run parts of
--     it, never re-run a highlighted selection, never run ROLLBACK separately.
--   * The run is valid only if (a) it finished without any error, and
--     (b) the result contains row 99.01 (the verdict). Anything else —
--     an error, an empty result, "Success. No rows returned", a truncated
--     grid without 99.01 — is NOT a pass: stop and use a single-session
--     client with error-stop and file output, e.g. psql with
--     -X -v ON_ERROR_STOP=1 --csv -f <this file> -o <output.csv>.
--   * Only the 99.01 subject "PASS FOR STAGING REHEARSAL PLANNING ..." is a
--     pass. UNKNOWN anywhere means the verdict is not PASS.
--
-- OUTPUT — one result set:
--   section | check_id | phase | status | blocker_class | subject | observed | expectation
--
--   phase
--     SCRIPT              safety of this run
--     BASELINE            migration ledger and object evidence
--     CURRENT             the state observed now (informational)
--     PRECONDITION        must hold BEFORE 061; 061 does not change it
--     ESTABLISHED_BY_061  present now, but 061 itself removes it (its own
--                         postcondition). Never a blocker.
--     SUMMARY             overall verdict (row 99.01)
--
--   status
--     PASS          observed to hold
--     FAIL          blocks planning to apply 061 (blocker_class says why)
--     FIXED_BY_061  present now; 061 removes it itself
--     UNKNOWN       not visible / not verifiable from this session: NOT a pass
--     CONFIRM       must be confirmed by the operator (not observable in SQL)
--     WARN          anomaly to review
--     INFO          context
--
--   blocker_class (on FAIL / UNKNOWN rows)
--     SCRIPT            the run itself is not read-only
--     VISIBILITY        evidence missing or unverifiable (UNKNOWN)
--     INCONSISTENT      ledger and objects (or ledger and repository) disagree
--     ALREADY_RECORDED  the ledger records 061: needs a separate
--                       post-application assessment, never a re-apply
--     PREREQUISITE      a prerequisite migration (001-060) is not established
--     PRIVILEGE         061 would abort on a privilege / ownership condition
--
-- EVIDENCE LIMITS (stated, not hidden)
--   * Prerequisites are the exact migration files below version 061 in the
--     pinned repository (58 files; numbering is NOT contiguous: no 028, 029).
--   * A ledger row proves only that the Supabase CLI recorded that version.
--     The presence of the 44 relations 061 names proves only that those
--     relations exist. Neither proves every historical effect of 001-060
--     (functions, policies, grants, triggers, backfills). This script checks
--     what 061 itself depends on: relations, ownership, ACLs, default ACLs,
--     role reachability and schema CREATE authority.
--   * Sections 06 and 10 SIMULATE 061 step 1 against current ACLs. 061's own
--     assertions remain the authority during a rehearsal; this script cannot
--     prove 061's postconditions.
--   * Missing ACLs are never read as "no privileges": NULL relacl / nspacl is
--     expanded with acldefault(), and absent pg_default_acl rows are reported
--     as the built-in default.
--   * "Browser-reachable" is computed exactly as 061 step 0a: anon,
--     authenticated, and every role either is a member of at any depth through
--     any membership edge — an unbounded recursive UNION, which terminates
--     because UNION discards rows already found (PostgreSQL also refuses
--     circular role membership).
-- =============================================================================

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

WITH RECURSIVE
params AS (
  SELECT current_setting('server_version_num')::int                      AS ver,
         (SELECT oid FROM pg_namespace WHERE nspname = 'public')           AS public_oid,
         (SELECT oid FROM pg_roles WHERE rolname = 'postgres')             AS postgres_oid,
         (SELECT oid FROM pg_roles WHERE rolname = 'anon')                 AS anon_oid,
         (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')        AS auth_oid,
         (SELECT oid FROM pg_roles WHERE rolname = 'service_role')         AS svc_oid
),
-- Every table privilege the server knows (061: MAINTAIN only on 17+)
table_privs(priv) AS (
  SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                || CASE WHEN (SELECT ver FROM params) >= 170000
                        THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END)
),
-- The 44 relations 061 step 1 revokes on (41 tables, 3 views)
listed(relname, expected_kind) AS (VALUES
  ('profiles','table'), ('organizations','table'), ('workspaces','table'),
  ('locations','table'), ('roles','table'), ('permissions','table'),
  ('role_permissions','table'), ('memberships','table'), ('invitations','table'),
  ('audit_logs','table'),
  ('customers','table'), ('customer_identities','table'), ('customer_addresses','table'),
  ('customer_notes','table'), ('customer_tags','table'), ('customer_tag_assignments','table'),
  ('customer_returns','table'), ('customer_return_items','table'), ('customer_return_events','table'),
  ('product_categories','table'), ('products','table'), ('product_variants','table'),
  ('inventory_movements','table'), ('stock_counts','table'), ('inventory_stock','view'),
  ('orders','table'), ('order_items','table'), ('order_status_history','table'),
  ('order_number_sequences','table'),
  ('delivery_providers','table'), ('deliveries','table'), ('delivery_status_history','table'),
  ('parcels','table'),
  ('payments','table'), ('payment_events','table'), ('payment_evidence','table'),
  ('payment_reconciliation_summary','view'), ('order_payment_totals','view'),
  ('conversations','table'), ('messages','table'), ('conversation_participants','table'),
  ('conversation_read_markers','table'),
  ('rate_limit_buckets','table'), ('webhook_event_receipts','table')
),
-- Exact prerequisite set: every supabase/migrations file below 061 at the pinned commit
expected_prerequisites(version, name) AS (VALUES
-- BEGIN EXPECTED PREREQUISITES
  ('001','auth_profiles'),
  ('002','organizations'),
  ('003','roles_permissions'),
  ('004','workspaces'),
  ('005','locations'),
  ('006','memberships'),
  ('007','rls_deferred_member_policies'),
  ('008','audit_logs'),
  ('009','create_organization_rpc'),
  ('010','permission_vocabulary'),
  ('011','customers'),
  ('012','customer_identities'),
  ('013','customer_notes'),
  ('014','customer_tags'),
  ('015','customer_addresses'),
  ('016','customer_permissions'),
  ('017','product_categories'),
  ('018','products'),
  ('019','product_permissions'),
  ('020','product_cross_tenant_integrity'),
  ('021','inventory_movements'),
  ('022','inventory_permissions'),
  ('023','orders'),
  ('024','order_rpc'),
  ('025','order_permissions'),
  ('026','order_inventory_integration'),
  ('027','delivery_fulfillment_domain'),
  ('030','order_conversation_source'),
  ('031','conversations'),
  ('032','messages'),
  ('033','conversation_permissions'),
  ('034','payments_domain'),
  ('035','payment_rpc'),
  ('036','payment_permissions'),
  ('037','conversation_read_identity'),
  ('038','conversation_ingestion'),
  ('039','order_refund_axis'),
  ('040','payment_order_authority'),
  ('041','team_invitations'),
  ('042','team_permissions'),
  ('043','payment_referenceless_duplicate'),
  ('044','order_idempotency_delivery_fee'),
  ('045','operability_rate_limits_webhooks'),
  ('046','fulfillment_permissions'),
  ('047','order_shipping_snapshot'),
  ('048','service_role_table_grants'),
  ('049','analytics_period_status_counts'),
  ('050','parcels'),
  ('051','courier_handoff_permission'),
  ('052','inventory_receiving'),
  ('053','stock_counts'),
  ('054','pack_order_readiness_guards'),
  ('055','inventory_damage_movement'),
  ('056','customer_returns'),
  ('057','atomic_parcel_on_confirm'),
  ('058','backfill_apsa_parcels'),
  ('059','recover_order_parcel'),
  ('060','customer_purchase_profile')
-- END EXPECTED PREREQUISITES
),
later_migrations(version, name) AS (VALUES
  ('061','browser_table_authority_hardening'),
  ('062','financial_replay_refund_audit_atomicity'),
  ('063','order_cancellation_custody_guard')
),
repo_migrations(version, name) AS (
  SELECT version, name FROM expected_prerequisites
  UNION ALL
  SELECT version, name FROM later_migrations
),
-- Grantees 061 step 1 / step 2 revoke from (0 = PUBLIC)
revoked_by_061(grantee) AS (
  SELECT 0::oid
  UNION SELECT anon_oid FROM params WHERE anon_oid IS NOT NULL
  UNION SELECT auth_oid FROM params WHERE auth_oid IS NOT NULL
),
-- 061 step 0a, verbatim semantics: unbounded, any edge, UNION (cycle-safe)
browser_roles(roleid) AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  UNION
  SELECT m.roleid FROM pg_auth_members m JOIN browser_roles b ON m.member = b.roleid
),
browser_or_public(grantee) AS (
  SELECT 0::oid UNION SELECT roleid FROM browser_roles
),
svc_roles(roleid) AS (
  SELECT oid FROM pg_roles WHERE rolname = 'service_role'
  UNION
  SELECT m.roleid FROM pg_auth_members m JOIN svc_roles s ON m.member = s.roleid
),
-- Every relation and sequence in public (061 steps 3 and 4 scope)
pub_rels AS (
  SELECT c.oid AS relid, c.relname::text AS relname, c.relkind, c.relowner, c.relacl,
         (l.relname IS NOT NULL) AS listed, l.expected_kind
    FROM pg_class c
    JOIN params p ON c.relnamespace = p.public_oid
    LEFT JOIN listed l ON l.relname = c.relname::text
   WHERE c.relkind IN ('r','p','v','m','f','S')
),
rel_acl AS (
  SELECT r.relid, r.relname, r.relkind, r.listed, a.grantee, a.grantor, a.privilege_type
    FROM pub_rels r
    CROSS JOIN LATERAL aclexplode(COALESCE(r.relacl,
           acldefault((CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END)::"char", r.relowner))) a
),
col_acl AS (
  SELECT r.relid, r.relname, r.listed, att.attnum, att.attname::text AS attname,
         a.grantee, a.privilege_type
    FROM pub_rels r
    JOIN pg_attribute att ON att.attrelid = r.relid AND att.attnum > 0
                         AND NOT att.attisdropped AND att.attacl IS NOT NULL
    CROSS JOIN LATERAL aclexplode(att.attacl) a
   WHERE r.relkind <> 'S'
),
dacl AS (
  SELECT d.defaclrole, d.defaclnamespace, d.defaclobjtype, a.grantee, a.privilege_type
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
),
public_acl AS (
  SELECT a.grantee, a.privilege_type, n.nspowner
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
   WHERE n.nspname = 'public'
),
-- Every role with effective CREATE on public (061 step 6a definition)
creators AS (
  SELECT r.oid AS roleid, r.rolname::text AS rolname, r.rolsuper,
         CASE WHEN r.rolsuper THEN 'superuser'
              WHEN r.oid = n.nspowner THEN 'schema owner'
              WHEN EXISTS (SELECT 1 FROM public_acl a
                            WHERE a.grantee = r.oid AND a.privilege_type = 'CREATE') THEN 'direct CREATE grant'
              WHEN EXISTS (SELECT 1 FROM public_acl a
                            WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') THEN 'CREATE granted to PUBLIC'
              ELSE 'inherited through role membership' END AS via
    FROM pg_roles r
    JOIN pg_namespace n ON n.nspname = 'public'
   WHERE has_schema_privilege(r.oid, n.oid, 'CREATE')
),
browser_creators AS (
  SELECT b.roleid
    FROM browser_roles b CROSS JOIN params pa
   WHERE pa.public_oid IS NOT NULL
     AND has_schema_privilege(b.roleid, pa.public_oid, 'CREATE')
),
-- postgres table/sequence defaults (global + public) reaching a browser role
postgres_browser_dacl AS (
  SELECT d.defaclnamespace, d.defaclobjtype, d.grantee, d.privilege_type,
         (d.grantee IN (SELECT grantee FROM revoked_by_061)) AS revoked_by_step2
    FROM dacl d CROSS JOIN params pa
   WHERE d.defaclrole = pa.postgres_oid
     AND d.defaclobjtype IN ('r','S')
     AND (d.defaclnamespace = 0 OR d.defaclnamespace = pa.public_oid)
     AND d.grantee IN (SELECT grantee FROM browser_or_public)
),
pg_dacl_rows AS (
  SELECT k.scope, k.objtype,
         EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN params pa
                  WHERE d.defaclrole = pa.postgres_oid AND d.defaclobjtype = k.objtype
                    AND d.defaclnamespace = CASE k.scope WHEN 'global' THEN 0::oid ELSE pa.public_oid END) AS has_row
    FROM (VALUES ('global','r'::"char"), ('global','S'::"char"),
                 ('public','r'::"char"), ('public','S'::"char")) k(scope, objtype)
),
-- Other creators' table/sequence defaults reaching a browser role (061 step 6a)
creator_browser_dacl AS (
  SELECT c.rolname, d.defaclnamespace, d.defaclobjtype, d.grantee, d.privilege_type
    FROM dacl d
    JOIN creators c ON c.roleid = d.defaclrole
    CROSS JOIN params pa
   WHERE d.defaclrole IS DISTINCT FROM pa.postgres_oid
     AND d.defaclobjtype IN ('r','S')
     AND (d.defaclnamespace = 0 OR d.defaclnamespace = pa.public_oid)
     AND d.grantee IN (SELECT grantee FROM browser_or_public)
),
-- Supabase CLI migration ledger. Only the version and name columns are ever
-- read (column-level SELECT on those two is enough; statements is never
-- touched). The ledger counts as readable only if both columns exist and are
-- SELECT-able by this role; otherwise the baseline is UNKNOWN, never PASS.
mig_cols AS (
  SELECT s.rel,
         (SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = s.rel AND a.attname = 'version' AND NOT a.attisdropped) AS version_att,
         (SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = s.rel AND a.attname = 'name' AND NOT a.attisdropped) AS name_att
    FROM (SELECT to_regclass('supabase_migrations.schema_migrations') AS rel) s
),
mig_state AS (
  SELECT c.rel,
         CASE WHEN c.rel IS NULL THEN 'absent'
              WHEN c.version_att IS NULL THEN 'present without a version column'
              WHEN c.name_att IS NULL THEN 'present without a name column'
              WHEN NOT has_schema_privilege('supabase_migrations', 'USAGE') THEN 'schema not usable'
              WHEN NOT has_column_privilege(c.rel::oid, c.version_att, 'SELECT') THEN 'version column not readable'
              WHEN NOT has_column_privilege(c.rel::oid, c.name_att, 'SELECT') THEN 'name column not readable'
              ELSE 'readable' END AS state
    FROM mig_cols c
),
mig_xml AS (
  SELECT query_to_xml(
           'SELECT m.version::text AS version, m.name::text AS name '
           || 'FROM supabase_migrations.schema_migrations m ORDER BY 1',
           false, false, '') AS x
    FROM mig_state WHERE state = 'readable'
),
mig_rows AS (
  SELECT t.v, COALESCE(t.n, '') AS n
    FROM mig_xml
    CROSS JOIN LATERAL XMLTABLE('/table/row' PASSING mig_xml.x
           COLUMNS v text PATH 'version', n text PATH 'name') t
),
ledger_readable AS (
  SELECT (SELECT state FROM mig_state) = 'readable' AS ok
),
prereq_status AS (
  SELECT e.version, e.name,
         EXISTS (SELECT 1 FROM mig_rows m WHERE m.v = e.version) AS recorded,
         (SELECT string_agg(DISTINCT m.n, ' | ') FROM mig_rows m WHERE m.v = e.version) AS ledger_name
    FROM expected_prerequisites e
),
later_status AS (
  SELECT l.version, l.name,
         EXISTS (SELECT 1 FROM mig_rows m WHERE m.v = l.version) AS recorded,
         (SELECT string_agg(DISTINCT m.n, ' | ') FROM mig_rows m WHERE m.v = l.version) AS ledger_name
    FROM later_migrations l
),
ledger_unexpected AS (
  SELECT m.v, m.n FROM mig_rows m
   WHERE NOT EXISTS (SELECT 1 FROM repo_migrations r WHERE r.version = m.v)
),
baseline_flags AS (
  SELECT lr.ok AS ledger_ok,
         lr.ok AND NOT EXISTS (SELECT 1 FROM prereq_status WHERE NOT recorded) AS all_prereq_recorded,
         lr.ok AND EXISTS (SELECT 1 FROM later_status WHERE version = '061' AND recorded) AS rec_061
    FROM ledger_readable lr
),
-- Object evidence for 062 / 063 (independent of the ledger)
fn_present AS (
  SELECT f.mig, f.proname,
         (SELECT count(*) FROM pg_proc p JOIN params pa ON p.pronamespace = pa.public_oid
           WHERE p.proname = f.proname) AS n
    FROM (VALUES ('062','record_payment_v2'), ('062','refund_payment_v2'),
                 ('062','reverse_payment_v2'), ('062','correct_payment_v2'),
                 ('062','payment_request_digest_v1'), ('062','payment_replay_matches_v1'),
                 ('063','order_cancellation_block_v1')) f(mig, proname)
),
-- 061 step 4a, simulated: browser-reachable authority that step 1 does not remove
remaining_browser(source, subject, observed) AS (
  SELECT 'table ACL',
         format('%s %s on public.%s',
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                a.privilege_type, a.relname),
         format('granted by %s; relation %s the 061 list', pg_get_userbyid(a.grantor),
                CASE WHEN a.listed THEN 'in' ELSE 'NOT in' END)
    FROM rel_acl a
   WHERE a.relkind <> 'S'
     AND a.grantee IN (SELECT grantee FROM browser_or_public)
     AND a.privilege_type IN (SELECT priv FROM table_privs)
     AND NOT (a.listed AND a.grantee IN (SELECT grantee FROM revoked_by_061))
  UNION ALL
  SELECT 'column ACL',
         format('%s %s on public.%s (%s)',
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                a.privilege_type, a.relname, string_agg(a.attname, ',' ORDER BY a.attnum)),
         CASE WHEN a.listed THEN 'relation in the 061 list; grantee not revoked by 061'
              ELSE 'relation NOT in the 061 list' END
    FROM col_acl a
   WHERE a.grantee IN (SELECT grantee FROM browser_or_public)
     AND NOT (a.listed AND a.grantee IN (SELECT grantee FROM revoked_by_061))
   GROUP BY a.grantee, a.privilege_type, a.relname, a.listed
  UNION ALL
  SELECT 'sequence ACL',
         format('%s %s on sequence public.%s',
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                a.privilege_type, a.relname),
         '061 revokes no sequence privileges'
    FROM rel_acl a
   WHERE a.relkind = 'S'
     AND a.grantee IN (SELECT grantee FROM browser_or_public)
  UNION ALL
  SELECT 'ownership',
         format('%s owns public.%s', pg_get_userbyid(r.relowner), r.relname),
         'an owner holds every privilege; 061 does not change owners'
    FROM pub_rels r
   WHERE r.relowner IN (SELECT roleid FROM browser_roles)
),
-- What 061 step 1 itself removes (its own postcondition)
fixed_browser(subject, privs) AS (
  SELECT format('%s on public.%s',
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.relname),
         string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
    FROM rel_acl a
   WHERE a.listed AND a.relkind <> 'S'
     AND a.grantee IN (SELECT grantee FROM revoked_by_061)
   GROUP BY a.grantee, a.relname
  UNION ALL
  SELECT format('%s on columns of public.%s',
                CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.relname),
         string_agg(a.privilege_type || '(' || a.attname || ')', ', ' ORDER BY a.attnum, a.privilege_type)
    FROM col_acl a
   WHERE a.listed AND a.grantee IN (SELECT grantee FROM revoked_by_061)
   GROUP BY a.grantee, a.relname
),
-- 061 step 0b / step 5, simulated for service_role
svc_tab_now AS (
  SELECT r.relid, r.relname, r.relowner, p.priv
    FROM pub_rels r
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(priv)
    CROSS JOIN params pa
   WHERE r.listed AND r.relkind <> 'S' AND pa.svc_oid IS NOT NULL
     AND has_table_privilege(pa.svc_oid, r.relid, p.priv)
),
svc_kept_tab AS (
  SELECT n.relid, n.priv
    FROM svc_tab_now n CROSS JOIN params pa
   WHERE (SELECT rolsuper FROM pg_roles WHERE oid = pa.svc_oid)
      OR pg_has_role(pa.svc_oid, n.relowner, 'USAGE')
      OR EXISTS (SELECT 1 FROM rel_acl a
                  WHERE a.relid = n.relid AND a.privilege_type = n.priv
                    AND CASE WHEN a.grantee IN (SELECT grantee FROM revoked_by_061) THEN false
                             ELSE pg_has_role(pa.svc_oid, a.grantee, 'USAGE') END)
      OR (n.priv = 'SELECT' AND EXISTS (
            SELECT 1 FROM pg_roles x
             WHERE x.rolname = 'pg_read_all_data' AND pg_has_role(pa.svc_oid, x.oid, 'USAGE')))
      OR (n.priv <> 'SELECT' AND EXISTS (
            SELECT 1 FROM pg_roles x
             WHERE x.rolname = 'pg_write_all_data' AND pg_has_role(pa.svc_oid, x.oid, 'USAGE')))
),
svc_lost_tab AS (
  SELECT n.relid, n.relname, n.priv,
         (n.relname IN ('payments','payment_events','payment_evidence')
          AND n.priv IN ('INSERT','UPDATE','DELETE')) AS payment_exception
    FROM svc_tab_now n
   WHERE NOT EXISTS (SELECT 1 FROM svc_kept_tab k WHERE k.relid = n.relid AND k.priv = n.priv)
),
svc_col_now AS (
  SELECT r.relid, r.relname, att.attnum, att.attname::text AS attname, p.priv
    FROM pub_rels r
    JOIN pg_attribute att ON att.attrelid = r.relid AND att.attnum > 0 AND NOT att.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) AS p(priv)
    CROSS JOIN params pa
   WHERE r.listed AND r.relkind <> 'S' AND pa.svc_oid IS NOT NULL
     AND has_column_privilege(pa.svc_oid, r.relid, att.attnum, p.priv)
),
svc_lost_col AS (
  SELECT c.relid, c.relname, c.attnum, c.attname, c.priv,
         (c.relname IN ('payments','payment_events','payment_evidence')
          AND c.priv IN ('INSERT','UPDATE')) AS payment_exception
    FROM svc_col_now c CROSS JOIN params pa
   WHERE NOT EXISTS (SELECT 1 FROM svc_kept_tab k WHERE k.relid = c.relid AND k.priv = c.priv)
     AND NOT EXISTS (SELECT 1 FROM svc_lost_tab l WHERE l.relid = c.relid AND l.priv = c.priv)
     AND NOT EXISTS (SELECT 1 FROM col_acl a
                      WHERE a.relid = c.relid AND a.attnum = c.attnum AND a.privilege_type = c.priv
                        AND CASE WHEN a.grantee IN (SELECT grantee FROM revoked_by_061) THEN false
                                 ELSE pg_has_role(pa.svc_oid, a.grantee, 'USAGE') END)
),
report(section, check_id, phase, status, blocker_class, subject, observed, expectation) AS (

  -- ── 00 session and script safety ──────────────────────────────────────────
  SELECT '00 session'::text, '00.01'::text, 'SCRIPT'::text,
         (CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'PASS' ELSE 'FAIL' END)::text,
         (CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'NONE' ELSE 'SCRIPT' END)::text,
         'transaction_read_only'::text,
         current_setting('transaction_read_only')::text,
         'on: this report must run inside BEGIN ... READ ONLY'::text
  UNION ALL
  SELECT '00 session', '00.02', 'SCRIPT', 'INFO', 'NONE', 'statement_timeout / lock_timeout / isolation',
         current_setting('statement_timeout') || ' / ' || current_setting('lock_timeout')
           || ' / ' || current_setting('transaction_isolation'),
         'bounded timeouts; repeatable read = one consistent snapshot'
  UNION ALL
  SELECT '00 session', '00.03', 'CURRENT', 'INFO', 'NONE', 'run_at (UTC)',
         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'record with the export'
  UNION ALL
  SELECT '00 session', '00.04', 'CURRENT', 'INFO', 'NONE', 'session_user / current_user',
         session_user::text || ' / ' || current_user::text,
         'the SQL Editor normally runs as postgres'
  UNION ALL
  SELECT '00 session', '00.05', 'CURRENT', 'INFO', 'NONE', 'current_user attributes',
         (SELECT format('superuser=%s, createrole=%s, bypassrls=%s',
                        rolsuper::text, rolcreaterole::text, rolbypassrls::text)
            FROM pg_roles WHERE rolname = current_user),
         'informational'
  UNION ALL
  SELECT '00 session', '00.06', 'CURRENT', 'INFO', 'NONE', 'PostgreSQL version',
         current_setting('server_version') || ' (server_version_num '
           || current_setting('server_version_num') || ')',
         '061 checks MAINTAIN only when server_version_num >= 170000'
  UNION ALL
  SELECT '00 session', '00.07', 'CURRENT', 'INFO', 'NONE', 'database / in recovery',
         current_database()::text || ' / ' || pg_is_in_recovery()::text,
         'expected: postgres / false'
  UNION ALL
  SELECT '00 session', '00.08', 'PRECONDITION', 'CONFIRM', 'NONE', 'staging project identity',
         'not observable from SQL',
         'operator records the project ref with this export; it must be the staging ref and differ from the production ref'
  UNION ALL
  SELECT '00 session', '00.09', 'PRECONDITION', 'CONFIRM', 'NONE', '061 executor role',
         'this report runs as ' || current_user::text,
         '061 step 3 aborts unless the role that applies it is postgres'
  UNION ALL
  SELECT '00 session', '00.10', 'PRECONDITION',
         CASE WHEN r.oid IS NULL THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN r.oid IS NULL THEN 'PREREQUISITE' ELSE 'NONE' END,
         'role ' || n.name,
         CASE WHEN r.oid IS NULL THEN 'missing'
              ELSE format('present (superuser=%s, login=%s, inherit=%s)',
                          r.rolsuper::text, r.rolcanlogin::text, r.rolinherit::text) END,
         'must exist: 061 names it'
    FROM (VALUES ('postgres'), ('anon'), ('authenticated'), ('service_role')) n(name)
    LEFT JOIN pg_roles r ON r.rolname = n.name
  UNION ALL
  SELECT '00 session', '00.11', 'PRECONDITION',
         CASE WHEN pa.public_oid IS NULL THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN pa.public_oid IS NULL THEN 'PREREQUISITE' ELSE 'NONE' END,
         'schema public',
         CASE WHEN pa.public_oid IS NULL THEN 'missing'
              ELSE 'present, owner ' || (SELECT pg_get_userbyid(nspowner) FROM pg_namespace
                                          WHERE oid = pa.public_oid) END,
         'must exist'
    FROM params pa

  -- ── 01 baseline: repository prerequisites vs the CLI ledger ───────────────
  UNION ALL
  SELECT '01 baseline', '01.00', 'BASELINE', 'INFO', 'NONE', 'evidence limits',
         'a ledger row proves the CLI recorded a version; relation presence (02) proves only that the relations exist',
         'neither proves every historical effect of 001-060 (functions, policies, grants, triggers, backfills); 061 depends on the relations, ownership and ACLs checked in 02-10'
  UNION ALL
  SELECT '01 baseline', '01.01', 'BASELINE',
         CASE WHEN s.state = 'readable' THEN 'PASS' ELSE 'UNKNOWN' END,
         CASE WHEN s.state = 'readable' THEN 'NONE' ELSE 'VISIBILITY' END,
         'supabase_migrations.schema_migrations',
         CASE WHEN s.state = 'readable'
              THEN format('readable: %s record(s); highest version %s',
                          (SELECT count(*) FROM mig_rows), COALESCE((SELECT max(v) FROM mig_rows), 'none'))
              ELSE s.state || ' to ' || current_user::text END,
         'the ledger must be present and readable, or the baseline cannot be established'
    FROM mig_state s
  UNION ALL
  SELECT '01 baseline', '01.02', 'BASELINE', 'INFO', 'NONE', 'repository prerequisite manifest',
         (SELECT format('%s file(s) below 061 at 0cb183f: %s', count(*), string_agg(version, ',' ORDER BY version))
            FROM expected_prerequisites),
         'exact file list from the pinned repository; numbering is not assumed contiguous'
  UNION ALL
  SELECT '01 baseline', '01.03', 'BASELINE',
         CASE WHEN NOT f.ledger_ok THEN 'UNKNOWN'
              WHEN f.all_prereq_recorded THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN NOT f.ledger_ok THEN 'VISIBILITY'
              WHEN f.all_prereq_recorded THEN 'NONE' ELSE 'PREREQUISITE' END,
         'every repository prerequisite is recorded in the ledger',
         CASE WHEN NOT f.ledger_ok THEN 'ledger not visible'
              ELSE (SELECT format('%s of %s recorded', count(*) FILTER (WHERE recorded), count(*))
                      FROM prereq_status) END,
         'all prerequisites must be recorded before 061 is planned'
    FROM baseline_flags f
  UNION ALL
  SELECT '01 baseline', '01.04', 'BASELINE', 'FAIL', 'PREREQUISITE',
         'prerequisite ' || p.version || '_' || p.name, 'not recorded in the ledger',
         'a prerequisite of 061 is not established'
    FROM prereq_status p CROSS JOIN baseline_flags f
   WHERE f.ledger_ok AND NOT p.recorded
  UNION ALL
  SELECT '01 baseline', '01.05', 'BASELINE', 'FAIL', 'INCONSISTENT',
         'ledger version ' || x.version || ' name',
         format('ledger %s, repository %s', x.ledger_name, x.name),
         'ledger and repository disagree on what this version is'
    FROM (SELECT version, name, ledger_name, recorded FROM prereq_status
          UNION ALL
          SELECT version, name, ledger_name, recorded FROM later_status) x
    CROSS JOIN baseline_flags f
   WHERE f.ledger_ok AND x.recorded AND x.ledger_name <> '' AND x.ledger_name <> x.name
  UNION ALL
  SELECT '01 baseline', '01.06', 'BASELINE', 'UNKNOWN', 'VISIBILITY',
         'ledger names', count(*) || ' recorded repository version(s) have no name in the ledger',
         'a version without a name cannot be matched to its file: unverifiable'
    FROM (SELECT ledger_name, recorded FROM prereq_status
          UNION ALL
          SELECT ledger_name, recorded FROM later_status) x
    CROSS JOIN baseline_flags f
   WHERE f.ledger_ok AND x.recorded AND COALESCE(x.ledger_name, '') = ''
  HAVING count(*) > 0
  UNION ALL
  SELECT '01 baseline', '01.07', 'BASELINE', 'FAIL', 'INCONSISTENT',
         'ledger version ' || u.v, 'name ' || COALESCE(NULLIF(u.n, ''), '(none)'),
         'recorded in the ledger but not a migration file in the pinned repository'
    FROM ledger_unexpected u
  UNION ALL
  SELECT '01 baseline', '01.08', 'BASELINE',
         CASE WHEN NOT f.ledger_ok THEN 'UNKNOWN'
              WHEN l.recorded AND l.version = '061' THEN 'FAIL'
              WHEN l.recorded AND NOT f.rec_061 THEN 'FAIL'
              WHEN l.version = '061' THEN 'PASS'
              ELSE 'INFO' END,
         CASE WHEN NOT f.ledger_ok THEN 'VISIBILITY'
              WHEN l.recorded AND l.version = '061' THEN 'ALREADY_RECORDED'
              WHEN l.recorded AND NOT f.rec_061 THEN 'INCONSISTENT'
              ELSE 'NONE' END,
         'ledger: ' || l.version || '_' || l.name,
         CASE WHEN NOT f.ledger_ok THEN 'ledger not visible'
              WHEN l.recorded THEN 'recorded' ELSE 'not recorded' END,
         CASE WHEN l.version = '061'
              THEN '061 must be pending; if recorded, run a separate post-application assessment and do not re-apply'
              ELSE 'a later migration recorded without 061 is inconsistent' END
    FROM later_status l CROSS JOIN baseline_flags f
  UNION ALL
  SELECT '01 baseline', '01.09', 'BASELINE', 'FAIL', 'INCONSISTENT',
         'ledger vs ' || fp.mig || ' objects',
         format('ledger %s %s; public.%s %s',
                CASE WHEN ls.recorded THEN 'records' ELSE 'does not record' END, fp.mig,
                fp.proname, CASE WHEN fp.n > 0 THEN 'is present' ELSE 'is absent' END),
         'ledger and objects disagree'
    FROM fn_present fp
    JOIN later_status ls ON ls.version = fp.mig
    CROSS JOIN baseline_flags f
   WHERE f.ledger_ok AND ls.recorded <> (fp.n > 0)
  UNION ALL
  SELECT '01 baseline', '01.10', 'BASELINE', 'FAIL', 'INCONSISTENT',
         'ledger vs 061 effects',
         'ledger records 061, but direct browser grants on listed relations or postgres browser defaults are present (see 06, 07)',
         'ledger and objects disagree'
    FROM baseline_flags f
   WHERE f.rec_061
     AND (EXISTS (SELECT 1 FROM fixed_browser) OR EXISTS (SELECT 1 FROM postgres_browser_dacl))
  UNION ALL
  SELECT '01 baseline', '01.11', 'BASELINE', 'WARN', 'NONE',
         'later-migration objects with an invisible ledger',
         string_agg(fp.mig || ': public.' || fp.proname, ', '),
         '062/063 objects exist, so 061 may already be applied; the ledger cannot confirm it'
    FROM fn_present fp CROSS JOIN baseline_flags f
   WHERE NOT f.ledger_ok AND fp.n > 0
  HAVING count(*) > 0

  -- ── 02 relations 061 step 1 requires ──────────────────────────────────────
  UNION ALL
  SELECT '02 required relations', '02.00', 'PRECONDITION',
         CASE WHEN count(r.relid) = 44 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(r.relid) = 44 THEN 'NONE'
              WHEN (SELECT all_prereq_recorded FROM baseline_flags) THEN 'INCONSISTENT'
              ELSE 'PREREQUISITE' END,
         '061 step 1 relation list',
         count(r.relid) || ' of 44 present',
         'all 44 must exist: a REVOKE on a missing relation aborts 061; missing while the ledger records every prerequisite is an inconsistency'
    FROM listed l
    LEFT JOIN pub_rels r ON r.relname = l.relname AND r.relkind <> 'S'
  UNION ALL
  SELECT '02 required relations', '02.01', 'PRECONDITION',
         CASE WHEN r.relid IS NULL THEN 'FAIL'
              WHEN (l.expected_kind = 'view') <> (r.relkind = 'v') THEN 'WARN'
              ELSE 'PASS' END,
         CASE WHEN r.relid IS NOT NULL THEN 'NONE'
              WHEN (SELECT all_prereq_recorded FROM baseline_flags) THEN 'INCONSISTENT'
              ELSE 'PREREQUISITE' END,
         'public.' || l.relname,
         CASE WHEN r.relid IS NULL THEN 'missing'
              ELSE format('kind %s, owner %s',
                          CASE r.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
                                         WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                                         WHEN 'f' THEN 'foreign table' ELSE r.relkind::text END,
                          pg_get_userbyid(r.relowner)) END,
         'exists as ' || l.expected_kind
    FROM listed l
    LEFT JOIN pub_rels r ON r.relname = l.relname AND r.relkind <> 'S'

  -- ── 03 ownership of everything in public (061 step 3) ─────────────────────
  UNION ALL
  SELECT '03 relation ownership', '03.00', 'PRECONDITION',
         CASE WHEN EXISTS (SELECT 1 FROM pub_rels r CROSS JOIN params pa
                            WHERE r.relowner IS DISTINCT FROM pa.postgres_oid)
              THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN EXISTS (SELECT 1 FROM pub_rels r CROSS JOIN params pa
                            WHERE r.relowner IS DISTINCT FROM pa.postgres_oid)
              THEN 'PRIVILEGE' ELSE 'NONE' END,
         'every relation and sequence in public is owned by postgres',
         (SELECT format('%s relation(s) in public: %s sequence(s), %s not in the 061 list',
                        count(*), count(*) FILTER (WHERE relkind = 'S'),
                        count(*) FILTER (WHERE NOT listed AND relkind <> 'S'))
            FROM pub_rels),
         '061 step 3 aborts otherwise (some other role would be creating APSA relations)'
  UNION ALL
  SELECT '03 relation ownership', '03.01', 'PRECONDITION', 'FAIL', 'PRIVILEGE',
         'public.' || r.relname || ' (relkind ' || r.relkind::text || ')',
         'owner ' || pg_get_userbyid(r.relowner),
         'owner must be postgres (061 step 3)'
    FROM pub_rels r CROSS JOIN params pa
   WHERE r.relowner IS DISTINCT FROM pa.postgres_oid
  UNION ALL
  SELECT '03 relation ownership', '03.02', 'CURRENT', 'WARN', 'NONE',
         'public.' || r.relname || ' (relkind ' || r.relkind::text || ')',
         'not in the 061 list; owner ' || pg_get_userbyid(r.relowner),
         '061 does not revoke on it, but step 4a still checks it (see 06)'
    FROM pub_rels r
   WHERE NOT r.listed AND r.relkind <> 'S'

  -- ── 04 role reachability (061 step 0a, unbounded) ─────────────────────────
  UNION ALL
  SELECT '04 role reachability', '04.00', 'CURRENT', 'INFO', 'NONE',
         'browser-reachable roles (unbounded, any membership edge)',
         (SELECT count(*) FROM browser_roles) || ' role(s)',
         'same recursive UNION as 061 step 0a; no depth limit'
  UNION ALL
  SELECT '04 role reachability', '04.01', 'PRECONDITION',
         CASE WHEN r.rolsuper
                OR r.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_maintain', 'service_role')
              THEN 'FAIL' ELSE 'INFO' END,
         CASE WHEN r.rolsuper
                OR r.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_maintain', 'service_role')
              THEN 'PRIVILEGE' ELSE 'NONE' END,
         'browser-reachable: ' || r.rolname,
         format('reached from: %s; superuser=%s; inherited by anon=%s; inherited by authenticated=%s',
                CASE WHEN r.rolname IN ('anon', 'authenticated') THEN 'origin'
                     ELSE COALESCE((SELECT string_agg(pg_get_userbyid(m.member), ', ' ORDER BY pg_get_userbyid(m.member))
                                      FROM pg_auth_members m
                                     WHERE m.roleid = b.roleid
                                       AND m.member IN (SELECT roleid FROM browser_roles)), '?') END,
                r.rolsuper::text,
                CASE WHEN pa.anon_oid IS NULL THEN 'n/a' ELSE pg_has_role(pa.anon_oid, b.roleid, 'USAGE')::text END,
                CASE WHEN pa.auth_oid IS NULL THEN 'n/a' ELSE pg_has_role(pa.auth_oid, b.roleid, 'USAGE')::text END),
         'any membership edge counts; a superuser, pg_read_all_data, pg_write_all_data, pg_maintain or service_role here makes 061 step 4a abort'
    FROM browser_roles b
    JOIN pg_roles r ON r.oid = b.roleid
    CROSS JOIN params pa
  UNION ALL
  SELECT '04 role reachability', '04.02', 'CURRENT', 'INFO', 'NONE',
         'member of ' || pg_get_userbyid(m.roleid) || ': ' || pg_get_userbyid(m.member),
         format('admin_option=%s', m.admin_option::text),
         'roles that can act as a browser role (e.g. authenticator); not browser authority themselves'
    FROM pg_auth_members m CROSS JOIN params pa
   WHERE m.roleid = pa.anon_oid OR m.roleid = pa.auth_oid
  UNION ALL
  SELECT '04 role reachability', '04.03', 'CURRENT',
         CASE WHEN r.rolsuper THEN 'WARN' ELSE 'INFO' END, 'NONE',
         'service_role-reachable: ' || r.rolname,
         format('superuser=%s', r.rolsuper::text),
         'not a 061 precondition; 062 aborts if any of these is a superuser'
    FROM svc_roles s JOIN pg_roles r ON r.oid = s.roleid

  -- ── 05 effective browser authority NOW (before 061) ───────────────────────
  UNION ALL
  SELECT '05 current browser authority', '05.01', 'CURRENT', 'INFO', 'NONE',
         pg_get_userbyid(b.roleid) || ' on public.' || r.relname,
         string_agg(p.priv, ',' ORDER BY p.priv),
         CASE WHEN r.listed
              THEN 'effective now (direct, PUBLIC or inherited); what survives 061 is in 06'
              ELSE 'effective now on a relation NOT in the 061 list (see 06)' END
    FROM browser_roles b
    CROSS JOIN pub_rels r
    CROSS JOIN table_privs p
   WHERE r.relkind <> 'S' AND has_table_privilege(b.roleid, r.relid, p.priv)
   GROUP BY b.roleid, r.relname, r.listed
  UNION ALL
  SELECT '05 current browser authority', '05.02', 'CURRENT', 'INFO', 'NONE',
         pg_get_userbyid(b.roleid) || ' on sequence public.' || r.relname,
         string_agg(p.priv, ',' ORDER BY p.priv),
         'effective now; 061 revokes no sequence privileges (see 06)'
    FROM browser_roles b
    CROSS JOIN pub_rels r
    CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p(priv)
   WHERE CASE WHEN r.relkind = 'S' THEN has_sequence_privilege(b.roleid, r.relid, p.priv) ELSE false END
   GROUP BY b.roleid, r.relname
  UNION ALL
  SELECT '05 current browser authority', '05.03', 'CURRENT', 'INFO', 'NONE',
         (CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
           || ' column grants on public.' || a.relname,
         string_agg(a.privilege_type || '(' || a.attname || ')', ', ' ORDER BY a.attnum, a.privilege_type),
         'column-level ACL entries now'
    FROM col_acl a
   WHERE a.grantee IN (SELECT grantee FROM browser_or_public)
   GROUP BY a.grantee, a.relname

  -- ── 06 browser authority that would SURVIVE 061 step 1 (step 4a) ──────────
  UNION ALL
  SELECT '06 browser authority after 061 revokes', '06.00', 'PRECONDITION',
         CASE WHEN EXISTS (SELECT 1 FROM remaining_browser) THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN EXISTS (SELECT 1 FROM remaining_browser) THEN 'PRIVILEGE' ELSE 'NONE' END,
         'browser-reachable authority that 061 step 1 does not remove',
         (SELECT count(*) FROM remaining_browser) || ' item(s)',
         'must be 0 or 061 step 4a aborts. Simulated from current relacl/attacl minus the PUBLIC/anon/authenticated entries on the 44 listed relations; superuser and predefined-role reachability: see 04'
  UNION ALL
  SELECT '06 browser authority after 061 revokes', '06.01', 'PRECONDITION', 'FAIL', 'PRIVILEGE',
         x.subject, x.source || ': ' || x.observed,
         '061 step 4a aborts; 061 never revokes from this grantee or relation'
    FROM remaining_browser x
  UNION ALL
  SELECT '06 browser authority after 061 revokes', '06.02', 'ESTABLISHED_BY_061', 'FIXED_BY_061', 'NONE',
         f.subject, f.privs,
         'removed by 061 step 1 (REVOKE ALL ... FROM PUBLIC, anon, authenticated); not a blocker'
    FROM fixed_browser f

  -- ── 07 postgres default ACLs (061 step 2 and step 4b) ─────────────────────
  UNION ALL
  SELECT '07 postgres default ACLs', '07.00', 'PRECONDITION',
         CASE WHEN EXISTS (SELECT 1 FROM postgres_browser_dacl WHERE NOT revoked_by_step2)
              THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN EXISTS (SELECT 1 FROM postgres_browser_dacl WHERE NOT revoked_by_step2)
              THEN 'PRIVILEGE' ELSE 'NONE' END,
         'postgres table/sequence defaults after 061 step 2',
         (SELECT string_agg(scope || ' ' || CASE objtype WHEN 'r' THEN 'tables' ELSE 'sequences' END
                            || ': ' || CASE WHEN has_row THEN 'explicit row' ELSE 'no row' END, '; '
                            ORDER BY scope, objtype)
            FROM pg_dacl_rows),
         'no global row = built-in default (owner only); no public row = nothing added. Only PUBLIC/anon/authenticated entries are removed by 061 step 2; any other browser-reachable grantee makes step 4b abort'
  UNION ALL
  SELECT '07 postgres default ACLs', '07.01',
         CASE WHEN d.revoked_by_step2 THEN 'ESTABLISHED_BY_061' ELSE 'PRECONDITION' END,
         CASE WHEN d.revoked_by_step2 THEN 'FIXED_BY_061' ELSE 'FAIL' END,
         CASE WHEN d.revoked_by_step2 THEN 'NONE' ELSE 'PRIVILEGE' END,
         format('postgres %s %s: %s %s',
                CASE WHEN d.defaclnamespace = 0 THEN 'global' ELSE 'public' END,
                CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
                CASE d.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(d.grantee) END,
                d.privilege_type),
         'explicit pg_default_acl entry',
         CASE WHEN d.revoked_by_step2 THEN 'removed by 061 step 2 (ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... REVOKE ALL)'
              ELSE '061 step 2 does not revoke this grantee; step 4b aborts' END
    FROM postgres_browser_dacl d

  -- ── 08 creators in public and their defaults (061 step 6a) ────────────────
  UNION ALL
  SELECT '08 creators in public', '08.00', 'PRECONDITION',
         CASE WHEN EXISTS (SELECT 1 FROM creator_browser_dacl) THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN EXISTS (SELECT 1 FROM creator_browser_dacl) THEN 'PRIVILEGE' ELSE 'NONE' END,
         'creators other than postgres: no table/sequence default reaching a browser role',
         (SELECT count(*) FROM creators) || ' creator(s): '
           || COALESCE((SELECT string_agg(rolname || ' [' || via || ']', ', ' ORDER BY rolname) FROM creators), 'none'),
         'global and public-schema defaults of every role with effective CREATE on public (061 step 6a); postgres: see 07'
  UNION ALL
  SELECT '08 creators in public', '08.01', 'CURRENT', 'INFO', 'NONE',
         'creator: ' || c.rolname,
         'CREATE on public via ' || c.via,
         'checked by 061 step 6a; a browser-reachable creator is reported in 09'
    FROM creators c
  UNION ALL
  SELECT '08 creators in public', '08.02', 'PRECONDITION', 'FAIL', 'PRIVILEGE',
         format('%s %s %s: %s %s', d.rolname,
                CASE WHEN d.defaclnamespace = 0 THEN 'global' ELSE 'public' END,
                CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
                CASE d.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(d.grantee) END,
                d.privilege_type),
         'explicit pg_default_acl entry of a role that can create in public',
         '061 step 6a aborts; 061 does not alter another role''s defaults'
    FROM creator_browser_dacl d

  -- ── 09 schema public ACL and browser CREATE (061 step 6b) ─────────────────
  UNION ALL
  SELECT '09 schema public', '09.00', 'PRECONDITION',
         CASE WHEN (SELECT public_oid FROM params) IS NULL THEN 'UNKNOWN'
              WHEN EXISTS (SELECT 1 FROM browser_creators) THEN 'FAIL' ELSE 'PASS' END,
         CASE WHEN (SELECT public_oid FROM params) IS NULL THEN 'VISIBILITY'
              WHEN EXISTS (SELECT 1 FROM browser_creators) THEN 'PRIVILEGE' ELSE 'NONE' END,
         'no browser-reachable role can create in public',
         (SELECT count(*) FROM browser_creators) || ' browser-reachable creator(s)',
         '061 step 6b aborts otherwise (062 revokes PUBLIC/anon/authenticated CREATE, but runs after 061)'
  UNION ALL
  SELECT '09 schema public', '09.01', 'PRECONDITION', 'FAIL', 'PRIVILEGE',
         'browser-reachable creator: ' || pg_get_userbyid(b.roleid),
         'has_schema_privilege(public, CREATE) = true',
         '061 step 6b aborts'
    FROM browser_creators b
  UNION ALL
  SELECT '09 schema public', '09.02', 'CURRENT', 'INFO', 'NONE',
         'public ACL: ' || (CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
           || ' ' || a.privilege_type,
         'schema owner ' || pg_get_userbyid(a.nspowner),
         'USAGE for anon/authenticated is kept by 061 (PostgREST resolves the two user RPCs)'
    FROM public_acl a

  -- ── 10 service_role keeps its authority (061 steps 0b and 5) ──────────────
  UNION ALL
  SELECT '10 service_role preservation', '10.00', 'PRECONDITION',
         CASE WHEN (SELECT svc_oid FROM params) IS NULL THEN 'UNKNOWN'
              WHEN EXISTS (SELECT 1 FROM svc_lost_tab WHERE NOT payment_exception)
                OR EXISTS (SELECT 1 FROM svc_lost_col WHERE NOT payment_exception) THEN 'FAIL'
              ELSE 'PASS' END,
         CASE WHEN (SELECT svc_oid FROM params) IS NULL THEN 'VISIBILITY'
              WHEN EXISTS (SELECT 1 FROM svc_lost_tab WHERE NOT payment_exception)
                OR EXISTS (SELECT 1 FROM svc_lost_col WHERE NOT payment_exception) THEN 'PRIVILEGE'
              ELSE 'NONE' END,
         'service_role authority that would vanish with the PUBLIC/anon/authenticated grants',
         (SELECT count(*) FROM svc_lost_tab WHERE NOT payment_exception) || ' table privilege(s), '
           || (SELECT count(*) FROM svc_lost_col WHERE NOT payment_exception) || ' column privilege(s)',
         'must be 0 or 061 step 5 aborts. Simulated: kept = ownership, superuser, pg_read/write_all_data, or an ACL entry for a role service_role inherits other than PUBLIC/anon/authenticated'
  UNION ALL
  SELECT '10 service_role preservation', '10.01',
         CASE WHEN l.payment_exception THEN 'ESTABLISHED_BY_061' ELSE 'PRECONDITION' END,
         CASE WHEN l.payment_exception THEN 'FIXED_BY_061' ELSE 'FAIL' END,
         CASE WHEN l.payment_exception THEN 'NONE' ELSE 'PRIVILEGE' END,
         'service_role ' || l.priv || ' on public.' || l.relname,
         'held now only through PUBLIC / anon / authenticated',
         CASE WHEN l.payment_exception
              THEN 'removed by 061 on purpose: restores migration 040 (payment ledger writes are RPC-only)'
              ELSE '061 step 5 aborts' END
    FROM svc_lost_tab l
  UNION ALL
  SELECT '10 service_role preservation', '10.02',
         CASE WHEN l.payment_exception THEN 'ESTABLISHED_BY_061' ELSE 'PRECONDITION' END,
         CASE WHEN l.payment_exception THEN 'FIXED_BY_061' ELSE 'FAIL' END,
         CASE WHEN l.payment_exception THEN 'NONE' ELSE 'PRIVILEGE' END,
         'service_role ' || l.priv || ' on columns of public.' || l.relname,
         string_agg(l.attname, ',' ORDER BY l.attnum),
         CASE WHEN l.payment_exception
              THEN 'removed by 061 on purpose: restores migration 040'
              ELSE '061 step 5 aborts' END
    FROM svc_lost_col l
   GROUP BY l.relname, l.priv, l.payment_exception
  UNION ALL
  SELECT '10 service_role preservation', '10.03', 'CURRENT', 'INFO', 'NONE',
         'service_role on public.' || n.relname,
         string_agg(n.priv, ',' ORDER BY n.priv),
         'effective table authority now (listed relations)'
    FROM svc_tab_now n
   GROUP BY n.relname

  -- ── 11 object evidence for 061 / 062 / 063 ────────────────────────────────
  UNION ALL
  SELECT '11 061-063 objects', '11.01', 'BASELINE', 'INFO', 'NONE',
         f.mig || ': public.' || f.proname,
         CASE WHEN f.n = 0 THEN 'absent' ELSE 'present (' || f.n || ' overload(s))' END,
         'object evidence, independent of the ledger (compared with it in 01.09)'
    FROM fn_present f
  UNION ALL
  SELECT '11 061-063 objects', '11.02', 'BASELINE', 'INFO', 'NONE', '061 effects',
         CASE WHEN EXISTS (SELECT 1 FROM fixed_browser) OR EXISTS (SELECT 1 FROM postgres_browser_dacl)
              THEN 'not in effect: direct browser grants on listed relations or postgres browser defaults are present'
              ELSE 'consistent with 061 applied, or with such grants never having existed' END,
         '061 creates no object; absent grants alone cannot prove it was applied'

  -- ── 12 default ACL inventory (all roles; tables, sequences, functions) ────
  UNION ALL
  SELECT '12 default ACL inventory', '12.01', 'CURRENT', 'INFO', 'NONE',
         format('%s %s %s', pg_get_userbyid(d.defaclrole),
                CASE WHEN d.defaclnamespace = 0 THEN 'global'
                     ELSE 'schema ' || d.defaclnamespace::regnamespace::text END,
                CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
                                     WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types'
                                     WHEN 'n' THEN 'schemas' WHEN 'L' THEN 'large objects'
                                     ELSE d.defaclobjtype::text END),
         string_agg((CASE d.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(d.grantee) END)
                    || '=' || d.privilege_type, ', '),
         CASE WHEN bool_or(d.grantee = 0 OR d.grantee IN (SELECT roleid FROM browser_roles))
              THEN 'grants to PUBLIC or a browser-reachable role'
              ELSE 'no browser-reachable grantee' END
    FROM dacl d
   GROUP BY d.defaclrole, d.defaclnamespace, d.defaclobjtype
  UNION ALL
  SELECT '12 default ACL inventory', '12.02', 'CURRENT', 'INFO', 'NONE',
         format('%s: new %s in public', c.rolname, t.label),
         format('global (%s): %s | public-schema addition: %s',
                CASE WHEN g.defaclacl IS NULL THEN 'built-in' ELSE 'explicit' END,
                COALESCE((SELECT string_agg((CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END)
                                            || '=' || x.privilege_type, ', ')
                            FROM aclexplode(COALESCE(g.defaclacl, acldefault(t.acltype, c.roleid))) x), 'none'),
                COALESCE((SELECT string_agg((CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END)
                                            || '=' || x.privilege_type, ', ')
                            FROM aclexplode(s.defaclacl) x), 'none')),
         CASE WHEN t.objtype = 'f'
              THEN 'functions: not a 061 precondition; 062/063 revoke EXECUTE explicitly'
              ELSE 'tables/sequences: decided in 07 (postgres) and 08 (other creators)' END
    FROM creators c
    CROSS JOIN (VALUES ('r'::"char", 'r'::"char", 'tables'),
                       ('S'::"char", 's'::"char", 'sequences'),
                       ('f'::"char", 'f'::"char", 'functions')) t(objtype, acltype, label)
    CROSS JOIN params pa
    LEFT JOIN pg_default_acl g
           ON g.defaclrole = c.roleid AND g.defaclnamespace = 0 AND g.defaclobjtype = t.objtype
    LEFT JOIN pg_default_acl s
           ON s.defaclrole = c.roleid AND s.defaclnamespace = pa.public_oid AND s.defaclobjtype = t.objtype
),
flags AS (
  SELECT COALESCE(bool_or(status = 'FAIL' AND blocker_class = 'SCRIPT'), false)           AS f_script,
         COALESCE(bool_or(check_id = '01.01' AND status <> 'PASS'), true)                  AS f_ledger,
         COALESCE(bool_or(status = 'FAIL' AND blocker_class = 'INCONSISTENT'), false)     AS f_inconsistent,
         COALESCE(bool_or(status = 'FAIL' AND blocker_class = 'ALREADY_RECORDED'), false) AS f_recorded,
         COALESCE(bool_or(status = 'FAIL' AND blocker_class = 'PREREQUISITE'), false)     AS f_prereq,
         COALESCE(bool_or(status = 'FAIL' AND blocker_class = 'PRIVILEGE'), false)        AS f_privilege,
         COALESCE(bool_or(status = 'FAIL'), false)                                         AS f_any_fail,
         COALESCE(bool_or(status = 'UNKNOWN'), false)                                      AS f_unknown,
         COALESCE(bool_or(check_id = '01.08' AND subject LIKE 'ledger: 061_%' AND status = 'PASS'), false) AS f_061_pending
    FROM report
)
SELECT section, check_id, phase, status, blocker_class, subject, observed, expectation
  FROM (
    SELECT * FROM report
    UNION ALL
    SELECT '99 verdict', '99.01', 'SUMMARY',
           CASE WHEN f.f_script THEN 'FAIL'
                WHEN f.f_ledger THEN 'UNKNOWN'
                WHEN f.f_any_fail THEN 'FAIL'
                WHEN f.f_unknown OR NOT f.f_061_pending THEN 'UNKNOWN'
                ELSE 'PASS' END,
           CASE WHEN f.f_script THEN 'SCRIPT'
                WHEN f.f_ledger THEN 'VISIBILITY'
                WHEN f.f_inconsistent THEN 'INCONSISTENT'
                WHEN f.f_recorded THEN 'ALREADY_RECORDED'
                WHEN f.f_prereq THEN 'PREREQUISITE'
                WHEN f.f_privilege THEN 'PRIVILEGE'
                WHEN f.f_any_fail THEN 'UNCLASSIFIED'
                WHEN f.f_unknown OR NOT f.f_061_pending THEN 'VISIBILITY'
                ELSE 'NONE' END,
           CASE WHEN f.f_script THEN 'INVALID RUN: not read-only'
                WHEN f.f_ledger THEN 'INCOMPLETE ACCESS/EVIDENCE: migration ledger missing or unreadable'
                WHEN f.f_inconsistent THEN 'INCONSISTENT BASELINE: ledger, repository and objects disagree'
                WHEN f.f_recorded THEN 'ALREADY RECORDED: 061 is in the ledger; run a separate post-application assessment, do not re-apply'
                WHEN f.f_prereq THEN 'BLOCKED: PREREQUISITES NOT ESTABLISHED'
                WHEN f.f_privilege THEN 'BLOCKED BY PRIVILEGES'
                WHEN f.f_any_fail THEN 'BLOCKED: unclassified FAIL (review)'
                WHEN f.f_unknown OR NOT f.f_061_pending THEN 'INCOMPLETE ACCESS/EVIDENCE'
                ELSE 'PASS FOR STAGING REHEARSAL PLANNING: 061 pending, prerequisites recorded' END,
           (SELECT format('classes: script=%s ledger_unavailable=%s inconsistent=%s already_recorded=%s prerequisite=%s privilege=%s unknown=%s | FAIL=%s UNKNOWN=%s WARN=%s FIXED_BY_061=%s CONFIRM=%s',
                          f.f_script::text, f.f_ledger::text, f.f_inconsistent::text, f.f_recorded::text,
                          f.f_prereq::text, f.f_privilege::text, f.f_unknown::text,
                          count(*) FILTER (WHERE status = 'FAIL'),
                          count(*) FILTER (WHERE status = 'UNKNOWN'),
                          count(*) FILTER (WHERE status = 'WARN'),
                          count(*) FILTER (WHERE status = 'FIXED_BY_061'),
                          count(*) FILTER (WHERE status = 'CONFIRM'))
              FROM report),
           'Only the subject "PASS FOR STAGING REHEARSAL PLANNING" is a pass. It means the observed preconditions hold; 061''s postconditions are proven only by its own assertions during the rehearsal. CONFIRM rows need the operator. A run without this row, or with any error, is not a pass.'
      FROM flags f
  ) z
 ORDER BY section, check_id,
          CASE status WHEN 'FAIL' THEN 0 WHEN 'UNKNOWN' THEN 1 WHEN 'WARN' THEN 2 WHEN 'CONFIRM' THEN 3
                      WHEN 'FIXED_BY_061' THEN 4 WHEN 'PASS' THEN 5 ELSE 6 END,
          subject;

ROLLBACK;
