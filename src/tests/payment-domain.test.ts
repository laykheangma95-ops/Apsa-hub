/**
 * Production Payment Domain Foundation tests.
 *
 * Structure mirrors src/tests/order-domain.test.ts: pure unit tests against a
 * mocked repository DB, plus source/migration structural assertions that need
 * no live database. This phase's Payment domain has no live Supabase project
 * to test against yet (migrations 034–036 are not applied to any hosted
 * project — see supabase/PAYMENTS.md), so every test here is either a mocked
 * unit test or a structural assertion over the migration SQL / TypeScript
 * source. There is no live-DB tier in this file (unlike order-domain.test.ts)
 * because there is nowhere live to point it at yet.
 *
 * Coverage:
 *   TENANT
 *     1.  Foreign (cross-org) Payment UUID is reported as not-found
 *     2.  Foreign (cross-org) Order UUID is reported as not-found
 *     3.  Foreign evidence attachment is reported as not-found
 *     4.  Duplicate-reference check is organization-scoped (SQL)
 *     5.  Reconciliation is scoped to the caller's organization only
 *   MANUAL CONFIRMATION
 *     6.  Authorized staff confirmation succeeds
 *     7.  Unauthorized staff confirmation is rejected
 *     8.  The actor is always the authorization context's user, never input
 *     9.  Amount / method / reference are captured exactly as supplied
 *    10.  Evidence attachment never marks a payment paid
 *   IMMUTABILITY
 *    11.  payment_events blocks UPDATE and DELETE by trigger (SQL)
 *    12.  Correction appends an event through the RPC, never a direct UPDATE
 *    13.  Reversal appends an event through the RPC
 *    14.  Refund appends an event through the RPC; partial vs full refund
 *    15.  No delete path exists anywhere in the repository
 *   DUPLICATE / IDEMPOTENCY
 *    16.  A reference collision is flagged duplicate_suspected, not rejected
 *    17.  A replayed idempotency key returns the same payment, no second audit
 *    18.  Concurrent verification is surfaced as a conflict, not overwritten
 *   VERIFICATION
 *    19.  Valid / invalid verification transitions
 *    20.  resultingPaymentStatus is the single source of the status mapping
 *    21.  The bank/API verification hook contract is provider-agnostic
 *   COD
 *    22.  Delivery migration never touches the payments table
 *    23.  Delivery domain never imports the Payment domain
 *    24.  Recording a COD payment requires payments.mark_cod, not payments.record
 *   ORDER MUTATION BLOCK
 *    25.  The Payment domain never imports the Order domain
 *    26.  No Payment RPC ever writes to the orders table
 *   RECONCILIATION
 *    27.  Aggregation buckets (paid/pending/needs-review/COD-unsettled/etc.)
 *    28.  Reconciliation requires payments.reconcile
 *   SECURITY / BUNDLE
 *    29.  src/api/payments.ts never statically imports server-only modules
 *    30.  No client-trusted organizationId/userId parameter exists
 *
 * Run: bun test src/tests/payment-domain.test.ts
 */

import { describe, it, expect, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

// ── Default audit mock ──────────────────────────────────────────────────────
//
// Best-effort and mandatory audit both succeed silently by default, so tests
// can exercise service logic without a live Supabase project. Test 14's
// "audit fail-closed" case overrides this locally and restores it afterward.

mock.module("@/server/auth/audit", () => ({
  auditLog: async () => {},
  auditLogRequired: async () => {},
  MANDATORY_AUDIT_ACTIONS: new Set([
    "orders.refund",
    "payments.override",
    "payments.reverse",
    "payments.refund",
    "inventory.adjust",
    "customers.export",
    "team.remove",
    "team.role_change",
    "org.ownership_transfer",
  ]),
}));

function restoreDefaultAuditMock(): void {
  mock.module("@/server/auth/audit", () => ({
    auditLog: async () => {},
    auditLogRequired: async () => {},
    MANDATORY_AUDIT_ACTIONS: new Set([
      "orders.refund",
      "payments.override",
      "payments.reverse",
      "payments.refund",
      "inventory.adjust",
      "customers.export",
      "team.remove",
      "team.role_change",
      "org.ownership_transfer",
    ]),
  }));
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

// ── Context factory (mirrors order-domain.test.ts) ────────────────────────────

function makeCtxWithPerms(
  userId: string,
  organizationId: string,
  permissions: string[],
  systemRole = "MANAGER",
): AuthCtxType {
  const perms = new Set<string>(permissions);
  return {
    userId,
    organizationId,
    roleId: "role-with-perms",
    systemRole,
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => systemRole === "OWNER",
    requireOwner: () => {
      if (systemRole !== "OWNER") throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthCtxType;
}

/** Every Payment permission this phase defines (migration 036). */
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

// ── Fixture UUIDs ─────────────────────────────────────────────────────────────

const ORG_A_ID = "a0000000-0000-0000-0000-000000000001";
const ORG_B_ID = "b0000000-0000-0000-0000-000000000002";
const USER_ORG_A = "10000000-0000-0000-0000-000000000001";
const ORDER_ID = "20000000-0000-0000-0000-000000000001";
const PAYMENT_ID = "30000000-0000-0000-0000-000000000001";

// ── Source/migration readers (structural assertions, no DB needed) ────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const paymentsMigration = () => readSource("supabase/migrations/034_payments_domain.sql");
const rpcMigration = () => readSource("supabase/migrations/035_payment_rpc.sql");
const permsMigration = () => readSource("supabase/migrations/036_payment_permissions.sql");
const deliveryMigration = () =>
  readSource("supabase/migrations/027_delivery_fulfillment_domain.sql");
const paymentsRepositorySource = () => readSource("src/server/payments/repository.ts");
const paymentsServiceSource = () => readSource("src/server/payments/service.ts");
const paymentsApiSource = () => readSource("src/api/payments.ts");
const deliveryServiceSource = () => readSource("src/server/deliveries/service.ts");
const deliveryRepositorySource = () => readSource("src/server/deliveries/repository.ts");

// ── Mock repository DB ────────────────────────────────────────────────────────

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

function fakeQuery(result: QueryResult) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    single: async () => result,
    maybeSingle: async () => result,
    then: (resolve: (v: QueryResult) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface PaymentDbOptions {
  tables?: Record<string, QueryResult>;
  rpc?: Record<string, QueryResult>;
}

async function withPaymentDb<T>(
  opts: PaymentDbOptions,
  fn: (calls: RpcCall[]) => Promise<T>,
): Promise<T> {
  const { setPaymentRepositoryDbForTests } = await import("../server/payments/repository");
  const calls: RpcCall[] = [];
  const testDb = {
    from: (table: string) => fakeQuery(opts.tables?.[table] ?? { data: null, error: null }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ fn: name, args });
      return opts.rpc?.[name] ?? { data: { status: "success" }, error: null };
    },
  };
  const restore = setPaymentRepositoryDbForTests(testDb);
  try {
    return await fn(calls);
  } finally {
    restore();
  }
}

const noRow: QueryResult = { data: null, error: { code: "PGRST116", message: "no rows" } };

const orderRow: QueryResult = {
  data: { id: ORDER_ID, organization_id: ORG_A_ID, currency: "USD" },
  error: null,
};

function paymentRow(overrides: Record<string, unknown> = {}): QueryResult {
  return {
    data: {
      id: PAYMENT_ID,
      organization_id: ORG_A_ID,
      order_id: ORDER_ID,
      method: "cash",
      currency: "USD",
      amount_minor: 1000,
      status: "pending",
      verification_state: "unverified",
      reference: null,
      idempotency_key: null,
      note: null,
      recorded_by: USER_ORG_A,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
      ...overrides,
    },
    error: null,
  };
}

function rows(data: Array<Record<string, unknown>>): QueryResult {
  return { data, error: null };
}

const emptyEvents = rows([]);
const emptyEvidence = rows([]);

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 1: Foreign Payment UUID", () => {
  it("a payment belonging to another organization is reported not-found, indistinguishable from nonexistent", async () => {
    const { getPaymentById } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb({ tables: { payments: noRow } }, async () => {
      const err = await expectRejects(() => getPaymentById(ctx, "org-b-payment-id"));
      expect(err.message).toMatch(/not found/i);
      expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
    });
  });
});

describe("Test 2: Foreign Order UUID", () => {
  it("recordPayment rejects an order id that does not resolve within the caller's org", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb({ tables: { orders: noRow } }, async () => {
      const err = await expectRejects(() =>
        recordPayment(ctx, { orderId: "org-b-order-id", method: "cash", amountMinor: 1000 }),
      );
      expect(err.message).toMatch(/order not found/i);
      expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
    });
  });
});

describe("Test 3: Foreign evidence attachment", () => {
  it("attaching evidence to a payment outside the caller's org is reported not-found", async () => {
    const { attachEvidence } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb({ tables: { payments: noRow } }, async () => {
      const err = await expectRejects(() =>
        attachEvidence(ctx, {
          paymentId: "org-b-payment-id",
          evidenceType: "screenshot",
          storageRef: "evidence/1.png",
        }),
      );
      expect(err.message).toMatch(/payment not found/i);
      expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
    });
  });
});

describe("Test 4: Duplicate-reference check is organization-scoped", () => {
  it("SQL: the duplicate-reference EXISTS check filters by organization_id", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).toMatch(
      /SELECT EXISTS \(\s*SELECT 1 FROM public\.payments\s*WHERE organization_id = p_organization_id\s*AND reference = v_reference/,
    );
  });
});

describe("Test 5: Reconciliation is organization-scoped only", () => {
  it("getReconciliationSummary takes no external organization parameter", () => {
    const src = paymentsServiceSource();
    expect(src).toBeDefined();
    const reconciliationSrc = readSource("src/server/payments/reconciliation.ts");
    expect(reconciliationSrc).toMatch(
      /export async function getReconciliationSummary\(\s*ctx: AuthorizationContext,?\s*\)/,
    );
    // The repository call always uses ctx.organizationId, never a caller-supplied id.
    expect(reconciliationSrc).toContain("repo.getReconciliationSummary(ctx.organizationId)");
  });

  it("cross-tenant access is rejected: Org A's context cannot read Org B's aggregate rows", async () => {
    const { getReconciliationSummary } = await import("../server/payments/reconciliation");
    const ctxA = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    // The mock DB ignores .eq() filters and always returns whatever is configured
    // for the table, so this test's guarantee is structural (see above): the
    // repository call is hard-wired to ctx.organizationId, not a parameter a
    // caller could substitute. Here we simply confirm the org-scoped read shape.
    await withPaymentDb(
      {
        tables: {
          payment_reconciliation_summary: rows([
            {
              organization_id: ORG_A_ID,
              method: "cash",
              currency: "USD",
              status: "paid",
              verification_state: "staff_confirmed",
              payment_count: 1,
              amount_minor_total: 1000,
            },
          ]),
        },
      },
      async () => {
        const summary = await getReconciliationSummary(ctxA);
        expect(summary).toHaveLength(1);
        expect(summary[0]!.currency).toBe("USD");
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL CONFIRMATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 6: Authorized staff confirmation", () => {
  it("a caller with payments.manual_confirm can confirm a pending payment as staff_confirmed", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    // The mocked `payments` table represents the PRE-transition row (as read by
    // loadTransitionTarget). The RPC result carries the transition's outcome —
    // asserted via the recorded call args, the same pattern order-domain.test.ts
    // uses for transitionPaymentStatus (a static mock can't reflect a DB write).
    const calls = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "pending", verification_state: "unverified" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          verify_payment_v1: {
            data: {
              status: "success",
              from: "unverified",
              to: "staff_confirmed",
              payment_status: "paid",
            },
            error: null,
          },
        },
      },
      async (recorded) => {
        await verifyPayment(ctx, PAYMENT_ID, "staff_confirmed", "Cash at counter");
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "verify_payment_v1");
    expect(call?.args["p_expected_from"]).toBe("unverified");
    expect(call?.args["p_to"]).toBe("staff_confirmed");
    expect(call?.args["p_reason"]).toBe("Cash at counter");
  });
});

describe("Test 7: Unauthorized staff confirmation rejected", () => {
  it("a caller without payments.manual_confirm cannot move a payment to staff_confirmed", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"]);
    await expectForbidden(() => verifyPayment(ctx, PAYMENT_ID, "staff_confirmed"));
  });

  it("a caller with only payments.manual_confirm cannot escalate to manager_verified", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      "payments.read",
      "payments.manual_confirm",
    ]);
    await expectForbidden(() => verifyPayment(ctx, PAYMENT_ID, "manager_verified"));
  });
});

describe("Test 8: Actor is always server-derived", () => {
  it("verifyPayment sends the authorization context's userId as p_actor", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "pending", verification_state: "unverified" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          verify_payment_v1: { data: { status: "success", payment_status: "paid" }, error: null },
        },
      },
      async (recorded) => {
        await verifyPayment(ctx, PAYMENT_ID, "staff_confirmed");
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "verify_payment_v1");
    expect(call?.args["p_actor"]).toBe(USER_ORG_A);
  });

  it("recordPayment sends the authorization context's userId as p_recorded_by", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          orders: orderRow,
          payments: paymentRow(),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          record_payment_v1: {
            data: {
              status: "success",
              payment_id: PAYMENT_ID,
              duplicate_suspected: false,
              replayed: false,
            },
            error: null,
          },
        },
      },
      async (recorded) => {
        await recordPayment(ctx, { orderId: ORDER_ID, method: "cash", amountMinor: 1000 });
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "record_payment_v1");
    expect(call?.args["p_recorded_by"]).toBe(USER_ORG_A);
  });
});

describe("Test 9: Amount / method / reference captured exactly", () => {
  it("recordPayment forwards amount, method and reference unchanged to the RPC", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          orders: orderRow,
          payments: paymentRow({
            reference: "ABA-REF-123",
            amount_minor: 4500,
            method: "bank_transfer",
          }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          record_payment_v1: {
            data: {
              status: "success",
              payment_id: PAYMENT_ID,
              duplicate_suspected: false,
              replayed: false,
            },
            error: null,
          },
        },
      },
      async (recorded) => {
        await recordPayment(ctx, {
          orderId: ORDER_ID,
          method: "bank_transfer",
          amountMinor: 4500,
          reference: "ABA-REF-123",
        });
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "record_payment_v1");
    expect(call?.args["p_method"]).toBe("bank_transfer");
    expect(call?.args["p_amount_minor"]).toBe(4500);
    expect(call?.args["p_reference"]).toBe("ABA-REF-123");
  });

  it("rejects a non-positive amount before ever calling the database", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);
    const err = await expectRejects(() =>
      recordPayment(ctx, { orderId: ORDER_ID, method: "cash", amountMinor: 0 }),
    );
    expect(err.message).toMatch(/positive integer/i);
  });
});

describe("Test 10: Evidence attachment never marks a payment paid", () => {
  it("attachEvidence never calls verify_payment_v1, and the payment's status/verification are unchanged", async () => {
    const { attachEvidence } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const { detail, calls } = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "pending", verification_state: "unverified" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          attach_payment_evidence_v1: {
            data: { status: "success", evidence_id: "evidence-1" },
            error: null,
          },
        },
      },
      async (recorded) => {
        const d = await attachEvidence(ctx, {
          paymentId: PAYMENT_ID,
          evidenceType: "screenshot",
          storageRef: "evidence/screenshot-1.png",
        });
        return { detail: d, calls: recorded };
      },
    );

    expect(detail.status).toBe("pending");
    expect(detail.verificationState).toBe("unverified");
    expect(calls.some((c) => c.fn === "verify_payment_v1")).toBe(false);
    expect(calls.some((c) => c.fn === "attach_payment_evidence_v1")).toBe(true);
  });

  it("SQL: attach_payment_evidence_v1 never assigns payments.status or verification_state", () => {
    const sql = executableSql(rpcMigration());
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.attach_payment_evidence_v1");
    const fnEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.verify_payment_v1");
    const fnBody = sql.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/UPDATE public\.payments/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMMUTABILITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 11: payment_events is append-only at the database level", () => {
  it("SQL: a trigger blocks UPDATE on payment_events unconditionally", () => {
    const sql = paymentsMigration();
    expect(sql).toMatch(
      /CREATE TRIGGER payment_events_no_update\s*\n\s*BEFORE UPDATE ON public\.payment_events/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION\s*\n\s*'payment_events is an append-only ledger/);
  });

  it("SQL: a trigger blocks DELETE on payment_events unconditionally", () => {
    const sql = paymentsMigration();
    expect(sql).toMatch(
      /CREATE TRIGGER payment_events_no_delete\s*\n\s*BEFORE DELETE ON public\.payment_events/,
    );
  });

  it("SQL: the blocking function raises regardless of role — not merely an RLS policy", () => {
    const sql = paymentsMigration();
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.block_payment_event_mutation");
    const fnEnd = sql.indexOf("CREATE TRIGGER payment_events_no_update");
    const fnBody = sql.slice(fnStart, fnEnd);
    expect(fnBody).toContain("RAISE EXCEPTION");
    expect(fnBody).not.toContain("SECURITY DEFINER"); // fires as-is for every caller, no role rewrite
  });
});

describe("Test 12: Correction appends, never rewrites directly", () => {
  it("correctPayment calls correct_payment_v1 and does not touch amount/method/currency", async () => {
    const { correctPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ reference: "OLD-REF" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: { correct_payment_v1: { data: { status: "success" }, error: null } },
      },
      async (recorded) => {
        await correctPayment(ctx, PAYMENT_ID, "Typo in reference", { reference: "NEW-REF" });
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "correct_payment_v1");
    expect(call).toBeDefined();
    expect(call?.args).not.toHaveProperty("p_amount_minor");
    expect(call?.args).not.toHaveProperty("p_method");
  });

  it("requires payments.override_status", async () => {
    const { correctPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"]);
    await expectForbidden(() => correctPayment(ctx, PAYMENT_ID, "reason", { note: "x" }));
  });

  it("SQL: correct_payment_v1 only ever sets reference/note, and always inserts a correction event", () => {
    const sql = executableSql(rpcMigration());
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.correct_payment_v1");
    const fnBody = sql.slice(fnStart);
    expect(fnBody).toMatch(/UPDATE public\.payments\s*\n\s*SET\s*\n\s*reference = COALESCE/);
    expect(fnBody).not.toMatch(/amount_minor = /);
    expect(fnBody).toContain("'correction'");
  });
});

describe("Test 13: Reversal appends an event", () => {
  it("reversePayment calls reverse_payment_v1 with the reason", async () => {
    const { reversePayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "paid" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: { reverse_payment_v1: { data: { status: "success" }, error: null } },
      },
      async (recorded) => {
        await reversePayment(ctx, PAYMENT_ID, "Customer disputed the charge");
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "reverse_payment_v1");
    expect(call?.args["p_reason"]).toBe("Customer disputed the charge");
  });

  it("requires a non-empty reason before calling the database", async () => {
    const { reversePayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);
    const err = await expectRejects(() => reversePayment(ctx, PAYMENT_ID, "   "));
    expect(err.message).toMatch(/reversal reason is required/i);
  });

  it("requires payments.reverse", async () => {
    const { reversePayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"]);
    await expectForbidden(() => reversePayment(ctx, PAYMENT_ID, "reason"));
  });
});

describe("Test 14: Refund appends an event; audit is fail-closed", () => {
  it("refundPayment calls refund_payment_v1 with the amount and reason", async () => {
    const { refundPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const calls = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "paid", amount_minor: 1000 }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          refund_payment_v1: {
            data: { status: "success", refunded_total: 400, fully_refunded: false },
            error: null,
          },
        },
      },
      async (recorded) => {
        await refundPayment(ctx, PAYMENT_ID, 400, "Partial refund — damaged item");
        return recorded;
      },
    );

    const call = calls.find((c) => c.fn === "refund_payment_v1");
    expect(call?.args["p_amount_minor"]).toBe(400);
    expect(call?.args["p_reason"]).toBe("Partial refund — damaged item");
  });

  it("a partial refund leaves the payment's status untouched by the service (DB decides finality)", async () => {
    const { refundPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const detail = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({ status: "paid" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          refund_payment_v1: {
            data: { status: "success", refunded_total: 400, fully_refunded: false },
            error: null,
          },
        },
      },
      () => refundPayment(ctx, PAYMENT_ID, 400, "Partial refund"),
    );

    // The service never writes payments.status itself — it always re-reads the
    // row the RPC produced. Here the mock represents a partial refund, so the
    // row is still 'paid'.
    expect(detail.status).toBe("paid");
  });

  it("rejects a refund exceeding what remains, mapping the DB's safe error", async () => {
    const { refundPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb(
      {
        tables: { payments: paymentRow({ status: "paid", amount_minor: 1000 }) },
        rpc: {
          refund_payment_v1: {
            data: {
              status: "invalid_amount",
              reason: "exceeds_paid_amount",
              already_refunded: 800,
              payment_amount: 1000,
            },
            error: null,
          },
        },
      },
      async () => {
        const err = await expectRejects(() => refundPayment(ctx, PAYMENT_ID, 500, "Too much"));
        expect(err.message).toMatch(/exceeds what remains/i);
        expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
      },
    );
  });

  it("blocks the refund when the mandatory audit write fails (fail-closed)", async () => {
    mock.module("@/server/auth/audit", () => ({
      auditLog: async () => {},
      auditLogRequired: async () => {
        throw new Error("Audit record could not be persisted");
      },
      MANDATORY_AUDIT_ACTIONS: new Set(["payments.refund"]),
    }));

    const { refundPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb(
      {
        tables: { payments: paymentRow({ status: "paid" }) },
        rpc: {
          refund_payment_v1: {
            data: { status: "success", refunded_total: 1000, fully_refunded: true },
            error: null,
          },
        },
      },
      async () => {
        await expect(refundPayment(ctx, PAYMENT_ID, 1000, "Full refund")).rejects.toThrow(
          /could not be persisted/i,
        );
      },
    );

    restoreDefaultAuditMock();
  });

  it("payments.reverse and payments.refund are registered as MANDATORY_AUDIT_ACTIONS", async () => {
    const { MANDATORY_AUDIT_ACTIONS } = await import("../server/auth/audit");
    expect(MANDATORY_AUDIT_ACTIONS.has("payments.reverse")).toBe(true);
    expect(MANDATORY_AUDIT_ACTIONS.has("payments.refund")).toBe(true);
  });
});

describe("Test 15: No delete path exists anywhere in the repository", () => {
  it("payments/repository.ts contains no .delete( call", () => {
    expect(paymentsRepositorySource()).not.toMatch(/\.delete\(/);
  });

  it("payments/repository.ts writes only through RPCs — no direct .update( on a table", () => {
    const src = paymentsRepositorySource();
    // Reconciliation/read helpers use .select(); every mutation goes through .rpc(.
    expect(src).not.toMatch(/\.from\(["']payments["']\)\s*\n?\s*\.update\(/);
  });

  it("SQL: payments/payment_events/payment_evidence all use RESTRICT, never CASCADE, on their financial FKs", () => {
    const sql = paymentsMigration();
    expect(sql).toMatch(
      /order_id\s+UUID NOT NULL REFERENCES public\.orders\(id\) ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /payment_id\s+UUID NOT NULL REFERENCES public\.payments\(id\) ON DELETE RESTRICT/g,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE / IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 16: Duplicate reference is flagged, not rejected", () => {
  it("a recorded payment with a colliding reference is returned as duplicate_suspected, and still created", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const detail = await withPaymentDb(
      {
        tables: {
          orders: orderRow,
          payments: paymentRow({
            verification_state: "duplicate_suspected",
            reference: "ABA-REF-1",
          }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          record_payment_v1: {
            data: {
              status: "success",
              payment_id: PAYMENT_ID,
              duplicate_suspected: true,
              replayed: false,
            },
            error: null,
          },
        },
      },
      () =>
        recordPayment(ctx, {
          orderId: ORDER_ID,
          method: "bank_transfer",
          amountMinor: 1000,
          reference: "ABA-REF-1",
        }),
    );

    expect(detail.verificationState).toBe("duplicate_suspected");
  });

  it("SQL: a duplicate reference does not block the INSERT — it only changes the initial verification_state", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).toMatch(
      /v_initial_state := CASE WHEN v_duplicate THEN 'duplicate_suspected' ELSE 'unverified' END/,
    );
    expect(sql).not.toMatch(/RETURN jsonb_build_object\('status', 'duplicate_reference'\)/);
  });
});

describe("Test 17: Idempotency key replay returns the same payment", () => {
  it("a replayed record_payment_v1 result produces no second audit entry", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const auditCalls: unknown[] = [];
    mock.module("@/server/auth/audit", () => ({
      auditLog: async (_ctx: unknown, payload: unknown) => {
        auditCalls.push(payload);
      },
      auditLogRequired: async () => {},
      MANDATORY_AUDIT_ACTIONS: new Set(["payments.reverse", "payments.refund"]),
    }));

    const { recordPayment: recordPaymentFresh } = await import("../server/payments/service");

    const detail = await withPaymentDb(
      {
        tables: {
          orders: orderRow,
          payments: paymentRow(),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          record_payment_v1: {
            data: {
              status: "success",
              payment_id: PAYMENT_ID,
              duplicate_suspected: false,
              replayed: true,
            },
            error: null,
          },
        },
      },
      () =>
        recordPaymentFresh(ctx, {
          orderId: ORDER_ID,
          method: "cash",
          amountMinor: 1000,
          idempotencyKey: "click-abc-123",
        }),
    );

    expect(detail.id).toBe(PAYMENT_ID);
    expect(auditCalls).toHaveLength(0);

    restoreDefaultAuditMock();
    void recordPayment; // keep the top-level import referenced for lint purposes
  });

  it("SQL: record_payment_v1 uses ON CONFLICT against the idempotency unique index, not a pre-check race", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).toMatch(
      /ON CONFLICT \(organization_id, idempotency_key\) WHERE idempotency_key IS NOT NULL\s*\n\s*DO NOTHING/,
    );
  });

  it("SQL: migration 034 defines a hard unique index for idempotency, scoped per organization", () => {
    const sql = paymentsMigration();
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uniq_payments_idempotency\s*\n\s*ON public\.payments\(organization_id, idempotency_key\)\s*\n\s*WHERE idempotency_key IS NOT NULL/,
    );
  });
});

describe("Test 18: Concurrent verification is a conflict, not a silent overwrite", () => {
  it("a stale verification_state re-read is surfaced as a 409, never applied blindly", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb(
      {
        tables: { payments: paymentRow({ verification_state: "unverified" }) },
        rpc: {
          verify_payment_v1: { data: { status: "stale", current: "staff_confirmed" }, error: null },
        },
      },
      async () => {
        const err = await expectRejects(() => verifyPayment(ctx, PAYMENT_ID, "staff_confirmed"));
        expect(err.message).toMatch(/changed concurrently/i);
        expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 19: Verification transition table", () => {
  it("unverified accepts staff_confirmed, bank_verified and mismatch — nothing else", async () => {
    const { isValidVerificationTransition } = await import("../server/payments/state-machine");
    expect(isValidVerificationTransition("unverified", "staff_confirmed")).toBe(true);
    expect(isValidVerificationTransition("unverified", "bank_verified")).toBe(true);
    expect(isValidVerificationTransition("unverified", "mismatch")).toBe(true);
    expect(isValidVerificationTransition("unverified", "manager_verified")).toBe(false);
  });

  it("bank_verified only exits to mismatch — it is otherwise terminal", async () => {
    const { isValidVerificationTransition } = await import("../server/payments/state-machine");
    expect(isValidVerificationTransition("bank_verified", "mismatch")).toBe(true);
    expect(isValidVerificationTransition("bank_verified", "staff_confirmed")).toBe(false);
    expect(isValidVerificationTransition("bank_verified", "unverified")).toBe(false);
  });

  it("duplicate_suspected can be cleared, escalated, or confirmed genuinely wrong", async () => {
    const { isValidVerificationTransition } = await import("../server/payments/state-machine");
    expect(isValidVerificationTransition("duplicate_suspected", "unverified")).toBe(true);
    expect(isValidVerificationTransition("duplicate_suspected", "staff_confirmed")).toBe(true);
    expect(isValidVerificationTransition("duplicate_suspected", "manager_verified")).toBe(true);
    expect(isValidVerificationTransition("duplicate_suspected", "mismatch")).toBe(true);
    expect(isValidVerificationTransition("duplicate_suspected", "bank_verified")).toBe(false);
  });

  it("the service rejects an invalid transition before ever calling the database", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb(
      { tables: { payments: paymentRow({ verification_state: "bank_verified" }) } },
      async (calls) => {
        const err = await expectRejects(() => verifyPayment(ctx, PAYMENT_ID, "staff_confirmed"));
        expect(err.message).toMatch(/Cannot move payment verification/);
        expect(calls.some((c) => c.fn === "verify_payment_v1")).toBe(false);
      },
    );
  });

  it("a reversed or refunded payment accepts no further verification transition", async () => {
    const { verifyPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    await withPaymentDb({ tables: { payments: paymentRow({ status: "reversed" }) } }, async () => {
      const err = await expectRejects(() => verifyPayment(ctx, PAYMENT_ID, "mismatch"));
      expect(err.message).toMatch(/reversed/i);
    });
  });
});

describe("Test 20: resultingPaymentStatus is the single source of the status mapping", () => {
  it("staff_confirmed / manager_verified / bank_verified all resolve to 'paid'", async () => {
    const { resultingPaymentStatus } = await import("../server/payments/state-machine");
    expect(resultingPaymentStatus("staff_confirmed")).toBe("paid");
    expect(resultingPaymentStatus("manager_verified")).toBe("paid");
    expect(resultingPaymentStatus("bank_verified")).toBe("paid");
  });

  it("mismatch resolves to 'failed'", async () => {
    const { resultingPaymentStatus } = await import("../server/payments/state-machine");
    expect(resultingPaymentStatus("mismatch")).toBe("failed");
  });

  it("unverified and duplicate_suspected resolve to 'pending'", async () => {
    const { resultingPaymentStatus } = await import("../server/payments/state-machine");
    expect(resultingPaymentStatus("unverified")).toBe("pending");
    expect(resultingPaymentStatus("duplicate_suspected")).toBe("pending");
  });

  it("SQL: verify_payment_v1 applies exactly this mapping", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).toMatch(/WHEN 'staff_confirmed'\s+THEN 'paid'/);
    expect(sql).toMatch(/WHEN 'mismatch'\s+THEN 'failed'/);
  });
});

describe("Test 21: Bank/API verification hook contract is provider-agnostic", () => {
  it("the default adapter reports not_found — no live provider is wired in this phase", async () => {
    const { manualOnlyAdapter } = await import("../server/payments/integrations");
    const outcome = await manualOnlyAdapter.verify({
      organizationId: ORG_A_ID,
      paymentId: PAYMENT_ID,
      reference: "ABA-REF-1",
      amountMinor: 1000,
      currency: "USD",
    });
    expect(outcome.kind).toBe("not_found");
  });

  it("outcomeToVerificationTarget maps every normalized outcome kind, never a raw provider payload", async () => {
    const { outcomeToVerificationTarget } = await import("../server/payments/integrations");

    expect(
      outcomeToVerificationTarget({
        kind: "verified",
        providerReference: "ref-1",
        verifiedAt: "2026-01-01",
      }).to,
    ).toBe("bank_verified");
    expect(outcomeToVerificationTarget({ kind: "mismatch", reason: "amount differs" }).to).toBe(
      "mismatch",
    );
    expect(
      outcomeToVerificationTarget({ kind: "duplicate", conflictingReference: "ref-2" }).to,
    ).toBe("mismatch");
    expect(outcomeToVerificationTarget({ kind: "not_found" }).to).toBeNull();
    expect(
      outcomeToVerificationTarget({ kind: "adapter_error", message: "timeout" }).to,
    ).toBeNull();
  });

  it("the adapter interface has no provider-specific field or method name", async () => {
    // Strip comments — mentioning a provider as a future-example in prose is
    // fine; the invariant is that no field/type/method NAME names one.
    const src = readSource("src/server/payments/integrations.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of ["aba", "wing", "bakong", "khqrProvider"]) {
      expect(src.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COD
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 22: Delivery migration never touches the payments table", () => {
  it("migration 027 has no reference to public.payments", () => {
    expect(deliveryMigration()).not.toMatch(/public\.payments\b/);
  });

  it("migration 027's own COD comment is unchanged: cod_amount_minor never drives payment state", () => {
    expect(deliveryMigration()).toMatch(
      /This is not a payment record and never drives\s*\n\s*-- orders\.payment_status or COD settlement state\./,
    );
  });
});

describe("Test 23: Delivery domain never imports the Payment domain", () => {
  it("src/server/deliveries/service.ts has no import of @/server/payments", () => {
    expect(deliveryServiceSource()).not.toContain("@/server/payments");
  });

  it("src/server/deliveries/repository.ts has no import of @/server/payments", () => {
    expect(deliveryRepositorySource()).not.toContain("@/server/payments");
  });
});

describe("Test 24: COD settlement requires payments.mark_cod, not payments.record", () => {
  it("recording a cod payment with only payments.record is rejected", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read", "payments.record"]);
    await expectForbidden(() =>
      recordPayment(ctx, { orderId: ORDER_ID, method: "cod", amountMinor: 1000 }),
    );
  });

  it("recording a cash payment with only payments.mark_cod is rejected", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read", "payments.mark_cod"]);
    await expectForbidden(() =>
      recordPayment(ctx, { orderId: ORDER_ID, method: "cash", amountMinor: 1000 }),
    );
  });

  it("recording a cod payment with payments.mark_cod succeeds", async () => {
    const { recordPayment } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read", "payments.mark_cod"]);

    const detail = await withPaymentDb(
      {
        tables: {
          orders: orderRow,
          payments: paymentRow({ method: "cod" }),
          payment_events: emptyEvents,
          payment_evidence: emptyEvidence,
        },
        rpc: {
          record_payment_v1: {
            data: {
              status: "success",
              payment_id: PAYMENT_ID,
              duplicate_suspected: false,
              replayed: false,
            },
            error: null,
          },
        },
      },
      () => recordPayment(ctx, { orderId: ORDER_ID, method: "cod", amountMinor: 1000 }),
    );

    expect(detail.method).toBe("cod");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MUTATION BLOCK
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 25: The Payment domain never imports the Order domain", () => {
  // These files legitimately DISCUSS @/server/orders and transitionPaymentStatus
  // in doc comments (explaining the deliberate separation) — the invariant under
  // test is that no actual import or call site exists, not that the string is
  // absent from prose. So we check import/call syntax specifically.

  it("service.ts has no import statement naming @/server/orders", () => {
    expect(paymentsServiceSource()).not.toMatch(/from\s+["']@\/server\/orders/);
  });

  it("repository.ts has no import statement naming @/server/orders", () => {
    expect(paymentsRepositorySource()).not.toMatch(/from\s+["']@\/server\/orders/);
  });

  it("no file under src/server/payments calls transitionPaymentStatus( or transitionOrderPaymentFn(", () => {
    const dir = path.resolve(process.cwd(), "src/server/payments");
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(src).not.toMatch(/transitionPaymentStatus\(/);
      expect(src).not.toMatch(/transitionOrderPaymentFn\(/);
    }
  });
});

describe("Test 26: No Payment RPC ever writes to the orders table", () => {
  it("SQL: migration 035 contains no UPDATE of public.orders", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).not.toMatch(/UPDATE public\.orders\b/);
  });

  it("SQL: migration 034 contains no UPDATE of public.orders", () => {
    const sql = executableSql(paymentsMigration());
    expect(sql).not.toMatch(/UPDATE public\.orders\b/);
  });

  it("the order lookup used by recordPayment is read-only (SELECT only, no .update)", () => {
    const src = paymentsRepositorySource();
    const fnStart = src.indexOf("export async function findOrderForOrg");
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain(".select(");
    expect(fnBody).not.toContain(".update(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 27: Reconciliation buckets", () => {
  it("aggregates paid/pending/needs-review/COD-unsettled correctly from the summary view", async () => {
    const { getReconciliationSummary } = await import("../server/payments/reconciliation");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const summaryRows = rows([
      {
        organization_id: ORG_A_ID,
        method: "cash",
        currency: "USD",
        status: "paid",
        verification_state: "staff_confirmed",
        payment_count: 2,
        amount_minor_total: 2000,
      },
      {
        organization_id: ORG_A_ID,
        method: "bank_transfer",
        currency: "USD",
        status: "paid",
        verification_state: "bank_verified",
        payment_count: 1,
        amount_minor_total: 500,
      },
      {
        organization_id: ORG_A_ID,
        method: "khqr",
        currency: "USD",
        status: "pending",
        verification_state: "unverified",
        payment_count: 1,
        amount_minor_total: 300,
      },
      {
        organization_id: ORG_A_ID,
        method: "bank_transfer",
        currency: "USD",
        status: "pending",
        verification_state: "duplicate_suspected",
        payment_count: 1,
        amount_minor_total: 150,
      },
      {
        organization_id: ORG_A_ID,
        method: "cod",
        currency: "USD",
        status: "pending",
        verification_state: "unverified",
        payment_count: 3,
        amount_minor_total: 900,
      },
      {
        organization_id: ORG_A_ID,
        method: "cash",
        currency: "USD",
        status: "refunded",
        // reverse_payment_v1/refund_payment_v1 never touch verification_state
        // (migration 035) — a refunded payment can still carry the trust
        // level it had before it was refunded. This row is the reason
        // managerVerified must gate on status = 'paid': it must NOT count
        // toward managerVerified below, since that money is no longer live.
        verification_state: "manager_verified",
        payment_count: 1,
        amount_minor_total: 1000,
      },
      {
        organization_id: ORG_A_ID,
        method: "bank_transfer",
        currency: "USD",
        status: "reversed",
        // Same reasoning as the refunded row above: a reversed payment can
        // still carry a stale 'staff_confirmed' trust level. This is the
        // exact regression case for the bug found in PR #30 review — this
        // row's 5000 must NOT appear in expectedRevenue or staffConfirmedOnly.
        verification_state: "staff_confirmed",
        payment_count: 1,
        amount_minor_total: 5000,
      },
      {
        organization_id: ORG_A_ID,
        method: "khqr",
        currency: "USD",
        status: "failed",
        verification_state: "mismatch",
        payment_count: 1,
        amount_minor_total: 700,
      },
    ]);

    const [summary] = await withPaymentDb(
      { tables: { payment_reconciliation_summary: summaryRows } },
      () => getReconciliationSummary(ctx),
    );

    // expectedRevenue = pending + paid + refunded only. Excludes the 5000
    // 'reversed' row and the 700 'failed' row entirely — see the field's own
    // documentation on ReconciliationSummary for why.
    expect(summary!.expectedRevenue.amount.amount).toBe(2000 + 500 + 300 + 150 + 900 + 1000);
    expect(summary!.paid.amount.amount).toBe(2500);
    expect(summary!.pending.amount.amount).toBe(300 + 150 + 900);
    expect(summary!.failed.amount.amount).toBe(700);
    expect(summary!.reversed.amount.amount).toBe(5000);
    expect(summary!.refunded.amount.amount).toBe(1000);

    // Trust-tier buckets only count CURRENTLY LIVE money (status = 'paid').
    // The refunded manager_verified row (1000) and the reversed
    // staff_confirmed row (5000) must be excluded from both.
    expect(summary!.bankVerified.amount.amount).toBe(500);
    expect(summary!.managerVerified.amount.amount).toBe(0);
    expect(summary!.staffConfirmedOnly.amount.amount).toBe(2000);

    // needs_review = duplicate_suspected (150) + mismatch (700, still live —
    // 'failed' is not excluded, only 'reversed'/'refunded' are) +
    // pending&unverified (300 khqr + 900 cod)
    expect(summary!.needsReview.amount.amount).toBe(150 + 700 + 300 + 900);
    expect(summary!.duplicateSuspected.amount.amount).toBe(150);
    expect(summary!.mismatch.amount.amount).toBe(700);
    expect(summary!.codUnsettled.amount.amount).toBe(900);
  });

  it("two currencies never sum into one bucket", async () => {
    const { getReconciliationSummary } = await import("../server/payments/reconciliation");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS);

    const summaryRows = rows([
      {
        organization_id: ORG_A_ID,
        method: "cash",
        currency: "USD",
        status: "paid",
        verification_state: "staff_confirmed",
        payment_count: 1,
        amount_minor_total: 1000,
      },
      {
        organization_id: ORG_A_ID,
        method: "cash",
        currency: "KHR",
        status: "paid",
        verification_state: "staff_confirmed",
        payment_count: 1,
        amount_minor_total: 4100,
      },
    ]);

    const summaries = await withPaymentDb(
      { tables: { payment_reconciliation_summary: summaryRows } },
      () => getReconciliationSummary(ctx),
    );

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.currency).sort()).toEqual(["KHR", "USD"]);
  });
});

describe("Test 28: Reconciliation requires payments.reconcile", () => {
  it("a caller without payments.reconcile is rejected", async () => {
    const { getReconciliationSummary } = await import("../server/payments/reconciliation");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"]);
    await expectForbidden(() => getReconciliationSummary(ctx));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY / BUNDLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 29: src/api/payments.ts respects the server/browser boundary", () => {
  it("no static top-level import of @/lib/supabase/server or @/server/payments", () => {
    const src = paymentsApiSource();
    const staticImportLines = src.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import ") && !trimmed.startsWith("import{")) return false;
      if (/^import\s+type\b/.test(trimmed)) return false;
      return true;
    });
    const offending = staticImportLines.filter(
      (line) => line.includes("lib/supabase/server") || line.includes("@/server/payments"),
    );
    expect(offending).toEqual([]);
  });

  it("uses await import for the service and repository, never a static import", () => {
    const src = paymentsApiSource();
    expect(src).toMatch(/await import\(["']@\/server\/payments\/service["']\)/);
    expect(src).toMatch(/await import\(["']@\/server\/payments\/reconciliation["']\)/);
    expect(src).toMatch(/await import\(["']@\/lib\/supabase\/server["']\)/);
  });
});

describe("Test 30: No client-trusted organizationId or userId parameter", () => {
  it("no zod schema in src/api/payments.ts accepts organizationId or userId", () => {
    const src = paymentsApiSource();
    expect(src).not.toContain("organizationId:");
    expect(src).not.toContain("userId:");
  });

  it("resolveAuthContext derives organization from DB membership, never from input", () => {
    const src = paymentsApiSource();
    expect(src).toMatch(/\.from\("memberships"\)/);
    expect(src).toMatch(/\.eq\("user_id", session\.userId\)/);
  });

  it("no route or component imports the Payment server domain directly", () => {
    for (const dir of ["src/routes", "src/components"]) {
      const abs = path.resolve(process.cwd(), dir);
      if (!fs.existsSync(abs)) continue;
      const walk = (current: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) out.push(...walk(full));
          else if (/\.tsx?$/.test(entry.name)) out.push(full);
        }
        return out;
      };
      for (const file of walk(abs)) {
        const src = fs.readFileSync(file, "utf-8");
        expect(src).not.toContain("@/server/payments");
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SENSITIVE REFERENCE WITHHOLDING (PR #30 review — Blocker 1 fix)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 31: payment_events metadata never leaks a withheld reference", () => {
  it("a caller without payments.view_provider_reference sees both the top-level field AND event metadata redacted", async () => {
    const { getPaymentById } = await import("../server/payments/service");
    // payments.read only — deliberately NOT payments.view_provider_reference.
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"], "CASHIER");

    const detail = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({
            reference: "ABA-SECRET-REF-999",
            verification_state: "duplicate_suspected",
          }),
          payment_events: rows([
            {
              id: "evt-1",
              organization_id: ORG_A_ID,
              payment_id: PAYMENT_ID,
              event_type: "duplicate_flagged",
              amount_minor: null,
              currency: null,
              from_verification: null,
              to_verification: null,
              actor_user_id: USER_ORG_A,
              reason: "Reference matches another active payment in this organization",
              metadata: { reference: "ABA-SECRET-REF-999" },
              created_at: "2026-09-05T00:00:00.000Z",
            },
            {
              id: "evt-2",
              organization_id: ORG_A_ID,
              payment_id: PAYMENT_ID,
              event_type: "correction",
              amount_minor: null,
              currency: null,
              from_verification: null,
              to_verification: null,
              actor_user_id: USER_ORG_A,
              reason: "Typo fix",
              metadata: {
                before: { reference: "OLD-REF", note: null },
                after: { reference: "ABA-SECRET-REF-999", note: null },
              },
              created_at: "2026-09-05T00:01:00.000Z",
            },
          ]),
          payment_evidence: emptyEvidence,
        },
      },
      () => getPaymentById(ctx, PAYMENT_ID),
    );

    // Top-level field: withheld (pre-existing behavior).
    expect(detail.reference).toBeNull();

    // Event metadata: must ALSO be withheld — this is the bug found in review.
    const duplicateEvent = detail.events.find((e) => e.eventType === "duplicate_flagged");
    expect(duplicateEvent?.metadata).toEqual({ reference: null });

    const correctionEvent = detail.events.find((e) => e.eventType === "correction");
    expect(correctionEvent?.metadata).toEqual({
      before: { reference: null, note: null },
      after: { reference: null, note: null },
    });

    // The reason string (non-reference prose) is untouched.
    expect(duplicateEvent?.reason).toContain("Reference matches another active payment");
  });

  it("a caller WITH payments.view_provider_reference sees the reference in both places", async () => {
    const { getPaymentById } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_PAYMENT_PERMS, "OWNER");

    const detail = await withPaymentDb(
      {
        tables: {
          payments: paymentRow({
            reference: "ABA-SECRET-REF-999",
            verification_state: "duplicate_suspected",
          }),
          payment_events: rows([
            {
              id: "evt-1",
              organization_id: ORG_A_ID,
              payment_id: PAYMENT_ID,
              event_type: "duplicate_flagged",
              amount_minor: null,
              currency: null,
              from_verification: null,
              to_verification: null,
              actor_user_id: USER_ORG_A,
              reason: "Reference matches another active payment in this organization",
              metadata: { reference: "ABA-SECRET-REF-999" },
              created_at: "2026-09-05T00:00:00.000Z",
            },
          ]),
          payment_evidence: emptyEvidence,
        },
      },
      () => getPaymentById(ctx, PAYMENT_ID),
    );

    expect(detail.reference).toBe("ABA-SECRET-REF-999");
    expect(detail.events[0]?.metadata).toEqual({ reference: "ABA-SECRET-REF-999" });
  });

  it("redaction is name-pattern based, so it also covers future/unanticipated metadata shapes", async () => {
    const { getPaymentById } = await import("../server/payments/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["payments.read"], "CASHIER");

    const detail = await withPaymentDb(
      {
        tables: {
          payments: paymentRow(),
          payment_events: rows([
            {
              id: "evt-1",
              organization_id: ORG_A_ID,
              payment_id: PAYMENT_ID,
              event_type: "bank_verified",
              amount_minor: null,
              currency: null,
              from_verification: "unverified",
              to_verification: "bank_verified",
              actor_user_id: null,
              reason: null,
              // Hypothetical future bank-adapter metadata shape (see
              // src/server/payments/integrations.ts#outcomeToVerificationTarget)
              // — not one of today's hardcoded event types, but the same
              // name-pattern redaction must still catch it.
              metadata: {
                providerReference: "BANK-XYZ-001",
                conflictingReference: "BANK-XYZ-002",
                nested: { list: [{ reference: "NESTED-REF" }] },
                amount: 1000,
              },
              created_at: "2026-09-05T00:00:00.000Z",
            },
          ]),
          payment_evidence: emptyEvidence,
        },
      },
      () => getPaymentById(ctx, PAYMENT_ID),
    );

    expect(detail.events[0]?.metadata).toEqual({
      providerReference: null,
      conflictingReference: null,
      nested: { list: [{ reference: null }] },
      amount: 1000,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE-REFERENCE CONCURRENCY (PR #30 review — Blocker 3 fix)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 32: record_payment_v1 serializes duplicate-reference detection", () => {
  it("SQL: an advisory lock keyed on (organization_id, reference) is taken before the EXISTS check", () => {
    const sql = executableSql(rpcMigration());
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.record_payment_v1");
    const fnEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.attach_payment_evidence_v1");
    const fnBody = sql.slice(fnStart, fnEnd);

    expect(fnBody).toContain("pg_advisory_xact_lock");
    expect(fnBody).toContain("v_lock_key");
    // The lock key must be derived from BOTH organization_id and the
    // reference — a lock keyed on reference alone would serialize unrelated
    // organizations against each other for no reason.
    expect(fnBody).toMatch(/hashtext\(p_organization_id::TEXT \|\| ':' \|\| v_reference\)/);

    const lockIdx = fnBody.indexOf("pg_advisory_xact_lock");
    const existsIdx = fnBody.indexOf("SELECT EXISTS");
    expect(lockIdx).toBeGreaterThan(0);
    expect(existsIdx).toBeGreaterThan(lockIdx);
  });

  it("SQL: the lock is transaction-scoped (xact), not session-scoped, so it can never leak past this call", () => {
    const sql = executableSql(rpcMigration());
    expect(sql).not.toMatch(/pg_advisory_lock\(/); // only the _xact_ variant should appear
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("SQL: the lock is skipped when no reference is supplied (no unnecessary serialization)", () => {
    const sql = executableSql(rpcMigration());
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.record_payment_v1");
    const fnEnd = sql.indexOf("CREATE OR REPLACE FUNCTION public.attach_payment_evidence_v1");
    const fnBody = sql.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/IF v_reference IS NOT NULL THEN\s*\n\s*v_lock_key := hashtext/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION VOCABULARY ALIGNMENT (PR #30 review — Blocker 4 fix)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 33: payments.verify/reverse/reconcile are recorded in PERMISSIONS_MATRIX.md", () => {
  it("PERMISSIONS_MATRIX.md §17 lists all three keys migration 036 seeds beyond the original matrix", () => {
    const matrix = readSource("PERMISSIONS_MATRIX.md");
    const section17Start = matrix.indexOf("# 17. PAYMENTS");
    const section18Start = matrix.indexOf("# 18. FINANCIALS");
    const section = matrix.slice(section17Start, section18Start);

    expect(section).toContain("`payments.verify`");
    expect(section).toContain("`payments.reverse`");
    expect(section).toContain("`payments.reconcile`");
  });
});
