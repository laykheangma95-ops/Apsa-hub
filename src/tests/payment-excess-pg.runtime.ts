/**
 * "Record with excess" and "return the excess" (migration 068 — DRAFT pilot
 * policy, PROVISIONAL number) under REAL PostgreSQL, with independent
 * connections contending for the order row lock.
 *
 * One throwaway database built from every migration under Supabase's default
 * privileges (EXECUTE on every new function, ALL on every new table, for anon,
 * authenticated and service_role) — the baseline 062's authority was written
 * against. Every financial call runs under SET ROLE service_role, the role the
 * deployed server uses; only legacy claims (written the way recording worked
 * before 068) and test-only failure injection run as the owner.
 *
 * "Waits" is observed, not assumed: the second backend's pg_stat_activity row
 * must report wait_event_type = 'Lock' before the first transaction commits.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test src/tests/payment-excess-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for payment-excess-pg.runtime.ts");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000003";
const TOTAL = 10000;

type Json = Record<string, unknown>;

const dbName = `apsa_pay_excess_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 12 });
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
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  for (const file of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${file}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file}: ${String(error)}`);
    }
  }
  await sql`insert into auth.users(id,email) values(${ACTOR},'excess-a@test.invalid'),(${OTHER},'excess-o@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'A','A','excess-a',${ACTOR}),(${ORG_B},'B','B','excess-b',${ACTOR})`;
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function svc(run: (tx: SQL) => Promise<Json>): Promise<Json> {
  return sql.begin(async (tx) => {
    await tx`set local role service_role`;
    return run(tx);
  }) as Promise<Json>;
}

const excessOn = (
  conn: SQL,
  order: string,
  amount: number,
  expectedOutstanding: number,
  o: {
    key?: string;
    method?: string;
    reference?: string | null;
    reason?: string | null;
    org?: string;
    by?: string;
  } = {},
) =>
  conn`select record_payment_with_excess_v1(${o.org ?? ORG}::uuid, ${order}::uuid,
      ${o.by ?? ACTOR}::uuid, ${o.method ?? "bank_transfer"}, ${amount}::bigint,
      ${o.reference === undefined ? `TRF-${crypto.randomUUID().slice(0, 8)}` : o.reference},
      ${o.key ?? crypto.randomUUID()},
      ${o.reason === undefined ? "Customer transferred more than the total" : o.reason},
      ${expectedOutstanding}::bigint) as r`.then((rows) => rows[0].r as Json);

const recordOn = (
  conn: SQL,
  order: string,
  amount: number,
  method = "cash",
  key = crypto.randomUUID(),
) =>
  conn`select record_payment_v2(${ORG}::uuid, ${order}::uuid, ${ACTOR}::uuid, ${method},
      ${amount}::bigint, null, ${key}, null) as r`.then((rows) => rows[0].r as Json);

const transitionOn = (conn: SQL, order: string, from: string, to: string) =>
  conn`select transition_order_status_v1(${ORG}::uuid, ${order}::uuid, 'lifecycle', ${from}, ${to},
      ${ACTOR}::uuid, 'test') as r`.then((rows) => rows[0].r as Json);

const excess = (
  order: string,
  amount: number,
  expectedOutstanding: number,
  o: Parameters<typeof excessOn>[4] = {},
) => svc((tx) => excessOn(tx, order, amount, expectedOutstanding, o));
const record = (order: string, amount: number, method = "cash") =>
  svc((tx) => recordOn(tx, order, amount, method));
const verify = (payment: string, org = ORG) =>
  svc((tx) =>
    tx`select verify_payment_v1(${org}::uuid, ${payment}::uuid, ${ACTOR}::uuid, 'unverified',
        'bank_verified', 'matched on the bank statement', null) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );

async function refundIds(payment: string): Promise<string[]> {
  return (
    await sql`select id from payment_events where payment_id = ${payment} and event_type = 'refund'
      order by created_at, id`
  ).map((r: { id: string }) => r.id);
}
async function refundedTotal(payment: string): Promise<number> {
  const [r] = await sql`select coalesce(sum(amount_minor), 0)::int as n from payment_events
    where payment_id = ${payment} and event_type = 'refund'`;
  return r.n as number;
}

/** The ordinary audited refund (refund_payment_v2), acknowledging every refund already made. */
async function refund(
  payment: string,
  amount: number,
  reason = "Item returned",
  key = crypto.randomUUID(),
) {
  const ack = await refundIds(payment);
  const expected = await refundedTotal(payment);
  return svc((tx) =>
    tx`select refund_payment_v2(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid, ${amount}::bigint,
        ${reason}, ${key}, ${expected}::bigint, ${ack}::uuid[]) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
}

/** Return of the recorded excess (return_payment_excess_v1), acknowledging every refund already made. */
async function returnExcess(
  payment: string,
  amount: number,
  o: { key?: string; reason?: string; org?: string } = {},
) {
  const ack = await refundIds(payment);
  const expected = await refundedTotal(payment);
  return svc((tx) =>
    tx`select return_payment_excess_v1(${o.org ?? ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid,
        ${amount}::bigint, ${o.reason ?? "Excess returned to the customer"}, ${o.key ?? crypto.randomUUID()},
        ${expected}::bigint, ${ack}::uuid[]) as r`.then((rows) => rows[0].r as Json),
  );
}

async function confirmedOrder(org = ORG, total = TOTAL): Promise<string> {
  const id = crypto.randomUUID();
  await sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
    values(${id},${org},${id},'MANUAL','USD',${total},${total},${ACTOR})`;
  const r = await svc((tx) =>
    tx`select transition_order_status_v1(${org}::uuid, ${id}::uuid, 'lifecycle', 'draft', 'confirmed',
        ${ACTOR}::uuid, null) as r`.then((rows) => rows[0].r as Json),
  );
  expect(r["status"]).toBe("success");
  return id;
}

/** A claim written the way recording worked before 068 (owner; body + order sync). */
async function legacyClaim(order: string, amount: number, method = "khqr"): Promise<string> {
  return sql.begin(async (tx) => {
    const [row] = await tx`select record_payment_before_order_v1(${ORG}::uuid, ${order}::uuid,
        ${ACTOR}::uuid, ${method}, ${amount}::bigint, ${"LEGACY-" + crypto.randomUUID()}, null, null) as r`;
    await tx`select sync_order_payment_state(${ORG}::uuid, ${order}::uuid, ${ACTOR}::uuid, 'legacy')`;
    return (row.r as Json)["payment_id"] as string;
  });
}

async function ledger(order: string) {
  const [r] = await sql`
    select (select count(*)::int from payments p where p.order_id = o.id) as payments,
      (select count(*)::int from payment_events e join payments p on p.id = e.payment_id
        where p.order_id = o.id) as events,
      (select count(*)::int from audit_logs a where a.organization_id = o.organization_id
        and a.action like 'payments.%') as audits,
      t.received_minor::int as received, t.refunded_minor::int as refunded, t.net_minor::int as net,
      o.payment_status::text as payment, o.refund_status::text as refund
    from orders o join order_payment_totals t on t.order_id = o.id where o.id = ${order}`;
  return r as {
    payments: number;
    events: number;
    audits: number;
    received: number;
    refunded: number;
    net: number;
    payment: string;
    refund: string;
  };
}

async function createdMetadata(payment: string): Promise<Json> {
  const [r] =
    await sql`select metadata from payment_events where payment_id = ${payment} and event_type = 'created'`;
  const m = { ...(r.metadata as Json) };
  delete m["request_reference_digest"];
  return m;
}

/** The refunds an excess_returned event names — the only ones the UI labels "excess returned". */
async function labelledRefunds(payment: string): Promise<string[]> {
  return (
    await sql`select metadata ->> 'refund_event_id' as id from payment_events
      where payment_id = ${payment} and event_type = 'excess_returned' order by created_at, id`
  ).map((r: { id: string }) => r.id);
}

async function waitUntilBlockedOnLock(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await sql`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await Bun.sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on the order lock`);
}

async function pair<T>(run: (a: SQL, b: SQL, bPid: number) => Promise<T>): Promise<T> {
  const a = await sql.reserve();
  const b = await sql.reserve();
  try {
    await a`set role service_role`;
    await b`set role service_role`;
    const [row] = await b`select pg_backend_pid() as pid`;
    return await run(a, b, Number(row.pid));
  } finally {
    await a`reset role`.catch(() => {});
    await b`reset role`.catch(() => {});
    a.release();
    b.release();
  }
}

async function sqlState(role: string, statement: string): Promise<string> {
  try {
    await sql.begin(async (tx) => {
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

// ── the real overpayment, end to end ─────────────────────────────────────────

describe("a $105 bank transfer for a $100 order", () => {
  it("is recorded in full as a claim, confirmed, flagged, and only the excess is returned", async () => {
    const order = await confirmedOrder();
    // Ordinary recording still refuses it (policy 1).
    expect((await record(order, 10500, "bank_transfer"))["status"]).toBe("exceeds_outstanding");

    const r = await excess(order, 10500, 10000, { reference: "TRF-105" });
    expect(r).toMatchObject({
      status: "success",
      replayed: false,
      excess_minor: 500,
      currency: "USD",
    });
    const payment = r["payment_id"] as string;
    expect(await createdMetadata(payment)).toEqual({
      request_digest_version: 1,
      excess_minor: 500,
      expected_outstanding_minor: 10000,
      order_total_minor: TOTAL,
    });
    // The reference verifies nothing: a pending, unverified claim like any other.
    const [p] = await sql`select status::text, verification_state::text, amount_minor::int, note
      from payments where id = ${payment}`;
    expect(p).toEqual({
      status: "pending",
      verification_state: "unverified",
      amount_minor: 10500,
      note: "Customer transferred more than the total",
    });
    // The mandatory audit row committed with it.
    const [audit] = await sql`select actor_user_id, after_json from audit_logs
      where action = 'payments.record_excess' and resource_id = ${payment}`;
    expect(audit.actor_user_id).toBe(ACTOR);
    expect(audit.after_json).toMatchObject({ excess_minor: 500, amount_minor: 10500 });
    expect(await ledger(order)).toMatchObject({ payment: "pending", received: 0 });

    expect((await verify(payment))["status"]).toBe("success");
    expect(await ledger(order)).toMatchObject({ payment: "paid", received: 10500, net: 10500 });

    // More than the excess is refused; nothing written.
    const before = await ledger(order);
    expect(await returnExcess(payment, 501)).toEqual({
      status: "exceeds_returnable_excess",
      returnable_excess_minor: 500,
      currency: "USD",
    });
    expect(await ledger(order)).toEqual(before);

    const returned = await returnExcess(payment, 500);
    expect(returned).toMatchObject({
      status: "success",
      excess_returned: true,
      returnable_excess_minor: 0,
    });
    expect(await ledger(order)).toMatchObject({
      payment: "paid",
      refund: "partial", // refund ledger semantics unchanged: money was returned
      received: 10500,
      refunded: 500,
      net: TOTAL, // no longer overpaid
    });
    expect(await labelledRefunds(payment)).toEqual(await refundIds(payment));
    const actions = (
      await sql`select action from audit_logs where resource_id = ${payment} order by created_at, id`
    ).map((a: { action: string }) => a.action);
    // Written in SQL, each in its write's own transaction (verification's audit
    // row is the service's, not SQL's).
    // The refund and its excess return commit in one transaction (one timestamp).
    expect(actions.sort()).toEqual(
      ["payments.record_excess", "payments.refund", "payments.return_excess"].sort(),
    );
    // Nothing more can be returned as excess.
    expect((await returnExcess(payment, 1))["status"]).toBe("exceeds_returnable_excess");
  });
});

// ── what the action refuses ──────────────────────────────────────────────────

describe("record with excess — refusals write nothing", () => {
  it("a stale outstanding amount, no excess, and every missing or disallowed field", async () => {
    const order = await confirmedOrder();
    const before = await ledger(order);
    expect(await excess(order, 10500, 9000)).toEqual({
      status: "stale",
      outstanding_minor: 10000,
      currency: "USD",
    });
    expect(await excess(order, 10000, 10000)).toMatchObject({
      status: "no_excess",
      outstanding_minor: 10000,
    });
    for (const method of ["cash", "cod", "cheque"]) {
      expect((await excess(order, 10500, 10000, { method }))["status"]).toBe("method_not_allowed");
    }
    expect((await excess(order, 10500, 10000, { reference: "  " }))["status"]).toBe(
      "reference_required",
    );
    expect((await excess(order, 10500, 10000, { reason: "" }))["status"]).toBe("reason_required");
    expect((await excess(order, 10500, 10000, { key: " " }))["status"]).toBe(
      "idempotency_key_required",
    );
    expect((await excess(order, 0, 10000))["status"]).toBe("invalid_amount");
    expect(await ledger(order)).toEqual(before);
  });

  it("draft and cancelled orders: order_not_payable", async () => {
    const draft = crypto.randomUUID();
    await sql`insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by)
      values(${draft},${ORG},${draft},'MANUAL','USD',${TOTAL},${TOTAL},${ACTOR})`;
    expect(await excess(draft, 10500, 10000)).toEqual({
      status: "order_not_payable",
      lifecycle: "draft",
    });
    const cancelled = await confirmedOrder();
    expect(
      (await svc((tx) => transitionOn(tx, cancelled, "confirmed", "cancelled")))["status"],
    ).toBe("success");
    expect(await excess(cancelled, 10500, 10000)).toEqual({
      status: "order_not_payable",
      lifecycle: "cancelled",
    });
    expect((await ledger(cancelled)).payments).toBe(0);
  });

  it("an audit-store failure rolls the whole recording back (apsa_audit_unavailable)", async () => {
    const order = await confirmedOrder();
    // Test-only failure injection, as the owner, for this action alone.
    await sql.unsafe(`
      CREATE FUNCTION test_fail_excess_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'payments.record_excess' THEN RAISE EXCEPTION 'audit store down'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_excess_audit BEFORE INSERT ON public.audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_fail_excess_audit();`);
    try {
      await expect(excess(order, 10500, 10000)).rejects.toThrow(/apsa_audit_unavailable/);
    } finally {
      await sql.unsafe(`DROP TRIGGER fail_excess_audit ON public.audit_logs;
        DROP FUNCTION test_fail_excess_audit();`);
    }
    expect(await ledger(order)).toMatchObject({ payments: 0, events: 0 });
  });
});

// ── the order lock ───────────────────────────────────────────────────────────

describe("concurrency on the order lock (two connections)", () => {
  it("an ordinary payment holds the lock → the excess recording waits, then is refused as stale", async () => {
    const order = await confirmedOrder();
    const result = await pair(async (a, b, bPid) => {
      await a`begin`;
      expect((await recordOn(a, order, 6000))["status"]).toBe("success");
      const pending = excessOn(b, order, 10500, 10000);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      return pending;
    });
    expect(result).toMatchObject({ status: "stale", outstanding_minor: 4000 });
    expect((await ledger(order)).payments).toBe(1);
  });

  it("the excess recording holds the lock → an ordinary payment waits, then is refused (nothing left owed)", async () => {
    const order = await confirmedOrder();
    const result = await pair(async (a, b, bPid) => {
      await a`begin`;
      expect((await excessOn(a, order, 10500, 10000))["status"]).toBe("success");
      const pending = recordOn(b, order, 1000);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      return pending;
    });
    expect(result).toMatchObject({ status: "exceeds_outstanding", outstanding_minor: 0 });
    expect((await ledger(order)).payments).toBe(1);
  });

  it("two excess recordings for the same outstanding amount: the second waits, then nothing is outstanding (B1)", async () => {
    const order = await confirmedOrder();
    const result = await pair(async (a, b, bPid) => {
      await a`begin`;
      expect((await excessOn(a, order, 10500, 10000))["status"]).toBe("success");
      const pending = excessOn(b, order, 10700, 10000, { method: "khqr" });
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      return pending;
    });
    // The first committed 10500 against 10000: the order is fully claimed.
    expect(result).toEqual({
      status: "nothing_outstanding",
      outstanding_minor: 0,
      currency: "USD",
    });
    expect(await ledger(order)).toMatchObject({ payments: 1 });
  });

  it("a cancellation holds the lock → the excess recording waits, then is refused; nothing written", async () => {
    const order = await confirmedOrder();
    const result = await pair(async (a, b, bPid) => {
      await a`begin`;
      expect((await transitionOn(a, order, "confirmed", "cancelled"))["status"]).toBe("success");
      const pending = excessOn(b, order, 10500, 10000);
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "order_not_payable", lifecycle: "cancelled" });
    expect(await ledger(order)).toMatchObject({ payments: 0, events: 0 });
  });
});

// ── references and retries ───────────────────────────────────────────────────

describe("duplicate references and idempotent retries", () => {
  it("a reference held by another active payment of the same method is refused; another method is only flagged", async () => {
    const first = await confirmedOrder();
    const second = await confirmedOrder();
    const third = await confirmedOrder();
    expect((await excess(first, 10500, 10000, { reference: "TRF-SHARED" }))["status"]).toBe(
      "success",
    );
    // Same method, same canonical reference: refused, nothing written (B2).
    expect(await excess(second, 10500, 10000, { reference: "TRF-SHARED" })).toEqual({
      status: "duplicate_transfer_reference",
    });
    expect(await ledger(second)).toMatchObject({ payments: 0, events: 0 });
    // The same text under ANOTHER method is the 035 rule: suspicious, flagged.
    const dup = await excess(third, 10500, 10000, { reference: "TRF-SHARED", method: "khqr" });
    expect(dup).toMatchObject({ status: "success", duplicate_suspected: true });
    const events = (
      await sql`select event_type::text from payment_events where payment_id = ${dup["payment_id"] as string}
        order by created_at, id`
    ).map((e: { event_type: string }) => e.event_type);
    // One transaction, one timestamp: compared as a set.
    expect(events.sort()).toEqual(["created", "duplicate_flagged"]);
  });

  it("the original request's retry replays; anything else under the key is a conflict", async () => {
    const order = await confirmedOrder();
    const key = crypto.randomUUID();
    const request = { key, reference: "TRF-RETRY", reason: "Sent 105" };
    const first = await excess(order, 10500, 10000, request);
    expect(first).toMatchObject({ status: "success", replayed: false });
    const before = await ledger(order);
    // The outstanding amount is now 0; the retry still carries the screen's 10000.
    expect(await excess(order, 10500, 10000, request)).toMatchObject({
      status: "success",
      replayed: true,
      payment_id: first["payment_id"],
      excess_minor: 500,
    });
    expect(await ledger(order)).toEqual(before); // nothing written, no second audit row
    expect((await excess(order, 10600, 10000, request))["status"]).toBe("idempotency_conflict");
    expect((await excess(order, 10500, 10000, { ...request, reason: "Other" }))["status"]).toBe(
      "idempotency_conflict",
    );
    expect((await excess(order, 10500, 10000, { ...request, by: OTHER }))["status"]).toBe(
      "idempotency_conflict",
    );
    // Cancelled since: the original request still replays (nothing written).
    expect((await svc((tx) => transitionOn(tx, order, "confirmed", "cancelled")))["status"]).toBe(
      "success",
    );
    expect((await excess(order, 10500, 10000, request))["replayed"]).toBe(true);
  });

  it("a key used by an ordinary payment never replays as an excess recording", async () => {
    const order = await confirmedOrder();
    const key = crypto.randomUUID();
    expect((await svc((tx) => recordOn(tx, order, 4000, "bank_transfer", key)))["status"]).toBe(
      "success",
    );
    expect((await excess(order, 10500, 6000, { key }))["status"]).toBe("idempotency_conflict");
  });
});

// ── authority ────────────────────────────────────────────────────────────────

describe("authority", () => {
  const SIGS = [
    "record_payment_with_excess_v1(uuid,uuid,uuid,text,bigint,text,text,text,bigint)",
    "return_payment_excess_v1(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])",
  ];

  it("owner postgres, SECURITY DEFINER, fixed search_path, EXECUTE for service_role only — under Supabase defaults", async () => {
    for (const sig of SIGS) {
      const fn = `public.${sig}`;
      const [meta] = await sql`select pg_get_userbyid(proowner) as owner, prosecdef as definer,
          proconfig::text as config,
          has_function_privilege('anon', oid, 'EXECUTE') as anon,
          has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated,
          has_function_privilege('service_role', oid, 'EXECUTE') as service_role,
          exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
        from pg_proc where oid = ${fn}::regprocedure`;
      expect(meta).toEqual({
        owner: "postgres",
        definer: true,
        config: '{"search_path=public, auth"}',
        anon: false,
        authenticated: false,
        service_role: true,
        public: false,
      });
    }
    // One function per name (no overload can be reached instead).
    const [n] = await sql`select count(*)::int as n from pg_proc
      where proname in ('record_payment_with_excess_v1', 'return_payment_excess_v1')`;
    expect(n.n).toBe(2);
  });

  it("anon and authenticated are refused (42501)", async () => {
    const order = await confirmedOrder();
    const call = `select record_payment_with_excess_v1('${ORG}'::uuid, '${order}'::uuid, '${ACTOR}'::uuid,
      'khqr', 10500, 'TRF-X', 'k-${crypto.randomUUID()}', 'r', 10000)`;
    const ret = `select return_payment_excess_v1('${ORG}'::uuid, gen_random_uuid(), '${ACTOR}'::uuid,
      1, 'r', 'k', 0, '{}'::uuid[])`;
    const others = [
      `select reinstate_excess_payment_v1('${ORG}'::uuid, gen_random_uuid(), '${ACTOR}'::uuid, 'r')`,
      `select list_excess_to_return_v1('${ORG}'::uuid, 10, 0)`,
      `select payment_excess_state_v1('${ORG}'::uuid, gen_random_uuid())`,
      `select payment_reference_canonical_v1('x')`,
    ];
    for (const role of ["anon", "authenticated"]) {
      expect(await sqlState(role, call)).toBe("42501");
      expect(await sqlState(role, ret)).toBe("42501");
      for (const statement of others) expect(await sqlState(role, statement)).toBe("42501");
    }
    expect(await sqlState("service_role", call)).toBe("ok");
    for (const statement of others) expect(await sqlState("service_role", statement)).toBe("ok");
    // The internal helpers are not callable even by service_role.
    expect(
      await sqlState(
        "service_role",
        `select payment_reference_held_v1('${ORG}'::uuid, 'khqr', 'x', null, false)`,
      ),
    ).toBe("42501");
  });

  it("payments.record_excess is seeded to OWNER and MANAGER only; refunds stay OWNER-only", async () => {
    const grants =
      await sql`select p.key, array_agg(r.system_role::text order by r.system_role::text) as roles
      from role_permissions rp join permissions p on p.id = rp.permission_id
      join roles r on r.id = rp.role_id and r.organization_id is null
      where p.key in ('payments.record_excess', 'payments.refund') group by p.key order by p.key`;
    expect(grants).toEqual([
      { key: "payments.record_excess", roles: ["MANAGER", "OWNER"] },
      { key: "payments.refund", roles: ["OWNER"] },
    ]);
  });

  it("another organization's id never reaches the order or the payment", async () => {
    const order = await confirmedOrder();
    const paid = await excess(order, 10500, 10000);
    const payment = paid["payment_id"] as string;
    expect((await verify(payment))["status"]).toBe("success");
    const before = await ledger(order);
    expect(await excess(order, 10500, 0, { org: ORG_B })).toEqual({ status: "not_found" });
    expect(await returnExcess(payment, 100, { org: ORG_B })).toEqual({ status: "not_found" });
    expect(await ledger(order)).toEqual(before);
  });
});

// ── returning only the excess ────────────────────────────────────────────────

describe("returning the excess", () => {
  async function overpaid(amount = 10500) {
    const order = await confirmedOrder();
    const r = await excess(order, amount, TOTAL);
    const payment = r["payment_id"] as string;
    return { order, payment };
  }

  it("is refused before the payment is confirmed, and for a payment recorded without excess", async () => {
    const { order, payment } = await overpaid();
    expect(await returnExcess(payment, 100)).toEqual({
      status: "invalid_state",
      current: "pending",
    });
    const ordinaryOrder = await confirmedOrder();
    const ordinary = await record(ordinaryOrder, 5000, "bank_transfer");
    expect(await returnExcess(ordinary["payment_id"] as string, 100)).toEqual({
      status: "no_recorded_excess",
    });
    expect((await ledger(order)).refunded).toBe(0);
  });

  it("an ordinary refund is never labelled, even for the excess amount; it lowers what can still be returned", async () => {
    const { order, payment } = await overpaid();
    expect((await verify(payment))["status"]).toBe("success");
    // An unrelated refund of exactly the excess amount, through the ordinary refund.
    expect((await refund(payment, 500, "Damaged item"))["status"]).toBe("success");
    expect(await labelledRefunds(payment)).toEqual([]);
    // The order is no longer above its total: nothing is returnable as excess.
    expect(await returnExcess(payment, 1)).toMatchObject({
      status: "exceeds_returnable_excess",
      returnable_excess_minor: 0,
    });
    expect(await ledger(order)).toMatchObject({ net: TOTAL, refund: "partial" });
  });

  it("partial returns add up to the excess; the retry replays; a reused key is a conflict", async () => {
    const { order, payment } = await overpaid(11000);
    expect((await verify(payment))["status"]).toBe("success");
    const key = crypto.randomUUID();
    const first = await returnExcess(payment, 300, { key });
    expect(first).toMatchObject({
      status: "success",
      excess_returned: true,
      returnable_excess_minor: 700,
    });
    const before = await ledger(order);
    // The same request again (its acknowledgement and expected total as first sent).
    const replay = await svc((tx) =>
      tx`select return_payment_excess_v1(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid, 300::bigint,
          'Excess returned to the customer', ${key}, 0::bigint, '{}'::uuid[]) as r`.then(
        (rows) => rows[0].r as Json,
      ),
    );
    expect(replay["replayed"]).toBe(true);
    expect(await ledger(order)).toEqual(before);
    expect((await returnExcess(payment, 400, { key }))["status"]).toBe("idempotency_conflict");
    expect((await returnExcess(payment, 700))["status"]).toBe("success");
    expect(await ledger(order)).toMatchObject({ net: TOTAL, refunded: 1000 });
    expect((await labelledRefunds(payment)).length).toBe(2);
    expect(await labelledRefunds(payment)).toEqual(await refundIds(payment));
  });

  it("a key used by an ordinary refund never replays as an excess return", async () => {
    const { payment } = await overpaid();
    expect((await verify(payment))["status"]).toBe("success");
    const key = crypto.randomUUID();
    expect((await refund(payment, 100, "Damaged item", key))["status"]).toBe("success");
    expect((await returnExcess(payment, 100, { key }))["status"]).toBe("idempotency_conflict");
    expect(await labelledRefunds(payment)).toEqual([]);
  });
});

// ── legacy over-claims (recorded before 068), separately ─────────────────────

describe("legacy over-claims", () => {
  it("are confirmable with the excess stamped, refundable only through the ordinary refund, never labelled", async () => {
    const order = await confirmedOrder();
    const settled = await legacyClaim(order, TOTAL, "cash");
    const over = await legacyClaim(order, 500);
    expect((await verify(settled))["status"]).toBe("success");
    expect((await verify(over))["status"]).toBe("success");
    const [stamp] = await sql`select metadata from payment_events where payment_id = ${over}
      and event_type = 'bank_verified'`;
    expect(stamp.metadata).toEqual({ order_excess_minor: 500, order_total_minor: TOTAL });
    // No recorded excess: the excess-return action does not apply...
    expect(await returnExcess(over, 500)).toEqual({ status: "no_recorded_excess" });
    // ...the ordinary refund returns it, and it is not labelled "excess returned".
    expect((await refund(over, 500, "Duplicate transfer returned"))["status"]).toBe("success");
    expect(await labelledRefunds(over)).toEqual([]);
    expect(await ledger(order)).toMatchObject({ net: TOTAL, payment: "paid", refund: "partial" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Repair of the independently reproduced defects (B1, B2, M1, M2, B3). Each
// "negative control" below fails against bc7533b's 068.
// ═════════════════════════════════════════════════════════════════════════════

async function counts(order: string) {
  const l = await ledger(order);
  const [a] = await sql`select count(*)::int as n from audit_logs where action like 'payments.%'`;
  return { ...l, allAudits: a.n as number };
}

const ordinary = (order: string, amount: number, method: string, reference: string | null) =>
  svc((tx) =>
    tx`select record_payment_v2(${ORG}::uuid, ${order}::uuid, ${ACTOR}::uuid, ${method},
        ${amount}::bigint, ${reference}, ${crypto.randomUUID()}, null) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
const verifyAs = (payment: string, from: string, to: string, org = ORG) =>
  svc((tx) =>
    tx`select verify_payment_v1(${org}::uuid, ${payment}::uuid, ${ACTOR}::uuid, ${from}, ${to},
        'review probe', null) as r`.then((rows) => rows[0].r as Json),
  );
const reverse = (payment: string) =>
  svc((tx) =>
    tx`select reverse_payment_v2(${ORG}::uuid, ${payment}::uuid, ${ACTOR}::uuid, 'recorded in error') as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
const reinstate = (payment: string, reason: string | null = "Rejected by mistake", org = ORG) =>
  svc((tx) =>
    tx`select reinstate_excess_payment_v1(${org}::uuid, ${payment}::uuid, ${ACTOR}::uuid, ${reason}) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
const excessState = (payment: string, org = ORG) =>
  svc((tx) =>
    tx`select payment_excess_state_v1(${org}::uuid, ${payment}::uuid) as r`.then(
      (rows) => rows[0].r as Json,
    ),
  );
const listExcess = (org: string, limit: number, offset: number) =>
  svc((tx) =>
    tx`select list_excess_to_return_v1(${org}::uuid, ${limit}, ${offset}) as r`.then(
      (rows) => rows[0].r as { total: number; rows: Json[]; status: string },
    ),
  );

describe("B1 — record with excess needs a still-positive outstanding amount", () => {
  it("negative control: a second recording of a transfer on a fully paid order is refused (TRF-P1 / 'trf-p1 ')", async () => {
    const order = await confirmedOrder();
    const paid = await ordinary(order, 10000, "bank_transfer", "TRF-P1-B1");
    expect((await verify(paid["payment_id"] as string))["status"]).toBe("success");
    const before = await counts(order);
    expect(await excess(order, 10000, 0, { reference: "trf-p1-b1 " })).toEqual({
      status: "nothing_outstanding",
      outstanding_minor: 0,
      currency: "USD",
    });
    expect(await counts(order)).toEqual(before);
  });

  it("outstanding = 0 from a pending claim: refused, nothing written", async () => {
    const order = await confirmedOrder();
    expect((await record(order, 10000, "cod"))["status"]).toBe("success");
    const before = await counts(order);
    expect((await excess(order, 10500, 0))["status"]).toBe("nothing_outstanding");
    expect(await counts(order)).toEqual(before);
  });

  it("outstanding < 0 from a legacy over-claim: refused, nothing written", async () => {
    const order = await confirmedOrder();
    await legacyClaim(order, 15000);
    const before = await counts(order);
    expect(await excess(order, 10500, 0)).toMatchObject({
      status: "nothing_outstanding",
      outstanding_minor: 0,
    });
    expect(await counts(order)).toEqual(before);
  });

  it("a stale screen: outstanding went from positive to zero → nothing_outstanding, nothing written", async () => {
    const order = await confirmedOrder();
    // The screen showed 10000; another member then recorded the whole total.
    expect((await record(order, 10000, "khqr"))["status"]).toBe("success");
    const before = await counts(order);
    expect((await excess(order, 10500, 10000))["status"]).toBe("nothing_outstanding");
    expect(await counts(order)).toEqual(before);
  });
});

describe("B2 — a transfer reference recorded with excess is exclusive", () => {
  it("negative control: case and edge whitespace ('TRF-P1' / 'trf-p1 ') are one reference", async () => {
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    expect((await excess(a, 10500, 10000, { reference: "TRF-B2-1" }))["status"]).toBe("success");
    const before = await counts(b);
    expect(await excess(b, 10500, 10000, { reference: "trf-b2-1 " })).toEqual({
      status: "duplicate_transfer_reference",
    });
    expect(await counts(b)).toEqual(before);
  });

  it("internal whitespace variants (spaces, tab, line break, NBSP, zero-width) are one reference", async () => {
    const a = await confirmedOrder();
    expect((await excess(a, 10500, 10000, { reference: "TRF-B2-2" }))["status"]).toBe("success");
    for (const variant of [
      "TRF - B2 - 2",
      "T R F-B2-2",
      "TRF-\tB2-\n2",
      "TRF- B2-2",
      "TRF-​B2-2",
    ]) {
      const b = await confirmedOrder();
      expect(await excess(b, 10500, 10000, { reference: variant })).toEqual({
        status: "duplicate_transfer_reference",
      });
      expect(await ledger(b)).toMatchObject({ payments: 0, events: 0 });
    }
    // Punctuation is NOT normalized: a different identifier stays different.
    const c = await confirmedOrder();
    expect((await excess(c, 10500, 10000, { reference: "TRFB22" }))["status"]).toBe("success");
  });

  it("a reference that canonicalizes to nothing is reference_required", async () => {
    const order = await confirmedOrder();
    for (const blank of ["   ", "​", "\t\n"]) {
      expect(await excess(order, 10500, 10000, { reference: blank })).toEqual({
        status: "reference_required",
      });
    }
  });

  it("negative control: the same transfer with a new key (a lost key after reload) is refused — on another order, and on the same one", async () => {
    const a = await confirmedOrder();
    const key = crypto.randomUUID();
    expect((await excess(a, 10500, 10000, { reference: "TRF-B2-3", key }))["status"]).toBe(
      "success",
    );
    // Same key, same payload: the replay.
    expect(await excess(a, 10500, 10000, { reference: "TRF-B2-3", key })).toMatchObject({
      status: "success",
      replayed: true,
    });
    // Same key, changed payload: conflict.
    expect((await excess(a, 10600, 10000, { reference: "TRF-B2-3", key }))["status"]).toBe(
      "idempotency_conflict",
    );
    // New key, same order: nothing is outstanding any more.
    expect((await excess(a, 10500, 0, { reference: "TRF-B2-3" }))["status"]).toBe(
      "nothing_outstanding",
    );
    // New key, another order: the reference is held.
    const b = await confirmedOrder();
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-3" }))["status"]).toBe(
      "duplicate_transfer_reference",
    );
    expect(await ledger(b)).toMatchObject({ payments: 0, events: 0 });
  });

  it("held after confirmation, and after the excess was returned (refunded still happened)", async () => {
    const a = await confirmedOrder();
    const p = (await excess(a, 10500, 10000, { reference: "TRF-B2-4" }))["payment_id"] as string;
    await verify(p);
    const b = await confirmedOrder();
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-4" }))["status"]).toBe(
      "duplicate_transfer_reference",
    );
    expect((await returnExcess(p, 500))["status"]).toBe("success");
    expect((await refund(p, 10000, "Order refunded in full"))["status"]).toBe("success");
    const [row] = await sql`select status::text from payments where id = ${p}`;
    expect(row.status).toBe("refunded");
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-4" }))["status"]).toBe(
      "duplicate_transfer_reference",
    );
  });

  it("released by a reversal, and by a rejection — and only then reusable", async () => {
    const a = await confirmedOrder();
    const p = (await excess(a, 10500, 10000, { reference: "TRF-B2-5" }))["payment_id"] as string;
    const b = await confirmedOrder();
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-5" }))["status"]).toBe(
      "duplicate_transfer_reference",
    );
    expect((await reverse(p))["status"]).toBe("success");
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-5" }))["status"]).toBe("success");

    const c = await confirmedOrder();
    const q = (await excess(c, 10500, 10000, { reference: "TRF-B2-6" }))["payment_id"] as string;
    expect((await verifyAs(q, "unverified", "mismatch"))["status"]).toBe("success");
    const d = await confirmedOrder();
    expect((await excess(d, 10500, 10000, { reference: "TRF-B2-6" }))["status"]).toBe("success");
  });

  it("scoped by organization and by method", async () => {
    const a = await confirmedOrder();
    expect((await excess(a, 10500, 10000, { reference: "TRF-B2-7" }))["status"]).toBe("success");
    const other = await confirmedOrder(ORG_B);
    expect(
      (await excess(other, 10500, 10000, { reference: "trf-b2-7", org: ORG_B }))["status"],
    ).toBe("success");
    const khqr = await confirmedOrder();
    expect(
      (await excess(khqr, 10500, 10000, { reference: "trf-b2-7", method: "khqr" }))["status"],
    ).toBe("success");
  });

  it("an ordinary claim, or the reinstatement of a rejected one, cannot take a reference held with excess", async () => {
    const a = await confirmedOrder();
    // An ordinary claim recorded first, then rejected: its reference is released.
    const o = await confirmedOrder();
    const op = (await ordinary(o, 10000, "bank_transfer", "TRF-B2-8"))["payment_id"] as string;
    expect((await verifyAs(op, "unverified", "mismatch"))["status"]).toBe("success");
    expect((await excess(a, 10500, 10000, { reference: "TRF-B2-8" }))["status"]).toBe("success");
    // Taking the ordinary claim back would count the transfer twice.
    expect(await verifyAs(op, "mismatch", "unverified")).toEqual({
      status: "duplicate_transfer_reference",
    });
    // A new ordinary claim under the same canonical reference and method too.
    const n = await confirmedOrder();
    expect(await ordinary(n, 5000, "bank_transfer", " trf-b2-8")).toEqual({
      status: "duplicate_transfer_reference",
    });
    expect(await ledger(n)).toMatchObject({ payments: 0, events: 0 });
    // Ordinary references among themselves keep the 035 rule (flag, never refuse).
    const m1 = await confirmedOrder();
    const m2 = await confirmedOrder();
    expect((await ordinary(m1, 5000, "bank_transfer", "ORD-SHARED"))["status"]).toBe("success");
    expect(await ordinary(m2, 5000, "bank_transfer", "ORD-SHARED")).toMatchObject({
      status: "success",
      duplicate_suspected: true,
    });
  });

  it("negative control: the duplicate never exists, so it can never be confirmed or returned as fictional money", async () => {
    const a = await confirmedOrder();
    const p = (await excess(a, 10500, 10000, { reference: "TRF-B2-9" }))["payment_id"] as string;
    await verify(p);
    const b = await confirmedOrder();
    expect((await excess(b, 10500, 10000, { reference: "TRF-B2-9" }))["status"]).toBe(
      "duplicate_transfer_reference",
    );
    const [n] = await sql`select count(*)::int as n from payments
      where organization_id = ${ORG} and payment_reference_canonical_v1(reference) = 'trf-b2-9'`;
    expect(n.n).toBe(1);
    // Only the real excess is returnable — once.
    expect((await excessState(p))["returnable_excess_minor"]).toBe(500);
  });

  it("two concurrent recordings of one canonical reference: the second waits, then is refused", async () => {
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    const result = await pair(async (x, y, yPid) => {
      await x`begin`;
      expect((await excessOn(x, a, 10500, 10000, { reference: "TRF-RACE" }))["status"]).toBe(
        "success",
      );
      const pending = excessOn(y, b, 10500, 10000, { reference: "trf-race " });
      await waitUntilBlockedOnLock(yPid);
      await x`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "duplicate_transfer_reference" });
    expect(await ledger(b)).toMatchObject({ payments: 0, events: 0 });
  });

  it("an ordinary recording racing an excess recording of one canonical reference", async () => {
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    const result = await pair(async (x, y, yPid) => {
      await x`begin`;
      expect((await excessOn(x, a, 10500, 10000, { reference: "TRF-RACE-2" }))["status"]).toBe(
        "success",
      );
      const pending = y`select record_payment_v2(${ORG}::uuid, ${b}::uuid, ${ACTOR}::uuid,
          'bank_transfer', 5000::bigint, 'TRF-race-2', ${crypto.randomUUID()}, null) as r`.then(
        (rows) => rows[0].r as Json,
      );
      await waitUntilBlockedOnLock(yPid);
      await x`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "duplicate_transfer_reference" });
  });

  it("the partial unique index is the database's own backstop (excess vs excess)", async () => {
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    // Bypassing every function (as the owner), in a transaction rolled back
    // afterwards: the index still refuses the second holder at once.
    const seen = await sql
      .begin(async (tx) => {
        await tx`insert into payments(organization_id,order_id,method,currency,amount_minor,reference,recorded_by,excess_recorded)
          values(${ORG},${a},'bank_transfer','USD',100,'TRF-IDX',${ACTOR},true)`;
        await tx`savepoint s`;
        const err =
          await tx`insert into payments(organization_id,order_id,method,currency,amount_minor,reference,recorded_by,excess_recorded)
            values(${ORG},${b},'bank_transfer','USD',100,' trf-idx',${ACTOR},true)`.then(
            () => "ok",
            (error: { errno?: string }) => String(error.errno),
          );
        await tx`rollback to savepoint s`;
        // excess_recorded is immutable.
        const immutable =
          await tx`update payments set excess_recorded = false where reference = 'TRF-IDX'`.then(
            () => "updated",
            (error: Error) => error.message,
          );
        throw Object.assign(new Error("__rollback__"), { seen: { err, immutable } });
      })
      .catch((error: { seen?: unknown }) => error.seen);
    expect(seen).toEqual({ err: "23505", immutable: "Payment excess_recorded is immutable" });
  });
});

describe("M1 — the returnable excess is the server's figure", () => {
  it("negative control: an ordinary refund that brings net to the total leaves nothing returnable", async () => {
    const order = await confirmedOrder();
    const p = (await excess(order, 10500, 10000))["payment_id"] as string;
    expect(await excessState(p)).toMatchObject({
      status: "success",
      payment_status: "pending",
      recorded_excess_minor: 500,
      returnable_excess_minor: 0,
    });
    await verify(p);
    expect((await excessState(p))["returnable_excess_minor"]).toBe(500);
    // Loaded with 500 returnable; an ordinary refund then brings net to the total.
    expect((await refund(p, 500, "Refunded outside the excess action"))["status"]).toBe("success");
    expect(await excessState(p)).toMatchObject({
      recorded_excess_minor: 500,
      excess_returned_minor: 0,
      returnable_excess_minor: 0,
    });
    // The stale submission is still refused, and writes nothing.
    const before = await counts(order);
    expect(await returnExcess(p, 500)).toMatchObject({
      status: "exceeds_returnable_excess",
      returnable_excess_minor: 0,
    });
    expect(await counts(order)).toEqual(before);
    expect(await ledger(order)).toMatchObject({ net: TOTAL, refund: "partial" });
  });

  it("rejected and reversed payments have nothing returnable; another organization sees not_found", async () => {
    const a = await confirmedOrder();
    const p = (await excess(a, 10500, 10000))["payment_id"] as string;
    await verifyAs(p, "unverified", "mismatch");
    expect((await excessState(p))["returnable_excess_minor"]).toBe(0);
    const b = await confirmedOrder();
    const q = (await excess(b, 10500, 10000))["payment_id"] as string;
    await reverse(q);
    expect((await excessState(q))["returnable_excess_minor"]).toBe(0);
    expect(await excessState(q, ORG_B)).toEqual({ status: "not_found" });
  });
});

describe("M2 — a mistakenly rejected excess payment is recoverable", () => {
  it("negative control: ordinary reinstatement is refused; the excess-aware one restores the same payment, audited", async () => {
    const order = await confirmedOrder();
    const p = (await excess(order, 10500, 10000, { reference: "TRF-M2-1" }))[
      "payment_id"
    ] as string;
    const created = await createdMetadata(p);
    expect((await verifyAs(p, "unverified", "mismatch"))["status"]).toBe("success");
    const before = await counts(order);
    expect(await verifyAs(p, "mismatch", "unverified")).toEqual({
      status: "excess_reinstatement_required",
    });
    expect(await counts(order)).toEqual(before);

    expect((await reinstate(p, "  "))["status"]).toBe("reason_required");
    expect((await reinstate(p, "x", ORG_B))["status"]).toBe("not_found");
    expect(await reinstate(p)).toMatchObject({
      status: "success",
      reinstated: true,
      excess_minor: 500,
    });
    const after = await counts(order);
    expect(after.payments).toBe(1);
    expect(after.allAudits).toBe(before.allAudits + 1);
    const [row] =
      await sql`select status::text, verification_state::text from payments where id = ${p}`;
    expect(row).toEqual({ status: "pending", verification_state: "unverified" });
    expect(await createdMetadata(p)).toEqual(created);
    const [ev] = await sql`select event_type::text, metadata from payment_events
      where payment_id = ${p} order by created_at desc, id desc limit 1`;
    expect(ev.event_type).toBe("correction");
    expect(ev.metadata).toMatchObject({ excess_reinstated: true, recorded_excess_minor: 500 });
    const [audit] = await sql`select action from audit_logs where resource_id = ${p}
      order by created_at desc limit 1`;
    expect(audit.action).toBe("payments.reinstate_excess");
    // Retrying is not a second reinstatement.
    expect((await reinstate(p))["status"]).toBe("invalid_state");
    // And it is usable: confirmed, then its excess returned.
    await verify(p);
    expect((await returnExcess(p, 500))["status"]).toBe("success");
  });

  it("refused when other claims took the outstanding amount, or changed the excess — then recorded again (released), never twice", async () => {
    const order = await confirmedOrder();
    const p = (await excess(order, 10500, 10000, { reference: "TRF-M2-2" }))[
      "payment_id"
    ] as string;
    await verifyAs(p, "unverified", "mismatch");
    expect((await record(order, 2000, "cash"))["status"]).toBe("success");
    expect(await reinstate(p)).toMatchObject({
      status: "excess_changed",
      outstanding_minor: 8000,
      recorded_excess_minor: 500,
    });
    // The rejection released the reference: the transfer is recorded again.
    const again = await excess(order, 10500, 8000, { reference: "TRF-M2-2" });
    expect(again).toMatchObject({ status: "success", excess_minor: 2500 });
    // Now nothing is outstanding for the old row: it can never be reinstated.
    expect((await reinstate(p))["status"]).toBe("nothing_outstanding");
    const [n] = await sql`select count(*)::int as n from payments
      where order_id = ${order} and status in ('pending','paid','refunded') and excess_recorded`;
    expect(n.n).toBe(1);
  });

  it("refused when its released reference was taken by another payment meanwhile", async () => {
    const a = await confirmedOrder();
    const p = (await excess(a, 10500, 10000, { reference: "TRF-M2-3" }))["payment_id"] as string;
    await verifyAs(p, "unverified", "mismatch");
    const b = await confirmedOrder();
    expect((await excess(b, 10500, 10000, { reference: "trf-m2-3" }))["status"]).toBe("success");
    const before = await counts(a);
    expect(await reinstate(p)).toEqual({ status: "duplicate_transfer_reference" });
    expect(await counts(a)).toEqual(before);
  });

  it("only a rejected payment recorded with excess, on a confirmed order", async () => {
    const a = await confirmedOrder();
    const plain = (await record(a, 1000, "cash"))["payment_id"] as string;
    expect((await reinstate(plain))["status"]).toBe("no_recorded_excess");
    const b = await confirmedOrder();
    const p = (await excess(b, 10500, 10000))["payment_id"] as string;
    expect((await reinstate(p))["status"]).toBe("invalid_state");
    await verifyAs(p, "unverified", "mismatch");
    expect((await svc((tx) => transitionOn(tx, b, "confirmed", "cancelled")))["status"]).toBe(
      "success",
    );
    expect((await reinstate(p))["status"]).toBe("order_not_payable");
  });
});

describe("B3 — Payments 'Excess to return'", () => {
  const ORG_C = "cccccccc-0000-4000-8000-000000000001";
  const ORG_D = "dddddddd-0000-4000-8000-000000000001";

  beforeAll(async () => {
    await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
      values(${ORG_C},'C','C','excess-c',${ACTOR}),(${ORG_D},'D','D','excess-d',${ACTOR})`;
  });

  const inOrg = (org: string, run: (tx: SQL) => Promise<Json>) => svc(run);
  const xs = (org: string, order: string, amount: number, outstanding: number) =>
    inOrg(org, (tx) => excessOn(tx, order, amount, outstanding, { org }));
  const confirmIn = (org: string, payment: string) =>
    verifyAs(payment, "unverified", "bank_verified", org);
  async function refundIn(org: string, payment: string, amount: number, excessReturn: boolean) {
    const ack = (
      await sql`select id from payment_events where payment_id = ${payment} and event_type = 'refund'`
    ).map((r: { id: string }) => r.id);
    const [t] = await sql`select coalesce(sum(amount_minor),0)::int as n from payment_events
      where payment_id = ${payment} and event_type = 'refund'`;
    const fn = excessReturn ? "return_payment_excess_v1" : "refund_payment_v2";
    return svc((tx) =>
      tx
        .unsafe(
          `select ${fn}($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6,$7::bigint,$8::uuid[]) as r`,
          [org, payment, ACTOR, amount, "probe refund", crypto.randomUUID(), t.n, ack],
        )
        .then((rows: { r: Json }[]) => rows[0]!.r),
    );
  }

  it("negative control: lists every kind once, with the authoritative amount, exact count and stable pages", async () => {
    // A: confirmed, returnable 500.
    const a = await confirmedOrder(ORG_C);
    const pa = (await xs(ORG_C, a, 10500, 10000))["payment_id"] as string;
    await confirmIn(ORG_C, pa);
    // A with two partial returns: 1000 excess, 300 + 200 returned → 500.
    const a2 = await confirmedOrder(ORG_C);
    const pa2 = (await xs(ORG_C, a2, 11000, 10000))["payment_id"] as string;
    await confirmIn(ORG_C, pa2);
    expect((await refundIn(ORG_C, pa2, 300, true))["status"]).toBe("success");
    expect((await refundIn(ORG_C, pa2, 200, true))["status"]).toBe("success");
    // A with several payments on the order: 4000 ordinary + 6500 against 6000.
    const a3 = await confirmedOrder(ORG_C);
    const o3 = await inOrg(ORG_C, (tx) =>
      tx`select record_payment_v2(${ORG_C}::uuid, ${a3}::uuid, ${ACTOR}::uuid, 'cash', 4000::bigint, null, ${crypto.randomUUID()}, null) as r`.then(
        (rows) => rows[0].r as Json,
      ),
    );
    await confirmIn(ORG_C, o3["payment_id"] as string);
    const pa3 = (await xs(ORG_C, a3, 6500, 6000))["payment_id"] as string;
    await confirmIn(ORG_C, pa3);
    // C: pending, awaiting confirmation (its recorded excess).
    const c = await confirmedOrder(ORG_C);
    const pc = (await xs(ORG_C, c, 10700, 10000))["payment_id"] as string;
    // B: legacy over-claim confirmed (no recorded excess): net 15000 > 10000.
    const b = await confirmedOrder(ORG_C);
    const legacy = await sql.begin(async (tx) => {
      const [row] = await tx`select record_payment_before_order_v1(${ORG_C}::uuid, ${b}::uuid,
          ${ACTOR}::uuid, 'khqr', 15000::bigint, ${"LEGACY-" + crypto.randomUUID()}, null, null) as r`;
      await tx`select sync_order_payment_state(${ORG_C}::uuid, ${b}::uuid, ${ACTOR}::uuid, 'legacy')`;
      return (row.r as Json)["payment_id"] as string;
    });
    await confirmIn(ORG_C, legacy);
    // Not listed: fully returned; returnable 0 after an ordinary refund; rejected; reversed.
    const n1 = await confirmedOrder(ORG_C);
    const pn1 = (await xs(ORG_C, n1, 10500, 10000))["payment_id"] as string;
    await confirmIn(ORG_C, pn1);
    expect((await refundIn(ORG_C, pn1, 500, true))["status"]).toBe("success");
    const n2 = await confirmedOrder(ORG_C);
    const pn2 = (await xs(ORG_C, n2, 10500, 10000))["payment_id"] as string;
    await confirmIn(ORG_C, pn2);
    expect((await refundIn(ORG_C, pn2, 500, false))["status"]).toBe("success");
    const n3 = await confirmedOrder(ORG_C);
    const pn3 = (await xs(ORG_C, n3, 10500, 10000))["payment_id"] as string;
    await verifyAs(pn3, "unverified", "mismatch", ORG_C);
    // Another tenant's excess never appears.
    const d = await confirmedOrder(ORG_D);
    await confirmIn(ORG_D, (await xs(ORG_D, d, 10500, 10000))["payment_id"] as string);

    const all = await listExcess(ORG_C, 100, 0);
    expect(all.status).toBe("success");
    expect(all.total).toBe(5);
    expect(all.rows).toHaveLength(5);
    const byKey = Object.fromEntries(
      all.rows.map((r) => [`${r["kind"]}:${r["payment_id"] ?? r["order_id"]}`, r["excess_minor"]]),
    );
    expect(byKey).toEqual({
      [`returnable:${pa}`]: 500,
      [`returnable:${pa2}`]: 500,
      [`returnable:${pa3}`]: 500,
      [`awaiting_confirmation:${pc}`]: 700,
      [`legacy_overpaid:${b}`]: 5000,
    });
    for (const r of all.rows) expect(r["currency"]).toBe("USD");
    // Every listed amount is the payment-detail figure.
    for (const p of [pa, pa2, pa3]) {
      expect((await excessState(p, ORG_C))["returnable_excess_minor"]).toBe(500);
    }

    // Pagination: pages of 2 partition the list in the same order; the count
    // is exact on every page, also past the end.
    const pages = [];
    for (let offset = 0; offset < 6; offset += 2) pages.push(await listExcess(ORG_C, 2, offset));
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
    expect(pages.map((p) => p.rows.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((p) => p.rows)).toEqual(all.rows);
    expect(await listExcess(ORG_C, 2, 10)).toMatchObject({ total: 5, rows: [] });
    // Bounds: limit clamped to 1..100, offset to ≥ 0.
    expect((await listExcess(ORG_C, 0, -5)).rows).toHaveLength(1);

    const other = await listExcess(ORG_D, 100, 0);
    expect(other.total).toBe(1);
    expect(other.rows.map((r) => r["order_id"])).toEqual([d]);
    expect(await listExcess("eeeeeeee-0000-4000-8000-000000000001", 100, 0)).toMatchObject({
      total: 0,
      rows: [],
    });
  });

  it("timestamp ties are ordered deterministically", async () => {
    const ORG_T = "eeeeeeee-0000-4000-8000-0000000000aa";
    await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
      values(${ORG_T},'T','T','excess-t',${ACTOR})`;
    const orders = [];
    for (let i = 0; i < 4; i++) orders.push(await confirmedOrder(ORG_T));
    // One transaction: one now() → identical created_at for all four payments.
    await sql.begin(async (tx) => {
      await tx`set local role service_role`;
      for (const order of orders) {
        const r = await excessOn(tx, order, 10500, 10000, { org: ORG_T });
        expect(r["status"]).toBe("success");
      }
    });
    const [ties] =
      await sql`select count(distinct created_at)::int as n from payments where organization_id = ${ORG_T}`;
    expect(ties.n).toBe(1);
    const full = await listExcess(ORG_T, 100, 0);
    expect(full.rows.map((r) => r["order_id"])).toEqual([...orders].sort());
    const paged = [];
    for (let offset = 0; offset < 4; offset++)
      paged.push(...(await listExcess(ORG_T, 1, offset)).rows);
    expect(paged).toEqual(full.rows);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P1 — correct_payment_v2 applies the same reference ownership rule. Each
// collision case is a behavioral negative control against c3c90b0's 068.
// ═════════════════════════════════════════════════════════════════════════════

describe("P1 — a reference correction cannot bypass the ownership rule", () => {
  const correctOn = (conn: SQL, payment: string, reference: string | null, org = ORG) =>
    conn`select correct_payment_v2(${org}::uuid, ${payment}::uuid, ${ACTOR}::uuid,
        'Typo in the reference', ${reference}, null) as r`.then((rows) => rows[0].r as Json);
  const correct = (payment: string, reference: string | null, org = ORG) =>
    svc((tx) => correctOn(tx, payment, reference, org));
  async function snapshot(payment: string) {
    const [p] = await sql`select reference from payments where id = ${payment}`;
    const [e] = await sql`select count(*)::int as n from payment_events
      where payment_id = ${payment} and event_type = 'correction'`;
    const [a] = await sql`select count(*)::int as n from audit_logs
      where resource_id = ${payment} and action = 'payments.override'`;
    return { reference: p.reference as string, corrections: e.n as number, audits: a.n as number };
  }

  it("negative control: an ordinary payment cannot be corrected onto a reference held with excess", async () => {
    const a = await confirmedOrder();
    expect((await excess(a, 10500, 10000, { reference: "TRF-P1C-1" }))["status"]).toBe("success");
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-1"))["payment_id"] as string;
    const before = await snapshot(o);
    expect(await correct(o, " trf - p1c-1")).toEqual({ status: "duplicate_transfer_reference" });
    expect(await snapshot(o)).toEqual(before);
    // Another method is another scope.
    const c = await confirmedOrder();
    const k = (await ordinary(c, 5000, "khqr", "ORD-P1C-1K"))["payment_id"] as string;
    expect((await correct(k, "TRF-P1C-1"))["status"]).toBe("success");
  });

  it("negative control: an excess payment cannot be corrected onto a reference held by an ordinary payment", async () => {
    const b = await confirmedOrder();
    expect((await ordinary(b, 5000, "bank_transfer", "ORD-P1C-2"))["status"]).toBe("success");
    const a = await confirmedOrder();
    const e = (await excess(a, 10500, 10000, { reference: "TRF-P1C-2" }))["payment_id"] as string;
    const before = await snapshot(e);
    expect(await correct(e, "ord-p1c-2")).toEqual({ status: "duplicate_transfer_reference" });
    expect(await snapshot(e)).toEqual(before);
    // An excess payment's reference may not become empty in canonical form.
    expect(await correct(e, "​")).toEqual({ status: "reference_required" });
    expect(await snapshot(e)).toEqual(before);
  });

  it("a refunded holder still holds its reference", async () => {
    const a = await confirmedOrder();
    const e = (await excess(a, 10500, 10000, { reference: "TRF-P1C-3" }))["payment_id"] as string;
    await verify(e);
    expect((await returnExcess(e, 500))["status"]).toBe("success");
    expect((await refund(e, 10000, "Order refunded in full"))["status"]).toBe("success");
    const [row] = await sql`select status::text from payments where id = ${e}`;
    expect(row.status).toBe("refunded");
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-3"))["payment_id"] as string;
    expect(await correct(o, "TRF-P1C-3")).toEqual({ status: "duplicate_transfer_reference" });
  });

  it("rejected and reversed holders release it; taking the rejected one back is then refused", async () => {
    const a = await confirmedOrder();
    const e = (await excess(a, 10500, 10000, { reference: "TRF-P1C-4" }))["payment_id"] as string;
    expect((await verifyAs(e, "unverified", "mismatch"))["status"]).toBe("success");
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-4"))["payment_id"] as string;
    expect((await correct(o, "trf-p1c-4"))["status"]).toBe("success");
    expect(await reinstate(e)).toEqual({ status: "duplicate_transfer_reference" });

    const c = await confirmedOrder();
    const r = (await excess(c, 10500, 10000, { reference: "TRF-P1C-5" }))["payment_id"] as string;
    expect((await reverse(r))["status"]).toBe("success");
    const d = await confirmedOrder();
    const q = (await ordinary(d, 5000, "bank_transfer", "ORD-P1C-5"))["payment_id"] as string;
    expect((await correct(q, "TRF-P1C-5"))["status"]).toBe("success");
    // A payment that holds nothing (rejected) may itself be corrected freely.
    expect((await correct(e, "ORD-P1C-5"))["status"]).toBe("success");
  });

  it("a retry, or a correction within the same canonical reference, is never refused; ordinary vs ordinary keeps the 035 rule", async () => {
    const a = await confirmedOrder();
    const e = (await excess(a, 10500, 10000, { reference: "TRF-P1C-6" }))["payment_id"] as string;
    expect((await correct(e, "TRF - P1C - 6"))["status"]).toBe("success");
    expect((await correct(e, "TRF - P1C - 6"))["status"]).toBe("success");
    expect((await snapshot(e)).corrections).toBe(2);
    expect((await snapshot(e)).audits).toBe(2);
    const b = await confirmedOrder();
    const c = await confirmedOrder();
    expect((await ordinary(b, 5000, "bank_transfer", "ORD-P1C-6"))["status"]).toBe("success");
    const o = (await ordinary(c, 5000, "bank_transfer", "ORD-P1C-6X"))["payment_id"] as string;
    expect((await correct(o, "ord-p1c-6"))["status"]).toBe("success");
  });

  it("another organization's reference is never a collision", async () => {
    const other = await confirmedOrder(ORG_B);
    expect(
      (await excess(other, 10500, 10000, { reference: "TRF-P1C-7", org: ORG_B }))["status"],
    ).toBe("success");
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-7"))["payment_id"] as string;
    expect((await correct(o, "trf-p1c-7"))["status"]).toBe("success");
    // And another organization cannot correct this one at all.
    expect((await correct(o, "X-P1C-7", ORG_B))["status"]).toBe("not_found");
  });

  it("two concurrent corrections onto one canonical reference (excess first): the second waits, then is refused", async () => {
    const a = await confirmedOrder();
    const e = (await excess(a, 10500, 10000, { reference: "TRF-P1C-8A" }))["payment_id"] as string;
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-8B"))["payment_id"] as string;
    const before = await snapshot(o);
    const result = await pair(async (x, y, yPid) => {
      await x`begin`;
      expect((await correctOn(x, e, "TRF-P1C-8"))["status"]).toBe("success");
      const pending = correctOn(y, o, "trf-p1c-8 ");
      await waitUntilBlockedOnLock(yPid);
      await x`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "duplicate_transfer_reference" });
    expect(await snapshot(o)).toEqual(before);
  });

  it("a correction racing an excess recording of the same canonical reference", async () => {
    const b = await confirmedOrder();
    const o = (await ordinary(b, 5000, "bank_transfer", "ORD-P1C-9"))["payment_id"] as string;
    const a = await confirmedOrder();
    const result = await pair(async (x, y, yPid) => {
      await x`begin`;
      expect((await correctOn(x, o, "TRF-P1C-9"))["status"]).toBe("success");
      const pending = excessOn(y, a, 10500, 10000, { reference: "trf-p1c-9" });
      await waitUntilBlockedOnLock(yPid);
      await x`commit`;
      return pending;
    });
    expect(result).toEqual({ status: "duplicate_transfer_reference" });
    expect(await ledger(a)).toMatchObject({ payments: 0, events: 0 });
  });
});

describe("refund explanation follows the order's current accounting", () => {
  async function returnedFiveOn105() {
    const order = await confirmedOrder();
    const p = (await excess(order, 10500, 10000))["payment_id"] as string;
    await verify(p);
    expect((await returnExcess(p, 500))["status"]).toBe("success");
    expect(await excessState(p)).toMatchObject({
      excess_returned_minor: 500,
      order_net_minor: 10000,
      order_total_minor: 10000,
    });
    return { order, p };
  }

  it("105 received, 5 excess returned, then an ordinary 20 refund: the sale is no longer fully paid", async () => {
    const { order, p } = await returnedFiveOn105();
    expect((await refund(p, 2000, "One cup returned"))["status"]).toBe("success");
    expect(await excessState(p)).toMatchObject({
      excess_returned_minor: 500,
      returnable_excess_minor: 0,
      order_net_minor: 8000,
      order_total_minor: 10000,
    });
    expect(await ledger(order)).toMatchObject({ net: 8000, refund: "partial" });
  });

  it("105 received, 5 excess returned, then the rest refunded in full", async () => {
    const { order, p } = await returnedFiveOn105();
    expect((await refund(p, 10000, "Order refunded in full"))["status"]).toBe("success");
    expect(await excessState(p)).toMatchObject({
      order_net_minor: 0,
      order_total_minor: 10000,
      returnable_excess_minor: 0,
    });
    expect(await ledger(order)).toMatchObject({ net: 0, refund: "full" });
  });
});
