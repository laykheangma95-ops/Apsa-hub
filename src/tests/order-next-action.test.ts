/**
 * Order detail Smart Next Action — pure derivation (src/lib/order-next-action.ts).
 *
 * Every action it returns must (a) be backed by an existing server path, (b)
 * be permitted by the capability snapshot, (c) be a valid transition from the
 * order's current axes, and (d) belong to the route's principal. These tests
 * pin each of those across the order's lifecycle, plus the audit's mitigation:
 * Cancel is never offered once the goods have left the shop.
 */
import { describe, expect, it } from "bun:test";
import {
  createCapabilityView,
  UI_PERMISSION_KEYS,
  type CapabilityView,
  type UiPermissionKey,
} from "@/lib/capabilities";
import {
  deriveOrderNextAction,
  type NextActionContext,
  type NextActionDeliveries,
  type NextActionOrder,
  type OrderNextAction,
} from "@/lib/order-next-action";
import { LIFECYCLE_TRANSITIONS } from "@/server/orders/state-machine";

const A = { userId: "user-a", organizationId: "org-a" };
const B = { userId: "user-b", organizationId: "org-b" };

function capsFor(
  permissions: readonly UiPermissionKey[],
  principal = A,
  snapshotPrincipal = principal,
): CapabilityView {
  return createCapabilityView({
    result: {
      status: "active",
      userId: snapshotPrincipal.userId,
      organizationId: snapshotPrincipal.organizationId,
      role: null,
      permissions: [...permissions],
    },
    isPending: false,
    isError: false,
    expectedUserId: principal.userId,
    expectedOrganizationId: principal.organizationId,
  });
}

const OWNER = capsFor(UI_PERMISSION_KEYS);
/** A counter cashier: reads orders and records payments, nothing else here. */
const CASHIER = capsFor(["orders.read", "orders.create", "payments.read", "payments.record"]);

function order(overrides: Partial<NextActionOrder> = {}): NextActionOrder {
  return {
    id: "order-1",
    lifecycleStatus: "confirmed",
    paymentStatus: "unpaid",
    refundStatus: "none",
    fulfillmentStatus: "unfulfilled",
    ...overrides,
  };
}

const NO_DELIVERY: NextActionDeliveries = {
  latestId: null,
  latestStatus: null,
  activeId: null,
  activeStatus: null,
  anyDelivered: false,
  latestHasCod: false,
};

function delivery(
  status: NonNullable<NextActionDeliveries["latestStatus"]>,
  extra: Partial<NextActionDeliveries> = {},
): NextActionDeliveries {
  const active = !["delivered", "failed", "cancelled"].includes(status);
  return {
    latestId: "delivery-1",
    latestStatus: status,
    activeId: active ? "delivery-1" : null,
    activeStatus: active ? status : null,
    anyDelivered: status === "delivered",
    latestHasCod: false,
    ...extra,
  };
}

function ctx(overrides: Partial<NextActionContext> = {}): NextActionContext {
  return {
    principal: A,
    dataPrincipal: A,
    parcelMissing: false,
    deliveries: NO_DELIVERY,
    deliveriesUnavailable: false,
    packed: false,
    parcelCode: "APSA:PCL:v1:abc",
    pendingPaymentId: null,
    ...overrides,
  };
}

const ids = (next: OrderNextAction) => [
  ...(next.primary ? [next.primary.id] : []),
  ...next.secondary.map((item) => item.id),
];

const offersCancel = (next: OrderNextAction) =>
  next.secondary.some((item) => item.id === "cancel_order");

describe("draft", () => {
  it("offers Confirm (and Cancel) to a member who may", () => {
    const next = deriveOrderNextAction(order({ lifecycleStatus: "draft" }), OWNER, ctx());
    expect(next.status).toBe("available");
    expect(next.primary).toEqual({ id: "confirm_order", destination: null });
    expect(offersCancel(next)).toBe(true);
    expect(next.steps.map((s) => [s.key, s.state])).toEqual([
      ["order", "current"],
      ["payment", "upcoming"],
      ["packing", "upcoming"],
      ["handoff", "upcoming"],
    ]);
  });

  it("restricted staff: no Confirm, no Cancel, and says who can", () => {
    const next = deriveOrderNextAction(order({ lifecycleStatus: "draft" }), CASHIER, ctx());
    expect(next.status).toBe("waiting");
    expect(ids(next)).toEqual([]);
    expect(next.reasonKey).toBe("order.next.reason.draftNoPermission");
  });
});

describe("confirmed — payment and packing are independent", () => {
  it("unpaid, not packed: Pack is next; packing never waits for money", () => {
    const next = deriveOrderNextAction(order(), OWNER, ctx());
    expect(next.primary).toEqual({
      id: "pack_order",
      destination: { to: "/app/pack/$orderId", params: { orderId: "order-1" } },
    });
    expect(next.reasonKey).toBe("order.next.reason.readyToPack");
    expect(next.paymentNoteKey).toBe("order.next.note.paymentOutstanding");
    expect(next.steps.find((s) => s.key === "payment")?.state).toBe("current");
  });

  it("paid, not packed: Pack is next, no payment note", () => {
    const next = deriveOrderNextAction(order({ paymentStatus: "paid" }), OWNER, ctx());
    expect(next.primary?.id).toBe("pack_order");
    expect(next.paymentNoteKey).toBeNull();
    expect(next.steps.find((s) => s.key === "payment")?.state).toBe("done");
  });

  it("partially paid (a pending claim) is not paid: the note says it awaits confirmation", () => {
    const next = deriveOrderNextAction(order({ paymentStatus: "pending" }), OWNER, ctx());
    expect(next.primary?.id).toBe("pack_order");
    expect(next.paymentNoteKey).toBe("order.next.note.paymentPending");
    expect(next.steps.find((s) => s.key === "payment")?.detailKey).toBe(
      "order.next.step.paymentPending",
    );
  });

  it("COD: packing proceeds and the note says the courier collects", () => {
    const next = deriveOrderNextAction(
      order(),
      OWNER,
      ctx({ packed: true, deliveries: delivery("ready", { latestHasCod: true }) }),
    );
    expect(next.primary?.id).toBe("courier_handoff");
    expect(next.paymentNoteKey).toBe("order.next.note.cod");
    expect(next.steps.find((s) => s.key === "payment")?.detailKey).toBe(
      "order.next.step.paymentCod",
    );
  });

  it("Pack needs orders.read AND delivery.handoff (markOrderPacked's own requirement)", () => {
    const next = deriveOrderNextAction(order(), CASHIER, ctx());
    expect(next.primary).toBeNull();
    expect(next.status).toBe("waiting");
    expect(next.reasonKey).toBe("order.next.reason.readyToPackNoPermission");
  });

  it("packed, no delivery: Arrange delivery (delivery.create)", () => {
    const next = deriveOrderNextAction(order(), OWNER, ctx({ packed: true }));
    expect(next.primary).toEqual({ id: "arrange_delivery", destination: null });
    expect(next.reasonKey).toBe("order.next.reason.packedNoDelivery");
    expect(next.steps.find((s) => s.key === "packing")?.state).toBe("done");
    expect(next.steps.find((s) => s.key === "handoff")?.state).toBe("current");
  });

  it("packed, no delivery, without delivery.create: nothing executable", () => {
    const caps = capsFor(UI_PERMISSION_KEYS.filter((k) => k !== "delivery.create"));
    const next = deriveOrderNextAction(order(), caps, ctx({ packed: true }));
    expect(next.primary).toBeNull();
    expect(next.reasonKey).toBe("order.next.reason.packedNoDeliveryNoPermission");
  });

  it("ready for courier: Hand to courier, only with a parcel code", () => {
    const ready = ctx({ packed: true, deliveries: delivery("ready") });
    expect(deriveOrderNextAction(order(), OWNER, ready).primary).toEqual({
      id: "courier_handoff",
      destination: { to: "/app/handoff/$parcelCode", params: { parcelCode: "APSA:PCL:v1:abc" } },
    });
    const noCode = deriveOrderNextAction(order(), OWNER, { ...ready, parcelCode: null });
    expect(noCode.primary).toBeNull();
    expect(noCode.status).toBe("waiting");
  });

  it("packed but delivery still pending: blocked, pointing at the existing retry", () => {
    const next = deriveOrderNextAction(
      order({ fulfillmentStatus: "processing" }),
      OWNER,
      ctx({ packed: true, deliveries: delivery("pending") }),
    );
    expect(next.status).toBe("blocked");
    expect(next.primary).toBeNull();
    expect(next.reasonKey).toBe("order.next.reason.deliveryNotReady");
  });

  it("in transit: Open delivery for a member who records outcomes; never Cancel", () => {
    const next = deriveOrderNextAction(
      order({ fulfillmentStatus: "processing" }),
      OWNER,
      ctx({ packed: true, deliveries: delivery("in_transit") }),
    );
    expect(next.primary).toEqual({
      id: "track_delivery",
      destination: { to: "/app/deliveries/$id", params: { id: "delivery-1" } },
    });
    expect(offersCancel(next)).toBe(false);
    expect(next.steps.find((s) => s.key === "handoff")?.detailKey).toBe(
      "order.next.step.inTransit",
    );
  });

  it("in transit without delivery.update: waiting, read-only link at most", () => {
    const caps = capsFor(["orders.read", "orders.cancel", "delivery.read"]);
    const next = deriveOrderNextAction(
      order({ fulfillmentStatus: "processing" }),
      caps,
      ctx({ packed: true, deliveries: delivery("in_transit") }),
    );
    expect(next.status).toBe("waiting");
    expect(next.primary).toBeNull();
    expect(ids(next)).toEqual(["track_delivery"]);
  });

  it("failed delivery: Arrange a new delivery; Cancel still allowed (goods came back)", () => {
    const next = deriveOrderNextAction(
      order(),
      OWNER,
      ctx({ packed: true, deliveries: delivery("failed") }),
    );
    expect(next.primary?.id).toBe("arrange_delivery");
    expect(next.reasonKey).toBe("order.next.reason.deliveryFailed");
    expect(offersCancel(next)).toBe(true);
  });

  it("parcel missing: blocked, no action (the recovery card handles it)", () => {
    const next = deriveOrderNextAction(order(), OWNER, ctx({ parcelMissing: true }));
    expect(next.status).toBe("blocked");
    expect(next.primary).toBeNull();
    expect(next.reasonKey).toBe("order.next.reason.parcelMissing");
  });
});

describe("delivered / fulfilled", () => {
  const delivered = ctx({ packed: false, deliveries: delivery("delivered") });

  it("paid + fulfilled: Complete order (orders.update) — the server path that exists", () => {
    const next = deriveOrderNextAction(
      order({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
      OWNER,
      delivered,
    );
    expect(next.primary).toEqual({ id: "complete_order", destination: null });
    expect(LIFECYCLE_TRANSITIONS.confirmed).toContain("completed");
    expect(next.steps.every((s) => s.state === "done" || s.key === "order")).toBe(true);
  });

  it("paid + fulfilled without orders.update: waiting for a manager", () => {
    const caps = capsFor(UI_PERMISSION_KEYS.filter((k) => k !== "orders.update"));
    const next = deriveOrderNextAction(
      order({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
      caps,
      delivered,
    );
    expect(next.primary).toBeNull();
    expect(next.reasonKey).toBe("order.next.reason.readyToCompleteNoPermission");
  });

  it("COD delivered but unpaid: Record payment, never Complete", () => {
    const next = deriveOrderNextAction(
      order({ fulfillmentStatus: "fulfilled" }),
      OWNER,
      ctx({ deliveries: delivery("delivered", { latestHasCod: true }) }),
    );
    expect(next.primary).toEqual({ id: "record_payment", destination: null });
    expect(ids(next)).not.toContain("complete_order");
  });

  it("delivered with a pending payment: Confirm payment opens that payment", () => {
    const next = deriveOrderNextAction(
      order({ paymentStatus: "pending", fulfillmentStatus: "fulfilled" }),
      OWNER,
      { ...delivered, pendingPaymentId: "pay-9" },
    );
    expect(next.primary).toEqual({
      id: "review_payment",
      destination: { to: "/app/payments/$id", params: { id: "pay-9" } },
    });
  });

  it("never offers Cancel once fulfilled (the server would restock handed-over goods)", () => {
    for (const paymentStatus of ["unpaid", "pending", "paid"] as const) {
      const next = deriveOrderNextAction(
        order({ paymentStatus, fulfillmentStatus: "fulfilled" }),
        OWNER,
        delivered,
      );
      expect(offersCancel(next)).toBe(false);
    }
  });
});

describe("terminal lifecycles", () => {
  it("completed: nothing executable; a return only for a delivered order and orders.return", () => {
    const done = order({
      lifecycleStatus: "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
    });
    const delivered = deriveOrderNextAction(
      done,
      OWNER,
      ctx({ deliveries: delivery("delivered") }),
    );
    expect(delivered.status).toBe("completed");
    expect(delivered.primary).toBeNull();
    expect(ids(delivered)).toEqual(["start_return"]);

    // Counter / pickup (no delivered delivery): returns are a server limitation.
    const counter = deriveOrderNextAction(done, OWNER, ctx());
    expect(ids(counter)).toEqual([]);

    const noReturn = capsFor(UI_PERMISSION_KEYS.filter((k) => k !== "orders.return"));
    expect(
      ids(deriveOrderNextAction(done, noReturn, ctx({ deliveries: delivery("delivered") }))),
    ).toEqual([]);
  });

  it("completed + refunded: says so, payment axis stays paid", () => {
    const next = deriveOrderNextAction(
      order({
        lifecycleStatus: "completed",
        paymentStatus: "paid",
        refundStatus: "full",
        fulfillmentStatus: "fulfilled",
      }),
      OWNER,
      ctx(),
    );
    expect(next.reasonKey).toBe("order.next.reason.completedRefunded");
    expect(next.steps.find((s) => s.key === "payment")?.state).toBe("done");
    expect(
      deriveOrderNextAction(
        order({ lifecycleStatus: "completed", paymentStatus: "paid", refundStatus: "partial" }),
        OWNER,
        ctx(),
      ).reasonKey,
    ).toBe("order.next.reason.completedPartRefunded");
  });

  it("cancelled: closed, no actions; paid-and-not-refunded points to Payments", () => {
    const plain = deriveOrderNextAction(
      order({ lifecycleStatus: "cancelled", fulfillmentStatus: "cancelled" }),
      OWNER,
      ctx(),
    );
    expect(plain.status).toBe("closed");
    expect(ids(plain)).toEqual([]);
    expect(plain.steps.filter((s) => s.state === "cancelled").length).toBeGreaterThan(0);

    const paid = deriveOrderNextAction(
      order({
        lifecycleStatus: "cancelled",
        paymentStatus: "paid",
        fulfillmentStatus: "cancelled",
      }),
      OWNER,
      ctx(),
    );
    expect(paid.reasonKey).toBe("order.next.reason.cancelledPaid");
    expect(ids(paid)).toEqual(["open_payments"]);

    const refunded = deriveOrderNextAction(
      order({
        lifecycleStatus: "cancelled",
        paymentStatus: "paid",
        refundStatus: "full",
        fulfillmentStatus: "cancelled",
      }),
      OWNER,
      ctx(),
    );
    expect(refunded.reasonKey).toBe("order.next.reason.cancelled");
  });
});

describe("Cancel is offered only while the goods are provably in the shop", () => {
  it("not while the deliveries read is outstanding", () => {
    const next = deriveOrderNextAction(order(), OWNER, ctx({ deliveries: null }));
    expect(next.status).toBe("loading");
    expect(offersCancel(next)).toBe(false);
  });

  it("not when any delivery was delivered, even if fulfillment was reopened", () => {
    const next = deriveOrderNextAction(
      order(),
      OWNER,
      ctx({ deliveries: { ...NO_DELIVERY, anyDelivered: true } }),
    );
    expect(offersCancel(next)).toBe(false);
  });

  it("yes for an unshipped confirmed order with orders.cancel; never without it", () => {
    expect(offersCancel(deriveOrderNextAction(order(), OWNER, ctx()))).toBe(true);
    expect(offersCancel(deriveOrderNextAction(order(), CASHIER, ctx()))).toBe(false);
  });
});

describe("principal isolation and delayed responses", () => {
  const states: NextActionOrder[] = [
    order({ lifecycleStatus: "draft" }),
    order(),
    order({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
  ];

  it("order data read for another principal offers nothing (A → B with A's late response)", () => {
    for (const o of states) {
      const next = deriveOrderNextAction(
        o,
        capsFor(UI_PERMISSION_KEYS, B),
        ctx({ principal: B, dataPrincipal: A }),
      );
      expect(next.status).toBe("blocked");
      expect(ids(next)).toEqual([]);
    }
  });

  it("a capability snapshot for another organization grants nothing", () => {
    // The route is A; the snapshot still describes B (stale mid-switch).
    const stale = capsFor(UI_PERMISSION_KEYS, A, B);
    for (const o of states) {
      const next = deriveOrderNextAction(o, stale, ctx());
      expect(ids(next)).toEqual([]);
    }
  });

  it("a pending capability snapshot is loading, not empty-handed 'no permission'", () => {
    const pending = createCapabilityView({
      result: undefined,
      isPending: true,
      isError: false,
      expectedUserId: A.userId,
      expectedOrganizationId: A.organizationId,
    });
    const next = deriveOrderNextAction(order(), pending, ctx());
    expect(next.status).toBe("loading");
    expect(ids(next)).toEqual([]);
  });

  it("an incomplete route identity fails closed", () => {
    const empty = { userId: "", organizationId: "" };
    const next = deriveOrderNextAction(
      order(),
      OWNER,
      ctx({ principal: empty, dataPrincipal: empty }),
    );
    expect(next.status).toBe("blocked");
    expect(ids(next)).toEqual([]);
  });

  it("A → B → A: back on A, A's own data and snapshot offer A's actions again", () => {
    const onA = deriveOrderNextAction(order(), OWNER, ctx());
    const onB = deriveOrderNextAction(order(), OWNER, ctx({ principal: B, dataPrincipal: A }));
    const backOnA = deriveOrderNextAction(order(), OWNER, ctx());
    expect(ids(onB)).toEqual([]);
    expect(backOnA).toEqual(onA);
  });

  it("delayed reads: pack state / deliveries loading never produce an action; failures are retryable", () => {
    expect(deriveOrderNextAction(order(), OWNER, ctx({ packed: "loading" })).primary).toBeNull();
    const failedPack = deriveOrderNextAction(order(), OWNER, ctx({ packed: "unavailable" }));
    expect(failedPack.status).toBe("blocked");
    expect(failedPack.retryable).toBe(true);
    const failedDeliveries = deriveOrderNextAction(
      order(),
      OWNER,
      ctx({ deliveries: null, deliveriesUnavailable: true }),
    );
    expect(failedDeliveries.status).toBe("blocked");
    expect(failedDeliveries.retryable).toBe(true);
    expect(offersCancel(failedDeliveries)).toBe(false);
  });
});

describe("currency", () => {
  it("USD and KHR orders derive identically — no money enters the decision", () => {
    // NextActionOrder has no money field at all; the same axes give the same answer.
    const usdOrder = {
      ...order({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
      currency: "USD",
    };
    const khrOrder = {
      ...order({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
      currency: "KHR",
    };
    expect(deriveOrderNextAction(usdOrder, OWNER, ctx())).toEqual(
      deriveOrderNextAction(khrOrder, OWNER, ctx()),
    );
  });
});

describe("every offered action is permitted and is a valid move", () => {
  const ACTION_PERMISSIONS: Record<string, UiPermissionKey[][]> = {
    confirm_order: [["orders.confirm"]],
    complete_order: [["orders.update"]],
    cancel_order: [["orders.cancel"]],
    record_payment: [["payments.record"], ["payments.mark_cod"]],
    review_payment: [["payments.manual_confirm"], ["payments.verify"]],
    pack_order: [["orders.read", "delivery.handoff"]],
    arrange_delivery: [["delivery.create"]],
    courier_handoff: [["delivery.handoff"]],
    track_delivery: [["delivery.read"]],
    start_return: [["orders.return"]],
    open_payments: [["payments.read"]],
  };

  const lifecycles = ["draft", "confirmed", "completed", "cancelled"] as const;
  const payments = ["unpaid", "pending", "paid", "failed"] as const;
  const fulfillments = ["unfulfilled", "processing", "fulfilled", "cancelled"] as const;
  const deliveryStates = [
    NO_DELIVERY,
    delivery("pending"),
    delivery("ready"),
    delivery("in_transit"),
    delivery("delivered"),
    delivery("failed"),
  ];
  const roles: CapabilityView[] = [
    OWNER,
    CASHIER,
    capsFor(["orders.read", "delivery.read", "delivery.handoff"]),
    capsFor([]),
  ];

  it("exhaustively, across axes × deliveries × packed × roles", () => {
    for (const lifecycleStatus of lifecycles)
      for (const paymentStatus of payments)
        for (const fulfillmentStatus of fulfillments)
          for (const deliveries of deliveryStates)
            for (const packed of [true, false])
              for (const caps of roles) {
                const next = deriveOrderNextAction(
                  order({ lifecycleStatus, paymentStatus, fulfillmentStatus }),
                  caps,
                  ctx({ deliveries, packed }),
                );
                for (const id of ids(next)) {
                  const ok = ACTION_PERMISSIONS[id]!.some((all) => all.every((k) => caps.can(k)));
                  expect({ id, ok }).toEqual({ id, ok: true });
                }
                if (next.primary?.id === "confirm_order") expect(lifecycleStatus).toBe("draft");
                if (next.primary?.id === "complete_order") {
                  expect([lifecycleStatus, paymentStatus, fulfillmentStatus]).toEqual([
                    "confirmed",
                    "paid",
                    "fulfilled",
                  ]);
                }
                if (offersCancel(next)) expect(["draft", "confirmed"]).toContain(lifecycleStatus);
                if (offersCancel(next) && lifecycleStatus === "confirmed") {
                  expect(["unfulfilled", "processing"]).toContain(fulfillmentStatus);
                  expect(deliveries.anyDelivered).toBe(false);
                  expect(deliveries.activeStatus).not.toBe("in_transit");
                }
                if (lifecycleStatus === "completed" || lifecycleStatus === "cancelled") {
                  expect(next.primary).toBeNull();
                }
              }
  });
});
