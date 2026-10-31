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
/** Supabase default privileges, every migration but 068 — 068 is applied by a test. */
let supabase: Db;
/** Supabase default privileges, migrations before 062 only. */
let early: Db;
/** Every migration but 068, seeded with each legacy state the inventory reports. */
let legacy: Db;

/**
 * `include` picks the migration files applied (in order). `supabaseDefaults`
 * adds Supabase's default privileges — EXECUTE on every new function, ALL on
 * every new table and sequence, for anon, authenticated and service_role — the
 * baseline migration 062's authority checks were written against.
 */
async function build(
  name: string,
  include: (file: string) => boolean,
  supabaseDefaults = false,
): Promise<Db> {
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
  if (supabaseDefaults) {
    await sql.unsafe(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
  }
  for (const file of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    if (!include(file)) continue;
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
  fixed = await build(`apsa_pay_guard_${suffix}`, () => true);
  before = await build(`apsa_pay_guard_before_${suffix}`, (f) => f !== MIGRATION);
  supabase = await build(`apsa_pay_guard_supa_${suffix}`, (f) => f !== MIGRATION, true);
  early = await build(`apsa_pay_guard_early_${suffix}`, (f) => f < "062_", true);
  legacy = await build(`apsa_pay_guard_legacy_${suffix}`, (f) => f !== MIGRATION);
}, 300_000);

afterAll(async () => {
  for (const db of [fixed, before, supabase, early, legacy]) {
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

/** The metadata on a payment's confirmation event (staff / manager / bank), {} when none. */
async function verificationMetadata(payment: string): Promise<Json> {
  const rows = await fixed.sql`select metadata from payment_events where payment_id = ${payment}
    and event_type in ('staff_confirmed', 'manager_verified', 'bank_verified')
    order by created_at desc limit 1`;
  return (rows[0]?.metadata as Json | null) ?? {};
}

/** The net held (received − refunded) — what reconciliation compares to the total for `overpaid`. */
async function net(order: string): Promise<number> {
  const [r] =
    await fixed.sql`select net_minor::int as n from order_payment_totals where order_id = ${order}`;
  return r.n as number;
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

  it("a deposit recorded on a draft before 068 can be confirmed and refunded — never stranded", async () => {
    const draft = await newOrder(fixed, "draft");
    const payment = await legacyClaim(fixed, draft, TOTAL, "khqr");
    expect((await verify(fixed, payment, "unverified", "bank_verified"))["status"]).toBe("success");
    expect(await state(fixed, draft)).toMatchObject({ lifecycle: "draft", payment: "paid" });
    expect((await refund(fixed, payment, TOTAL))["status"]).toBe("success");
    expect(await state(fixed, draft)).toMatchObject({ refund: "full", refunded: TOTAL });
    // ...and the draft still takes no new money.
    expect((await record(fixed, draft, 100))["status"]).toBe("order_not_payable");
  });

  it("a legacy draft claim that did not arrive is rejected instead; lowering a claim is never refused", async () => {
    const draft = await newOrder(fixed, "draft");
    const payment = await legacyClaim(fixed, draft, TOTAL);
    expect((await verify(fixed, payment, "unverified", "mismatch"))["status"]).toBe("success");
    expect((await state(fixed, draft)).payment).toBe("failed");
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
    expect(await verify(fixed, codId, "mismatch", "unverified")).toEqual({
      status: "claim_exceeds_total",
      outstanding_minor: 0,
    });
    expect((await verify(fixed, khqr["payment_id"] as string))["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", received: TOTAL });
  });

  it("a legacy over-claim that really arrived: confirmed with its excess stamped, flagged overpaid, the excess refunded", async () => {
    const order = await newOrder(fixed);
    const a = await legacyClaim(fixed, order, TOTAL);
    const b = await legacyClaim(fixed, order, 5000, "khqr");
    expect((await verify(fixed, a))["status"]).toBe("success");
    // The first confirmation fits: no excess on its event.
    expect(await verificationMetadata(a)).toEqual({});
    expect((await verify(fixed, b, "unverified", "bank_verified"))["status"]).toBe("success");
    // The excess it creates is written into its own immutable event.
    expect(await verificationMetadata(b)).toEqual({
      order_excess_minor: 5000,
      order_total_minor: TOTAL,
    });
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", received: TOTAL + 5000 });
    expect(await net(order)).toBe(TOTAL + 5000); // reconciliation: overpaid by 5000
    // Returning the excess: a refund on the payment that over-collected.
    expect((await refund(fixed, b, 5000))["status"]).toBe("success");
    expect(await net(order)).toBe(TOTAL); // no longer overpaid
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", refund: "partial" });
    // ...and the order still takes no new money.
    expect((await record(fixed, order, 1))["status"]).toBe("exceeds_outstanding");
    // A stronger verification of the settled payment changes no claim and is allowed.
    expect((await verify(fixed, a, "staff_confirmed", "manager_verified"))["status"]).toBe(
      "success",
    );
  });
});

// ── 068: confirmation under the order lock ───────────────────────────────────

describe("068: concurrent confirmations of legacy claims", () => {
  it("the second waits on the order lock and stamps the excess the first one's commit left", async () => {
    const order = await newOrder(fixed);
    const a = await legacyClaim(fixed, order, 8000);
    const b = await legacyClaim(fixed, order, 8000, "khqr");
    await pair(fixed, async (x, y) => {
      await x`begin`;
      expect((await verifyOn(x, a))["status"]).toBe("success");
      const pid = await backendPid(y);
      const pending = verifyOn(y, b, "unverified", "bank_verified");
      await waitUntilBlockedOnLock(fixed, pid);
      await x`commit`;
      expect((await pending)["status"]).toBe("success");
    });
    expect(await verificationMetadata(a)).toEqual({});
    // Computed after the lock: received 8000 (committed) + 8000 → 6000 above 10000.
    expect(await verificationMetadata(b)).toEqual({
      order_excess_minor: 6000,
      order_total_minor: TOTAL,
    });
    expect(await net(order)).toBe(16000);
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

// ── 068: authority, ownership and deployment order ───────────────────────────

const GUARDED = [
  "record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)",
  "verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)",
];

/** Every public function's identity and authority (bodies of the two guarded ones excluded). */
async function functionAuthority(db: Db) {
  return db.sql`
    select p.oid::regprocedure::text as sig, pg_get_userbyid(p.proowner) as owner,
      p.prosecdef as definer, p.proconfig::text as config, p.provolatile as volatility,
      p.proacl::text as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by 1`;
}

async function privileges(db: Db, signature: string) {
  const fn = `public.${signature}`;
  const [row] = await db.sql`
    select has_function_privilege('anon', ${fn}::regprocedure, 'EXECUTE') as anon,
      has_function_privilege('authenticated', ${fn}::regprocedure, 'EXECUTE') as authenticated,
      has_function_privilege('service_role', ${fn}::regprocedure, 'EXECUTE') as service_role,
      exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = ${fn}::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public`;
  return row;
}

async function sqlState(db: Db, role: string, statement: string): Promise<string> {
  try {
    await db.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx.unsafe(statement);
      throw new Error("__rollback__");
    });
  } catch (error) {
    const e = error as { message?: string; errno?: string; code?: string };
    if (e.message === "__rollback__") return "ok";
    return String(e.errno ?? e.code ?? e.message);
  }
  return "ok";
}

describe("068: authority under Supabase's default privileges", () => {
  it("keeps every function's owner, SECURITY DEFINER, search_path, volatility and ACL; adds no function", async () => {
    const beforeAuthority = await functionAuthority(supabase);
    await supabase.sql.unsafe(readFileSync(`supabase/migrations/${MIGRATION}`, "utf8"));
    const afterAuthority = await functionAuthority(supabase);
    expect(afterAuthority).toEqual(beforeAuthority);
    for (const sig of GUARDED) {
      const [meta] = await supabase.sql`
        select pg_get_userbyid(proowner) as owner, prosecdef as definer, proconfig::text as config
        from pg_proc where oid = ${`public.${sig}`}::regprocedure`;
      expect(meta).toEqual({
        owner: "postgres",
        definer: true,
        config: '{"search_path=public, auth"}',
      });
      expect(await privileges(supabase, sig)).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
        public: false,
      });
    }
    // The guarded body is what runs: a draft order is refused through it.
    const [body] = await supabase.sql`select prosrc from pg_proc
      where oid = 'public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)'::regprocedure`;
    expect(String(body.prosrc)).toContain("order_not_payable");
  });

  it("anon and authenticated are refused (42501); service_role reaches the guard", async () => {
    const order = crypto.randomUUID();
    await supabase.sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
      values(${order},${ORG},${order},'MANUAL','USD',${TOTAL},${TOTAL},${ACTOR})`;
    const call = `select record_payment_v2('${ORG}'::uuid, '${order}'::uuid, '${ACTOR}'::uuid, 'cash', 100, null, null, null)`;
    const verify = `select verify_payment_v1('${ORG}'::uuid, gen_random_uuid(), '${ACTOR}'::uuid, 'unverified', 'staff_confirmed', null, null)`;
    for (const role of ["anon", "authenticated"]) {
      expect(await sqlState(supabase, role, call)).toBe("42501");
      expect(await sqlState(supabase, role, verify)).toBe("42501");
    }
    expect(await sqlState(supabase, "service_role", call)).toBe("ok");
    const [r] = await supabase.sql.begin(async (tx) => {
      await tx`set local role service_role`;
      return tx.unsafe(`${call} as r`);
    });
    expect(r.r).toEqual({ status: "order_not_payable", lifecycle: "draft" });
  });

  it("applied before 062, 068 aborts and changes nothing", async () => {
    const beforeAuthority = await functionAuthority(early);
    const [verifyBefore] = await early.sql`select prosrc from pg_proc
      where oid = 'public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)'::regprocedure`;
    await expect(
      early.sql.unsafe(readFileSync(`supabase/migrations/${MIGRATION}`, "utf8")),
    ).rejects.toThrow(/requires migrations 040 and 062/);
    expect(await functionAuthority(early)).toEqual(beforeAuthority);
    const [exists] = await early.sql`select to_regprocedure(
      'public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)') is not null as present`;
    expect(exists.present).toBe(false);
    const [verifyAfter] = await early.sql`select prosrc from pg_proc
      where oid = 'public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)'::regprocedure`;
    expect(verifyAfter.prosrc).toBe(verifyBefore.prosrc);
  });
});

// ── 068: the lowering transitions stay open ──────────────────────────────────

describe("068: reject, correct and COD settlement", () => {
  const correct = (payment: string) =>
    svc(fixed, (tx) =>
      tx`select correct_payment_v2(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid,
          'typo in reference', 'REF-FIXED', null) as r`.then((rows) => rows[0].r as Json),
    );

  it("on a cancelled order, an earlier claim can be rejected, corrected or reversed", async () => {
    const order = await newOrder(fixed);
    const a = (await record(fixed, order, 4000))["payment_id"] as string;
    const b = (await record(fixed, order, 3000))["payment_id"] as string;
    const c = (await record(fixed, order, 3000))["payment_id"] as string;
    expect((await transition(fixed, order, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
      "success",
    );
    expect((await verify(fixed, a, "unverified", "mismatch"))["status"]).toBe("success");
    expect((await correct(b))["status"]).toBe("success");
    expect((await reverse(fixed, c))["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({ lifecycle: "cancelled", received: 0 });
  });

  it("a COD claim for the whole total is confirmed when the courier hands the cash over", async () => {
    const order = await newOrder(fixed);
    const cod = await record(fixed, order, TOTAL, undefined, "cod");
    expect(cod["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({ payment: "pending", received: 0 });
    expect((await verify(fixed, cod["payment_id"] as string))["status"]).toBe("success");
    expect(await state(fixed, order)).toMatchObject({ payment: "paid", received: TOTAL });
  });
});

// ── the owner-run legacy inventory (scripts/sql) ─────────────────────────────

const INVENTORY = "scripts/sql/apsa_068_payment_legacy_inventory.sql";
type InventoryRow = {
  check_id: string;
  category: string;
  currency: string | null;
  organizations: number | null;
  orders: number | null;
  payments: number | null;
  amount_minor: number | null;
  meaning: string;
};

/** The file's exact bytes, in one session, as psql would send them. */
async function inventory(db: Db): Promise<Map<string, InventoryRow>> {
  const conn = await db.sql.reserve();
  let results: unknown[];
  try {
    results = (await conn.unsafe(readFileSync(INVENTORY, "utf8")).simple()) as unknown[];
  } finally {
    conn.release();
  }
  const rows = results
    .flat()
    .filter((r) => r && typeof r === "object" && "check_id" in (r as object));
  const byId = new Map<string, InventoryRow>();
  for (const r of rows as Json[]) {
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    byId.set(String(r["check_id"]), {
      check_id: String(r["check_id"]),
      category: String(r["category"]),
      currency: (r["currency"] as string | null) ?? null,
      organizations: n(r["organizations"]),
      orders: n(r["orders"]),
      payments: n(r["payments"]),
      amount_minor: n(r["amount_minor"]),
      meaning: String(r["meaning"]),
    });
  }
  return byId;
}
const counts = (r: InventoryRow | undefined) =>
  r && [r.currency, r.organizations, r.orders, r.payments, r.amount_minor];

describe("legacy inventory (read-only, aggregates only)", () => {
  it("counts every legacy state on a database that ran an earlier release", async () => {
    // Each state written through the real pre-068 functions, as service_role.
    const o1 = await newOrder(legacy); // cancelled, pending 3000
    expect((await record(legacy, o1, 3000))["status"]).toBe("success");
    expect((await transition(legacy, o1, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
      "success",
    );
    const o2 = await completedOrder(legacy); // completed, extra pending 5000
    expect((await record(legacy, o2, 5000, undefined, "khqr"))["status"]).toBe("success");
    const o3 = await newOrder(legacy); // settled 12000 on 10000
    const over = await record(legacy, o3, 12000);
    expect((await verify(legacy, over["payment_id"] as string))["status"]).toBe("success");
    const o4 = await newOrder(legacy, "draft"); // draft, pending 4000
    expect((await record(legacy, o4, 4000))["status"]).toBe("success");
    const o5 = await newOrder(legacy, "draft"); // draft, paid 10000
    const draftPaid = await record(legacy, o5, TOTAL);
    expect((await verify(legacy, draftPaid["payment_id"] as string))["status"]).toBe("success");
    const o6 = await newOrder(legacy); // KHQR paid in full; the COD claim rejected
    const cod = await record(legacy, o6, TOTAL, undefined, "cod");
    expect(
      (await verify(legacy, cod["payment_id"] as string, "unverified", "mismatch"))["status"],
    ).toBe("success");
    const khqr = await record(legacy, o6, TOTAL, undefined, "khqr");
    expect((await verify(legacy, khqr["payment_id"] as string))["status"]).toBe("success");

    const o7 = await newOrder(legacy); // paid in full, then cancelled: money held on a cancelled sale
    const held = await record(legacy, o7, TOTAL);
    expect((await verify(legacy, held["payment_id"] as string))["status"]).toBe("success");
    expect((await transition(legacy, o7, "lifecycle", "confirmed", "cancelled"))["status"]).toBe(
      "success",
    );

    const before = await legacy.sql`select
      (select count(*)::int from payments) as p, (select count(*)::int from payment_events) as e,
      (select count(*)::int from orders) as o, (select count(*)::int from order_status_history) as h`;
    const r = await inventory(legacy);
    const after = await legacy.sql`select
      (select count(*)::int from payments) as p, (select count(*)::int from payment_events) as e,
      (select count(*)::int from orders) as o, (select count(*)::int from order_status_history) as h`;
    expect(after).toEqual(before); // read-only

    expect(counts(r.get("01.01"))).toEqual(["USD", 1, 1, 1, 3000]);
    expect(counts(r.get("01.02"))).toEqual(["USD", 1, 1, 1, 5000]);
    expect(counts(r.get("01.03"))).toEqual(["USD", 1, 1, null, TOTAL]);
    expect(counts(r.get("02.01"))).toEqual(["USD", 1, 1, null, 2000]);
    expect(counts(r.get("02.02"))).toEqual(["USD", 1, 2, null, 7000]);
    expect(counts(r.get("02.03"))).toEqual(["USD", 1, 1, null, 2000]);
    expect(counts(r.get("03.01"))).toEqual(["USD", 1, 1, 1, 4000]);
    expect(counts(r.get("03.02"))).toEqual(["USD", 1, 1, 1, TOTAL]);
    expect(counts(r.get("03.03"))).toEqual([null, 0, 0, 0, 0]);
    expect(counts(r.get("04.01"))).toEqual(["USD", 1, 2, 2, 9000]); // o2's 5000 + o4's 4000
    expect(counts(r.get("04.02"))).toEqual(["USD", 1, 1, 1, TOTAL]); // o6's rejected COD
    expect(r.get("99.01")!.meaning).toStartWith("REVIEW");

    // The same claims, judged by 068 itself once applied: the inventory's 04.x
    // rows are exactly what the guard refuses.
    await legacy.sql.unsafe(readFileSync(`supabase/migrations/${MIGRATION}`, "utf8"));
    const pendingRow = async (order: string) =>
      (
        await legacy.sql`select id from payments where order_id = ${order} and status = 'pending'`
      )[0].id as string;
    // 04.01: confirmable — the excess is stamped, then flagged overpaid.
    const o2Pending = await pendingRow(o2);
    expect((await verify(legacy, o2Pending))["status"]).toBe("success");
    expect(
      (
        await legacy.sql`select metadata from payment_events where payment_id = ${o2Pending}
          and event_type = 'staff_confirmed'`
      )[0].metadata,
    ).toEqual({ order_excess_minor: 5000, order_total_minor: TOTAL });
    expect((await verify(legacy, await pendingRow(o4)))["status"]).toBe("success"); // draft deposit
    expect((await verify(legacy, await pendingRow(o1)))["status"]).toBe("success"); // 01.01
    // 04.02: reinstating the rejected COD claim is refused.
    expect(
      (await verify(legacy, cod["payment_id"] as string, "mismatch", "unverified"))["status"],
    ).toBe("claim_exceeds_total");
    expect(r.get("99.01")).toBeDefined();
  });

  it("returns no identifier, and reports every category even when empty", async () => {
    const r = await inventory(fixed);
    for (const row of r.values()) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "amount_minor",
          "category",
          "check_id",
          "currency",
          "meaning",
          "organizations",
          "orders",
          "payments",
        ].sort(),
      );
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
    for (const id of [
      "01.01",
      "01.02",
      "01.03",
      "02.01",
      "02.02",
      "02.03",
      "03.01",
      "03.02",
      "03.03",
      "04.01",
      "04.02",
      "99.01",
    ]) {
      expect(r.has(id)).toBe(true);
    }
    expect(r.get("99.01")!.meaning).toStartWith("NOTE: 068 already appears applied");
  });

  it("is refused any write: it runs in a READ ONLY transaction", () => {
    const text = readFileSync(INVENTORY, "utf8");
    expect(text).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(text.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(
      /\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy)\b/i,
    );
  });
});
