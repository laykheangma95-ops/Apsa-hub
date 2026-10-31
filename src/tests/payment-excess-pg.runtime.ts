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

  it("two excess recordings for the same outstanding amount: the second waits, then is stale", async () => {
    const order = await confirmedOrder();
    const result = await pair(async (a, b, bPid) => {
      await a`begin`;
      expect((await excessOn(a, order, 10500, 10000))["status"]).toBe("success");
      const pending = excessOn(b, order, 10700, 10000, { method: "khqr" });
      await waitUntilBlockedOnLock(bPid);
      await a`commit`;
      return pending;
    });
    expect(result).toMatchObject({ status: "stale", outstanding_minor: 0 });
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
  it("a reference already on another active payment is suspicious, never a refusal", async () => {
    const first = await confirmedOrder();
    const second = await confirmedOrder();
    expect((await excess(first, 10500, 10000, { reference: "TRF-SHARED" }))["status"]).toBe(
      "success",
    );
    const dup = await excess(second, 10500, 10000, { reference: "TRF-SHARED" });
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
    for (const role of ["anon", "authenticated"]) {
      expect(await sqlState(role, call)).toBe("42501");
      expect(await sqlState(role, ret)).toBe("42501");
    }
    expect(await sqlState("service_role", call)).toBe("ok");
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
