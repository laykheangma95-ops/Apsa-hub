/**
 * Customer Intelligence V1 — Customer Detail section and its wiring.
 *
 * Renders the shipped CustomerInsightsSection with real i18n (Khmer and
 * English) and asserts what a merchant reads: an honest empty state, money
 * only when permitted and never summed across currencies, statuses as words,
 * and denied sections absent rather than zero. Also pins the route wiring and
 * the cache partition.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CustomerInsightsSection } from "@/components/customers/CustomerInsightsSection";
import { customerKeys } from "@/lib/customers-query";
import {
  customerInsightGrants,
  customerInsightGrantsTag,
  redactCustomerInsights,
  deliveryParts,
  insightMoney,
  outstandingLines,
  topProductLabel,
  type CustomerInsights,
} from "@/lib/customer-insights-view";
import i18n from "@/lib/i18n";
import { QueryClient } from "@tanstack/react-query";
import {
  createCapabilityView,
  createFixtureCapabilityView,
  type UiPermissionKey,
} from "@/lib/capabilities";
import { enforceCustomerInsightsGrants } from "@/lib/customers-query";

function base(): CustomerInsights {
  return {
    customerId: "c",
    hasPurchases: true,
    activity: {
      orderCount: 3,
      openOrderCount: 2,
      completedOrderCount: 1,
      cancelledOrderCount: 1,
      refundedOrderCount: 1,
      firstOrderAt: "2026-09-01T03:00:00.000Z",
      lastOrderAt: "2026-09-10T03:00:00.000Z",
      lastOrderId: "o3",
      lastOrderSource: "MANUAL",
      lastOrderProducts: ["Product A"],
      distinctProductCount: 2,
      unitsPurchased: 5,
      conversationLinkedOrderCount: 1,
      sourceCounts: { INSTAGRAM: 1, FACEBOOK: 1, MANUAL: 1 },
    },
    topProducts: [
      {
        productId: "pA",
        label: "Product A",
        topVariantLabel: "Black / M",
        variantCount: 2,
        units: 4,
        orderCount: 3,
        lastPurchasedAt: "2026-09-10T03:00:00.000Z",
      },
      {
        productId: "pB",
        label: "Product B",
        topVariantLabel: null,
        variantCount: 1,
        units: 1,
        orderCount: 1,
        lastPurchasedAt: "2026-09-01T03:00:00.000Z",
      },
    ],
    money: {
      status: "available",
      data: [
        {
          currency: "KHR",
          orderCount: 1,
          ordered: { amount: 40000, currency: "KHR" },
          received: { amount: 40000, currency: "KHR" },
          refunded: { amount: 10000, currency: "KHR" },
          netPaid: { amount: 30000, currency: "KHR" },
          outstanding: { amount: 0, currency: "KHR" },
          averageOrder: { amount: 40000, currency: "KHR" },
        },
        {
          currency: "USD",
          orderCount: 2,
          ordered: { amount: 6500, currency: "USD" },
          received: { amount: 5000, currency: "USD" },
          refunded: { amount: 0, currency: "USD" },
          netPaid: { amount: 5000, currency: "USD" },
          outstanding: { amount: 1500, currency: "USD" },
          averageOrder: { amount: 3250, currency: "USD" },
        },
      ],
    },
    payments: { status: "available", data: { methodOrderCounts: { khqr: 1, cod: 1, cash: 1 } } },
    delivery: {
      status: "available",
      data: {
        ordersWithDelivery: 2,
        failedAttemptCount: 1,
        currentStatusCounts: { delivered: 1, in_transit: 1 },
      },
    },
    returns: {
      status: "available",
      data: {
        returnCount: 2,
        returnedOrderCount: 1,
        completedReturnCount: 1,
        completedReturnedUnits: 1,
      },
    },
  };
}

async function render(
  insights: CustomerInsights,
  sensitiveVisible = true,
  language: "en" | "km" = "en",
) {
  await i18n.changeLanguage(language);
  const html = renderToStaticMarkup(
    createElement(CustomerInsightsSection, { insights, sensitiveVisible }),
  );
  return {
    html,
    text: html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

describe("14 — a customer with no purchases", () => {
  it("says so plainly, with no zeros dressed up as figures", async () => {
    const empty: CustomerInsights = {
      ...base(),
      hasPurchases: false,
      activity: {
        ...base().activity,
        orderCount: 0,
        openOrderCount: 0,
        completedOrderCount: 0,
        cancelledOrderCount: 0,
        refundedOrderCount: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        lastOrderProducts: [],
        sourceCounts: {},
      },
      topProducts: [],
      money: { status: "available", data: [] },
    };
    const { text } = await render(empty);
    expect(text).toContain("No purchase history yet");
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/\b0 orders\b/);
    expect(text).not.toContain("Most bought");
  });

  it("still mentions cancelled orders, which are not purchases", async () => {
    const { text } = await render({
      ...base(),
      hasPurchases: false,
      topProducts: [],
      activity: { ...base().activity, orderCount: 0, cancelledOrderCount: 2 },
    });
    expect(text).toContain("No purchase history yet");
    expect(text).toContain("Cancelled orders 2 orders");
  });

  it("is Khmer by default copy, translated", async () => {
    const { text } = await render({ ...base(), hasPurchases: false }, true, "km");
    expect(text).toContain("មិនទាន់មានប្រវត្តិទិញនៅឡើយ");
  });
});

describe("a customer with history", () => {
  it("shows orders, products with their usual variant, and word statuses", async () => {
    const { text } = await render(base());
    expect(text).toContain("Customer insights");
    expect(text).toContain("3 · 1 completed · 2 in progress");
    expect(text).toContain("Product A · Black / M");
    expect(text).toContain("×4");
    expect(text).toContain("Delivered 1, In transit 1");
    expect(text).toContain("1 failed attempt");
    expect(text).toContain("2 · 1 completed");
    expect(text).toContain("Payment methods Cash 1, KHQR 1, Cash on delivery 1");
    expect(text).not.toContain("Paid with");
    expect(text).toContain("Facebook 1, Instagram 1, Entered by hand 1");
    expect(text).toContain("Last bought Product A");
  });

  it("owed money is per currency and only non-zero balances are listed", async () => {
    const { text } = await render(base());
    expect(text).toContain("Still to collect $15.00");
    expect(text).not.toContain("៛0");
  });

  it("hides every amount when the member may not see sensitive values right now", async () => {
    const { text } = await render(base(), false);
    expect(text).not.toContain("$");
    expect(text).not.toContain("៛");
    expect(text).not.toContain("Still to collect");
    // Non-financial facts remain.
    expect(text).toContain("Product A · Black / M");
  });

  it("omits sections the server withheld — never renders them as zero", async () => {
    const denied: CustomerInsights = {
      ...base(),
      money: { status: "permission_denied" },
      payments: { status: "permission_denied" },
      delivery: { status: "permission_denied" },
      returns: { status: "permission_denied" },
    };
    const { text } = await render(denied);
    for (const label of ["Deliveries", "Returns", "Payment methods", "Still to collect", "$"]) {
      expect(text).not.toContain(label);
    }
  });

  it("renders in Khmer without forcing case on any text", async () => {
    const { html, text } = await render(base(), true, "km");
    expect(text).toContain("ព័ត៌មានសង្ខេបអំពីអតិថិជន");
    expect(text).toContain("ទិញញឹកញាប់ជាងគេ");
    expect(html).not.toContain("uppercase");
  });
});

describe("view rules", () => {
  it("money: server denial or a lapsed grant hides; otherwise per-currency values", () => {
    expect(insightMoney(base(), false)).toEqual({ kind: "hidden" });
    expect(insightMoney({ ...base(), money: { status: "permission_denied" } }, true)).toEqual({
      kind: "hidden",
    });
    expect(insightMoney({ ...base(), money: { status: "error" } }, true)).toEqual({
      kind: "unavailable",
    });
    const shown = insightMoney(base(), true);
    if (shown.kind !== "values") throw new Error("unreachable");
    expect(shown.byCurrency.map((m) => m.currency)).toEqual(["KHR", "USD"]);
    expect(outstandingLines(shown.byCurrency)).toEqual([{ amount: 1500, currency: "USD" }]);
  });

  it("delivery parts follow a fixed outcome-first order", () => {
    expect(deliveryParts(base())).toEqual([
      { key: "delivered", count: 1 },
      { key: "in_transit", count: 1 },
    ]);
    expect(deliveryParts({ ...base(), delivery: { status: "permission_denied" } })).toBeNull();
  });

  it("a product with an unnamed variant shows just its name", () => {
    expect(topProductLabel(base().topProducts[1]!)).toBe("Product B");
  });
});

describe("display authority comes from the CURRENT grants", () => {
  const view = (keys: string[]) => createFixtureCapabilityView(keys as UiPermissionKey[]);
  const FULL = [
    "customers.read",
    "orders.read",
    "customers.view_sensitive",
    "payments.reconcile",
    "payments.read",
    "delivery.read",
    "orders.return",
  ];

  it("base needs customers.read AND orders.read; every section needs base", () => {
    for (const missing of ["customers.read", "orders.read"]) {
      expect(customerInsightGrants(view(FULL.filter((k) => k !== missing)))).toEqual({
        base: false,
        money: false,
        payments: false,
        delivery: false,
        returns: false,
      });
    }
    expect(customerInsightGrants(view(FULL))).toEqual({
      base: true,
      money: true,
      payments: true,
      delivery: true,
      returns: true,
    });
  });

  it("money needs BOTH customers.view_sensitive and payments.reconcile", () => {
    for (const missing of ["customers.view_sensitive", "payments.reconcile"]) {
      expect(customerInsightGrants(view(FULL.filter((k) => k !== missing))).money).toBe(false);
    }
  });

  it("a snapshot whose latest refresh FAILED grants nothing — base and every section included", () => {
    const stale = createCapabilityView({
      result: {
        status: "active",
        userId: "u",
        organizationId: "o",
        role: "OWNER",
        permissions: FULL as UiPermissionKey[],
      },
      isPending: false,
      isError: true,
      expectedUserId: "u",
      expectedOrganizationId: "o",
    });
    // can() still says yes for navigation; Customer Intelligence must not.
    expect(stale.can("customers.read")).toBe(true);
    expect(customerInsightGrants(stale)).toEqual({
      base: false,
      money: false,
      payments: false,
      delivery: false,
      returns: false,
    });
  });

  it("a snapshot that has not resolved yet grants nothing", () => {
    const pending = createCapabilityView({
      result: undefined,
      isPending: true,
      isError: false,
      expectedUserId: "u",
      expectedOrganizationId: "o",
    });
    expect(customerInsightGrants(pending).base).toBe(false);
  });

  it("a cached payload's own 'available' sections are withheld when the grant is gone", () => {
    const grants = customerInsightGrants(view(["customers.read", "orders.read", "payments.read"]));
    const shown = redactCustomerInsights(base(), grants)!;
    expect(shown.money).toEqual({ status: "permission_denied" });
    expect(shown.delivery).toEqual({ status: "permission_denied" });
    expect(shown.returns).toEqual({ status: "permission_denied" });
    expect(shown.payments.status).toBe("available");
    expect(redactCustomerInsights(base(), customerInsightGrants(view(["orders.read"])))).toBeNull();
  });

  it("the grant tag differs for every grant set, so responses never share an entry", () => {
    const tags = new Set<string>();
    for (let mask = 0; mask < 32; mask++) {
      const keys = ["base", "money", "payments", "delivery", "returns"] as const;
      tags.add(
        customerInsightGrantsTag(
          Object.fromEntries(keys.map((k, i) => [k, Boolean(mask & (1 << i))])) as never,
        ),
      );
    }
    expect(tags.size).toBe(32);
  });

  it("eviction removes this principal's entries under any other grant set — and nothing else", () => {
    const queryClient = new QueryClient();
    const keep = customerKeys.insights("u", "o", "c1", "11111");
    const old1 = customerKeys.insights("u", "o", "c1", "11110");
    const old2 = customerKeys.insights("u", "o", "c2", "01111");
    const otherPrincipal = customerKeys.insights("u2", "o", "c1", "10000");
    const profile = customerKeys.detail("u", "o", "c1");
    for (const key of [keep, old1, old2, otherPrincipal, profile])
      queryClient.setQueryData(key, { marker: true });

    enforceCustomerInsightsGrants(queryClient, "u", "o", "11111");
    expect(queryClient.getQueryData(keep)).toBeDefined();
    expect(queryClient.getQueryData(old1)).toBeUndefined();
    expect(queryClient.getQueryData(old2)).toBeUndefined();
    expect(queryClient.getQueryData(otherPrincipal)).toBeDefined();
    expect(queryClient.getQueryData(profile)).toBeDefined();

    // Revocation: the entry under the previous grants goes too.
    enforceCustomerInsightsGrants(queryClient, "u", "o", "10111");
    expect(queryClient.getQueryData(keep)).toBeUndefined();
  });
});

describe("wiring", () => {
  const route = readFileSync("src/routes/app.customers.$id.tsx", "utf8");
  const component = readFileSync("src/components/customers/CustomerInsightsSection.tsx", "utf8");

  it("the insights cache entry sits under the customer's detail key, so purges and sensitive eviction take it", () => {
    const detail = customerKeys.detail("u", "o", "c");
    const principal = customerKeys.principal("u", "o");
    const insights = customerKeys.insights("u", "o", "c", "11111");
    expect(insights.slice(0, detail.length)).toEqual([...detail]);
    expect(insights.slice(0, principal.length)).toEqual([...principal]);
  });

  it("Customer Detail reads insights only through the grant-checking hook", () => {
    expect(route).toContain("useCustomerInsights({");
    // No direct read of the raw query payload anywhere on the screen.
    expect(route).not.toContain("getCustomerInsights(");
    expect(route).not.toMatch(/insightsQuery/);
    const hook = readFileSync("src/hooks/use-customer-insights.ts", "utf8");
    expect(hook).toContain("redactCustomerInsights(query.data.data, grants)");
    expect(hook).toContain(
      "enforceCustomerInsightsGrants(queryClient, userId, organizationId, grantsTag);",
    );
    expect(hook).toContain(
      "queryKey: customerKeys.insights(userId, organizationId, customerId, grantsTag)",
    );
    // A failure is reported as a failure, never as "no purchases".
    expect(route).toContain('title={t("customerInsights.loadError")}');
  });

  it("the section stays out of Apsi, raw colours and forced case", () => {
    expect(component).not.toMatch(/apsi/i);
    expect(component).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(component).not.toMatch(/uppercase/);
  });
});
