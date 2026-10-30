/**
 * Orders attention views — Payment due, Needs preparation, Packed · Waiting
 * for pickup — through the REAL server functions, service, repository and SQL.
 *
 *   listOrdersPageFn / getOrderAttentionCountsFn (src/api/orders.ts, real zod
 *   validators and handlers) → resolveAuthContext → AuthorizationContext →
 *   orders service → repository → PGlite with every migration applied.
 *
 * Replaced, and only these:
 *   - createServerFn — the stand-in runs the function's own validator, then
 *     its own handler;
 *   - the session cookie and the active-organization lookup — answered from
 *     `server`, the principal the server would resolve;
 *   - verifyActiveMembership — the same membership → role → permission read as
 *     plain SQL over the same tables, so grants are real rows;
 *   - the Supabase admin client — src/tests/helpers/postgrest-pglite.ts.
 *
 * Fixtures write status columns and history rows directly (triggers suspended
 * for that statement, as the Orders pagination suite does) so every state the
 * views must classify exists exactly — including ones the application should
 * never produce, which must still be classified safely.
 *
 * Runs in its own process (order-attention-lists.test.ts): it installs module
 * mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import { postgrestOverPglite } from "./helpers/postgrest-pglite";

setDefaultTimeout(60_000);

const f = await financialFixture();
const transport = postgrestOverPglite(f.db);
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: transport }));

const OWNER_ROLE = "00000000-0000-0000-0000-000000000001";
const OWNER = "cccccccc-0000-4000-8000-0000000000a1";
/** orders.read only. */
const VIEWER = "cccccccc-0000-4000-8000-0000000000a2";
/** orders.read + delivery.read + delivery.handoff — the packing bench. */
const PACKER = "cccccccc-0000-4000-8000-0000000000a3";
/** A member with no orders.read at all. */
const OUTSIDER = "cccccccc-0000-4000-8000-0000000000a4";
for (const [id, email] of [
  [OWNER, "owner@attention.invalid"],
  [VIEWER, "viewer@attention.invalid"],
  [PACKER, "packer@attention.invalid"],
  [OUTSIDER, "outsider@attention.invalid"],
]) {
  await f.db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
}

let orgSeq = 0;
async function role(org: string, name: string, keys: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await f.db.query(`insert into roles(id,organization_id,name) values($1,$2,$3)`, [id, org, name]);
  if (keys.length) {
    await f.db.query(
      `insert into role_permissions(role_id,permission_id)
       select $1, id from permissions where key = any($2)`,
      [id, keys],
    );
  }
  return id;
}
async function newOrg(): Promise<string> {
  orgSeq += 1;
  const org = crypto.randomUUID();
  await f.db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
     values($1,$2,$2,$3,$4)`,
    [org, `Attention ${orgSeq}`, `attention-${orgSeq}`, OWNER],
  );
  const members: [string, string][] = [
    [OWNER, OWNER_ROLE],
    [VIEWER, await role(org, "Viewer", ["orders.read"])],
    [PACKER, await role(org, "Packer", ["orders.read", "delivery.read", "delivery.handoff"])],
    [OUTSIDER, await role(org, "Outsider", ["products.read"])],
  ];
  for (const [user, roleId] of members) {
    await f.db.query(
      `insert into memberships(user_id,organization_id,role_id,status) values($1,$2,$3,'active')`,
      [user, org, roleId],
    );
  }
  return org;
}

type Lifecycle = "draft" | "confirmed" | "completed" | "cancelled";
type Payment = "unpaid" | "pending" | "paid" | "failed";
type Fulfillment = "unfulfilled" | "processing" | "fulfilled" | "cancelled";

/** Run statements with triggers suspended (status columns are the Payment domain's to write). */
async function raw(sql: string, params: unknown[] = []): Promise<void> {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, params);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
}

let codeSeq = 0;
async function order(
  org: string,
  lifecycle: Lifecycle,
  payment: Payment,
  fulfillment: Fulfillment,
  opts: { createdAt?: string; customerId?: string | null; total?: number; currency?: string } = {},
): Promise<string> {
  codeSeq += 1;
  const id = crypto.randomUUID();
  const total = opts.total ?? 10000;
  await raw(
    `insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,
       created_by,created_at,lifecycle_status,payment_status,fulfillment_status,customer_id)
     values($1,$2,$3,'MANUAL',$4,$5,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      org,
      `ATT-${String(codeSeq).padStart(5, "0")}`,
      opts.currency ?? "USD",
      total,
      OWNER,
      opts.createdAt ?? new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - codeSeq * 1000).toISOString(),
      lifecycle,
      payment,
      fulfillment,
      opts.customerId ?? null,
    ],
  );
  return id;
}

async function delivery(
  org: string,
  orderId: string,
  status: string,
  opts: { cod?: number; at?: string; reason?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const at = opts.at ?? "2026-10-01T10:00:00.000000+00:00";
  await raw(
    `insert into deliveries(id,organization_id,order_id,provider_name,status,cod_amount_minor,
       cod_currency,created_by,created_at,updated_at)
     values($1,$2,$3,'Courier',$4,$5,$6,$7,$8,$8)`,
    [id, org, orderId, status, opts.cod ?? null, opts.cod ? "USD" : null, OWNER, at],
  );
  await raw(
    `insert into delivery_status_history(organization_id,delivery_id,from_status,to_status,
       changed_by,reason,created_at) values($1,$2,null,$3,$4,$5,$6)`,
    [org, id, status, OWNER, opts.reason ?? null, at],
  );
  return id;
}

async function orderHistory(
  org: string,
  orderId: string,
  from: string,
  to: string,
  at: string,
  reason: string | null,
): Promise<void> {
  await raw(
    `insert into order_status_history(organization_id,order_id,axis,from_status,to_status,
       changed_by,reason,changed_at) values($1,$2,'fulfillment',$3,$4,$5,$6,$7)`,
    [org, orderId, from, to, OWNER, reason, at],
  );
}

async function customer(org: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await f.db.query(`insert into customers(id,organization_id,display_name) values($1,$2,$3)`, [
    id,
    org,
    name,
  ]);
  return id;
}

// ── Principal the server resolves ────────────────────────────────────────────

const server = { userId: OWNER, organizationId: "" };
function signInAs(userId: string, organizationId: string) {
  Object.assign(server, { userId, organizationId });
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler(handler: (args: { data: unknown }) => unknown) {
          return async ({ data }: { data?: unknown } = {}) => handler({ data: validator(data) });
        },
      };
    },
    handler(handler: () => unknown) {
      return handler;
    },
  }),
}));
mock.module("@/api/auth", () => ({
  getSessionFn: async () => ({
    userId: server.userId,
    email: "x@attention.invalid",
    emailVerified: true,
  }),
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async (userId: string) =>
    server.userId === userId ? server.organizationId : null,
}));
const realMembership = { ...(await import("@/server/auth/membership")) };
mock.module("@/server/auth/membership", () => ({
  ...realMembership,
  verifyActiveMembership: async (userId: string, organizationId: string) => {
    const result = await f.db.query<any>(
      `select m.*, r.name as role_name, r.organization_id as role_org, r.system_role,
              coalesce(array_agg(p.key) filter (where p.key is not null), '{}') as permission_keys
         from memberships m
         join roles r on r.id = m.role_id
         left join role_permissions rp on rp.role_id = r.id
         left join permissions p on p.id = rp.permission_id
        where m.user_id = $1 and m.organization_id = $2 and m.status = 'active'
        group by m.id, r.id`,
      [userId, organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      membership: {
        id: row.id,
        user_id: row.user_id,
        organization_id: row.organization_id,
        role_id: row.role_id,
        status: row.status,
      },
      role: { id: row.role_id, organization_id: row.role_org, name: row.role_name },
      permissions: new Set<string>(row.permission_keys),
    };
  },
}));

const api = await import("@/api/orders");
const { getHomeOrderSummary } = await import("@/server/home/repository");
type Filter = "awaiting_payment" | "to_pack" | "packed_needs_delivery" | "waiting_pickup" | "all";

async function page(filter: Filter, before?: { createdAt: string; id: string }, limit?: number) {
  return api.listOrdersPageFn({
    data: {
      ...(filter === "all" ? {} : { filter }),
      ...(before ? { before } : {}),
      ...(limit ? { limit } : {}),
    },
  });
}
/** Every order id under `filter`, walked page by page. */
async function walk(filter: Filter, limit = 50): Promise<string[]> {
  const ids: string[] = [];
  let before: { createdAt: string; id: string } | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const result = await page(filter, before, limit);
    ids.push(...result.orders.map((o) => o.id));
    if (!result.nextCursor) return ids;
    before = result.nextCursor;
  }
  throw new Error("walk did not end");
}
const counts = () => api.getOrderAttentionCountsFn();

// ── Cases ────────────────────────────────────────────────────────────────────

describe("Payment due", () => {
  let org: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    org = await newOrg();
    ids.unpaidConfirmed = await order(org, "confirmed", "unpaid", "unfulfilled");
    ids.draftUnpaid = await order(org, "draft", "unpaid", "unfulfilled");
    ids.failed = await order(org, "confirmed", "failed", "unfulfilled");
    ids.paid = await order(org, "confirmed", "paid", "unfulfilled");
    ids.cancelledUnpaid = await order(org, "cancelled", "unpaid", "cancelled");
    ids.completedPaid = await order(org, "completed", "paid", "fulfilled");
    // A real partial payment, through the Payment domain: 40.00 of 100.00,
    // recorded and confirmed (an unconfirmed payment is not yet received).
    ids.partial = await f.newOrder(org, 10000);
    await f.verify(
      await f.record(4000, "cash", null, ids.partial, org),
      "staff_confirmed",
      "unverified",
      org,
    );
    // Recorded, not yet confirmed: pending, nothing received.
    ids.unconfirmed = await f.newOrder(org, 10000);
    await f.record(10000, "cash", null, ids.unconfirmed, org);
    // Paid in full, then partly refunded: still paid, nothing due.
    ids.refunded = await f.newOrder(org, 10000);
    const payment = await f.record(10000, "cash", null, ids.refunded, org);
    await f.verify(payment, "staff_confirmed", "unverified", org);
    await f.refund(payment, 3000, org);
    signInAs(OWNER, org);
  });

  it("PA. the real Payment domain classifies the fixtures as named", async () => {
    expect((await f.state(ids.partial)).payment_status).toBe("pending");
    expect((await f.state(ids.partial)).received_minor).toBe(4000);
    const refunded = await f.state(ids.refunded);
    expect([refunded.payment_status, refunded.refund_status]).toEqual(["paid", "partial"]);
    const unconfirmed = await f.state(ids.unconfirmed);
    expect([unconfirmed.payment_status, unconfirmed.received_minor]).toEqual(["pending", 0]);
  });

  it("PB. unpaid, partly paid, failed and draft orders are due; paid, refunded, cancelled and completed are not", async () => {
    const listed = new Set(await walk("awaiting_payment"));
    for (const key of ["unpaidConfirmed", "draftUnpaid", "failed", "partial", "unconfirmed"]) {
      expect({ key, listed: listed.has(ids[key]!) }).toEqual({ key, listed: true });
    }
    for (const key of ["paid", "cancelledUnpaid", "completedPaid", "refunded"]) {
      expect({ key, listed: listed.has(ids[key]!) }).toEqual({ key, listed: false });
    }
    expect((await counts()).paymentDue).toBe(listed.size);
  });

  it("PC. a partial payment shows what was received, from the ledger — never a guess", async () => {
    const result = await page("awaiting_payment");
    expect(result.attention[ids.partial!]!.received).toEqual({ amount: 4000, currency: "USD" });
    expect(result.attention[ids.unpaidConfirmed!]!.received).toEqual({
      amount: 0,
      currency: "USD",
    });
    // No staff assignment exists in the data model: always null, never invented.
    expect(Object.values(result.attention).every((a) => a.assignedStaff === null)).toBe(true);
  });

  it("PD. Home's 'awaiting payment' count is the same predicate as the list", async () => {
    const home = await getHomeOrderSummary(org, {
      from: "2000-01-01T00:00:00Z",
      until: "2100-01-01T00:00:00Z",
    });
    expect(home.awaitingPaymentCount).toBe((await counts()).paymentDue);
  });
});

describe("Packed · Waiting for pickup, and COD overlap", () => {
  let org: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    org = await newOrg();
    // Packed COD order, delivery ready for the courier, nothing collected yet.
    ids.codReady = await order(org, "confirmed", "unpaid", "processing");
    await delivery(org, ids.codReady, "ready", {
      cod: 10000,
      at: "2026-10-01T08:00:00.000000+00:00",
    });
    ids.paidReady = await order(org, "confirmed", "paid", "processing");
    await delivery(org, ids.paidReady, "ready");
    ids.inTransit = await order(org, "confirmed", "unpaid", "processing");
    await delivery(org, ids.inTransit, "in_transit", { cod: 10000 });
    ids.delivered = await order(org, "confirmed", "unpaid", "fulfilled");
    await delivery(org, ids.delivered, "delivered");
    ids.arranged = await order(org, "confirmed", "paid", "processing");
    await delivery(org, ids.arranged, "preparing");
    // Packed, no delivery arranged: NOT waiting for a courier (next: Arrange delivery).
    ids.packedNoDelivery = await order(org, "confirmed", "paid", "processing");
    await orderHistory(
      org,
      ids.packedNoDelivery,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00+00",
      "pack_order_packed",
    );
    // Cancelled with a ready delivery — the custody guard forbids this; if it
    // ever exists it must not read as actionable waiting work.
    ids.cancelledReady = await order(org, "cancelled", "unpaid", "cancelled");
    await delivery(org, ids.cancelledReady, "ready");
    // Two deliveries: the first failed, the second is ready. Listed once.
    ids.twoDeliveries = await order(org, "confirmed", "paid", "processing");
    await delivery(org, ids.twoDeliveries, "failed", { at: "2026-10-01T07:00:00+00" });
    await delivery(org, ids.twoDeliveries, "ready", { at: "2026-10-01T09:30:00+00" });
    signInAs(OWNER, org);
  });

  it("WA. only a confirmed order with a ready delivery is waiting; custody, cancellation and unarranged are not", async () => {
    const listed = await walk("waiting_pickup");
    expect(new Set(listed)).toEqual(new Set([ids.codReady, ids.paidReady, ids.twoDeliveries]));
    expect(listed.length).toBe(new Set(listed).size);
    expect((await counts()).waitingPickup).toBe(3);
  });

  it("WB. a packed COD order is Payment due AND Waiting for pickup — packing is not payment", async () => {
    expect(await walk("awaiting_payment")).toContain(ids.codReady!);
    expect(await walk("waiting_pickup")).toContain(ids.codReady!);
    // ...and not Needs preparation: it is packed.
    expect(await walk("to_pack")).not.toContain(ids.codReady!);
    // In courier custody it is still due, but no longer waiting in the shop.
    expect(await walk("awaiting_payment")).toContain(ids.inTransit!);
  });

  it("WC. rows carry the ready time from delivery history and the COD flag", async () => {
    const result = await page("waiting_pickup");
    const cod = result.attention[ids.codReady!]!;
    expect(cod.delivery).toEqual({
      status: "ready",
      readySince: expect.stringMatching(/^2026-10-01T08:00:00/),
      cod: true,
    });
    // Two deliveries: the ACTIVE one is described, not the failed attempt.
    const two = result.attention[ids.twoDeliveries!]!;
    expect(two.delivery?.status).toBe("ready");
    expect(two.delivery?.readySince).toMatch(/^2026-10-01T09:30:00/);
  });

  it("WD. Payment due rows show COD from the delivery a member may read", async () => {
    const result = await walk("awaiting_payment");
    expect(result).toContain(ids.inTransit!);
    const first = await page("awaiting_payment");
    expect(first.attention[ids.inTransit!]!.delivery).toMatchObject({
      status: "in_transit",
      cod: true,
    });
  });
});

/** A parcel row (identity only — migration 050); packing never reads it. */
async function parcel(org: string, orderId: string, status: "created" | "void"): Promise<void> {
  await raw(
    `insert into parcels(organization_id,order_id,parcel_code,status,created_by)
     values($1,$2,$3,$4,$5)`,
    [org, orderId, `APSA-PARCEL-${crypto.randomUUID()}`, status, OWNER],
  );
}

/** Pack Order's marker on the order's own history (record_order_packed_v1's shape). */
async function packedOnOrder(org: string, orderId: string, at: string): Promise<void> {
  await orderHistory(org, orderId, "unfulfilled", "processing", at, "pack_order_packed");
}

/** Pack Order's marker on a delivery's history (transition_delivery_status_v1 → ready). */
async function packedOnDelivery(org: string, deliveryId: string, at: string): Promise<void> {
  await raw(
    `insert into delivery_status_history(organization_id,delivery_id,from_status,to_status,
       changed_by,reason,created_at) values($1,$2,'preparing','ready',$3,'pack_order_packed',$4)`,
    [org, deliveryId, OWNER, at],
  );
}

/** A retired delivery attempt drives the order back to unfulfilled at the SAME instant (054). */
async function retired(
  org: string,
  orderId: string,
  status: "failed" | "cancelled",
  at: string,
  reason: string | null = null,
): Promise<string> {
  const id = await delivery(org, orderId, status, { at, reason });
  await orderHistory(org, orderId, "processing", "unfulfilled", at, reason ?? "delivery retired");
  return id;
}

describe("Needs preparation vs Packed · Needs delivery — the database's packed rule", () => {
  let org: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    org = await newOrg();
    // 1. Confirmed, unpacked, no delivery.
    ids.unpackedNoDelivery = await order(org, "confirmed", "unpaid", "unfulfilled");
    await parcel(org, ids.unpackedNoDelivery, "created");

    // 2. Confirmed, unpacked, delivery arranged FIRST (pending → order processing).
    ids.unpackedArranged = await order(org, "confirmed", "paid", "processing");
    await delivery(org, ids.unpackedArranged, "pending", { at: "2026-10-01T08:00:00+00" });
    ids.unpackedPreparing = await order(org, "confirmed", "paid", "processing");
    await delivery(org, ids.unpackedPreparing, "preparing", { at: "2026-10-01T08:00:00+00" });

    // 3. Packed with its delivery ready: Waiting for pickup only.
    ids.packedReady = await order(org, "confirmed", "unpaid", "processing");
    const ready = await delivery(org, ids.packedReady, "ready", { at: "2026-10-01T09:00:00+00" });
    await packedOnDelivery(org, ready, "2026-10-01T09:00:00+00");

    // 4a. Packed (no delivery), then a delivery failed → unfulfilled, still packed.
    ids.packedThenFailed = await order(org, "confirmed", "paid", "unfulfilled");
    await packedOnOrder(org, ids.packedThenFailed, "2026-10-01T09:00:00+00");
    await retired(org, ids.packedThenFailed, "failed", "2026-10-01T11:00:00+00");
    // 4b. Packed, then the delivery was cancelled (not by a reopen) → still packed.
    ids.packedThenCancelled = await order(org, "confirmed", "paid", "unfulfilled");
    await packedOnOrder(org, ids.packedThenCancelled, "2026-10-01T09:00:00+00");
    await retired(org, ids.packedThenCancelled, "cancelled", "2026-10-01T11:30:00+00");
    // 4c. Packed, no delivery ever arranged (processing).
    ids.packedNoDelivery = await order(org, "confirmed", "paid", "processing");
    await packedOnOrder(org, ids.packedNoDelivery, "2026-10-01T09:00:00+00");
    // 4d. Packed, but its delivery is pending and was never readied.
    ids.packedPending = await order(org, "confirmed", "paid", "processing");
    await packedOnOrder(org, ids.packedPending, "2026-10-01T09:00:00+00");
    await delivery(org, ids.packedPending, "pending", { at: "2026-10-01T10:00:00+00" });

    // Packed, then REOPENED (its ready delivery cancelled BY the reopen): packing again.
    ids.reopened = await order(org, "confirmed", "paid", "unfulfilled");
    await packedOnOrder(org, ids.reopened, "2026-10-01T09:00:00+00");
    await retired(
      org,
      ids.reopened,
      "cancelled",
      "2026-10-01T12:00:00+00",
      "system:order_fulfillment_reopened",
    );

    // 5. Multiple parcels and deliveries: a voided parcel and its replacement,
    //    a failed then a cancelled attempt, then a new pending one — packed
    //    once, before all of them: packed, nothing ready or out.
    ids.manyAttempts = await order(org, "confirmed", "paid", "processing");
    await parcel(org, ids.manyAttempts, "void");
    await parcel(org, ids.manyAttempts, "created");
    await packedOnOrder(org, ids.manyAttempts, "2026-10-01T07:00:00+00");
    await retired(org, ids.manyAttempts, "failed", "2026-10-01T08:00:00+00");
    await retired(org, ids.manyAttempts, "cancelled", "2026-10-01T09:00:00+00");
    await delivery(org, ids.manyAttempts, "pending", { at: "2026-10-01T10:00:00+00" });
    // ...and the same history, never packed: still packing work.
    ids.manyAttemptsUnpacked = await order(org, "confirmed", "paid", "processing");
    await parcel(org, ids.manyAttemptsUnpacked, "void");
    await parcel(org, ids.manyAttemptsUnpacked, "created");
    await delivery(org, ids.manyAttemptsUnpacked, "failed", { at: "2026-10-01T08:00:00+00" });
    await delivery(org, ids.manyAttemptsUnpacked, "pending", { at: "2026-10-01T10:00:00+00" });

    // Out of the shop or out of the sale: in neither packing view.
    ids.inTransit = await order(org, "confirmed", "unpaid", "processing");
    await delivery(org, ids.inTransit, "in_transit");
    ids.delivered = await order(org, "confirmed", "unpaid", "fulfilled");
    await delivery(org, ids.delivered, "delivered");
    ids.cancelled = await order(org, "cancelled", "unpaid", "cancelled");
    ids.cancelledPacked = await order(org, "cancelled", "paid", "cancelled");
    await packedOnOrder(org, ids.cancelledPacked, "2026-10-01T09:00:00+00");
    ids.draft = await order(org, "draft", "unpaid", "unfulfilled");
    ids.completed = await order(org, "completed", "paid", "fulfilled");
    signInAs(OWNER, org);
  });

  it("NA. Needs preparation is exactly the orders not packed — with or without a delivery arranged first", async () => {
    const listed = new Set(await walk("to_pack"));
    expect(listed).toEqual(
      new Set([
        ids.unpackedNoDelivery,
        ids.unpackedArranged,
        ids.unpackedPreparing,
        ids.reopened,
        ids.manyAttemptsUnpacked,
      ]),
    );
    expect((await counts()).needsPreparation).toBe(listed.size);
  });

  it("NB. a packed order whose delivery failed, was cancelled, was never arranged or never readied is delivery recovery, not packing work", async () => {
    const recovery = new Set(await walk("packed_needs_delivery"));
    expect(recovery).toEqual(
      new Set([
        ids.packedThenFailed,
        ids.packedThenCancelled,
        ids.packedNoDelivery,
        ids.packedPending,
        ids.manyAttempts,
      ]),
    );
    expect((await counts()).packedNeedsDelivery).toBe(recovery.size);
  });

  it("NC. packed with a ready delivery is Waiting for pickup only; custody, cancellation and closed sales are in no packing view", async () => {
    const toPack = await walk("to_pack");
    const recovery = await walk("packed_needs_delivery");
    expect(await walk("waiting_pickup")).toEqual([ids.packedReady!]);
    for (const key of [
      "packedReady",
      "inTransit",
      "delivered",
      "cancelled",
      "cancelledPacked",
      "draft",
      "completed",
    ]) {
      expect({ key, toPack: toPack.includes(ids[key]!) }).toEqual({ key, toPack: false });
      expect({ key, recovery: recovery.includes(ids[key]!) }).toEqual({ key, recovery: false });
    }
  });

  it("ND. the views agree with the packed rule itself, order by order", async () => {
    const toPack = new Set(await walk("to_pack"));
    const recovery = new Set(await walk("packed_needs_delivery"));
    for (const id of [...toPack, ...recovery]) {
      const packed = (
        await f.db.query<{ p: boolean }>("select public.order_currently_packed_v1($1,$2) as p", [
          org,
          id,
        ])
      ).rows[0]!.p;
      expect({ id, packed }).toEqual({ id, packed: recovery.has(id) });
      expect(toPack.has(id) && recovery.has(id)).toBe(false);
    }
  });

  it("NE. rows explain the recovery from the delivery the member may read; no per-row packed calls", async () => {
    const before = transport.reads.filter((r) => r.startsWith("rpc:")).length;
    const result = await page("packed_needs_delivery");
    expect(transport.reads.filter((r) => r.startsWith("rpc:")).length).toBe(before);
    expect(result.attention[ids.packedThenFailed!]!.delivery?.status).toBe("failed");
    expect(result.attention[ids.packedThenCancelled!]!.delivery?.status).toBe("cancelled");
    expect(result.attention[ids.packedNoDelivery!]!.delivery?.status).toBeNull();
    expect(result.attention[ids.packedPending!]!.delivery?.status).toBe("pending");
    // The active attempt is described, not the older retired ones.
    expect(result.attention[ids.manyAttempts!]!.delivery?.status).toBe("pending");
  });

  it("NF. orders.read alone sees both packing views and counts, without delivery facts", async () => {
    signInAs(VIEWER, org);
    try {
      const c = await counts();
      expect([c.needsPreparation, c.packedNeedsDelivery]).toEqual([5, 5]);
      const recovery = await page("packed_needs_delivery");
      expect(recovery.orders).toHaveLength(5);
      expect(Object.values(recovery.attention).every((a) => a.delivery === null)).toBe(true);
      signInAs(OUTSIDER, org);
      for (const filter of ["to_pack", "packed_needs_delivery"] as const) {
        await expect(page(filter)).rejects.toThrow(/orders\.read/);
      }
    } finally {
      signInAs(OWNER, org);
    }
  });

  it("NG. another tenant's history can neither pack nor unpack an order, and its queue is its own", async () => {
    const other = await newOrg();
    const theirs = await order(other, "confirmed", "paid", "unfulfilled");
    // A Pack Order marker written under THIS organization's id against the other
    // tenant's order (corrupt data) must not count for either tenant.
    await packedOnOrder(org, theirs, "2026-10-01T09:00:00+00");
    signInAs(OWNER, other);
    try {
      expect(await walk("to_pack")).toEqual([theirs]);
      expect(await walk("packed_needs_delivery")).toEqual([]);
      expect(await counts()).toMatchObject({ needsPreparation: 1, packedNeedsDelivery: 0 });
    } finally {
      signInAs(OWNER, org);
    }
    expect(await walk("to_pack")).not.toContain(theirs);
    expect((await counts()).needsPreparation).toBe(5);
  });
});

describe("Permissions", () => {
  let org: string;
  let named: string;
  beforeAll(async () => {
    org = await newOrg();
    const buyer = await customer(org, "Sokha Chan");
    named = await order(org, "confirmed", "unpaid", "processing", { customerId: buyer });
    await delivery(org, named, "ready", { cod: 10000 });
  });

  it("RA. orders.read alone: Payment due and Needs preparation, no Waiting for pickup list or count", async () => {
    signInAs(VIEWER, org);
    const c = await counts();
    expect(c.waitingPickup).toBeNull();
    expect(c.paymentDue).toBe(1);
    await expect(page("waiting_pickup")).rejects.toThrow(/delivery\.read/);
    const due = await page("awaiting_payment");
    const facts = due.attention[named]!;
    // The customer is linked, but the name is customers.read's to show.
    expect(facts.customer).toEqual({ kind: "hidden" });
    expect(facts.received).toBeNull();
    expect(facts.delivery).toBeNull();
  });

  it("RB. the packing bench sees Waiting for pickup and its delivery facts", async () => {
    signInAs(PACKER, org);
    expect((await counts()).waitingPickup).toBe(1);
    const waiting = await page("waiting_pickup");
    expect(waiting.orders.map((o) => o.id)).toEqual([named]);
    expect(waiting.attention[named]!.delivery?.cod).toBe(true);
    expect(waiting.attention[named]!.customer).toEqual({ kind: "hidden" });
  });

  it("RC. an owner sees the customer's name and the ledger", async () => {
    signInAs(OWNER, org);
    const due = await page("awaiting_payment");
    expect(due.attention[named]!.customer).toEqual({ kind: "named", name: "Sokha Chan" });
    expect(due.attention[named]!.received).toEqual({ amount: 0, currency: "USD" });
  });

  it("RD. without orders.read every view and every count is refused", async () => {
    signInAs(OUTSIDER, org);
    await expect(counts()).rejects.toThrow(/orders\.read/);
    for (const filter of [
      "awaiting_payment",
      "to_pack",
      "packed_needs_delivery",
      "waiting_pickup",
    ] as const) {
      await expect(page(filter)).rejects.toThrow(/orders\.read/);
    }
  });
});

describe("Organization isolation", () => {
  let orgA: string;
  let orgB: string;
  const a: string[] = [];
  const b: string[] = [];
  beforeAll(async () => {
    orgA = await newOrg();
    orgB = await newOrg();
    for (const [org, into, n] of [
      [orgA, a, 3],
      [orgB, b, 5],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const id = await order(org, "confirmed", "unpaid", "processing");
        await delivery(org, id, "ready");
        into.push(id);
      }
    }
    // A delivery row in B that (wrongly) points at an order of A must not make
    // A's order "waiting" — the embed holds the delivery to the order's tenant.
    const aOnly = await order(orgA, "confirmed", "paid", "processing");
    await delivery(orgB, aOnly, "ready");
    a.push(aOnly);
  });

  it("IA. each organization's lists and counts hold only its own orders", async () => {
    signInAs(OWNER, orgA);
    const waitingA = await walk("waiting_pickup");
    expect(waitingA.every((id) => a.includes(id))).toBe(true);
    expect(waitingA).not.toContain(a[3]!); // the cross-tenant delivery did not count
    expect((await counts()).waitingPickup).toBe(3);
    signInAs(OWNER, orgB);
    const waitingB = await walk("waiting_pickup");
    expect(new Set(waitingB)).toEqual(new Set(b));
    expect((await counts()).waitingPickup).toBe(5);
  });

  it("IB. a request cannot name an organization — the validator refuses the field", async () => {
    signInAs(OWNER, orgA);
    await expect(
      api.listOrdersPageFn({ data: { filter: "waiting_pickup", organizationId: orgB } as any }),
    ).rejects.toThrow();
  });

  it("IC. a cursor taken from another organization's list still reads only the caller's orders", async () => {
    signInAs(OWNER, orgB);
    const bPage = await page("waiting_pickup", undefined, 1);
    signInAs(OWNER, orgA);
    const result = await page("waiting_pickup", bPage.nextCursor ?? undefined, 50);
    expect(result.orders.every((o) => a.includes(o.id))).toBe(true);
    expect(Object.keys(result.attention).every((id) => a.includes(id))).toBe(true);
    expect(result.servedAs.organizationId).toBe(orgA);
  });
});

describe("Pagination and count consistency over large lists", () => {
  let org: string;
  beforeAll(async () => {
    org = await newOrg();
    for (let i = 0; i < 130; i++) await order(org, "confirmed", "unpaid", "unfulfilled");
    for (let i = 0; i < 61; i++) {
      const id = await order(org, "confirmed", i % 2 ? "paid" : "unpaid", "processing");
      await delivery(org, id, "ready");
    }
    for (let i = 0; i < 40; i++) await order(org, "completed", "paid", "fulfilled");
    // 73 packed orders whose delivery failed (paid): unfulfilled, but delivery
    // recovery — a fulfillment_status predicate would have called them packing work.
    for (let i = 0; i < 73; i++) {
      const id = await order(org, "confirmed", "paid", "unfulfilled");
      await packedOnOrder(org, id, "2026-10-01T09:00:00+00");
      await retired(org, id, "failed", "2026-10-01T11:00:00+00");
    }
    // 27 unpacked orders with a delivery arranged first (paid, processing).
    for (let i = 0; i < 27; i++) {
      const id = await order(org, "confirmed", "paid", "processing");
      await delivery(org, id, "pending");
    }
    signInAs(OWNER, org);
  });

  it("CA. every view, walked page by page, holds exactly its count — no row twice, none missing", async () => {
    const c = await counts();
    expect(c).toMatchObject({
      paymentDue: 130 + 31,
      needsPreparation: 130 + 27,
      packedNeedsDelivery: 73,
      waitingPickup: 61,
    });
    for (const [filter, expected, limit] of [
      ["awaiting_payment", c.paymentDue, 50],
      ["to_pack", c.needsPreparation, 50],
      ["packed_needs_delivery", c.packedNeedsDelivery, 20],
      ["waiting_pickup", c.waitingPickup, 25],
    ] as const) {
      const ids = await walk(filter, limit);
      expect({ filter, rows: ids.length, unique: new Set(ids).size }).toEqual({
        filter,
        rows: expected,
        unique: expected,
      });
    }
  });

  it("CB. the count is the whole organization's, not the loaded page's", async () => {
    const first = await page("awaiting_payment", undefined, 50);
    expect(first.orders.length).toBe(50);
    expect(first.nextCursor).not.toBeNull();
    expect((await counts()).paymentDue).toBe(161);
  });
});
