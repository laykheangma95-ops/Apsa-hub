/**
 * Order cancellation safety — REAL SQL behaviour (PGlite, every migration
 * applied), then the production order service through the same database.
 *
 * The rule under test (migration 063, order_cancellation_block_v1): a confirmed
 * order is cancelled — and its sold units released back to stock — only while
 * the goods are still in the merchant's custody and no shipment is active.
 * Decided under the order row lock, in the cancelling transaction:
 *
 *   fulfillment 'fulfilled'             → cancel_blocked / goods_with_customer
 *   delivery in_transit | delivered      → cancel_blocked / goods_dispatched
 *   delivery pending | preparing | ready → cancel_blocked / active_delivery
 *
 * A refused cancellation writes nothing: no status, no history, no stock
 * movement, no audit row. Every assertion here fails against 001–061 alone
 * (the pre-063 function cancelled and restocked in all three cases).
 *
 * Races: PGlite is one connection, so the lock-step races are expressed as the
 * two serial orders the order row lock allows (every delivery / fulfillment /
 * payment writer locks the same order row, see the 063 header). Each test
 * names the interleaving it stands for. The same scenarios were run with two
 * real concurrent sessions on PostgreSQL 16 while developing 063.
 *
 * Money is observed, never changed: cancellation of a paid order is still
 * allowed (an open owner decision) and must leave payments and the payment /
 * refund axes exactly as they were.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "../server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, unknown>;
let f: Awaited<ReturnType<typeof financialFixture>>;

let product: string;
let variant: string;
let location: string;
let productB: string;
let variantB: string;
let locationB: string;

/** Audit rows the service tried to write (captured by the transport below). */
const audits: Json[] = [];

const rows = async <T = Json>(sql: string, params: unknown[] = []) =>
  (await f.db.query<T>(sql, params)).rows;
const scalar = async <T = number>(sql: string, params: unknown[] = []) =>
  (await rows<{ v: T }>(sql, params))[0]!.v;
const rpc = async (name: string, args: unknown[]) => (await f.rpc(name, args)) as Json;

const onHand = (v = variant) =>
  scalar<number>(
    `select coalesce(sum(quantity_delta),0)::int as v from inventory_movements where variant_id=$1`,
    [v],
  );

async function order(id: string) {
  return (
    await rows<Json>(
      `select lifecycle_status,fulfillment_status,payment_status,refund_status from orders where id=$1`,
      [id],
    )
  )[0]!;
}

async function ledger(id: string) {
  return (
    await rows<{ t: string; d: number }>(
      `select m.movement_type::text t, m.quantity_delta::int d from inventory_movements m
       join order_items oi on oi.id=m.reference_id where oi.order_id=$1
       order by m.movement_type`,
      [id],
    )
  ).map((r) => `${r.t} ${r.d}`);
}

const historyCount = (id: string) =>
  scalar("select count(*)::int as v from order_status_history where order_id=$1", [id]);

const deliveryStatus = (id: string) =>
  scalar<string>("select status::text as v from deliveries where id=$1", [id]);

async function payments(id: string) {
  return rows(
    `select status::text,amount_minor::int from payments where order_id=$1 order by created_at`,
    [id],
  );
}

/** Everything a refused cancellation must leave untouched. */
async function footprint(id: string) {
  return {
    order: await order(id),
    ledger: await ledger(id),
    history: await historyCount(id),
    deliveries: await rows(
      "select status::text from deliveries where order_id=$1 order by created_at",
      [id],
    ),
    parcels: await rows("select status from parcels where order_id=$1", [id]),
    payments: await payments(id),
  };
}

async function confirmed(org = f.org, v = variant, loc = location, qty = 2): Promise<string> {
  const created = (
    await rows<{ r: Json }>(
      `select create_order_v2($1,$2,'POS',$3::jsonb,null,$4,0,0,null,$5) as r`,
      [org, f.actor, JSON.stringify([{ variant_id: v, quantity: qty }]), loc, crypto.randomUUID()],
    )
  )[0]!.r;
  expect(created.status).toBe("success");
  const id = created.order_id as string;
  expect(
    (
      await rpc("transition_order_status_v1", [
        org,
        id,
        "lifecycle",
        "draft",
        "confirmed",
        f.actor,
        null,
      ])
    ).status,
  ).toBe("success");
  return id;
}

const cancel = (id: string, from = "confirmed", org = f.org) =>
  rpc("transition_order_status_v1", [org, id, "lifecycle", from, "cancelled", f.actor, "test"]);
const fulfillment = (id: string, from: string, to: string) =>
  rpc("transition_order_status_v1", [f.org, id, "fulfillment", from, to, f.actor, null]);
const createDelivery = async (id: string) => {
  const r = await rpc("create_delivery_v1", [
    f.org,
    id,
    f.actor,
    null,
    null,
    null,
    "Courier",
    null,
    null,
  ]);
  expect(r.status).toBe("success");
  return r.delivery_id as string;
};
const moveDelivery = (d: string, from: string, to: string) =>
  // Only a packed order's delivery may become 'ready' (054): this suite is not
  // about packing, so '→ ready' is the step Mark Packed makes.
  rpc("transition_delivery_status_v1", [
    f.org,
    d,
    from,
    to,
    f.actor,
    to === "ready" ? "pack_order_packed" : null,
  ]);

async function deliveryAt(
  id: string,
  status: "pending" | "preparing" | "ready" | "in_transit" | "delivered",
) {
  const d = await createDelivery(id);
  const chain = ["pending", "preparing", "ready", "in_transit", "delivered"];
  for (let i = 0; chain[i] !== status; i++) {
    expect((await moveDelivery(d, chain[i]!, chain[i + 1]!)).status).toBe("success");
  }
  return d;
}

/** Asserts a cancellation was refused for `reason` and wrote nothing. */
async function expectBlocked(id: string, reason: string, from = "confirmed") {
  const before = await footprint(id);
  const stock = await onHand();
  expect(await cancel(id, from)).toEqual({ status: "cancel_blocked", reason });
  expect(await footprint(id)).toEqual(before);
  expect(await onHand()).toBe(stock);
}

/** Asserts a cancellation succeeded and released exactly the sold units once. */
async function expectCancelled(id: string) {
  const stock = await onHand();
  expect(await cancel(id)).toMatchObject({ status: "success", stock_movements: 1 });
  expect(await order(id)).toMatchObject({
    lifecycle_status: "cancelled",
    fulfillment_status: "cancelled",
  });
  expect((await ledger(id)).sort()).toEqual(["return 2", "sale -2"]);
  expect(await onHand()).toBe(stock + 2);
}

beforeAll(async () => {
  f = await financialFixture();
  async function seed(org: string) {
    const p = crypto.randomUUID();
    const v = crypto.randomUUID();
    const l = crypto.randomUUID();
    await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'ផលិតផល')`, [
      p,
      org,
    ]);
    await f.db.query(
      `insert into product_variants(id,organization_id,product_id,price_amount) values($1,$2,$3,1000)`,
      [v, org, p],
    );
    await f.db.query(`insert into locations(id,organization_id,name) values($1,$2,'Shop')`, [
      l,
      org,
    ]);
    await f.db.query(
      `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
       values($1,$2,$3,$4,100,'initial')`,
      [org, p, v, l],
    );
    return [p, v, l] as const;
  }
  [product, variant, location] = await seed(f.org);
  [productB, variantB, locationB] = await seed(f.orgB);
  void product;
  void productB;
}, 120000);

afterAll(async () => {
  await f?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// Goods still in custody — cancellation allowed, stock released once
// ═══════════════════════════════════════════════════════════════════════════

describe("allowed: the goods never left the merchant", () => {
  it("1. confirmed, unfulfilled, unpaid", async () => {
    await expectCancelled(await confirmed());
  });

  it("2. confirmed, partially paid — payment rows and payment axis untouched", async () => {
    const id = await confirmed();
    await f.verify(await f.record(500, "cash", null, id));
    const moneyBefore = { order: await order(id), payments: await payments(id) };
    await expectCancelled(id);
    expect(await payments(id)).toEqual(moneyBefore.payments);
    expect((await order(id)).payment_status).toBe(moneyBefore.order.payment_status);
    expect((await order(id)).refund_status).toBe(moneyBefore.order.refund_status);
  });

  it("3. confirmed, fully paid — still refundable afterwards through the Payment domain", async () => {
    const id = await confirmed();
    const payment = await f.record(2000, "cash", null, id);
    await f.verify(payment);
    await expectCancelled(id);
    expect(await order(id)).toMatchObject({ payment_status: "paid", refund_status: "none" });
    expect((await f.refund(payment, 2000)).status).toBe("success");
    expect((await order(id)).refund_status).toBe("full");
  });

  it("4a. packed, no delivery arranged (the parcel is still on the bench)", async () => {
    const id = await confirmed();
    expect((await rpc("record_order_packed_v1", [f.org, id, f.actor])).status).toBe("success");
    expect((await order(id)).fulfillment_status).toBe("processing");
    await expectCancelled(id);
  });

  it("after a FAILED delivery the order is back in custody and may be cancelled", async () => {
    const id = await confirmed();
    const d = await deliveryAt(id, "in_transit");
    expect((await moveDelivery(d, "in_transit", "failed")).status).toBe("success");
    expect((await order(id)).fulfillment_status).toBe("unfulfilled");
    await expectCancelled(id);
  });

  it("after a CANCELLED delivery the order may be cancelled", async () => {
    const id = await confirmed();
    const d = await deliveryAt(id, "ready");
    expect((await moveDelivery(d, "ready", "cancelled")).status).toBe("success");
    await expectCancelled(id);
  });

  it("a draft is cancelled as before, with no stock effect", async () => {
    const created = (
      await rows<{ r: Json }>(
        `select create_order_v2($1,$2,'POS',$3::jsonb,null,$4,0,0,null,$5) as r`,
        [
          f.org,
          f.actor,
          JSON.stringify([{ variant_id: variant, quantity: 1 }]),
          location,
          crypto.randomUUID(),
        ],
      )
    )[0]!.r;
    const id = created.order_id as string;
    const stock = await onHand();
    expect(await cancel(id, "draft")).toMatchObject({ status: "success", stock_movements: 0 });
    expect(await onHand()).toBe(stock);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Goods left custody or a shipment is active — refused, nothing written
// ═══════════════════════════════════════════════════════════════════════════

describe("refused: a shipment is active or the goods have left", () => {
  it("4b/5. packed with a delivery pending, preparing or ready → active_delivery, and the delivery stays operable", async () => {
    for (const status of ["pending", "preparing", "ready"] as const) {
      const id = await confirmed();
      const d = await deliveryAt(id, status);
      await expectBlocked(id, "active_delivery");
      expect(await deliveryStatus(d)).toBe(status);
      // Not frozen: the shipment can still be cancelled through its own flow,
      // after which the order cancels normally.
      expect((await moveDelivery(d, status, "cancelled")).status).toBe("success");
      await expectCancelled(id);
    }
  });

  it("6. in transit → goods_dispatched; the courier outcome can still be recorded", async () => {
    const id = await confirmed();
    const d = await deliveryAt(id, "in_transit");
    await expectBlocked(id, "goods_dispatched");
    expect((await moveDelivery(d, "in_transit", "delivered")).status).toBe("success");
    expect((await order(id)).fulfillment_status).toBe("fulfilled");
  });

  it("7a. delivered by courier → goods_with_customer; no restock of goods the customer holds", async () => {
    const id = await confirmed();
    await deliveryAt(id, "delivered");
    await expectBlocked(id, "goods_with_customer");
    expect(await ledger(id)).toEqual(["sale -2"]);
  });

  it("7b. handed over at the counter (unfulfilled → fulfilled) → goods_with_customer", async () => {
    const id = await confirmed();
    expect((await fulfillment(id, "unfulfilled", "fulfilled")).status).toBe("success");
    await expectBlocked(id, "goods_with_customer");
  });

  it("7c. a paid and delivered order is refused and its money is untouched", async () => {
    const id = await confirmed();
    await f.verify(await f.record(2000, "cash", null, id));
    await deliveryAt(id, "delivered");
    await expectBlocked(id, "goods_with_customer");
    expect(await order(id)).toMatchObject({ payment_status: "paid", refund_status: "none" });
  });

  it("the fulfillment axis cannot be called off first to route around the guard", async () => {
    const id = await confirmed();
    await deliveryAt(id, "in_transit");
    const before = await footprint(id);
    expect(await fulfillment(id, "processing", "cancelled")).toEqual({
      status: "cancel_blocked",
      reason: "goods_dispatched",
    });
    expect(await footprint(id)).toEqual(before);
    await expectBlocked(id, "goods_dispatched");

    const counter = await confirmed();
    await fulfillment(counter, "unfulfilled", "fulfilled");
    expect(await fulfillment(counter, "fulfilled", "cancelled")).toEqual({
      status: "cancel_blocked",
      reason: "goods_with_customer",
    });

    const pending = await confirmed();
    await deliveryAt(pending, "pending");
    expect(await fulfillment(pending, "processing", "cancelled")).toEqual({
      status: "cancel_blocked",
      reason: "active_delivery",
    });
  });

  it("calling fulfillment off with nothing shipped still works, and the later cancel restocks once", async () => {
    const id = await confirmed();
    expect((await fulfillment(id, "unfulfilled", "cancelled")).status).toBe("success");
    const stock = await onHand();
    expect(await cancel(id)).toMatchObject({ status: "success", stock_movements: 1 });
    expect(await onHand()).toBe(stock + 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Terminal, repeated, raced and cross-tenant
// ═══════════════════════════════════════════════════════════════════════════

describe("terminal, idempotent, raced, isolated", () => {
  it("8. completed: terminal / stale exactly as before, no stock effect", async () => {
    const id = await confirmed();
    await f.verify(await f.record(2000, "cash", null, id));
    await fulfillment(id, "unfulfilled", "fulfilled");
    expect(
      (
        await rpc("transition_order_status_v1", [
          f.org,
          id,
          "lifecycle",
          "confirmed",
          "completed",
          f.actor,
          null,
        ])
      ).status,
    ).toBe("success");
    const before = await footprint(id);
    expect(await cancel(id, "completed")).toEqual({ status: "terminal", lifecycle: "completed" });
    expect(await cancel(id, "confirmed")).toEqual({ status: "stale", current: "completed" });
    expect(await footprint(id)).toEqual(before);
  });

  it("9/12. already cancelled and repeated cancellation: one release only", async () => {
    const id = await confirmed();
    await expectCancelled(id);
    const before = await footprint(id);
    const stock = await onHand();
    expect(await cancel(id)).toEqual({ status: "stale", current: "cancelled" });
    expect(await cancel(id, "cancelled")).toEqual({ status: "no_change", current: "cancelled" });
    expect(await footprint(id)).toEqual(before);
    expect(await onHand()).toBe(stock);
  });

  it("10a. handoff commits first, the waiting cancel then sees the courier → goods_dispatched", async () => {
    const id = await confirmed();
    const d = await deliveryAt(id, "ready");
    expect((await moveDelivery(d, "ready", "in_transit")).status).toBe("success");
    await expectBlocked(id, "goods_dispatched");
  });

  it("10b. the cancel attempt runs first against a ready delivery → refused, handoff proceeds", async () => {
    const id = await confirmed();
    const d = await deliveryAt(id, "ready");
    await expectBlocked(id, "active_delivery");
    expect((await moveDelivery(d, "ready", "in_transit")).status).toBe("success");
  });

  it("10c. Arrange Delivery commits first, the waiting cancel → active_delivery", async () => {
    const id = await confirmed();
    await createDelivery(id);
    await expectBlocked(id, "active_delivery");
  });

  it("10d. cancel commits first, a waiting handoff / arrange / counter fulfilment is refused", async () => {
    const id = await confirmed();
    await expectCancelled(id);
    expect(
      (
        await rpc("create_delivery_v1", [
          f.org,
          id,
          f.actor,
          null,
          null,
          null,
          "Courier",
          null,
          null,
        ])
      ).status,
    ).toBe("order_not_confirmed");
    expect((await fulfillment(id, "cancelled", "fulfilled")).status).toBe("terminal");
  });

  it("11. payment committed first, then cancel: allowed, payment untouched (owner decision pending)", async () => {
    const id = await confirmed();
    await f.verify(await f.record(2000, "cash", null, id));
    const paid = await payments(id);
    await expectCancelled(id);
    expect(await payments(id)).toEqual(paid);
    expect((await order(id)).payment_status).toBe("paid");
  });

  it("another organization's cancel is not_found and moves neither tenant's stock", async () => {
    const id = await confirmed();
    await deliveryAt(id, "delivered");
    const before = await footprint(id);
    const stockA = await onHand();
    const stockB = await onHand(variantB);
    expect(await cancel(id, "confirmed", f.orgB)).toEqual({ status: "not_found" });
    expect(
      await rpc("transition_order_status_v1", [
        f.orgB,
        id,
        "fulfillment",
        "fulfilled",
        "cancelled",
        f.actor,
        null,
      ]),
    ).toEqual({ status: "not_found" });
    expect(await footprint(id)).toEqual(before);
    expect(await onHand()).toBe(stockA);
    expect(await onHand(variantB)).toBe(stockB);

    // B's own order is judged by B's own deliveries only.
    const b = await confirmed(f.orgB, variantB, locationB);
    expect(await cancel(b, "confirmed", f.orgB)).toMatchObject({ status: "success" });
  });

  it("the guard helper is not callable by any API role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await scalar<boolean>(
          `select has_function_privilege($1,'public.order_cancellation_block_v1(uuid,uuid)','EXECUTE') as v`,
          [role],
        ),
      ).toBe(false);
    }
    expect(
      await scalar<boolean>(
        `select has_function_privilege('service_role','public.transition_order_status_v1(uuid,uuid,text,text,text,uuid,text)','EXECUTE') as v`,
      ),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION SERVICE through the same database
// ═══════════════════════════════════════════════════════════════════════════

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
    const chain = {
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
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options.ascending ? "asc" : "desc"}`);
        return chain;
      },
      limit(n: number) {
        max = n;
        return chain;
      },
      single() {
        single = true;
        return chain;
      },
      async execute() {
        let sql = `select ${columns} from ${table}`;
        if (where.length) sql += ` where ${where.join(" and ")}`;
        if (ordering.length) sql += ` order by ${ordering.join(",")}`;
        if (max !== undefined) sql += ` limit ${max}`;
        try {
          const result = JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows));
          if (single) {
            return result.length
              ? { data: result[0], error: null }
              : { data: null, error: { code: "PGRST116" } };
          }
          return { data: result, error: null };
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
            audits.push(row);
            return { error: null };
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
      const values = entries.map(([, value]) =>
        value !== null && typeof value === "object" ? JSON.stringify(value) : value,
      );
      try {
        const result = await f.db.query<{ result: unknown }>(sql, values);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

mock.module("../lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));

function context(org: string, user: string, permissions: string[]): AuthorizationContext {
  return {
    organizationId: org,
    userId: user,
    can: (key: string) => permissions.includes(key),
    require: (key: string) => {
      if (!permissions.includes(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 });
      }
    },
  } as unknown as AuthorizationContext;
}

/**
 * Calls transitionLifecycleStatus with the acting principal as a trailing
 * argument. The service on main ignores it; once the refuse-only
 * expectedPrincipal precondition (PR #121) lands, it is the matching principal
 * that precondition requires — so this suite holds in either merge order.
 */
async function cancelViaService(ctx: AuthorizationContext, id: string, reason: string | null) {
  const service = await import("../server/orders/service");
  const call = service.transitionLifecycleStatus as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof service.transitionLifecycleStatus>;
  return call(ctx, id, "cancelled", reason, {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });
}

async function serviceError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { statusCode?: number; code?: string };
  }
  throw new Error("expected the service call to be refused");
}

describe("order service: cancellation through the real database", () => {
  const perms = ["orders.cancel", "orders.read"];

  it("maps each refusal to a 409 with a stable code, writes no audit, moves no stock", async () => {
    const cases: [string, () => Promise<string>][] = [
      [
        "order_cancel_active_delivery",
        async () => {
          const id = await confirmed();
          await deliveryAt(id, "ready");
          return id;
        },
      ],
      [
        "order_cancel_goods_dispatched",
        async () => {
          const id = await confirmed();
          await deliveryAt(id, "in_transit");
          return id;
        },
      ],
      [
        "order_cancel_goods_with_customer",
        async () => {
          const id = await confirmed();
          await deliveryAt(id, "delivered");
          return id;
        },
      ],
    ];
    for (const [code, setup] of cases) {
      const id = await setup();
      const before = await footprint(id);
      const stock = await onHand();
      const auditsBefore = audits.length;
      const error = await serviceError(
        cancelViaService(context(f.org, f.actor, perms), id, "test"),
      );
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/cannot be cancelled/);
      // Only the message crosses the server-function wire: it leads with the code.
      expect(error.message.startsWith(`${code}: `)).toBe(true);
      expect(await footprint(id)).toEqual(before);
      expect(await onHand()).toBe(stock);
      expect(audits.length).toBe(auditsBefore);
    }
  });

  it("an allowed cancellation releases stock once and audits orders.cancel with the movement count", async () => {
    const id = await confirmed();
    const stock = await onHand();
    const detail = await cancelViaService(
      context(f.org, f.actor, perms),
      id,
      "customer changed mind",
    );
    expect(detail.lifecycleStatus).toBe("cancelled");
    expect(await onHand()).toBe(stock + 2);
    const audit = audits.at(-1)!;
    expect(audit).toMatchObject({ action: "orders.cancel", resource_id: id });
    expect(JSON.stringify(audit)).toContain("inventory_movements_written");
    // A replay is refused as terminal and releases nothing more.
    const replay = await serviceError(cancelViaService(context(f.org, f.actor, perms), id, null));
    expect(replay.statusCode).toBe(409);
    expect(await onHand()).toBe(stock + 2);
  });

  it("without orders.cancel the call is refused before the order is read", async () => {
    const id = await confirmed();
    const before = await footprint(id);
    const error = await serviceError(
      cancelViaService(context(f.org, f.actor, ["orders.read", "orders.update"]), id, null),
    );
    expect(error.statusCode).toBe(403);
    expect(await footprint(id)).toEqual(before);
  });

  it("another organization's member gets 404 for an order it cannot see", async () => {
    const id = await confirmed();
    const before = await footprint(id);
    const error = await serviceError(cancelViaService(context(f.orgB, f.actor, perms), id, null));
    expect(error.statusCode).toBe(404);
    expect(await footprint(id)).toEqual(before);
  });
});
