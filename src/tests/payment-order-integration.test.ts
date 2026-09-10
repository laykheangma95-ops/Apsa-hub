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
 *   AGGREGATE RULE
 *     1.  paid > pending > failed > unpaid precedence, in that order
 *     2.  every EXISTS check is organization_id- AND order_id-scoped
 *     3.  the order row is locked (FOR UPDATE) before the aggregate decision
 *     4.  a no-op is a real early return, not a wasted transition call
 *   WIRING — one atomic function, not a TypeScript sequence
 *     5.  record_payment_v1 syncs on both the replay path and the normal path
 *     6.  verify_payment_v1 syncs after the payments UPDATE, using the
 *         payment's own order_id (never a parameter the caller could vary)
 *     7.  reverse_payment_v1 syncs after marking the payment reversed
 *     8.  refund_payment_v1 syncs ONLY inside the fully-refunded branch —
 *         a partial refund never touches the order
 *     9.  correct_payment_v1 and attach_payment_evidence_v1 are untouched by
 *         this migration — neither ever moves `status`, so neither has an
 *         Order consequence (SECURITY.md §41)
 *   PAID RULE (task brief, verbatim)
 *    10.  the sync target can only be 'paid' when a payment's own status is
 *         'paid' — never derived from verification_state directly
 *    11.  evidence attachment cannot reach the sync function at all
 *   COD
 *    12.  a COD payment still starts 'pending' — recording COD is not itself
 *         settlement; only a later verifyPayment can move the order to paid
 *    13.  the Delivery migration still makes no reference to `payments` or
 *         `orders.payment_status`, and this migration adds nothing there
 *   ORDER-SIDE CLOSURE
 *    14.  transitionPaymentStatus() refuses unconditionally now (TypeScript)
 *    15.  the permission gate still runs first — unauthorized stays 403
 *    16.  PAYMENT_TRANSITIONS.paid gained exits; the edges match what
 *         sync_order_payment_status_v1 can legitimately produce
 *   TENANT ISOLATION
 *    17.  sync_order_payment_status_v1 takes p_organization_id and is
 *         revoked from anon/authenticated, granted only to service_role
 *    18.  the order lookup and every payments aggregate query are scoped by
 *         organization_id, not just order_id
 *   IDEMPOTENCY
 *    19.  a replayed record_payment_v1 call still syncs safely (no double
 *         financial write — this is a read-then-conditional-transition, not
 *         a second INSERT)
 *   ATOMICITY / NO TWO-STEP SEQUENCE
 *    20.  src/server/payments/service.ts and repository.ts are still
 *         untouched — the bridge is SQL calling SQL, not TypeScript calling
 *         TypeScript (re-asserts payment-domain.test.ts's "Test 25" boundary
 *         still holds after this migration)
 *    21.  each payment RPC's Order consequence is reached only AFTER its own
 *         payments/payment_events writes are already in the same function
 *         body (ordering, not just presence)
 *   MIGRATION HYGIENE
 *    22.  039 is additive only — no DROP/TRUNCATE, no new table/column/index/
 *         enum value, and it does not redefine transition_order_status_v1
 *         itself (026 still owns that function)
 *    23.  039 does not modify 023/026/034/035/036 — those files carry no
 *         reference to sync_order_payment_status_v1
 *
 * Run: bun test src/tests/payment-order-integration.test.ts
 */

import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

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
// AGGREGATE RULE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 1: paid > pending > failed > unpaid precedence", () => {
  it("the aggregate is an IF/ELSIF chain checking 'paid' first", () => {
    const body = syncFn();
    const paidIdx = body.indexOf("status = 'paid'");
    const pendingIdx = body.indexOf("status = 'pending'");
    const failedIdx = body.indexOf("status = 'failed'");
    expect(paidIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeGreaterThan(paidIdx);
    expect(failedIdx).toBeGreaterThan(pendingIdx);
  });

  it("falls through to 'unpaid' when no payment is paid/pending/failed", () => {
    const body = syncFn();
    expect(body).toMatch(/ELSE\s+v_target := 'unpaid';/);
  });

  it("every branch assigns v_target from the order_payment_status enum, nothing client-shaped", () => {
    const body = syncFn();
    expect(body).toMatch(/v_target public\.order_payment_status;/);
    for (const value of ["'paid'", "'pending'", "'failed'", "'unpaid'"]) {
      expect(body).toContain(`v_target := ${value}`);
    }
  });
});

describe("Test 2: every aggregate check is organization- and order-scoped", () => {
  it("each EXISTS clause filters by both order_id and organization_id", () => {
    const body = syncFn();
    const clauses = body.match(
      /WHERE order_id = p_order_id AND organization_id = p_organization_id/g,
    );
    // paid, pending, failed — three EXISTS checks, all identically scoped.
    expect(clauses?.length).toBe(3);
  });

  it("the order lookup itself is scoped the same way", () => {
    expect(syncFn()).toMatch(
      /WHERE id = p_order_id AND organization_id = p_organization_id\s+FOR UPDATE/,
    );
  });
});

describe("Test 3: the order row is locked before any decision is made", () => {
  it("FOR UPDATE appears before the first EXISTS check", () => {
    const body = syncFn();
    const lockIdx = body.indexOf("FOR UPDATE");
    const firstExists = body.indexOf("EXISTS (");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(firstExists).toBeGreaterThan(lockIdx);
  });
});

describe("Test 4: a no-op is a real early return", () => {
  it("the function returns before calling transition_order_status_v1 when nothing changed", () => {
    const body = syncFn();
    const noChangeIdx = body.indexOf("'no_change'");
    const transitionCallIdx = body.indexOf("public.transition_order_status_v1(");
    expect(noChangeIdx).toBeGreaterThan(-1);
    expect(transitionCallIdx).toBeGreaterThan(noChangeIdx);
    expect(body).toMatch(
      /IF v_order\.payment_status = v_target THEN\s+RETURN jsonb_build_object\('status', 'no_change'/,
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

describe("Test 8: refund_payment_v1 syncs ONLY on a full refund", () => {
  it("the sync call is nested inside the 'fully refunded' branch, not unconditional", () => {
    const body = refundFn();
    const fullBranchIdx = body.indexOf("IF v_new_total = v_payment.amount_minor THEN");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    const branchEndIdx = body.indexOf("END IF;", fullBranchIdx);
    expect(fullBranchIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(fullBranchIdx);
    expect(syncIdx).toBeLessThan(branchEndIdx);
  });

  it("appears exactly once — a partial refund path has no second, unconditional call", () => {
    expect(refundFn().match(/public\.sync_order_payment_status_v1\(/g)?.length).toBe(1);
  });

  it("the refund event insert happens before the conditional sync, not after", () => {
    const body = refundFn();
    const eventIdx = body.indexOf("INSERT INTO public.payment_events");
    const syncIdx = body.indexOf("public.sync_order_payment_status_v1(");
    expect(eventIdx).toBeLessThan(syncIdx);
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
    // Test 4 already proves the no-op early return exists; this test proves
    // it is reached BEFORE any write — there is no unconditional INSERT/UPDATE
    // in this function outside of what transition_order_status_v1 itself does.
    const body = syncFn();
    expect(body).not.toMatch(/INSERT INTO/);
    expect(body).not.toMatch(/UPDATE public\.(orders|payments)\b/);
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
