/**
 * Mark Packed's packing-round check under REAL PostgreSQL lock contention
 * (migration 066, mark_order_packed_v1).
 *
 * PGlite is a single connection, so it cannot show two transactions racing for
 * the same order. This file runs against a real PostgreSQL server
 * (APSA_TEST_PG_URL) with several independent connections. Every migration is
 * applied to a fresh, throwaway database; nothing here matches SQL text.
 *
 *   - a reopen holds the order lock while a stale screen submits → the
 *     submission WAITS on that lock, then is refused: 'stale_round'
 *   - two screens of the same round submit together (no delivery, and through
 *     a delivery) → the second WAITS, then is refused: packed exactly once
 *   - a screen opened after the reopen submits while nothing races → packs
 *
 * "Waits" is observed, not assumed: the second backend's pg_stat_activity row
 * must report wait_event_type = 'Lock' before the first transaction commits.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test src/tests/pack-round-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for pack-round-pg.runtime.ts");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";

const dbName = `apsa_pack_round_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 20 });

  // Same prelude as parcel-recovery-pg.runtime.ts; roles are cluster-wide.
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  `);
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }

  await sql`insert into auth.users(id,email) values(${ACTOR},'pack-round@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'A','A','pack-round-a',${ACTOR})`;
}, 120_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

async function confirmedOrder(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
    values(${id},${ORG},${id},'MANUAL','USD',3000,3000,${ACTOR})`;
  await sql`update orders set lifecycle_status='confirmed' where id=${id}`;
  return id;
}

async function arrange(orderId: string): Promise<string> {
  const [row] = await sql`select create_delivery_v1(${ORG}::uuid, ${orderId}::uuid, ${ACTOR}::uuid,
      null, null, null, 'Courier', null, null) as r`;
  const r = row.r as Json;
  expect(r["status"]).toBe("success");
  return r["delivery_id"] as string;
}

const roundOf = async (orderId: string) =>
  Number((await sql`select order_pack_round_v1(${ORG}::uuid, ${orderId}::uuid) as v`)[0].v);

const markersOf = async (orderId: string) =>
  Number(
    (
      await sql`select (
        (select count(*) from order_status_history
          where order_id = ${orderId} and reason = 'pack_order_packed')
        + (select count(*) from delivery_status_history dh join deliveries d on d.id = dh.delivery_id
          where d.order_id = ${orderId} and dh.reason = 'pack_order_packed')) as v`
    )[0].v,
  );

const markOn = (conn: SQL, orderId: string, expected: number) =>
  conn`select mark_order_packed_v1(${ORG}::uuid, ${orderId}::uuid, ${ACTOR}::uuid, ${expected}::int) as r`.then(
    (rows) => rows[0].r as Json,
  );

const reopenOn = (conn: SQL, orderId: string) =>
  conn`select reopen_order_fulfillment_v1(${ORG}::uuid, ${orderId}::uuid, ${ACTOR}::uuid, 'Recount') as r`.then(
    (rows) => rows[0].r as Json,
  );

/** Resolves once `pid` is blocked waiting for a heavyweight (row/tuple) lock. */
async function waitUntilBlockedOnLock(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await sql`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await Bun.sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on the order lock`);
}

async function backendPid(conn: SQL): Promise<number> {
  const [row] = await conn`select pg_backend_pid() as pid`;
  return Number(row.pid);
}

// ── reopen during submission ─────────────────────────────────────────────────

describe("a reopen racing a stale screen's Mark Packed (real PostgreSQL)", () => {
  it("the reopen holds the lock → the submission waits, then is refused: stale_round", async () => {
    const id = await confirmedOrder();
    const screen = await roundOf(id); // the stale screen started here
    expect((await markOn(sql, id, screen))["status"]).toBe("success"); // another member packs
    const packedRound = await roundOf(id);
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      expect((await reopenOn(a, id))["status"]).toBe("success"); // holds the order lock
      const bPid = await backendPid(b);
      const pending = markOn(b, id, screen);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      expect(await pending).toEqual({ status: "stale_round", current_round: packedRound });
    } finally {
      a.release();
      b.release();
    }
    // Reopened, and nothing from the stale screen was recorded.
    expect(await markersOf(id)).toBe(packedRound);
    const [state] = await sql`select order_currently_packed_v1(${ORG}::uuid, ${id}::uuid) as v`;
    expect(state.v).toBe(false);
  });

  it("after the reopen, a screen opened in the current round packs", async () => {
    const id = await confirmedOrder();
    expect((await markOn(sql, id, 0))["status"]).toBe("success");
    expect((await reopenOn(sql, id))["status"]).toBe("success");
    const fresh = await roundOf(id);
    expect((await markOn(sql, id, fresh))["status"]).toBe("success");
    expect(await roundOf(id)).toBeGreaterThan(fresh);
  });
});

// ── two submissions of the same round ────────────────────────────────────────

describe("two screens of the same round submit together (real PostgreSQL)", () => {
  for (const path of ["no delivery", "delivery"] as const) {
    it(`${path}: the second waits for the first, then is refused — packed exactly once`, async () => {
      const id = await confirmedOrder();
      if (path === "delivery") await arrange(id);
      const screen = await roundOf(id);
      const a = await sql.reserve();
      const b = await sql.reserve();
      let second: Json;
      try {
        await a`begin`;
        expect((await markOn(a, id, screen))["status"]).toBe("success"); // holds the locks
        const bPid = await backendPid(b);
        const pending = markOn(b, id, screen);
        await waitUntilBlockedOnLock(bPid);
        await a`commit`;
        second = await pending;
      } finally {
        a.release();
        b.release();
      }
      const after = await roundOf(id);
      expect(second).toEqual({ status: "stale_round", current_round: after });
      // Exactly one Mark Packed's markers: 1 on the order, or 2 on the delivery.
      expect(after).toBe(path === "delivery" ? 2 : 1);
    });
  }
});
