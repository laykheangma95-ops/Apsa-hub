/**
 * Financial and fulfillment mutations run only as the principal that started
 * them — through the REAL server functions and REAL SQL.
 *
 * The real `src/api/orders.ts`, `src/api/payments.ts` and `src/api/parcels.ts`
 * modules run here: their zod validators, their handlers, their services and
 * repositories, and every migration (PGlite = PostgreSQL 17). Only what sits
 * outside the server process is replaced:
 *
 *   - `createServerFn` → validator + handler, called in-process;
 *   - the session (`getSessionFn`) and the member's active organization — the
 *     principal the server derives when it HANDLES a request (`server` below);
 *   - the membership lookup behind `AuthorizationService.forRequest` — the real
 *     AuthorizationContext class over a per-member grant set;
 *   - the Supabase admin client → PGlite. Audit rows are inserted into the
 *     real `audit_logs` table, so an audit row written by a service and one
 *     written inside an RPC are the same kind of evidence.
 *
 * A member or organization switch is modelled the way the server sees it: the
 * request carries the principal it was STARTED as (`expectedPrincipal`) while
 * `server` is what the session resolves to when the request is handled — the
 * same picture whether the switch happened in this tab or another.
 *
 * Every case asserts what was persisted, not only the response: orders,
 * status history, stock movements, parcels, deliveries, payments, payment
 * events, payment evidence, audit rows and rate-limit buckets.
 *
 * Run through src/tests/financial-mutation-integrity.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Database: every migration ──────────────────────────────────────────────

const f = await financialFixture();
const db = f.db;
const ORG_A = f.org;
const ORG_B = f.orgB;
const USER_A = f.actor;
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000d7";
await db.query("insert into auth.users(id,email) values($1,'member-b@test.invalid')", [USER_B]);

async function seedProduct(org: string, name: string, price: number) {
  const product = crypto.randomUUID();
  await db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    `${name}-km`,
    name,
  ]);
  const variant = crypto.randomUUID();
  await db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
     values($1,$2,$3,$4,'',$5,'USD')`,
    [variant, org, product, `${name}-sku`, price],
  );
  return { product, variant };
}
const TEA = await seedProduct(ORG_A, "Iced tea", 5000); // $50.00 × 2 = $100.00 an order

// ── Principals and grants ────────────────────────────────────────────────────

/** What the server derives when it HANDLES a request (session + active organization). */
const server = { userId: USER_A, organizationId: ORG_A, signedIn: true };
const P_A = { userId: USER_A, organizationId: ORG_A };

const ALL_GRANTS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.cancel",
  "orders.update",
  "fulfillment.create_parcel",
  "payments.read",
  "payments.record",
  "payments.mark_cod",
  "payments.manual_confirm",
  "payments.verify",
  "payments.refund",
  "payments.reverse",
  "payments.override_status",
  "payments.view_provider_reference",
];
const grants = new Map<string, Set<string>>();
function resetGrants() {
  grants.set(USER_A, new Set(ALL_GRANTS));
  grants.set(USER_B, new Set(ALL_GRANTS));
}
resetGrants();
function setGrant(user: string, permission: string, held: boolean) {
  const set = grants.get(user)!;
  if (held) set.add(permission);
  else set.delete(permission);
}
function as(user: string, org = ORG_A) {
  server.userId = user;
  server.organizationId = org;
  server.signedIn = true;
}

// ── The server-process boundary ──────────────────────────────────────────────

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
    let skip: number | undefined;
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
        skip = from;
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
        if (skip !== undefined) sql += ` offset ${skip}`;
        try {
          const rows = JSON.parse(JSON.stringify((await db.query(sql, values)).rows));
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
          // The service's own audit insert, into the real table (and its trigger).
          insert: async (row: Json) => {
            try {
              await db.query(
                `insert into audit_logs(organization_id, actor_user_id, action, resource_type,
                   resource_id, before_json, after_json, reason, ip_address, user_agent)
                 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  row.organization_id,
                  row.actor_user_id,
                  row.action,
                  row.resource_type,
                  row.resource_id,
                  row.before_json === null ? null : JSON.stringify(row.before_json),
                  row.after_json === null ? null : JSON.stringify(row.after_json),
                  row.reason,
                  row.ip_address,
                  row.user_agent,
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
        value !== null && typeof value === "object" ? JSON.stringify(value) : value,
      );
      try {
        const result = await db.query<{ result: unknown }>(sql, params);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));

/** createServerFn(): the validator runs on what the browser sent, then the handler. */
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
  getSessionFn: async () =>
    server.signedIn
      ? { userId: server.userId, email: "member@test.invalid", emailVerified: true }
      : null,
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => server.organizationId,
}));
const realAuthorization = await import("@/server/auth/authorization");
mock.module("@/server/auth/authorization", () => ({
  ...realAuthorization,
  AuthorizationService: {
    ...realAuthorization.AuthorizationService,
    // The membership lookup: the real AuthorizationContext over THIS member's grants.
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
const parcels = (await import("@/api/parcels")) as any;

type Outcome = { ok: true; value: any } | { ok: false; code: string; status?: number };
/** Calls a real server function; a refusal becomes its public code (or the validator's). */
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
          : e.statusCode === 403
            ? "forbidden"
            : `status_${e.statusCode ?? "500"}`;
    return { ok: false, code, status: e.statusCode } as Outcome;
  }
}
const codeOf = (o: Outcome) => (o.ok ? "ok" : o.code);

beforeEach(async () => {
  await db.query("delete from rate_limit_buckets");
  resetGrants();
  as(USER_A);
});
afterAll(async () => {
  await f.close();
});

// ── Persisted state ──────────────────────────────────────────────────────────

/** Every table these mutations can write, row-for-row (any column change shows). */
async function writeSurface() {
  const rows = async (sql: string) =>
    (await db.query<{ r: string }>(sql)).rows.map((row) => row.r).join("|");
  return {
    orders: await rows("select md5(row_to_json(o)::text) as r from orders o order by id"),
    history: await rows("select id::text as r from order_status_history order by id"),
    movements: await rows("select id::text as r from inventory_movements order by id"),
    parcels: await rows("select md5(row_to_json(p)::text) as r from parcels p order by id"),
    deliveries: await rows("select md5(row_to_json(d)::text) as r from deliveries d order by id"),
    payments: await rows("select md5(row_to_json(p)::text) as r from payments p order by id"),
    paymentEvents: await rows("select id::text as r from payment_events order by id"),
    paymentEvidence: await rows("select id::text as r from payment_evidence order by id"),
    audits: await rows("select id::text as r from audit_logs order by id"),
    rateLimits: await rows(
      "select md5(row_to_json(b)::text) as r from rate_limit_buckets b order by 1",
    ),
  };
}
type Surface = Awaited<ReturnType<typeof writeSurface>>;
const wroteSince = (before: Surface, after: Surface) =>
  (Object.keys(before) as (keyof Surface)[]).filter((k) => before[k] !== after[k]);
/**
 * What an AUTHORIZED refusal wrote. A replay conflict, a stale refund or an
 * amount over the balance is decided after the permission check and the rate
 * limiter (by design: an authorized attempt is counted), so its token is
 * spent; no order, ledger, payment, evidence or audit row may move.
 */
const ledgerWritesSince = (before: Surface, after: Surface) =>
  wroteSince(before, after).filter((k) => k !== "rateLimits");

/** Audit rows written after `before` was taken, oldest first. */
async function auditsSince(before: Surface) {
  const known = new Set(before.audits.split("|"));
  const all = (
    await db.query<Json>(
      "select id::text, action, actor_user_id, organization_id, resource_id, after_json, reason, xmin::text as tx from audit_logs order by created_at, id",
    )
  ).rows;
  return all.filter((row) => !known.has(row.id));
}
const who = (id: string | null | undefined) =>
  id === USER_A ? "A" : id === USER_B ? "B" : String(id);

async function eventsOf(paymentId: string, type?: string) {
  return (
    await db.query<Json>(
      `select id::text, event_type, actor_user_id, amount_minor, idempotency_key, reason, xmin::text as tx
         from payment_events where payment_id = $1 ${type ? "and event_type = $2" : ""}
        order by created_at, id`,
      type ? [paymentId, type] : [paymentId],
    )
  ).rows;
}

async function paymentRow(paymentId: string) {
  return (
    await db.query<Json>(
      "select status, verification_state, recorded_by, reference, note from payments where id = $1",
      [paymentId],
    )
  ).rows[0]!;
}
async function orderMoney(orderId: string) {
  return (
    await db.query<Json>(
      `select o.payment_status, o.refund_status, t.received_minor::int, t.refunded_minor::int
         from orders o join order_payment_totals t on t.order_id = o.id where o.id = $1`,
      [orderId],
    )
  ).rows[0]!;
}
async function stockMovementCount() {
  return (await db.query<{ n: number }>("select count(*)::int as n from inventory_movements"))
    .rows[0]!.n;
}

// ── Seeding: everything below is created by member A in organization A ──────

const freshKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function seedDraft(): Promise<string> {
  as(USER_A);
  const detail = await orders.createOrderFn({
    data: {
      source: "MANUAL",
      items: [{ variantId: TEA.variant, quantity: 2, productId: TEA.product }],
      idempotencyKey: freshKey("order"),
      expectedPrincipal: P_A,
    },
  });
  return detail.id;
}
async function seedConfirmed(): Promise<string> {
  const orderId = await seedDraft();
  await orders.transitionOrderLifecycleFn({
    data: { orderId, to: "confirmed", expectedPrincipal: P_A },
  });
  return orderId;
}
/** Confirmed with stock taken but NO parcel — a pre-057 confirmation. */
async function seedStranded(): Promise<string> {
  const orderId = await seedDraft();
  const result = await db.query<{ r: Json }>(
    `select transition_order_before_payment_authority_v1($1::uuid, $2::uuid, 'lifecycle',
       'draft', 'confirmed', $3::uuid, null) as r`,
    [ORG_A, orderId, USER_A],
  );
  expect(result.rows[0]!.r.status).toBe("success");
  return orderId;
}
async function seedPendingPayment(): Promise<{ orderId: string; paymentId: string }> {
  const orderId = await seedConfirmed();
  const detail = await payments.recordPaymentFn({
    data: {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: freshKey("pay"),
      expectedPrincipal: P_A,
    },
  });
  return { orderId, paymentId: detail.id };
}
async function seedPaidPayment(): Promise<{ orderId: string; paymentId: string }> {
  const seeded = await seedPendingPayment();
  await payments.verifyPaymentFn({
    data: { paymentId: seeded.paymentId, to: "staff_confirmed", expectedPrincipal: P_A },
  });
  return seeded;
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 + P2 #2 — every consequential path: principal required, refuse-only
// ═══════════════════════════════════════════════════════════════════════════

interface Path {
  name: string;
  /** The permission this request needs (and only this one is toggled). */
  grant: string;
  fn: () => (args: { data: unknown }) => Promise<unknown>;
  seed: () => Promise<Json>;
  /** The request A's screen sends, minus expectedPrincipal. */
  request: (target: Json) => Json;
  /** Who the persisted effect is attributed to — [] when it was not applied. */
  effect: (target: Json) => Promise<string[]>;
}

const PATHS: Path[] = [
  {
    name: "createOrderFn (Orders/Inbox/POS create)",
    grant: "orders.create",
    fn: () => orders.createOrderFn,
    seed: async () => ({ key: freshKey("order") }),
    request: (t) => ({
      source: "MANUAL",
      items: [{ variantId: TEA.variant, quantity: 2, productId: TEA.product }],
      idempotencyKey: t.key,
    }),
    effect: async (t) =>
      (
        await db.query<Json>("select created_by from orders where idempotency_key = $1", [t.key])
      ).rows.map((r) => who(r.created_by)),
  },
  {
    name: "transitionOrderLifecycleFn (confirm)",
    grant: "orders.confirm",
    fn: () => orders.transitionOrderLifecycleFn,
    seed: async () => ({ orderId: await seedDraft() }),
    request: (t) => ({ orderId: t.orderId, to: "confirmed" }),
    effect: async (t) =>
      (
        await db.query<Json>(
          `select changed_by from order_status_history
            where order_id = $1 and axis = 'lifecycle' and to_status = 'confirmed'`,
          [t.orderId],
        )
      ).rows.map((r) => who(r.changed_by)),
  },
  {
    name: "recordPaymentFn",
    grant: "payments.record",
    fn: () => payments.recordPaymentFn,
    seed: async () => ({ orderId: await seedConfirmed(), key: freshKey("pay") }),
    request: (t) => ({
      orderId: t.orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: t.key,
    }),
    effect: async (t) =>
      (
        await db.query<Json>("select recorded_by from payments where order_id = $1", [t.orderId])
      ).rows.map((r) => who(r.recorded_by)),
  },
  {
    name: "verifyPaymentFn (staff confirm)",
    grant: "payments.manual_confirm",
    fn: () => payments.verifyPaymentFn,
    seed: seedPendingPayment,
    request: (t) => ({ paymentId: t.paymentId, to: "staff_confirmed" }),
    effect: async (t) =>
      (await eventsOf(t.paymentId, "staff_confirmed")).map((e) => who(e.actor_user_id)),
  },
  {
    name: "refundPaymentFn",
    grant: "payments.refund",
    fn: () => payments.refundPaymentFn,
    seed: async () => ({ ...(await seedPaidPayment()), key: freshKey("refund") }),
    request: (t) => ({
      paymentId: t.paymentId,
      amountMinor: 4000,
      reason: "Customer returned one cup",
      idempotencyKey: t.key,
      expectedRefundedMinor: 0,
    }),
    effect: async (t) => (await eventsOf(t.paymentId, "refund")).map((e) => who(e.actor_user_id)),
  },
  {
    name: "reversePaymentFn",
    grant: "payments.reverse",
    fn: () => payments.reversePaymentFn,
    seed: seedPaidPayment,
    request: (t) => ({ paymentId: t.paymentId, reason: "Recorded against the wrong order" }),
    effect: async (t) => (await eventsOf(t.paymentId, "reversal")).map((e) => who(e.actor_user_id)),
  },
  {
    name: "correctPaymentFn",
    grant: "payments.override_status",
    fn: () => payments.correctPaymentFn,
    seed: seedPendingPayment,
    request: (t) => ({
      paymentId: t.paymentId,
      reason: "Typo in reference",
      reference: "ABA-7781",
    }),
    effect: async (t) =>
      (await eventsOf(t.paymentId, "correction")).map((e) => who(e.actor_user_id)),
  },
  {
    name: "attachPaymentEvidenceFn",
    grant: "payments.record",
    fn: () => payments.attachPaymentEvidenceFn,
    seed: seedPendingPayment,
    request: (t) => ({
      paymentId: t.paymentId,
      evidenceType: "screenshot",
      storageRef: "evidence/khqr-receipt.png",
    }),
    effect: async (t) =>
      (
        await db.query<Json>("select uploaded_by from payment_evidence where payment_id = $1", [
          t.paymentId,
        ])
      ).rows.map((r) => who(r.uploaded_by)),
  },
  {
    name: "transitionOrderFulfillmentFn",
    grant: "orders.update",
    fn: () => orders.transitionOrderFulfillmentFn,
    seed: async () => ({ orderId: await seedConfirmed() }),
    request: (t) => ({ orderId: t.orderId, to: "processing" }),
    effect: async (t) =>
      (
        await db.query<Json>(
          `select changed_by from order_status_history
            where order_id = $1 and axis = 'fulfillment' and to_status = 'processing'`,
          [t.orderId],
        )
      ).rows.map((r) => who(r.changed_by)),
  },
  {
    name: "recoverOrderParcelFn",
    grant: "orders.confirm",
    fn: () => orders.recoverOrderParcelFn,
    seed: async () => ({ orderId: await seedStranded() }),
    request: (t) => ({ orderId: t.orderId }),
    effect: async (t) =>
      (
        await db.query<Json>("select created_by from parcels where order_id = $1", [t.orderId])
      ).rows.map((r) => who(r.created_by)),
  },
  {
    name: "updateOrderShippingFn",
    grant: "orders.update",
    fn: () => orders.updateOrderShippingFn,
    seed: async () => ({ orderId: await seedConfirmed() }),
    request: (t) => ({
      orderId: t.orderId,
      shipping: { name: "Dara", phone: "012345678", address: "St 271, Phnom Penh" },
    }),
    effect: async (t) =>
      (
        await db.query<Json>(
          `select a.actor_user_id from audit_logs a join orders o on o.id::text = a.resource_id
            where o.id = $1 and o.shipping_name = 'Dara'
              and a.after_json->>'changed' = 'shipping_snapshot'`,
          [t.orderId],
        )
      ).rows.map((r) => who(r.actor_user_id)),
  },
  {
    name: "createParcelFn",
    grant: "fulfillment.create_parcel",
    fn: () => parcels.createParcelFn,
    seed: async () => ({ orderId: await seedStranded() }),
    request: (t) => ({ orderId: t.orderId }),
    effect: async (t) =>
      (
        await db.query<Json>("select created_by from parcels where order_id = $1", [t.orderId])
      ).rows.map((r) => who(r.created_by)),
  },
];

const COMBOS = [
  { label: "A allowed / B denied", a: true, b: false },
  { label: "A denied / B allowed", a: false, b: true },
  { label: "both allowed", a: true, b: true },
  { label: "both denied", a: false, b: false },
] as const;

/** What an old bundle (or any client) might send instead of a valid principal. */
const NOT_A_PRINCIPAL: { label: string; value?: unknown }[] = [
  { label: "omitted (pre-repair browser bundle)" },
  { label: "null", value: null },
  { label: "empty object", value: {} },
  { label: "member only", value: { userId: USER_A } },
  { label: "organization only", value: { organizationId: ORG_A } },
  { label: "not a uuid", value: { userId: "member-a", organizationId: ORG_A } },
  { label: "extra field", value: { userId: USER_A, organizationId: ORG_A, role: "OWNER" } },
  { label: "a string", value: `${USER_A}:${ORG_A}` },
];

for (const path of PATHS) {
  describe(`${path.name}: runs only as the principal that started it`, () => {
    it("P2#1 a missing or malformed initiating principal is refused before anything is written", async () => {
      const target = await path.seed();
      as(USER_A);
      const results: string[] = [];
      for (const variant of NOT_A_PRINCIPAL) {
        const before = await writeSurface();
        const data =
          "value" in variant
            ? { ...path.request(target), expectedPrincipal: variant.value }
            : path.request(target);
        const outcome = await call(path.fn(), data);
        const wrote = wroteSince(before, await writeSurface());
        results.push(
          `${variant.label}=${codeOf(outcome)}${wrote.length ? `+wrote[${wrote}]` : ""}`,
        );
      }
      console.log(`[evidence] ${path.name} without a valid principal: ${results.join("; ")}`);
      for (const line of results) expect(line).not.toContain("wrote[");
      for (const line of results) expect(line).not.toMatch(/=ok$/);
      expect(await path.effect(target)).toEqual([]);
    });

    it("P2#2 member A → B: refused for every permission combination — B's authority never decides A's request", async () => {
      const target = await path.seed();
      const results: string[] = [];
      for (const combo of COMBOS) {
        resetGrants();
        setGrant(USER_A, path.grant, combo.a);
        setGrant(USER_B, path.grant, combo.b);
        as(USER_B); // the session is member B's when the request is handled
        const before = await writeSurface();
        const outcome = await call(path.fn(), { ...path.request(target), expectedPrincipal: P_A });
        const wrote = wroteSince(before, await writeSurface());
        results.push(`${combo.label}=${codeOf(outcome)}${wrote.length ? `+wrote[${wrote}]` : ""}`);
      }
      const attributed = await path.effect(target);
      console.log(
        `[evidence] ${path.name} member A→B: ${results.join("; ")} effect=[${attributed}]`,
      );
      expect(results).toEqual(COMBOS.map((c) => `${c.label}=principal_changed`));
      expect(attributed).toEqual([]);
    });

    it("P2#2 organization A → B: refused, nothing written in either organization", async () => {
      const target = await path.seed();
      as(USER_A, ORG_B); // the member's active organization moved before the request landed
      const before = await writeSurface();
      const outcome = await call(path.fn(), { ...path.request(target), expectedPrincipal: P_A });
      const wrote = wroteSince(before, await writeSurface());
      console.log(`[evidence] ${path.name} organization A→B: ${codeOf(outcome)} wrote=[${wrote}]`);
      expect(codeOf(outcome)).toBe("principal_changed");
      expect(wrote).toEqual([]);
    });

    it("A without the permission is refused as A (403) even while B holds it", async () => {
      const target = await path.seed();
      setGrant(USER_A, path.grant, false);
      setGrant(USER_B, path.grant, true);
      as(USER_A);
      const before = await writeSurface();
      const outcome = await call(path.fn(), { ...path.request(target), expectedPrincipal: P_A });
      expect(codeOf(outcome)).toBe("forbidden");
      expect(wroteSince(before, await writeSurface())).toEqual([]);
    });

    it("A's own request is applied once and attributed to A", async () => {
      const target = await path.seed();
      as(USER_A);
      const before = await writeSurface();
      const outcome = await call(path.fn(), { ...path.request(target), expectedPrincipal: P_A });
      expect(codeOf(outcome)).toBe("ok");
      expect(await path.effect(target)).toEqual(["A"]);
      for (const row of await auditsSince(before)) {
        expect([who(row.actor_user_id), row.organization_id]).toEqual(["A", ORG_A]);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #3 — a durable replay identity belongs to one actor, tenant and operation
// ═══════════════════════════════════════════════════════════════════════════

describe("P2#3 payment recording: replay is bound to the actor, the tenant and the request", () => {
  it("R1. B's payment under a key is never replayed to A as A's success; nothing is reassigned", async () => {
    const orderId = await seedConfirmed();
    const key = freshKey("pay");
    const request = { orderId, method: "cash", amountMinor: 10000, idempotencyKey: key };
    as(USER_B);
    const first = await call(payments.recordPaymentFn, {
      ...request,
      expectedPrincipal: { userId: USER_B, organizationId: ORG_A },
    });
    expect(codeOf(first)).toBe("ok");
    as(USER_A);
    const before = await writeSurface();
    const retry = await call(payments.recordPaymentFn, { ...request, expectedPrincipal: P_A });
    const wrote = ledgerWritesSince(before, await writeSurface());
    const rows = (
      await db.query<Json>("select id, recorded_by from payments where order_id = $1", [orderId])
    ).rows;
    console.log(
      `[evidence] record replay across actors: A's retry=${codeOf(retry)}` +
        (retry.ok ? ` returned recordedBy=${who(retry.value.recordedBy)}` : "") +
        ` payments=[${rows.map((r) => who(r.recorded_by))}] wrote=[${wrote}]`,
    );
    expect(codeOf(retry)).toBe("idempotency_conflict");
    expect(wrote).toEqual([]);
    expect(rows.map((r) => who(r.recorded_by))).toEqual(["B"]);
    expect((await eventsOf(rows[0]!.id)).map((e) => [e.event_type, who(e.actor_user_id)])).toEqual([
      ["created", "B"],
    ]);
  });

  it("R2. the same key with a different request is a conflict — order, amount, method, reference or note", async () => {
    const orderId = await seedConfirmed();
    const otherOrder = await seedConfirmed();
    const key = freshKey("pay");
    const original = {
      orderId,
      method: "khqr",
      amountMinor: 10000,
      reference: "KHQR-55120",
      note: "Paid at the counter",
      idempotencyKey: key,
      expectedPrincipal: P_A,
    };
    expect(codeOf(await call(payments.recordPaymentFn, original))).toBe("ok");
    const variants: [string, Json][] = [
      ["order", { orderId: otherOrder }],
      ["amount", { amountMinor: 9000 }],
      ["method", { method: "bank_transfer" }],
      ["reference", { reference: "KHQR-99999" }],
      ["note", { note: "Paid by phone" }],
    ];
    const results: string[] = [];
    for (const [label, change] of variants) {
      const before = await writeSurface();
      const outcome = await call(payments.recordPaymentFn, { ...original, ...change });
      const wrote = ledgerWritesSince(before, await writeSurface());
      results.push(`${label}=${codeOf(outcome)}${wrote.length ? `+wrote[${wrote}]` : ""}`);
    }
    console.log(`[evidence] record same key, different request: ${results.join("; ")}`);
    expect(results).toEqual(variants.map(([label]) => `${label}=idempotency_conflict`));
  });

  it("R3. A's lost-response retry replays A's own payment: one payment, one created event, one audit row", async () => {
    const orderId = await seedConfirmed();
    const request = {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: freshKey("pay"),
      expectedPrincipal: P_A,
    };
    const before = await writeSurface();
    const first = await call(payments.recordPaymentFn, request); // committed; response lost
    const retry = await call(payments.recordPaymentFn, request);
    expect([codeOf(first), codeOf(retry)]).toEqual(["ok", "ok"]);
    expect((retry as any).value.id).toBe((first as any).value.id);
    const rows = (
      await db.query<Json>("select id, recorded_by from payments where order_id = $1", [orderId])
    ).rows;
    expect(rows.map((r) => who(r.recorded_by))).toEqual(["A"]);
    expect((await eventsOf(rows[0]!.id)).map((e) => e.event_type)).toEqual(["created"]);
    expect((await auditsSince(before)).map((a) => [a.action, who(a.actor_user_id)])).toEqual([
      ["payments.record", "A"],
    ]);
  });

  it("R4. the same key in another organization never reaches the first organization's payment", async () => {
    const orderId = await seedConfirmed();
    const key = freshKey("pay");
    const inA = await call(payments.recordPaymentFn, {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: key,
      expectedPrincipal: P_A,
    });
    expect(codeOf(inA)).toBe("ok");
    as(USER_A, ORG_B);
    const before = await writeSurface();
    // Organization B cannot see organization A's order: the key alone names nothing there.
    const inB = await call(payments.recordPaymentFn, {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: key,
      expectedPrincipal: { userId: USER_A, organizationId: ORG_B },
    });
    expect(codeOf(inB)).toBe("status_404");
    expect(wroteSince(before, await writeSurface())).not.toContain("payments");
  });

  it("R8. two simultaneous requests with one key create one payment", async () => {
    const orderId = await seedConfirmed();
    const request = {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: freshKey("pay"),
      expectedPrincipal: P_A,
    };
    const [a, b] = await Promise.all([
      call(payments.recordPaymentFn, request),
      call(payments.recordPaymentFn, request),
    ]);
    expect([codeOf(a), codeOf(b)]).toEqual(["ok", "ok"]);
    expect(
      (await db.query("select id from payments where order_id = $1", [orderId])).rows,
    ).toHaveLength(1);
  });
});

/** A paid $100.00 payment and a refund request against it, as A. */
function refundRequest(paymentId: string, change: Json = {}) {
  return {
    paymentId,
    amountMinor: 4000,
    reason: "Customer returned one cup",
    idempotencyKey: freshKey("refund"),
    expectedRefundedMinor: 0,
    expectedPrincipal: P_A,
    ...change,
  };
}

describe("P2#3 refunds: replay is bound to the actor, the payment and the request", () => {
  it("R5. B's refund under a key is never replayed to A, and A gets no audit row for B's money", async () => {
    const { paymentId } = await seedPaidPayment();
    const key = freshKey("refund");
    as(USER_B);
    const first = await call(
      payments.refundPaymentFn,
      refundRequest(paymentId, {
        idempotencyKey: key,
        expectedPrincipal: { userId: USER_B, organizationId: ORG_A },
      }),
    );
    expect(codeOf(first)).toBe("ok");
    as(USER_A);
    const before = await writeSurface();
    const retry = await call(
      payments.refundPaymentFn,
      refundRequest(paymentId, { idempotencyKey: key }),
    );
    const wrote = ledgerWritesSince(before, await writeSurface());
    const audits = await auditsSince(before);
    console.log(
      `[evidence] refund replay across actors: A's retry=${codeOf(retry)} ` +
        `refunds=[${(await eventsOf(paymentId, "refund")).map((e) => who(e.actor_user_id))}] ` +
        `newAudits=[${audits.map((a) => `${a.action}:${who(a.actor_user_id)}`)}] wrote=[${wrote}]`,
    );
    expect(codeOf(retry)).toBe("idempotency_conflict");
    expect(wrote).toEqual([]);
    expect((await eventsOf(paymentId, "refund")).map((e) => who(e.actor_user_id))).toEqual(["B"]);
  });

  it("R6. the same refund key with a different amount or reason is a conflict, nothing written", async () => {
    const { paymentId } = await seedPaidPayment();
    const original = refundRequest(paymentId);
    expect(codeOf(await call(payments.refundPaymentFn, original))).toBe("ok");
    const results: string[] = [];
    for (const [label, change] of [
      ["amount", { amountMinor: 3000, expectedRefundedMinor: 4000 }],
      ["reason", { reason: "Something else", expectedRefundedMinor: 4000 }],
    ] as [string, Json][]) {
      const before = await writeSurface();
      const outcome = await call(payments.refundPaymentFn, { ...original, ...change });
      const wrote = ledgerWritesSince(before, await writeSurface());
      results.push(`${label}=${codeOf(outcome)}${wrote.length ? `+wrote[${wrote}]` : ""}`);
    }
    console.log(`[evidence] refund same key, different request: ${results.join("; ")}`);
    expect(results).toEqual(["amount=idempotency_conflict", "reason=idempotency_conflict"]);
    expect(await eventsOf(paymentId, "refund")).toHaveLength(1);
  });

  it("R7. a refund key already used on one payment cannot refund another", async () => {
    const one = await seedPaidPayment();
    const two = await seedPaidPayment();
    const key = freshKey("refund");
    expect(
      codeOf(
        await call(payments.refundPaymentFn, refundRequest(one.paymentId, { idempotencyKey: key })),
      ),
    ).toBe("ok");
    const before = await writeSurface();
    const reuse = await call(
      payments.refundPaymentFn,
      refundRequest(two.paymentId, { idempotencyKey: key }),
    );
    const wrote = ledgerWritesSince(before, await writeSurface());
    console.log(
      `[evidence] refund key reused on another payment: ${codeOf(reuse)} wrote=[${wrote}]`,
    );
    expect(codeOf(reuse)).toBe("idempotency_conflict");
    expect(wrote).toEqual([]);
  });

  it("R9. two simultaneous requests with one refund key refund once and audit once", async () => {
    const { paymentId } = await seedPaidPayment();
    const request = refundRequest(paymentId);
    const before = await writeSurface();
    const [a, b] = await Promise.all([
      call(payments.refundPaymentFn, request),
      call(payments.refundPaymentFn, request),
    ]);
    expect([codeOf(a), codeOf(b)]).toEqual(["ok", "ok"]);
    expect((await eventsOf(paymentId, "refund")).map((e) => e.amount_minor)).toEqual([4000]);
    expect((await auditsSince(before)).map((a) => a.action)).toEqual(["payments.refund"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #4 — a refund retried after a lost response refunds once
// ═══════════════════════════════════════════════════════════════════════════

describe("P2#4 refunds: exactly one refund effect per logical refund", () => {
  it("D1. committed, response lost, same-key retry: one refund, one audit row, no stock or payment side effect twice", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    const stockBefore = await stockMovementCount();
    const request = refundRequest(paymentId);
    const before = await writeSurface();
    const first = await call(payments.refundPaymentFn, request); // committed; response lost
    const retry = await call(payments.refundPaymentFn, request);
    const refunds = await eventsOf(paymentId, "refund");
    const audits = await auditsSince(before);
    console.log(
      `[evidence] refund lost response + same-key retry: [${codeOf(first)},${codeOf(retry)}] ` +
        `refunds=[${refunds.map((e) => `${e.amount_minor}:${who(e.actor_user_id)}`)}] ` +
        `audits=[${audits.map((a) => `${a.action}:${who(a.actor_user_id)}`)}]`,
    );
    expect([codeOf(first), codeOf(retry)]).toEqual(["ok", "ok"]);
    expect(refunds.map((e) => [e.amount_minor, who(e.actor_user_id)])).toEqual([[4000, "A"]]);
    expect(await orderMoney(orderId)).toEqual({
      payment_status: "paid",
      refund_status: "partial",
      received_minor: 10000,
      refunded_minor: 4000,
    });
    expect((await paymentRow(paymentId)).status).toBe("paid");
    expect(await stockMovementCount()).toBe(stockBefore);
    expect(
      audits.map((a) => [a.action, who(a.actor_user_id), a.after_json.refunded_amount_minor]),
    ).toEqual([["payments.refund", "A", 4000]]);
  });

  it("D2. the pre-repair bundle's keyless retry of a committed refund is refused — the money moves once", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    // The pre-repair Payment detail sent exactly this: no key, no refunded total, no principal.
    const legacy = { paymentId, amountMinor: 4000, reason: "Customer returned one cup" };
    const first = await call(payments.refundPaymentFn, legacy);
    const retry = await call(payments.refundPaymentFn, legacy);
    const refunds = await eventsOf(paymentId, "refund");
    console.log(
      `[evidence] keyless refund (old bundle) twice: [${codeOf(first)},${codeOf(retry)}] ` +
        `refunds=[${refunds.map((e) => e.amount_minor)}] refunded=${(await orderMoney(orderId)).refunded_minor}`,
    );
    expect(codeOf(first)).not.toBe("ok");
    expect(codeOf(retry)).not.toBe("ok");
    expect(refunds).toEqual([]);
  });

  it("D3. a retry with a fresh key but the refunded total it last saw is refused as stale", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    expect(codeOf(await call(payments.refundPaymentFn, refundRequest(paymentId)))).toBe("ok");
    // The screen remounted and lost its key, but still shows "nothing refunded".
    const before = await writeSurface();
    const stale = await call(payments.refundPaymentFn, refundRequest(paymentId));
    const wrote = ledgerWritesSince(before, await writeSurface());
    console.log(
      `[evidence] refund retried under a new key, stale total: ${codeOf(stale)} wrote=[${wrote}]`,
    );
    expect(codeOf(stale)).toBe("refund_stale");
    expect(wrote).toEqual([]);
    expect((await orderMoney(orderId)).refunded_minor).toBe(4000);
  });

  it("D4. a deliberate second refund, made after re-reading the payment, is applied and audited", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    const before = await writeSurface();
    expect(codeOf(await call(payments.refundPaymentFn, refundRequest(paymentId)))).toBe("ok");
    const second = await call(
      payments.refundPaymentFn,
      refundRequest(paymentId, { expectedRefundedMinor: 4000 }),
    );
    expect(codeOf(second)).toBe("ok");
    expect((await eventsOf(paymentId, "refund")).map((e) => e.amount_minor)).toEqual([4000, 4000]);
    expect((await orderMoney(orderId)).refunded_minor).toBe(8000);
    expect((await auditsSince(before)).map((a) => [a.action, who(a.actor_user_id)])).toEqual([
      ["payments.refund", "A"],
      ["payments.refund", "A"],
    ]);
  });

  it("D5. a full refund retried after a lost response refunds once and moves the payment once", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    const request = refundRequest(paymentId, { amountMinor: 10000 });
    expect(codeOf(await call(payments.refundPaymentFn, request))).toBe("ok");
    expect(codeOf(await call(payments.refundPaymentFn, request))).toBe("ok");
    expect((await eventsOf(paymentId, "refund")).map((e) => e.amount_minor)).toEqual([10000]);
    expect((await paymentRow(paymentId)).status).toBe("refunded");
    expect(await orderMoney(orderId)).toMatchObject({
      refund_status: "full",
      refunded_minor: 10000,
    });
  });

  it("D6. two simultaneous refunds started from the same screen state: one is applied, the other is stale", async () => {
    const { orderId, paymentId } = await seedPaidPayment();
    const [a, b] = await Promise.all([
      call(payments.refundPaymentFn, refundRequest(paymentId, { amountMinor: 6000 })),
      call(payments.refundPaymentFn, refundRequest(paymentId, { amountMinor: 6000 })),
    ]);
    expect([codeOf(a), codeOf(b)].sort()).toEqual(["ok", "refund_stale"]);
    expect((await orderMoney(orderId)).refunded_minor).toBe(6000);
  });

  it("D7. a refund over what remains is refused, nothing written but the attempt's rate-limit token", async () => {
    const { paymentId } = await seedPaidPayment();
    const before = await writeSurface();
    const over = await call(
      payments.refundPaymentFn,
      refundRequest(paymentId, { amountMinor: 10001 }),
    );
    expect(codeOf(over)).toBe("status_409");
    // An authorized attempt is counted (the limiter runs after the permission
    // check, by design); no money, ledger or audit row moves.
    expect(wroteSince(before, await writeSurface())).toEqual(["rateLimits"]);
  });
});
