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
type Filter = "awaiting_payment" | "to_pack" | "waiting_pickup" | "all";

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

describe("Needs preparation and the packed rule", () => {
  let org: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    org = await newOrg();
    ids.fresh = await order(org, "confirmed", "unpaid", "unfulfilled");
    ids.draft = await order(org, "draft", "unpaid", "unfulfilled");
    ids.cancelled = await order(org, "cancelled", "unpaid", "cancelled");
    ids.packedNoDelivery = await order(org, "confirmed", "paid", "processing");
    await orderHistory(
      org,
      ids.packedNoDelivery,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00+00",
      "pack_order_packed",
    );

    // Packed, then its delivery failed: back to unfulfilled, but still packed
    // (migration 054 — a retired delivery attempt does not clear packed).
    ids.packedThenFailed = await order(org, "confirmed", "paid", "unfulfilled");
    await orderHistory(
      org,
      ids.packedThenFailed,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00+00",
      "pack_order_packed",
    );
    await delivery(org, ids.packedThenFailed, "failed", { at: "2026-10-01T11:00:00+00" });
    await orderHistory(
      org,
      ids.packedThenFailed,
      "processing",
      "unfulfilled",
      "2026-10-01T11:00:00+00",
      null,
    );

    // Packed, then REOPENED (its ready delivery cancelled by the reopen): not packed.
    ids.reopened = await order(org, "confirmed", "paid", "unfulfilled");
    await orderHistory(
      org,
      ids.reopened,
      "unfulfilled",
      "processing",
      "2026-10-01T09:00:00+00",
      "pack_order_packed",
    );
    await delivery(org, ids.reopened, "cancelled", {
      at: "2026-10-01T12:00:00+00",
      reason: "system:order_fulfillment_reopened",
    });
    await orderHistory(
      org,
      ids.reopened,
      "processing",
      "unfulfilled",
      "2026-10-01T12:00:00+00",
      "reopen",
    );
    signInAs(OWNER, org);
  });

  it("NA. confirmed, unfulfilled orders are listed; drafts, cancelled and packed-without-delivery are not", async () => {
    const listed = new Set(await walk("to_pack"));
    expect(listed).toEqual(new Set([ids.fresh, ids.packedThenFailed, ids.reopened]));
    expect((await counts()).needsPreparation).toBe(3);
  });

  it("NB. packed-then-failed is shown for review, never as 'needs packing'; reopened and fresh are not", async () => {
    const result = await page("to_pack");
    expect(result.attention[ids.packedThenFailed!]!.packedReview).toBe(true);
    expect(result.attention[ids.reopened!]!.packedReview).toBe(false);
    expect(result.attention[ids.fresh!]!.packedReview).toBe(false);
  });

  it("NC. the packed rule is asked only for listed orders that ever had a delivery", async () => {
    const before = transport.reads.filter((r) => r === "rpc:order_currently_packed_v1").length;
    await page("to_pack");
    const after = transport.reads.filter((r) => r === "rpc:order_currently_packed_v1").length;
    expect(after - before).toBe(2); // packedThenFailed, reopened — not the fresh order
  });

  it("ND. a member without delivery.read still gets the packed review (Order detail shows it too), but no delivery facts", async () => {
    signInAs(VIEWER, org);
    try {
      const result = await page("to_pack");
      expect(result.attention[ids.packedThenFailed!]!.packedReview).toBe(true);
      expect(result.attention[ids.packedThenFailed!]!.delivery).toBeNull();
    } finally {
      signInAs(OWNER, org);
    }
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
    for (const filter of ["awaiting_payment", "to_pack", "waiting_pickup"] as const) {
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
    signInAs(OWNER, org);
  });

  it("CA. every view, walked page by page, holds exactly its count — no row twice, none missing", async () => {
    const c = await counts();
    expect(c).toMatchObject({ paymentDue: 130 + 31, needsPreparation: 130, waitingPickup: 61 });
    for (const [filter, expected, limit] of [
      ["awaiting_payment", c.paymentDue, 50],
      ["to_pack", c.needsPreparation, 50],
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
