/**
 * The Orders screen's nine filters — vocabulary, meaning and labels.
 *
 * The SQL behind each filter is proven against the real repository and every
 * migration in src/tests/orders-pagination-mounted.runtime.ts (case FA); this
 * file pins the written definitions themselves, so a change to what a filter
 * means is a deliberate, reviewed edit here rather than a side effect.
 *
 * Run: bun test src/tests/order-list-filters.test.ts
 */
import { describe, expect, it } from "bun:test";
import en from "@/locales/en.json";
import km from "@/locales/km.json";
import {
  DEFAULT_ORDER_LIST_FILTER,
  ORDER_ATTENTION_FILTERS,
  ORDER_LIST_FILTERS,
  ORDER_PROGRESS_FILTERS,
  PAYMENT_DUE_STATUSES,
  isOrderListFilter,
  orderListFilterLabelKey,
  orderMatchesListFilter,
  parseOrderListFilter,
  type OrderListFilterAxes,
} from "@/lib/order-list-filters";
import {
  ORDER_FULFILLMENT_STATUSES,
  ORDER_LIFECYCLE_STATUSES,
  ORDER_PAYMENT_STATUSES,
} from "@/server/orders/state-machine";

/**
 * Every combination the orders table can hold — 4 × 4 × 4. Built from the state
 * machine's own vocabularies, so a status the filters do not know about fails
 * to typecheck here.
 */
const EVERY: OrderListFilterAxes[] = ORDER_LIFECYCLE_STATUSES.flatMap((lifecycle) =>
  ORDER_PAYMENT_STATUSES.flatMap((payment) =>
    ORDER_FULFILLMENT_STATUSES.map((fulfillment) => ({ lifecycle, payment, fulfillment })),
  ),
);

const matching = (filter: (typeof ORDER_LIST_FILTERS)[number]) =>
  EVERY.filter((axes) => orderMatchesListFilter(filter, axes));

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, dict);
}

describe("the nine filters", () => {
  it("are exactly these nine: All, then the three attention views, then progress", () => {
    expect([...ORDER_LIST_FILTERS]).toEqual([
      "all",
      "awaiting_payment",
      "to_pack",
      "waiting_pickup",
      "draft",
      "processing",
      "fulfilled",
      "completed",
      "cancelled",
    ]);
    expect(DEFAULT_ORDER_LIST_FILTER).toBe("all");
    expect([...ORDER_ATTENTION_FILTERS]).toEqual(["awaiting_payment", "to_pack", "waiting_pickup"]);
  });

  it("match exactly the combinations written out by hand", () => {
    const counts = Object.fromEntries(ORDER_LIST_FILTERS.map((f) => [f, matching(f).length]));
    expect(counts).toEqual({
      all: 64,
      awaiting_payment: 36,
      draft: 12,
      to_pack: 4,
      // A delivery fact: no combination of the three columns alone is waiting.
      waiting_pickup: 0,
      processing: 4,
      fulfilled: 4,
      completed: 12,
      cancelled: 28,
    });

    expect(matching("to_pack").every((a) => a.lifecycle === "confirmed")).toBe(true);
    expect(matching("to_pack").every((a) => a.fulfillment === "unfulfilled")).toBe(true);
    expect(matching("processing").every((a) => a.fulfillment === "processing")).toBe(true);
    expect(matching("fulfilled").every((a) => a.lifecycle === "confirmed")).toBe(true);
    expect(matching("fulfilled").every((a) => a.fulfillment === "fulfilled")).toBe(true);
    expect(matching("draft").every((a) => a.lifecycle === "draft")).toBe(true);
    expect(matching("completed").every((a) => a.lifecycle === "completed")).toBe(true);
    expect(
      matching("cancelled").every(
        (a) => a.lifecycle === "cancelled" || a.fulfillment === "cancelled",
      ),
    ).toBe(true);
  });

  it("the six progress filters place every possible order in exactly one", () => {
    expect([...ORDER_PROGRESS_FILTERS].sort()).toEqual(
      ["cancelled", "completed", "draft", "fulfilled", "processing", "to_pack"].sort(),
    );
    for (const axes of EVERY) {
      const hits = ORDER_PROGRESS_FILTERS.filter((f) => orderMatchesListFilter(f, axes));
      expect({ axes, hits: hits.length }).toEqual({ axes, hits: 1 });
    }
  });

  it("Payment due is Home's 'Orders awaiting payment', combination for combination", () => {
    // src/server/home/repository.ts getHomeOrderSummary:
    //   .neq("lifecycle_status", "cancelled").in("payment_status", PAYMENT_DUE_STATUSES)
    expect([...PAYMENT_DUE_STATUSES]).toEqual(["unpaid", "pending", "failed"]);
    const home = (a: OrderListFilterAxes) =>
      a.lifecycle !== "cancelled" && ["unpaid", "pending", "failed"].includes(a.payment);
    for (const axes of EVERY) {
      expect(orderMatchesListFilter("awaiting_payment", axes)).toBe(home(axes));
    }
    // A cash-on-delivery sale being packed is under both, on purpose.
    const cod: OrderListFilterAxes = {
      lifecycle: "confirmed",
      payment: "unpaid",
      fulfillment: "unfulfilled",
    };
    expect(orderMatchesListFilter("awaiting_payment", cod)).toBe(true);
    expect(orderMatchesListFilter("to_pack", cod)).toBe(true);
    // Every attempt failed and nothing was received (migration 040): still due.
    expect(orderMatchesListFilter("awaiting_payment", { ...cod, payment: "failed" })).toBe(true);
    expect(orderMatchesListFilter("awaiting_payment", { ...cod, payment: "paid" })).toBe(false);
  });

  it("Waiting for pickup: confirmed, a ready delivery, goods neither delivered nor cancelled", () => {
    for (const axes of EVERY) {
      const ready = { ...axes, readyDelivery: true };
      expect(orderMatchesListFilter("waiting_pickup", ready)).toBe(
        axes.lifecycle === "confirmed" &&
          axes.fulfillment !== "fulfilled" &&
          axes.fulfillment !== "cancelled",
      );
      // Without a ready delivery nothing waits for a courier — packed or not.
      expect(orderMatchesListFilter("waiting_pickup", axes)).toBe(false);
    }
    // A packed COD order waiting for the courier is also Payment due: packing is not payment.
    const codWaiting: OrderListFilterAxes = {
      lifecycle: "confirmed",
      payment: "unpaid",
      fulfillment: "processing",
      readyDelivery: true,
    };
    expect(orderMatchesListFilter("waiting_pickup", codWaiting)).toBe(true);
    expect(orderMatchesListFilter("awaiting_payment", codWaiting)).toBe(true);
    expect(orderMatchesListFilter("to_pack", codWaiting)).toBe(false);
    // Cancelled is never waiting work.
    expect(
      orderMatchesListFilter("waiting_pickup", { ...codWaiting, lifecycle: "cancelled" }),
    ).toBe(false);
  });

  it("To pack plus Processing is the Ready-to-Pack queue, nothing more and nothing less", () => {
    // src/server/orders/state-machine.ts isReadyToPackEligible: confirmed + unfulfilled|processing.
    for (const axes of EVERY) {
      const queue =
        axes.lifecycle === "confirmed" &&
        (axes.fulfillment === "unfulfilled" || axes.fulfillment === "processing");
      expect(
        orderMatchesListFilter("to_pack", axes) || orderMatchesListFilter("processing", axes),
      ).toBe(queue);
    }
  });
});

describe("filter names from outside", () => {
  it("accepts only the nine names; everything else is All", () => {
    for (const filter of ORDER_LIST_FILTERS) {
      expect(isOrderListFilter(filter)).toBe(true);
      expect(parseOrderListFilter(filter)).toBe(filter);
    }
    for (const value of [
      "",
      "ALL",
      "Draft",
      "unpaid",
      "draft ",
      "to-pack",
      null,
      undefined,
      3,
      {},
    ]) {
      expect(isOrderListFilter(value)).toBe(false);
      expect(parseOrderListFilter(value)).toBe("all");
    }
  });
});

describe("labels", () => {
  it("every filter has its own English and Khmer label, and Khmer is not English", () => {
    const enLabels = ORDER_LIST_FILTERS.map((f) => lookup(en, orderListFilterLabelKey(f)));
    const kmLabels = ORDER_LIST_FILTERS.map((f) => lookup(km, orderListFilterLabelKey(f)));
    for (const label of [...enLabels, ...kmLabels]) {
      expect(typeof label).toBe("string");
      expect((label as string).trim().length).toBeGreaterThan(0);
    }
    expect(new Set(enLabels).size).toBe(9);
    expect(new Set(kmLabels).size).toBe(9);
    for (const label of kmLabels) expect(label as string).toMatch(/[ក-៿]/);
    for (const label of kmLabels) expect(label as string).not.toMatch(/[A-Za-z]/);
  });

  it("the filtered empty and end states exist in both languages", () => {
    for (const key of [
      "orderList.filtersLabel",
      "orderList.emptyFilter.title",
      "orderList.emptyFilter.body",
      "orderList.emptyFilter.showAll",
      "orderList.endFiltered.title",
      "orderList.endFiltered.body_one",
      "orderList.endFiltered.body_other",
    ]) {
      expect(typeof lookup(en, key)).toBe("string");
      expect(lookup(km, key) as string).toMatch(/[ក-៿]/);
    }
    expect(lookup(km, "orderList.endFiltered.body_other") as string).toContain("{{count}}");
  });

  it("the attention views carry the names merchants asked for", () => {
    expect(lookup(en, "orderList.filters.awaiting_payment")).toBe("Payment due");
    expect(lookup(en, "orderList.filters.to_pack")).toBe("Needs preparation");
    expect(lookup(en, "orderList.filters.waiting_pickup")).toBe("Packed · Waiting for pickup");
  });

  it("chip labels reuse the words the row's own status chips use", () => {
    // A merchant who picks "Processing" sees rows marked "Processing".
    expect(lookup(en, "orderList.filters.processing")).toBe(lookup(en, "status.processing"));
    expect(lookup(km, "orderList.filters.completed")).toBe(lookup(km, "status.completed"));
    expect(lookup(km, "orderList.filters.cancelled")).toBe(lookup(km, "status.cancelled"));
    expect(lookup(km, "orderList.filters.draft")).toBe(lookup(km, "status.draft"));
  });

  it("Khmer Processing and Fulfilled never say 'prepare': both hold orders past preparing", () => {
    // Processing holds packing, ready AND in-transit orders; Fulfilled holds
    // orders the customer already has. រៀបចំ ("prepare") would put a parcel on
    // the road under a preparing label, and a delivered order under "prepared".
    // (Khmer status.processing still says កំពុងរៀបចំ, so this chip departs
    // from the row's word on purpose.)
    for (const filter of ["processing", "fulfilled"] as const) {
      expect(lookup(km, orderListFilterLabelKey(filter)) as string).not.toContain("រៀបចំ");
    }
    // Fulfilled is not Completed: its label never reads as the finished sale.
    expect(lookup(km, "orderList.filters.fulfilled")).not.toBe(lookup(km, "status.completed"));
    expect(lookup(km, "orderList.filters.fulfilled") as string).toContain("មិនទាន់បញ្ចប់");
  });
});
