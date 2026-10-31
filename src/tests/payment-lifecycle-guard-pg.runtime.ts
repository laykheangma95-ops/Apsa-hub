/**
 * Payment lifecycle and outstanding-balance guard (migration 068, PROVISIONAL —
 * the policy it encodes awaits the project owner's decision) under REAL
 * PostgreSQL, with independent connections contending for the order row lock.
 *
 * Two throwaway databases, both built from the real migrations:
 *   fixed   every migration (068 included);
 *   before  every migration except 068 — main as it stands. Each defect is
 *           first shown to reproduce there (negative control), so a test that
 *           passes on `fixed` is known to detect the defect, not to pass
 *           vacuously.
 *
 * Every financial RPC runs under SET ROLE service_role, the role the deployed
 * server uses. Only the "legacy claim" helper runs as the owner: it writes a
 * claim the way record_payment_v2 did before 068 (its recording body directly),
 * to exercise the verification guard on pre-existing data.
 *
 * "Waits" is observed, not assumed: the second backend's pg_stat_activity row
 * must report wait_event_type = 'Lock' before the first transaction commits.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test src/tests/payment-lifecycle-guard-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL)
  throw new Error("APSA_TEST_PG_URL is required for payment-lifecycle-guard-pg.runtime.ts");

const MIGRATION = "068_payment_lifecycle_guard.sql";
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const TOTAL = 10000;

type Json = Record<string, unknown>;
type Db = { name: string; sql: SQL };

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
let admin: SQL;
let fixed: Db;
let before: Db;

async function build(name: string, omit: string | null): Promise<Db> {
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const sql = new SQL({ url: url.toString(), max: 10 });
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
  for (const file of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    if (file === omit) continue;
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${file}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file}: ${String(error)}`);
    }
  }
  await sql`insert into auth.users(id,email) values(${ACTOR},'payment-guard@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'A','A','guard-a',${ACTOR}),(${ORG_B},'B','B','guard-b',${ACTOR})`;
  return { name, sql };
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  expect(readdirSync("supabase/migrations")).toContain(MIGRATION);
  fixed = await build(`apsa_pay_guard_${suffix}`, null);
  before = await build(`apsa_pay_guard_before_${suffix}`, MIGRATION);
}, 180_000);

afterAll(async () => {
  for (const db of [fixed, before]) {
    await db?.sql.close();
    if (db) await admin?.unsafe(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
  }
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** One call as the deployed server makes it: service_role, its own transaction. */
async function svc(db: Db, run: (tx: SQL) => Promise<Json>): Promise<Json> {
  return db.sql.begin(async (tx) => {
    await tx`set local role service_role`;
    return run(tx);
  }) as Promise<Json>;
}

const recordOn = (
  conn: SQL,
  order: string,
  amount: number,
  key: string | null = crypto.randomUUID(),
  method = "cash",
  org = ORG,
) =>
  conn`select record_payment_v2(${org}::uuid, ${order}::uuid, ${ACTOR}::uuid, ${method},
      ${amount}::bigint, null, ${key}, null) as r`.then((rows) => rows[0].r as Json);

const verifyOn = (
  conn: SQL,
  payment: string,
  from = "unverified",
  to = "staff_confirmed",
  org = ORG,
) =>
  conn`select verify_payment_v1(${org}::uuid, ${payment}::uuid, ${ACTOR}::uuid, ${from}, ${to},
      'test', null) as r`.then((rows) => rows[0].r as Json);

const transitionOn = (conn: SQL, order: string, axis: string, from: string, to: string) =>
  conn`select transition_order_status_v1(${ORG}::uuid, ${order}::uuid, ${axis}, ${from}, ${to},
      ${ACTOR}::uuid, 'test') as r`.then((rows) => rows[0].r as Json);

const record = (
  db: Db,
  order: string,
  amount: number,
  key?: string | null,
  method?: string,
  org?: string,
) =>
  svc(db, (tx) =>
    recordOn(tx, order, amount, key === undefined ? crypto.randomUUID() : key, method, org),
  );
const verify = (db: Db, payment: string, from?: string, to?: string, org?: string) =>
  svc(db, (tx) => verifyOn(tx, payment, from, to, org));
const transition = (db: Db, order: string, axis: string, from: string, to: string) =>
  svc(db, (tx) => transitionOn(tx, order, axis, from, to));
const refund = (
  db: Db,
  payment: string,
  amount: number,
  acknowledged: string[] = [],
  expected = 0,
) =>
  svc(db, (tx) =>
    tx`select refund_payment_v2(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid, ${amount}::bigint,
        'test refund', ${crypto.randomUUID()}, ${expected}::bigint, ${acknowledged}::uuid[]) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
const reverse = (db: Db, payment: string) =>
  svc(db, (tx) =>
    tx`select reverse_payment_v2(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid, 'test reversal') as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );

async function newOrder(db: Db, lifecycle: "draft" | "confirmed" = "confirmed", org = ORG) {
  const id = crypto.randomUUID();
  await db.sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
    values(${id},${org},${id},'MANUAL','USD',${TOTAL},${TOTAL},${ACTOR})`;
  if (lifecycle === "confirmed") {
    // Through the real confirmation (057: atomic APSA Parcel), as the server.
    const r = await svc(db, (tx) =>
      tx`select transition_order_status_v1(${org}::uuid, ${id}::uuid, 'lifecycle', 'draft',
          'confirmed', ${ACTOR}::uuid, null) as r`.then((rows) => rows[0].r as Json),
    );
    expect(r["status"]).toBe("success");
  }
  return id;
}

async function cancelledOrder(db: Db) {
  const id = await newOrder(db);
  expect((await transition(db, id, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
    "success",
  );
  return id;
}

/** Fully paid (recorded + verified), fulfilled at the counter, completed. */
async function completedOrder(db: Db) {
  const id = await newOrder(db);
  const paid = await record(db, id, TOTAL);
  expect((await verify(db, paid["payment_id"] as string))["status"]).toBe("success");
  expect((await transition(db, id, "fulfillment", "unfulfilled", "fulfilled"))["status"]).toBe(
    "success",
  );
  expect((await transition(db, id, "lifecycle", "confirmed", "completed"))["status"]).toBe(
    "success",
  );
  return id;
}

/** A claim written the way record_payment_v2 wrote it before 068 (owner, not service_role). */
async function legacyClaim(db: Db, order: string, amount: number, method = "cash") {
  return db.sql.begin(async (tx) => {
    const [row] = await tx`select record_payment_before_order_v1(${ORG}::uuid, ${order}::uuid,
        ${ACTOR}::uuid, ${method}, ${amount}::bigint, ${"legacy-" + crypto.randomUUID()}, null, null) as r`;
    await tx`select sync_order_payment_state(${ORG}::uuid, ${order}::uuid, ${ACTOR}::uuid, 'legacy')`;
    return (row.r as Json)["payment_id"] as string;
  });
}

async function state(db: Db, order: string) {
  const [r] = await db.sql`
    select o.lifecycle_status::text as lifecycle, o.payment_status::text as payment,
      o.refund_status::text as refund, t.received_minor::int as received,
      t.refunded_minor::int as refunded,
      (select count(*)::int from payments p where p.order_id = o.id) as payments,
      (select count(*)::int from payment_events e join payments p on p.id = e.payment_id
        where p.order_id = o.id) as events,
      (select count(*)::int from order_status_history h
        where h.order_id = o.id and h.axis = 'payment') as "paymentHistory"
    from orders o join order_payment_totals t on t.order_id = o.id where o.id = ${order}`;
  return r as {
    lifecycle: string;
    payment: string;
    refund: string;
    received: number;
    refunded: number;
    payments: number;
    events: number;
    paymentHistory: number;
  };
}

async function waitUntilBlockedOnLock(db: Db, pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.sql`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await Bun.sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on the order lock`);
}

async function backendPid(conn: SQL): Promise<number> {
  const [row] = await conn`select pg_backend_pid() as pid`;
  return Number(row.pid);
}

/** Two reserved connections acting as service_role for a lock-contention schedule. */
async function pair<T>(db: Db, run: (a: SQL, b: SQL) => Promise<T>): Promise<T> {
  const a = await db.sql.reserve();
  const b = await db.sql.reserve();
  try {
    await a`set role service_role`;
    await b`set role service_role`;
    return await run(a, b);
  } finally {
    await a`reset role`.catch(() => {});
    await b`reset role`.catch(() => {});
    a.release();
    b.release();
  }
}

// ── negative control: the defect, on main's migrations ───────────────────────

describe("before 068 (main): the defect reproduces", () => {
  it("draft, cancelled and completed orders take and settle payments; any order is overpaid", async () => {
    const draft = await newOrder(before, "draft");
    const cancelled = await cancelledOrder(before);
    const completed = await completedOrder(before);
    const confirmed = await newOrder(before);
    for (const [order, amount] of [
      [draft, TOTAL],
      [cancelled, TOTAL],
      [completed, 5000],
      [confirmed, 25000],
    ] as const) {
      const r = await record(before, order, amount);
      expect(r["status"]).toBe("success");
      expect((await verify(before, r["payment_id"] as string))["status"]).toBe("success");
    }
    expect(await state(before, draft)).toMatchObject({ lifecycle: "draft", payment: "paid" });
    expect(await state(before, cancelled)).toMatchObject({
      lifecycle: "cancelled",
      payment: "paid",
    });
    expect((await state(before, completed)).received).toBe(15000);
    expect((await state(before, confirmed)).received).toBe(25000);
  });

  it("a Record Payment queued behind a cancellation succeeds once the cancellation commits", async () => {
    const order = await newOrder(before);
    const result = await pair(before, async (a, b) => {
      await a`begin`;
      expect((await transitionOn(a, order, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
        "success",
      );
      const pid = await backendPid(b);
      const pending = recordOn(b, order, TOTAL);
      await waitUntilBlockedOnLock(before, pid);
      await a`commit`;
      return pending;
    });
    expect(result["status"]).toBe("success");
    expect((await state(before, order)).lifecycle).toBe("cancelled");
  });
});

// ── 068: lifecycle ───────────────────────────────────────────────────────────

describe("068: only a confirmed order takes a new payment", () => {
  it("cancellation holds the order lock → Record Payment waits, then is refused; nothing written", async () => {
    const order = await newOrder(fixed);
    const result = await pair(fixed, async (a, b) => {
      await a`begin`;
      expect((await transitionOn(a, order, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
        "success",
      );
      const pid = await backendPid(b);
      const pending = recordOn(b, order, TOTAL);
      await waitUntilBlockedOnLock(fixed, pid);
      await a`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "order_not_payable", lifecycle: "cancelled" });
    expect(await state(fixed, order)).toMatchObject({
      lifecycle: "cancelled",
      payment: "unpaid",
      payments: 0,
      events: 0,
      paymentHistory: 0,
    });
  });

  it("Record Payment holds the lock → cancellation waits, then proceeds; the earlier claim stays confirmable and refundable", async () => {
    const order = await newOrder(fixed);
    const recorded = await pair(fixed, async (a, b) => {
      await a`begin`;
      const r = await recordOn(a, order, TOTAL);
      expect(r["status"]).toBe("success");
      const pid = await backendPid(b);
      const pending = transitionOn(b, order, "lifecycle", "confirmed", "cancelled");
      await waitUntilBlockedOnLock(fixed, pid);
      await a`commit`;
      expect((await pending)["status"]).toBe("success"); // 063: payments do not block cancellation
      return r;
    });
    const payment = recorded["payment_id"] as string;
    expect(await state(fixed, order)).toMatchObject({ lifecycle: "cancelled", payment: "pending" });
    // Money taken before the cancellation can be confirmed and handed back.
    expect((await verify(fixed, payment))["status"]).toBe("success");
    expect((await refund(fixed, payment, TOTAL))["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({
      payment: "paid",
      refund: "full",
      refunded: TOTAL,
    });
    // ...and no new money is taken on it.
    expect((await record(fixed, order, 100))["status"]).toBe("order_not_payable");
  });

  it("draft and completed orders are refused; nothing written", async () => {
    const draft = await newOrder(fixed, "draft");
    expect(await record(fixed, draft, TOTAL)).toEqual({
      status: "order_not_payable",
      lifecycle: "draft",
    });
    expect(await state(fixed, draft)).toMatchObject({ payment: "unpaid", payments: 0, events: 0 });

    const completed = await completedOrder(fixed);
    const beforeState = await state(fixed, completed);
    expect(await record(fixed, completed, 5000)).toEqual({
      status: "order_not_payable",
      lifecycle: "completed",
    });
    expect(await state(fixed, completed)).toEqual(beforeState);
  });

  it("an invalid amount or method is still reported as such, whatever the lifecycle", async () => {
    const cancelled = await cancelledOrder(fixed);
    expect((await record(fixed, cancelled, 0))["status"]).toBe("invalid_amount");
    expect((await record(fixed, cancelled, 100, null, "cheque"))["status"]).toBe("invalid_method");
  });

  it("a payment cannot be confirmed on a draft order (a claim recorded before 068)", async () => {
    const draft = await newOrder(fixed, "draft");
    const payment = await legacyClaim(fixed, draft, TOTAL);
    expect(await verify(fixed, payment)).toEqual({
      status: "order_not_payable",
      lifecycle: "draft",
    });
    expect((await state(fixed, draft)).payment).toBe("pending");
    // Lowering the claim is never refused.
    expect((await verify(fixed, payment, "unverified", "mismatch"))["status"]).toBe("success");
  });
});

// ── 068: outstanding balance ─────────────────────────────────────────────────

describe("068: a new claim must fit the outstanding balance", () => {
  it("more than the total is refused; split payments up to the total are accepted; the next is refused", async () => {
    const order = await newOrder(fixed);
    expect(await record(fixed, order, TOTAL + 1)).toEqual({
      status: "exceeds_outstanding",
      outstanding_minor: TOTAL,
      currency: "USD",
    });
    expect((await state(fixed, order)).payments).toBe(0);
    const first = await record(fixed, order, 6000);
    expect(first["status"]).toBe("success");
    // A pending claim occupies the balance before it is confirmed.
    expect(await record(fixed, order, 4001)).toMatchObject({
      status: "exceeds_outstanding",
      outstanding_minor: 4000,
    });
    expect((await record(fixed, order, 4000, null, "khqr"))["status"]).toBe("success");
    expect(await record(fixed, order, 1)).toMatchObject({
      status: "exceeds_outstanding",
      outstanding_minor: 0,
    });
    expect((await state(fixed, order)).payments).toBe(2);
  });

  it("two concurrent claims that each fit but together exceed: the second waits on the lock, then is refused", async () => {
    const order = await newOrder(fixed);
    const second = await pair(fixed, async (a, b) => {
      await a`begin`;
      expect((await recordOn(a, order, 6000))["status"]).toBe("success");
      const pid = await backendPid(b);
      const pending = recordOn(b, order, 6000, crypto.randomUUID(), "khqr");
      await waitUntilBlockedOnLock(fixed, pid);
      await a`commit`;
      return pending;
    });
    expect(second).toMatchObject({ status: "exceeds_outstanding", outstanding_minor: 4000 });
    expect((await state(fixed, order)).payments).toBe(1);
  });

  it("a legitimate payment's retry replays even when the balance is now covered, or the order since cancelled", async () => {
    const order = await newOrder(fixed);
    const key = crypto.randomUUID();
    const first = await record(fixed, order, TOTAL, key);
    expect(first).toMatchObject({ status: "success", replayed: false });
    const retry = await record(fixed, order, TOTAL, key);
    expect(retry).toMatchObject({
      status: "success",
      replayed: true,
      payment_id: first["payment_id"],
    });
    // The same key with a different amount is not a retry.
    expect((await record(fixed, order, 5000, key))["status"]).toBe("idempotency_conflict");

    expect((await transition(fixed, order, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
      "success",
    );
    expect(await record(fixed, order, TOTAL, key)).toMatchObject({
      status: "success",
      replayed: true,
      payment_id: first["payment_id"],
    });
    expect((await state(fixed, order)).payments).toBe(1);
  });

  it("a reversal frees the balance; a refund does not (refunds never undo money received)", async () => {
    const reversedOrder = await newOrder(fixed);
    const wrong = await record(fixed, reversedOrder, TOTAL);
    expect((await reverse(fixed, wrong["payment_id"] as string))["status"]).toBe("success");
    expect((await record(fixed, reversedOrder, TOTAL))["status"]).toBe("success");

    const refundedOrder = await newOrder(fixed);
    const paid = await record(fixed, refundedOrder, TOTAL);
    const payment = paid["payment_id"] as string;
    expect((await verify(fixed, payment))["status"]).toBe("success");
    expect((await refund(fixed, payment, 2000))["status"]).toBe("success");
    expect(await state(fixed, refundedOrder)).toMatchObject({ payment: "paid", refund: "partial" });
    // Owner decision 3: a re-collection after a refund is refused under this draft.
    expect(await record(fixed, refundedOrder, 2000)).toMatchObject({
      status: "exceeds_outstanding",
      outstanding_minor: 0,
    });
  });

  it("COD: a pending COD claim occupies the balance until it is rejected; it cannot be reinstated over a later payment", async () => {
    const order = await newOrder(fixed);
    const cod = await record(fixed, order, TOTAL, undefined, "cod");
    expect(cod["status"]).toBe("success");
    // The customer paid by KHQR instead: refused while the COD claim stands.
    expect((await record(fixed, order, TOTAL, undefined, "khqr"))["status"]).toBe(
      "exceeds_outstanding",
    );
    // The courier reports no collection → mismatch; now the KHQR fits.
    const codId = cod["payment_id"] as string;
    expect((await verify(fixed, codId, "unverified", "mismatch"))["status"]).toBe("success");
    const khqr = await record(fixed, order, TOTAL, undefined, "khqr");
    expect(khqr["status"]).toBe("success");
    // Reinstating the COD claim would now exceed the total.
    expect(await verify(fixed, codId, "mismatch", "unverified")).toMatchObject({
      status: "exceeds_outstanding",
      outstanding_minor: 0,
    });
    expect((await verify(fixed, khqr["payment_id"] as string))["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", received: TOTAL });
  });

  it("confirming an over-claim recorded before 068 is refused; confirming the one that fits succeeds", async () => {
    const order = await newOrder(fixed);
    const a = await legacyClaim(fixed, order, TOTAL);
    const b = await legacyClaim(fixed, order, TOTAL);
    expect((await verify(fixed, a))["status"]).toBe("success");
    expect(await verify(fixed, b)).toMatchObject({
      status: "exceeds_outstanding",
      outstanding_minor: 0,
    });
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", received: TOTAL });
    // A stronger verification of the settled payment changes no claim and is allowed.
    expect((await verify(fixed, a, "staff_confirmed", "manager_verified"))["status"]).toBe(
      "success",
    );
  });
});

// ── tenancy ──────────────────────────────────────────────────────────────────

describe("068: organization isolation", () => {
  it("another organization's id never reaches, reads or changes the order", async () => {
    const order = await newOrder(fixed);
    const orderB = await newOrder(fixed, "confirmed", ORG_B);
    const paid = await record(fixed, order, 6000);
    expect(paid["status"]).toBe("success");
    // Org B naming org A's order: not found — not 'order_not_payable', not a balance figure.
    expect(await record(fixed, order, 1000, undefined, "cash", ORG_B)).toEqual({
      status: "not_found",
    });
    expect(
      await verify(fixed, paid["payment_id"] as string, "unverified", "staff_confirmed", ORG_B),
    ).toEqual({
      status: "not_found",
    });
    // Org A's claim does not consume org B's balance.
    expect((await record(fixed, orderB, TOTAL, undefined, "cash", ORG_B))["status"]).toBe(
      "success",
    );
    expect(await state(fixed, order)).toMatchObject({ payments: 1, payment: "pending" });
  });
});
