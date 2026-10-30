/**
 * Pack Order packing round — REAL SQL behaviour (PGlite, every migration applied).
 *
 * Executes migration 066 (order_pack_round_v1, mark_order_packed_v1) against
 * Postgres and reads back the rows it wrote. Proves, at the database:
 *   - the round counts Pack Order markers on BOTH packing paths (the order's
 *     fulfillment history with no delivery; the delivery's history), and only
 *     this organization's — computed in SQL, so no row page limit applies
 *   - a reopen keeps the round; packing again changes it
 *   - Mark Packed with the round its screen started in packs; with an earlier
 *     round it is refused and writes nothing; with no round it is refused
 *   - a delivery step that refuses rolls the earlier step back
 *
 * Interleaving two transactions needs real connections: see
 * pack-round-pg.runtime.ts (concurrent reopen / pack during submission).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;

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
  return id;
}

const round = async (order: string, tenant = f.org) =>
  (await f.db.query<{ v: number }>(`select order_pack_round_v1($1,$2) as v`, [tenant, order]))
    .rows[0]!.v;
const packedNow = async (order: string) =>
  (await f.db.query<{ v: boolean }>(`select order_currently_packed_v1($1,$2) as v`, [f.org, order]))
    .rows[0]!.v;
const historyRows = async (order: string) =>
  (
    await f.db.query<{ n: number }>(
      `select ((select count(*) from order_status_history where order_id=$1)
             + (select count(*) from delivery_status_history dh
                join deliveries d on d.id = dh.delivery_id where d.order_id=$1))::int as n`,
      [order],
    )
  ).rows[0]!.n;
const deliveryStatus = async (delivery: string) =>
  (
    await f.db.query<{ v: string }>(`select status::text as v from deliveries where id=$1`, [
      delivery,
    ])
  ).rows[0]!.v;

const mark = (order: string, expected: number | null, tenant = f.org) =>
  f.rpc("mark_order_packed_v1", [tenant, order, f.actor, expected]);
const reopen = (order: string) =>
  f.rpc("reopen_order_fulfillment_v1", [f.org, order, f.actor, "Recount"]);
const arrange = async (order: string) => {
  const result = await f.rpc("create_delivery_v1", [
    f.org,
    order,
    f.actor,
    null,
    null,
    null,
    "Courier",
    null,
    null,
  ]);
  expect(result.status).toBe("success");
  return result.delivery_id as string;
};

describe("order_pack_round_v1 counts both packing paths", () => {
  it("no delivery: grows when packed, unchanged by the reopen", async () => {
    const order = await confirmedOrder();
    expect(await round(order)).toBe(0);
    expect((await mark(order, 0)).status).toBe("success");
    const packed = await round(order);
    expect(packed).toBeGreaterThan(0);
    expect((await reopen(order)).status).toBe("success");
    expect(await round(order)).toBe(packed);
    expect(await packedNow(order)).toBe(false);
  });

  it("delivery path: the delivery's marker-tagged history counts", async () => {
    const order = await confirmedOrder();
    const delivery = await arrange(order);
    // Arranging a delivery is not packing.
    expect(await round(order)).toBe(0);
    expect(await mark(order, 0)).toMatchObject({ status: "success", delivery_id: delivery });
    expect(await deliveryStatus(delivery)).toBe("ready");
    const packed = await round(order);
    const markers = (
      await f.db.query<{ n: number }>(
        `select count(*)::int as n from delivery_status_history
         where delivery_id=$1 and reason='pack_order_packed'`,
        [delivery],
      )
    ).rows[0]!.n;
    expect(markers).toBe(2); // pending → preparing → ready, each tagged
    expect(packed).toBe(markers); // the order's own history carries none here
  });

  it("counts only the given organization's history", async () => {
    const order = await confirmedOrder();
    expect((await mark(order, 0)).status).toBe("success");
    expect(await round(order)).toBeGreaterThan(0);
    expect(await round(order, f.orgB)).toBe(0);
  });

  it("many deliveries: every delivery's history is counted (no page limit)", async () => {
    const order = await confirmedOrder();
    // Retire 30 delivery attempts, each packed through its delivery first.
    let expected = 0;
    for (let i = 0; i < 30; i++) {
      const delivery = await arrange(order);
      expect((await mark(order, expected)).status).toBe("success");
      expected = await round(order);
      expect(
        (
          await f.rpc("transition_delivery_status_v1", [
            f.org,
            delivery,
            "ready",
            "cancelled",
            f.actor,
            "Courier did not come",
          ])
        ).status,
      ).toBe("success");
    }
    expect(expected).toBe(60);
  });
});

describe("mark_order_packed_v1 refuses an earlier round", () => {
  it("no delivery: a screen from before the pack and reopen is refused, nothing written", async () => {
    const order = await confirmedOrder();
    const screen = await round(order);
    expect((await mark(order, screen)).status).toBe("success");
    expect((await reopen(order)).status).toBe("success");
    const before = await historyRows(order);
    expect(await mark(order, screen)).toEqual({
      status: "stale_round",
      current_round: await round(order),
    });
    expect(await historyRows(order)).toBe(before);
    expect(await packedNow(order)).toBe(false);
  });

  it("delivery path: a screen from before the pack and reopen is refused, nothing written", async () => {
    const order = await confirmedOrder();
    await arrange(order);
    const screen = await round(order);
    expect((await mark(order, screen)).status).toBe("success");
    expect((await reopen(order)).status).toBe("success"); // cancels the ready delivery
    const replacement = await arrange(order);
    const before = await historyRows(order);
    expect((await mark(order, screen)).status).toBe("stale_round");
    expect(await historyRows(order)).toBe(before);
    expect(await deliveryStatus(replacement)).toBe("pending");
  });

  it("still packed: an earlier round is refused before any already-packed answer", async () => {
    for (const viaDelivery of [false, true]) {
      const order = await confirmedOrder();
      if (viaDelivery) await arrange(order);
      const screen = await round(order);
      expect((await mark(order, screen)).status).toBe("success"); // another member packs
      const before = await historyRows(order);
      expect((await mark(order, screen)).status).toBe("stale_round");
      expect(await historyRows(order)).toBe(before);
    }
  });

  it("still packed, current round: acknowledged without writing (no re-record, round unchanged)", async () => {
    // No delivery: the order's own marker.
    const order = await confirmedOrder();
    expect((await mark(order, 0)).status).toBe("success");
    const current = await round(order);
    const before = await historyRows(order);
    expect(await mark(order, current)).toEqual({ status: "already_packed" });
    expect(await historyRows(order)).toBe(before);
    expect(await round(order)).toBe(current);

    // Through a delivery that is already ready.
    const viaDelivery = await confirmedOrder();
    const delivery = await arrange(viaDelivery);
    expect((await mark(viaDelivery, 0)).status).toBe("success");
    const deliveryRound = await round(viaDelivery);
    const deliveryBefore = await historyRows(viaDelivery);
    expect(await mark(viaDelivery, deliveryRound)).toEqual({
      status: "already_ready",
      delivery_id: delivery,
    });
    expect(await historyRows(viaDelivery)).toBe(deliveryBefore);
  });

  it("packed before a delivery was arranged, current round: the pending delivery is readied and reported as already packed", async () => {
    const order = await confirmedOrder();
    expect((await mark(order, 0)).status).toBe("success");
    const delivery = await arrange(order); // create_delivery_v1 leaves it pending here
    await f.db.query(`update deliveries set status='pending' where id=$1`, [delivery]);
    expect(await mark(order, await round(order))).toEqual({
      status: "success",
      delivery_id: delivery,
      was_packed: true,
    });
    expect(await deliveryStatus(delivery)).toBe("ready");
  });

  it("an unchanged round packs: the screen opened after the reopen succeeds", async () => {
    const order = await confirmedOrder();
    expect((await mark(order, 0)).status).toBe("success");
    expect((await reopen(order)).status).toBe("success");
    expect((await mark(order, await round(order))).status).toBe("success");
    expect(await packedNow(order)).toBe(true);
  });

  it("a missing or negative round is refused, never read as zero", async () => {
    const order = await confirmedOrder();
    expect(await mark(order, null)).toEqual({ status: "round_required" });
    expect(await mark(order, -1)).toEqual({ status: "round_required" });
    expect(await historyRows(order)).toBe(0);
    expect(await packedNow(order)).toBe(false);
  });

  it("another organization's order is not found and nothing is written", async () => {
    const order = await confirmedOrder();
    expect(await mark(order, 0, f.orgB)).toEqual({ status: "not_found" });
    expect(await historyRows(order)).toBe(0);
  });

  it("a delivery step that refuses rolls back the step before it", async () => {
    const order = await confirmedOrder();
    const delivery = await arrange(order);
    // The second step (preparing → ready) refuses: the order is already fulfilled.
    await f.db.query(`update orders set fulfillment_status='fulfilled' where id=$1`, [order]);
    const before = await historyRows(order);
    expect(await mark(order, 0)).toEqual({
      status: "order_fulfillment_terminal",
      delivery_id: delivery,
    });
    expect(await deliveryStatus(delivery)).toBe("pending");
    expect(await historyRows(order)).toBe(before);
    expect(await round(order)).toBe(0);
  });

  it("is executable by service_role only", async () => {
    for (const fn of [
      "mark_order_packed_v1(uuid,uuid,uuid,integer)",
      "order_pack_round_v1(uuid,uuid)",
    ]) {
      for (const [role, allowed] of [
        ["anon", false],
        ["authenticated", false],
        ["service_role", true],
      ] as const) {
        const r = await f.db.query<{ v: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as v`,
          [role, fn],
        );
        expect(r.rows[0]!.v).toBe(allowed);
      }
    }
  });
});
