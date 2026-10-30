/**
 * Order and Parcel workflow — service, permission and view rules.
 *
 * The SQL itself (queue membership, custody refusals, audit atomicity) is proven
 * against the real migrations in order-parcel-workflow-sql.runtime.ts. This file
 * proves what sits above it:
 *   - Mark Packed saves parcel details and shelf/bin; invalid details write
 *     nothing; packing never touches payment, hand-off or completion
 *   - Undo packing: permission, required reason, reserved reasons, principal
 *     check — all refused BEFORE any write; custody refusal is reported
 *   - Work queues: orders.read required; parcel code only for delivery.handoff;
 *     COD flagged; outstanding balance from the payment ledger
 *   - Each queue row derives one Next Action through the same function Order
 *     detail uses, so leaving and returning shows the same next step
 *
 * Run: bun test src/tests/order-parcel-workflow.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isValidStaffReason,
  normalizePackDetails,
  parcelFactOf,
  parseOrderWorkQueue,
  paymentFactOf,
  preparationFactOf,
  type OrderWorkQueueEntry,
} from "@/lib/order-work-queue";
import { deriveOrderNextAction } from "@/lib/order-next-action";
import { principalOf } from "./helpers/refuse-only-principal";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

function ctx(permissions: string[] = ["orders.read", "delivery.handoff"]) {
  const perms = new Set(permissions);
  return {
    organizationId: ORG,
    userId: USER,
    can: (p: string) => perms.has(p),
    require(p: string) {
      if (!perms.has(p)) {
        const err = new Error(`Missing permission: ${p}`);
        (err as any).statusCode = 403;
        throw err;
      }
    },
  } as any;
}

// ── A fake service-role client: every RPC and table read is answered here ────

let rpcCalls: { fn: string; args: any }[] = [];
let rpcAnswers: Record<string, (args: any) => any> = {};
let tables: Record<string, any[]> = {};

function chain(rows: any[]) {
  const eqs: Record<string, any> = {};
  const ins: Record<string, any[]> = {};
  const out = () =>
    rows.filter(
      (r) =>
        Object.entries(eqs).every(([c, v]) => r[c] === v) &&
        Object.entries(ins).every(([c, v]) => v.includes(r[c])),
    );
  const c: any = {
    select: () => c,
    eq: (col: string, v: any) => ((eqs[col] = v), c),
    neq: () => c,
    in: (col: string, v: any[]) => ((ins[col] = v), c),
    order: () => c,
    limit: () => c,
    single: () => {
      const r = out();
      return r.length
        ? { data: r[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "no row" } };
    },
    maybeSingle: () => ({ data: out()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: out(), error: null }),
  };
  return c;
}

const fakeDb = {
  from: (t: string) => chain(tables[t] ?? []),
  rpc(fn: string, args: any) {
    rpcCalls.push({ fn, args });
    const answer = rpcAnswers[fn];
    return { data: answer ? answer(args) : { status: "success" }, error: null };
  },
};

const restores: Array<() => void> = [];
beforeEach(async () => {
  rpcCalls = [];
  rpcAnswers = {};
  tables = {
    orders: [
      {
        id: ORDER,
        organization_id: ORG,
        order_number: "APSA-1",
        lifecycle_status: "confirmed",
        payment_status: "unpaid",
        fulfillment_status: "unfulfilled",
      },
    ],
    order_items: [{ id: "item-1", organization_id: ORG, order_id: ORDER, quantity: 2 }],
    parcels: [
      {
        id: "parcel-1",
        organization_id: ORG,
        order_id: ORDER,
        parcel_code: "APSA-PARCEL-0000000001",
        status: "created",
      },
    ],
    deliveries: [],
    parcel_pack_records: [],
    customers: [],
    order_payment_totals: [],
  };
  restores.push(
    (await import("../server/orders/repository")).setOrderRepositoryDbForTests(fakeDb),
    (await import("../server/parcels/repository")).setParcelRepositoryDbForTests(fakeDb),
    (await import("../server/deliveries/repository")).setDeliveryRepositoryDbForTests(fakeDb),
    (await import("../server/fulfillment/repository")).setFulfillmentRepositoryDbForTests(fakeDb),
  );
});
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const LINES = [{ orderItemId: "item-1", quantity: 2 }];
const writes = () => rpcCalls.filter((c) => c.fn !== "order_currently_packed_v1");

describe("Mark Packed saves parcel details", () => {
  it("records count, weight and shelf before the packed marker, and nothing about payment", async () => {
    rpcAnswers.order_currently_packed_v1 = () => false;
    const { markOrderPacked } = await import("../server/packing/service");
    const c = ctx();
    const result = await markOrderPacked(c, ORDER, LINES, principalOf(c), {
      packageCount: 2,
      weightGrams: 900,
      storageLocation: "  Shelf B-2 ",
    });
    expect(result).toEqual({ kind: "packed", deliveryId: null });
    expect(writes().map((w) => w.fn)).toEqual([
      "record_parcel_pack_details_v1",
      "record_order_packed_v1",
    ]);
    expect(writes()[0]!.args).toEqual({
      p_organization_id: ORG,
      p_order_id: ORDER,
      p_recorded_by: USER,
      p_package_count: 2,
      p_weight_grams: 900,
      p_storage_location: "Shelf B-2",
    });
    // No payment, delivery, hand-off or lifecycle write of any kind.
    for (const w of writes()) {
      expect(w.fn).not.toMatch(/payment|delivery|handoff|transition_order_status/);
    }
  });

  it("invalid details are refused before any write", async () => {
    const { markOrderPacked } = await import("../server/packing/service");
    const c = ctx();
    for (const bad of [
      { packageCount: 0, weightGrams: null, storageLocation: null },
      { packageCount: 1.5, weightGrams: null, storageLocation: null },
      { packageCount: 1, weightGrams: -1, storageLocation: null },
      { packageCount: 1, weightGrams: null, storageLocation: "x".repeat(41) },
    ]) {
      expect(await markOrderPacked(c, ORDER, LINES, principalOf(c), bad)).toEqual({
        kind: "invalid_details",
      });
    }
    expect(writes()).toEqual([]);
  });

  it("an order already packed keeps its first record (no duplicate details)", async () => {
    rpcAnswers.order_currently_packed_v1 = () => true;
    const { markOrderPacked } = await import("../server/packing/service");
    const c = ctx();
    expect((await markOrderPacked(c, ORDER, LINES, principalOf(c))).kind).toBe("already_packed");
    expect(writes()).toEqual([]);
  });

  it("pack state shows details only while packed, and says when the parcel is handed off", async () => {
    tables.parcel_pack_records = [
      {
        organization_id: ORG,
        order_id: ORDER,
        package_count: 3,
        weight_grams: null,
        storage_location: "Bin 4",
        recorded_at: "2026-10-01T00:00:00Z",
      },
    ];
    const { getOrderPackState } = await import("../server/packing/service");
    rpcAnswers.order_currently_packed_v1 = () => true;
    expect(await getOrderPackState(ctx(["orders.read"]), ORDER)).toEqual({
      packed: true,
      parcelCode: null, // no delivery.handoff → no code
      packDetails: {
        packageCount: 3,
        weightGrams: null,
        storageLocation: "Bin 4",
        recordedAt: "2026-10-01T00:00:00Z",
      },
      handedOff: false,
    });
    rpcAnswers.order_currently_packed_v1 = () => false;
    expect((await getOrderPackState(ctx(), ORDER))?.packDetails).toBeNull();

    tables.orders[0].fulfillment_status = "processing";
    tables.deliveries = [{ id: "d1", organization_id: ORG, order_id: ORDER, status: "in_transit" }];
    expect((await getOrderPackState(ctx(), ORDER))?.handedOff).toBe(true);
  });
});

describe("Undo packing", () => {
  it("requires delivery.handoff — refused before any write", async () => {
    const { undoOrderPacking } = await import("../server/packing/service");
    const c = ctx(["orders.read", "orders.update"]);
    await expect(undoOrderPacking(c, ORDER, "Wrong items", principalOf(c))).rejects.toThrow(
      /delivery.handoff/,
    );
    expect(rpcCalls).toEqual([]);
  });

  it("requires a reason, and a reserved system reason is not one", async () => {
    const { undoOrderPacking } = await import("../server/packing/service");
    const c = ctx();
    for (const reason of ["", "  ", "ab", "pack_order_packed", "system:packing_undone"]) {
      expect(await undoOrderPacking(c, ORDER, reason, principalOf(c))).toEqual({
        kind: "reason_required",
      });
    }
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a request started as another member before anything else", async () => {
    const { undoOrderPacking } = await import("../server/packing/service");
    await expect(
      undoOrderPacking(ctx(), ORDER, "Wrong items", {
        userId: "44444444-4444-4444-8444-444444444444",
        organizationId: ORG,
      }),
    ).rejects.toThrow(/changed/);
    expect(rpcCalls).toEqual([]);
  });

  it("sends the trimmed reason and the server-derived actor; reports success", async () => {
    rpcAnswers.undo_order_packing_v1 = () => ({ status: "success", cancelled_delivery_id: "d1" });
    const { undoOrderPacking } = await import("../server/packing/service");
    const c = ctx();
    expect(await undoOrderPacking(c, ORDER, "  Wrong size  ", principalOf(c))).toEqual({
      kind: "undone",
      cancelledDeliveryId: "d1",
    });
    expect(rpcCalls).toEqual([
      {
        fn: "undo_order_packing_v1",
        args: {
          p_organization_id: ORG,
          p_order_id: ORDER,
          p_changed_by: USER,
          p_reason: "Wrong size",
        },
      },
    ]);
  });

  it("reports courier custody and other refusals without retrying them", async () => {
    const { undoOrderPacking } = await import("../server/packing/service");
    const c = ctx();
    for (const [status, kind] of [
      ["handed_off", "handed_off"],
      ["not_packed", "not_packed"],
      ["order_terminal", "invalid_order"],
      ["not_found", "invalid_order"],
    ] as const) {
      rpcCalls = [];
      rpcAnswers.undo_order_packing_v1 = () => ({ status });
      expect(await undoOrderPacking(c, ORDER, "Wrong size", principalOf(c))).toEqual({ kind });
      expect(rpcCalls).toHaveLength(1);
    }
  });

  it("re-runs a concurrent-change 'retry' at most three times", async () => {
    rpcAnswers.undo_order_packing_v1 = () => ({ status: "retry" });
    const { undoOrderPacking } = await import("../server/packing/service");
    const c = ctx();
    expect(await undoOrderPacking(c, ORDER, "Wrong size", principalOf(c))).toEqual({
      kind: "retry",
    });
    expect(rpcCalls).toHaveLength(3);
  });
});

describe("Work queues", () => {
  const rpcRow = (over: Record<string, unknown> = {}) => ({
    order_id: ORDER,
    order_number: "APSA-1",
    created_at: "2026-10-01T00:00:00Z",
    currency: "USD",
    total_minor: 2500,
    customer_id: null,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    refund_status: "none",
    fulfillment_status: "processing",
    packed: true,
    active_delivery_id: "d1",
    active_delivery_status: "ready",
    latest_delivery_status: "ready",
    any_delivered: false,
    cod_amount_minor: 2500,
    parcel_code: "APSA-PARCEL-0000000001",
    package_count: 1,
    weight_grams: null,
    storage_location: "A-1",
    packed_recorded_at: "2026-10-01T01:00:00Z",
    ...over,
  });

  it("requires orders.read", async () => {
    const { listOrderWorkQueue } = await import("../server/orders/work-queue");
    await expect(listOrderWorkQueue(ctx([]), "payment_due")).rejects.toThrow(/orders.read/);
    expect(rpcCalls).toEqual([]);
  });

  it("passes the server org and the queue; never a client org", async () => {
    rpcAnswers.list_order_work_queue_v1 = () => [];
    const { listOrderWorkQueue } = await import("../server/orders/work-queue");
    await listOrderWorkQueue(ctx(), "awaiting_handoff");
    expect(rpcCalls[0]).toEqual({
      fn: "list_order_work_queue_v1",
      args: { p_organization_id: ORG, p_queue: "awaiting_handoff", p_limit: 100 },
    });
  });

  it("maps rows: COD flagged, outstanding balance from the ledger, shelf shown, code gated", async () => {
    rpcAnswers.list_order_work_queue_v1 = () => [rpcRow()];
    tables.order_payment_totals = [
      { organization_id: ORG, order_id: ORDER, total_minor: 2500, net_minor: 1000 },
    ];
    const { listOrderWorkQueue } = await import("../server/orders/work-queue");
    const [withCode] = await listOrderWorkQueue(ctx(), "awaiting_handoff");
    expect(withCode).toMatchObject({
      cod: true,
      due: { amount: 1500, currency: "USD" },
      parcelCode: "APSA-PARCEL-0000000001",
      packDetails: { packageCount: 1, storageLocation: "A-1" },
    });
    const [withoutCode] = await listOrderWorkQueue(ctx(["orders.read"]), "awaiting_handoff");
    expect(withoutCode!.parcelCode).toBeNull();
  });

  it("an unpacked row never carries pack details", async () => {
    rpcAnswers.list_order_work_queue_v1 = () => [
      rpcRow({ packed: false, package_count: null, packed_recorded_at: null }),
    ];
    const { listOrderWorkQueue } = await import("../server/orders/work-queue");
    const [row] = await listOrderWorkQueue(ctx(), "not_prepared");
    expect(row!.packDetails).toBeNull();
  });
});

describe("Row facts and the one Next Action", () => {
  const base: OrderWorkQueueEntry = {
    orderId: ORDER,
    orderNumber: "APSA-1",
    createdAt: "2026-10-01T00:00:00Z",
    customerName: null,
    currency: "USD",
    total: { amount: 100, currency: "USD" },
    due: { amount: 100, currency: "USD" },
    lifecycleStatus: "confirmed",
    paymentStatus: "unpaid",
    refundStatus: "none",
    fulfillmentStatus: "unfulfilled",
    packed: false,
    activeDeliveryId: null,
    activeDeliveryStatus: null,
    latestDeliveryStatus: null,
    anyDelivered: false,
    cod: false,
    parcelCode: "APSA-PARCEL-0000000001",
    packDetails: null,
  };

  it("payment, preparation and parcel stay three separate facts", () => {
    expect(paymentFactOf(base)).toBe("due");
    expect(paymentFactOf({ ...base, cod: true })).toBe("cod_due");
    expect(paymentFactOf({ ...base, paymentStatus: "pending" })).toBe("review");
    expect(paymentFactOf({ ...base, paymentStatus: "failed" })).toBe("failed");
    // Packed never implies paid.
    const packed = { ...base, packed: true };
    expect(preparationFactOf(packed)).toBe("packed");
    expect(paymentFactOf(packed)).toBe("due");
    expect(parcelFactOf(packed)).toBe("waiting_for_courier");
    expect(parcelFactOf(base)).toBe("on_bench");
    expect(parcelFactOf({ ...packed, activeDeliveryStatus: "in_transit" })).toBe("with_courier");
    expect(parcelFactOf({ ...packed, fulfillmentStatus: "fulfilled" })).toBe("delivered");
  });

  const principal = { userId: USER, organizationId: ORG };
  const caps = (perms: string[]) => ({
    state: "ready" as const,
    organizationId: ORG,
    can: (k: string) => perms.includes(k),
  });
  const next = (row: OrderWorkQueueEntry, perms: string[]) =>
    deriveOrderNextAction(
      {
        id: row.orderId,
        lifecycleStatus: row.lifecycleStatus,
        paymentStatus: row.paymentStatus,
        refundStatus: row.refundStatus,
        fulfillmentStatus: row.fulfillmentStatus,
      },
      caps(perms) as any,
      {
        principal,
        dataPrincipal: principal,
        parcelMissing: false,
        deliveries: {
          latestId: null,
          latestStatus: row.latestDeliveryStatus as any,
          activeId: row.activeDeliveryId,
          activeStatus: row.activeDeliveryStatus as any,
          anyDelivered: row.anyDelivered,
          latestHasCod: row.cod,
        },
        deliveriesUnavailable: false,
        packed: row.packed,
        parcelCode: row.parcelCode,
        pendingPaymentId: null,
      },
    );

  it("not prepared → Pack; packed + ready → Courier hand-off; COD is a note, not a blocker", () => {
    const packer = ["orders.read", "delivery.handoff", "delivery.create"];
    expect(next(base, packer).primary?.id).toBe("pack_order");
    const waiting = {
      ...base,
      packed: true,
      fulfillmentStatus: "processing" as const,
      activeDeliveryId: "d1",
      activeDeliveryStatus: "ready",
      cod: true,
    };
    const action = next(waiting, packer);
    expect(action.primary?.id).toBe("courier_handoff");
    expect(action.paymentNoteKey).toBe("order.next.note.cod");
    expect(
      next({ ...waiting, activeDeliveryStatus: null, activeDeliveryId: null }, packer).primary?.id,
    ).toBe("arrange_delivery");
  });

  it("without the permission, the row says who it is waiting on instead of offering it", () => {
    expect(next(base, ["orders.read"]).status).toBe("waiting");
    expect(next(base, ["orders.read"]).primary).toBeNull();
  });
});

describe("Shared validation", () => {
  it("queue names from the URL fall back safely", () => {
    expect(parseOrderWorkQueue("payment_due")).toBe("payment_due");
    expect(parseOrderWorkQueue("drop table")).toBe("not_prepared");
    expect(parseOrderWorkQueue(undefined)).toBe("not_prepared");
  });

  it("pack details normalize the same way the database checks them", () => {
    expect(normalizePackDetails({ packageCount: 1 })).toEqual({
      packageCount: 1,
      weightGrams: null,
      storageLocation: null,
    });
    expect(
      normalizePackDetails({ packageCount: 2, storageLocation: "   " })?.storageLocation,
    ).toBeNull();
    expect(normalizePackDetails({ packageCount: 51 })).toBeNull();
    expect(normalizePackDetails({ packageCount: 1, weightGrams: 100001 })).toBeNull();
  });

  it("undo reasons need real words", () => {
    expect(isValidStaffReason("ab")).toBe(false);
    expect(isValidStaffReason("Wrong size")).toBe(true);
    expect(isValidStaffReason("x".repeat(501))).toBe(false);
  });
});

describe("Leaving and returning is navigation only", () => {
  const detail = readFileSync("src/routes/app.orders.$id.tsx", "utf8");
  const work = readFileSync("src/routes/app.orders.work.tsx", "utf8");

  it("Order detail's Back only navigates — to the work queue it came from, else the list", () => {
    const back = detail.slice(
      detail.indexOf("const back = "),
      detail.indexOf("if (query.isLoading)"),
    );
    expect(back).toContain("navigate(");
    expect(back).toContain('"/app/orders/work"');
    expect(back).not.toMatch(/mutate|Fn\(|invalidate|cancel|undo/i);
  });

  it("the work queue links to Order detail carrying the queue, and holds no mutation", () => {
    expect(work).toContain('to="/app/orders/$id"');
    expect(work).toMatch(/search=\{\{\s*queue/);
    expect(work).not.toMatch(/useMutation|markOrderPacked|undoOrderPacking|cancelRealOrder/);
  });
});

describe("Cancel and Undo confirmations require a reason and preserve payments", () => {
  const cancel = readFileSync("src/components/orders/CancelOrderSheet.tsx", "utf8");
  const undo = readFileSync("src/components/fulfillment/PackedParcelPanel.tsx", "utf8");

  it("Cancel cannot be confirmed without a reason, offers Keep order, and says money is kept", () => {
    expect(cancel).toContain("disabled={pending || !reasonOk}");
    expect(cancel).toContain('t("order.cancelSheet.keep")');
    expect(cancel).toContain('t("order.cancelSheet.paymentKept")');
    expect(cancel).not.toMatch(/refundPayment|reversePayment|[A-Za-z]+Fn\(/);
  });

  it("Undo cannot be confirmed without a reason and is never offered after hand-off", () => {
    expect(undo).toContain("disabled={!reasonOk || undo.isPending}");
    const detail = readFileSync("src/routes/app.orders.$id.tsx", "utf8");
    expect(detail).toContain("packState?.handedOff === false");
  });
});
