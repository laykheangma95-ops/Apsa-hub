/**
 * Migration 048 against a REAL PostgreSQL (PGlite): every migration, in order.
 * Spawned by service-role-table-grants.test.ts. Never touches hosted Supabase.
 *
 * Two environments are built, because the bug 048 fixes exists only in one:
 *
 *   RESTRICTED — Supabase's newer project default: new `public` tables get only
 *                Dxtm (TRUNCATE / REFERENCES / TRIGGER) for anon, authenticated
 *                and service_role. No SELECT/INSERT/UPDATE/DELETE.
 *   PERMISSIVE — the older default production was created under: full privileges
 *                for all three roles on every new table.
 *
 * Proves, per relation in `public` (so an object nobody listed fails the test):
 *   - before 048, the restricted environment reproduces the staging failure;
 *   - after 048, service_role holds EXACTLY the reviewed matrix;
 *   - the payment ledger stays read-only and TRUNCATE-free for service_role;
 *   - webhook_event_receipts is exactly SELECT/INSERT/DELETE (never UPDATE);
 *   - anon and authenticated are byte-for-byte unchanged by 048 and hold no
 *     table privilege at all in the restricted environment;
 *   - a table created after 048 gets nothing (no blanket / future access);
 *   - re-running 048 changes nothing;
 *   - in the permissive environment 048 changes nothing for ANY role.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import {
  EXPECTED_SERVICE_ROLE_PRIVILEGES,
  PAYMENT_LEDGER,
  type Privilege,
} from "./helpers/service-role-grant-matrix";

const MIGRATION_048 = "048_service_role_table_grants.sql";
const ROLES = ["anon", "authenticated", "service_role"] as const;
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

type Snapshot = Record<string, Record<string, string[]>>; // role → relation → privileges

async function buildEnvironment(defaults: "restricted" | "permissive", through048: boolean) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
  `);
  if (defaults === "restricted") {
    await db.exec(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated, service_role;`,
    );
  } else {
    await db.exec(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT ALL ON TABLES TO anon, authenticated, service_role;`,
    );
  }
  const files = readdirSync("supabase/migrations")
    .filter((n) => /^\d{3}_.*\.sql$/.test(n))
    .sort();
  for (const name of files) {
    if (name === MIGRATION_048 && !through048) continue;
    if (name > MIGRATION_048) continue; // later migrations are not this file's business
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      await db.close();
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  return db;
}

async function snapshot(db: PGlite): Promise<Snapshot> {
  const rels = await db.query<{ relname: string; oid: number }>(
    `SELECT c.relname, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v') ORDER BY c.relname`,
  );
  const out: Snapshot = {};
  for (const role of ROLES) {
    out[role] = {};
    for (const rel of rels.rows) {
      const held: string[] = [];
      for (const priv of PRIVS) {
        const r = await db.query<{ h: boolean }>(
          `SELECT has_table_privilege('${role}', ${rel.oid}::oid, '${priv}') AS h`,
        );
        if (r.rows[0]!.h) held.push(priv);
      }
      out[role]![rel.relname] = held;
    }
  }
  return out;
}

const dml = (privs: string[]) => privs.filter((p) => p !== "TRUNCATE").sort();

describe("RESTRICTED default privileges (the staging environment)", () => {
  let before: PGlite;
  let after: PGlite;
  let beforeSnap: Snapshot;
  let afterSnap: Snapshot;

  beforeAll(async () => {
    before = await buildEnvironment("restricted", false);
    beforeSnap = await snapshot(before);
    after = await buildEnvironment("restricted", true);
    afterSnap = await snapshot(after);
  }, 120000);
  afterAll(async () => {
    await before.close();
    await after.close();
  });

  it("reproduces the staging failure without 048: service_role cannot read organizations", async () => {
    expect(dml(beforeSnap.service_role!.organizations!)).toEqual([]);
    await before.exec("SET ROLE service_role");
    await expect(before.query("SELECT 1 FROM public.organizations")).rejects.toThrow(
      /permission denied for table organizations/,
    );
    await before.exec("RESET ROLE");
  });

  it("after 048 service_role holds EXACTLY the reviewed matrix on every relation in public", () => {
    const actual: Record<string, string[]> = {};
    for (const [rel, privs] of Object.entries(afterSnap.service_role!)) {
      const d = dml(privs);
      if (d.length > 0) actual[rel] = d;
    }
    const expected: Record<string, string[]> = {};
    for (const [rel, privs] of Object.entries(EXPECTED_SERVICE_ROLE_PRIVILEGES)) {
      expected[rel] = [...(privs as Privilege[])].sort();
    }
    expect(actual).toEqual(expected);
  });

  it("every relation in public is accounted for (an unlisted table or view fails here)", () => {
    const relations = Object.keys(afterSnap.service_role!).sort();
    expect(relations).toEqual(Object.keys(EXPECTED_SERVICE_ROLE_PRIVILEGES).sort());
  });

  it("the payment ledger stays SELECT-only with no TRUNCATE for service_role", () => {
    for (const t of PAYMENT_LEDGER) {
      expect(afterSnap.service_role![t]).toEqual(["SELECT"]);
    }
  });

  it("webhook_event_receipts is exactly SELECT/INSERT/DELETE — never UPDATE — and 048 left it alone", () => {
    expect(dml(afterSnap.service_role!.webhook_event_receipts!)).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
    ]);
    expect(afterSnap.service_role!.webhook_event_receipts).toEqual(
      beforeSnap.service_role!.webhook_event_receipts,
    );
  });

  it("the objects earlier migrations made explicit are byte-for-byte what they were before 048", () => {
    for (const rel of [
      "conversations",
      "messages",
      "conversation_read_markers",
      "conversation_participants",
      "order_payment_totals",
      "rate_limit_buckets",
      "webhook_event_receipts",
    ]) {
      expect(afterSnap.service_role![rel]).toEqual(beforeSnap.service_role![rel]);
    }
  });

  it("anon and authenticated are unchanged by 048 and hold no table privilege at all", () => {
    for (const role of ["anon", "authenticated"] as const) {
      expect(afterSnap[role]).toEqual(beforeSnap[role]);
      for (const [rel, privs] of Object.entries(afterSnap[role]!)) {
        expect({ role, rel, dml: dml(privs) }).toEqual({ role, rel, dml: [] });
      }
    }
  });

  it("service_role can do exactly what the server does — and is refused what 040/045 forbid", async () => {
    await after.exec("SET ROLE service_role");
    await after.query("SELECT 1 FROM public.organizations");
    await after.query("SELECT 1 FROM public.payments");
    await after.query("SELECT 1 FROM public.webhook_event_receipts");
    await expect(after.query("INSERT INTO public.payment_events DEFAULT VALUES")).rejects.toThrow(
      /permission denied/,
    );
    await expect(after.query("UPDATE public.payments SET currency = currency")).rejects.toThrow(
      /permission denied/,
    );
    await expect(after.query("DELETE FROM public.payment_evidence")).rejects.toThrow(
      /permission denied/,
    );
    await expect(after.query("TRUNCATE public.payments")).rejects.toThrow(/permission denied/);
    await expect(
      after.query("UPDATE public.webhook_event_receipts SET provider = provider"),
    ).rejects.toThrow(/permission denied/);
    await after.exec("RESET ROLE");
    await after.exec("SET ROLE anon");
    await expect(after.query("SELECT 1 FROM public.organizations")).rejects.toThrow(
      /permission denied/,
    );
    await after.exec("RESET ROLE");
    await after.exec("SET ROLE authenticated");
    await expect(after.query("SELECT 1 FROM public.memberships")).rejects.toThrow(
      /permission denied/,
    );
    await after.exec("RESET ROLE");
  });

  it("a table created after 048 receives nothing — no blanket or future access", async () => {
    await after.exec("CREATE TABLE public.zz_future_table (id uuid primary key)");
    const snap = await snapshot(after);
    expect(dml(snap.service_role!.zz_future_table!)).toEqual([]);
    await after.exec("SET ROLE service_role");
    await expect(after.query("SELECT 1 FROM public.zz_future_table")).rejects.toThrow(
      /permission denied/,
    );
    await after.exec("RESET ROLE");
    await after.exec("DROP TABLE public.zz_future_table");
  });

  it("re-running 048 changes nothing (idempotent)", async () => {
    const sql = readFileSync(`supabase/migrations/${MIGRATION_048}`, "utf8");
    await after.exec(sql);
    await after.exec(sql);
    expect(await snapshot(after)).toEqual(afterSnap);
  });
});

describe("PERMISSIVE default privileges (the environment production was created under)", () => {
  it("048 changes nothing for any role, and the payment ledger is still write-closed", async () => {
    const before = await buildEnvironment("permissive", false);
    const beforeSnap = await snapshot(before);
    await before.close();
    const after = await buildEnvironment("permissive", true);
    const afterSnap = await snapshot(after);
    await after.close();
    expect(afterSnap).toEqual(beforeSnap);
    for (const t of PAYMENT_LEDGER) {
      expect(dml(afterSnap.service_role![t]!)).toEqual(["SELECT"]);
    }
  }, 120000);
});
