/**
 * Payments Operations UI — service-level and client-boundary behaviour.
 *
 * Spawned as its own process by payments-operations-ui.test.ts because both
 * halves of it need module mocking, which is process-wide in bun:
 *
 *   - the Payment service's audit writes are stubbed, so a read/permission
 *     test does not need a live Supabase project;
 *   - `@/api/payments` is stubbed, so the client boundary in src/lib/api can be
 *     exercised for real (what it sends, what it does with what comes back)
 *     without a server.
 *
 * These are behavioural tests: they call the actual functions the screens call
 * and assert on what those functions do. Nothing here reads source text.
 *
 * Run: bun test src/tests/payments-operations-ui.runtime.ts
 */
import { describe, it, expect, mock } from "bun:test";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

mock.module("@/server/auth/audit", () => ({
  auditLog: async () => {},
  auditLogRequired: async () => {},
  MANDATORY_AUDIT_ACTIONS: new Set(["payments.override", "payments.reverse", "payments.refund"]),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_A_ID = "a0000000-0000-0000-0000-000000000001";
const ORG_B_ID = "b0000000-0000-0000-0000-000000000002";
const USER_ORG_A = "10000000-0000-0000-0000-000000000001";
const ORDER_ID = "20000000-0000-0000-0000-000000000001";
const PAYMENT_ID = "30000000-0000-0000-0000-000000000001";
/** A payment that really exists — but in Organization B. */
const ORG_B_PAYMENT_ID = "30000000-0000-0000-0000-0000000000b2";
/** A UUID that names nothing at all. */
const NONEXISTENT_PAYMENT_ID = "30000000-0000-0000-0000-00000000dead";

function makeCtx(permissions: string[], organizationId = ORG_A_ID): AuthCtxType {
  const perms = new Set<string>(permissions);
  return {
    userId: USER_ORG_A,
    organizationId,
    roleId: "role-with-perms",
    systemRole: "MANAGER",
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthCtxType;
}

async function expectForbidden(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error("Expected ForbiddenError or UnauthorizedError, but none was thrown");
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof UnauthorizedError) return;
    throw e;
  }
}

async function expectRejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected the call to reject, but it resolved");
}

// ── A recording fake of the repository's query builder ────────────────────────
//
// Every read the Payment repository performs is captured, so a test can assert
// that the organization filter was actually applied rather than trusting that
// it was.

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

interface RecordedQuery {
  table: string;
  eq: Array<[string, unknown]>;
  limit: number | null;
  range: [number, number] | null;
}

const PGRST_NO_ROW = { code: "PGRST116", message: "no rows" };

function recordingDb(
  tables: Record<string, QueryResult | ((query: RecordedQuery) => QueryResult)>,
  queries: RecordedQuery[],
) {
  return {
    from(table: string) {
      const record: RecordedQuery = { table, eq: [], limit: null, range: null };
      queries.push(record);

      const settle = (): QueryResult => {
        const entry = tables[table];
        if (entry === undefined) return { data: null, error: null };
        return typeof entry === "function" ? entry(record) : entry;
      };

      const builder = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: unknown) => {
          record.eq.push([column, value]);
          return builder;
        },
        limit: (value: number) => {
          record.limit = value;
          return builder;
        },
        range: (from: number, to: number) => {
          record.range = [from, to];
          return builder;
        },
        single: async () => settle(),
        maybeSingle: async () => settle(),
        then: (onOk: (v: QueryResult) => void, onErr?: (e: unknown) => void) =>
          Promise.resolve(settle()).then(onOk, onErr),
      };
      return builder;
    },
    rpc: async () => ({ data: { status: "success" }, error: null }),
  };
}

async function withDb<T>(
  tables: Record<string, QueryResult | ((query: RecordedQuery) => QueryResult)>,
  fn: (queries: RecordedQuery[]) => Promise<T>,
): Promise<T> {
  const { setPaymentRepositoryDbForTests } = await import("../server/payments/repository");
  const queries: RecordedQuery[] = [];
  const restore = setPaymentRepositoryDbForTests(recordingDb(tables, queries));
  try {
    return await fn(queries);
  } finally {
    restore();
  }
}

function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_ID,
    organization_id: ORG_A_ID,
    order_id: ORDER_ID,
    method: "khqr",
    currency: "USD",
    amount_minor: 10000,
    status: "paid",
    verification_state: "staff_confirmed",
    reference: "ABA-REF-99001",
    idempotency_key: null,
    note: "Second instalment, ref ABA-REF-99001",
    recorded_by: USER_ORG_A,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const ALL_PAYMENT_PERMS = [
  "payments.read",
  "payments.record",
  "payments.manual_confirm",
  "payments.mark_cod",
  "payments.refund",
  "payments.override_status",
  "payments.view_provider_reference",
  "payments.verify",
  "payments.reverse",
  "payments.reconcile",
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Tenant isolation — a guessed Organization B id reveals nothing
// ═══════════════════════════════════════════════════════════════════════════════

describe("tenant isolation on the reads the Payments UI performs", () => {
  it("scopes every list read to the caller's own organization", async () => {
    await withDb({ payments: { data: [paymentRow()], error: null } }, async (queries) => {
      const { listPayments } = await import("../server/payments/service");
      await listPayments(makeCtx(["payments.read"]), { limit: 30 });

      const listQuery = queries.find((query) => query.table === "payments");
      expect(listQuery).toBeDefined();
      expect(listQuery!.eq).toContainEqual(["organization_id", ORG_A_ID]);
    });
  });

  it("reports a real Organization B payment as not-found, exactly like a made-up id", async () => {
    /*
     * The repository filters on (id, organization_id), so a row that exists in
     * another organization simply does not match — PostgREST answers with the
     * same PGRST116 as a UUID that names nothing. This models both cases and
     * asserts the two answers are indistinguishable.
     */
    const results: string[] = [];

    for (const guessedId of [ORG_B_PAYMENT_ID, NONEXISTENT_PAYMENT_ID]) {
      await withDb({ payments: { data: null, error: PGRST_NO_ROW } }, async (queries) => {
        const { getPaymentById } = await import("../server/payments/service");
        const error = await expectRejects(() =>
          getPaymentById(makeCtx(["payments.read"]), guessedId),
        );
        results.push(`${(error as { statusCode?: number }).statusCode}:${error.message}`);

        // The lookup was still scoped: the caller's own org, never the guess's.
        const lookup = queries.find((query) => query.table === "payments");
        expect(lookup!.eq).toContainEqual(["organization_id", ORG_A_ID]);
        expect(lookup!.eq).toContainEqual(["id", guessedId]);
        expect(lookup!.eq.map(([column]) => column)).not.toContain("organization_id_from_client");
      });
    }

    expect(results[0]).toBe(results[1]!);
    expect(results[0]).toContain("404");
  });

  it("never reads a payment under an organization the caller did not resolve to", async () => {
    await withDb({ payments: { data: null, error: PGRST_NO_ROW } }, async (queries) => {
      const { getPaymentById } = await import("../server/payments/service");
      // A context resolved to Organization B can only ever read Organization B.
      await expectRejects(() => getPaymentById(makeCtx(["payments.read"], ORG_B_ID), PAYMENT_ID));
      const lookup = queries.find((query) => query.table === "payments");
      expect(lookup!.eq).toContainEqual(["organization_id", ORG_B_ID]);
      expect(lookup!.eq).not.toContainEqual(["organization_id", ORG_A_ID]);
    });
  });

  it("scopes the order settlement read to the caller's organization too", async () => {
    await withDb(
      {
        order_payment_totals: {
          data: {
            order_id: ORDER_ID,
            organization_id: ORG_A_ID,
            total_minor: 10000,
            currency: "USD",
            received_minor: 10000,
            refunded_minor: 2000,
            has_pending: false,
            has_failed: false,
            net_minor: 8000,
            payment_status: "paid",
            refund_status: "partial",
          },
          error: null,
        },
      },
      async (queries) => {
        const { getOrderSettlement } = await import("../server/payments/reconciliation");
        const settlement = await getOrderSettlement(makeCtx(["payments.reconcile"]), ORDER_ID);

        expect(settlement.paymentStatus).toBe("paid");
        expect(settlement.refundStatus).toBe("partial");
        expect(settlement.refundedMinor).toEqual({ amount: 2000, currency: "USD" });

        const query = queries.find((q) => q.table === "order_payment_totals");
        expect(query!.eq).toContainEqual(["organization_id", ORG_A_ID]);
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Permission denial
// ═══════════════════════════════════════════════════════════════════════════════

describe("permission denial happens before any data is touched", () => {
  it("refuses the list without payments.read, and issues no query at all", async () => {
    await withDb({ payments: { data: [paymentRow()], error: null } }, async (queries) => {
      const { listPayments } = await import("../server/payments/service");
      await expectForbidden(() => listPayments(makeCtx([]), { limit: 30 }));
      expect(queries).toHaveLength(0);
    });
  });

  it("refuses the detail read without payments.read, and issues no query at all", async () => {
    await withDb({ payments: { data: paymentRow(), error: null } }, async (queries) => {
      const { getPaymentById } = await import("../server/payments/service");
      await expectForbidden(() => getPaymentById(makeCtx(["orders.read"]), PAYMENT_ID));
      expect(queries).toHaveLength(0);
    });
  });

  it("refuses reconciliation aggregates without payments.reconcile", async () => {
    await withDb({ payment_reconciliation_summary: { data: [], error: null } }, async () => {
      const { getReconciliationSummary } = await import("../server/payments/reconciliation");
      await expectForbidden(() => getReconciliationSummary(makeCtx(["payments.read"])));
    });
  });

  it("refuses the order settlement read without payments.reconcile", async () => {
    await withDb({ order_payment_totals: { data: null, error: null } }, async (queries) => {
      const { getOrderSettlement } = await import("../server/payments/reconciliation");
      await expectForbidden(() => getOrderSettlement(makeCtx(["payments.read"]), ORDER_ID));
      expect(queries).toHaveLength(0);
    });
  });

  it("refuses a verification move whose own permission the caller lacks", async () => {
    await withDb({ payments: { data: paymentRow(), error: null } }, async (queries) => {
      const { verifyPayment } = await import("../server/payments/service");
      // manual_confirm alone may confirm, but may not escalate or flag.
      await expectForbidden(() =>
        verifyPayment(
          makeCtx(["payments.read", "payments.manual_confirm"]),
          PAYMENT_ID,
          "mismatch",
        ),
      );
      // Checked before the payment is even loaded, so no id is confirmed real.
      expect(queries).toHaveLength(0);
    });
  });

  it("refuses a refund and a reversal without their own permissions", async () => {
    await withDb({ payments: { data: paymentRow(), error: null } }, async () => {
      const { refundPayment, reversePayment } = await import("../server/payments/service");
      const ctx = makeCtx(["payments.read", "payments.verify"]);
      await expectForbidden(() => refundPayment(ctx, PAYMENT_ID, 1000, "Damaged"));
      await expectForbidden(() => reversePayment(ctx, PAYMENT_ID, "Recorded in error"));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Sensitive fields the list must not leak
// ═══════════════════════════════════════════════════════════════════════════════

describe("what the list read gives the browser", () => {
  it("withholds the reference and the whole note without payments.view_provider_reference", async () => {
    await withDb({ payments: { data: [paymentRow()], error: null } }, async () => {
      const { listPayments } = await import("../server/payments/service");
      const rows = await listPayments(makeCtx(["payments.read"]), { limit: 30 });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.reference).toBeNull();
      // Withheld entirely rather than partially redacted — the list cannot see
      // the evidence rows, so it cannot know the full known-reference set.
      expect(rows[0]!.note).toBeNull();
      // The amount and both state axes still come through in full.
      expect(rows[0]!.amount).toEqual({ amount: 10000, currency: "USD" });
      expect(rows[0]!.status).toBe("paid");
      expect(rows[0]!.verificationState).toBe("staff_confirmed");
    });
  });

  it("returns the reference and note to a caller who does hold the permission", async () => {
    await withDb({ payments: { data: [paymentRow()], error: null } }, async () => {
      const { listPayments } = await import("../server/payments/service");
      const rows = await listPayments(makeCtx(ALL_PAYMENT_PERMS), { limit: 30 });
      expect(rows[0]!.reference).toBe("ABA-REF-99001");
      expect(rows[0]!.note).toContain("ABA-REF-99001");
    });
  });

  it("keeps a KHR payment in riel, with no conversion on the way out", async () => {
    await withDb(
      { payments: { data: [paymentRow({ currency: "KHR", amount_minor: 41000 })], error: null } },
      async () => {
        const { listPayments } = await import("../server/payments/service");
        const rows = await listPayments(makeCtx(["payments.read"]), { limit: 30 });
        expect(rows[0]!.amount).toEqual({ amount: 41000, currency: "KHR" });
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. The client boundary: pagination, no mock fallback, what it sends
// ═══════════════════════════════════════════════════════════════════════════════

interface ListCall {
  data: Record<string, unknown> | undefined;
}

function stubPaymentsApi(handlers: {
  list?: (call: ListCall) => Promise<unknown> | unknown;
  detail?: (call: ListCall) => Promise<unknown> | unknown;
  verify?: (call: ListCall) => Promise<unknown> | unknown;
  refund?: (call: ListCall) => Promise<unknown> | unknown;
  reverse?: (call: ListCall) => Promise<unknown> | unknown;
}) {
  mock.module("@/api/payments", () => ({
    listPaymentsFn: async (call: ListCall) => handlers.list?.(call) ?? [],
    getPaymentByIdFn: async (call: ListCall) => handlers.detail?.(call),
    verifyPaymentFn: async (call: ListCall) => handlers.verify?.(call),
    refundPaymentFn: async (call: ListCall) => handlers.refund?.(call),
    reversePaymentFn: async (call: ListCall) => handlers.reverse?.(call),
    getOrderSettlementFn: async () => undefined,
    getPaymentReconciliationFn: async () => [],
  }));
}

function uiSummary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: ORG_A_ID,
    orderId: ORDER_ID,
    method: "khqr",
    amount: { amount: 10000, currency: "USD" },
    status: "paid",
    verificationState: "staff_confirmed",
    reference: null,
    note: null,
    recordedBy: USER_ORG_A,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("the client boundary in src/lib/api", () => {
  it("asks for one row beyond the page and reports that another page exists", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      list: (call) => {
        seen.push(call);
        // 31 rows come back for a 30-row page.
        return Array.from({ length: 31 }, (_, index) => uiSummary(`p-${index}`));
      },
    });

    const { listRealPayments } = await import("../lib/api");
    const page = await listRealPayments({ limit: 30, offset: 0 });

    expect(seen[0]!.data!["limit"]).toBe(31);
    expect(page.hasMore).toBe(true);
    // The probe row is dropped, never shown.
    expect(page.items).toHaveLength(30);
    expect(page.items.at(-1)!.id).toBe("p-29");
  });

  it("reports the end of the list when the probe row does not come back", async () => {
    stubPaymentsApi({
      list: () => Array.from({ length: 12 }, (_, index) => uiSummary(`p-${index}`)),
    });

    const { listRealPayments } = await import("../lib/api");
    const page = await listRealPayments({ limit: 30 });
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(12);
  });

  it("returns an honest empty page rather than inventing rows", async () => {
    stubPaymentsApi({ list: () => [] });
    const { listRealPayments } = await import("../lib/api");
    const page = await listRealPayments();
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("sends the filters to the server instead of narrowing rows on the client", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      list: (call) => {
        seen.push(call);
        return [];
      },
    });

    const { listRealPayments } = await import("../lib/api");
    await listRealPayments({ status: "pending", verificationState: "mismatch", offset: 60 });

    expect(seen[0]!.data).toMatchObject({
      status: "pending",
      verificationState: "mismatch",
      offset: 60,
    });
  });

  it("never falls back to mock data when the payment list read fails", async () => {
    stubPaymentsApi({
      list: () => {
        throw Object.assign(new Error("Missing permission: payments.read"), { statusCode: 403 });
      },
    });

    const { listRealPayments } = await import("../lib/api");
    const error = await expectRejects(() => listRealPayments());
    expect((error as { statusCode?: number }).statusCode).toBe(403);
  });

  it("never falls back to mock data when the payment detail read fails", async () => {
    stubPaymentsApi({
      detail: () => {
        throw Object.assign(new Error("Payment not found"), { statusCode: 404 });
      },
    });

    const { getRealPaymentDetail } = await import("../lib/api");
    const error = await expectRejects(() => getRealPaymentDetail(PAYMENT_ID));
    expect((error as { statusCode?: number }).statusCode).toBe(404);
  });

  it("sends only a verification target — never a payment status", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      verify: (call) => {
        seen.push(call);
        return { ...uiSummary(PAYMENT_ID), events: [], evidence: [] };
      },
    });

    const { verifyRealPayment } = await import("../lib/api");
    await verifyRealPayment(PAYMENT_ID, "staff_confirmed", "Counted the cash");

    expect(seen[0]!.data).toEqual({
      paymentId: PAYMENT_ID,
      to: "staff_confirmed",
      reason: "Counted the cash",
    });
    expect(Object.keys(seen[0]!.data!)).not.toContain("status");
  });

  it("omits the reason entirely when the merchant left it blank", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      verify: (call) => {
        seen.push(call);
        return { ...uiSummary(PAYMENT_ID), events: [], evidence: [] };
      },
    });

    const { verifyRealPayment } = await import("../lib/api");
    await verifyRealPayment(PAYMENT_ID, "bank_verified");
    expect(seen[0]!.data).toEqual({ paymentId: PAYMENT_ID, to: "bank_verified" });
  });

  it("sends a refund as an integer minor amount with its reason, and nothing else", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      refund: (call) => {
        seen.push(call);
        return { ...uiSummary(PAYMENT_ID), events: [], evidence: [] };
      },
    });

    const { refundRealPayment } = await import("../lib/api");
    await refundRealPayment(PAYMENT_ID, 2000, "Damaged item");

    expect(seen[0]!.data).toEqual({
      paymentId: PAYMENT_ID,
      amountMinor: 2000,
      reason: "Damaged item",
    });
    expect(Number.isInteger(seen[0]!.data!["amountMinor"])).toBe(true);
    // No currency is sent: a refund is always in the payment's own currency,
    // which the server already knows.
    expect(Object.keys(seen[0]!.data!)).not.toContain("currency");
  });

  it("sends a reversal as a payment id and a reason only", async () => {
    const seen: ListCall[] = [];
    stubPaymentsApi({
      reverse: (call) => {
        seen.push(call);
        return { ...uiSummary(PAYMENT_ID), events: [], evidence: [] };
      },
    });

    const { reverseRealPayment } = await import("../lib/api");
    await reverseRealPayment(PAYMENT_ID, "Recorded in error");
    expect(seen[0]!.data).toEqual({ paymentId: PAYMENT_ID, reason: "Recorded in error" });
  });
});
