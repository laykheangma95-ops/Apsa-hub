/**
 * Analytics backend/read-model foundation — behavioral and structural tests.
 *
 * Mirrors the conventions in home-domain.test.ts (pure-function tests +
 * dependency-injected service tests + source-inspection query-safety tests)
 * and team-repository.test.ts (a call-recording fake Postgrest builder for the
 * one file, repository.ts, that actually talks to the DB).
 *
 * Run: bun test src/tests/analytics-foundation.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";
import { rangeBounds } from "../server/home/service";
import {
  aggregateTopSellingItems,
  chunkIds,
  getCustomerCohort,
  getDeliveryStatusCounts,
  getOrderStatusCounts,
  getPaymentMethodCounts,
  getSettlementTotals,
  listQualifyingOrders,
  listTopSellingItems,
  setAnalyticsRepositoryDbForTests,
  toMoneyList,
  type AnalyticsOrderRow,
} from "../server/analytics/repository";
import {
  computeRepeatOrderRate,
  getBusinessSummary,
  getCustomerSummary,
  getTopSellingItems,
  type AnalyticsDependencies,
} from "../server/analytics/service";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "11111111-0000-0000-0000-000000000001";

function source(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
}

function makeCtx(permissions: string[], organizationId = ORG_A, userId = USER_A) {
  const granted = new Set(permissions);
  return {
    userId,
    organizationId,
    roleId: "custom-role",
    systemRole: null,
    permissions: granted,
    can: (permission: string) => granted.has(permission),
    require: (permission: string) => {
      if (!granted.has(permission)) throw new ForbiddenError(`Missing permission: ${permission}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

function order(overrides: Partial<AnalyticsOrderRow> = {}): AnalyticsOrderRow {
  return {
    id: "order-1",
    currency: "USD",
    total_minor: 1000,
    customer_id: null,
    created_at: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function dependencies(overrides: Partial<AnalyticsDependencies> = {}): AnalyticsDependencies {
  return {
    listQualifyingOrders: async () => [],
    getOrderStatusCounts: async () => ({
      lifecycleStatusCounts: { draft: 0, confirmed: 0, completed: 0, cancelled: 0 },
      paymentStatusCounts: { unpaid: 0, pending: 0, paid: 0, failed: 0 },
      fulfillmentStatusCounts: { unfulfilled: 0, processing: 0, fulfilled: 0, cancelled: 0 },
      refundStatusCounts: { none: 0, partial: 0, full: 0 },
    }),
    getSettlementTotals: async () => ({
      orderedGross: [],
      collectedGross: [],
      refundedAmount: [],
      outstandingAmount: [],
    }),
    getPaymentMethodCounts: async () => ({ cash: 0, khqr: 0, bank_transfer: 0, cod: 0 }),
    getDeliveryStatusCounts: async () => ({
      pending: 0,
      preparing: 0,
      ready: 0,
      in_transit: 0,
      delivered: 0,
      failed: 0,
      cancelled: 0,
    }),
    listTopSellingItems: async () => [],
    getCustomerCohort: async () => ({
      totalCustomers: 0,
      newCustomers: 0,
      repeatCustomers: 0,
      unattributedOrderCount: 0,
      repeatOrderCount: 0,
    }),
    ...overrides,
  };
}

// ── Fake Postgrest builder for repository.ts behavioral tests ────────────────

type Row = Record<string, unknown>;

/**
 * Minimal in-memory Postgrest stand-in. `pageCap` simulates a server that
 * returns fewer rows than requested per page (like a PostgREST db.max_rows
 * setting below our page size), so a repository function that does not
 * genuinely walk every page will fail these tests instead of silently
 * truncating.
 */
function makeFakeDb(tables: Record<string, Row[]>, pageCap = Infinity) {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let rangeArgs: [number, number] | null = null;
      let countMode = false;
      let headOnly = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select(_cols: string, opts?: { count?: "exact"; head?: boolean }) {
          if (opts?.count === "exact") countMode = true;
          if (opts?.head) headOnly = true;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((row) => row[col] === val);
          return builder;
        },
        in(col: string, vals: readonly unknown[]) {
          const set = new Set(vals);
          filters.push((row) => set.has(row[col]));
          return builder;
        },
        gte(col: string, val: unknown) {
          filters.push((row) => (row[col] as string) >= (val as string));
          return builder;
        },
        lt(col: string, val: unknown) {
          filters.push((row) => (row[col] as string) < (val as string));
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          rangeArgs = [from, to];
          return builder;
        },
        then(resolve: (value: unknown) => void) {
          const all = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
          const total = all.length;
          let page = all;
          if (rangeArgs) {
            const [from, to] = rangeArgs;
            const cappedTo = Math.min(to, from + pageCap - 1);
            page = all.slice(from, cappedTo + 1);
          }
          resolve({
            data: headOnly ? null : page,
            error: null,
            count: countMode ? total : null,
          });
        },
      };
      return builder;
    },
  };
}

describe("Analytics repository — tenant isolation", () => {
  it("never returns another organization's orders even under identical filters", async () => {
    const restore = setAnalyticsRepositoryDbForTests(
      makeFakeDb({
        orders: [
          order({ id: "a-1", customer_id: null }),
          { ...order({ id: "b-1" }), organization_id: ORG_B },
        ].map((row, index) => ({
          ...row,
          organization_id: index === 0 ? ORG_A : ORG_B,
          lifecycle_status: "confirmed",
        })),
      }),
    );
    try {
      const rows = await listQualifyingOrders(ORG_A, {
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      });
      expect(rows.map((r) => r.id)).toEqual(["a-1"]);
    } finally {
      restore();
    }
  });

  it("keeps guessed org-B customer ids from ever being credited as Org A repeat customers", async () => {
    const restore = setAnalyticsRepositoryDbForTests(
      makeFakeDb({
        orders: [
          {
            organization_id: ORG_B,
            customer_id: "shared-id-guess",
            lifecycle_status: "confirmed",
            created_at: "2020-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    try {
      const cohort = await getCustomerCohort(
        ORG_A,
        [
          order({
            id: "o-1",
            customer_id: "shared-id-guess",
            created_at: "2026-09-10T00:00:00.000Z",
          }),
        ],
        { from: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" },
      );
      // Org B's much-older order for the same customer id must not count as
      // Org A's prior history — the fake table has zero Org-A rows.
      expect(cohort.newCustomers).toBe(1);
      expect(cohort.repeatCustomers).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("Analytics repository — completeness under a capped page", () => {
  it("walks a 1,205-row qualifying-order cohort even when the server caps pages at 50", async () => {
    const rows = Array.from({ length: 1_205 }, (_, index) => ({
      id: `order-${index}`,
      organization_id: ORG_A,
      currency: "USD",
      total_minor: 100,
      customer_id: null,
      created_at: "2026-09-10T10:00:00.000Z",
      lifecycle_status: "confirmed",
    }));
    const restore = setAnalyticsRepositoryDbForTests(makeFakeDb({ orders: rows }, 50));
    try {
      const result = await listQualifyingOrders(ORG_A, {
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      });
      expect(result.length).toBe(1_205);
    } finally {
      restore();
    }
  });

  it("walks order_items across a >100-order chunk boundary without dropping lines", async () => {
    const orders = Array.from({ length: 150 }, (_, index) =>
      order({ id: `order-${index}`, currency: "USD" }),
    );
    const items = orders.map((o, index) => ({
      order_id: o.id,
      organization_id: ORG_A,
      product_id: "product-1",
      variant_id: "variant-1",
      product_name_snapshot: "Iced Coffee",
      variant_name_snapshot: null,
      quantity: 1,
      line_total_minor: 100,
      id: `item-${index}`,
    }));
    const restore = setAnalyticsRepositoryDbForTests(makeFakeDb({ order_items: items }, 40));
    try {
      const top = await listTopSellingItems(ORG_A, orders, 10);
      expect(top).toEqual([
        {
          productId: "product-1",
          variantId: "variant-1",
          currency: "USD",
          displayLabel: "Iced Coffee",
          quantitySold: 150,
          grossAmount: 15_000,
        },
      ]);
    } finally {
      restore();
    }
  });
});

describe("Analytics repository — financial truth", () => {
  it("separates currencies, floors outstanding at zero, and never discards an overpayment from collected", async () => {
    const orders = [
      order({ id: "unpaid", currency: "USD", total_minor: 1_000 }),
      order({ id: "partial-refund", currency: "USD", total_minor: 1_000 }),
      order({ id: "overpaid", currency: "USD", total_minor: 1_000 }),
      order({ id: "khr-order", currency: "KHR", total_minor: 4_000 }),
    ];
    const restore = setAnalyticsRepositoryDbForTests(
      makeFakeDb({
        order_payment_totals: [
          {
            order_id: "unpaid",
            organization_id: ORG_A,
            currency: "USD",
            total_minor: 1_000,
            received_minor: 0,
            refunded_minor: 0,
          },
          {
            order_id: "partial-refund",
            organization_id: ORG_A,
            currency: "USD",
            total_minor: 1_000,
            received_minor: 1_000,
            refunded_minor: 200,
          },
          {
            order_id: "overpaid",
            organization_id: ORG_A,
            currency: "USD",
            total_minor: 1_000,
            received_minor: 1_200,
            refunded_minor: 0,
          },
          {
            order_id: "khr-order",
            organization_id: ORG_A,
            currency: "KHR",
            total_minor: 4_000,
            received_minor: 4_000,
            refunded_minor: 0,
          },
        ],
      }),
    );
    try {
      const totals = await getSettlementTotals(ORG_A, orders);
      expect(totals.orderedGross).toEqual([
        { currency: "KHR", amount: 4_000 },
        { currency: "USD", amount: 3_000 },
      ]);
      // Collected is gross received, including the overpayment — never discarded.
      expect(totals.collectedGross).toEqual([
        { currency: "KHR", amount: 4_000 },
        { currency: "USD", amount: 2_200 },
      ]);
      expect(totals.refundedAmount).toEqual([
        { currency: "KHR", amount: 0 },
        { currency: "USD", amount: 200 },
      ]);
      // unpaid: 1000 outstanding. partial-refund: fully received, 0 outstanding
      // (refund is reported separately, never re-added to outstanding).
      // overpaid: floored at 0, not negative.
      expect(totals.outstandingAmount).toEqual([
        { currency: "KHR", amount: 0 },
        { currency: "USD", amount: 1_000 },
      ]);
    } finally {
      restore();
    }
  });

  it("chunks settlement lookups past 100 orders and still proves a complete cohort", async () => {
    const orders = Array.from({ length: 130 }, (_, index) =>
      order({ id: `order-${index}`, currency: "USD", total_minor: 100 }),
    );
    const totalsRows = orders.map((o) => ({
      order_id: o.id,
      organization_id: ORG_A,
      currency: "USD",
      total_minor: 100,
      received_minor: 100,
      refunded_minor: 0,
    }));
    const restore = setAnalyticsRepositoryDbForTests(
      makeFakeDb({ order_payment_totals: totalsRows }),
    );
    try {
      const totals = await getSettlementTotals(ORG_A, orders);
      expect(totals.collectedGross).toEqual([{ currency: "USD", amount: 13_000 }]);
    } finally {
      restore();
    }
  });

  it("throws rather than silently under-counting when a chunk's settlement rows are incomplete", async () => {
    const orders = [order({ id: "missing-row" })];
    const restore = setAnalyticsRepositoryDbForTests(makeFakeDb({ order_payment_totals: [] }));
    try {
      await expect(getSettlementTotals(ORG_A, orders)).rejects.toThrow("incomplete order cohort");
    } finally {
      restore();
    }
  });
});

describe("Analytics repository — exact-count status mixes", () => {
  it("counts every order status axis via exact head counts, not a fetched-and-counted page", async () => {
    const rows = [
      {
        organization_id: ORG_A,
        lifecycle_status: "draft",
        payment_status: "unpaid",
        fulfillment_status: "unfulfilled",
        refund_status: "none",
        created_at: "2026-09-10T00:00:00.000Z",
      },
      {
        organization_id: ORG_A,
        lifecycle_status: "confirmed",
        payment_status: "paid",
        fulfillment_status: "fulfilled",
        refund_status: "none",
        created_at: "2026-09-10T00:00:00.000Z",
      },
      {
        organization_id: ORG_A,
        lifecycle_status: "cancelled",
        payment_status: "unpaid",
        fulfillment_status: "cancelled",
        refund_status: "none",
        created_at: "2026-09-10T00:00:00.000Z",
      },
    ];
    const restore = setAnalyticsRepositoryDbForTests(makeFakeDb({ orders: rows }));
    try {
      const counts = await getOrderStatusCounts(ORG_A, {
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      });
      expect(counts.lifecycleStatusCounts).toEqual({
        draft: 1,
        confirmed: 1,
        completed: 0,
        cancelled: 1,
      });
      expect(counts.paymentStatusCounts.paid).toBe(1);
      expect(counts.paymentStatusCounts.unpaid).toBe(2);
    } finally {
      restore();
    }
  });

  it("counts payments by method within the period and deliveries by status", async () => {
    const restorePayments = setAnalyticsRepositoryDbForTests(
      makeFakeDb({
        payments: [
          { organization_id: ORG_A, method: "cash", created_at: "2026-09-10T00:00:00.000Z" },
          { organization_id: ORG_A, method: "khqr", created_at: "2026-09-10T00:00:00.000Z" },
          { organization_id: ORG_A, method: "khqr", created_at: "2026-09-10T00:00:00.000Z" },
        ],
      }),
    );
    try {
      const counts = await getPaymentMethodCounts(ORG_A, {
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      });
      expect(counts).toEqual({ cash: 1, khqr: 2, bank_transfer: 0, cod: 0 });
    } finally {
      restorePayments();
    }

    const restoreDeliveries = setAnalyticsRepositoryDbForTests(
      makeFakeDb({
        deliveries: [
          { organization_id: ORG_A, status: "delivered", created_at: "2026-09-10T00:00:00.000Z" },
          { organization_id: ORG_A, status: "failed", created_at: "2026-09-10T00:00:00.000Z" },
        ],
      }),
    );
    try {
      const counts = await getDeliveryStatusCounts(ORG_A, {
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      });
      expect(counts.delivered).toBe(1);
      expect(counts.failed).toBe(1);
      expect(counts.pending).toBe(0);
    } finally {
      restoreDeliveries();
    }
  });
});

describe("Analytics pure aggregation helpers", () => {
  it("toMoneyList sorts by currency and never mixes amounts across currencies", () => {
    const totals = new Map<"USD" | "KHR", number>([
      ["KHR", 5_000],
      ["USD", 1_000],
    ]);
    expect(toMoneyList(totals)).toEqual([
      { currency: "KHR", amount: 5_000 },
      { currency: "USD", amount: 1_000 },
    ]);
  });

  it("chunkIds splits into the requested size, including a short final chunk", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 2)).toEqual([]);
  });

  it("aggregateTopSellingItems keeps the same product in different currencies separate", () => {
    const items = [
      {
        order_id: "o1",
        product_id: "p1",
        variant_id: "v1",
        product_name_snapshot: "Shirt",
        variant_name_snapshot: "L",
        quantity: 2,
        line_total_minor: 2_000,
      },
      {
        order_id: "o2",
        product_id: "p1",
        variant_id: "v1",
        product_name_snapshot: "Shirt",
        variant_name_snapshot: "L",
        quantity: 1,
        line_total_minor: 40_000,
      },
    ];
    const currencyByOrder = new Map([
      ["o1", "USD" as const],
      ["o2", "KHR" as const],
    ]);
    const result = aggregateTopSellingItems(items, currencyByOrder, 10);
    // Sorted by quantitySold desc first — USD (2 units) ranks above KHR (1 unit)
    // even though the KHR line's gross amount is larger. Currencies stay separate rows.
    expect(result).toEqual([
      {
        productId: "p1",
        variantId: "v1",
        currency: "USD",
        displayLabel: "Shirt — L",
        quantitySold: 2,
        grossAmount: 2_000,
      },
      {
        productId: "p1",
        variantId: "v1",
        currency: "KHR",
        displayLabel: "Shirt — L",
        quantitySold: 1,
        grossAmount: 40_000,
      },
    ]);
  });

  it("computeRepeatOrderRate returns null rather than a manufactured zero with no attributed orders", () => {
    expect(computeRepeatOrderRate(5, 5, 0)).toBeNull();
    expect(computeRepeatOrderRate(0, 0, 0)).toBeNull();
    expect(computeRepeatOrderRate(10, 4, 3)).toBe(0.5);
  });
});

describe("Analytics service — permissions and tenancy", () => {
  it("requires analytics.read for every entry point", async () => {
    await expect(getBusinessSummary(makeCtx([]), "today", dependencies())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(getCustomerSummary(makeCtx([]), "today", dependencies())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      getTopSellingItems(makeCtx([]), "today", 10, dependencies()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("passes only the caller's own organization to every dependency", async () => {
    const seen: string[] = [];
    const deps = dependencies({
      listQualifyingOrders: async (organizationId) => {
        seen.push(organizationId);
        return [];
      },
      getOrderStatusCounts: async (organizationId) => {
        seen.push(organizationId);
        return {
          lifecycleStatusCounts: { draft: 0, confirmed: 0, completed: 0, cancelled: 0 },
          paymentStatusCounts: { unpaid: 0, pending: 0, paid: 0, failed: 0 },
          fulfillmentStatusCounts: { unfulfilled: 0, processing: 0, fulfilled: 0, cancelled: 0 },
          refundStatusCounts: { none: 0, partial: 0, full: 0 },
        };
      },
      getSettlementTotals: async (organizationId) => {
        seen.push(organizationId);
        return { orderedGross: [], collectedGross: [], refundedAmount: [], outstandingAmount: [] };
      },
      getPaymentMethodCounts: async (organizationId) => {
        seen.push(organizationId);
        return { cash: 0, khqr: 0, bank_transfer: 0, cod: 0 };
      },
    });
    await getBusinessSummary(makeCtx(["analytics.read"], ORG_B), "today", deps);
    expect(new Set(seen)).toEqual(new Set([ORG_B]));
  });

  it("withholds delivery counts (not zero) without delivery.read, and returns them with it", async () => {
    const deps = dependencies({
      getDeliveryStatusCounts: async () => ({
        pending: 1,
        preparing: 0,
        ready: 0,
        in_transit: 0,
        delivered: 2,
        failed: 0,
        cancelled: 0,
      }),
    });
    const without = await getBusinessSummary(makeCtx(["analytics.read"]), "today", deps);
    expect(without.delivery).toEqual({ status: "permission_denied" });

    const withIt = await getBusinessSummary(
      makeCtx(["analytics.read", "delivery.read"]),
      "today",
      deps,
    );
    expect(withIt.delivery).toEqual({
      status: "available",
      data: {
        statusCounts: {
          pending: 1,
          preparing: 0,
          ready: 0,
          in_transit: 0,
          delivered: 2,
          failed: 0,
          cancelled: 0,
        },
      },
    });
  });

  it("bounds a caller-supplied top-selling limit instead of trusting it directly", async () => {
    let seenLimit = -1;
    const deps = dependencies({
      listTopSellingItems: async (_org, _orders, limit) => {
        seenLimit = limit;
        return [];
      },
    });
    await getTopSellingItems(makeCtx(["analytics.read"]), "today", 999_999, deps);
    expect(seenLimit).toBe(100);
    await getTopSellingItems(makeCtx(["analytics.read"]), "today", -5, deps);
    expect(seenLimit).toBe(1);
  });

  it("computes repeatOrderRate end to end from the customer cohort", async () => {
    const deps = dependencies({
      listQualifyingOrders: async () => [order(), order({ id: "order-2" })],
      getCustomerCohort: async () => ({
        totalCustomers: 1,
        newCustomers: 0,
        repeatCustomers: 1,
        unattributedOrderCount: 0,
        repeatOrderCount: 2,
      }),
    });
    const summary = await getCustomerSummary(makeCtx(["analytics.read"]), "today", deps);
    expect(summary.repeatOrderRate).toBe(1);
  });
});

describe("Analytics time semantics — reuses Home's Phnom Penh calendar, no second implementation", () => {
  it("service.ts imports Home's rangeBounds rather than defining its own", () => {
    const serviceSource = source("src/server/analytics/service.ts");
    expect(serviceSource).toContain('import { rangeBounds } from "@/server/home/service"');
    expect(serviceSource).not.toMatch(/function rangeBounds/);
  });

  it("today/week/month bounds match Home's existing Cambodia-calendar convention", () => {
    const now = new Date("2026-09-10T17:01:00.000Z");
    expect(rangeBounds("today", now)).toEqual({
      from: "2026-09-10T17:00:00.000Z",
      until: "2026-09-11T17:00:00.000Z",
    });
  });
});

describe("Analytics query safety and bundle boundary", () => {
  it("scopes every repository query to organization_id and never hard-codes an org", () => {
    const repository = source("src/server/analytics/repository.ts");
    expect(repository.match(/\.eq\("organization_id", organizationId\)/g)?.length).toBeGreaterThan(
      5,
    );
    expect(repository).not.toContain(ORG_A);
    expect(repository).not.toContain(ORG_B);
    expect(repository).not.toMatch(/\.limit\(1000|\.limit\(10000/);
    expect(repository).toContain("collectCompletePages<AnalyticsOrderRow>");
    expect(repository).toContain('{ count: "exact", head: true }');
  });

  it("never accepts organizationId or userId from the client in the API boundary", () => {
    const api = source("src/api/analytics.ts");
    expect(api).toContain('.eq("user_id", session.userId)');
    expect(api).toContain("AuthorizationService.forRequest");
    expect(api).not.toMatch(/z\.object\(\{[^}]*organizationId/s);
    expect(api).not.toMatch(/z\.object\(\{[^}]*userId/s);
  });

  it("keeps server-only imports inside handler bodies, never at module top level", () => {
    const api = source("src/api/analytics.ts");
    const staticImportLines = api
      .split("\n")
      .filter(
        (line) => line.trim().startsWith("import ") && !line.trim().startsWith("import type"),
      );
    for (const line of staticImportLines) {
      expect(line).not.toContain("@/lib/supabase/server");
      expect(line).not.toContain("@/server/analytics/service");
      expect(line).not.toContain("@/server/auth/authorization");
    }
    expect(api).toContain('await import("@/server/analytics/service")');
    expect(api).toContain('await import("@/lib/supabase/server")');
  });

  it("gates every service export on analytics.read", () => {
    const serviceSource = source("src/server/analytics/service.ts");
    const requireCount = (serviceSource.match(/ctx\.require\("analytics\.read"\)/g) ?? []).length;
    expect(requireCount).toBe(3);
  });

  it("does not expose any staff-performance surface in this phase", () => {
    const serviceSource = source("src/server/analytics/service.ts");
    const apiSource = source("src/api/analytics.ts");
    // A code comment may legitimately explain the deferral (see types.ts); what
    // must never appear is an actual staff export, endpoint, or permission key.
    expect(serviceSource).not.toMatch(/export (async function|function|const) \w*[Ss]taff/);
    expect(serviceSource).not.toMatch(/staff_metrics|analytics\.staff/);
    expect(apiSource).not.toMatch(/staff/i);
  });

  it("CustomerSummary type carries no PII field names", () => {
    const typesSource = source("src/server/analytics/types.ts");
    const customerSummaryBlock = typesSource.slice(
      typesSource.indexOf("interface CustomerSummary"),
      typesSource.indexOf("interface CustomerSummary") + 600,
    );
    for (const field of ["phone", "email", "address", "display_name", "note", "evidence"]) {
      expect(customerSummaryBlock.toLowerCase()).not.toContain(field);
    }
  });
});
