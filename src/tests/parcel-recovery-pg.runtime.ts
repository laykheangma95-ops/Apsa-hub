/**
 * APSA Parcel recovery under REAL PostgreSQL lock contention (migration 059).
 *
 * PGlite is a single connection, so it cannot show two transactions racing for
 * the same row. This file runs against a real PostgreSQL server (APSA_TEST_PG_URL)
 * with several independent connections. Every migration is applied to a fresh,
 * throwaway database; nothing here matches SQL text.
 *
 * A "stranded" order is produced by the real pre-057 confirmation
 * (transition_order_before_payment_authority_v1 — the function 057 wraps):
 * lifecycle confirmed, real stock 'sale' movements and history written, and no
 * APSA Parcel, exactly what a failed post-confirmation parcel write leaves.
 *
 *   - cancellation holds the order lock first → recovery WAITS on that lock,
 *     then refuses: zero parcels
 *   - recovery holds the lock first → cancellation WAITS, then proceeds by the
 *     existing cancellation rules: one parcel, order cancelled, stock returned
 *   - negative control: one fixed schedule (unlocked read → pause → cancellation
 *     takes the lock → resume → cancellation commits) run against a TEST-ONLY
 *     unlocked recovery yields cancelled + active parcel; against the shipped
 *     recover_order_parcel_v1 it yields zero parcels — the lock is necessary
 *   - recovery vs recovery (held lock, and an unsynchronised burst) → exactly
 *     one active parcel; the others report 'exists'
 *
 * "Waits" is observed, not assumed: the second backend's pg_stat_activity row
 * must report wait_event_type = 'Lock' before the first transaction commits.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test src/tests/parcel-recovery-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for parcel-recovery-pg.runtime.ts");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const PRODUCT = "aaaaaaaa-7777-4000-8000-000000000001";
const VARIANT = "aaaaaaaa-5555-4000-8000-000000000001";

const dbName = `apsa_parcel_recovery_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 20 });

  // Same prelude as the PGlite fixture (src/tests/helpers/payment-order-fixture.ts);
  // roles are cluster-wide, so they are created only if absent.
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

  await sql`insert into auth.users(id,email) values(${ACTOR},'recovery@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'A','A','recovery-a',${ACTOR}),(${ORG_B},'B','B','recovery-b',${ACTOR})`;
  await sql`insert into products(id,organization_id,name_km) values(${PRODUCT},${ORG},'ផលិតផល')`;
  await sql`insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency,status)
    values(${VARIANT},${ORG},${PRODUCT},'SKU-RECOVER','Std',1500,'USD','ACTIVE')`;
}, 120_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

async function draftOrder(): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
    values(${id},${ORG},${id},'MANUAL','USD',3000,3000,${ACTOR})`;
  await sql`insert into order_items(organization_id,order_id,product_id,variant_id,product_name_snapshot,
      unit_price_minor,quantity,line_total_minor)
    values(${ORG},${id},${PRODUCT},${VARIANT},'Iced Coffee',1500,2,3000)`;
  return id;
}

/** A confirmed order with real stock + history side effects and NO parcel (pre-057 confirm). */
async function strandedOrder(): Promise<string> {
  const id = await draftOrder();
  const [row] = await sql`select transition_order_before_payment_authority_v1(
      ${ORG}::uuid, ${id}::uuid, 'lifecycle', 'draft', 'confirmed', ${ACTOR}::uuid, null) as r`;
  expect((row.r as Json)["status"]).toBe("success");
  const s = await snapshot(id);
  expect(s).toMatchObject({ lifecycle: "confirmed", parcels: 0 });
  expect(s.saleUnits).toBe(2);
  return id;
}

async function snapshot(orderId: string) {
  const [r] = await sql`
    select
      (select lifecycle_status::text from orders where id = ${orderId}) as lifecycle,
      (select count(*)::int from parcels where order_id = ${orderId} and status <> 'void') as parcels,
      (select coalesce(-sum(m.quantity_delta) filter (where m.movement_type = 'sale'), 0)::int
         from inventory_movements m join order_items i
           on m.reference_type = 'order_item' and m.reference_id = i.id
        where i.order_id = ${orderId}) as "saleUnits",
      (select coalesce(sum(m.quantity_delta) filter (where m.movement_type = 'return'), 0)::int
         from inventory_movements m join order_items i
           on m.reference_type = 'order_item' and m.reference_id = i.id
        where i.order_id = ${orderId}) as "returnUnits",
      (select count(*)::int from order_status_history where order_id = ${orderId}) as history`;
  return r as {
    lifecycle: string;
    parcels: number;
    saleUnits: number;
    returnUnits: number;
    history: number;
  };
}

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

const recoverOn = (conn: SQL, orderId: string, org = ORG) =>
  conn`select recover_order_parcel_v1(${org}::uuid, ${orderId}::uuid, ${ACTOR}::uuid) as r`.then(
    (rows) => rows[0].r as Json,
  );

const cancelOn = (conn: SQL, orderId: string) =>
  conn`select transition_order_status_v1(${ORG}::uuid, ${orderId}::uuid, 'lifecycle',
      'confirmed', 'cancelled', ${ACTOR}::uuid, 'test cancel') as r`.then(
    (rows) => rows[0].r as Json,
  );

// ── recovery vs cancellation ─────────────────────────────────────────────────

describe("recovery vs cancellation (real PostgreSQL, two connections)", () => {
  it("cancellation takes the lock first → recovery waits, then refuses; zero parcels", async () => {
    const id = await strandedOrder();
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      expect((await cancelOn(a, id))["status"]).toBe("success"); // holds the order lock
      const bPid = await backendPid(b);
      const pending = recoverOn(b, id);
      await waitUntilBlockedOnLock(bPid); // recovery is queued behind the cancellation
      await a`commit`;
      const result = await pending;
      expect(result).toMatchObject({ status: "not_confirmed", current: "cancelled" });
    } finally {
      a.release();
      b.release();
    }
    const s = await snapshot(id);
    expect(s.lifecycle).toBe("cancelled");
    expect(s.parcels).toBe(0);
    expect(s.saleUnits).toBe(2);
    expect(s.returnUnits).toBe(2);
  });

  it("recovery takes the lock first → cancellation waits, then proceeds by its own rules", async () => {
    const id = await strandedOrder();
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      await a`begin`;
      expect((await recoverOn(a, id))["status"]).toBe("created"); // holds the order lock
      const bPid = await backendPid(b);
      const pending = cancelOn(b, id);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      expect((await pending)["status"]).toBe("success");
    } finally {
      a.release();
      b.release();
    }
    const s = await snapshot(id);
    expect(s.lifecycle).toBe("cancelled");
    expect(s.parcels).toBe(1); // created consistently under the lock; cancellation never voids it
    expect(s.saleUnits).toBe(2);
    expect(s.returnUnits).toBe(2); // stock returned once, as for any confirmed-order cancellation
    // ...and a recovery after the cancellation refuses without writing.
    expect(await recoverOn(sql, id)).toMatchObject({ status: "not_confirmed" });
    expect((await snapshot(id)).parcels).toBe(1);
  });

  it("a recovery rolled back while holding the lock leaves nothing behind", async () => {
    const id = await strandedOrder();
    const a = await sql.reserve();
    try {
      await a`begin`;
      expect((await recoverOn(a, id))["status"]).toBe("created");
      await a`rollback`;
    } finally {
      a.release();
    }
    expect((await snapshot(id)).parcels).toBe(0);
  });
});

// ── recovery vs recovery ─────────────────────────────────────────────────────

describe("recovery vs recovery (real PostgreSQL)", () => {
  it("the second recovery waits for the first, then sees its parcel: exactly one", async () => {
    const id = await strandedOrder();
    const before = await snapshot(id);
    const a = await sql.reserve();
    const b = await sql.reserve();
    let first: Json;
    let second: Json;
    try {
      await a`begin`;
      first = await recoverOn(a, id);
      expect(first["status"]).toBe("created");
      const bPid = await backendPid(b);
      const pending = recoverOn(b, id);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      second = await pending;
    } finally {
      a.release();
      b.release();
    }
    expect(second).toMatchObject({ status: "exists", parcel_id: first["parcel_id"] });
    const after = await snapshot(id);
    expect(after.parcels).toBe(1);
    // No lifecycle, stock or history side effect from either recovery.
    expect({ ...after, parcels: 0 }).toEqual({ ...before, parcels: 0 });
  });

  it("an unsynchronised burst of 12 recoveries creates exactly one active parcel", async () => {
    const id = await strandedOrder();
    const before = await snapshot(id);
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const conn = await sql.reserve();
        try {
          return await recoverOn(conn, id);
        } finally {
          conn.release();
        }
      }),
    );
    expect(results.filter((r) => r["status"] === "created")).toHaveLength(1);
    expect(results.filter((r) => r["status"] === "exists")).toHaveLength(11);
    expect(new Set(results.map((r) => r["parcel_id"])).size).toBe(1);
    const after = await snapshot(id);
    expect(after.parcels).toBe(1);
    expect({ ...after, parcels: 0 }).toEqual({ ...before, parcels: 0 });
  });
});

// ── negative control: the lock is what prevents the invalid state ────────────
//
// TEST-ONLY. Two functions are created in this throwaway database (never in a
// migration, never in production) to replay the OLD recovery shape under one
// fixed schedule:
//
//   test_unlocked_recover_v0 — read lifecycle WITHOUT the order lock, pause,
//     then insert the parcel if the earlier read said 'confirmed' (the removed
//     "check in the service → await → service-role insert").
//   test_gated_shipped_recover — the same unlocked read and the same pause,
//     then call the SHIPPED recover_order_parcel_v1.
//
// The pause is a transaction advisory lock (the gate) that the test holds and
// releases. Schedule, identical for both:
//   1. recovery starts, reads lifecycle = confirmed (no lock), waits at the gate
//   2. cancellation takes the order lock and cancels (not yet committed)
//   3. the gate opens; recovery proceeds and WAITS on the order row
//   4. cancellation commits; recovery finishes
// The unlocked version leaves the forbidden state (cancelled + active parcel);
// the shipped one re-reads under the lock, sees 'cancelled', writes nothing.

describe("negative control: same schedule, unlocked vs shipped recovery (real PostgreSQL)", () => {
  const GATE = 59_059;

  beforeAll(async () => {
    await sql.unsafe(`
      CREATE FUNCTION test_unlocked_recover_v0(p_org UUID, p_order UUID, p_gate BIGINT)
      RETURNS JSONB LANGUAGE plpgsql AS $$
      DECLARE v_lifecycle TEXT; v_id UUID;
      BEGIN
        SELECT lifecycle_status::TEXT INTO v_lifecycle
        FROM public.orders WHERE id = p_order AND organization_id = p_org;   -- no lock
        PERFORM pg_advisory_xact_lock(p_gate);                               -- pause
        IF v_lifecycle <> 'confirmed' THEN
          RETURN jsonb_build_object('status', 'not_confirmed', 'current', v_lifecycle);
        END IF;
        IF EXISTS (SELECT 1 FROM public.parcels
                   WHERE organization_id = p_org AND order_id = p_order AND status <> 'void') THEN
          RETURN jsonb_build_object('status', 'exists');
        END IF;
        INSERT INTO public.parcels (organization_id, order_id, parcel_code, status)
        VALUES (p_org, p_order, public.new_apsa_parcel_code_v1(), 'created')
        RETURNING id INTO v_id;
        RETURN jsonb_build_object('status', 'created', 'observed', v_lifecycle);
      END $$;

      CREATE FUNCTION test_gated_shipped_recover(p_org UUID, p_order UUID, p_gate BIGINT, p_actor UUID)
      RETURNS JSONB LANGUAGE plpgsql AS $$
      DECLARE v_lifecycle TEXT;
      BEGIN
        SELECT lifecycle_status::TEXT INTO v_lifecycle
        FROM public.orders WHERE id = p_order AND organization_id = p_org;   -- no lock
        PERFORM pg_advisory_xact_lock(p_gate);                               -- pause
        RETURN public.recover_order_parcel_v1(p_org, p_order, p_actor)
               || jsonb_build_object('observed_before_pause', v_lifecycle);
      END $$;
    `);
  });

  /** Waits until `pid` is blocked on a lock of the given kind ('advisory' or a row lock). */
  async function waitForLockWait(pid: number, kind: "advisory" | "row"): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [row] =
        await sql`select wait_event_type, wait_event from pg_stat_activity where pid = ${pid}`;
      const advisory = row?.wait_event === "advisory";
      if (row?.wait_event_type === "Lock" && (kind === "advisory" ? advisory : !advisory)) return;
      await Bun.sleep(25);
    }
    throw new Error(`backend ${pid} never waited on a ${kind} lock`);
  }

  async function runSchedule(call: (conn: SQL, id: string) => Promise<Json>) {
    const id = await strandedOrder();
    const gate = await sql.reserve();
    const recovery = await sql.reserve();
    const cancel = await sql.reserve();
    let result: Json;
    try {
      await gate`select pg_advisory_lock(${GATE})`;
      const recoveryPid = await backendPid(recovery);
      // 1. recovery reads 'confirmed' without the lock, then waits at the gate.
      const pending = call(recovery, id);
      await waitForLockWait(recoveryPid, "advisory");
      // 2. cancellation takes the order lock and cancels, uncommitted.
      await cancel`begin`;
      expect((await cancelOn(cancel, id))["status"]).toBe("success");
      // 3. open the gate: recovery proceeds and must wait on the order row.
      await gate`select pg_advisory_unlock(${GATE})`;
      await waitForLockWait(recoveryPid, "row");
      // 4. cancellation commits; recovery completes.
      await cancel`commit`;
      result = await pending;
    } finally {
      gate.release();
      recovery.release();
      cancel.release();
    }
    return { id, result, after: await snapshot(id) };
  }

  it("UNLOCKED (old shape): the schedule produces a cancelled order with an active parcel", async () => {
    const { result, after } = await runSchedule((conn, id) =>
      conn`select test_unlocked_recover_v0(${ORG}::uuid, ${id}::uuid, ${GATE}) as r`.then(
        (rows) => rows[0].r as Json,
      ),
    );
    expect(result).toMatchObject({ status: "created", observed: "confirmed" });
    // The forbidden state the lock exists to prevent.
    expect(after.lifecycle).toBe("cancelled");
    expect(after.parcels).toBe(1);
  });

  it("SHIPPED recover_order_parcel_v1: same schedule — waits, re-reads 'cancelled', creates nothing", async () => {
    const { result, after } = await runSchedule((conn, id) =>
      conn`select test_gated_shipped_recover(${ORG}::uuid, ${id}::uuid, ${GATE}, ${ACTOR}::uuid) as r`.then(
        (rows) => rows[0].r as Json,
      ),
    );
    // It saw 'confirmed' before the pause, exactly like the unlocked version...
    expect(result["observed_before_pause"]).toBe("confirmed");
    // ...but decided under the lock, after the cancellation committed.
    expect(result).toMatchObject({ status: "not_confirmed", current: "cancelled" });
    expect(after.lifecycle).toBe("cancelled");
    expect(after.parcels).toBe(0);
  });
});

// ── refusals write nothing ───────────────────────────────────────────────────

describe("recovery refusals (real PostgreSQL)", () => {
  it("draft, cancelled and another tenant's order are refused with nothing written", async () => {
    const draft = await draftOrder();
    expect(await recoverOn(sql, draft)).toMatchObject({
      status: "not_confirmed",
      current: "draft",
    });
    expect((await snapshot(draft)).parcels).toBe(0);

    const stranded = await strandedOrder();
    expect(await recoverOn(sql, stranded, ORG_B)).toMatchObject({ status: "not_found" });
    expect((await snapshot(stranded)).parcels).toBe(0);
  });

  it("is not executable by anon or authenticated — service_role only", async () => {
    const [row] = await sql`
      select has_function_privilege('anon', 'public.recover_order_parcel_v1(uuid,uuid,uuid)', 'execute') as anon,
             has_function_privilege('authenticated', 'public.recover_order_parcel_v1(uuid,uuid,uuid)', 'execute') as authed,
             has_function_privilege('service_role', 'public.recover_order_parcel_v1(uuid,uuid,uuid)', 'execute') as service`;
    expect(row).toEqual({ anon: false, authed: false, service: true });
  });
});
