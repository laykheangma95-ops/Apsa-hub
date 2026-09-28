/**
 * Analytics browser data layer — the wrappers the Analytics screen calls.
 *
 * Isolated runtime file (spawned by analytics-ui.test.ts): mock.module mutates
 * the shared module cache. The double replaces ONLY the server-function
 * boundary (src/api/analytics.ts); everything the screen reads goes through
 * the real src/lib/api wrappers.
 *
 * Run: bun test ./src/tests/analytics-ui.runtime.ts
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const sent: Array<{ fn: string; data: Record<string, unknown> }> = [];
let failure: Error | null = null;

const summaryFor = (range: string) => ({
  range,
  from: "2026-09-27T17:00:00.000Z",
  until: "2026-09-28T17:00:00.000Z",
  orderCount: 2,
  finance: {
    status: "available",
    data: {
      orderedGross: [{ amount: 80000, currency: "KHR" }],
      collectedGross: [{ amount: 40000, currency: "KHR" }],
      refundedAmount: [],
      outstandingAmount: [{ amount: 40000, currency: "KHR" }],
    },
  },
});

mock.module("@/api/analytics", () => ({
  getBusinessSummaryFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "getBusinessSummaryFn", data });
    if (failure) throw failure;
    return summaryFor(data.range as string);
  },
  getTopSellingItemsFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "getTopSellingItemsFn", data });
    if (failure) throw failure;
    return [
      {
        productId: "p",
        variantId: "v",
        currency: "KHR",
        displayLabel: "កាហ្វេទឹកដោះគោ",
        quantitySold: 3,
        grossAmount: null,
      },
    ];
  },
  getCustomerSummaryFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "getCustomerSummaryFn", data });
    if (failure) throw failure;
    return { range: data.range, totalCustomers: 0, repeatOrderRate: null };
  },
}));

const api = await import("@/lib/api");

beforeEach(() => {
  sent.length = 0;
  failure = null;
});

describe("Analytics wrappers call the real server functions", () => {
  it("business summary asks for exactly the selected range and returns the server payload untouched", async () => {
    const summary = await api.getAnalyticsBusinessSummary("week");
    expect(sent).toEqual([{ fn: "getBusinessSummaryFn", data: { range: "week" } }]);
    expect(summary).toEqual(summaryFor("week") as never);
  });

  it("KHR money stays KHR — no conversion anywhere between server and screen", async () => {
    const summary = await api.getAnalyticsBusinessSummary("today");
    expect(summary.finance.status).toBe("available");
    if (summary.finance.status === "available") {
      expect(summary.finance.data.orderedGross).toEqual([{ amount: 80000, currency: "KHR" }]);
    }
  });

  it("top sellers pass range and limit, and are tagged with the range asked for", async () => {
    const page = await api.getAnalyticsTopSellers("month", 5);
    expect(sent).toEqual([{ fn: "getTopSellingItemsFn", data: { range: "month", limit: 5 } }]);
    expect(page.range).toBe("month");
    // A withheld amount arrives as null and stays null — never a 0.
    expect(page.items[0]!.grossAmount).toBeNull();
  });

  it("customer summary asks for the selected range", async () => {
    await api.getAnalyticsCustomerSummary("today");
    expect(sent).toEqual([{ fn: "getCustomerSummaryFn", data: { range: "today" } }]);
  });

  it("a failure is thrown for the screen to show — never fixtures, never zeros", async () => {
    failure = Object.assign(new Error("Missing permission: analytics.read"), { statusCode: 403 });
    await expect(api.getAnalyticsBusinessSummary("today")).rejects.toThrow("analytics.read");
    await expect(api.getAnalyticsTopSellers("today", 5)).rejects.toThrow("analytics.read");
    await expect(api.getAnalyticsCustomerSummary("today")).rejects.toThrow("analytics.read");
  });
});
