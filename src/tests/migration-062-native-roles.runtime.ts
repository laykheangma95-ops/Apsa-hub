/**
 * Migration 062's role authority on a REAL PostgreSQL server, by actual calls.
 *
 * migration-062-authority.runtime.ts proves 062 against adverse privilege
 * plantings on PGlite, mostly by asking has_function_privilege. This file
 * proves the outcome on native PostgreSQL (APSA_TEST_PG_URL — PostgreSQL 17
 * in CI; any supported server locally) by switching to each role and CALLING:
 *
 *   - baseline: Supabase's default grants (EXECUTE on new functions and ALL on
 *     new tables for anon, authenticated and service_role), then every
 *     migration in order, through 062, into a fresh throwaway database;
 *   - service_role CAN call every financial entry point, and a real
 *     record_payment_v2 / refund_payment_v2 as service_role writes through the
 *     internal helpers it may not call directly;
 *   - service_role CANNOT call any internal helper or legacy body (42501);
 *   - anon and authenticated CANNOT call any financial function, nor
 *     create_order_v3 — and a refused call with real arguments writes nothing;
 *   - direct table writes stay refused: payments / payment_events /
 *     payment_evidence for service_role (040: RPC-only), and every protected
 *     table for anon and authenticated (061);
 *   - anon and authenticated cannot CREATE in schema public (062).
 *
 * The function families are this file's own list, written independently of
 * 062. Synthetic data only; the database is dropped afterwards.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test ./src/tests/migration-062-native-roles.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for migration-062-native-roles");

const ORG = "aaaaaaaa-0000-4000-8000-000000000062";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000162";

/** Financial entry points: service_role only. */
const ENTRY = [
  "record_payment_v1",
  "record_payment_v2",
  "verify_payment_v1",
  "attach_payment_evidence_v1",
  "refund_payment_v2",
  "reverse_payment_v2",
  "correct_payment_v2",
];
/** Internal helpers and legacy bodies: no caller role, service_role included. */
const INTERNAL = [
  "refund_payment_v1",
  "reverse_payment_v1",
  "correct_payment_v1",
  "record_payment_before_order_v1",
  "verify_payment_before_order_v1",
  "reverse_payment_before_order_v1",
  "refund_payment_before_order_v1",
  "lock_payment_order",
  "sync_order_payment_state",
  "payment_replay_matches_v1",
  "payment_request_digest_v1",
  "transition_order_before_payment_authority_v1",
];
/** Tables a browser role must not write (061), with a column to touch. */
const PROTECTED_TABLES = [
  "orders",
  "order_items",
  "inventory_movements",
  "payments",
  "payment_events",
  "payment_evidence",
  "audit_logs",
  "rate_limit_buckets",
  "memberships",
];
/** Payment ledger tables: RPC-only, even for service_role (040). */
const LEDGER_TABLES = ["payments", "payment_events", "payment_evidence"];

const dbName = `apsa_062_roles_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;
let serverVersion = "";

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 4 });
  serverVersion = ((await sql`select current_setting('server_version') as v`)[0] as { v: string })
    .v;

  // Roles are cluster-wide: created only if absent. Default privileges are
  // per database: Supabase's defaults for objects postgres creates in public.
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  const migrations = readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort();
  // This suite pins #121's schema: through migration 062.
  expect(migrations.at(-1)).toBe("062_financial_replay_refund_audit_atomicity.sql");
  for (const name of migrations) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  await sql`insert into auth.users(id,email) values(${ACTOR},'roles062@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'R','R','roles-062',${ACTOR})`;
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Run `statement` as `role` in its own transaction: "ok" + rows, or the SQLSTATE. */
async function as(
  role: string,
  statement: string,
  params: unknown[] = [],
): Promise<{ state: string; rows: Json[] }> {
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      return (await tx.unsafe(statement, params as never[])) as Json[];
    });
    return { state: "ok", rows: [...rows] };
  } catch (error) {
    const e = error as { errno?: string; code?: string };
    return { state: e.errno ?? e.code ?? "error", rows: [] };
  }
}

/** Every public overload of `name`, as a call with typed NULL arguments. */
async function nullCalls(name: string): Promise<{ sig: string; call: string }[]> {
  const rows = (await sql`
    select p.oid::regprocedure::text as sig,
           coalesce((select string_agg(format('NULL::%s', format_type(t, null)), ',' order by i)
                       from unnest(p.proargtypes) with ordinality as a(t, i)), '') as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = ${name}`) as { sig: string; args: string }[];
  return rows.map((r) => ({ sig: r.sig, call: `select public.${name}(${r.args}) as result` }));
}

async function newOrder(total = 10000): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
    values(${id},${ORG},${id},'MANUAL','USD',${total},${total},${ACTOR})`;
  return id;
}

async function ledger(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const table of ["orders", "payments", "payment_events", "payment_evidence", "audit_logs"]) {
    out.push(
      table,
      ...((await sql.unsafe(`select to_jsonb(t) as r from ${table} t order by 1`)) as Json[]).map(
        (row) => row["r"],
      ),
    );
  }
  return out;
}

// ── the suite ────────────────────────────────────────────────────────────────

describe(`migration 062 role authority on native PostgreSQL`, () => {
  it("runs on a real server, through migration 062", () => {
    // Reported so the run records which major version proved it.
    console.info(`[migration-062-native-roles] server_version=${serverVersion}`);
    expect(Number.parseInt(serverVersion, 10)).toBeGreaterThanOrEqual(15);
  });

  it("every listed function exists, one overload per entry point", async () => {
    for (const name of ENTRY) expect((await nullCalls(name)).length).toBe(1);
    for (const name of INTERNAL) expect((await nullCalls(name)).length).toBeGreaterThanOrEqual(1);
  });

  it("service_role can call every financial entry point (no 42501)", async () => {
    for (const name of ENTRY) {
      for (const { sig, call } of await nullCalls(name)) {
        const { state } = await as("service_role", call);
        expect({ sig, refused: state === "42501" }).toEqual({ sig, refused: false });
      }
    }
  });

  it("service_role cannot call any internal helper or legacy body (42501)", async () => {
    for (const name of INTERNAL) {
      for (const { sig, call } of await nullCalls(name)) {
        expect({ sig, state: (await as("service_role", call)).state }).toEqual({
          sig,
          state: "42501",
        });
      }
    }
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} cannot call any financial function or create_order_v3 (42501)`, async () => {
      for (const name of [...ENTRY, ...INTERNAL, "create_order_v3"]) {
        const calls = await nullCalls(name);
        expect(calls.length).toBeGreaterThan(0);
        for (const { sig, call } of calls) {
          expect({ sig, state: (await as(role, call)).state }).toEqual({ sig, state: "42501" });
        }
      }
    });

    it(`${role}: a real record_payment_v2 call is refused and writes nothing`, async () => {
      const order = await newOrder();
      const before = await ledger();
      const { state } = await as(
        role,
        `select public.record_payment_v2($1::uuid,$2::uuid,$3::uuid,'cash',500::bigint,null,$4,null) as result`,
        [ORG, order, ACTOR, `native-${role}-${crypto.randomUUID()}`],
      );
      expect(state).toBe("42501");
      expect(await ledger()).toEqual(before);
    });

    it(`${role} cannot read or write protected tables directly, nor CREATE in schema public`, async () => {
      for (const table of PROTECTED_TABLES) {
        expect({
          table,
          state: (await as(role, `select 1 from public.${table} limit 1`)).state,
        }).toEqual({ table, state: "42501" });
        expect({ table, state: (await as(role, `delete from public.${table}`)).state }).toEqual({
          table,
          state: "42501",
        });
        expect({
          table,
          state: (await as(role, `insert into public.${table} default values`)).state,
        }).toEqual({ table, state: "42501" });
      }
      expect((await as(role, `create table public.planted_${role}(x int)`)).state).toBe("42501");
      expect(
        (
          await as(
            role,
            `create function public.record_payment_v2(x int) returns int language sql as 'select 1'`,
          )
        ).state,
      ).toBe("42501");
    });
  }

  it("service_role cannot write the payment ledger tables directly (RPC-only)", async () => {
    for (const table of LEDGER_TABLES) {
      expect({
        table,
        state: (await as("service_role", `delete from public.${table}`)).state,
      }).toEqual({ table, state: "42501" });
      expect({
        table,
        state: (await as("service_role", `insert into public.${table} default values`)).state,
      }).toEqual({ table, state: "42501" });
      expect({
        table,
        state: (await as("service_role", `update public.${table} set id = id`)).state,
      }).toEqual({ table, state: "42501" });
    }
  });

  it("service_role's real record → replay → refund writes through the internals it cannot call itself", async () => {
    const order = await newOrder();
    const key = `native-service-${crypto.randomUUID()}`;
    const record = `select public.record_payment_v2($1::uuid,$2::uuid,$3::uuid,'cash',4000::bigint,null,$4,null) as result`;
    const first = await as("service_role", record, [ORG, order, ACTOR, key]);
    expect(first.state).toBe("ok");
    const result = first.rows[0]!["result"] as Json;
    expect(result["status"]).toBe("success");
    const paymentId = result["payment_id"] as string;

    const replay = await as("service_role", record, [ORG, order, ACTOR, key]);
    expect((replay.rows[0]!["result"] as Json)["payment_id"]).toBe(paymentId);
    expect((replay.rows[0]!["result"] as Json)["replayed"]).toBe(true);
    const payments = (await sql`select organization_id, recorded_by, amount_minor::int as amount
      from payments where order_id = ${order}`) as Json[];
    expect([...payments]).toEqual([{ organization_id: ORG, recorded_by: ACTOR, amount: 4000 }]);

    // A refund needs a verified payment: verify through its own entry point.
    const verified = await as(
      "service_role",
      `select public.verify_payment_v1($1::uuid,$2::uuid,$3::uuid,'unverified','staff_confirmed',null,null) as result`,
      [ORG, paymentId, ACTOR],
    );
    expect(verified.state).toBe("ok");
    expect((verified.rows[0]!["result"] as Json)["status"]).toBe("success");
    const refund = await as(
      "service_role",
      `select public.refund_payment_v2($1::uuid,$2::uuid,$3::uuid,1000::bigint,'native check',$4,$5::bigint,$6::uuid[]) as result`,
      [ORG, paymentId, ACTOR, `native-refund-${crypto.randomUUID()}`, 0, `{}`],
    );
    expect(refund.state).toBe("ok");
    expect((refund.rows[0]!["result"] as Json)["status"]).toBe("success");
  });
});
