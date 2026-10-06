/**
 * Shared PGlite environment and detectors for the migration 061 runtime tests
 * (browser-table-authority.runtime.ts, browser-table-authority-roles.runtime.ts).
 *
 * The detectors here are written independently of 061's own post-conditions
 * (role reachability is walked in TypeScript, privileges are asked one by one),
 * so a defect in the migration's SQL cannot hide behind the same defect here.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

export const MIGRATION_061 = "061_browser_table_authority_hardening.sql";

export type Baseline = "restricted" | "permissive";

/**
 * Every migration before 061, applied as `postgres` under one of two default-
 * privilege baselines:
 *   restricted — the staging-observed Dxtm inheritance for anon/authenticated/service_role;
 *   permissive — ALL for every role plus PUBLIC, a global default and column grants.
 */
export async function migratedThrough060(baseline: Baseline): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  if (baseline === "restricted") {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
  } else {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON TABLES TO PUBLIC, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon;
    `);
  }
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d{3}_.*\.sql$/.test(n))
    .sort()) {
    if (name >= MIGRATION_061) continue; // 061 (and anything later) is applied by the test
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      await db.close();
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  if (baseline === "permissive") {
    // Whatever earlier migrations revoked, assume the live project re-opened it.
    await db.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC, anon, authenticated;
      GRANT UPDATE (organization_id) ON public.customers TO authenticated;
      GRANT SELECT (cost_amount) ON public.product_variants TO anon;
    `);
  }
  // Scratch schema a browser role could create objects in — the only way to
  // exercise REFERENCES and TRIGGER from the role itself.
  await db.exec(`
    CREATE SCHEMA scratch;
    GRANT USAGE, CREATE ON SCHEMA scratch TO anon, authenticated;
    CREATE FUNCTION scratch.noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    GRANT EXECUTE ON FUNCTION scratch.noop() TO anon, authenticated;
  `);
  return db;
}

export const pgVersion = async (db: PGlite) =>
  (await db.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v")).rows[0]!
    .v;

/** anon, authenticated, and every role they are members of — any edge, any depth. */
export async function browserReachableRoles(db: PGlite): Promise<string[]> {
  const edges = (
    await db.query<{ member: string; role: string }>(
      `SELECT m.member::regrole::text AS member, m.roleid::regrole::text AS role FROM pg_auth_members m`,
    )
  ).rows;
  const reached = new Set(["anon", "authenticated"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (reached.has(e.member) && !reached.has(e.role)) {
        reached.add(e.role);
        grew = true;
      }
    }
  }
  return [...reached].sort();
}

/**
 * Every privilege a browser-reachable role effectively holds on a relation,
 * column or sequence in `public` (has_*_privilege includes PUBLIC and inherited
 * grants). Empty means no browser authority at all.
 */
export async function effectiveBrowserAuthority(db: PGlite): Promise<string[]> {
  const tablePrivs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  if ((await pgVersion(db)) >= 170000) tablePrivs.push("MAINTAIN");
  const out: string[] = [];
  for (const role of await browserReachableRoles(db)) {
    const rows = (
      await db.query<{ what: string }>(
        `SELECT format('%s %s on %s', $1::text, p, c.relname) AS what
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest($2::text[]) p
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
           AND has_table_privilege($1::text, c.oid, p)
         UNION ALL
         SELECT format('%s %s on %s.%s', $1::text, p, c.relname, a.attname)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped,
         unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
           AND has_column_privilege($1::text, c.oid, a.attnum, p)
         UNION ALL
         SELECT format('%s %s on sequence %s', $1::text, p, c.relname)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         unnest(ARRAY['USAGE','SELECT','UPDATE']) p
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND has_sequence_privilege($1::text, c.oid, p)`,
        [role, tablePrivs],
      )
    ).rows;
    out.push(...rows.map((r) => r.what));
  }
  return out.sort();
}

/** service_role's effective table, column and sequence authority in `public`. */
export async function serviceRoleAuthority(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ what: string }>(
      `SELECT format('%s %s', p, c.relname) AS what
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
         AND has_table_privilege('service_role', c.oid, p)
       UNION ALL
       SELECT format('%s %s.%s', p, c.relname, a.attname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped,
       unnest(ARRAY['SELECT','INSERT','UPDATE']) p
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
         AND has_column_privilege('service_role', c.oid, a.attnum, p)
       UNION ALL
       SELECT format('%s sequence %s', p, c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       unnest(ARRAY['USAGE','SELECT','UPDATE']) p
       WHERE n.nspname = 'public' AND c.relkind = 'S'
         AND has_sequence_privilege('service_role', c.oid, p)`,
    )
  ).rows;
  return rows.map((r) => r.what).sort();
}
