/**
 * Analytics Business Summary — structural performance guarantees.
 *
 * The Analytics screen is "ready" only once every section has left its
 * skeleton, and the Business Summary is the section with the most round trips.
 * These tests pin the two structural fixes in that path:
 *
 *   1. The status mixes (order lifecycle/payment/fulfillment/refund status and
 *      payment method) come from ONE database-side RPC (migration 049) instead
 *      of 19 exact HEAD counts — with identical numbers, and a fallback to the
 *      HEAD counts while the migration is not yet applied.
 *   2. Reads that do not depend on the qualifying order cohort (status mixes,
 *      delivery mix) no longer wait behind it; only the settlement read does.
 *
 * No milliseconds are asserted — request counts and call ordering only.
 *
 * Run: bun test src/tests/analytics-summary-performance.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";
import {
  getPeriodStatusCounts,
  PERIOD_STATUS_COUNTS_RPC,
  setAnalyticsRepositoryDbForTests,
  type PeriodStatusCounts,
} from "../server/analytics/repository";
import { getBusinessSummary, type AnalyticsDependencies } from "../server/analytics/service";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const BOUNDS = { from: "2026-09-10T17:00:00.000Z", until: "2026-09-11T17:00:00.000Z" };

type Row = Record<string, unknown>;

function makeCtx(permissions: string[], organizationId = ORG_A) {
  const granted = new Set(permissions);
  return {
    userId: "11111111-0000-0000-0000-000000000001",
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
 * Request-counting PostgREST stand-in. `rpc` evaluates migration 049's
 * semantics over the same in-memory rows the `.from()` builder filters, so the
 * RPC path and the HEAD-count fallback can be compared on one dataset.
 */
function makeCountingDb(
  tables: Record<string, Row[]>,
  rpcMode: "ok" | "missing" | "error" | { rows: unknown[] } = "ok",
) {
  const calls: { kind: "from" | "rpc"; name: string; args?: Record<string, unknown> }[] = [];

  function inPeriod(row: Row, org: unknown, from: unknown, until: unknown) {
    return (
      row.organization_id === org &&
      (row.created_at as string) >= (from as string) &&
      (row.created_at as string) < (until as string)
    );
  }

  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, args });
      if (rpcMode === "missing") {
        return { data: null, error: { code: "PGRST202", message: "function not found" } };
      }
      if (rpcMode === "error") {
        return { data: null, error: { code: "57014", message: "statement timeout" } };
      }
      if (typeof rpcMode === "object") return { data: rpcMode.rows, error: null };
      const { p_organization_id: org, p_from: from, p_until: until } = args;
      const out: { axis: string; value: string; row_count: number }[] = [];
      const orders = (tables.orders ?? []).filter((r) => inPeriod(r, org, from, until));
      for (const axis of [
        "lifecycle_status",
        "payment_status",
        "fulfillment_status",
        "refund_status",
      ]) {
        const groups = new Map<string, number>();
        for (const r of orders)
          groups.set(r[axis] as string, (groups.get(r[axis] as string) ?? 0) + 1);
        for (const [value, row_count] of groups) out.push({ axis, value, row_count });
      }
      const payments = (tables.payments ?? []).filter((r) => inPeriod(r, org, from, until));
      const methods = new Map<string, number>();
      for (const r of payments)
        methods.set(r.method as string, (methods.get(r.method as string) ?? 0) + 1);
      for (const [value, row_count] of methods)
        out.push({ axis: "payment_method", value, row_count });
      return { data: out, error: null };
    },
    from(table: string) {
      calls.push({ kind: "from", name: table });
      const filters: Array<(row: Row) => boolean> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push((row) => row[col] === val);
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
        then(resolve: (value: unknown) => void) {
          const count = (tables[table] ?? []).filter((row) => filters.every((f) => f(row))).length;
          resolve({ data: null, error: null, count });
        },
      };
      return builder;
    },
  };
}

function orderRow(
  org: string,
  createdAt: string,
  statuses: Partial<
    Record<"lifecycle_status" | "payment_status" | "fulfillment_status" | "refund_status", string>
  > = {},
): Row {
  return {
    organization_id: org,
    created_at: createdAt,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    fulfillment_status: "unfulfilled",
    refund_status: "none",
    ...statuses,
  };
}

const DATASET: Record<string, Row[]> = {
  orders: [
    orderRow(ORG_A, "2026-09-10T17:00:00.000Z"), // inclusive lower bound
    orderRow(ORG_A, "2026-09-11T02:00:00.000Z", {
      payment_status: "paid",
      fulfillment_status: "fulfilled",
    }),
    orderRow(ORG_A, "2026-09-11T03:00:00.000Z", {
      lifecycle_status: "completed",
      payment_status: "paid",
      refund_status: "partial",
    }),
    orderRow(ORG_A, "2026-09-11T04:00:00.000Z", {
      lifecycle_status: "cancelled",
      fulfillment_status: "cancelled",
      refund_status: "full",
    }),
    orderRow(ORG_A, "2026-09-11T05:00:00.000Z", {
      lifecycle_status: "draft",
      payment_status: "pending",
    }),
    orderRow(ORG_A, "2026-09-11T17:00:00.000Z"), // exclusive upper bound: out
    orderRow(ORG_A, "2026-09-10T16:59:59.999Z"), // before the period: out
    orderRow(ORG_B, "2026-09-11T02:00:00.000Z", { payment_status: "paid" }), // other org: out
  ],
  payments: [
    { organization_id: ORG_A, created_at: "2026-09-11T02:00:00.000Z", method: "cash" },
    { organization_id: ORG_A, created_at: "2026-09-11T03:00:00.000Z", method: "khqr" },
    { organization_id: ORG_A, created_at: "2026-09-11T03:30:00.000Z", method: "khqr" },
    { organization_id: ORG_A, created_at: "2026-09-11T04:00:00.000Z", method: "cod" },
    { organization_id: ORG_A, created_at: "2026-09-11T18:00:00.000Z", method: "cod" }, // out
    { organization_id: ORG_B, created_at: "2026-09-11T02:00:00.000Z", method: "bank_transfer" }, // other org
  ],
};

const EXPECTED: PeriodStatusCounts = {
  lifecycleStatusCounts: { draft: 1, confirmed: 2, completed: 1, cancelled: 1 },
  paymentStatusCounts: { unpaid: 2, pending: 1, paid: 2, failed: 0 },
  fulfillmentStatusCounts: { unfulfilled: 3, processing: 0, fulfilled: 1, cancelled: 1 },
  refundStatusCounts: { none: 3, partial: 1, full: 1 },
  paymentMethodCounts: { cash: 1, khqr: 2, bank_transfer: 0, cod: 1 },
};

async function withDb<T>(fake: ReturnType<typeof makeCountingDb>, run: () => Promise<T>) {
  const restore = setAnalyticsRepositoryDbForTests(fake);
  try {
    return await run();
  } finally {
    restore();
  }
}

describe("getPeriodStatusCounts — one round trip, same numbers", () => {
  it("issues exactly one RPC (was 19 HEAD counts), scoped to the server-derived org and period", async () => {
    const fake = makeCountingDb(DATASET);
    const counts = await withDb(fake, () => getPeriodStatusCounts(ORG_A, BOUNDS));
    expect(counts).toEqual(EXPECTED);
    expect(fake.calls).toEqual([
      {
        kind: "rpc",
        name: PERIOD_STATUS_COUNTS_RPC,
        args: { p_organization_id: ORG_A, p_from: BOUNDS.from, p_until: BOUNDS.until },
      },
    ]);
  });

  it("the HEAD-count fallback (migration 049 absent) returns identical metrics with 19 requests", async () => {
    const fake = makeCountingDb(DATASET, "missing");
    const counts = await withDb(fake, () => getPeriodStatusCounts(ORG_A, BOUNDS));
    expect(counts).toEqual(EXPECTED);
    expect(fake.calls.filter((c) => c.kind === "rpc")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.kind === "from")).toHaveLength(19);
  });

  it("never leaks another organization's counts", async () => {
    const fake = makeCountingDb(DATASET);
    const counts = await withDb(fake, () => getPeriodStatusCounts(ORG_B, BOUNDS));
    expect(counts.paymentStatusCounts).toEqual({ unpaid: 0, pending: 0, paid: 1, failed: 0 });
    expect(counts.paymentMethodCounts).toEqual({ cash: 0, khqr: 0, bank_transfer: 1, cod: 0 });
  });

  it("fails closed on any RPC error other than a missing function (no silent fallback)", async () => {
    const fake = makeCountingDb(DATASET, "error");
    await expect(withDb(fake, () => getPeriodStatusCounts(ORG_A, BOUNDS))).rejects.toThrow(
      "getPeriodStatusCounts: statement timeout",
    );
    expect(fake.calls.filter((c) => c.kind === "from")).toHaveLength(0);
  });

  it("rejects malformed RPC output instead of reporting it as a count", async () => {
    const cases: unknown[][] = [
      [{ axis: "mystery", value: "x", row_count: 1 }],
      [{ axis: "payment_method", value: "cash", row_count: -1 }],
      [{ axis: "payment_method", value: "cash", row_count: 1.5 }],
      [
        { axis: "payment_method", value: "cash", row_count: 1 },
        { axis: "payment_method", value: "cash", row_count: 2 },
      ],
    ];
    for (const rows of cases) {
      const fake = makeCountingDb(DATASET, { rows });
      await expect(withDb(fake, () => getPeriodStatusCounts(ORG_A, BOUNDS))).rejects.toThrow(
        "getPeriodStatusCounts",
      );
    }
  });

  it("zero-fills absent values, accepts bigint-as-string counts, ignores values it never counted", async () => {
    const fake = makeCountingDb(DATASET, {
      rows: [
        { axis: "lifecycle_status", value: "confirmed", row_count: "7" },
        { axis: "lifecycle_status", value: "archived_future_value", row_count: 3 },
        { axis: "refund_status", value: null, row_count: 2 },
      ],
    });
    const counts = await withDb(fake, () => getPeriodStatusCounts(ORG_A, BOUNDS));
    expect(counts.lifecycleStatusCounts).toEqual({
      draft: 0,
      confirmed: 7,
      completed: 0,
      cancelled: 0,
    });
    expect(counts.refundStatusCounts).toEqual({ none: 0, partial: 0, full: 0 });
    expect(counts.paymentMethodCounts).toEqual({ cash: 0, khqr: 0, bank_transfer: 0, cod: 0 });
  });
});

// ── Service: independent reads start together ────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const ZERO_COUNTS: PeriodStatusCounts = {
  lifecycleStatusCounts: { draft: 0, confirmed: 0, completed: 0, cancelled: 0 },
  paymentStatusCounts: { unpaid: 0, pending: 0, paid: 0, failed: 0 },
  fulfillmentStatusCounts: { unfulfilled: 0, processing: 0, fulfilled: 0, cancelled: 0 },
  refundStatusCounts: { none: 0, partial: 0, full: 0 },
  paymentMethodCounts: { cash: 0, khqr: 0, bank_transfer: 0, cod: 0 },
};

function tracingDeps(started: string[], orders: Promise<never[]>): AnalyticsDependencies {
  return {
    listQualifyingOrders: async () => {
      started.push("orders");
      return orders;
    },
    getPeriodStatusCounts: async () => {
      started.push("statusCounts");
      return ZERO_COUNTS;
    },
    getSettlementTotals: async () => {
      started.push("settlement");
      return { orderedGross: [], collectedGross: [], refundedAmount: [], outstandingAmount: [] };
    },
    getDeliveryStatusCounts: async () => {
      started.push("delivery");
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
    listTopSellingItems: async () => [],
    getCustomerCohort: async () => ({
      totalCustomers: 0,
      newCustomers: 0,
      repeatCustomers: 0,
      unattributedOrderCount: 0,
      repeatOrderCount: 0,
    }),
  };
}

describe("getBusinessSummary — no false serialization behind the order cohort", () => {
  it("starts status counts and the delivery mix before the cohort read resolves; settlement waits for it", async () => {
    const started: string[] = [];
    const cohort = deferred<never[]>();
    const pending = getBusinessSummary(
      makeCtx(["analytics.read", "orders.read", "payments.reconcile", "delivery.read"]),
      "today",
      tracingDeps(started, cohort.promise),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(new Set(started)).toEqual(new Set(["orders", "statusCounts", "delivery"]));
    expect(started).not.toContain("settlement");

    cohort.resolve([]);
    const summary = await pending;
    expect(started.at(-1)).toBe("settlement");
    expect(summary.finance.status).toBe("available");
  });

  it("still never issues the settlement read for a caller outside the financial boundary", async () => {
    const started: string[] = [];
    await getBusinessSummary(
      makeCtx(["analytics.read", "orders.read", "payments.read"]),
      "today",
      tracingDeps(started, Promise.resolve([])),
    );
    expect(started).not.toContain("settlement");
  });

  it("still requires analytics.read before any read starts", async () => {
    const started: string[] = [];
    await expect(
      getBusinessSummary(makeCtx([]), "today", tracingDeps(started, Promise.resolve([]))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(started).toEqual([]);
  });
});

describe("migration 049 — security posture", () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/049_analytics_period_status_counts.sql"),
    "utf8",
  );

  it("is SECURITY INVOKER, callable only by service_role, and filters on the org parameter", () => {
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.analytics_period_status_counts_v1\([^)]*\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.analytics_period_status_counts_v1\([^)]*\)\s+TO service_role;/,
    );
    expect(sql.match(/\b[op]\.organization_id = p_organization_id/g)?.length).toBe(2);
    expect(sql).not.toMatch(/total_minor|amount_minor/);
  });
});
