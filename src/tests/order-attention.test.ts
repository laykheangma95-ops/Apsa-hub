/**
 * Orders attention views — the pure parts: each row's next-step hint, its
 * waiting time, the identity check on the chips' counts, and the strings in
 * both languages. The SQL, permissions and tenancy are proven through the real
 * server in order-attention-lists.runtime.ts.
 *
 * Run: bun test src/tests/order-attention.test.ts
 */
import { describe, expect, it } from "bun:test";
import en from "@/locales/en.json";
import km from "@/locales/km.json";
import type { UiPermissionKey } from "@/lib/capabilities";
import { attentionNextStep, packedDeliveryReasonKey, waitingDuration } from "@/lib/order-attention";
import {
  acceptOrderAttentionCounts,
  acceptOrderListPage,
  isOrderListPrincipalChanged,
} from "@/lib/orders";
import { ordersKeys } from "@/lib/orders-query";

const ALL = () => true;
const only =
  (...keys: UiPermissionKey[]) =>
  (key: UiPermissionKey) =>
    keys.includes(key);

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, dict);
}

describe("next-step hint", () => {
  const confirmed = (paymentStatus: "unpaid" | "pending" | "paid" | "failed") => ({
    lifecycleStatus: "confirmed" as const,
    paymentStatus,
  });

  it("Payment due: a draft is confirmed first, pending is confirmed, unpaid and failed are recorded", () => {
    expect(
      attentionNextStep(
        "awaiting_payment",
        { lifecycleStatus: "draft", paymentStatus: "unpaid" },
        null,
        ALL,
      ),
    ).toEqual({ kind: "action", actionKey: "order.next.action.confirm_order" });
    expect(attentionNextStep("awaiting_payment", confirmed("pending"), null, ALL)).toEqual({
      kind: "action",
      actionKey: "order.next.action.review_payment",
    });
    for (const status of ["unpaid", "failed"] as const) {
      expect(attentionNextStep("awaiting_payment", confirmed(status), null, ALL)).toEqual({
        kind: "action",
        actionKey: "order.next.action.record_payment",
      });
    }
    // COD collection is recorded with payments.mark_cod alone.
    expect(
      attentionNextStep("awaiting_payment", confirmed("unpaid"), null, only("payments.mark_cod")),
    ).toEqual({ kind: "action", actionKey: "order.next.action.record_payment" });
  });

  it("Needs preparation: Pack order", () => {
    expect(attentionNextStep("to_pack", confirmed("unpaid"), null, ALL)).toEqual({
      kind: "action",
      actionKey: "order.next.action.pack_order",
    });
  });

  it("Packed · Needs delivery: Arrange delivery, except a delivery never readied; nothing guessed without delivery.read", () => {
    for (const status of [null, "failed", "cancelled"]) {
      expect(
        attentionNextStep("packed_needs_delivery", confirmed("paid"), { status }, ALL),
      ).toEqual({ kind: "action", actionKey: "order.next.action.arrange_delivery" });
    }
    for (const status of ["pending", "preparing"]) {
      // Next Action's own answer: "Retry delivery ready" on Order detail.
      expect(
        attentionNextStep("packed_needs_delivery", confirmed("paid"), { status }, ALL),
      ).toEqual({ kind: "none" });
      expect(packedDeliveryReasonKey({ status })).toBe("order.next.reason.deliveryNotReady");
    }
    expect(packedDeliveryReasonKey({ status: null })).toBe("order.next.reason.packedNoDelivery");
    expect(packedDeliveryReasonKey({ status: "failed" })).toBe("order.next.reason.deliveryFailed");
    expect(packedDeliveryReasonKey({ status: "cancelled" })).toBe(
      "order.next.reason.deliveryCancelled",
    );
    expect(attentionNextStep("packed_needs_delivery", confirmed("paid"), null, ALL)).toEqual({
      kind: "none",
    });
    expect(packedDeliveryReasonKey(null)).toBeNull();
    expect(
      attentionNextStep(
        "packed_needs_delivery",
        confirmed("paid"),
        { status: "failed" },
        only("orders.read"),
      ),
    ).toEqual({ kind: "teammate" });
  });

  it("Waiting for pickup: Hand to courier", () => {
    expect(attentionNextStep("waiting_pickup", confirmed("unpaid"), null, ALL)).toEqual({
      kind: "action",
      actionKey: "order.next.action.courier_handoff",
    });
  });

  it("without the grant the step needs, the hint names a teammate, never the action", () => {
    const viewer = only("orders.read");
    expect(attentionNextStep("awaiting_payment", confirmed("unpaid"), null, viewer)).toEqual({
      kind: "teammate",
    });
    expect(attentionNextStep("awaiting_payment", confirmed("pending"), null, viewer)).toEqual({
      kind: "teammate",
    });
    expect(attentionNextStep("to_pack", confirmed("unpaid"), null, viewer)).toEqual({
      kind: "teammate",
    });
    expect(attentionNextStep("waiting_pickup", confirmed("unpaid"), null, viewer)).toEqual({
      kind: "teammate",
    });
  });

  it("every action label the hint can name exists in English and Khmer", () => {
    for (const id of [
      "confirm_order",
      "review_payment",
      "record_payment",
      "pack_order",
      "arrange_delivery",
      "courier_handoff",
    ]) {
      expect(typeof lookup(en, `order.next.action.${id}`)).toBe("string");
      expect(lookup(km, `order.next.action.${id}`) as string).toMatch(/[ក-៿]/);
    }
  });
});

describe("waiting time", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("rounds down to minutes, hours, then days", () => {
    expect(waitingDuration("2026-10-27T11:59:30Z", now)).toEqual({ unit: "minutes", count: 0 });
    expect(waitingDuration("2026-10-27T11:01:00Z", now)).toEqual({ unit: "minutes", count: 59 });
    expect(waitingDuration("2026-10-27T11:00:00Z", now)).toEqual({ unit: "hours", count: 1 });
    expect(waitingDuration("2026-10-26T12:00:01Z", now)).toEqual({ unit: "hours", count: 23 });
    expect(waitingDuration("2026-10-24T12:00:00Z", now)).toEqual({ unit: "days", count: 3 });
  });
  it("a time ahead of this clock is no wait, not a negative one; garbage is unknown", () => {
    expect(waitingDuration("2026-10-27T13:00:00Z", now)).toEqual({ unit: "minutes", count: 0 });
    expect(waitingDuration("not a time", now)).toBeNull();
  });
});

describe("stale and foreign answers", () => {
  const me = { userId: "u-1", organizationId: "org-a" };
  const counts = { paymentDue: 3, needsPreparation: 2, packedNeedsDelivery: 4, waitingPickup: 1 };

  it("counts answered for this principal are accepted", () => {
    expect(acceptOrderAttentionCounts({ ...counts, servedAs: me }, me)).toEqual(counts);
  });

  it("counts answered for another business or account are refused, not shown", () => {
    for (const servedAs of [
      { userId: "u-1", organizationId: "org-b" },
      { userId: "u-2", organizationId: "org-a" },
    ]) {
      let error: unknown = null;
      try {
        acceptOrderAttentionCounts({ ...counts, servedAs }, me);
      } catch (caught) {
        error = caught;
      }
      expect(isOrderListPrincipalChanged(error)).toBe(true);
    }
  });

  it("a page answered for another filter is refused, and attention facts ride with an accepted page", () => {
    const page = {
      orders: [],
      nextCursor: null,
      servedAs: me,
      filter: "to_pack" as const,
      attention: {},
    };
    expect(() => acceptOrderListPage(page, me, "awaiting_payment")).toThrow(/different filter/);
    expect(acceptOrderListPage(page, me, "to_pack").attention).toEqual({});
  });

  it("counts are cached per member and organization, under the list (so list invalidation reaches them)", () => {
    const key = ordersKeys.attentionCounts("u-1", "org-a");
    expect(key.slice(0, ordersKeys.list("u-1", "org-a").length)).toEqual([
      ...ordersKeys.list("u-1", "org-a"),
    ]);
    expect(ordersKeys.attentionCounts("u-1", "org-b")).not.toEqual(key);
    expect(ordersKeys.attentionCounts("u-2", "org-a")).not.toEqual(key);
  });
});

describe("strings", () => {
  it("every attention string exists in both languages; Khmer is Khmer", () => {
    const keys = [
      "orderList.attention.readyTimeUnknown",
      "orderList.attention.staffNotTracked",
      "orderList.attention.received",
      "orderList.attention.cod",
      "orderList.attention.packedDeliveryUnknown",
      "orderList.attention.next",
      "orderList.attention.nextTeammate",
      "orderList.attention.countLabel",
    ];
    for (const unit of ["minutes", "hours", "days"]) {
      for (const group of ["waited", "readyWaited"]) {
        keys.push(`orderList.attention.${group}.${unit}_other`);
        expect(typeof lookup(en, `orderList.attention.${group}.${unit}_one`)).toBe("string");
      }
    }
    for (const key of keys) {
      expect({ key, en: typeof lookup(en, key) }).toEqual({ key, en: "string" });
      expect({ key, km: /[ក-៿]/.test(String(lookup(km, key))) }).toEqual({ key, km: true });
    }
    expect(lookup(km, "orderList.attention.waited.hours_other") as string).toContain("{{count}}");
  });
});
