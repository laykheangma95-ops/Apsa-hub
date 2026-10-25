/**
 * Order and Parcel workflow — REAL SQL behaviour (PGlite, every migration applied).
 *
 * Proves migration 065 at the database:
 *   - parcel details + shelf/bin are recorded at Mark Packed and change no
 *     payment, hand-off, delivery or lifecycle status
 *   - the three work queues select exactly the right orders (payment due incl.
 *     COD, not yet prepared incl. delivery-arranged-before-packing, packed and
 *     waiting for courier) and never cross tenants
 *   - undo packing needs a reason, writes history + audit together, and is
 *     refused once the parcel is with the courier; the generic reopen is too
 *
 * Limitation: PGlite is a single connection — lock races are covered by the
 * re-read under the order lock (same discipline as 054's reopen).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
type Row = Record<string, unknown>;

let f: Fixture;

beforeAll(async () => {
  f = await financialFixture();
});
afterAll(async () => {
  await f?.close();
});

async function confirmedOrder(tenant = f.org): Promise<string> {
  const id = await f.newOrder(tenant);
  await f.db.query(`update orders set lifecycle_status='confirmed' where id=$1`, [id]);
  await f.db.query(
    `insert into parcels(organization_id,order_id,parcel_code,created_by) values($1,$2,$3,$4)`,
    [tenant, id, `APSA-PARCEL-TEST-${id}`, f.actor],
  );
  return id;
}

const one = async (sql: string, args: unknown[]) => (await f.db.query<Row>(sql, args)).rows[0]!;
const orderRow = (id: string) =>
  one(
    `select lifecycle_status::text l, payment_status::text p, fulfillment_status::text fu
     from orders where id=$1`,
    [id],
  );
const packedNow = async (order: string) =>
  (await one(`select order_currently_packed_v1($1,$2) v`, [f.org, order])).v as boolean;
const details = (
  order: string,
  count = 2,
  weight: number | null = 1200,
  at: string | null = "A-3",
) => f.rpc("record_parcel_pack_details_v1", [f.org, order, f.actor, count, weight, at]);
const pack = (order: string) => f.rpc("record_order_packed_v1", [f.org, order, f.actor]);
const arrange = async (order: string, cod: number | null = null) => {
  const r = await f.rpc("create_delivery_v1", [
    f.org,
    order,
    f.actor,
    null,
    null,
    null,
    "Courier",
    null,
    cod,
  ]);
  expect(r.status).toBe("success");
  return r.delivery_id as string;
};
const move = (delivery: string, from: string, to: string, reason: string | null = null) =>
  f.rpc("transition_delivery_status_v1", [f.org, delivery, from, to, f.actor, reason]);
const undo = (order: string, reason: string | null = "Packed the wrong size", tenant = f.org) =>
  f.rpc("undo_order_packing_v1", [tenant, order, f.actor, reason]);
const queue = async (name: string, tenant = f.org) =>
  (await f.db.query<Row>(`select * from list_order_work_queue_v1($1,$2,200)`, [tenant, name])).rows;
const ids = (rows: Row[]) => rows.map((r) => r.order_id);

describe("parcel details at Mark Packed", () => {
  it("records count, weight and shelf without touching payment, hand-off or lifecycle", async () => {
    const order = await confirmedOrder();
    expect((await details(order)).status).toBe("success");
    expect((await pack(order)).status).toBe("success");
    expect(await orderRow(order)).toEqual({ l: "confirmed", p: "unpaid", fu: "processing" });
    const [row] = (await queue("awaiting_handoff")).filter((r) => r.order_id === order);
    expect(row).toMatchObject({
      packed: true,
      package_count: 2,
      weight_grams: 1200,
      storage_location: "A-3",
      payment_status: "unpaid",
      active_delivery_status: null,
    });
  });

  it("rejects invalid details and orders that cannot be packed; never writes across tenants", async () => {
    const order = await confirmedOrder();
    expect((await details(order, 0)).status).toBe("invalid_details");
    expect((await details(order, 1, -5)).status).toBe("invalid_details");
    expect((await details(order, 1, null, "x".repeat(41))).status).toBe("invalid_details");
    const draft = await f.newOrder();
    expect((await details(draft)).status).toBe("invalid_order");
    const other = await confirmedOrder(f.orgB);
    expect((await details(other)).status).toBe("not_found");
  });

  it("records are append-only", async () => {
    const order = await confirmedOrder();
    await details(order);
    await expect(
      f.db.query(`update parcel_pack_records set storage_location='Z' where order_id=$1`, [order]),
    ).rejects.toThrow(/append-only/);
  });

  it("browser roles hold no privilege on the new table or functions", async () => {
    const r = await one(
      `select has_table_privilege('authenticated','public.parcel_pack_records','SELECT') t,
              has_table_privilege('anon','public.parcel_pack_records','SELECT') a,
              has_function_privilege('authenticated','public.undo_order_packing_v1(uuid,uuid,uuid,text)','EXECUTE') u,
              has_function_privilege('authenticated','public.list_order_work_queue_v1(uuid,text,integer)','EXECUTE') q,
              has_table_privilege('service_role','public.parcel_pack_records','INSERT') si`,
      [],
    );
    expect(r).toEqual({ t: false, a: false, u: false, q: false, si: false });
  });
});

describe("work queues", () => {
  it("payment due includes COD and payments awaiting review, excludes paid, drafts and cancelled", async () => {
    const cod = await confirmedOrder();
    await arrange(cod, 10000);
    const plain = await confirmedOrder();
    const paid = await confirmedOrder();
    const cash = await f.record(10000, "cash", null, paid);
    if ((await f.state(paid)).payment_status !== "paid") await f.verify(cash);
    expect((await f.state(paid)).payment_status).toBe("paid");
    const reviewing = await confirmedOrder();
    await f.record(10000, "bank_transfer", null, reviewing);
    expect((await f.state(reviewing)).payment_status).toBe("pending");
    const draft = await f.newOrder();
    const cancelled = await confirmedOrder();
    await f.db.query(`update orders set lifecycle_status='cancelled' where id=$1`, [cancelled]);
    const rows = await queue("payment_due");
    expect(ids(rows)).toEqual(expect.arrayContaining([cod, plain, reviewing]));
    expect(ids(rows)).not.toContain(cancelled);
    expect(ids(rows)).not.toContain(paid);
    expect(ids(rows)).not.toContain(draft);
    expect(rows.find((r) => r.order_id === cod)!.cod_amount_minor).toBe(10000);
    expect(rows.find((r) => r.order_id === plain)!.cod_amount_minor).toBeNull();
  });

  it("not prepared includes a delivery arranged before packing; packed moves to awaiting hand-off; handed off leaves both", async () => {
    const order = await confirmedOrder();
    const delivery = await arrange(order);
    expect((await orderRow(order)).fu).toBe("processing");
    expect(ids(await queue("not_prepared"))).toContain(order);
    expect(ids(await queue("awaiting_handoff"))).not.toContain(order);

    await details(order, 1, null, "B-1");
    expect((await move(delivery, "pending", "preparing")).status).toBe("success");
    expect((await move(delivery, "preparing", "ready", "pack_order_packed")).status).toBe(
      "success",
    );
    expect(ids(await queue("not_prepared"))).not.toContain(order);
    const waiting = (await queue("awaiting_handoff")).find((r) => r.order_id === order)!;
    expect(waiting).toMatchObject({ active_delivery_status: "ready", storage_location: "B-1" });

    expect((await move(delivery, "ready", "in_transit")).status).toBe("success");
    expect(ids(await queue("not_prepared"))).not.toContain(order);
    expect(ids(await queue("awaiting_handoff"))).not.toContain(order);
  });

  it("another organization's orders never appear; unknown queue names return nothing", async () => {
    const mine = await confirmedOrder();
    const theirs = await confirmedOrder(f.orgB);
    expect(ids(await queue("not_prepared"))).toContain(mine);
    expect(ids(await queue("not_prepared"))).not.toContain(theirs);
    expect(ids(await queue("not_prepared", f.orgB))).toContain(theirs);
    expect(ids(await queue("not_prepared", f.orgB))).not.toContain(mine);
    expect(await queue("everything")).toEqual([]);
  });

  it("pack details are hidden once packing is undone", async () => {
    const order = await confirmedOrder();
    await details(order);
    await pack(order);
    expect((await undo(order)).status).toBe("success");
    const row = (await queue("not_prepared")).find((r) => r.order_id === order)!;
    expect(row).toMatchObject({ packed: false, storage_location: null, package_count: null });
  });
});

describe("undo packing", () => {
  it("requires a reason and an actor; writes nothing when refused", async () => {
    const order = await confirmedOrder();
    await pack(order);
    expect((await undo(order, null)).status).toBe("reason_required");
    expect((await undo(order, "  ")).status).toBe("reason_required");
    expect((await f.rpc("undo_order_packing_v1", [f.org, order, null, "Wrong"])).status).toBe(
      "actor_required",
    );
    expect(await packedNow(order)).toBe(true);
    expect((await orderRow(order)).fu).toBe("processing");
  });

  it("clears packed, records the reason in history and an audit row, cancels a ready delivery", async () => {
    const order = await confirmedOrder();
    await pack(order);
    const delivery = await arrange(order);
    expect(
      (await f.rpc("ready_packed_delivery_v1", [f.org, order, delivery, f.actor])).status,
    ).toBe("success");
    const result = await undo(order, "Wrong item packed");
    expect(result).toMatchObject({ status: "success", cancelled_delivery_id: delivery });
    expect(await packedNow(order)).toBe(false);
    expect((await orderRow(order)).fu).toBe("unfulfilled");
    expect((await one(`select status::text s from deliveries where id=$1`, [delivery])).s).toBe(
      "cancelled",
    );
    const history = await one(
      `select reason from order_status_history where order_id=$1 and axis='fulfillment'
       order by changed_at desc limit 1`,
      [order],
    );
    expect(history.reason).toBe("Wrong item packed");
    const audit = await one(
      `select action, reason, actor_user_id from audit_logs where resource_id=$1 and action='orders.packing_undone'`,
      [order],
    );
    expect(audit).toEqual({
      action: "orders.packing_undone",
      reason: "Wrong item packed",
      actor_user_id: f.actor,
    });
    // Payment and lifecycle untouched.
    expect(await orderRow(order)).toMatchObject({ l: "confirmed", p: "unpaid" });
  });

  it("works on a packed order whose delivery attempt was cancelled (fulfillment unfulfilled)", async () => {
    const order = await confirmedOrder();
    await pack(order);
    const delivery = await arrange(order);
    await f.rpc("ready_packed_delivery_v1", [f.org, order, delivery, f.actor]);
    expect((await move(delivery, "ready", "cancelled", "Customer moved")).status).toBe("success");
    expect((await orderRow(order)).fu).toBe("unfulfilled");
    expect(await packedNow(order)).toBe(true);
    expect((await undo(order)).status).toBe("success");
    expect(await packedNow(order)).toBe(false);
    expect((await orderRow(order)).fu).toBe("unfulfilled");
  });

  it("is refused once the parcel is with the courier — and so is the generic reopen", async () => {
    const order = await confirmedOrder();
    await pack(order);
    const delivery = await arrange(order);
    await f.rpc("ready_packed_delivery_v1", [f.org, order, delivery, f.actor]);
    expect((await move(delivery, "ready", "in_transit")).status).toBe("success");
    expect((await undo(order)).status).toBe("handed_off");
    expect((await f.rpc("reopen_order_fulfillment_v1", [f.org, order, f.actor, "x"])).status).toBe(
      "handed_off",
    );
    expect((await one(`select status::text s from deliveries where id=$1`, [delivery])).s).toBe(
      "in_transit",
    );
    expect((await orderRow(order)).fu).toBe("processing");
  });

  it("is refused for an order that is not packed, cancelled, or in another organization", async () => {
    const notPacked = await confirmedOrder();
    expect((await undo(notPacked)).status).toBe("not_packed");
    const cancelled = await confirmedOrder();
    await f.db.query(`update orders set lifecycle_status='cancelled' where id=$1`, [cancelled]);
    expect((await undo(cancelled)).status).toBe("order_terminal");
    const theirs = await confirmedOrder(f.orgB);
    expect((await undo(theirs)).status).toBe("not_found");
  });
});
