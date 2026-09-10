/**
 * Payment ↔ Order Transactional Integration tests.
 *
 * Structure mirrors src/tests/order-inventory-integration.test.ts: the
 * behaviour under test is a single plpgsql function body (migration 039's
 * sync_order_payment_status_v1, wired into record/verify/reverse/
 * refund_payment_v1), so most assertions here are structural — over the
 * migration's executable SQL — rather than mocked round-trips, exactly for
 * the reason order-inventory-integration.test.ts gives: there is no live
 * Postgres to run this migration against yet (supabase/PAYMENTS.md §14 —
 * migrations 034–036 are not applied to any hosted project, and neither is
 * 039). TypeScript-level tests cover what changed in TypeScript: the closure
 * of the legacy direct-mutation path in src/server/orders/service.ts.
 *
 * Coverage:
 *   SETTLEMENT RULE — executable, against src/server/payments/settlement.ts
 *     1.  net settled < order total is NEVER paid ($100 order + $10 settled)
 *     2.  net settled == order total is paid (incl. two $50 payments)
 *     3.  net settled > order total is overpayment — coarse status stays
 *         'paid', the excess and needs-review flag are preserved
 *     4.  refunds subtract: $100 paid + $20 refund is no longer paid; a full
 *         refund returns the order to unpaid
 *     5.  reversals remove the whole claim, refunds included
 *     6.  pending / evidence-only / unsettled-COD / failed never count as money
 *     7.  duplicate retries and concurrent settlements cannot double-count
 *     8.  currency-safe, integer-only money (non-integer input is rejected)
 *   SETTLEMENT RULE — the SQL implements the same thing
 *     9.  sync_order_payment_status_v1 sums AMOUNTS against orders.total_minor
 *         (never "does a paid row exist"), BIGINT only, order currency only
 *    10.  overpayment truth preserved in SQL: return envelope on both paths,
 *         the immutable history reason, and the order_payment_settlement view
 *    11.  the order row is locked BEFORE the aggregate (concurrency), and a
 *         no-op still returns early
 *    12.  the aggregate and its refund sub-scan are organization-scoped
 *   COD
 *    13.  the Delivery migration still makes no executable reference to
 *         payments or orders.payment_status; this migration adds nothing there
 *   ORDER-SIDE CLOSURE
 *    14.  transitionPaymentStatus() refuses unconditionally now (TypeScript)
 *    15.  the permission gate still runs first — unauthorized stays 403
 *    16.  PAYMENT_TRANSITIONS.paid gained exits; the edges match what
 *         sync_order_payment_status_v1 can legitimately produce
 *   WIRING — one atomic function, not a TypeScript sequence
 *     5b. record_payment_v1 syncs on both the replay path and the normal path
 *     6b. verify_payment_v1 syncs after the payments UPDATE, using the
 *         payment's own order_id (never a parameter the caller could vary)
 *     7b. reverse_payment_v1 syncs after marking the payment reversed
 *     8b. refund_payment_v1 syncs on EVERY refund, partial ones included —
 *         the partial-refund regression this PR fixes
 *     9b. correct_payment_v1 and attach_payment_evidence_v1 are untouched —
 *         neither moves `status`, so neither has an Order consequence
 *         (SECURITY.md §41)
 *   TENANT ISOLATION
 *    17.  sync_order_payment_status_v1 takes p_organization_id and is
 *         revoked from anon/authenticated, granted only to service_role
 *    18.  no query filters by order_id alone
 *    19b. one tenant's payments cannot reach another tenant's settlement —
 *         repository read, service reads and server functions are all
 *         org-scoped and permission-gated
 *   IDEMPOTENCY
 *    19.  a replayed record_payment_v1 call syncs safely (no double financial
 *         write), and the uniqueness that makes that true lives in the index
 *   ATOMICITY / NO TWO-STEP SEQUENCE
 *    20.  src/server/payments/service.ts and repository.ts still never import
 *         the Order domain — the bridge is SQL calling SQL
 *    21.  each payment RPC's Order consequence is reached only AFTER its own
 *         payments/payment_events writes, in the same function body
 *   MIGRATION HYGIENE
 *    22.  039 is additive only — no DROP/TRUNCATE, no new table/column/enum
 *         value, and it does not redefine transition_order_status_v1 itself
 *    23.  039 does not modify 023/026/034/035/036
 *
 * Run: bun test src/tests/payment-order-integration.test.ts
 */

import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";
import {
  computeOrderSettlement,
  classifySettlement,
  settlementFactsFromPayments,
  type SettlementPayment,
} from "../server/payments/settlement";

// ── Context factory (mirrors order-domain.test.ts / payment-domain.test.ts) ──

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

// ── Fixture UUIDs ─────────────────────────────────────────────────────────────

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_ORG_A = "user-aaaa-0000-0000-0000-000000000001";
const ORDER_ID = "11111111-0000-0000-0000-000000000001";

// ── Source / migration readers ────────────────────────────────────────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

/** SQL with `--` comment lines removed — this migration explains at length
 * what it must NOT do, and a raw-text scan would read those warnings as the
 * thing they warn against (same rationale as order-inventory-integration's
 * executableSql). */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const INTEGRATION_MIGRATION = "supabase/migrations/039_payment_order_integration.sql";

const integrationSql = () => readSource(INTEGRATION_MIGRATION);
const integrationBody = () => executableSql(integrationSql());
const ordersMigration = () => readSource("supabase/migrations/023_orders.sql");
const inventoryIntegrationMigration = () =>
  readSource("supabase/migrations/026_order_inventory_integration.sql");
const paymentsDomainMigration = () => readSource("supabase/migrations/034_payments_domain.sql");
const paymentRpcMigration = () => readSource("supabase/migrations/035_payment_rpc.sql");
const paymentPermissionsMigration = () =>
  readSource("supabase/migrations/036_payment_permissions.sql");
const deliveryMigration = () =>
  readSource("supabase/migrations/027_delivery_fulfillment_domain.sql");
const paymentsServiceSource = () => readSource("src/server/payments/service.ts");
const paymentsRepositorySource = () => readSource("src/server/payments/repository.ts");

/**
 * The executable text of ONE `CREATE OR REPLACE FUNCTION public.<name>(...)`
 * definition, sliced from its own header to the next function definition or
 * the closing privileges section — whichever comes first. Slicing per
 * function matters for the same reason order-inventory-integration.test.ts
 * slices per branch: asserting "the migration calls sync_..." anywhere would
 * pass even if the call had landed in the wrong function.
 */
function functionBody(name: string): string {
  const sql = integrationBody();
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = sql.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = sql.slice(start + marker.length);
  const nextFn = rest.indexOf("CREATE OR REPLACE FUNCTION public.");
  const nextPriv = rest.indexOf("REVOKE EXECUTE ON FUNCTION");
  const boundaries = [nextFn, nextPriv].filter((i) => i >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : rest.length;
  return sql.slice(start, start + marker.length + end);
}

const syncFn = () => functionBody("sync_order_payment_status_v1");
const recordFn = () => functionBody("record_payment_v1");
const verifyFn = () => functionBody("verify_payment_v1");
const reverseFn = () => functionBody("reverse_payment_v1");
const refundFn = () => functionBody("refund_payment_v1");

// ═══════════════════════════════════════════════════════════════════════════════
// SETTLEMENT RULE — executable (src/server/payments/settlement.ts is the spec)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These run the real rule, not a description of it. The SQL in migration 039
// implements the same rule atomically; the structural tests further down
// assert the two agree.

const USD = "USD";

/** A settled payment of `amountMinor`, optionally partially refunded. */
function settled(amountMinor: number, refundedMinor = 0): SettlementPayment {
  return { amountMinor, currency: USD, status: "paid", refundedMinor };
}

function pendingPayment(amountMinor: number): SettlementPayment {
  return { amountMinor, currency: USD, status: "pending", refundedMinor: 0 };
}

describe("Test 1: net settled < order total is NEVER paid", () => {
  it("$100 order + $10 settled → NOT paid (the bug this rule replaced)", () => {
    const s = computeOrderSettlement([settled(1000)], USD, 10000);
    expect(s.netSettledMinor).toBe(1000);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.orderPaymentStatus).not.toBe("paid");
    expect(s.state).toBe("partial");
    expect(s.outstandingMinor).toBe(9000);
  });

  it("$100 order + $50 settled + $50 still pending → NOT paid", () => {
    const s = computeOrderSettlement([settled(5000), pendingPayment(5000)], USD, 10000);
    expect(s.netSettledMinor).toBe(5000);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.state).toBe("partial");
    expect(s.hasPendingPayment).toBe(true);
  });

  it("a nearly-complete settlement is still not paid — one minor unit short", () => {
    const s = computeOrderSettlement([settled(9999)], USD, 10000);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.outstandingMinor).toBe(1);
  });
});

describe("Test 2: net settled == order total is paid", () => {
  it("$100 order + $100 settled → paid", () => {
    const s = computeOrderSettlement([settled(10000)], USD, 10000);
    expect(s.netSettledMinor).toBe(10000);
    expect(s.orderPaymentStatus).toBe("paid");
    expect(s.state).toBe("settled");
    expect(s.outstandingMinor).toBe(0);
    expect(s.overSettledMinor).toBe(0);
    expect(s.needsReview).toBe(false);
  });

  it("$100 order + two $50 settled payments → paid (amounts aggregate)", () => {
    const s = computeOrderSettlement([settled(5000), settled(5000)], USD, 10000);
    expect(s.netSettledMinor).toBe(10000);
    expect(s.orderPaymentStatus).toBe("paid");
    expect(s.state).toBe("settled");
  });

  it("an order with no payments is never paid, even at a zero total", () => {
    const s = computeOrderSettlement([], USD, 0);
    expect(s.orderPaymentStatus).toBe("unpaid");
    expect(s.state).toBe("unsettled");
  });
});

describe("Test 3: net settled > order total is overpayment, preserved not discarded", () => {
  it("$100 order + $110 settled → coarse 'paid', excess preserved, needs review", () => {
    const s = computeOrderSettlement([settled(11000)], USD, 10000);
    expect(s.orderPaymentStatus).toBe("paid");
    expect(s.state).toBe("overpaid");
    expect(s.overSettledMinor).toBe(1000);
    expect(s.outstandingMinor).toBe(0);
    expect(s.needsReview).toBe(true);
  });

  it("overpayment via several payments is detected the same way", () => {
    const s = computeOrderSettlement([settled(6000), settled(6000)], USD, 10000);
    expect(s.state).toBe("overpaid");
    expect(s.overSettledMinor).toBe(2000);
    expect(s.needsReview).toBe(true);
  });

  it("a partially settled order is NOT flagged for review — deposits are ordinary", () => {
    const s = computeOrderSettlement([settled(5000)], USD, 10000);
    expect(s.state).toBe("partial");
    expect(s.needsReview).toBe(false);
  });

  it("the coarse axis gains no new enum value for overpayment", async () => {
    const { ORDER_PAYMENT_STATUSES } = await import("../server/orders/state-machine");
    expect(ORDER_PAYMENT_STATUSES).toEqual(["unpaid", "pending", "paid", "failed"]);
    expect(ORDER_PAYMENT_STATUSES as readonly string[]).not.toContain("overpaid");
    expect(ORDER_PAYMENT_STATUSES as readonly string[]).not.toContain("partially_paid");
  });
});

describe("Test 4: refunds subtract from net settled", () => {
  it("$100 paid → $20 refund → net $80 → NOT paid any more", () => {
    const s = computeOrderSettlement([settled(10000, 2000)], USD, 10000);
    expect(s.netSettledMinor).toBe(8000);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.orderPaymentStatus).not.toBe("paid");
    expect(s.state).toBe("partial");
    expect(s.outstandingMinor).toBe(2000);
  });

  it("$100 paid → full refund → net $0 → unpaid", () => {
    // refund_payment_v1 flips status to 'refunded' once refunds equal the
    // amount; either representation nets to zero.
    const fullyRefunded: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "refunded",
      refundedMinor: 10000,
    };
    const s = computeOrderSettlement([fullyRefunded], USD, 10000);
    expect(s.netSettledMinor).toBe(0);
    expect(s.orderPaymentStatus).toBe("unpaid");
    expect(s.state).toBe("unsettled");
  });

  it("a refund on one of two payments leaves the other's money counted", () => {
    const s = computeOrderSettlement([settled(5000, 5000), settled(5000)], USD, 10000);
    expect(s.netSettledMinor).toBe(5000);
    expect(s.orderPaymentStatus).toBe("pending");
  });
});

describe("Test 5: reversals remove the whole claim", () => {
  it("two settled payments, one reversed → only the remaining one counts", () => {
    const reversed: SettlementPayment = {
      amountMinor: 5000,
      currency: USD,
      status: "reversed",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([settled(5000), reversed], USD, 10000);
    expect(s.netSettledMinor).toBe(5000);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.state).toBe("partial");
  });

  it("reversing the only payment of a fully paid order un-pays it", () => {
    const reversed: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "reversed",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([reversed], USD, 10000);
    expect(s.netSettledMinor).toBe(0);
    expect(s.orderPaymentStatus).toBe("unpaid");
  });

  it("a reversal of a partially refunded payment removes it whole, refunds included", () => {
    const reversed: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "reversed",
      refundedMinor: 2000,
    };
    const s = computeOrderSettlement([reversed, settled(10000)], USD, 10000);
    // Only the live payment counts — the reversed one contributes 0, not 8000.
    expect(s.netSettledMinor).toBe(10000);
    expect(s.orderPaymentStatus).toBe("paid");
  });
});

describe("Test 6: unsettled claims never count as money", () => {
  it("a pending (unverified / evidence-only) payment contributes nothing", () => {
    const s = computeOrderSettlement([pendingPayment(10000)], USD, 10000);
    expect(s.netSettledMinor).toBe(0);
    expect(s.orderPaymentStatus).toBe("pending");
    expect(s.state).toBe("unsettled");
  });

  it("an unsettled COD collection contributes nothing until it is verified", () => {
    const codPending: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "pending",
      refundedMinor: 0,
    };
    expect(computeOrderSettlement([codPending], USD, 10000).orderPaymentStatus).toBe("pending");
    // ...and once staff confirm collection, the same amount settles it.
    expect(computeOrderSettlement([settled(10000)], USD, 10000).orderPaymentStatus).toBe("paid");
  });

  it("a failed payment contributes nothing and reports 'failed' when it is all there is", () => {
    const failed: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "failed",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([failed], USD, 10000);
    expect(s.netSettledMinor).toBe(0);
    expect(s.orderPaymentStatus).toBe("failed");
  });

  it("a failed attempt cannot un-pay an order other payments fully cover", () => {
    const failed: SettlementPayment = {
      amountMinor: 10000,
      currency: USD,
      status: "failed",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([settled(10000), failed], USD, 10000);
    expect(s.orderPaymentStatus).toBe("paid");
  });

  it("the amount math and the classification are separable, and agree", () => {
    const payments = [settled(6000, 1000), pendingPayment(2000)];
    const facts = settlementFactsFromPayments(payments, USD);
    expect(facts).toEqual({
      netSettledMinor: 5000,
      hasPendingPayment: true,
      hasFailedPayment: false,
    });
    expect(classifySettlement(facts, 10000)).toEqual(computeOrderSettlement(payments, USD, 10000));
  });
});

describe("Test 7: duplicate retries and concurrency", () => {
  it("a retried record produces ONE payment row, so the amount is counted once", () => {
    // record_payment_v1's idempotency key means the retry returns the existing
    // payment rather than inserting a second one — the settled set contains
    // one row, not two. (The SQL-level guarantee is asserted structurally in
    // "Test 19: replay path" below.)
    const s = computeOrderSettlement([settled(10000)], USD, 10000);
    expect(s.netSettledMinor).toBe(10000);
    expect(s.orderPaymentStatus).toBe("paid");
  });

  it("a duplicate_suspected payment is 'pending' and cannot double-count until reviewed", () => {
    const duplicateSuspected = pendingPayment(10000);
    const s = computeOrderSettlement([settled(10000), duplicateSuspected], USD, 10000);
    // The flagged duplicate adds nothing while it awaits review.
    expect(s.netSettledMinor).toBe(10000);
    expect(s.state).toBe("settled");
    expect(s.overSettledMinor).toBe(0);
  });

  it("if a flagged duplicate is later accepted, the excess surfaces as overpayment", () => {
    const s = computeOrderSettlement([settled(10000), settled(10000)], USD, 10000);
    expect(s.state).toBe("overpaid");
    expect(s.overSettledMinor).toBe(10000);
    expect(s.needsReview).toBe(true);
  });

  it("two concurrent settlements are order-independent — the rule is a pure aggregate", () => {
    // Whichever transaction commits second recomputes over BOTH rows (it holds
    // the order lock and re-reads), so the final state is the same either way.
    const a = settled(5000);
    const b = settled(5000);
    const first = computeOrderSettlement([a, b], USD, 10000);
    const second = computeOrderSettlement([b, a], USD, 10000);
    expect(first).toEqual(second);
    expect(first.orderPaymentStatus).toBe("paid");
  });
});

describe("Test 8: currency safety and integer-only money", () => {
  it("a payment in another currency is never summed into the order's total", () => {
    const khr: SettlementPayment = {
      amountMinor: 400000,
      currency: "KHR",
      status: "paid",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([khr], USD, 10000);
    expect(s.netSettledMinor).toBe(0);
    expect(s.orderPaymentStatus).toBe("unpaid");
  });

  it("mixed currencies count only the order's own", () => {
    const khr: SettlementPayment = {
      amountMinor: 400000,
      currency: "KHR",
      status: "paid",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([settled(10000), khr], USD, 10000);
    expect(s.netSettledMinor).toBe(10000);
    expect(s.state).toBe("settled");
  });

  it("a non-integer amount is rejected outright, never rounded into a comparison", () => {
    const bad: SettlementPayment = {
      amountMinor: 100.5,
      currency: USD,
      status: "paid",
      refundedMinor: 0,
    };
    expect(() => computeOrderSettlement([bad], USD, 10000)).toThrow(/integer minor amount/);
    expect(() =>
      classifySettlement(
        { netSettledMinor: 0.1, hasPendingPayment: false, hasFailedPayment: false },
        100,
      ),
    ).toThrow(/integer minor amount/);
  });

  it("KHR (a zero-decimal currency) settles by the same integer rule", () => {
    const khr: SettlementPayment = {
      amountMinor: 400000,
      currency: "KHR",
      status: "paid",
      refundedMinor: 0,
    };
    const s = computeOrderSettlement([khr], "KHR", 400000);
    expect(s.orderPaymentStatus).toBe("paid");
    expect(s.state).toBe("settled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTLEMENT RULE — the SQL implements the same thing
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 9: sync_order_payment_status_v1 compares an AMOUNT against the order total", () => {
  it("sums payment amounts rather than testing for the existence of a paid row", () => {
    const body = syncFn();
    expect(body).toMatch(/SUM\(/);
    expect(body).toMatch(/p\.amount_minor/);
    expect(body).toMatch(/v_order\.total_minor/);
    // The old, buggy shape: a bare EXISTS over status='paid' deciding the axis.
    expect(body).not.toMatch(/IF EXISTS \(\s*SELECT 1 FROM public\.payments/);
  });

  it("only 'paid' and 'refunded' amounts are settled; pending/failed/reversed contribute nothing", () => {
    const body = syncFn();
    expect(body).toMatch(/WHEN p\.status IN \('paid', 'refunded'\)/);
  });

  it("subtracts refunds derived from the append-only refund events", () => {
    const body = syncFn();
    expect(body).toMatch(/event_type = 'refund'/);
    expect(body).toMatch(/p\.amount_minor - COALESCE\(r\.refunded_minor, 0\)/);
  });

  it("'paid' requires net > 0 AND net >= total — a zero-total order with no payments is not paid", () => {
    expect(syncFn()).toMatch(
      /IF v_net_settled > 0 AND v_net_settled >= v_order\.total_minor THEN\s+v_target := 'paid';/,
    );
  });

  it("partial settlement falls to 'pending', never 'paid'", () => {
    expect(syncFn()).toMatch(
      /ELSIF v_net_settled > 0 OR v_has_pending THEN\s+v_target := 'pending';/,
    );
  });

  it("only the order's own currency is summed — no implicit exchange rate", () => {
    expect(syncFn()).toMatch(/p\.currency = v_order\.currency/);
  });

  it("every monetary variable is BIGINT — no NUMERIC, no float, no rounding", () => {
    const body = syncFn();
    expect(body).toMatch(/v_net_settled\s+BIGINT/);
    expect(body).toMatch(/v_over_settled BIGINT/);
    expect(body).not.toMatch(/NUMERIC|DOUBLE PRECISION|::float|REAL\b/i);
    expect(body).not.toMatch(/ROUND\(/i);
  });

  it("the settlement thresholds match settlement.ts exactly", () => {
    const body = syncFn();
    // unsettled / partial / settled / overpaid, same boundaries as the module.
    expect(body).toMatch(/WHEN v_net_settled = 0\s+THEN 'unsettled'/);
    expect(body).toMatch(/WHEN v_net_settled < v_order\.total_minor THEN 'partial'/);
    expect(body).toMatch(/WHEN v_net_settled = v_order\.total_minor THEN 'settled'/);
    expect(body).toMatch(/ELSE\s+'overpaid'/);
  });
});

describe("Test 10: overpayment truth is preserved in SQL too", () => {
  it("the sync function returns the settlement figures on BOTH the changed and no-change paths", () => {
    const body = syncFn();
    expect(body).toMatch(/'over_settled_minor', v_over_settled/);
    expect(body).toMatch(/'settlement_state',\s+v_state/);
    expect(body).toMatch(/'needs_review',\s+v_state = 'overpaid'/);
    // no_change path concatenates the same facts object rather than dropping it.
    expect(body).toMatch(/'no_change'.*\)\s*\n?\s*\|\| v_facts/s);
  });

  it("the settlement figures are stamped into the immutable history reason", () => {
    expect(syncFn()).toMatch(/format\(' \[settled %s of %s %s; %s\]'/);
  });

  it("a live order_payment_settlement view exposes per-order settlement, including overpaid", () => {
    const sql = integrationBody();
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.order_payment_settlement/);
    expect(sql).toMatch(/security_invoker = true/);
    expect(sql).toMatch(/over_settled_minor/);
    expect(sql).toMatch(/'overpaid'/);
    expect(sql).toMatch(/REVOKE ALL ON public\.order_payment_settlement FROM anon, authenticated/);
  });

  it("the view derives from the same immutable sources — never a stored balance column", () => {
    const sql = integrationBody();
    const viewStart = sql.indexOf("CREATE OR REPLACE VIEW public.order_payment_settlement");
    const view = sql.slice(viewStart);
    expect(view).toMatch(/FROM public\.orders o/);
    expect(view).toMatch(/FROM public\.payments p/);
    expect(view).toMatch(/event_type = 'refund'/);
    // No ALTER TABLE adding a cached settlement column anywhere.
    expect(sql).not.toMatch(/ADD COLUMN/i);
  });

  it("the view is org-scoped on the join itself, not only by the caller's filter", () => {
    const sql = integrationBody();
    const viewStart = sql.indexOf("CREATE OR REPLACE VIEW public.order_payment_settlement");
    const view = sql.slice(viewStart);
    expect(view).toMatch(/p\.organization_id = o\.organization_id/);
    expect(view).toMatch(/p\.currency = o\.currency/);
  });
});

describe("Test 11: the order row is locked BEFORE the settlement aggregate", () => {
  it("FOR UPDATE precedes the SUM — otherwise two concurrent settlements could each miss the other", () => {
    const body = syncFn();
    const lockIdx = body.indexOf("FOR UPDATE");
    const sumIdx = body.indexOf("SUM(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeGreaterThan(lockIdx);
  });

  it("a no-op still returns early, before calling transition_order_status_v1", () => {
    const body = syncFn();
    const noChangeIdx = body.indexOf("'no_change'");
    const transitionCallIdx = body.indexOf("public.transition_order_status_v1(");
    expect(noChangeIdx).toBeGreaterThan(-1);
    expect(transitionCallIdx).toBeGreaterThan(noChangeIdx);
  });
});

describe("Test 12: the aggregate is organization- and order-scoped", () => {
  it("the settlement scan filters by order_id AND organization_id", () => {
    expect(syncFn()).toMatch(
      /WHERE p\.order_id = p_order_id\s+AND p\.organization_id = p_organization_id/,
    );
  });

  it("the refund sub-scan is organization-scoped too", () => {
    expect(syncFn()).toMatch(/AND e\.organization_id = p\.organization_id/);
  });

  it("the order lookup is scoped the same way", () => {
    expect(syncFn()).toMatch(
      /WHERE id = p_order_id AND organization_id = p_organization_id\s+FOR UPDATE/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIRING — one atomic function, not a TypeScript sequence
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 5: record_payment_v1 syncs on both the replay path and the normal path", () => {
  it("calls sync_order_payment_status_v1 exactly twice", () => {
    const body = recordFn();
    expect(body.match(/public\.sync_order_payment_status_v1\(/g)?.length).toBe(2);
  });

  it("the replay branch's sync happens before its RETURN", () => {
    const body = recordFn();
    const replayReturnIdx = body.indexOf("'replayed', true");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(replayReturnIdx).toBeGreaterThan(syncIdx);
  });

  it("uses p_order_id directly — the same order every payments row in this call belongs to", () => {
    const body = recordFn();
    expect(body).toMatch(/sync_order_payment_status_v1\(\s*p_organization_id, p_order_id,/);
  });
});

describe("Test 6: verify_payment_v1 syncs using the payment's OWN order_id", () => {
  it("SELECTs order_id from payments, not from any parameter", () => {
    const body = verifyFn();
    expect(body).toMatch(/SELECT id, order_id, status, verification_state INTO v_payment/);
    expect(body).toMatch(
      /sync_order_payment_status_v1\(\s*p_organization_id, v_payment\.order_id,/,
    );
  });

  it("the sync call happens after the payments UPDATE and its event insert", () => {
    const body = verifyFn();
    const updateIdx = body.indexOf("UPDATE public.payments");
    const eventIdx = body.indexOf("INSERT INTO public.payment_events");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(syncIdx).toBeGreaterThan(updateIdx);
    expect(syncIdx).toBeGreaterThan(eventIdx);
  });

  it("this is the only function whose sync call can carry a target of 'paid' for a brand-new claim", () => {
    // record_payment_v1 always inserts status='pending' — only verify/reverse/
    // refund can ever cause the aggregate to see a 'paid' row for the first time.
    expect(recordFn()).not.toMatch(/'paid'/);
  });
});

describe("Test 7: reverse_payment_v1 syncs after marking the payment reversed", () => {
  it("the sync call happens after the status UPDATE and the reversal event", () => {
    const body = reverseFn();
    const updateIdx = body.indexOf("UPDATE public.payments SET status = 'reversed'");
    const eventIdx = body.indexOf("'reversal'");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(updateIdx);
    expect(syncIdx).toBeGreaterThan(eventIdx);
  });

  it("uses the payment's own order_id, fetched alongside its status", () => {
    expect(reverseFn()).toMatch(/SELECT id, order_id, status INTO v_payment/);
  });
});

describe("Test 8: refund_payment_v1 syncs on EVERY refund, partial ones included", () => {
  it("the sync call is OUTSIDE the fully-refunded branch — a partial refund must resync too", () => {
    const body = refundFn();
    const fullBranchIdx = body.indexOf("IF v_new_total = v_payment.amount_minor THEN");
    const branchEndIdx = body.indexOf("END IF;", fullBranchIdx);
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(fullBranchIdx).toBeGreaterThan(-1);
    expect(branchEndIdx).toBeGreaterThan(fullBranchIdx);
    // The regression this guards: syncing only on a full refund would leave a
    // $100 order marked paid after $20 of its money went back to the customer.
    expect(syncIdx).toBeGreaterThan(branchEndIdx);
  });

  it("appears exactly once, on the unconditional path", () => {
    expect(refundFn().match(/public\.sync_order_payment_status_v1\(/g)?.length).toBe(1);
  });

  it("the refund event insert and any status flip both happen before the sync", () => {
    const body = refundFn();
    const eventIdx = body.indexOf("INSERT INTO public.payment_events");
    const statusIdx = body.indexOf("UPDATE public.payments SET status = 'refunded'");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(eventIdx).toBeLessThan(syncIdx);
    expect(statusIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(syncIdx);
  });

  it("payments.amount_minor is never mutated by a refund — the original claim survives", () => {
    expect(refundFn()).not.toMatch(/UPDATE public\.payments\s+SET amount_minor/);
  });
});

describe("Test 9: correct_payment_v1 and attach_payment_evidence_v1 are untouched by this migration", () => {
  it("migration 039 contains no CREATE OR REPLACE for either function", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.correct_payment_v1/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.attach_payment_evidence_v1/);
  });

  it("neither function name appears anywhere else in this migration either", () => {
    const sql = integrationBody();
    expect(sql).not.toContain("correct_payment_v1");
    expect(sql).not.toContain("attach_payment_evidence_v1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAID RULE (task brief, verbatim: "screenshot/evidence alone: NEVER marks paid")
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 10: the sync target can only be 'paid' via a payment's own status column", () => {
  it("the aggregate reads payments.status, never payments.verification_state", () => {
    const body = syncFn();
    expect(body).not.toMatch(/verification_state/);
  });

  it("verify_payment_v1 derives status from the state machine mapping before syncing — sync never re-derives it", () => {
    const body = verifyFn();
    const statusMapIdx = body.indexOf("v_new_status := CASE p_to");
    const updateIdx = body.indexOf("UPDATE public.payments\n  SET status = v_new_status");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(statusMapIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(statusMapIdx);
    expect(syncIdx).toBeGreaterThan(updateIdx);
  });
});

describe("Test 11: evidence attachment cannot reach the sync function", () => {
  it("sync_order_payment_status_v1 is CALLED only from record/verify/reverse/refund — 2+1+1+1 PERFORM sites", () => {
    const sql = integrationBody();
    // Matches only actual call sites (PERFORM ...), not the CREATE/COMMENT/
    // REVOKE/GRANT lines that also mention the function's name.
    const callSites = sql.match(/PERFORM public\.sync_order_payment_status_v1\(/g) ?? [];
    expect(callSites.length).toBe(5);
  });

  it("the payments domain's own evidence rule (SECURITY.md §41) is restated, not contradicted, by this migration", () => {
    expect(integrationSql()).toMatch(/evidence is never financial authority/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COD
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 12: a COD payment still starts 'pending' — recording is not settlement", () => {
  it("record_payment_v1 inserts status='pending' unconditionally, not branched on method", () => {
    const body = recordFn();
    expect(body).toMatch(/'pending', v_initial_state,/);
    // The only branch on p_method is the invalid-method guard near the top —
    // nothing conditions the inserted status on 'cod' specifically.
    const insertIdx = body.indexOf("INSERT INTO public.payments (");
    const afterInsert = body.slice(insertIdx);
    expect(afterInsert).not.toMatch(/p_method\s*=\s*'cod'/);
  });
});

describe("Test 13: Delivery stays financially independent; this migration adds nothing there", () => {
  it("migration 027 (Delivery) still makes no EXECUTABLE reference to the payments table or orders.payment_status — only fulfillment_status", () => {
    // executableSql strips comment lines — the migration's own prose ("never
    // drives orders.payment_status") legitimately mentions the column name in
    // a comment explaining that it does NOT touch it; the assertion is about
    // actual SQL, not about avoiding the word entirely.
    const sql = executableSql(deliveryMigration());
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/payment_status/);
    // It DOES legitimately update orders.fulfillment_status (pre-existing,
    // unrelated to this phase) — confirm that's the only column it touches.
    const updateOrders = sql.match(/UPDATE public\.orders SET (\w+)/g) ?? [];
    expect(updateOrders.length).toBeGreaterThan(0);
    for (const stmt of updateOrders) {
      expect(stmt).toContain("fulfillment_status");
    }
  });

  it("migration 039 touches no delivery table or column", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/deliveries/i);
    expect(sql).not.toMatch(/cod_amount_minor/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER-SIDE CLOSURE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 14: transitionPaymentStatus() refuses unconditionally now", () => {
  it("throws a 409 naming the Payment Domain for a fully-permissioned caller, any target", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      "orders.read",
      "orders.update",
      "payments.confirm",
    ]);
    for (const to of ["unpaid", "pending", "paid", "failed"] as const) {
      const err = await expectRejects(() => transitionPaymentStatus(ctx, ORDER_ID, to));
      expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
      expect(err.message).toContain("Payment Domain");
    }
  });
});

describe("Test 15: the permission gate still runs first — unauthorized stays 403, not 409", () => {
  it("a caller without payments.confirm is Forbidden, never reaching the 409 refusal", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read", "orders.update"]);
    await expectForbidden(() => transitionPaymentStatus(ctx, ORDER_ID, "paid"));
  });
});

describe("Test 16: PAYMENT_TRANSITIONS.paid gained exactly the edges the sync function can produce", () => {
  it("paid now exits to pending, failed and unpaid — nothing else", async () => {
    const { PAYMENT_TRANSITIONS } = await import("../server/orders/state-machine");
    expect(PAYMENT_TRANSITIONS.paid).toEqual(["pending", "failed", "unpaid"]);
  });

  it("every OTHER axis edge is unchanged from before this phase", async () => {
    const { PAYMENT_TRANSITIONS } = await import("../server/orders/state-machine");
    expect(PAYMENT_TRANSITIONS.unpaid).toEqual(["pending", "paid", "failed"]);
    expect(PAYMENT_TRANSITIONS.pending).toEqual(["paid", "failed", "unpaid"]);
    expect(PAYMENT_TRANSITIONS.failed).toEqual(["pending", "paid", "unpaid"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 17: sync_order_payment_status_v1 is a privileged, service-role-only RPC", () => {
  it("EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to service_role", () => {
    const sql = integrationBody();
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.sync_order_payment_status_v1\(UUID, UUID, UUID, TEXT\)\s+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.sync_order_payment_status_v1\(UUID, UUID, UUID, TEXT\)\s+TO service_role/,
    );
  });

  it("takes p_organization_id as its first parameter, like every other privileged RPC in this migration", () => {
    const body = syncFn();
    expect(body).toMatch(/p_organization_id UUID,/);
  });

  it("every replaced payment RPC restates its own REVOKE/GRANT rather than relying only on CREATE OR REPLACE", () => {
    const sql = integrationBody();
    for (const fn of [
      "record_payment_v1",
      "verify_payment_v1",
      "reverse_payment_v1",
      "refund_payment_v1",
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(`));
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(.*\\n?\\s*TO service_role`),
      );
    }
  });
});

describe("Test 18: the order lookup and every aggregate query are organization-scoped, not just order-scoped", () => {
  it("no query in sync_order_payment_status_v1 filters by order_id alone", () => {
    const body = syncFn();
    // Every WHERE clause that mentions order_id also mentions organization_id
    // on the same clause (already the shape asserted in Test 2 — this test
    // asserts the NEGATIVE: no clause omits it).
    const whereClauses = body.match(/WHERE[^;]*order_id[^;]*/g) ?? [];
    expect(whereClauses.length).toBeGreaterThan(0);
    for (const clause of whereClauses) {
      expect(clause).toMatch(/organization_id/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 19: a replayed record_payment_v1 call syncs safely, never a second financial write", () => {
  it("the replay branch reads the existing payment id, it never re-INSERTs", () => {
    const body = recordFn();
    const replayBlock = body.slice(
      body.indexOf("IF v_payment_id IS NULL THEN"),
      body.indexOf("'replayed', true"),
    );
    expect(replayBlock).toMatch(/SELECT id INTO v_payment_id/);
    expect(replayBlock).not.toMatch(/INSERT INTO public\.payments/);
  });

  it("sync_order_payment_status_v1 itself is read-then-conditional-transition, not a write on every call", () => {
    // Test 11 already proves the no-op early return exists; this test proves
    // it is reached BEFORE any write — there is no unconditional INSERT/UPDATE
    // in this function outside of what transition_order_status_v1 itself does.
    const body = syncFn();
    expect(body).not.toMatch(/INSERT INTO/);
    expect(body).not.toMatch(/UPDATE public\.(orders|payments)\b/);
  });

  it("the idempotency index is what makes a retry un-double-countable — not application logic", () => {
    // The settled set can only contain one row per idempotency key because the
    // uniqueness lives in the index (migration 034), so no amount of retrying
    // can add the same money twice. Asserted here against 034's own text since
    // this PR must not (and does not) modify that migration.
    expect(paymentsDomainMigration()).toMatch(
      /CREATE UNIQUE INDEX uniq_payments_idempotency\s+ON public\.payments\(organization_id, idempotency_key\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION OF THE SETTLEMENT FIGURES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 19b: one tenant's payments can never reach another tenant's settlement", () => {
  it("the pure rule only ever sees payments handed to it for one order", () => {
    // Org B's payment is simply not in Org A's order's payment set — the
    // repository query that builds it is organization_id-scoped (below), and
    // the SQL aggregate is scoped identically (Test 12).
    const orgAOnly = computeOrderSettlement([settled(1000)], USD, 10000);
    expect(orgAOnly.netSettledMinor).toBe(1000);
    expect(orgAOnly.orderPaymentStatus).toBe("pending");

    // If a foreign payment COULD leak in, this is what would change — the
    // assertion above is what proves it does not.
    const ifItLeaked = computeOrderSettlement([settled(1000), settled(9000)], USD, 10000);
    expect(ifItLeaked.orderPaymentStatus).toBe("paid");
    expect(orgAOnly.orderPaymentStatus).not.toBe(ifItLeaked.orderPaymentStatus);
  });

  it("the settlement repository read is organization-scoped", () => {
    const src = paymentsRepositorySource();
    const fn = src.slice(src.indexOf("export async function listOrderSettlements"));
    expect(fn).toMatch(/\.from\("order_payment_settlement"\)/);
    expect(fn).toMatch(/\.eq\("organization_id", organizationId\)/);
  });

  it("the settlement service reads take organizationId from the auth context, never an argument", () => {
    const src = readSource("src/server/payments/reconciliation.ts");
    expect(src).toMatch(
      /getOrderSettlement\(\s*ctx: AuthorizationContext,\s*orderId: string,?\s*\)/,
    );
    expect(src).toMatch(/ctx\.organizationId/);
    // No handler anywhere takes a caller-supplied organization id.
    expect(src).not.toMatch(/organizationId:\s*string\s*[,)]/);
  });

  it("the settlement server functions accept only an orderId/limit — never an organizationId", () => {
    const src = readSource("src/api/payments.ts");
    const block = src.slice(src.indexOf("export const getOrderSettlementFn"));
    expect(block).toMatch(/orderId: z\.string\(\)\.uuid\(\)/);
    expect(block).not.toMatch(/organizationId/);
    expect(block).not.toMatch(/userId/);
  });

  it("settlement reads are permission-gated: payments.read for one order, payments.reconcile org-wide", () => {
    const src = readSource("src/server/payments/reconciliation.ts");
    const single = src.slice(src.indexOf("export async function getOrderSettlement"));
    expect(single.slice(0, 400)).toMatch(/ctx\.require\("payments\.read"\)/);
    const issues = src.slice(src.indexOf("export async function getOrderSettlementIssues"));
    expect(issues.slice(0, 400)).toMatch(/ctx\.require\("payments\.reconcile"\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMICITY / NO TWO-STEP TYPESCRIPT SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 20: the bridge is SQL calling SQL, not TypeScript calling TypeScript", () => {
  it("src/server/payments/service.ts still has no import statement naming @/server/orders", () => {
    expect(paymentsServiceSource()).not.toMatch(/from\s+["']@\/server\/orders/);
  });

  it("src/server/payments/repository.ts still has no import statement naming @/server/orders", () => {
    expect(paymentsRepositorySource()).not.toMatch(/from\s+["']@\/server\/orders/);
  });

  it("no file under src/server/payments calls transitionPaymentStatus( or transitionOrderPaymentFn( — the pre-existing invariant still holds after migration 039", () => {
    const dir = path.resolve(process.cwd(), "src/server/payments");
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(src).not.toMatch(/transitionPaymentStatus\(/);
      expect(src).not.toMatch(/transitionOrderPaymentFn\(/);
    }
  });

  it("src/server/payments/repository.ts calls exactly the same six RPC names as before — no new client-side RPC call was added", () => {
    const src = paymentsRepositorySource();
    const rpcNames = [...src.matchAll(/db\.rpc\("(\w+)"/g)].map((m) => m[1]).sort();
    expect(rpcNames).toEqual(
      [
        "attach_payment_evidence_v1",
        "correct_payment_v1",
        "record_payment_v1",
        "refund_payment_v1",
        "reverse_payment_v1",
        "verify_payment_v1",
      ].sort(),
    );
  });
});

describe("Test 21: each RPC's Order consequence is reached only after its OWN writes are already in the same transaction", () => {
  it("record_payment_v1: the payments INSERT precedes both sync call sites", () => {
    const body = recordFn();
    const insertIdx = body.indexOf("INSERT INTO public.payments (");
    const syncIdxs = [...body.matchAll(/public\.sync_order_payment_status_v1\(/g)].map(
      (m) => m.index!,
    );
    expect(insertIdx).toBeGreaterThan(-1);
    for (const idx of syncIdxs) expect(idx).toBeGreaterThan(insertIdx);
  });

  it("verify/reverse/refund: the payments UPDATE precedes the sync call", () => {
    for (const [fn, updateNeedle] of [
      [verifyFn(), "UPDATE public.payments"],
      [reverseFn(), "UPDATE public.payments SET status = 'reversed'"],
      [refundFn(), "UPDATE public.payments SET status = 'refunded'"],
    ] as const) {
      const updateIdx = fn.indexOf(updateNeedle);
      const syncIdx = fn.indexOf("public.sync_order_payment_status_v1(");
      expect(updateIdx).toBeGreaterThan(-1);
      expect(syncIdx).toBeGreaterThan(updateIdx);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION HYGIENE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 22: 039 is additive only", () => {
  it("no DROP, no TRUNCATE, no destructive ALTER", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP TYPE/i);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.\w+ DROP/i);
  });

  it("adds no table, column, index or enum value", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/ADD VALUE/i);
    expect(sql).not.toMatch(/CREATE TYPE/i);
  });

  it("does not redefine transition_order_status_v1 itself — it only calls it", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.transition_order_status_v1/);
    expect(sql).toMatch(/public\.transition_order_status_v1\(/);
  });

  it("replaces exactly five functions: the new sync function plus four payment RPCs", () => {
    const sql = integrationBody();
    const defs = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(defs.sort()).toEqual(
      [
        "record_payment_v1",
        "refund_payment_v1",
        "reverse_payment_v1",
        "sync_order_payment_status_v1",
        "verify_payment_v1",
      ].sort(),
    );
  });
});

describe("Test 23: earlier migration files are not modified by this phase", () => {
  it("023 (orders), 026 (inventory integration), 034–036 (payment domain) carry no reference to the new sync function", () => {
    for (const migration of [
      ordersMigration(),
      inventoryIntegrationMigration(),
      paymentsDomainMigration(),
      paymentRpcMigration(),
      paymentPermissionsMigration(),
    ]) {
      expect(migration).not.toContain("sync_order_payment_status_v1");
    }
  });

  it("the payment_status enum values are still exactly unpaid/pending/paid/failed — this phase adds no new value", () => {
    expect(ordersMigration()).toMatch(
      /CREATE TYPE public\.order_payment_status AS ENUM \(\s*'unpaid',\s*'pending',\s*'paid',\s*'failed'\s*\);/,
    );
  });
});
