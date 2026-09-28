/**
 * Analytics screen — V1, on the existing Analytics backend.
 *
 * The metrics themselves (cohort, money boundary, top-seller ranking, customer
 * cohort) are proven against the real service in analytics-foundation.test.ts.
 * This file proves what the SCREEN does with them:
 *   - the wrappers hit the real server functions and fail honestly
 *     (analytics-ui.runtime.ts, isolated process);
 *   - one range's numbers are never shown under another range's label, and a
 *     failure is never shown as zero (src/lib/analytics-view.ts);
 *   - money is withheld as a sentence, never zeroed, and never mixed across
 *     currencies;
 *   - a previous principal's analytics can never be served to the next one,
 *     and commerce writes refresh Analytics through the existing Home prefix;
 *   - the screen is wired to all of the above (comment-stripped source scans —
 *     no DOM test environment in this repository).
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import {
  averageOrderValue,
  classifyAnalyticsError,
  analyticsPeriodDays,
  financeUnavailableKey,
  isEmptyPeriod,
  repeatRatePercent,
  resolveAnalyticsSection,
  type BusinessSummary,
} from "@/lib/analytics-view";
import { analyticsKeys } from "@/lib/analytics-query";
import {
  HOME_QUERY_PREFIX,
  clearHomeQueries,
  enforceHomeCachePrincipal,
  homeQueryKey,
} from "@/lib/home-query";
import { createFixtureCapabilityView } from "@/lib/capabilities";
import { filterBusinessNavConfig, getBusinessNavConfig } from "@/design-system/mobile-nav-config";
import en from "../locales/en.json";
import km from "../locales/km.json";

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SCREEN = stripComments(readFileSync(resolve("src/routes/app.analytics.tsx"), "utf8"));

function summary(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    range: "today",
    from: "2026-09-27T17:00:00.000Z",
    until: "2026-09-28T17:00:00.000Z",
    orderCount: 3,
    finance: {
      status: "available",
      data: {
        orderedGross: [{ amount: 1000, currency: "USD" }],
        collectedGross: [{ amount: 500, currency: "USD" }],
        refundedAmount: [],
        outstandingAmount: [{ amount: 500, currency: "USD" }],
      },
    },
    lifecycleStatusCounts: {} as never,
    paymentStatusCounts: {} as never,
    fulfillmentStatusCounts: {} as never,
    refundStatusCounts: {} as never,
    paymentMethodCounts: {} as never,
    delivery: { status: "permission_denied" },
    ...overrides,
  };
}

it("the Analytics wrappers call the real server functions and fail honestly", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/analytics-ui.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 70000);

// ── States ────────────────────────────────────────────────────────────────────

describe("one range's numbers are never shown under another range's label", () => {
  it("ready only when the payload describes the selected range", () => {
    const today = summary({ range: "today" });
    expect(
      resolveAnalyticsSection({ range: "today", data: today, isError: false, error: null }),
    ).toEqual({ kind: "ready", data: today });
    // Switched to Week while Today's payload is still held: loading, not Today's numbers.
    expect(
      resolveAnalyticsSection({ range: "week", data: today, isError: false, error: null }).kind,
    ).toBe("loading");
  });

  it("an error with only another range's data is an error, never that data and never zero", () => {
    const view = resolveAnalyticsSection({
      range: "month",
      data: summary({ range: "today" }),
      isError: true,
      error: new Error("fetch failed"),
    });
    expect(view).toEqual({ kind: "error", error: "error" });
  });

  it("denied is distinct from failed", () => {
    const denied = Object.assign(new Error("Missing permission: analytics.read"), {
      statusCode: 403,
    });
    expect(classifyAnalyticsError(denied)).toBe("forbidden");
    expect(classifyAnalyticsError(Object.assign(new Error("x"), { statusCode: 401 }))).toBe(
      "unauthorized",
    );
    expect(classifyAnalyticsError(new Error("timeout"))).toBe("error");
  });

  it("empty is a server answer (zero qualifying orders), never loading or failure", () => {
    expect(isEmptyPeriod({ kind: "ready", data: summary({ orderCount: 0 }) })).toBe(true);
    expect(isEmptyPeriod({ kind: "ready", data: summary({ orderCount: 1 }) })).toBe(false);
    expect(isEmptyPeriod({ kind: "loading" })).toBe(false);
    expect(isEmptyPeriod({ kind: "error", error: "error" })).toBe(false);
  });
});

// ── Money truthfulness ────────────────────────────────────────────────────────

describe("money is withheld as a sentence, never zeroed, never mixed across currencies", () => {
  it("each non-available finance status has its own copy, all present in the locale", () => {
    const keys = (["permission_denied", "truncated", "error"] as const).map(financeUnavailableKey);
    expect(new Set(keys).size).toBe(3);
    const money = (en as { analytics: { money: Record<string, string> } }).analytics.money;
    for (const key of keys) expect(money[key.split(".").pop()!]).toBeTruthy();
  });

  it("average order is integer minor units in the order currency (round half up)", () => {
    expect(averageOrderValue(summary())).toEqual({ amount: 333, currency: "USD" });
    const khr = summary({
      orderCount: 3,
      finance: {
        status: "available",
        data: {
          orderedGross: [{ amount: 100_000, currency: "KHR" }],
          collectedGross: [],
          refundedAmount: [],
          outstandingAmount: [],
        },
      },
    });
    expect(averageOrderValue(khr)).toEqual({ amount: 33_333, currency: "KHR" });
  });

  it("average order is exact beyond float precision", () => {
    const big = summary({
      orderCount: 2,
      finance: {
        status: "available",
        data: {
          orderedGross: [{ amount: Number.MAX_SAFE_INTEGER, currency: "KHR" }],
          collectedGross: [],
          refundedAmount: [],
          outstandingAmount: [],
        },
      },
    });
    expect(averageOrderValue(big)).toEqual({ amount: 4503599627370496, currency: "KHR" });
  });

  it("refuses an average for mixed currencies, withheld money, or no orders", () => {
    const mixed = summary({
      finance: {
        status: "available",
        data: {
          orderedGross: [
            { amount: 1000, currency: "USD" },
            { amount: 40000, currency: "KHR" },
          ],
          collectedGross: [],
          refundedAmount: [],
          outstandingAmount: [],
        },
      },
    });
    expect(averageOrderValue(mixed)).toBeNull();
    expect(averageOrderValue(summary({ finance: { status: "permission_denied" } }))).toBeNull();
    expect(averageOrderValue(summary({ orderCount: 0 }))).toBeNull();
  });

  it("an undefined repeat rate stays undefined, never 0%", () => {
    expect(repeatRatePercent(null)).toBeNull();
    expect(repeatRatePercent(1 / 3)).toBe(33);
  });
});

// ── Time range ────────────────────────────────────────────────────────────────

describe("the caption states the exact period the server measured", () => {
  it("one day for Today (until is exclusive)", () => {
    // 28 Sep 00:00 ICT → 29 Sep 00:00 ICT.
    expect(analyticsPeriodDays("2026-09-27T17:00:00.000Z", "2026-09-28T17:00:00.000Z")).toEqual({
      first: { year: 2026, month: 9, day: 28 },
      last: null,
    });
  });

  it("first to last day on the Cambodia calendar, not UTC's", () => {
    // Monday 22 Sep 00:00 ICT is still 21 Sep in UTC.
    expect(analyticsPeriodDays("2026-09-21T17:00:00.000Z", "2026-09-28T17:00:00.000Z")).toEqual({
      first: { year: 2026, month: 9, day: 22 },
      last: { year: 2026, month: 9, day: 28 },
    });
  });

  it("a whole month ends on its last day", () => {
    expect(
      analyticsPeriodDays("2026-08-31T17:00:00.000Z", "2026-09-30T17:00:00.000Z").last,
    ).toEqual({ year: 2026, month: 9, day: 30 });
  });

  it("month names come from the locale files in both languages, not browser Intl data", () => {
    for (const locale of [en, km] as Array<{ analytics: { months: Record<string, string> } }>) {
      for (let month = 1; month <= 12; month += 1) {
        expect(locale.analytics.months[String(month)]).toBeTruthy();
      }
    }
    expect(SCREEN).toContain("t(`analytics.months.${date.month}`)");
    expect(SCREEN).not.toMatch(/Intl\.DateTimeFormat/);
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe("analytics cache: principal-scoped and refreshed by commerce writes", () => {
  it("every analytics key lives under Home's prefix, partitioned by user and organization", () => {
    for (const key of [
      analyticsKeys.summary("u", "o", "today"),
      analyticsKeys.topSellers("u", "o", "week", 5),
      analyticsKeys.customers("u", "o", "month"),
    ]) {
      expect(key.slice(0, HOME_QUERY_PREFIX.length)).toEqual([...HOME_QUERY_PREFIX]);
      expect(key.slice(0, 5)).toEqual([...analyticsKeys.principal("u", "o")]);
    }
  });

  it("never collides with Home's own range entries", () => {
    const client = new QueryClient();
    client.setQueryData(homeQueryKey("u", "o", "today"), { home: true });
    client.setQueryData(analyticsKeys.summary("u", "o", "today"), { analytics: true });
    expect(client.getQueryData(homeQueryKey("u", "o", "today"))).toEqual({ home: true });
    expect(client.getQueryData(analyticsKeys.summary("u", "o", "today"))).toEqual({
      analytics: true,
    });
  });

  it("a different member or organization in the same tab never sees the previous analytics", () => {
    const client = new QueryClient();
    enforceHomeCachePrincipal(client, "user-a", "org-a");
    client.setQueryData(analyticsKeys.summary("user-a", "org-a", "today"), summary());

    enforceHomeCachePrincipal(client, "user-a", "org-b");
    expect(client.getQueryData(analyticsKeys.summary("user-a", "org-a", "today"))).toBeUndefined();
  });

  it("sign-out's clearHomeQueries removes analytics too", () => {
    const client = new QueryClient();
    client.setQueryData(analyticsKeys.customers("u", "o", "today"), { range: "today" });
    clearHomeQueries(client);
    expect(client.getQueryData(analyticsKeys.customers("u", "o", "today"))).toBeUndefined();
  });

  it("the HOME_QUERY_PREFIX invalidation every commerce write already performs refreshes analytics", async () => {
    const client = new QueryClient();
    const key = analyticsKeys.summary("u", "o", "week");
    client.setQueryData(key, summary({ range: "week" }));
    await client.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("the commerce write sites still invalidate HOME_QUERY_PREFIX", () => {
    for (const file of [
      "src/components/pos/PosCheckoutSheet.tsx",
      "src/routes/app.orders.tsx",
      "src/routes/app.orders.$id.tsx",
      "src/routes/app.payments.$id.tsx",
      "src/routes/app.inbox.$id.tsx",
      "src/lib/deliveries-query.ts",
    ]) {
      expect(stripComments(readFileSync(resolve(file), "utf8"))).toContain("HOME_QUERY_PREFIX");
    }
  });
});

// ── Navigation + screen wiring ────────────────────────────────────────────────

describe("Analytics entry and screen wiring", () => {
  it("the nav entry is gated on analytics.read", () => {
    const ids = (permissions: string[]) =>
      filterBusinessNavConfig(
        getBusinessNavConfig("online-seller"),
        createFixtureCapabilityView(permissions as never),
      )
        .salesGroups.flatMap((g) => g.actions)
        .map((a) => a.id);
    expect(ids(["orders.read"])).not.toContain("analytics");
    expect(ids(["analytics.read"])).toContain("analytics");
  });

  it("gates the screen on analytics.read and shows the denial rather than data", () => {
    expect(SCREEN).toContain('const canRead = capabilities.can("analytics.read");');
    expect(SCREEN).toContain("if (!canRead) return shell(<CapabilityDeniedState");
    expect(SCREEN.match(/enabled: canRead/g)?.length).toBe(3);
  });

  it("reads each metric through the range-safe resolver, keyed by the guard's principal", () => {
    expect(SCREEN.match(/resolveAnalyticsSection\(\{/g)?.length).toBe(3);
    expect(SCREEN).toContain("analyticsKeys.summary(userId, organizationId, range)");
    expect(SCREEN).toContain("analyticsKeys.customers(userId, organizationId, range)");
    expect(SCREEN).toMatch(/analyticsKeys\.topSellers\(userId, organizationId, range/);
  });

  it("uses no fixtures and no zero fallbacks", () => {
    expect(SCREEN).not.toMatch(/@\/lib\/mock/);
    expect(SCREEN).not.toMatch(/\?\?\s*0\b/);
    expect(SCREEN).not.toMatch(/\|\|\s*0\b/);
  });

  it("renders withheld money as the server's reason, and a null item amount as nothing", () => {
    expect(SCREEN).toContain("t(financeUnavailableKey(finance.status))");
    expect(SCREEN).toContain("item.grossAmount !== null ?");
  });

  it("offers exactly the ranges the backend accepts", () => {
    expect(SCREEN).toContain("ANALYTICS_RANGES.map");
    expect(readFileSync(resolve("src/api/analytics.ts"), "utf8")).toContain(
      'z.enum(["today", "week", "month"])',
    );
  });
});
