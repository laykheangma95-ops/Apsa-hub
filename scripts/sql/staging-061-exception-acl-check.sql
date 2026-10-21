-- =============================================================================
-- APSA — STAGING 061 EXCEPTION ACL CHECK  (read-only, owner-run)  v1
--
-- docs/RELEASE_CHECKLIST.md §8b, step 2. Run ONLY against the confirmed
-- STAGING project, as postgres, after the reviewed 061 preflight. NEVER run
-- it against production (production gets no 061 exception).
--
-- The reviewed preflight lists supabase_admin's default privileges by grantee
-- and privilege only (rows 08.02 / 12.01). This check shows each complete
-- supabase_admin default ACL — grantee, grantor, privilege, grant option —
-- and evaluates on it the SAME predicate as migration 061 step 6a-x:
--   * supabase_admin exists and is a superuser;
--   * the row is for schema public (never global) and for tables (r) or
--     sequences (S);
--   * the row's ACL, as a set of (grantee, grantor, privilege, grantable),
--     equals exactly: every privilege the server knows for that kind
--     (tables: SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER, plus
--     MAINTAIN on PostgreSQL 17+; sequences: USAGE SELECT UPDATE) to exactly
--     postgres, anon, authenticated and service_role, granted by
--     supabase_admin, without grant option.
-- The marker schema is not consulted: this check runs BEFORE the marker
-- exists.
--
-- HOW TO RUN: the whole file in one session, e.g.
--   psql -X -v ON_ERROR_STOP=1 --csv -f <this file> -o <output.csv>
-- Valid only with exit 0 and row 99.01 present.
--
-- RESULT (row 99.01): "EXACT MATCH: 2 managed rows" is the only result that
-- allows the §8b procedure to continue; it requires exactly two supabase_admin
-- table/sequence default rows in scope (global or public), both public, one
-- for tables and one for sequences, both matching. Anything else: STOP.
-- One READ ONLY transaction, catalog reads only, then ROLLBACK.
-- =============================================================================

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

WITH params AS (
  SELECT (SELECT oid FROM pg_roles WHERE rolname = 'supabase_admin') AS sa,
         coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = 'supabase_admin'), false) AS sa_super,
         ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
           || CASE WHEN current_setting('server_version_num')::int >= 170000
                   THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END AS table_privs
),
-- supabase_admin's table/sequence defaults in 6a's scope (global or public)
scoped AS (
  SELECT d.oid, d.defaclnamespace, d.defaclobjtype, d.defaclacl
    FROM pg_default_acl d CROSS JOIN params p
   WHERE d.defaclrole = p.sa
     AND d.defaclobjtype IN ('r','S')
     AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
),
actual AS (
  SELECT s.oid AS row_oid, a.grantee, a.grantor, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM scoped s CROSS JOIN LATERAL aclexplode(s.defaclacl) a
),
expected AS (
  SELECT s.oid AS row_oid, g.oid AS grantee, p.sa AS grantor, priv.privilege, false AS grantable
    FROM scoped s
    CROSS JOIN params p
    JOIN pg_roles g ON g.rolname IN ('postgres', 'anon', 'authenticated', 'service_role')
    CROSS JOIN unnest(CASE s.defaclobjtype WHEN 'r' THEN p.table_privs
                           ELSE ARRAY['USAGE','SELECT','UPDATE'] END) AS priv(privilege)
),
extra AS (SELECT * FROM actual EXCEPT SELECT * FROM expected),
missing AS (SELECT * FROM expected EXCEPT SELECT * FROM actual),
verdict AS (
  SELECT s.oid, s.defaclnamespace, s.defaclobjtype,
         (p.sa_super
          AND s.defaclnamespace = 'public'::regnamespace
          AND NOT EXISTS (SELECT 1 FROM extra e WHERE e.row_oid = s.oid)
          AND NOT EXISTS (SELECT 1 FROM missing m WHERE m.row_oid = s.oid)) AS exact
    FROM scoped s CROSS JOIN params p
),
fmt AS (
  SELECT x.row_oid,
         format('%s:%s:by %s:%s',
                CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
                x.privilege, pg_get_userbyid(x.grantor),
                CASE WHEN x.grantable THEN 'WITH GRANT OPTION' ELSE 'no grant option' END) AS entry
    FROM (SELECT * FROM actual) x
),
report(section, check_id, status, subject, observed) AS (
  SELECT '00 session', '00.01',
         CASE WHEN current_setting('transaction_read_only') = 'on' THEN 'OK' ELSE 'STOP' END,
         'transaction_read_only', current_setting('transaction_read_only')
  UNION ALL
  SELECT '00 session', '00.02', 'INFO', 'server_version / current_user',
         current_setting('server_version') || ' / ' || current_user::text
  UNION ALL
  SELECT '01 role', '01.01',
         CASE WHEN p.sa IS NULL OR NOT p.sa_super THEN 'STOP' ELSE 'OK' END,
         'supabase_admin', CASE WHEN p.sa IS NULL THEN 'missing'
                                ELSE 'superuser=' || p.sa_super::text END
    FROM params p
  UNION ALL
  SELECT '10 rows', '10.01',
         CASE WHEN v.exact THEN 'EXACT' ELSE 'STOP' END,
         format('supabase_admin %s %s',
                CASE v.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
                CASE v.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END),
         (SELECT count(*) || ' entries: ' || string_agg(f.entry, '; ' ORDER BY f.entry)
            FROM fmt f WHERE f.row_oid = v.oid)
    FROM verdict v
  UNION ALL
  SELECT '11 differences', '11.01', 'STOP',
         format('extra entry in supabase_admin %s %s',
                CASE s.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
                CASE s.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END),
         format('%s:%s:by %s:%s',
                CASE e.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END,
                e.privilege, pg_get_userbyid(e.grantor),
                CASE WHEN e.grantable THEN 'WITH GRANT OPTION' ELSE 'no grant option' END)
    FROM extra e JOIN scoped s ON s.oid = e.row_oid
  UNION ALL
  SELECT '11 differences', '11.02', 'STOP',
         format('missing entry in supabase_admin %s %s',
                CASE s.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
                CASE s.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END),
         format('%s:%s:by %s:no grant option',
                pg_get_userbyid(m.grantee), m.privilege, pg_get_userbyid(m.grantor))
    FROM missing m JOIN scoped s ON s.oid = m.row_oid
)
SELECT section, check_id, status, subject, observed
  FROM (
    SELECT * FROM report
    UNION ALL
    SELECT '99 result', '99.01',
           CASE WHEN ok THEN 'EXACT MATCH' ELSE 'STOP' END,
           CASE WHEN ok THEN 'EXACT MATCH: 2 managed rows'
                ELSE 'STOP: supabase_admin defaults are not exactly the managed set' END,
           format('rows in scope=%s, exact public tables=%s, exact public sequences=%s, read_only=%s',
                  (SELECT count(*) FROM verdict),
                  (SELECT count(*) FROM verdict WHERE exact AND defaclobjtype = 'r'),
                  (SELECT count(*) FROM verdict WHERE exact AND defaclobjtype = 'S'),
                  current_setting('transaction_read_only'))
      FROM (SELECT current_setting('transaction_read_only') = 'on'
                   AND (SELECT sa_super FROM params)
                   AND (SELECT count(*) FROM verdict) = 2
                   AND (SELECT count(*) FROM verdict WHERE exact AND defaclobjtype = 'r') = 1
                   AND (SELECT count(*) FROM verdict WHERE exact AND defaclobjtype = 'S') = 1 AS ok) z
  ) r
 ORDER BY section, check_id, subject, observed;

ROLLBACK;
