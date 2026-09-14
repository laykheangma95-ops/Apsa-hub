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
import { setDeliveryRepositoryDbForTests } from "../server/deliveries/repository";
import { canReadFinancials, rangeBounds } from "../server/home/service";
import {
  aggregateTopSellingItems,
  chunkIds,
  compareTopSellingItems,
  getCustomerCohort,
  getDeliveryStatusCounts,
  getOrderStatusCounts,
  getPaymentMethodCounts,
  getSettlementTotals,
  listOrderIdsWithDeliveryInPeriod,
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

/**
 * The permissions a caller needs for Analytics money: domain entry plus the
 * Home domain's established financial visibility boundary. Deliberately
 * spelled out here rather than imported, so a silent widening of
 * `canReadFinancials` fails these tests instead of passing them.
 */
const FINANCIAL_PERMISSIONS = ["analytics.read", "orders.read", "payments.reconcile"];

/** SALES's real grant: analytics.read (migration 003) and ordinary order/payment reads — no reconcile. */
const SALES_PERMISSIONS = ["analytics.read", "orders.read", "payments.read"];

/** Sets BOTH db seams the latest-delivery path reads through to one fake. */
function withDeliveryDb<T>(tables: Record<string, Row[]>, run: () => Promise<T>): Promise<T> {
  const fake = makeFakeDb(tables);
  const restoreAnalytics = setAnalyticsRepositoryDbForTests(fake);
  const restoreDeliveries = setDeliveryRepositoryDbForTests(fake);
  return run().finally(() => {
    restoreDeliveries();
    restoreAnalytics();
  });
}

/** A delivery attempt row for the fake `deliveries` table. */
function attempt(
  id: string,
  orderId: string,
  status: string,
  createdAt: string,
  organizationId = ORG_A,
): Row {
  return {
    id,
    order_id: orderId,
    status,
    created_at: createdAt,
    organization_id: organizationId,
  };
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
      statusCounts: {
        pending: 0,
        preparing: 0,
        ready: 0,
        in_transit: 0,
        delivered: 0,
        failed: 0,
        cancelled: 0,
      },
      unresolved: false,
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
      const sortKeys: Array<{ col: string; ascending: boolean }> = [];
      let rangeArgs: [number, number] | null = null;
      let limitArg: number | null = null;
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
        order(col: string, opts?: { ascending?: boolean }) {
          sortKeys.push({ col, ascending: opts?.ascending !== false });
          return builder;
        },
        limit(n: number) {
          limitArg = n;
          return builder;
        },
        range(from: number, to: number) {
          rangeArgs = [from, to];
          return builder;
        },
        then(resolve: (value: unknown) => void) {
          const all = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
          // Real ordering, not a no-op: latest-attempt resolution is defined by
          // `created_at DESC, id DESC`, so a fake that ignores .order() would
          // pass a query that picks the wrong attempt.
          if (sortKeys.length > 0) {
            all.sort((a, b) => {
              for (const key of sortKeys) {
                const left = a[key.col];
                const right = b[key.col];
                if (left === right) continue;
                if (left === undefined) return 1;
                if (right === undefined) return -1;
                const cmp = (left as string) < (right as string) ? -1 : 1;
                return key.ascending ? cmp : -cmp;
              }
              return 0;
            });
          }
          const total = all.length;
          let page = all;
          if (rangeArgs) {
            const [from, to] = rangeArgs;
            const cappedTo = Math.min(to, from + pageCap - 1);
            page = all.slice(from, cappedTo + 1);
          } else if (limitArg !== null) {
            page = all.slice(0, Math.min(limitArg, pageCap));
          }
          if (limitArg === null && !rangeArgs && page.length > pageCap) {
            page = page.slice(0, pageCap);
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

    const counts = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "o1", "delivered", "2026-09-10T00:00:00.000Z"),
          attempt("d2", "o2", "failed", "2026-09-10T00:00:00.000Z"),
        ],
      },
      () =>
        getDeliveryStatusCounts(ORG_A, {
          from: "2026-09-01T00:00:00.000Z",
          until: "2026-10-01T00:00:00.000Z",
        }),
    );
    expect(counts.statusCounts.delivered).toBe(1);
    expect(counts.statusCounts.failed).toBe(1);
    expect(counts.statusCounts.pending).toBe(0);
    expect(counts.unresolved).toBe(false);
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
    // (Equal-quantity cross-currency ordering is proved separately below.)
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
      getDeliveryStatusCounts: async (organizationId) => {
        seen.push(organizationId);
        return {
          statusCounts: {
            pending: 0,
            preparing: 0,
            ready: 0,
            in_transit: 0,
            delivered: 0,
            failed: 0,
            cancelled: 0,
          },
          unresolved: false,
        };
      },
      getPaymentMethodCounts: async (organizationId) => {
        seen.push(organizationId);
        return { cash: 0, khqr: 0, bank_transfer: 0, cod: 0 };
      },
    });
    // Fully-authorized caller, so every dependency — including the protected
    // settlement read and the delivery read — actually runs and is checked.
    await getBusinessSummary(
      makeCtx([...FINANCIAL_PERMISSIONS, "delivery.read"], ORG_B),
      "today",
      deps,
    );
    expect(new Set(seen)).toEqual(new Set([ORG_B]));
  });

  it("withholds delivery counts (not zero) without delivery.read, and returns them with it", async () => {
    const deps = dependencies({
      getDeliveryStatusCounts: async () => ({
        statusCounts: {
          pending: 1,
          preparing: 0,
          ready: 0,
          in_transit: 0,
          delivered: 2,
          failed: 0,
          cancelled: 0,
        },
        unresolved: false,
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
    expect(serviceSource).toMatch(
      /import \{[^}]*\brangeBounds\b[^}]*\} from "@\/server\/home\/service"/,
    );
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

// ═══════════════════════════════════════════════════════════════════════════════
// P1 (independent review) — FINANCIAL AUTHORIZATION BOUNDARY
//
// Analytics exposed collected/refunded/outstanding totals on `analytics.read`
// alone. `analytics.read` is granted to SALES (migration 003), while the Home
// domain already places money behind `orders.read` AND `payments.reconcile`.
// A Sales member could therefore read the org's settlement position in
// Analytics that the same member is denied on Home. Analytics now imports that
// one boundary (`canReadFinancials`) instead of defining a second one.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Analytics financial boundary — the established orders.read + payments.reconcile rule", () => {
  const settlement = {
    orderedGross: [{ currency: "USD" as const, amount: 90_000 }],
    collectedGross: [{ currency: "USD" as const, amount: 70_000 }],
    refundedAmount: [{ currency: "USD" as const, amount: 5_000 }],
    outstandingAmount: [{ currency: "USD" as const, amount: 20_000 }],
  };

  function financialDeps(onSettlementRead?: () => void) {
    return dependencies({
      listQualifyingOrders: async () => [order({ id: "o-1", total_minor: 90_000 })],
      getSettlementTotals: async () => {
        onSettlementRead?.();
        return settlement;
      },
      listTopSellingItems: async () => [
        {
          productId: "p1",
          variantId: "v1",
          currency: "USD" as const,
          displayLabel: "Iced Coffee",
          quantitySold: 12,
          grossAmount: 36_000,
        },
      ],
    });
  }

  it("is the same predicate Home enforces, not an Analytics-local copy", () => {
    expect(canReadFinancials(makeCtx(["orders.read", "payments.reconcile"]))).toBe(true);
    expect(canReadFinancials(makeCtx(["orders.read", "payments.read"]))).toBe(false);
    expect(canReadFinancials(makeCtx(["payments.reconcile"]))).toBe(false);
    expect(canReadFinancials(makeCtx([]))).toBe(false);

    // Analytics must import it rather than restate the expression.
    const serviceSource = source("src/server/analytics/service.ts");
    expect(serviceSource).toMatch(
      /import \{[^}]*\bcanReadFinancials\b[^}]*\} from "@\/server\/home\/service"/,
    );
    expect(serviceSource).not.toMatch(/ctx\.can\("payments\.reconcile"\)/);
  });

  it("SALES (analytics.read, no payments.reconcile) cannot read protected financial totals", async () => {
    const summary = await getBusinessSummary(makeCtx(SALES_PERMISSIONS), "today", financialDeps());

    // Withheld as a denial — never a fabricated zero.
    expect(summary.finance).toEqual({ status: "permission_denied" });
    expect(JSON.stringify(summary)).not.toContain("70000");
    expect(JSON.stringify(summary)).not.toContain("collectedGross");
    expect(JSON.stringify(summary)).not.toContain("outstandingAmount");
  });

  it("never even issues the settlement read for a caller outside the boundary", async () => {
    let settlementReads = 0;
    await getBusinessSummary(
      makeCtx(SALES_PERMISSIONS),
      "today",
      financialDeps(() => {
        settlementReads += 1;
      }),
    );
    expect(settlementReads).toBe(0);

    await getBusinessSummary(
      makeCtx(FINANCIAL_PERMISSIONS),
      "today",
      financialDeps(() => {
        settlementReads += 1;
      }),
    );
    expect(settlementReads).toBe(1);
  });

  it("holding payments.read instead of payments.reconcile is not enough", async () => {
    const summary = await getBusinessSummary(
      makeCtx(["analytics.read", "orders.read", "payments.read"]),
      "today",
      financialDeps(),
    );
    expect(summary.finance.status).toBe("permission_denied");
  });

  it("holding payments.reconcile without orders.read is not enough either", async () => {
    const summary = await getBusinessSummary(
      makeCtx(["analytics.read", "payments.reconcile"]),
      "today",
      financialDeps(),
    );
    expect(summary.finance.status).toBe("permission_denied");
  });

  it("authorized Owner/Manager paths still receive the full financial totals", async () => {
    const summary = await getBusinessSummary(
      makeCtx(FINANCIAL_PERMISSIONS),
      "today",
      financialDeps(),
    );
    expect(summary.finance).toEqual({ status: "available", data: settlement });
  });

  it("preserves every non-financial metric for a caller with analytics.read only", async () => {
    const deps = dependencies({
      listQualifyingOrders: async () => [order({ id: "o-1" }), order({ id: "o-2" })],
      getOrderStatusCounts: async () => ({
        lifecycleStatusCounts: { draft: 1, confirmed: 2, completed: 3, cancelled: 0 },
        paymentStatusCounts: { unpaid: 1, pending: 0, paid: 5, failed: 0 },
        fulfillmentStatusCounts: { unfulfilled: 2, processing: 0, fulfilled: 4, cancelled: 0 },
        refundStatusCounts: { none: 6, partial: 0, full: 0 },
      }),
      getPaymentMethodCounts: async () => ({ cash: 3, khqr: 4, bank_transfer: 0, cod: 1 }),
    });
    const summary = await getBusinessSummary(makeCtx(["analytics.read"]), "today", deps);

    expect(summary.finance.status).toBe("permission_denied");
    // …while everything non-financial still answers truthfully.
    expect(summary.orderCount).toBe(2);
    expect(summary.lifecycleStatusCounts).toEqual({
      draft: 1,
      confirmed: 2,
      completed: 3,
      cancelled: 0,
    });
    expect(summary.paymentStatusCounts.paid).toBe(5);
    expect(summary.fulfillmentStatusCounts.fulfilled).toBe(4);
    expect(summary.refundStatusCounts.none).toBe(6);
    expect(summary.paymentMethodCounts).toEqual({ cash: 3, khqr: 4, bank_transfer: 0, cod: 1 });
  });

  it("customer analytics stays fully available to analytics.read (no money in it)", async () => {
    const deps = dependencies({
      listQualifyingOrders: async () => [order({ id: "o-1" }), order({ id: "o-2" })],
      getCustomerCohort: async () => ({
        totalCustomers: 2,
        newCustomers: 1,
        repeatCustomers: 1,
        unattributedOrderCount: 0,
        repeatOrderCount: 1,
      }),
    });
    const summary = await getCustomerSummary(makeCtx(["analytics.read"]), "today", deps);
    expect(summary.totalCustomers).toBe(2);
    expect(summary.repeatOrderRate).toBe(0.5);
  });

  it("withholds top-selling gross revenue as null (never 0) but keeps the quantity ranking", async () => {
    const deps = financialDeps();
    const denied = await getTopSellingItems(makeCtx(SALES_PERMISSIONS), "today", 10, deps);
    const allowed = await getTopSellingItems(makeCtx(FINANCIAL_PERMISSIONS), "today", 10, deps);

    expect(denied[0]?.grossAmount).toBeNull();
    expect(denied[0]?.grossAmount).not.toBe(0);
    expect(allowed[0]?.grossAmount).toBe(36_000);

    // The non-financial ranking payload is identical either way.
    expect(denied.map((i) => [i.productId, i.variantId, i.quantitySold])).toEqual(
      allowed.map((i) => [i.productId, i.variantId, i.quantitySold]),
    );
  });

  it("does not leak another tenant's financial totals to an authorized caller", async () => {
    const seen: string[] = [];
    const deps = dependencies({
      listQualifyingOrders: async (organizationId) => {
        seen.push(organizationId);
        return [];
      },
      getSettlementTotals: async (organizationId) => {
        seen.push(organizationId);
        if (organizationId !== ORG_B) throw new Error("cross-tenant settlement read");
        return settlement;
      },
    });
    // Fully financially authorized, but only inside their OWN organization.
    const summary = await getBusinessSummary(makeCtx(FINANCIAL_PERMISSIONS, ORG_B), "today", deps);
    expect(new Set(seen)).toEqual(new Set([ORG_B]));
    expect(summary.finance.status).toBe("available");
  });

  it("still refuses the whole domain without analytics.read, however financial the caller is", async () => {
    await expect(
      getBusinessSummary(makeCtx(["orders.read", "payments.reconcile"]), "today", dependencies()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getTopSellingItems(
        makeCtx(["orders.read", "payments.reconcile"]),
        "today",
        10,
        dependencies(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps every monetary field of BusinessSummary inside the finance section", () => {
    const typesSource = source("src/server/analytics/types.ts");
    const block = typesSource.slice(
      typesSource.indexOf("export interface BusinessSummary"),
      typesSource.indexOf("export interface TopSellingItem"),
    );
    // The money field names must live in AnalyticsFinancialTotals, not at the
    // top level of BusinessSummary where analytics.read alone would reach them.
    for (const field of [
      "collectedGross:",
      "refundedAmount:",
      "outstandingAmount:",
      "orderedGross:",
    ]) {
      expect(block).not.toContain(field);
    }
    expect(block).toContain("finance: HomeSection<AnalyticsFinancialTotals>");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2 (independent review) — DELIVERY STATUS COUNTS ARE PER ORDER, ON THE
// CURRENT ATTEMPT
//
// The counts were a raw per-attempt tally, so a retried delivery was reported
// twice: an order that failed and was then delivered showed `failed: 1,
// delivered: 1` — telling the merchant a delivery had failed that in fact
// succeeded. "Current" is NOT redefined here: the Deliveries domain's own
// derivation (listDeliveryAttemptRefsForOrders — newest `created_at DESC,
// id DESC` row per order) decides which attempt is authoritative, and
// Analytics only counts what it returns.
// ═══════════════════════════════════════════════════════════════════════════════

const PERIOD = { from: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" };

function zeroCounts() {
  return {
    pending: 0,
    preparing: 0,
    ready: 0,
    in_transit: 0,
    delivered: 0,
    failed: 0,
    cancelled: 0,
  };
}

describe("Analytics delivery mix — one count per order, on its latest attempt", () => {
  it("failed → delivered counts delivered: 1 only, never failed: 1 + delivered: 1", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "failed", "2026-09-05T00:00:00.000Z"),
          attempt("d2", "order-1", "delivered", "2026-09-06T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
    expect(result.statusCounts.failed).toBe(0);
    expect(result.unresolved).toBe(false);
    // Exactly one order in the cohort, so exactly one count in total.
    expect(Object.values(result.statusCounts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("pending → failed → delivered counts delivered: 1 only", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "pending", "2026-09-05T00:00:00.000Z"),
          attempt("d2", "order-1", "failed", "2026-09-06T00:00:00.000Z"),
          attempt("d3", "order-1", "delivered", "2026-09-07T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
  });

  it("a genuinely current failure is still reported as failed", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "pending", "2026-09-05T00:00:00.000Z"),
          attempt("d2", "order-1", "failed", "2026-09-06T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), failed: 1 });
  });

  it("multiple attempts across different orders each contribute exactly one current status", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          // order-1: failed then delivered → delivered
          attempt("a1", "order-1", "failed", "2026-09-05T00:00:00.000Z"),
          attempt("a2", "order-1", "delivered", "2026-09-09T00:00:00.000Z"),
          // order-2: pending → failed → still failed
          attempt("b1", "order-2", "pending", "2026-09-05T00:00:00.000Z"),
          attempt("b2", "order-2", "failed", "2026-09-08T00:00:00.000Z"),
          // order-3: single in_transit attempt
          attempt("c1", "order-3", "in_transit", "2026-09-07T00:00:00.000Z"),
          // order-4: cancelled then retried and delivered
          attempt("e1", "order-4", "cancelled", "2026-09-02T00:00:00.000Z"),
          attempt("e2", "order-4", "delivered", "2026-09-03T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({
      ...zeroCounts(),
      delivered: 2,
      failed: 1,
      in_transit: 1,
    });
    // Four orders, seven raw attempts — four counts, not seven.
    expect(Object.values(result.statusCounts).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("breaks a same-timestamp tie by id DESC, exactly as the Deliveries domain does", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "failed", "2026-09-05T00:00:00.000Z"),
          attempt("d2", "order-1", "delivered", "2026-09-05T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
  });

  it("counts the current attempt even when the retry lands after the period", async () => {
    // The in-period attempt failed; the order was retried in October and
    // delivered. Reporting the stale in-period failure as current is the very
    // defect this fixes, so the order counts as delivered.
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "failed", "2026-09-28T00:00:00.000Z"),
          attempt("d2", "order-1", "delivered", "2026-10-02T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
  });

  it("excludes orders whose only attempts fall outside the period", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-old", "delivered", "2026-08-01T00:00:00.000Z"),
          attempt("d2", "order-in", "delivered", "2026-09-05T00:00:00.000Z"),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
  });

  it("TENANT ISOLATION: another organization's attempts never reach this org's mix", async () => {
    const result = await withDeliveryDb(
      {
        deliveries: [
          attempt("a1", "order-1", "delivered", "2026-09-05T00:00:00.000Z", ORG_A),
          attempt("b1", "order-b", "failed", "2026-09-05T00:00:00.000Z", ORG_B),
          attempt("b2", "order-b", "pending", "2026-09-06T00:00:00.000Z", ORG_B),
          // Org B holding a NEWER attempt on an order id Org A also uses must
          // never be able to override Org A's current state.
          attempt("b3", "order-1", "cancelled", "2026-09-30T00:00:00.000Z", ORG_B),
        ],
      },
      () => getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result.statusCounts).toEqual({ ...zeroCounts(), delivered: 1 });
    expect(result.statusCounts.cancelled).toBe(0);
    expect(result.statusCounts.pending).toBe(0);
  });

  it("returns an all-zero mix, not an error, when the org had no deliveries at all", async () => {
    const result = await withDeliveryDb({ deliveries: [] }, () =>
      getDeliveryStatusCounts(ORG_A, PERIOD),
    );
    expect(result).toEqual({ statusCounts: zeroCounts(), unresolved: false });
  });

  it("collects the cohort of orders with an in-period attempt, deduplicated", async () => {
    const orderIds = await withDeliveryDb(
      {
        deliveries: [
          attempt("d1", "order-1", "failed", "2026-09-05T00:00:00.000Z"),
          attempt("d2", "order-1", "delivered", "2026-09-06T00:00:00.000Z"),
          attempt("d3", "order-2", "pending", "2026-09-06T00:00:00.000Z"),
          attempt("d4", "order-b", "pending", "2026-09-06T00:00:00.000Z", ORG_B),
        ],
      },
      () => listOrderIdsWithDeliveryInPeriod(ORG_A, PERIOD),
    );
    expect([...orderIds].sort()).toEqual(["order-1", "order-2"]);
  });

  it("surfaces an unresolvable latest attempt as truncated, never as a certain mix", async () => {
    const deps = dependencies({
      getDeliveryStatusCounts: async () => ({
        statusCounts: { ...zeroCounts(), delivered: 3 },
        unresolved: true,
      }),
    });
    const summary = await getBusinessSummary(
      makeCtx(["analytics.read", "delivery.read"]),
      "today",
      deps,
    );
    expect(summary.delivery).toEqual({ status: "truncated" });
  });

  it("reuses the Deliveries domain's rule instead of restating a latest-attempt query", () => {
    const repository = source("src/server/analytics/repository.ts");
    expect(repository).toContain("listDeliveryAttemptRefsForOrders");
    expect(repository).toContain('from "@/server/deliveries/repository"');
    // No competing definition of "which attempt is current" in this domain.
    expect(repository).not.toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
    expect(repository).not.toMatch(/\.eq\("status", status\)[\s\S]{0,400}deliveries/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2 (independent review) — TOP-SELLING TIE-BREAKING MUST BE
// CURRENCY-INDEPENDENT
//
// The ranking broke quantity ties with `b.grossAmount - a.grossAmount`. These
// rows are NOT partitioned by currency and `grossAmount` is a minor-unit
// integer in each row's own currency, so 20 000 riel compared as "greater than"
// 20 000 cents. That is an accidental FX judgement — made with no rate and no
// rate timestamp, against the money rules. The tie-break is now a deterministic
// non-monetary ordering (snapshot name, then stable ids), and no FX conversion
// is performed anywhere.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Analytics top-selling ranking — currency-independent tie-breaking", () => {
  function line(
    orderId: string,
    productId: string,
    label: string,
    quantity: number,
    lineTotalMinor: number,
  ) {
    return {
      order_id: orderId,
      product_id: productId,
      variant_id: "v1",
      product_name_snapshot: label,
      variant_name_snapshot: null,
      quantity,
      line_total_minor: lineTotalMinor,
    };
  }

  it("does not order two equal-quantity items by their minor-unit amounts across currencies", () => {
    // Same quantity. The KHR line's minor-unit number is ~4000x larger purely
    // because riel is a smaller unit — it is NOT a bigger sale.
    const items = [
      line("usd-order", "p-usd", "Aaa Product", 10, 20_000), // USD 200.00
      line("khr-order", "p-khr", "Bbb Product", 10, 80_000_000), // KHR 80,000,000
    ];
    const currencyByOrder = new Map([
      ["usd-order", "USD" as const],
      ["khr-order", "KHR" as const],
    ]);

    const result = aggregateTopSellingItems(items, currencyByOrder, 10);
    expect(result.map((r) => r.productId)).toEqual(["p-usd", "p-khr"]);

    // The ordering must come from the snapshot name, NOT from the amounts:
    // inflating the USD row's minor units past the KHR row changes nothing.
    const inflated = aggregateTopSellingItems(
      [line("usd-order", "p-usd", "Aaa Product", 10, 999_999_999), items[1]!],
      currencyByOrder,
      10,
    );
    expect(inflated.map((r) => r.productId)).toEqual(["p-usd", "p-khr"]);

    // …and shrinking it to almost nothing changes nothing either.
    const deflated = aggregateTopSellingItems(
      [line("usd-order", "p-usd", "Aaa Product", 10, 1), items[1]!],
      currencyByOrder,
      10,
    );
    expect(deflated.map((r) => r.productId)).toEqual(["p-usd", "p-khr"]);
  });

  it("ranks the same set identically no matter which currency each row carries", () => {
    const items = [
      line("o1", "p-a", "Aaa Product", 7, 50_000),
      line("o2", "p-b", "Bbb Product", 7, 50_000),
      line("o3", "p-c", "Ccc Product", 9, 10),
    ];
    const asUsd = aggregateTopSellingItems(
      items,
      new Map([
        ["o1", "USD" as const],
        ["o2", "USD" as const],
        ["o3", "USD" as const],
      ]),
      10,
    );
    const mixed = aggregateTopSellingItems(
      items,
      new Map([
        ["o1", "KHR" as const],
        ["o2", "USD" as const],
        ["o3", "KHR" as const],
      ]),
      10,
    );
    // Quantity decides first (p-c), then the non-monetary tie-break — and the
    // currency assignment cannot move anything.
    expect(asUsd.map((r) => r.productId)).toEqual(["p-c", "p-a", "p-b"]);
    expect(mixed.map((r) => r.productId)).toEqual(["p-c", "p-a", "p-b"]);
  });

  it("keeps quantity as the only ranking metric, above every tie-break", () => {
    const items = [
      line("o1", "p-small", "Zzz Product", 100, 1),
      line("o2", "p-big", "Aaa Product", 99, 99_000_000),
    ];
    const result = aggregateTopSellingItems(
      items,
      new Map([
        ["o1", "USD" as const],
        ["o2", "KHR" as const],
      ]),
      10,
    );
    expect(result.map((r) => r.productId)).toEqual(["p-small", "p-big"]);
  });

  it("is a total, deterministic order — identical rows in any input order rank the same", () => {
    const currencyByOrder = new Map([
      ["o1", "KHR" as const],
      ["o2", "USD" as const],
      ["o3", "USD" as const],
    ]);
    const items = [
      line("o1", "p-1", "Same Name", 5, 400_000),
      line("o2", "p-2", "Same Name", 5, 100),
      line("o3", "p-3", "Same Name", 5, 900_000),
    ];
    const forward = aggregateTopSellingItems(items, currencyByOrder, 10).map((r) => r.productId);
    const reversed = aggregateTopSellingItems([...items].reverse(), currencyByOrder, 10).map(
      (r) => r.productId,
    );
    expect(forward).toEqual(reversed);
    // Identical labels and quantities, so the stable product id decides.
    expect(forward).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("separates the same product's USD and KHR sales into their own rows, never summing them", () => {
    const items = [
      line("o-usd", "p1", "Iced Coffee", 4, 8_000),
      line("o-khr", "p1", "Iced Coffee", 4, 32_000_000),
    ];
    const result = aggregateTopSellingItems(
      items,
      new Map([
        ["o-usd", "USD" as const],
        ["o-khr", "KHR" as const],
      ]),
      10,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.currency).sort()).toEqual(["KHR", "USD"]);
    // Tie on quantity and on label, so the currency code breaks it — a stable
    // string compare, not a comparison of 8 000 against 32 000 000.
    expect(result.map((r) => r.currency)).toEqual(["KHR", "USD"]);
    for (const row of result) expect(row.quantitySold).toBe(4);
  });

  it("comparator reads no monetary field at all", () => {
    const base = {
      productId: "p1",
      variantId: "v1",
      displayLabel: "Same",
      quantitySold: 5,
    };
    const khr = { ...base, currency: "KHR" as const, grossAmount: 99_000_000 };
    const usd = { ...base, currency: "KHR" as const, grossAmount: 1 };
    // Same identity on every non-monetary field → the comparator must call it a
    // tie, however far apart the amounts are.
    expect(compareTopSellingItems(khr, usd)).toBe(0);
    expect(compareTopSellingItems(usd, khr)).toBe(0);

    // And the ranking source performs no currency conversion of any kind.
    // Matched against code, not prose: the doc comments legitimately discuss
    // why FX must not happen here.
    const repositoryCode = source("src/server/analytics/repository.ts")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(repositoryCode).not.toMatch(
      /KHR_PER_USD|exchange_?[Rr]ate|convertCurrency|toUsd|toMinorUsd|fxRate/,
    );
  });

  it("sorts by no monetary expression in the repository source", () => {
    const repository = source("src/server/analytics/repository.ts");
    const comparator = repository.slice(
      repository.indexOf("export function compareTopSellingItems"),
      repository.indexOf("export function aggregateTopSellingItems"),
    );
    expect(comparator).toContain("quantitySold");
    expect(comparator).not.toContain("grossAmount");
    expect(comparator).not.toContain("line_total_minor");
    expect(comparator).not.toContain("total_minor");
  });
});
