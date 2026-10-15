/**
 * The Orders screen's eight filters — vocabulary, meaning and labels.
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
  ORDER_LIST_FILTERS,
  ORDER_PROGRESS_FILTERS,
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

describe("the eight filters", () => {
  it("are exactly these eight, All first", () => {
    expect([...ORDER_LIST_FILTERS]).toEqual([
      "all",
      "awaiting_payment",
      "draft",
      "to_pack",
      "processing",
      "fulfilled",
      "completed",
      "cancelled",
    ]);
    expect(DEFAULT_ORDER_LIST_FILTER).toBe("all");
  });

  it("match exactly the combinations written out by hand", () => {
    const counts = Object.fromEntries(ORDER_LIST_FILTERS.map((f) => [f, matching(f).length]));
    expect(counts).toEqual({
      all: 64,
      awaiting_payment: 24,
      draft: 12,
      to_pack: 4,
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

  it("Awaiting payment is Home's 'Orders awaiting payment', combination for combination", () => {
    // src/server/home/repository.ts getHomeOrderSummary:
    //   .neq("lifecycle_status", "cancelled").in("payment_status", ["unpaid", "pending"])
    const home = (a: OrderListFilterAxes) =>
      a.lifecycle !== "cancelled" && ["unpaid", "pending"].includes(a.payment);
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
  it("accepts only the eight names; everything else is All", () => {
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
    expect(new Set(enLabels).size).toBe(8);
    expect(new Set(kmLabels).size).toBe(8);
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

  it("chip labels reuse the words the row's own status chips use", () => {
    // A merchant who picks "Processing" sees rows marked "Processing".
    expect(lookup(en, "orderList.filters.processing")).toBe(lookup(en, "status.processing"));
    expect(lookup(km, "orderList.filters.processing")).toBe(lookup(km, "status.processing"));
    expect(lookup(km, "orderList.filters.completed")).toBe(lookup(km, "status.completed"));
    expect(lookup(km, "orderList.filters.cancelled")).toBe(lookup(km, "status.cancelled"));
    expect(lookup(km, "orderList.filters.draft")).toBe(lookup(km, "status.draft"));
  });
});
