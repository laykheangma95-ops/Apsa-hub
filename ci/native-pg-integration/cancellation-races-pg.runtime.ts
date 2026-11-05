/**
 * Cancellation races on REAL PostgreSQL — integrated main + PR #121 + PR #128.
 *
 * Runs inside the integration tree built by integrate.sh (it is copied to
 * src/tests/native-pg-integration/), against APSA_TEST_PG_URL. A throwaway
 * database is created per run, the complete migration chain (001 → 061, 062,
 * 063) is applied to it, and it is dropped afterwards. Synthetic data only.
 *
 * Every race is two (or more) independent sessions. "Waits" is observed, never
 * assumed: the second backend must report wait_event_type = 'Lock' and name
 * the first backend in pg_blocking_pids() before the first commits. Both
 * serial orders the order row lock allows are run for each pair:
 *
 *   cancellation  vs courier handoff        (delivery ready → in_transit)
 *   cancellation  vs delivery completion    (delivery in_transit → delivered)
 *   cancellation  vs counter handoff        (fulfillment unfulfilled → fulfilled)
 *   cancellation  vs cancellation           (held lock, and an unsynchronised burst)
 *
 * After each race: order axes, the inventory ledger (per order and per
 * variant), delivery status, order and delivery status history, and that no
 * stock was restored for goods that left custody.
 *
 * Run (inside the integration tree):
 *   APSA_TEST_PG_URL=postgres://postgres@localhost:5432/postgres \
 *     bun test src/tests/native-pg-integration/cancellation-races-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required");

const ORG = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ACTOR = "aaaaaaaa-0000-4000-8000-0000000000a2";
const PRODUCT = "aaaaaaaa-7777-4000-8000-0000000000a1";
const VARIANT = "aaaaaaaa-5555-4000-8000-0000000000a1";
const LOCATION = "aaaaaaaa-3333-4000-8000-0000000000a1";
const INITIAL_STOCK = 1000;

// Negative control only (the workflow's "control" step): withhold one
// migration by number prefix, to prove these races fail without it.
const WITHHELD = process.env["APSA_HARNESS_WITHHOLD_MIGRATION"] ?? "";

const dbName = `apsa_cancel_races_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;

type Json = Record<string, unknown>;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 20 });

  // Same prelude as src/tests/parcel-recovery-pg.runtime.ts.
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
  const applied: string[] = [];
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    if (WITHHELD && name.startsWith(`${WITHHELD}_`)) {
      console.log(`NEGATIVE CONTROL: withholding ${name}`);
      continue;
    }
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
      applied.push(name);
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  console.log(`applied ${applied.length} migrations: ${applied[0]} … ${applied.at(-1)}`);

  await sql`insert into auth.users(id,email) values(${ACTOR},'races@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'A','A','races-a',${ACTOR}),(${ORG_B},'B','B','races-b',${ACTOR})`;
  await sql`insert into products(id,organization_id,name_km) values(${PRODUCT},${ORG},'ផលិតផល')`;
  await sql`insert into product_variants(id,organization_id,product_id,price_amount)
    values(${VARIANT},${ORG},${PRODUCT},1000)`;
  await sql`insert into locations(id,organization_id,name) values(${LOCATION},${ORG},'Shop')`;
  await sql`insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
    values(${ORG},${PRODUCT},${VARIANT},${LOCATION},${INITIAL_STOCK},'initial')`;
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const one = async (query: PromiseLike<Json[]>) => (await query)[0]!["r"] as Json;

const cancelOn = (conn: SQL, id: string, from = "confirmed") =>
  one(
    conn`select transition_order_status_v1(${ORG}::uuid, ${id}::uuid, 'lifecycle',
      ${from}, 'cancelled', ${ACTOR}::uuid, 'race cancel') as r`,
  );
const fulfilOn = (conn: SQL, id: string, from: string, to: string) =>
  one(
    conn`select transition_order_status_v1(${ORG}::uuid, ${id}::uuid, 'fulfillment',
      ${from}, ${to}, ${ACTOR}::uuid, null) as r`,
  );
const deliveryOn = (conn: SQL, d: string, from: string, to: string) =>
  one(
    // Only a packed order's delivery may become 'ready' (054); this marker is
    // the step Mark Packed makes (same convention as PR #128's suite).
    conn`select transition_delivery_status_v1(${ORG}::uuid, ${d}::uuid, ${from}, ${to},
      ${ACTOR}::uuid, ${to === "ready" ? "pack_order_packed" : null}) as r`,
  );

async function confirmedOrder(): Promise<string> {
  const [created] = await sql`select create_order_v2(${ORG}::uuid, ${ACTOR}::uuid, 'POS',
      ${JSON.stringify([{ variant_id: VARIANT, quantity: 2 }])}::text::jsonb, null, ${LOCATION}::uuid,
      0, 0, null, ${crypto.randomUUID()}) as r`;
  const c = created!.r as Json;
  expect(c["status"]).toBe("success");
  const id = c["order_id"] as string;
  const [confirmed] = await sql`select transition_order_status_v1(${ORG}::uuid, ${id}::uuid,
      'lifecycle', 'draft', 'confirmed', ${ACTOR}::uuid, null) as r`;
  expect((confirmed!.r as Json)["status"]).toBe("success");
  return id;
}

async function deliveryAt(id: string, status: "ready" | "in_transit"): Promise<string> {
  const [created] = await sql`select create_delivery_v1(${ORG}::uuid, ${id}::uuid, ${ACTOR}::uuid,
      null, null, null, 'Courier', null, null) as r`;
  const r = created!.r as Json;
  expect(r["status"]).toBe("success");
  const d = r["delivery_id"] as string;
  const chain = ["pending", "preparing", "ready", "in_transit"];
  for (let i = 0; chain[i] !== status; i++) {
    expect((await deliveryOn(sql, d, chain[i]!, chain[i + 1]!))["status"]).toBe("success");
  }
  return d;
}

async function state(id: string) {
  const [r] = await sql`
    select
      (select lifecycle_status::text from orders where id = ${id}) as lifecycle,
      (select fulfillment_status::text from orders where id = ${id}) as fulfillment,
      (select coalesce(array_agg(status::text order by created_at), '{}')
         from deliveries where order_id = ${id}) as deliveries,
      (select coalesce(sum(m.quantity_delta) filter (where m.movement_type = 'sale'), 0)::int
         from inventory_movements m join order_items i
           on m.reference_type = 'order_item' and m.reference_id = i.id
        where i.order_id = ${id}) as sale,
      (select coalesce(sum(m.quantity_delta) filter (where m.movement_type = 'return'), 0)::int
         from inventory_movements m join order_items i
           on m.reference_type = 'order_item' and m.reference_id = i.id
        where i.order_id = ${id}) as returned,
      (select count(*)::int from inventory_movements m join order_items i
           on m.reference_type = 'order_item' and m.reference_id = i.id
        where i.order_id = ${id} and m.movement_type = 'return') as "returnRows",
      (select coalesce(array_agg(axis || ':' || from_status || '>' || to_status order by changed_at, id), '{}')
         from order_status_history where order_id = ${id}) as history,
      (select coalesce(array_agg(h.from_status::text || '>' || h.to_status::text order by h.created_at, h.id), '{}')
         from delivery_status_history h join deliveries d on d.id = h.delivery_id
        where d.order_id = ${id}) as "deliveryHistory"`;
  return r as {
    lifecycle: string;
    fulfillment: string;
    deliveries: string[];
    sale: number;
    returned: number;
    returnRows: number;
    history: string[];
    deliveryHistory: string[];
  };
}

const onHand = async () => {
  const [r] = await sql`select coalesce(sum(quantity_delta),0)::int as v
    from inventory_movements where variant_id = ${VARIANT}`;
  return Number(r!.v);
};

async function backendPid(conn: SQL): Promise<number> {
  const [row] = await conn`select pg_backend_pid() as pid`;
  return Number(row!.pid);
}

/** Resolves once `pid` is blocked on a heavyweight lock held by `holder`. */
async function waitUntilBlockedBy(pid: number, holder: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [row] = await sql`select a.wait_event_type, pg_blocking_pids(a.pid) as blockers
      from pg_stat_activity a where a.pid = ${pid}`;
    const blockers = (row?.blockers as number[] | undefined)?.map(Number) ?? [];
    if (row?.wait_event_type === "Lock" && blockers.includes(holder)) return;
    await Bun.sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on a lock held by ${holder}`);
}

/**
 * The race harness: `first` runs in an open transaction on session A and keeps
 * its locks; `second` starts on session B, must be observed WAITING on A, and
 * resolves only after A commits. Returns both envelopes.
 */
async function race(
  first: (conn: SQL) => Promise<Json>,
  second: (conn: SQL) => Promise<Json>,
): Promise<[Json, Json]> {
  const a = await sql.reserve();
  const b = await sql.reserve();
  try {
    // Deterministic failure instead of a hung CI job if a lock never releases.
    await a`set statement_timeout = '30s'`;
    await b`set statement_timeout = '30s'`;
    await b`set lock_timeout = '30s'`;
    await a`begin`;
    const firstResult = await first(a);
    const aPid = await backendPid(a);
    const bPid = await backendPid(b);
    let settled = false;
    const pending = second(b).finally(() => {
      settled = true;
    });
    await waitUntilBlockedBy(bPid, aPid);
    expect(settled).toBe(false); // still queued behind A's order lock
    await a`commit`;
    return [firstResult, await pending];
  } finally {
    a.release();
    b.release();
  }
}

// ── the integrated database ──────────────────────────────────────────────────

describe("integrated migration chain", () => {
  it("061, 062 and 063 are all applied, and 063's guard is the live cancellation", async () => {
    const [r] = await sql`select
      to_regprocedure('public.order_cancellation_block_v1(uuid,uuid)') is not null as guard,
      to_regprocedure('public.payment_request_digest_v1') is not null
        or exists (select 1 from pg_proc where proname = 'payment_request_digest_v1') as digest,
      pg_get_functiondef('public.transition_order_status_v1(uuid,uuid,text,text,text,uuid,text)'::regprocedure)
        like '%order_cancellation_block_v1%' as wired`;
    expect(r).toMatchObject({ guard: true, digest: true, wired: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const [p] = await sql`select has_function_privilege(${role},
        'public.order_cancellation_block_v1(uuid,uuid)', 'EXECUTE') as v`;
      expect(p!.v).toBe(false);
    }
  });
});

// ── cancellation vs courier handoff ──────────────────────────────────────────

describe("cancellation vs courier handoff (ready → in_transit)", () => {
  it("handoff holds the order lock → cancellation waits, then is refused: goods_dispatched", async () => {
    const id = await confirmedOrder();
    const d = await deliveryAt(id, "ready");
    const stock = await onHand();
    const [handoff, cancel] = await race(
      (a) => deliveryOn(a, d, "ready", "in_transit"),
      (b) => cancelOn(b, id),
    );
    expect(handoff["status"]).toBe("success");
    expect(cancel).toEqual({ status: "cancel_blocked", reason: "goods_dispatched" });
    const s = await state(id);
    expect(s).toMatchObject({
      lifecycle: "confirmed",
      fulfillment: "processing",
      deliveries: ["in_transit"],
      sale: -2,
      returned: 0,
    });
    expect(s.history.some((h) => h.endsWith(">cancelled"))).toBe(false);
    expect(s.deliveryHistory.at(-1)).toBe("ready>in_transit");
    expect(await onHand()).toBe(stock); // nothing restocked while with the courier
    // Not frozen: the courier outcome can still be recorded.
    expect((await deliveryOn(sql, d, "in_transit", "delivered"))["status"]).toBe("success");
  });

  it("cancellation holds the order lock → refused (active_delivery); handoff waits, then proceeds", async () => {
    const id = await confirmedOrder();
    const d = await deliveryAt(id, "ready");
    const before = await state(id);
    const stock = await onHand();
    const [cancel, handoff] = await race(
      (a) => cancelOn(a, id),
      (b) => deliveryOn(b, d, "ready", "in_transit"),
    );
    expect(cancel).toEqual({ status: "cancel_blocked", reason: "active_delivery" });
    expect(handoff["status"]).toBe("success");
    const s = await state(id);
    expect(s).toMatchObject({ lifecycle: "confirmed", deliveries: ["in_transit"], returned: 0 });
    expect(s.history).toEqual(before.history); // the refusal wrote no history
    expect(await onHand()).toBe(stock);
  });
});

// ── cancellation vs delivery completion ──────────────────────────────────────

describe("cancellation vs delivery completion (in_transit → delivered)", () => {
  it("completion holds the order lock → cancellation waits, then is refused: goods_with_customer", async () => {
    const id = await confirmedOrder();
    const d = await deliveryAt(id, "in_transit");
    const stock = await onHand();
    const [delivered, cancel] = await race(
      (a) => deliveryOn(a, d, "in_transit", "delivered"),
      (b) => cancelOn(b, id),
    );
    expect(delivered["status"]).toBe("success");
    expect(cancel).toEqual({ status: "cancel_blocked", reason: "goods_with_customer" });
    expect(await state(id)).toMatchObject({
      lifecycle: "confirmed",
      fulfillment: "fulfilled",
      deliveries: ["delivered"],
      sale: -2,
      returned: 0,
      returnRows: 0,
    });
    expect(await onHand()).toBe(stock); // the customer holds the goods: no restock
  });

  it("cancellation holds the order lock → refused (goods_dispatched); completion waits, then proceeds", async () => {
    const id = await confirmedOrder();
    const d = await deliveryAt(id, "in_transit");
    const before = await state(id);
    const stock = await onHand();
    const [cancel, delivered] = await race(
      (a) => cancelOn(a, id),
      (b) => deliveryOn(b, d, "in_transit", "delivered"),
    );
    expect(cancel).toEqual({ status: "cancel_blocked", reason: "goods_dispatched" });
    expect(delivered["status"]).toBe("success");
    const s = await state(id);
    expect(s).toMatchObject({ lifecycle: "confirmed", fulfillment: "fulfilled", returned: 0 });
    expect(s.history.filter((h) => h.startsWith("lifecycle"))).toEqual(
      before.history.filter((h) => h.startsWith("lifecycle")),
    );
    expect(await onHand()).toBe(stock);
  });
});

// ── cancellation vs counter handoff ──────────────────────────────────────────

describe("cancellation vs counter handoff (fulfillment unfulfilled → fulfilled)", () => {
  it("counter handoff holds the order lock → cancellation waits, then is refused: goods_with_customer", async () => {
    const id = await confirmedOrder();
    const stock = await onHand();
    const [handoff, cancel] = await race(
      (a) => fulfilOn(a, id, "unfulfilled", "fulfilled"),
      (b) => cancelOn(b, id),
    );
    expect(handoff["status"]).toBe("success");
    expect(cancel).toEqual({ status: "cancel_blocked", reason: "goods_with_customer" });
    expect(await state(id)).toMatchObject({
      lifecycle: "confirmed",
      fulfillment: "fulfilled",
      deliveries: [],
      sale: -2,
      returned: 0,
    });
    expect(await onHand()).toBe(stock);
  });

  it("cancellation holds the order lock → succeeds once; the handoff waits, then is refused", async () => {
    const id = await confirmedOrder();
    const stock = await onHand();
    const [cancel, handoff] = await race(
      (a) => cancelOn(a, id),
      (b) => fulfilOn(b, id, "unfulfilled", "fulfilled"),
    );
    expect(cancel).toMatchObject({ status: "success", stock_movements: 1 });
    expect(handoff["status"]).not.toBe("success");
    const s = await state(id);
    expect(s).toMatchObject({
      lifecycle: "cancelled",
      fulfillment: "cancelled",
      sale: -2,
      returned: 2,
      returnRows: 1,
    });
    expect(s.history.filter((h) => h.endsWith(">fulfilled"))).toEqual([]);
    expect(await onHand()).toBe(stock + 2); // released exactly once
  });
});

// ── simultaneous cancellations ───────────────────────────────────────────────

describe("simultaneous cancellations", () => {
  it("the second cancellation waits for the first, then is answered stale: one release", async () => {
    const id = await confirmedOrder();
    const stock = await onHand();
    const [first, second] = await race(
      (a) => cancelOn(a, id),
      (b) => cancelOn(b, id),
    );
    expect(first).toMatchObject({ status: "success", stock_movements: 1 });
    expect(second).toMatchObject({ status: "stale", current: "cancelled" });
    const s = await state(id);
    expect(s).toMatchObject({ lifecycle: "cancelled", returned: 2, returnRows: 1 });
    expect(s.history.filter((h) => h === "lifecycle:confirmed>cancelled")).toHaveLength(1);
    expect(await onHand()).toBe(stock + 2);
  });

  it("an unsynchronised burst of 12 cancellations: exactly one success, one release", async () => {
    const id = await confirmedOrder();
    const stock = await onHand();
    const results = await Promise.all(Array.from({ length: 12 }, () => cancelOn(sql, id)));
    const statuses = results.map((r) => r["status"]);
    expect(statuses.filter((s) => s === "success")).toHaveLength(1);
    expect(statuses.every((s) => s === "success" || s === "stale")).toBe(true);
    const s = await state(id);
    expect(s).toMatchObject({ lifecycle: "cancelled", returned: 2, returnRows: 1 });
    expect(await onHand()).toBe(stock + 2);
  });

  it("a cancellation rolled back while holding the lock leaves nothing; the next one succeeds", async () => {
    const id = await confirmedOrder();
    const before = await state(id);
    const stock = await onHand();
    const a = await sql.reserve();
    try {
      await a`begin`;
      expect((await cancelOn(a, id))["status"]).toBe("success");
      await a`rollback`;
    } finally {
      a.release();
    }
    expect(await state(id)).toEqual(before);
    expect(await onHand()).toBe(stock);
    expect((await cancelOn(sql, id))["status"]).toBe("success");
    expect(await onHand()).toBe(stock + 2);
  });
});

// ── tenancy under the same races ─────────────────────────────────────────────

describe("cross-tenant cancellation", () => {
  it("organization B cannot cancel A's order, even while A's handoff holds the lock", async () => {
    const id = await confirmedOrder();
    const d = await deliveryAt(id, "ready");
    const before = await state(id);
    const stock = await onHand();
    const a = await sql.reserve();
    try {
      await a`begin`;
      expect((await deliveryOn(a, d, "ready", "in_transit"))["status"]).toBe("success");
      // B's call never reaches A's row lock: not_found, immediately.
      const [r] = await sql`select transition_order_status_v1(${ORG_B}::uuid, ${id}::uuid,
        'lifecycle', 'confirmed', 'cancelled', ${ACTOR}::uuid, 'cross-tenant') as r`;
      expect(r!.r).toEqual({ status: "not_found" });
      await a`commit`;
    } finally {
      a.release();
    }
    const s = await state(id);
    expect(s.lifecycle).toBe("confirmed");
    expect(s.history.filter((h) => h.startsWith("lifecycle"))).toEqual(
      before.history.filter((h) => h.startsWith("lifecycle")),
    );
    expect(await onHand()).toBe(stock);
  });
});
