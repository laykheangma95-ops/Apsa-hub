/**
 * Migration 062 re-review (PR #121): refund intent identity after a reload,
 * the original payment request's replay identity, and both deployment orders —
 * through the REAL server functions and REAL SQL, executed AS service_role.
 *
 * Like financial-mutation-integrity, the real src/api/{orders,payments,parcels}.ts
 * modules run here (validators, handlers, services, repositories). The
 * difference that matters for this file: every statement the server sends is
 * executed inside a transaction under `SET LOCAL ROLE service_role` — the role
 * the deployed server uses — so a revoked EXECUTE, a missing function or a
 * missing grant behaves exactly as it would through PostgREST.
 *
 * Two databases, both built from the real migrations:
 *   withMigration    every migration (062 included);
 *   beforeMigration  every migration up to 061 — the database a release that
 *                    ships ahead of migration 062 would meet.
 *
 * Run through src/tests/financial-rereview-062.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Databases ────────────────────────────────────────────────────────────────

const withMigration = await financialFixture();
const beforeMigration = await financialFixture(false, false, { omit: ["062_"] });
const ORG_A = withMigration.org;
const USER_A = withMigration.actor;
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000f2";

async function prepare(f: Awaited<ReturnType<typeof financialFixture>>) {
  await f.db.query("insert into auth.users(id,email) values($1,'member-b@test.invalid')", [USER_B]);
  const product = crypto.randomUUID();
  const variant = crypto.randomUUID();
  await f.db.query(
    `insert into products(id,organization_id,name_km,name_en) values($1,$2,'Tea-km','Tea')`,
    [product, f.org],
  );
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
     values($1,$2,$3,'tea-sku','',5000,'USD')`,
    [variant, f.org, product],
  );
  return { product, variant };
}
const TEA = await prepare(withMigration);
const TEA_BEFORE = await prepare(beforeMigration);

/** The database the server process is talking to right now. */
let active: PGlite = withMigration.db;
let tea = TEA;
function useDatabase(which: "with" | "before") {
  active = which === "with" ? withMigration.db : beforeMigration.db;
  tea = which === "with" ? TEA : TEA_BEFORE;
}

// ── Principals and grants ────────────────────────────────────────────────────

const server = { userId: USER_A, organizationId: ORG_A };
const P_A = { userId: USER_A, organizationId: ORG_A };
const P_B = { userId: USER_B, organizationId: ORG_A };
const ALL_GRANTS = [
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.update",
  "payments.read",
  "payments.record",
  "payments.manual_confirm",
  "payments.verify",
  "payments.refund",
  "payments.reverse",
  "payments.override_status",
  "payments.view_provider_reference",
];
const grants = new Map<string, Set<string>>([
  [USER_A, new Set(ALL_GRANTS)],
  [USER_B, new Set(ALL_GRANTS)],
]);
function as(user: string) {
  server.userId = user;
  server.organizationId = ORG_A;
}

// ── The server process, executing AS service_role ────────────────────────────

/** One statement, as the deployed server would run it: service_role, its own transaction. */
async function asServiceRole(sql: string, params: unknown[]) {
  return active.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE service_role");
    return tx.query<Json>(sql, params);
  });
}

function sqlTransport() {
  const identifier = (value: string) => {
    if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };
  function select(table: string) {
    const where: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let single = false;
    let max: number | undefined;
    const chain: any = {
      select(cols = "*") {
        columns = cols;
        return chain;
      },
      eq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} = $${values.length}`);
        return chain;
      },
      neq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} <> $${values.length}`);
        return chain;
      },
      is(key: string, value: unknown) {
        where.push(`${identifier(key)} is ${value === null ? "null" : String(value)}`);
        return chain;
      },
      in(key: string, list: unknown[]) {
        const params = list.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        where.push(list.length ? `${identifier(key)} in (${params.join(",")})` : "false");
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options?.ascending === false ? "desc" : "asc"}`);
        return chain;
      },
      limit(n: number) {
        max = n;
        return chain;
      },
      range(from: number, to: number) {
        max = to - from + 1;
        return chain;
      },
      single() {
        single = true;
        return chain;
      },
      maybeSingle() {
        single = true;
        return chain;
      },
      async execute() {
        let sql = `select ${columns} from ${table}`;
        if (where.length) sql += ` where ${where.join(" and ")}`;
        if (ordering.length) sql += ` order by ${ordering.join(",")}`;
        if (max !== undefined) sql += ` limit ${max}`;
        try {
          const rows = JSON.parse(JSON.stringify((await asServiceRole(sql, values)).rows));
          if (single) {
            return rows.length
              ? { data: rows[0], error: null }
              : { data: null, error: { code: "PGRST116" } };
          }
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
        return chain.execute().then(ok, fail);
      },
    };
    return chain;
  }
  return {
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert: async (row: Json) => {
            try {
              await asServiceRole(
                `insert into audit_logs(organization_id, actor_user_id, action, resource_type,
                   resource_id, before_json, after_json, reason)
                 values($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  row.organization_id,
                  row.actor_user_id,
                  row.action,
                  row.resource_type,
                  row.resource_id,
                  row.before_json == null ? null : JSON.stringify(row.before_json),
                  row.after_json == null ? null : JSON.stringify(row.after_json),
                  row.reason,
                ],
              );
              return { error: null };
            } catch (error) {
              return { error };
            }
          },
        };
      }
      return select(identifier(table));
    },
    async rpc(name: string, input: Record<string, unknown>) {
      const entries = Object.entries(input);
      const sql = `select ${identifier(name)}(${entries
        .map(([key], i) => `${identifier(key)} => $${i + 1}`)
        .join(",")}) as result`;
      const params = entries.map(([, value]) =>
        Array.isArray(value)
          ? value
          : value !== null && typeof value === "object"
            ? JSON.stringify(value)
            : value,
      );
      try {
        const result = await asServiceRole(sql, params);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));
mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validate: (data: unknown) => unknown) {
      return {
        handler(handle: (args: { data: unknown }) => unknown) {
          return async ({ data }: { data?: unknown } = {}) => handle({ data: validate(data) });
        },
      };
    },
    handler(handle: () => unknown) {
      return handle;
    },
  }),
}));
mock.module("@/api/auth", () => ({
  getSessionFn: async () => ({
    userId: server.userId,
    email: "member@test.invalid",
    emailVerified: true,
  }),
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => server.organizationId,
}));
const realAuthorization = await import("@/server/auth/authorization");
mock.module("@/server/auth/authorization", () => ({
  ...realAuthorization,
  AuthorizationService: {
    ...realAuthorization.AuthorizationService,
    forRequest: async (userId: string, organizationId: string) =>
      new realAuthorization.AuthorizationContext({
        membership: { user_id: userId, organization_id: organizationId, role_id: "role" },
        role: { system_role: "STAFF" },
        permissions: new Set(grants.get(userId) ?? []),
      } as any),
  },
}));

const orders = (await import("@/api/orders")) as any;
const payments = (await import("@/api/payments")) as any;

type Outcome = { ok: true; value: any } | { ok: false; code: string; status?: number };
async function call(fn: (args: { data: unknown }) => Promise<unknown>, data: unknown) {
  try {
    return { ok: true, value: await fn({ data }) } as Outcome;
  } catch (error) {
    const e = error as Json;
    const code =
      e.code && typeof e.code === "string"
        ? e.code
        : e.name === "ZodError"
          ? "invalid_request"
          : `status_${e.statusCode ?? "500"}`;
    return { ok: false, code, status: e.statusCode } as Outcome;
  }
}
const codeOf = (o: Outcome) => (o.ok ? "ok" : o.code);

beforeEach(async () => {
  for (const f of [withMigration, beforeMigration])
    await f.db.query("delete from rate_limit_buckets");
  useDatabase("with");
  as(USER_A);
});
afterAll(async () => {
  await withMigration.close();
  await beforeMigration.close();
});

// ── Persisted state ──────────────────────────────────────────────────────────

async function rows(sql: string, params: unknown[] = []) {
  return (await active.query<Json>(sql, params)).rows;
}
async function refundsOf(paymentId: string) {
  return rows(
    `select id::text, actor_user_id, amount_minor, idempotency_key from payment_events
      where payment_id = $1 and event_type = 'refund' order by created_at, id`,
    [paymentId],
  );
}
async function auditsFor(resourceId: string, action: string) {
  return rows(
    "select actor_user_id from audit_logs where resource_id = $1 and action = $2 order by created_at",
    [resourceId, action],
  );
}
async function ledgerCounts() {
  const [r] = await rows(`select
      (select count(*)::int from payments) as payments,
      (select count(*)::int from payment_events) as events,
      (select count(*)::int from audit_logs) as audits,
      (select count(*)::int from order_status_history) as history,
      (select count(*)::int from inventory_movements) as movements`);
  return r!;
}
const who = (id: string | null | undefined) =>
  id === USER_A ? "A" : id === USER_B ? "B" : String(id);

// ── Seeding (member A), through the real server functions ───────────────────

const freshKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
async function seedConfirmed(): Promise<string> {
  as(USER_A);
  const order = await orders.createOrderFn({
    data: {
      source: "MANUAL",
      items: [{ variantId: tea.variant, quantity: 2, productId: tea.product }],
      idempotencyKey: freshKey("order"),
      expectedPrincipal: P_A,
    },
  });
  await orders.transitionOrderLifecycleFn({
    data: { orderId: order.id, to: "confirmed", expectedPrincipal: P_A },
  });
  return order.id;
}
async function seedPaid(): Promise<{ orderId: string; paymentId: string }> {
  const orderId = await seedConfirmed();
  const payment = await payments.recordPaymentFn({
    data: {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: freshKey("pay"),
      expectedPrincipal: P_A,
    },
  });
  await payments.verifyPaymentFn({
    data: { paymentId: payment.id, to: "staff_confirmed", expectedPrincipal: P_A },
  });
  return { orderId, paymentId: payment.id };
}
function refund(paymentId: string, change: Json = {}) {
  return {
    paymentId,
    amountMinor: 4000,
    reason: "Customer returned one cup",
    idempotencyKey: freshKey("refund"),
    expectedRefundedMinor: 0,
    acknowledgedRefundIds: [],
    expectedPrincipal: P_A,
    ...change,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Finding 1 — a refund retried after a reload is one refund, not two
// ═══════════════════════════════════════════════════════════════════════════

describe("Finding 1: one logical refund survives a lost response and a reload", () => {
  it("F1.1 committed → response lost → reload (fresh screen, key gone) → same refund again: refused, ONE refund, ONE audit", async () => {
    const { paymentId } = await seedPaid();
    const first = await call(payments.refundPaymentFn, refund(paymentId)); // response lost
    expect(codeOf(first)).toBe("ok");
    // After the reload the screen re-reads the payment (refunded 4000) and,
    // having lost its in-memory key, sends the same refund under a new key.
    const before = await ledgerCounts();
    const retry = await call(
      payments.refundPaymentFn,
      refund(paymentId, { expectedRefundedMinor: 4000 }),
    );
    const after = await ledgerCounts();
    const refunds = await refundsOf(paymentId);
    console.log(
      `[evidence] F1.1 lost response + reload + retry: retry=${codeOf(retry)} ` +
        `refunds=[${refunds.map((r) => `${r.amount_minor}:${who(r.actor_user_id)}`)}] ` +
        `audits=${(await auditsFor(paymentId, "payments.refund")).length}`,
    );
    expect(codeOf(retry)).toBe("refund_confirmation_required");
    expect(refunds.map((r) => r.amount_minor)).toEqual([4000]);
    expect(
      (await auditsFor(paymentId, "payments.refund")).map((a) => who(a.actor_user_id)),
    ).toEqual(["A"]);
    expect(after.events).toBe(before.events);
    expect(after.audits).toBe(before.audits);
  });

  it("F1.2 the same retry carrying the recovered key is a replay: ONE refund, ONE audit, success", async () => {
    const { paymentId } = await seedPaid();
    const key = freshKey("refund");
    expect(
      codeOf(await call(payments.refundPaymentFn, refund(paymentId, { idempotencyKey: key }))),
    ).toBe("ok");
    const retry = await call(
      payments.refundPaymentFn,
      refund(paymentId, { idempotencyKey: key, expectedRefundedMinor: 4000 }),
    );
    expect(codeOf(retry)).toBe("ok");
    expect((await refundsOf(paymentId)).map((r) => r.amount_minor)).toEqual([4000]);
    expect(await auditsFor(paymentId, "payments.refund")).toHaveLength(1);
  });

  it("F1.3 an intentional second refund that acknowledges the first is applied: TWO refunds, TWO audits", async () => {
    const { paymentId } = await seedPaid();
    expect(codeOf(await call(payments.refundPaymentFn, refund(paymentId)))).toBe("ok");
    const [first] = await refundsOf(paymentId);
    const second = await call(
      payments.refundPaymentFn,
      refund(paymentId, { expectedRefundedMinor: 4000, acknowledgedRefundIds: [first!.id] }),
    );
    expect(codeOf(second)).toBe("ok");
    expect((await refundsOf(paymentId)).map((r) => r.amount_minor)).toEqual([4000, 4000]);
    expect(await auditsFor(paymentId, "payments.refund")).toHaveLength(2);
  });

  it("F1.4 acknowledging an OLDER refund while a newer one exists still needs confirmation", async () => {
    const { paymentId } = await seedPaid();
    expect(
      codeOf(await call(payments.refundPaymentFn, refund(paymentId, { amountMinor: 1000 }))),
    ).toBe("ok");
    const [r1] = await refundsOf(paymentId);
    expect(
      codeOf(
        await call(
          payments.refundPaymentFn,
          refund(paymentId, {
            amountMinor: 2000,
            expectedRefundedMinor: 1000,
            acknowledgedRefundIds: [r1!.id],
          }),
        ),
      ),
    ).toBe("ok");
    const stale = await call(
      payments.refundPaymentFn,
      refund(paymentId, {
        amountMinor: 3000,
        expectedRefundedMinor: 3000,
        acknowledgedRefundIds: [r1!.id],
      }),
    );
    expect(codeOf(stale)).toBe("refund_confirmation_required");
    expect((await refundsOf(paymentId)).map((r) => r.amount_minor)).toEqual([1000, 2000]);
  });

  it("F1.5 acknowledging a refund this payment does not have is refused", async () => {
    const one = await seedPaid();
    const two = await seedPaid();
    expect(codeOf(await call(payments.refundPaymentFn, refund(one.paymentId)))).toBe("ok");
    const [foreign] = await refundsOf(one.paymentId);
    const outcome = await call(
      payments.refundPaymentFn,
      refund(two.paymentId, { acknowledgedRefundIds: [foreign!.id] }),
    );
    expect(codeOf(outcome)).toBe("refund_stale");
    expect(await refundsOf(two.paymentId)).toEqual([]);
  });

  it("F1.6 another member's earlier refund must be acknowledged too — nobody refunds twice by accident", async () => {
    const { paymentId } = await seedPaid();
    as(USER_B);
    expect(
      codeOf(await call(payments.refundPaymentFn, refund(paymentId, { expectedPrincipal: P_B }))),
    ).toBe("ok");
    as(USER_A);
    const outcome = await call(
      payments.refundPaymentFn,
      refund(paymentId, { expectedRefundedMinor: 4000 }),
    );
    expect(codeOf(outcome)).toBe("refund_confirmation_required");
    expect((await refundsOf(paymentId)).map((r) => who(r.actor_user_id))).toEqual(["B"]);
  });

  it("F1.7 two tabs refunding at once from the same screen state: one refund", async () => {
    const { paymentId } = await seedPaid();
    const [a, b] = await Promise.all([
      call(payments.refundPaymentFn, refund(paymentId)),
      call(payments.refundPaymentFn, refund(paymentId)),
    ]);
    expect([codeOf(a), codeOf(b)].filter((c) => c === "ok")).toHaveLength(1);
    expect((await refundsOf(paymentId)).map((r) => r.amount_minor)).toEqual([4000]);
  });

  it("F1.8 a member's own refund events expose their key to that member only (recovery), never another's", async () => {
    const { paymentId } = await seedPaid();
    const key = freshKey("refund");
    expect(
      codeOf(await call(payments.refundPaymentFn, refund(paymentId, { idempotencyKey: key }))),
    ).toBe("ok");
    const own = await call(payments.getPaymentByIdFn, { paymentId });
    as(USER_B);
    const other = await call(payments.getPaymentByIdFn, { paymentId });
    const keyOf = (o: Outcome) =>
      (o as any).value.events
        .filter((e: Json) => e.eventType === "refund")
        .map((e: Json) => e.idempotencyKey);
    expect(keyOf(own)).toEqual([key]);
    expect(keyOf(other)).toEqual([null]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 2 — the original payment request keeps its replay identity
// ═══════════════════════════════════════════════════════════════════════════

/** A KHQR payment recorded by A with a reference and a note, and the exact request. */
async function seedRecorded() {
  const orderId = await seedConfirmed();
  const request = {
    orderId,
    method: "khqr",
    amountMinor: 10000,
    reference: "KHQR-ORIGINAL-1",
    note: "Paid at the counter",
    idempotencyKey: freshKey("pay"),
    expectedPrincipal: P_A,
  };
  const recorded = await call(payments.recordPaymentFn, request);
  expect(codeOf(recorded)).toBe("ok");
  return { orderId, request, paymentId: (recorded as any).value.id as string };
}
/** Two corrections committed in ONE transaction: same timestamp, so their order is only the ids'. */
async function correctTwiceInOneTransaction(paymentId: string, first: string, second: string) {
  await active.transaction(async (tx) => {
    await tx.query("select correct_payment_v2($1,$2,$3,'fix one',$4,null)", [
      ORG_A,
      paymentId,
      USER_A,
      first,
    ]);
    await tx.query("select correct_payment_v2($1,$2,$3,'fix two',$4,null)", [
      ORG_A,
      paymentId,
      USER_A,
      second,
    ]);
  });
}

describe("Finding 2: a correction never redefines the original recording request", () => {
  it("F2.1 corrections whose ids sort against their commit order: the original replays, the changed reference conflicts", async () => {
    // Find a payment whose two same-transaction corrections sort the second one
    // first by id — the ambiguous ordering the original-request lookup must not use.
    let seeded: Awaited<ReturnType<typeof seedRecorded>> | null = null;
    for (let attempt = 0; attempt < 40 && !seeded; attempt++) {
      const candidate = await seedRecorded();
      await correctTwiceInOneTransaction(candidate.paymentId, "KHQR-FIXED-2", "KHQR-FIXED-3");
      const corrections = await rows(
        `select metadata->'before'->>'reference' as before from payment_events
          where payment_id = $1 and event_type = 'correction' order by created_at, id`,
        [candidate.paymentId],
      );
      if (corrections[0]!.before === "KHQR-FIXED-2") seeded = candidate;
    }
    expect(seeded).not.toBeNull();
    const { request, paymentId } = seeded!;
    const before = await ledgerCounts();
    const original = await call(payments.recordPaymentFn, request);
    const changed = await call(payments.recordPaymentFn, { ...request, reference: "KHQR-FIXED-2" });
    const current = await call(payments.recordPaymentFn, { ...request, reference: "KHQR-FIXED-3" });
    const after = await ledgerCounts();
    console.log(
      `[evidence] F2.1 replay after ambiguous corrections: original=${codeOf(original)} ` +
        `changedReference=${codeOf(changed)} currentReference=${codeOf(current)} ` +
        `payments+${after.payments - before.payments} events+${after.events - before.events} audits+${after.audits - before.audits}`,
    );
    expect(codeOf(original)).toBe("ok");
    expect((original as any).value.id).toBe(paymentId);
    expect(codeOf(changed)).toBe("idempotency_conflict");
    expect(codeOf(current)).toBe("idempotency_conflict");
    expect([after.payments, after.events, after.audits]).toEqual([
      before.payments,
      before.events,
      before.audits,
    ]);
  });

  it("F2.2 after several sequential corrections: original replays; altered reference or note conflicts; nothing is duplicated", async () => {
    const { request, paymentId } = await seedRecorded();
    for (const [i, reference] of [
      "KHQR-SEQ-2",
      "KHQR-SEQ-3",
      "KHQR-ORIGINAL-1",
      "KHQR-SEQ-4",
    ].entries()) {
      await active.query("select correct_payment_v2($1,$2,$3,$4,$5,$6)", [
        ORG_A,
        paymentId,
        USER_A,
        `fix ${i}`,
        reference,
        i === 1 ? "Corrected note" : null,
      ]);
    }
    const before = await ledgerCounts();
    const results = {
      original: codeOf(await call(payments.recordPaymentFn, request)),
      currentReference: codeOf(
        await call(payments.recordPaymentFn, { ...request, reference: "KHQR-SEQ-4" }),
      ),
      alteredNote: codeOf(
        await call(payments.recordPaymentFn, { ...request, note: "Corrected note" }),
      ),
      alteredAmount: codeOf(
        await call(payments.recordPaymentFn, { ...request, amountMinor: 9000 }),
      ),
    };
    const after = await ledgerCounts();
    expect(results).toEqual({
      original: "ok",
      currentReference: "idempotency_conflict",
      alteredNote: "idempotency_conflict",
      alteredAmount: "idempotency_conflict",
    });
    expect([after.payments, after.events, after.audits]).toEqual([
      before.payments,
      before.events,
      before.audits,
    ]);
    expect(
      (await rows("select id from payments where order_id = $1", [request.orderId])).length,
    ).toBe(1);
    void paymentId;
  });

  it("F2.3 a replay racing a correction: the original still replays, the corrected values still conflict", async () => {
    const { request, paymentId } = await seedRecorded();
    const [replay] = await Promise.all([
      call(payments.recordPaymentFn, request),
      active.query("select correct_payment_v2($1,$2,$3,'race','KHQR-RACE',null)", [
        ORG_A,
        paymentId,
        USER_A,
      ]),
    ]);
    expect(codeOf(replay)).toBe("ok");
    expect(
      codeOf(await call(payments.recordPaymentFn, { ...request, reference: "KHQR-RACE" })),
    ).toBe("idempotency_conflict");
  });

  it("F2.4 the original request is replayed only for its original member", async () => {
    const { request } = await seedRecorded();
    as(USER_B);
    expect(
      codeOf(await call(payments.recordPaymentFn, { ...request, expectedPrincipal: P_B })),
    ).toBe("idempotency_conflict");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 4 — no deployment order silently permits unsafe financial replay
// ═══════════════════════════════════════════════════════════════════════════

describe("Finding 4: application released BEFORE migration 062", () => {
  it("F4.1 record, refund, reverse and correct are refused before any write; nothing is replayed unsafely", async () => {
    useDatabase("before");
    const orderId = await seedConfirmed();
    const before = await ledgerCounts();
    const key = freshKey("pay");
    as(USER_B);
    const recordB = await call(payments.recordPaymentFn, {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: key,
      expectedPrincipal: P_B,
    });
    as(USER_A);
    const recordA = await call(payments.recordPaymentFn, {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: key,
      expectedPrincipal: P_A,
    });
    // A payment that exists from before the release (recorded by the old code path).
    const legacy = (
      await rows(`select record_payment_v1($1,$2,$3,'cash',10000,null,$4,null) as r`, [
        ORG_A,
        orderId,
        USER_A,
        freshKey("legacy"),
      ])
    )[0]!.r.payment_id as string;
    await rows("select verify_payment_v1($1,$2,$3,'unverified','staff_confirmed',null,null)", [
      ORG_A,
      legacy,
      USER_A,
    ]);
    const mid = await ledgerCounts();
    const refundOutcome = await call(payments.refundPaymentFn, refund(legacy));
    const reverseOutcome = await call(payments.reversePaymentFn, {
      paymentId: legacy,
      reason: "Recorded twice",
      expectedPrincipal: P_A,
    });
    const correctOutcome = await call(payments.correctPaymentFn, {
      paymentId: legacy,
      reason: "Typo",
      reference: "ABA-1",
      expectedPrincipal: P_A,
    });
    const after = await ledgerCounts();
    console.log(
      `[evidence] F4.1 code before migration: recordB=${codeOf(recordB)} recordA=${codeOf(recordA)}` +
        (recordA.ok ? ` (A got recordedBy=${who((recordA as any).value.recordedBy)})` : "") +
        ` refund=${codeOf(refundOutcome)} reverse=${codeOf(reverseOutcome)} correct=${codeOf(correctOutcome)} ` +
        `payments+${mid.payments - before.payments - 1} ledgerAfterRefusals+${after.events - mid.events}`,
    );
    expect([codeOf(recordB), codeOf(recordA)]).toEqual([
      "schema_upgrade_required",
      "schema_upgrade_required",
    ]);
    expect(mid.payments - before.payments).toBe(1); // only the legacy seed
    expect([codeOf(refundOutcome), codeOf(reverseOutcome), codeOf(correctOutcome)]).toEqual([
      "schema_upgrade_required",
      "schema_upgrade_required",
      "schema_upgrade_required",
    ]);
    expect([after.payments, after.events, after.audits]).toEqual([
      mid.payments,
      mid.events,
      mid.audits,
    ]);
  });

  it("F4.2 unaffected workflows keep working: create and confirm an order, verify a payment", async () => {
    useDatabase("before");
    const orderId = await seedConfirmed();
    const legacy = (
      await rows(`select record_payment_v1($1,$2,$3,'cash',10000,null,$4,null) as r`, [
        ORG_A,
        orderId,
        USER_A,
        freshKey("legacy"),
      ])
    )[0]!.r.payment_id as string;
    const verify = await call(payments.verifyPaymentFn, {
      paymentId: legacy,
      to: "staff_confirmed",
      expectedPrincipal: P_A,
    });
    expect(codeOf(verify)).toBe("ok");
    expect(
      (await rows("select lifecycle_status from orders where id = $1", [orderId]))[0]!
        .lifecycle_status,
    ).toBe("confirmed");
  });
});

describe("Finding 4: migration 062 applied BEFORE the application (the old code's database calls, as service_role)", () => {
  /** Exactly what the pre-PR application sends, statement for statement. */
  const oldCode = {
    record: (orderId: string, actor: string, key: string, reference: string | null = null) =>
      asServiceRole("select record_payment_v1($1,$2,$3,'cash',10000,$4,$5,null) as r", [
        ORG_A,
        orderId,
        actor,
        reference,
        key,
      ]),
    refund: (paymentId: string, key: string | null) =>
      asServiceRole("select refund_payment_v1($1,$2,$3,4000,'old refund',$4) as r", [
        ORG_A,
        paymentId,
        USER_A,
        key,
      ]),
    reverse: (paymentId: string) =>
      asServiceRole("select reverse_payment_v1($1,$2,$3,'old reversal') as r", [
        ORG_A,
        paymentId,
        USER_A,
      ]),
    correct: (paymentId: string) =>
      asServiceRole("select correct_payment_v1($1,$2,$3,'old correction','ABA-9',null) as r", [
        ORG_A,
        paymentId,
        USER_A,
      ]),
  };
  const sqlState = async (run: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await run() } as const;
    } catch (error) {
      return { ok: false, code: (error as Json).code as string } as const;
    }
  };

  it("F4.3 old recording keeps the safe replay rules; old refund / reversal / correction are refused (42501), nothing written", async () => {
    const { paymentId } = await seedPaid();
    const orderId = await seedConfirmed();
    const key = freshKey("pay");
    const byB = await oldCode.record(orderId, USER_B, key);
    const byA = await oldCode.record(orderId, USER_A, key);
    const before = await ledgerCounts();
    const outcomes = {
      refund: await sqlState(() => oldCode.refund(paymentId, freshKey("refund"))),
      keylessRefund: await sqlState(() => oldCode.refund(paymentId, null)),
      reverse: await sqlState(() => oldCode.reverse(paymentId)),
      correct: await sqlState(() => oldCode.correct(paymentId)),
    };
    const after = await ledgerCounts();
    console.log(
      `[evidence] F4.3 migration before code: oldRecordB=${byB.rows[0]!.r.status} oldRecordA(same key)=${byA.rows[0]!.r.status} ` +
        `refund=${outcomes.refund.ok ? "ok" : outcomes.refund.code} keyless=${outcomes.keylessRefund.ok ? "ok" : outcomes.keylessRefund.code} ` +
        `reverse=${outcomes.reverse.ok ? "ok" : outcomes.reverse.code} correct=${outcomes.correct.ok ? "ok" : outcomes.correct.code}`,
    );
    expect(byB.rows[0]!.r.status).toBe("success");
    expect(byA.rows[0]!.r.status).toBe("idempotency_conflict");
    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toEqual({ ok: false, code: "42501" });
    }
    expect([after.payments, after.events, after.audits]).toEqual([
      before.payments,
      before.events,
      before.audits,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration 068 (provisional) — the lifecycle / outstanding-balance refusals,
// through the real server functions: the public 409 codes, and nothing written
// (no payment, event, history or audit row).
// ═══════════════════════════════════════════════════════════════════════════

describe("068 through the server functions", () => {
  async function seedDraft(): Promise<string> {
    as(USER_A);
    const order = await orders.createOrderFn({
      data: {
        source: "MANUAL",
        items: [{ variantId: tea.variant, quantity: 2, productId: tea.product }],
        idempotencyKey: freshKey("order"),
        expectedPrincipal: P_A,
      },
    });
    return order.id;
  }
  const pay = (orderId: string, amountMinor: number, change: Json = {}) => ({
    orderId,
    method: "cash",
    amountMinor,
    idempotencyKey: freshKey("pay"),
    expectedPrincipal: P_A,
    ...change,
  });

  it("draft and cancelled orders: 409 order_not_payable, nothing written", async () => {
    const draft = await seedDraft();
    const cancelled = await seedConfirmed();
    // Setup only (this harness grants no orders.cancel): the real cancellation SQL.
    const [cancel] = await rows(
      `select transition_order_status_v1($1, $2, 'lifecycle', 'confirmed', 'cancelled', $3, 'test') as r`,
      [ORG_A, cancelled, USER_A],
    );
    expect(cancel!.r.status).toBe("success");
    const before = await ledgerCounts();
    for (const orderId of [draft, cancelled]) {
      expect(await call(payments.recordPaymentFn, pay(orderId, 1000))).toEqual({
        ok: false,
        code: "order_not_payable",
        status: 409,
      });
    }
    expect(await ledgerCounts()).toEqual(before);
  });

  it("more than the outstanding balance: 409 payment_exceeds_outstanding; the fitting remainder is accepted", async () => {
    const orderId = await seedConfirmed();
    expect(codeOf(await call(payments.recordPaymentFn, pay(orderId, 6000)))).toBe("ok");
    const before = await ledgerCounts();
    expect(await call(payments.recordPaymentFn, pay(orderId, 4001))).toEqual({
      ok: false,
      code: "payment_exceeds_outstanding",
      status: 409,
    });
    expect(await ledgerCounts()).toEqual(before);
    expect(codeOf(await call(payments.recordPaymentFn, pay(orderId, 4000)))).toBe("ok");
  });

  it("the original request's retry replays once the balance is covered; nothing is written again", async () => {
    const orderId = await seedConfirmed();
    const request = pay(orderId, 10000);
    const first = await call(payments.recordPaymentFn, request);
    expect(first.ok).toBe(true);
    const before = await ledgerCounts();
    const retry = await call(payments.recordPaymentFn, request);
    expect(retry.ok && retry.value.id).toBe(first.ok && first.value.id);
    expect(await ledgerCounts()).toEqual(before);
  });

  it("confirming a claim recorded before 068 beyond the total: 409 payment_exceeds_outstanding, nothing written", async () => {
    const orderId = await seedConfirmed();
    const settled = await withMigration.recordBefore068(10000, "cash", orderId);
    const excess = await withMigration.recordBefore068(5000, "khqr", orderId);
    await withMigration.verifyBefore068(settled);
    const before = await ledgerCounts();
    expect(
      await call(payments.verifyPaymentFn, {
        paymentId: excess,
        to: "staff_confirmed",
        expectedPrincipal: P_A,
      }),
    ).toEqual({ ok: false, code: "payment_exceeds_outstanding", status: 409 });
    expect(await ledgerCounts()).toEqual(before);
    // Rejecting the excess claim lowers it and is accepted.
    expect(
      codeOf(
        await call(payments.verifyPaymentFn, {
          paymentId: excess,
          to: "mismatch",
          reason: "Not received",
          expectedPrincipal: P_A,
        }),
      ),
    ).toBe("ok");
  });
});
