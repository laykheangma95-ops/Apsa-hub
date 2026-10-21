/**
 * Migration 061's staging exception (step 6a-x) on a native PostgreSQL server
 * with Supabase's role split (spawned by migration-061-staging-exception-native.test.ts).
 *
 * APSA_TEST_PG_URL must connect as a superuser. 061 is applied as postgres via
 * SET SESSION AUTHORIZATION, so on a cluster bootstrapped as supabase_admin
 * (Supabase's layout: postgres NOSUPERUSER) it runs exactly as on a hosted
 * project; on CI's postgres:17 service postgres is itself the superuser.
 *
 * Template: migrations 001–060, the staging-observed restricted defaults for
 * postgres, and Supabase's managed supabase_admin public defaults
 * (supabase/postgres init-scripts/00000000000000-initial-schema.sql). Each case
 * copies the template, applies its mutation as the superuser, then applies 061
 * in one transaction and checks the outcome. Every abort must leave the
 * catalog byte-identical.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for migration-061-staging-exception");

const MIG_061 = "061_browser_table_authority_hardening.sql";
const MARKER_COMMENT = "APSA STAGING: 061 managed supabase_admin default ACL exception v1";
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const template = `apsa_061x_tpl_${tag}`;
const extraRoles = ["x", "y", "z", "c", "o"].map((r) => `apsa_061x_${r}_${tag}`);
const [ROLE_X, ROLE_Y, ROLE_Z, ROLE_C, ROLE_O] = extraRoles as [
  string,
  string,
  string,
  string,
  string,
];
const databases: string[] = [];

let admin: SQL;
let serverVersion = "";
let postgresIsSuperuser = false;

const urlFor = (db: string) => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${db}`;
  return url.toString();
};

const MARKER = `CREATE SCHEMA apsa_environment AUTHORIZATION postgres;
  COMMENT ON SCHEMA apsa_environment IS '${MARKER_COMMENT}';`;

const MANAGED_DEFAULTS = `
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;`;

const SNAPSHOT = `select
  (select string_agg(defaclrole::regrole || ' ' || defaclnamespace || ' ' || defaclobjtype::text || ' ' || defaclacl::text, ' | ' order by oid) from pg_default_acl) as dacl,
  (select string_agg(c.relname || '=' || coalesce(c.relacl::text, '-'), ';' order by c.relname)
     from pg_class c where c.relnamespace = 'public'::regnamespace) as acl`;

interface Outcome {
  error: string | null;
  before: unknown;
  after: unknown;
  db: SQL;
}

/** Copies the template, applies `mutation` as the superuser, then 061 as postgres in one transaction. */
async function run061(mutation: string): Promise<Outcome> {
  const name = `apsa_061x_${tag}_${databases.length}`;
  databases.push(name);
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const db = new SQL({ url: urlFor(name), max: 1 });
  if (mutation.trim()) await db.unsafe(mutation);
  const [before] = await db.unsafe(SNAPSHOT);
  let error: string | null = null;
  try {
    await db.unsafe("SET SESSION AUTHORIZATION postgres");
    await db.begin(async (tx) => {
      await tx.unsafe(readFileSync(`supabase/migrations/${MIG_061}`, "utf8"));
    });
  } catch (e) {
    error = String((e as Error).message);
  } finally {
    await db.unsafe("RESET SESSION AUTHORIZATION");
  }
  const [after] = await db.unsafe(SNAPSHOT);
  // Role membership is cluster-wide: undo every edge a mutation may add.
  await admin.unsafe(`REVOKE service_role FROM anon; REVOKE ${ROLE_X} FROM anon;
    REVOKE ${ROLE_Z} FROM authenticated;`);
  return { error, before, after, db };
}

async function expectAbort(mutation: string, message: RegExp) {
  const { error, before, after, db } = await run061(mutation);
  expect(error).toMatch(message);
  expect(after).toEqual(before); // nothing half-applied
  await db.close();
}

const has = async (db: SQL, sql: string) =>
  Boolean(((await db.unsafe(sql)) as { v: boolean }[])[0]?.v);

beforeAll(async () => {
  admin = new SQL({ url: ADMIN_URL, max: 1 });
  serverVersion = String(
    ((await admin`select current_setting('server_version') as v`)[0] as { v: string }).v,
  );
  const [me] = (await admin`select rolsuper from pg_roles where rolname = current_user`) as {
    rolsuper: boolean;
  }[];
  if (!me?.rolsuper) throw new Error("APSA_TEST_PG_URL must connect as a superuser");
  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin SUPERUSER; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
    END $$;`);
  for (const role of extraRoles) await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`);
  // Every case starts from browser roles that belong to no role (Supabase's layout).
  const edges = await admin`select count(*)::int as n from pg_auth_members
    where member in (select oid from pg_roles where rolname in ('anon', 'authenticated'))`;
  if ((edges[0] as { n: number }).n !== 0)
    throw new Error("anon/authenticated must not be members of any role");
  const [sa] = (await admin`select rolsuper from pg_roles where rolname = 'supabase_admin'`) as {
    rolsuper: boolean;
  }[];
  if (!sa?.rolsuper)
    throw new Error("supabase_admin must be a superuser (Supabase's managed role)");
  postgresIsSuperuser = Boolean(
    (
      (await admin`select rolsuper from pg_roles where rolname = 'postgres'`)[0] as {
        rolsuper: boolean;
      }
    ).rolsuper,
  );

  await admin.unsafe(`CREATE DATABASE ${template} OWNER postgres`);
  const tpl = new SQL({ url: urlFor(template), max: 1 });
  await tpl.unsafe(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO postgres, anon, authenticated, service_role;
    GRANT ALL ON auth.users TO postgres;
    ${MANAGED_DEFAULTS}`);
  await tpl.unsafe("SET SESSION AUTHORIZATION postgres");
  await tpl.unsafe(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d{3}_.*\.sql$/.test(n))
    .sort()) {
    if (name >= MIG_061) continue;
    try {
      await tpl.begin(async (tx) => {
        await tx.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
      });
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  await tpl.close();
}, 240_000);

afterAll(async () => {
  for (const name of [...databases, template]) {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  for (const role of extraRoles) await admin?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await admin?.close();
});

describe("061 staging exception — native PostgreSQL, Supabase role split", () => {
  it("runs on a real server", () => {
    console.info(
      `[061-staging-exception-native] server_version=${serverVersion} postgres_superuser=${postgresIsSuperuser}`,
    );
    expect(Number.parseInt(serverVersion, 10)).toBeGreaterThanOrEqual(15);
  });

  describe("positive", () => {
    it("marker + exactly Supabase's managed defaults: 061 applies, browser authority is gone", async () => {
      const { error, db } = await run061(MARKER);
      expect(error).toBeNull();
      expect(
        await has(db, "select has_table_privilege('anon','public.customers','SELECT') as v"),
      ).toBe(false);
      expect(
        await has(
          db,
          "select has_table_privilege('authenticated','public.payments','TRUNCATE') as v",
        ),
      ).toBe(false);
      expect(
        await has(
          db,
          "select has_table_privilege('service_role','public.customers','SELECT') as v",
        ),
      ).toBe(true);
      // postgres's own defaults were hardened by step 2; the managed rows are left untouched
      expect(
        await has(
          db,
          `select not exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
             where d.defaclrole = 'postgres'::regrole and d.defaclobjtype in ('r','S')
               and a.grantee in ('anon'::regrole, 'authenticated'::regrole)) as v`,
        ),
      ).toBe(true);
      expect(
        await has(
          db,
          `select count(*) = 2 as v from pg_default_acl
            where defaclrole = 'supabase_admin'::regrole and defaclobjtype in ('r','S')`,
        ),
      ).toBe(true);
      // The documented residual risk, demonstrated: a table supabase_admin
      // creates in public later is browser-readable while the exception holds.
      await db.unsafe(
        "BEGIN; SET LOCAL ROLE supabase_admin; CREATE TABLE public.zz_platform(id int)",
      );
      expect(
        await has(db, "select has_table_privilege('anon','public.zz_platform','SELECT') as v"),
      ).toBe(true);
      await db.unsafe("ROLLBACK");
      await db.close();
    });

    it("marker + Supabase already removed the browser grants: 061 applies (exception unused)", async () => {
      const { error, db } = await run061(`${MARKER}
        ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
        ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;`);
      expect(error).toBeNull();
      await db.close();
    });
  });

  describe("production behaviour unchanged (no valid marker)", () => {
    const blocked =
      /061: a role that can create relations in public has default privileges.*supabase_admin \(public (tables|sequences)\)/;
    it("no marker: aborts at 6a exactly as reviewed", () => expectAbort("", blocked));
    it("marker comment differs by one character: aborts", () =>
      expectAbort(MARKER.replace("v1'", "v2'"), blocked));
    it("marker schema without comment: aborts", () =>
      expectAbort("CREATE SCHEMA apsa_environment AUTHORIZATION postgres;", blocked));
    it("marker schema owned by another role: aborts", () =>
      expectAbort(MARKER.replace("AUTHORIZATION postgres", `AUTHORIZATION ${ROLE_O}`), blocked));
  });

  describe("mutations with the marker present — each must abort", () => {
    const step6a = /061: a role that can create relations in public has default privileges/;
    it("managed tables row also grants PUBLIC", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;`,
        step6a,
      ));
    it("managed sequences row also grants PUBLIC", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE ON SEQUENCES TO PUBLIC;`,
        step6a,
      ));
    it("managed row also grants another browser-reachable role", () =>
      expectAbort(
        `${MARKER} GRANT ${ROLE_X} TO anon;
         ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE_X};`,
        step6a,
      ));
    it("managed row also grants a non-browser role (not the observed row)", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE_Y};`,
        step6a,
      ));
    it("managed row lacks one privilege (not the observed row)", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon;`,
        step6a,
      ));
    it("managed row carries a grant option", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
           GRANT SELECT ON TABLES TO authenticated WITH GRANT OPTION;`,
        step6a,
      ));
    it("supabase_admin also has a GLOBAL default reaching anon", () =>
      expectAbort(
        `${MARKER} ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin GRANT SELECT ON TABLES TO anon;`,
        step6a,
      ));
    it("another creator in public has the same defaults", () =>
      expectAbort(
        `${MARKER} GRANT CREATE ON SCHEMA public TO ${ROLE_C};
         ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLE_C} IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;`,
        step6a,
      ));
    it("existing object: a relation supabase_admin already created in public (step 3)", () =>
      expectAbort(
        `${MARKER} SET ROLE supabase_admin; CREATE TABLE public.zz_platform(id int); RESET ROLE;`,
        /061: relations in public not owned by postgres/,
      ));
    it("existing object: browser authority on a listed relation through another role (step 4a)", () =>
      expectAbort(
        `${MARKER} GRANT ${ROLE_Z} TO authenticated; GRANT SELECT ON public.customers TO ${ROLE_Z};`,
        /061: browser authority remains/,
      ));
    it("role reachability: a browser role can reach service_role (step 4a)", () =>
      expectAbort(`${MARKER} GRANT service_role TO anon;`, /061: browser authority remains/));
    it("postgres's own defaults reach another browser-reachable role (step 4b)", () =>
      expectAbort(
        `${MARKER} GRANT ${ROLE_X} TO anon;
         ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE_X};`,
        /061: default privileges for postgres/,
      ));
    it("a browser role can create in public (step 6b)", () =>
      expectAbort(
        `${MARKER} GRANT CREATE ON SCHEMA public TO authenticated;`,
        /061: browser-reachable roles can create/,
      ));
  });
});
