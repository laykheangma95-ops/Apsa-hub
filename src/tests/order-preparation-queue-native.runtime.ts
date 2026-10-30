/**
 * Migration 065 (order_preparation_queue_v1) on NATIVE PostgreSQL — the
 * evidence PGlite cannot give:
 *   - every migration 001–065 applies on a real server with Supabase-style
 *     default privileges (ALL to anon/authenticated on new relations), and 065's
 *     REVOKE really leaves the view unreadable to every browser role;
 *   - the packing classification (needs_packing / packed_needs_delivery) on the
 *     real planner, against order_currently_packed_v1 itself;
 *   - large-tenant cost: EXPLAIN (ANALYZE, BUFFERS) of the count and the first
 *     page for both packing views, and of the SQL shape behind Waiting for pickup.
 *     Timings are printed, not asserted (they belong to this machine); the
 *     rows each plan returns are asserted.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test ./src/tests/order-preparation-queue-native.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for order-preparation-queue-native");

const MIGRATION_065 = "065_order_preparation_queue.sql";
const ORG = "aaaaaaaa-0000-4000-8000-000000000065";
const BIG = "bbbbbbbb-0000-4000-8000-000000000065";
const OTHER = "cccccccc-0000-4000-8000-000000000065";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000165";

const dbName = `apsa_065_native_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;
let serverVersion = "";

type Row = Record<string, unknown>;

/** One statement as `role` in its own transaction. */
async function as(role: string, statement: string, params: unknown[] = []): Promise<Row[]> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return (await tx.unsafe(statement, params as never[])) as Row[];
  })) as Row[];
}

/** Fixture writes with triggers suspended (status columns belong to their domains). */
async function raw(statement: string, params: unknown[] = []): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica");
    await tx.unsafe(statement, params as never[]);
  });
}

let seq = 0;
async function order(org: string, lifecycle: string, fulfillment: string): Promise<string> {
  seq += 1;
  const id = crypto.randomUUID();
  await raw(
    `insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,
       created_by,created_at,lifecycle_status,payment_status,fulfillment_status)
     values($1,$2,$3,'MANUAL','USD',1000,1000,$4,
       timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => $5),$6,'paid',$7)`,
    [id, org, `N65-${seq}`, OWNER, seq, lifecycle, fulfillment],
  );
  return id;
}
async function delivery(org: string, orderId: string, status: string, at: string, reason?: string) {
  const id = crypto.randomUUID();
  await raw(
    `insert into deliveries(id,organization_id,order_id,provider_name,status,created_by,created_at,updated_at)
     values($1,$2,$3,'Courier',$4,$5,$6,$6)`,
    [id, org, orderId, status, OWNER, at],
  );
  await raw(
    `insert into delivery_status_history(organization_id,delivery_id,from_status,to_status,changed_by,reason,created_at)
     values($1,$2,null,$3,$4,$5,$6)`,
    [org, id, status, OWNER, reason ?? null, at],
  );
  return id;
}
async function history(
  org: string,
  orderId: string,
  from: string,
  to: string,
  at: string,
  reason: string | null,
) {
  await raw(
    `insert into order_status_history(organization_id,order_id,axis,from_status,to_status,changed_by,reason,changed_at)
     values($1,$2,'fulfillment',$3,$4,$5,$6,$7)`,
    [org, orderId, from, to, OWNER, reason, at],
  );
}

async function states(org: string): Promise<Map<string, string>> {
  const rows = await as(
    "service_role",
    "select id, preparation_state from order_preparation_queue_v1 where organization_id = $1",
    [org],
  );
  return new Map(rows.map((r) => [String(r["id"]), String(r["preparation_state"])]));
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 4 });
  serverVersion = String(
    ((await sql`select current_setting('server_version') as v`)[0] as Row)["v"],
  );
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
    .filter((n) => /^\d+.*\.sql$/.test(n) && n <= MIGRATION_065)
    .sort();
  expect(migrations.at(-1)).toBe(MIGRATION_065);
  for (const name of migrations) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  await sql`insert into auth.users(id,email) values(${OWNER},'owner065@test.invalid')`;
  for (const [org, slug] of [
    [ORG, "n65-a"],
    [BIG, "n65-big"],
    [OTHER, "n65-other"],
  ]) {
    await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
      values(${org},${slug},${slug},${slug},${OWNER})`;
  }
}, 240_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

describe("migration 065 on native PostgreSQL", () => {
  it("applies after every earlier migration, and the view is server-only", async () => {
    console.info(`[order-preparation-queue-native] PostgreSQL ${serverVersion}`);
    expect(
      await as("service_role", "select count(*)::int as n from order_preparation_queue_v1"),
    ).toEqual([{ n: 0 }]);
    // Supabase-style defaults granted ALL on new relations to the browser roles;
    // 065's REVOKE must have taken it back.
    for (const role of ["anon", "authenticated"]) {
      let error = "";
      try {
        await as(role, "select 1 from order_preparation_queue_v1 limit 1");
      } catch (caught) {
        error = String((caught as Error).message);
      }
      expect({ role, error }).toEqual({ role, error: expect.stringMatching(/permission denied/) });
    }
    const grants = await sql`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'order_preparation_queue_v1'
        and grantee in ('anon','authenticated','PUBLIC','service_role')
      order by grantee, privilege_type`;
    expect(grants).toEqual([{ grantee: "service_role", privilege_type: "SELECT" }]);
    const opts =
      await sql`select reloptions from pg_class where oid = 'public.order_preparation_queue_v1'::regclass`;
    expect((opts[0] as Row)["reloptions"]).toEqual(["security_invoker=true"]);
  });

  it("classifies by the packed rule, never by fulfillment_status", async () => {
    const ids: Record<string, string> = {};
    ids.unpackedNoDelivery = await order(ORG, "confirmed", "unfulfilled");
    ids.unpackedArranged = await order(ORG, "confirmed", "processing");
    await delivery(ORG, ids.unpackedArranged, "pending", "2026-10-01T08:00:00Z");
    ids.packedReady = await order(ORG, "confirmed", "processing");
    const ready = await delivery(
      ORG,
      ids.packedReady,
      "ready",
      "2026-10-01T09:00:00Z",
      "pack_order_packed",
    );
    expect(ready).toBeTruthy();
    ids.packedFailed = await order(ORG, "confirmed", "unfulfilled");
    await history(
      ORG,
      ids.packedFailed,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00Z",
      "pack_order_packed",
    );
    await delivery(ORG, ids.packedFailed, "failed", "2026-10-01T11:00:00Z");
    await history(ORG, ids.packedFailed, "processing", "unfulfilled", "2026-10-01T11:00:00Z", null);
    ids.packedCancelled = await order(ORG, "confirmed", "unfulfilled");
    await history(
      ORG,
      ids.packedCancelled,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00Z",
      "pack_order_packed",
    );
    await delivery(ORG, ids.packedCancelled, "cancelled", "2026-10-01T11:00:00Z");
    await history(
      ORG,
      ids.packedCancelled,
      "processing",
      "unfulfilled",
      "2026-10-01T11:00:00Z",
      null,
    );
    ids.reopened = await order(ORG, "confirmed", "unfulfilled");
    await history(
      ORG,
      ids.reopened,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00Z",
      "pack_order_packed",
    );
    await delivery(
      ORG,
      ids.reopened,
      "cancelled",
      "2026-10-01T12:00:00Z",
      "system:order_fulfillment_reopened",
    );
    await history(ORG, ids.reopened, "processing", "unfulfilled", "2026-10-01T12:00:00Z", "reopen");
    ids.inTransit = await order(ORG, "confirmed", "processing");
    await delivery(ORG, ids.inTransit, "in_transit", "2026-10-01T09:00:00Z");
    ids.cancelled = await order(ORG, "cancelled", "cancelled");
    // Corrupt cross-tenant marker: OTHER's id on ORG's history must not count.
    ids.otherTenant = await order(OTHER, "confirmed", "unfulfilled");
    await history(
      ORG,
      ids.otherTenant,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00Z",
      "pack_order_packed",
    );

    const got = await states(ORG);
    expect(
      Object.fromEntries(
        [...got].map(([id, state]) => [Object.keys(ids).find((k) => ids[k] === id), state]),
      ),
    ).toEqual({
      unpackedNoDelivery: "needs_packing",
      unpackedArranged: "needs_packing",
      packedFailed: "packed_needs_delivery",
      packedCancelled: "packed_needs_delivery",
      reopened: "needs_packing",
    });
    expect(await states(OTHER)).toEqual(new Map([[ids.otherTenant!, "needs_packing"]]));
    // The view and the rule agree row by row.
    for (const [id, state] of got) {
      const [rule] = await as("service_role", "select order_currently_packed_v1($1,$2) as p", [
        ORG,
        id,
      ]);
      expect({ id, packed: rule!["p"] }).toEqual({ id, packed: state === "packed_needs_delivery" });
    }
  });

  it("large tenant: exact counts and first pages, with their plans", async () => {
    // 60,000 orders in BIG: 50,000 completed, 4,000 unpacked with no delivery,
    // 2,000 unpacked with a pending delivery, 2,000 packed whose delivery failed,
    // 1,500 packed with a ready delivery, 500 in transit.
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica");
      await tx.unsafe(`
        insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,
          created_by,created_at,lifecycle_status,payment_status,fulfillment_status)
        select gen_random_uuid(), '${BIG}', 'BIG-' || g, 'MANUAL', 'USD', 1000, 1000, '${OWNER}',
          timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => g),
          (case when g <= 50000 then 'completed' else 'confirmed' end)::order_lifecycle_status,
          'paid',
          (case when g <= 50000 then 'fulfilled'
                when g <= 54000 then 'unfulfilled'
                when g <= 56000 then 'processing'
                when g <= 58000 then 'unfulfilled'
                else 'processing' end)::order_fulfillment_status
        from generate_series(1, 60000) g;
        create temp table big_orders on commit drop as
          select id, (regexp_replace(order_number, '^BIG-', ''))::int as g from orders where organization_id = '${BIG}';
        insert into deliveries(id,organization_id,order_id,provider_name,status,created_by,created_at,updated_at)
        select gen_random_uuid(), '${BIG}', id, 'Courier',
          (case when g <= 56000 then 'pending' when g <= 58000 then 'failed'
                when g <= 59500 then 'ready' else 'in_transit' end)::delivery_status,
          '${OWNER}', timestamptz '2026-10-01 11:00:00+00', timestamptz '2026-10-01 11:00:00+00'
        from big_orders where g > 54000;
        insert into order_status_history(organization_id,order_id,axis,from_status,to_status,changed_by,reason,changed_at)
        select '${BIG}', id, 'fulfillment', 'unfulfilled', 'processing', '${OWNER}', 'pack_order_packed',
          timestamptz '2026-10-01 09:00:00+00'
        from big_orders where g > 56000 and g <= 58000;
        insert into order_status_history(organization_id,order_id,axis,from_status,to_status,changed_by,reason,changed_at)
        select '${BIG}', b.id, 'fulfillment', 'processing', 'unfulfilled', '${OWNER}', null,
          timestamptz '2026-10-01 11:00:00+00'
        from big_orders b where g > 56000 and g <= 58000;
        insert into delivery_status_history(organization_id,delivery_id,from_status,to_status,changed_by,reason,created_at)
        select '${BIG}', d.id, null, d.status, '${OWNER}',
          case when d.status in ('ready','in_transit') then 'pack_order_packed' end, d.created_at
        from deliveries d where d.organization_id = '${BIG}';
      `);
    });
    await sql.unsafe("ANALYZE");

    const count = async (state: string) =>
      Number(
        (
          await as(
            "service_role",
            "select count(*)::int as n from order_preparation_queue_v1 where organization_id = $1 and preparation_state = $2",
            [BIG, state],
          )
        )[0]!["n"],
      );
    expect(await count("needs_packing")).toBe(6000);
    expect(await count("packed_needs_delivery")).toBe(2000);

    // The same shape the repository asks PostgREST for: organization, state,
    // newest first, one row more than the page.
    const page = await as(
      "service_role",
      `select id from order_preparation_queue_v1 where organization_id = $1 and preparation_state = 'needs_packing'
       order by created_at desc, id desc limit 51`,
      [BIG],
    );
    expect(page).toHaveLength(51);

    const plans: Record<string, string> = {};
    const explain = async (label: string, statement: string) => {
      const rows = await as("service_role", `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${statement}`);
      plans[label] = rows.map((r) => String(r["QUERY PLAN"])).join("\n");
      const time = /Execution Time: ([\d.]+) ms/.exec(plans[label]!)?.[1];
      console.info(`[order-preparation-queue-native] ${label}: ${time} ms`);
    };
    await explain(
      "needs_packing count",
      `select count(*) from order_preparation_queue_v1 where organization_id = '${BIG}' and preparation_state = 'needs_packing'`,
    );
    await explain(
      "needs_packing first page",
      `select * from order_preparation_queue_v1 where organization_id = '${BIG}' and preparation_state = 'needs_packing' order by created_at desc, id desc limit 51`,
    );
    await explain(
      "packed_needs_delivery count",
      `select count(*) from order_preparation_queue_v1 where organization_id = '${BIG}' and preparation_state = 'packed_needs_delivery'`,
    );
    // Waiting for pickup: the predicate PostgREST's deliveries!inner embed applies
    // (an EXISTS-equivalent semi-join). PostgREST's generated SQL differs in form
    // (a LATERAL subquery); its real plan is a staging measurement.
    await explain(
      "waiting_pickup count (EXISTS equivalent)",
      `select count(*) from orders o where o.organization_id = '${BIG}' and o.lifecycle_status = 'confirmed'
         and o.fulfillment_status <> 'fulfilled' and o.fulfillment_status <> 'cancelled'
         and exists (select 1 from deliveries d where d.order_id = o.id and d.status = 'ready' and d.organization_id = '${BIG}')`,
    );
    for (const [label, plan] of Object.entries(plans)) {
      console.info(`[order-preparation-queue-native] plan — ${label}\n${plan}`);
    }
    const waiting = await as(
      "service_role",
      `select count(*)::int as n from orders o where o.organization_id = $1 and o.lifecycle_status = 'confirmed'
         and o.fulfillment_status <> 'fulfilled' and o.fulfillment_status <> 'cancelled'
         and exists (select 1 from deliveries d where d.order_id = o.id and d.status = 'ready' and d.organization_id = $1)`,
      [BIG],
    );
    expect(waiting[0]!["n"]).toBe(1500);
  }, 300_000);
});
