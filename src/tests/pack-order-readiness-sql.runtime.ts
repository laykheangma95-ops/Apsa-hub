/**
 * Pack Order readiness — REAL SQL behaviour (PGlite, every migration applied).
 *
 * Executes the migration-054 functions and the re-declared
 * transition_delivery_status_v1 against Postgres and reads back the rows they
 * wrote. Proves, at the database:
 *   - one packed rule (order_currently_packed_v1) decides every '→ ready' write:
 *     auto-ready / retry (ready_packed_delivery_v1) AND the generic transition
 *   - a reopen cancels a ready delivery in the same transaction, and a
 *     replacement cannot be readied — generically or by recovery — until
 *     Pack Order runs again
 *   - a retired (cancelled) attempt keeps the packed parcel; recovery never
 *     writes the packed marker
 *
 * Limitation: PGlite is a single connection, so two transactions cannot
 * interleave here. The reopen race (a delivery created/readied between the
 * reopen's delivery lookup and its order lock) is covered by the re-read under
 * the order lock in reopen_order_fulfillment_v1 (asserted statically in
 * pack-order-v1.test.ts) and by the service-level race tests there.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
type Json = Record<string, unknown>;

let f: Fixture;
const PACKED = "pack_order_packed";

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

const packedNow = async (order: string, tenant = f.org) =>
  (
    await f.db.query<{ v: boolean }>(`select order_currently_packed_v1($1,$2) as v`, [
      tenant,
      order,
    ])
  ).rows[0]!.v;
const deliveryStatus = async (delivery: string) =>
  (
    await f.db.query<{ v: string }>(`select status::text as v from deliveries where id=$1`, [
      delivery,
    ])
  ).rows[0]!.v;
const fulfillment = async (order: string) =>
  (
    await f.db.query<{ v: string }>(
      `select fulfillment_status::text as v from orders where id=$1`,
      [order],
    )
  ).rows[0]!.v;

/** Mark Packed with no delivery: the locked marker write Pack Order uses. */
const packWithoutDelivery = (order: string) =>
  f.rpc("record_order_packed_v1", [f.org, order, f.actor]);
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
const genericMove = (delivery: string, from: string, to: string, reason: string | null = null) =>
  f.rpc("transition_delivery_status_v1", [f.org, delivery, from, to, f.actor, reason]);
const readyPacked = (order: string, delivery: string, tenant = f.org) =>
  f.rpc("ready_packed_delivery_v1", [tenant, order, delivery, f.actor]);
const reopen = (order: string, reason = "Repack needed") =>
  f.rpc("reopen_order_fulfillment_v1", [f.org, order, f.actor, reason]);

describe("one packed rule guards every '→ ready' write", () => {
  it("an order never packed: neither recovery nor the generic transition can ready it", async () => {
    const order = await confirmedOrder();
    const delivery = await arrange(order);
    expect(await packedNow(order)).toBe(false);
    expect((await readyPacked(order, delivery)).status).toBe("not_packed");
    expect((await genericMove(delivery, "pending", "preparing")).status).toBe("success");
    expect((await genericMove(delivery, "preparing", "ready")).status).toBe("not_packed");
    expect(await deliveryStatus(delivery)).toBe("preparing");
  });

  it("pack → ready → reopen → replacement → generic Ready refused → pack again → ready", async () => {
    const order = await confirmedOrder();
    expect((await packWithoutDelivery(order)).status).toBe("success");
    expect(await packedNow(order)).toBe(true);

    const first = await arrange(order);
    expect(await readyPacked(order, first)).toMatchObject({ status: "success", to: "ready" });
    expect(await deliveryStatus(first)).toBe("ready");

    // Reopen: the ready delivery is cancelled in the same transaction.
    const reopened = await reopen(order);
    expect(reopened).toMatchObject({ status: "success", cancelled_delivery_id: first });
    expect(await deliveryStatus(first)).toBe("cancelled");
    expect(await fulfillment(order)).toBe("unfulfilled");
    expect(await packedNow(order)).toBe(false);

    // Replacement: recovery and the generic "Mark ready" are both refused.
    const replacement = await arrange(order);
    expect((await readyPacked(order, replacement)).status).toBe("not_packed");
    expect((await genericMove(replacement, "pending", "preparing")).status).toBe("success");
    expect((await genericMove(replacement, "preparing", "ready")).status).toBe("not_packed");
    expect(await deliveryStatus(replacement)).toBe("preparing");

    // Pack again — Mark Packed's own marker-tagged transition — then it is ready.
    expect((await genericMove(replacement, "preparing", "ready", PACKED)).status).toBe("success");
    expect(await deliveryStatus(replacement)).toBe("ready");
    expect(await packedNow(order)).toBe(true);
  });

  it("a cancelled attempt keeps the packed parcel; recovery never writes the packed marker", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    const first = await arrange(order);
    await readyPacked(order, first);
    expect((await genericMove(first, "ready", "cancelled", "Customer moved")).status).toBe(
      "success",
    );
    expect(await fulfillment(order)).toBe("unfulfilled");
    expect(await packedNow(order)).toBe(true);

    const second = await arrange(order);
    expect((await readyPacked(order, second)).status).toBe("success");
    const reasons = (
      await f.db.query<Json>(
        `select reason from delivery_status_history where delivery_id=$1 and from_status is not null`,
        [second],
      )
    ).rows.map((r) => r.reason);
    expect(reasons).toEqual([
      "system:pack_order_delivery_ready",
      "system:pack_order_delivery_ready",
    ]);
    // The generic API on a packed order is allowed by the same rule.
    expect((await genericMove(second, "ready", "in_transit")).status).toBe("success");
  });

  it("a reopen with the delivery-sync reason text still clears packed (exemption unforgeable)", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    await reopen(order, "Delivery status: cancelled");
    expect(await packedNow(order)).toBe(false);
  });

  it("is tenant-scoped", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    const delivery = await arrange(order);
    expect(await packedNow(order, f.orgB)).toBe(false);
    expect((await readyPacked(order, delivery, f.orgB)).status).toBe("not_found");
    expect(await deliveryStatus(delivery)).toBe("pending");
  });
});

describe("reopen", () => {
  it("leaves a pending delivery in place and refuses a second reopen", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    const delivery = await arrange(order);
    expect((await reopen(order)).status).toBe("success");
    expect(await deliveryStatus(delivery)).toBe("pending");
    expect((await reopen(order)).status).toBe("stale");
  });

  it("the cancel row and the order row share one timestamp and the reopen tag", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    const delivery = await arrange(order);
    await readyPacked(order, delivery);
    await reopen(order, "Customer changed the items");
    const row = (
      await f.db.query<Json>(
        `select oh.changed_at = dh.created_at as same_ts, dh.reason as d_reason, oh.reason as o_reason
         from order_status_history oh, delivery_status_history dh
         where oh.order_id=$1 and oh.to_status='unfulfilled'
           and dh.delivery_id=$2 and dh.to_status='cancelled'`,
        [order, delivery],
      )
    ).rows[0]!;
    expect(row).toEqual({
      same_ts: true,
      d_reason: "system:order_fulfillment_reopened",
      o_reason: "Customer changed the items",
    });
  });
});

describe("privileges", () => {
  it("only service_role may execute the 054 functions", async () => {
    for (const signature of [
      "order_currently_packed_v1(uuid,uuid)",
      "reopen_order_fulfillment_v1(uuid,uuid,uuid,text)",
      "ready_packed_delivery_v1(uuid,uuid,uuid,uuid)",
      "transition_delivery_status_v1(uuid,uuid,text,text,uuid,text)",
    ]) {
      const row = (
        await f.db.query<Json>(
          `select has_function_privilege('anon','public.${signature}','EXECUTE') as anon,
                  has_function_privilege('authenticated','public.${signature}','EXECUTE') as auth,
                  has_function_privilege('service_role','public.${signature}','EXECUTE') as svc`,
        )
      ).rows[0]!;
      expect(row).toEqual({ anon: false, auth: false, svc: true });
    }
  });
});

// ── Timestamp ordering: a Mark Packed that waited behind a reopen ───────────
//
// In production the reopen holds the order lock, Mark Packed waits for it, and
// Mark Packed commits LATER — but its transaction STARTED earlier. PGlite is a
// single connection, so the wait itself cannot be staged; the timestamp effect
// can, exactly: BEGIN fixes the packing transaction's start time (what now()
// and every DEFAULT now() column return), the reopen then runs and is stamped
// later, and the pack writes after it in the same, earlier-started
// transaction. With transaction-start stamping the marker lands BEFORE the
// reopen and the order reads as not packed despite the successful repack.

type Tx = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function rpcIn(tx: Tx, name: string, args: unknown[]) {
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  return (await tx.query<{ r: Json }>(`select ${name}(${params}) as r`, args)).rows[0]!.r;
}

/** One transaction that starts BEFORE the reopen and packs AFTER it. */
async function packWaitingBehindReopen(
  order: string,
  pack: (tx: Tx) => Promise<void>,
): Promise<{ startedAt: string }> {
  return f.db.transaction(async (tx: Tx) => {
    const startedAt = (await tx.query<{ t: string }>(`select now()::text as t`)).rows[0]!.t;
    // The reopen holds the order lock and commits first …
    const reopened = await rpcIn(tx, "reopen_order_fulfillment_v1", [
      f.org,
      order,
      f.actor,
      "Redo",
    ]);
    expect(reopened.status).toBe("success");
    // … then the pack that was waiting for it writes and commits.
    await pack(tx);
    return { startedAt };
  });
}

const fulfillmentRows = async (order: string) =>
  (
    await f.db.query<{ to_status: string; reason: string | null; at: string }>(
      `select to_status, reason, changed_at::text as at from order_status_history
       where order_id=$1 and axis='fulfillment' order by changed_at, id`,
      [order],
    )
  ).rows;

describe("timestamp ordering: pack waits behind reopen, commits later", () => {
  it("no delivery: the repack is ordered after the reopen → packed, then auto-ready succeeds", async () => {
    const order = await confirmedOrder();
    expect((await packWithoutDelivery(order)).status).toBe("success");

    const { startedAt } = await packWaitingBehindReopen(order, async (tx) => {
      const packed = await rpcIn(tx, "record_order_packed_v1", [f.org, order, f.actor]);
      expect(packed.status).toBe("success");
    });

    const rows = await fulfillmentRows(order);
    const reopenRow = rows.find((r) => r.to_status === "unfulfilled" && r.reason === "Redo")!;
    const lastMarker = rows.filter((r) => r.reason === PACKED).at(-1)!;
    // The pack's transaction started before the reopen, yet its marker is later.
    expect(Date.parse(reopenRow.at)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    expect(await isAfter(lastMarker.at, reopenRow.at)).toBe(true);
    expect(await packedNow(order)).toBe(true);

    // Replacement delivery: Arrange Delivery's auto-ready succeeds.
    const replacement = await arrange(order);
    expect((await readyPacked(order, replacement)).status).toBe("success");
    expect(await deliveryStatus(replacement)).toBe("ready");
  });

  it("with a delivery: Mark Packed's marker-tagged steps are ordered after the reopen → packed and ready", async () => {
    const order = await confirmedOrder();
    const delivery = await arrange(order);

    await packWaitingBehindReopen(order, async (tx) => {
      for (const [from, to] of [
        ["pending", "preparing"],
        ["preparing", "ready"],
      ]) {
        const moved = await rpcIn(tx, "transition_delivery_status_v1", [
          f.org,
          delivery,
          from,
          to,
          f.actor,
          PACKED,
        ]);
        expect(moved.status).toBe("success");
      }
    });

    expect(await deliveryStatus(delivery)).toBe("ready");
    expect(await packedNow(order)).toBe(true);
    const reopenAt = (await fulfillmentRows(order)).find((r) => r.reason === "Redo")!.at;
    const markers = (
      await f.db.query<{ at: string }>(
        `select created_at::text as at from delivery_status_history
         where delivery_id=$1 and reason=$2 order by created_at`,
        [delivery, PACKED],
      )
    ).rows;
    expect(markers).toHaveLength(2);
    for (const m of markers) expect(await isAfter(m.at, reopenAt)).toBe(true);

    // Retry ready on a replacement left preparing: succeeds on the repacked order.
    expect((await genericMove(delivery, "ready", "cancelled", "Courier no-show")).status).toBe(
      "success",
    );
    const replacement = await arrange(order);
    expect((await genericMove(replacement, "pending", "preparing")).status).toBe("success");
    expect((await readyPacked(order, replacement)).status).toBe("success");
    expect(await deliveryStatus(replacement)).toBe("ready");
  });

  it("why the dedicated write exists: the generic order transition stamps transaction START", async () => {
    // The pre-fix path — Mark Packed through transition_order_status_v1 — in the
    // same waiting transaction: its marker lands before the reopen and the order
    // reads as NOT packed. Pack Order no longer writes its marker this way.
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    await packWaitingBehindReopen(order, async (tx) => {
      const r = await rpcIn(tx, "transition_order_status_v1", [
        f.org,
        order,
        "fulfillment",
        "unfulfilled",
        "processing",
        f.actor,
        PACKED,
      ]);
      expect(r.status).toBe("success");
    });
    expect(await packedNow(order)).toBe(false);
  });

  it("no inversion even when the clock is behind the order's history (+1µs, never backwards)", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    // A history row stamped an hour in the future (clock skew between writers).
    const future = (
      await f.db.query<{ t: string }>(
        `insert into order_status_history(organization_id,order_id,axis,from_status,to_status,changed_by,reason,changed_at)
         values($1,$2,'payment','unpaid','unpaid_probe',$3,'skew probe', now() + interval '1 hour')
         returning changed_at::text as t`,
        [f.org, order, f.actor],
      )
    ).rows[0]!.t;
    expect((await reopen(order)).status).toBe("success");
    expect((await packWithoutDelivery(order)).status).toBe("success");
    const rows = await fulfillmentRows(order);
    const reopenRow = rows.find((r) => r.reason === "Repack needed")!;
    const lastMarker = rows.filter((r) => r.reason === PACKED).at(-1)!;
    expect(await isAfter(reopenRow.at, future)).toBe(true);
    expect(await isAfter(lastMarker.at, reopenRow.at)).toBe(true);
    expect(await packedNow(order)).toBe(true);
  });

  it("paired rows of one event share a time; steps of one operation are 1µs apart", async () => {
    const order = await confirmedOrder();
    await packWithoutDelivery(order);
    const delivery = await arrange(order);
    expect((await genericMove(delivery, "pending", "cancelled", "Customer moved")).status).toBe(
      "success",
    );
    // The delivery's cancelled row and the order row it drove: one event, one time.
    const paired = (
      await f.db.query<Json>(
        `select oh.changed_at = dh.created_at as same
         from order_status_history oh, delivery_status_history dh
         where oh.order_id=$1 and oh.reason='Delivery status: cancelled'
           and dh.delivery_id=$2 and dh.to_status='cancelled'`,
        [order, delivery],
      )
    ).rows[0]!;
    expect(paired.same).toBe(true);
    expect(await packedNow(order)).toBe(true);

    // Recovery on a pending delivery: pending → preparing, then ready 1µs later.
    const second = await arrange(order);
    expect((await readyPacked(order, second)).status).toBe("success");
    const steps = (
      await f.db.query<{ to_status: string; at: string }>(
        `select to_status::text, created_at::text as at from delivery_status_history
         where delivery_id=$1 and from_status is not null order by created_at`,
        [second],
      )
    ).rows;
    expect(steps.map((s) => s.to_status)).toEqual(["preparing", "ready"]);
    const gap = (
      await f.db.query<{ us: number }>(
        `select (extract(epoch from ($2::timestamptz - $1::timestamptz)) * 1000000)::int as us`,
        [steps[0]!.at, steps[1]!.at],
      )
    ).rows[0]!.us;
    expect(gap).toBe(1);
  });
});

/** Strict timestamptz comparison in SQL (text forms are not always comparable). */
async function isAfter(later: string, earlier: string): Promise<boolean> {
  return (
    await f.db.query<{ v: boolean }>(`select $1::timestamptz > $2::timestamptz as v`, [
      later,
      earlier,
    ])
  ).rows[0]!.v;
}
