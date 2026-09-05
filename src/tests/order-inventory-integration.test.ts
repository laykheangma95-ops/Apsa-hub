/**
 * Order ↔ Inventory Integration tests.
 *
 * Structure mirrors src/tests/order-domain.test.ts: pure unit tests against a
 * mocked repository DB, plus structural assertions over the migrations that
 * need no live database.
 *
 * WHY SO MUCH OF THIS IS STRUCTURAL
 *   The integration deliberately lives inside one plpgsql function (migration
 *   026) rather than in TypeScript, precisely so that no application-level
 *   sequence can be interrupted between the status change and the ledger write.
 *   That means the behaviour under test is SQL, and the assertions that can run
 *   without a live Postgres are assertions about that SQL. They are written
 *   against the executable statements only (comments stripped), because the
 *   migration explains at length the very patterns it rules out.
 *
 * Coverage:
 *   SALE
 *     1.  draft -> confirmed writes one negative movement per line
 *     2.  quantity comes from the persisted line, never from a caller
 *     3.  multi-item and same-variant-twice orders do not collide
 *     4.  duplicate confirmation cannot double-decrement
 *     5.  location is copied from the order
 *   CANCELLATION
 *     6.  draft -> cancelled writes nothing
 *     7.  confirmed -> cancelled writes one positive 'return' per consumed line
 *     8.  duplicate cancellation cannot double-restock
 *     9.  sale and return coexist for one line
 *   ATOMICITY
 *    10.  one RPC, one transaction — no transition-then-adjust sequence
 *   TENANT ISOLATION
 *    11.  every id is org-scoped or copied from an already-verified row
 *   AUTHORIZATION
 *    12.  orders.confirm / orders.cancel suffice; inventory.adjust is not required
 *    13.  manual inventory adjustment still requires inventory.adjust
 *   LEDGER
 *    14.  append-only; inventory_stock stays derived
 *   SECURITY / BOUNDARY
 *    15.  privileged RPC unreachable by anon/authenticated; service_role can execute
 *    16.  migration hygiene — forward-only, merged migrations untouched
 *
 * Run: bun test src/tests/order-inventory-integration.test.ts
 */

import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

// ── Context factory ───────────────────────────────────────────────────────────

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
const ORG_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ORG_A = "user-aaaa-0000-0000-0000-000000000001";
const PRODUCT_ID = "cccccccc-0000-0000-0000-000000000001";
const VARIANT_ID = "dddddddd-0000-0000-0000-000000000001";
const VARIANT_2_ID = "dddddddd-0000-0000-0000-000000000002";
const LOCATION_ID = "ffffffff-0000-0000-0000-000000000001";
const ORDER_ID = "11111111-0000-0000-0000-000000000001";
const ORG_B_ORDER_ID = "22222222-0000-0000-0000-000000000002";

// ── Source / migration readers ────────────────────────────────────────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

/**
 * SQL with `--` comment lines removed.
 *
 * Migration 026 spends most of its length explaining what it must NOT do
 * ("keying on ('order', order_id) would collide", "no UPDATE of
 * inventory_movements"). A structural test that scanned the raw text would read
 * those warnings as the thing they warn against.
 */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const INTEGRATION_MIGRATION = "supabase/migrations/026_order_inventory_integration.sql";

const integrationSql = () => readSource(INTEGRATION_MIGRATION);
const integrationBody = () => executableSql(integrationSql());
const ledgerMigration = () => readSource("supabase/migrations/021_inventory_movements.sql");
const ordersMigration = () => readSource("supabase/migrations/023_orders.sql");
const rpcMigration = () => readSource("supabase/migrations/024_order_rpc.sql");

/**
 * The executable text of one branch of the transition function: everything from
 * the branch's guard up to the `ON CONFLICT` that terminates its INSERT.
 *
 * Slicing per-branch matters. Asserting "the migration contains -oi.quantity"
 * would pass even if the negative delta had been written into the CANCELLATION
 * branch, which is the single most damaging way to get this wrong.
 */
function branchSql(guard: RegExp): string {
  const body = integrationBody();
  const start = body.search(guard);
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf("GET DIAGNOSTICS", start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

const saleBranch = () => branchSql(/v_current = 'draft' AND p_to = 'confirmed'/);
const returnBranch = () => branchSql(/v_current = 'confirmed' AND p_to = 'cancelled'/);

// ── Mock repository DB (same fake as order-domain.test.ts) ────────────────────

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

function fakeQuery(result: QueryResult) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    insert: () => q,
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

interface OrderDbOptions {
  tables?: Record<string, QueryResult>;
  rpc?: Record<string, QueryResult>;
}

async function withOrderDb<T>(
  opts: OrderDbOptions,
  fn: (calls: RpcCall[]) => Promise<T>,
): Promise<T> {
  const { setOrderRepositoryDbForTests } = await import("../server/orders/repository");
  const calls: RpcCall[] = [];
  const testDb = {
    from: (table: string) => fakeQuery(opts.tables?.[table] ?? { data: null, error: null }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ fn: name, args });
      return opts.rpc?.[name] ?? { data: { status: "success" }, error: null };
    },
  };
  const restore = setOrderRepositoryDbForTests(testDb);
  try {
    return await fn(calls);
  } finally {
    restore();
  }
}

const noRow: QueryResult = { data: null, error: { code: "PGRST116", message: "no rows" } };

function orderRow(overrides: Record<string, unknown> = {}): QueryResult {
  return {
    data: {
      id: ORDER_ID,
      organization_id: ORG_A_ID,
      order_number: "APSA-2026-000001",
      customer_id: null,
      location_id: LOCATION_ID,
      source: "POS",
      currency: "USD",
      subtotal_minor: 1800,
      discount_minor: 0,
      delivery_minor: 0,
      total_minor: 1800,
      lifecycle_status: "draft",
      payment_status: "unpaid",
      fulfillment_status: "unfulfilled",
      created_by: USER_ORG_A,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
      ...overrides,
    },
    error: null,
  };
}

function itemRows(rows: Array<Record<string, unknown>>): QueryResult {
  return { data: rows, error: null };
}

function line(id: string, variantId: string, quantity: number): Record<string, unknown> {
  return {
    id,
    organization_id: ORG_A_ID,
    order_id: ORDER_ID,
    product_id: PRODUCT_ID,
    variant_id: variantId,
    product_name_snapshot: "សេរ៉ូមវីតាមីន C",
    variant_name_snapshot: null,
    sku_snapshot: "SKU-1",
    unit_price_minor: 900,
    quantity,
    line_total_minor: 900 * quantity,
    created_at: "2026-09-05T00:00:00.000Z",
  };
}

/** Two lines of the SAME variant — the case an order-level reference would eat. */
const twoLinesSameVariant = itemRows([
  line("line-1", VARIANT_ID, 2),
  line("line-2", VARIANT_ID, 3),
]);

const twoLinesTwoVariants = itemRows([
  line("line-1", VARIANT_ID, 2),
  line("line-2", VARIANT_2_ID, 5),
]);

const ORDER_PERMS_CONFIRM = ["orders.read", "orders.confirm"];
const ORDER_PERMS_CANCEL = ["orders.read", "orders.cancel"];

// ═══════════════════════════════════════════════════════════════════════════════
// SALE MOVEMENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 1: draft -> confirmed writes one negative 'sale' movement per line", () => {
  it("the sale branch inserts into inventory_movements, one row per order line", () => {
    const branch = saleBranch();
    expect(branch).toMatch(/INSERT INTO public\.inventory_movements/);
    expect(branch).toMatch(/FROM public\.order_items oi/);
    // A set-returning INSERT ... SELECT over the lines is what makes "one per
    // line" structural rather than a loop that could miss one.
    expect(branch).toMatch(/SELECT[\s\S]*FROM public\.order_items oi/);
  });

  it("the delta is negative and the movement_type is 'sale'", () => {
    const branch = saleBranch();
    expect(branch).toMatch(/-oi\.quantity/);
    expect(branch).toMatch(/'sale'::public\.inventory_movement_type/);
    expect(branch).not.toMatch(/'return'/);
  });

  it("the cancellation branch is the mirror image, not a copy", () => {
    const branch = returnBranch();
    expect(branch).toMatch(/'return'::public\.inventory_movement_type/);
    // Positive delta: `oi.quantity`, never `-oi.quantity`.
    expect(branch).not.toMatch(/-oi\.quantity/);
  });

  it("no other axis or transition touches the ledger", () => {
    const body = integrationBody();
    // Exactly two ledger INSERTs exist in the whole function.
    expect(body.match(/INSERT INTO public\.inventory_movements/g)?.length).toBe(2);
    // Both are guarded by a lifecycle branch.
    expect(body.match(/p_axis = 'lifecycle' AND v_current =/g)?.length).toBe(2);
  });
});

describe("Test 2: quantity is the persisted line's, never a caller's", () => {
  it("the RPC has no quantity parameter at all", () => {
    const signature = integrationBody().slice(
      integrationBody().indexOf("CREATE OR REPLACE FUNCTION public.transition_order_status_v1"),
      integrationBody().indexOf("RETURNS JSONB"),
    );
    expect(signature).not.toMatch(/quantity/i);
    expect(signature).toMatch(/p_organization_id UUID/);
    expect(signature).toMatch(/p_order_id\s+UUID/);
  });

  it("both branches read quantity from order_items and nowhere else", () => {
    for (const branch of [saleBranch(), returnBranch()]) {
      expect(branch).toMatch(/oi\.quantity/);
      // No literal or parameterised quantity could substitute for the line's.
      expect(branch).not.toMatch(/p_quantity/);
    }
  });

  it("the service sends no quantity, organization_id or user_id of the client's choosing", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "success", stock_movements: 2 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "confirmed");
        const call = calls.find((c) => c.fn === "transition_order_status_v1");
        expect(call).toBeDefined();
        // organization_id and changed_by come from the server-verified context.
        expect(call!.args["p_organization_id"]).toBe(ORG_A_ID);
        expect(call!.args["p_changed_by"]).toBe(USER_ORG_A);
        // Nothing resembling a quantity, a variant or a product is sent.
        const keys = Object.keys(call!.args);
        expect(keys.some((k) => /quantity|variant|product|delta|movement/i.test(k))).toBe(false);
      },
    );
  });
});

describe("Test 3: multiple lines, including the same variant twice", () => {
  it("the reference is the LINE id, so two lines of one variant get two movements", () => {
    for (const branch of [saleBranch(), returnBranch()]) {
      expect(branch).toMatch(/'order_item'/);
      expect(branch).toMatch(/oi\.id/);
      // An order-level reference would be the collision bug this design avoids.
      expect(branch).not.toMatch(/'order'\s*,/);
      expect(branch).not.toMatch(/reference_id[\s\S]{0,40}p_order_id/);
    }
  });

  it("migration 021's unique key includes movement_type, so sale and return coexist", () => {
    const ledger = executableSql(ledgerMigration());
    expect(ledger).toMatch(
      /CREATE UNIQUE INDEX uniq_inventory_movements_reference\s+ON public\.inventory_movements\(organization_id, variant_id, movement_type, reference_type, reference_id\)\s+WHERE reference_id IS NOT NULL/,
    );
  });

  it("the ON CONFLICT target matches that index exactly, predicate included", () => {
    const body = integrationBody();
    const conflicts = body.match(
      /ON CONFLICT \(organization_id, variant_id, movement_type, reference_type, reference_id\)\s*\n?\s*WHERE reference_id IS NOT NULL\s*\n?\s*DO NOTHING/g,
    );
    // One per ledger INSERT. A partial unique index is only inferred when the
    // predicate is restated, so omitting it would raise at runtime instead of
    // deduplicating.
    expect(conflicts?.length).toBe(2);
  });

  it("migration 021 is untouched — the item-level design needs no schema change", () => {
    // The ledger migration is merged. If this integration had required widening
    // the idempotency key, that would have been a forward-only 026 change too;
    // it did not, and 021 must not have been edited.
    const ledger = ledgerMigration();
    expect(ledger).not.toContain("order_item");
    expect(ledger).toContain("uniq_inventory_movements_reference");
  });
});

describe("Test 4: duplicate confirmation cannot double-decrement", () => {
  it("a replayed confirmation is refused by the status gate before the ledger", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb(
      {
        tables: {
          // The order is ALREADY confirmed — this is the retry.
          orders: orderRow({ lifecycle_status: "confirmed" }),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
      },
      async (calls) => {
        const err = await expectRejects(() =>
          transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"),
        );
        expect((err as { statusCode?: number }).statusCode).toBe(409);
        // The state machine rejected it in the service; the DB was never asked.
        expect(calls.filter((c) => c.fn === "transition_order_status_v1")).toHaveLength(0);
      },
    );
  });

  it("a concurrent confirmation that reaches the DB is refused as stale", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "stale", current: "confirmed" },
            error: null,
          },
        },
      },
      async () => {
        const err = await expectRejects(() =>
          transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"),
        );
        expect((err as { statusCode?: number }).statusCode).toBe(409);
      },
    );
  });

  it("the SQL returns 'stale' before reaching either ledger branch", () => {
    const body = integrationBody();
    const staleAt = body.indexOf("'stale'");
    const firstLedgerAt = body.indexOf("INSERT INTO public.inventory_movements");
    expect(staleAt).toBeGreaterThan(-1);
    expect(staleAt).toBeLessThan(firstLedgerAt);
    // The optimistic-concurrency comparison is what makes it stale.
    expect(body).toMatch(/IF v_current <> p_expected_from THEN[\s\S]{0,200}'stale'/);
  });

  it("even if the insert were reached twice, ON CONFLICT DO NOTHING absorbs it", () => {
    expect(saleBranch()).toMatch(/ON CONFLICT/);
    expect(integrationBody()).toMatch(/DO NOTHING/);
    // DO UPDATE would mutate an existing ledger row — the one thing an
    // append-only ledger must never do.
    expect(integrationBody()).not.toMatch(/DO UPDATE/);
  });

  it("the row lock serialises two concurrent confirmations", () => {
    expect(integrationBody()).toMatch(/FROM public\.orders[\s\S]{0,200}FOR UPDATE/);
  });
});

describe("Test 5: location is copied from the Order", () => {
  it("both branches use the order's location_id, not the line's or a parameter's", () => {
    expect(integrationBody()).toMatch(
      /SELECT id, lifecycle_status, payment_status, fulfillment_status, location_id/,
    );
    for (const branch of [saleBranch(), returnBranch()]) {
      expect(branch).toMatch(/v_order\.location_id/);
      expect(branch).not.toMatch(/p_location_id/);
    }
  });

  it("a NULL order location is allowed — the ledger column is nullable", () => {
    expect(executableSql(ledgerMigration())).toMatch(
      /location_id\s+UUID REFERENCES public\.locations\(id\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CANCELLATION / STOCK RELEASE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 6: draft -> cancelled moves no stock", () => {
  it("neither ledger branch matches a draft cancellation", () => {
    const body = integrationBody();
    // The two guards are exhaustive and neither is (draft -> cancelled).
    expect(body).toMatch(/v_current = 'draft' AND p_to = 'confirmed'/);
    expect(body).toMatch(/v_current = 'confirmed' AND p_to = 'cancelled'/);
    expect(body).not.toMatch(/v_current = 'draft' AND p_to = 'cancelled'/);
  });

  it("the service still performs the cancellation itself", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CANCEL);

    await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "draft" }),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            // The DB reports zero movements for a draft cancellation.
            data: { status: "success", stock_movements: 0 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "cancelled");
        const call = calls.find((c) => c.fn === "transition_order_status_v1");
        expect(call!.args["p_expected_from"]).toBe("draft");
        expect(call!.args["p_to"]).toBe("cancelled");
      },
    );
  });
});

describe("Test 7: confirmed -> cancelled releases exactly what was consumed", () => {
  it("the return branch only compensates lines that have a matching 'sale'", () => {
    const branch = returnBranch();
    expect(branch).toMatch(/AND EXISTS \(/);
    expect(branch).toMatch(/FROM public\.inventory_movements m/);
    expect(branch).toMatch(/m\.movement_type\s*=\s*'sale'/);
    expect(branch).toMatch(/m\.reference_type\s*=\s*'order_item'/);
    expect(branch).toMatch(/m\.reference_id\s*=\s*oi\.id/);
    // The EXISTS lookup is itself org-scoped.
    expect(branch).toMatch(/m\.organization_id\s*=\s*oi\.organization_id/);
  });

  it("the compensating movement mirrors product, variant and location", () => {
    const branch = returnBranch();
    expect(branch).toMatch(/oi\.product_id/);
    expect(branch).toMatch(/oi\.variant_id/);
    expect(branch).toMatch(/v_order\.location_id/);
  });

  it("the service requires orders.cancel and reports the movement count", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CANCEL);

    await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "confirmed" }),
          order_items: twoLinesTwoVariants,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "success", stock_movements: 2 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "cancelled");
        const call = calls.find((c) => c.fn === "transition_order_status_v1");
        expect(call!.args["p_expected_from"]).toBe("confirmed");
        expect(call!.args["p_to"]).toBe("cancelled");
      },
    );
  });
});

describe("Test 8: duplicate cancellation cannot double-restock", () => {
  it("an already-cancelled order is refused by the service before any RPC", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CANCEL);

    await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "cancelled" }),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
      },
      async (calls) => {
        const err = await expectRejects(() =>
          transitionLifecycleStatus(ctx, ORDER_ID, "cancelled"),
        );
        expect((err as { statusCode?: number }).statusCode).toBe(409);
        expect(calls.filter((c) => c.fn === "transition_order_status_v1")).toHaveLength(0);
      },
    );
  });

  it("the SQL's terminal check fires before either ledger branch", () => {
    const body = integrationBody();
    const terminalAt = body.indexOf("'terminal'");
    const firstLedgerAt = body.indexOf("INSERT INTO public.inventory_movements");
    expect(terminalAt).toBeGreaterThan(-1);
    expect(terminalAt).toBeLessThan(firstLedgerAt);
    expect(body).toMatch(
      /IF v_order\.lifecycle_status IN \('cancelled', 'completed'\) THEN[\s\S]{0,200}'terminal'/,
    );
  });

  it("the return insert is also ON CONFLICT DO NOTHING", () => {
    expect(returnBranch()).toMatch(/ON CONFLICT/);
  });
});

describe("Test 9: sale and return coexist for the same order item", () => {
  it("they differ only by movement_type, which is part of the unique key", () => {
    // Same (org, variant, reference_type, reference_id); different
    // movement_type. Migration 021's index therefore permits both rows.
    expect(saleBranch()).toMatch(/'order_item'::TEXT,\s*\n?\s*oi\.id/);
    expect(returnBranch()).toMatch(/'order_item'::TEXT,\s*\n?\s*oi\.id/);
    expect(executableSql(ledgerMigration())).toMatch(
      /\(organization_id, variant_id, movement_type, reference_type, reference_id\)/,
    );
  });

  it("the cancellation never deletes or updates the original sale", () => {
    const body = integrationBody();
    expect(body).not.toMatch(/DELETE FROM public\.inventory_movements/);
    expect(body).not.toMatch(/UPDATE public\.inventory_movements/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMICITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 10: the transition and its movements are one transaction", () => {
  it("the whole consequence lives inside one plpgsql function", () => {
    const body = integrationBody();
    // Status change, history, fulfillment cascade and ledger, all between one
    // BEGIN and its matching END.
    expect(body).toMatch(/UPDATE public\.orders SET lifecycle_status/);
    expect(body).toMatch(/INSERT INTO public\.order_status_history/);
    expect(body).toMatch(/INSERT INTO public\.inventory_movements/);
    expect(body.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1);
  });

  it("the ledger write happens after the status write, inside the same call", () => {
    const body = integrationBody();
    expect(body.indexOf("UPDATE public.orders SET lifecycle_status")).toBeLessThan(
      body.indexOf("INSERT INTO public.inventory_movements"),
    );
    expect(body.indexOf("INSERT INTO public.order_status_history")).toBeLessThan(
      body.indexOf("INSERT INTO public.inventory_movements"),
    );
  });

  it("a lifecycle transition issues exactly ONE RPC — never transition-then-adjust", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: twoLinesTwoVariants,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "success", stock_movements: 2 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "confirmed");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.fn).toBe("transition_order_status_v1");
      },
    );
  });

  it("a failure inside the transaction surfaces as a failure of the whole transition", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    // Simulates 021's cross-tenant integrity trigger raising on the movement
    // insert. Because the status UPDATE happened in the same statement, Postgres
    // rolls it back too — the caller sees an error, not a half-applied order.
    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: twoLinesTwoVariants,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: null,
            error: {
              message: "inventory_movement variant_id must belong to (cross_tenant_variant)",
            },
          },
        },
      },
      async (calls) => {
        const err = await expectRejects(() =>
          transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"),
        );
        expect(err.message).toContain("cross_tenant_variant");
        // No compensating second call: there is nothing to compensate, because
        // nothing committed.
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("no application code writes the ledger around the transition", () => {
    for (const file of [
      "src/server/orders/service.ts",
      "src/server/orders/repository.ts",
      "src/api/orders.ts",
    ]) {
      const src = readSource(file);
      expect(src).not.toMatch(/^\s*import[\s\S]{0,120}?from ["']@\/server\/inventory/m);
      expect(src).not.toMatch(/await import\(["']@\/server\/inventory/);
      expect(src).not.toMatch(/recordMovement\(/);
      // Prose about the integration is expected (and required); a query
      // against the ledger table is not.
      expect(src).not.toMatch(/from\(\s*["']inventory_movements["']/);
      expect(src).not.toMatch(/rpc\(\s*["'][^"']*inventory/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 11: cross-org orders, lines, products and locations", () => {
  it("a cross-org order id never reaches the transition RPC", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb({ tables: { orders: noRow } }, async (calls) => {
      const err = await expectRejects(() =>
        transitionLifecycleStatus(ctx, ORG_B_ORDER_ID, "confirmed"),
      );
      expect((err as { statusCode?: number }).statusCode).toBe(404);
      expect(err.message).toBe("Order not found");
      expect(calls).toHaveLength(0);
    });
  });

  it("the SQL loads the order org-scoped and returns an indistinguishable 'not_found'", () => {
    const body = integrationBody();
    expect(body).toMatch(
      /FROM public\.orders\s+WHERE id = p_order_id\s+AND organization_id = p_organization_id/,
    );
    expect(body).toMatch(/IF NOT FOUND THEN[\s\S]{0,120}'not_found'/);
  });

  it("order lines are read org-scoped in both branches", () => {
    for (const branch of [saleBranch(), returnBranch()]) {
      expect(branch).toMatch(/WHERE oi\.order_id = p_order_id/);
      expect(branch).toMatch(/AND oi\.organization_id = p_organization_id/);
    }
  });

  it("product and variant are copied from the line's own FK columns, never supplied", () => {
    for (const branch of [saleBranch(), returnBranch()]) {
      expect(branch).toMatch(/oi\.organization_id,\s*\n?\s*oi\.product_id,\s*\n?\s*oi\.variant_id/);
    }
    // Migration 023's own trigger already proved the line's product and variant
    // belong to this organization when the line was written.
    const orders = executableSql(ordersMigration());
    expect(orders).toMatch(/CREATE OR REPLACE FUNCTION public\.check_order_item_cross_tenant_refs/);
    expect(orders).toMatch(/CREATE TRIGGER order_item_cross_tenant_refs_check/);
    expect(orders).toMatch(/CREATE TRIGGER order_cross_tenant_refs_check/);
  });

  it("migration 021's integrity trigger re-proves org ownership on every insert", () => {
    const ledger = executableSql(ledgerMigration());
    expect(ledger).toMatch(/CREATE TRIGGER inventory_movement_integrity_check\s+BEFORE INSERT/);
    expect(ledger).toMatch(/cross_tenant_variant/);
    expect(ledger).toMatch(/cross_tenant_product/);
    expect(ledger).toMatch(/cross_tenant_location/);
  });

  it("the API surface has no organizationId or userId parameter to abuse", () => {
    const api = readSource("src/api/orders.ts");
    expect(api).not.toMatch(/organizationId:\s*z\./);
    expect(api).not.toMatch(/userId:\s*z\./);
    expect(api).not.toMatch(/organization_id:\s*z\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHORIZATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 12: order permissions alone authorize the stock consequence", () => {
  it("orders.confirm alone is enough to consume stock", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    // Deliberately WITHOUT inventory.adjust, inventory.receive_stock or any
    // other inventory permission.
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CONFIRM);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "success", stock_movements: 2 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "confirmed");
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("orders.cancel alone is enough to release stock", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ORDER_PERMS_CANCEL);

    await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "confirmed" }),
          order_items: twoLinesSameVariant,
          order_status_history: itemRows([]),
        },
        rpc: {
          transition_order_status_v1: {
            data: { status: "success", stock_movements: 2 },
            error: null,
          },
        },
      },
      async (calls) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "cancelled");
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("inventory.adjust does NOT substitute for orders.confirm", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    // Holding every inventory permission and no order permission must not let
    // anyone move an order — the human action is the order transition.
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      "inventory.read",
      "inventory.adjust",
      "inventory.receive_stock",
      "inventory.view_movements",
    ]);

    await withOrderDb({ tables: { orders: orderRow() } }, async (calls) => {
      await expectForbidden(() => transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"));
      await expectForbidden(() => transitionLifecycleStatus(ctx, ORDER_ID, "cancelled"));
      expect(calls).toHaveLength(0);
    });
  });

  it("the state machine records which order permission authorizes each stock transition", async () => {
    const {
      STOCK_CONSUMING_TRANSITION,
      STOCK_RELEASING_TRANSITION,
      LIFECYCLE_TRANSITION_PERMISSIONS,
    } = await import("../server/orders/state-machine");
    expect(STOCK_CONSUMING_TRANSITION.permission).toBe("orders.confirm");
    expect(STOCK_RELEASING_TRANSITION.permission).toBe("orders.cancel");
    expect(LIFECYCLE_TRANSITION_PERMISSIONS.confirmed).toBe("orders.confirm");
    expect(LIFECYCLE_TRANSITION_PERMISSIONS.cancelled).toBe("orders.cancel");
  });

  it("the order service requires no inventory.* permission anywhere", () => {
    const src = readSource("src/server/orders/service.ts");
    const required = [...src.matchAll(/ctx\.require\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(required.length).toBeGreaterThan(0);
    expect(required.some((key) => key.startsWith("inventory."))).toBe(false);
  });
});

describe("Test 13: manual inventory adjustment is unchanged", () => {
  it("recordMovement still demands inventory.adjust for a manual_adjustment", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      // Every ORDER permission, and no inventory permission at all.
      "orders.read",
      "orders.create",
      "orders.confirm",
      "orders.cancel",
      "orders.update",
    ]);

    await expectForbidden(() =>
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: -5,
        movementType: "manual_adjustment",
        reason: "stock count correction",
      }),
    );
  });

  it("a hand-written 'sale' movement also still demands inventory.adjust", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.confirm", "orders.cancel"]);

    await expectForbidden(() =>
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: -5,
        movementType: "sale",
        referenceType: "order_item",
        referenceId: ORDER_ID,
      }),
    );
  });

  it("the mandatory fail-closed audit on manual adjustment is still in place", () => {
    const src = readSource("src/server/inventory/service.ts");
    expect(src).toMatch(/auditLogRequired\(/);
    expect(src).toMatch(/action: "inventory\.adjust"/);
    // Written BEFORE the mutation, so an unauditable adjustment cannot happen.
    expect(src.indexOf("auditLogRequired(")).toBeLessThan(src.indexOf("repo.insertMovement("));
  });

  it("the inventory permission mapping was not weakened", async () => {
    const src = readSource("src/server/inventory/service.ts");
    expect(src).toMatch(/case "manual_adjustment":\s*\n\s*return "inventory\.adjust"/);
    expect(src).toMatch(/return "inventory\.receive_stock"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEDGER INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 14: the ledger stays append-only and stock stays derived", () => {
  it("migration 026 only ever INSERTs into inventory_movements", () => {
    const body = integrationBody();
    const statements = body.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.inventory\w*/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^INSERT INTO/);
    }
  });

  it("migration 026 never writes inventory_stock — it is a view, not storage", () => {
    const body = integrationBody();
    expect(body).not.toMatch(/INSERT INTO public\.inventory_stock/);
    expect(body).not.toMatch(/UPDATE public\.inventory_stock/);
    expect(body).not.toMatch(/quantity_on_hand\s*=/);
  });

  it("no mutable stock column was introduced anywhere", () => {
    for (const file of fs
      .readdirSync(path.resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))) {
      const sql = executableSql(readSource(path.join("supabase/migrations", file)));
      expect(sql).not.toMatch(/ADD COLUMN\s+stock_quantity/i);
      expect(sql).not.toMatch(/ADD COLUMN\s+quantity_on_hand/i);
    }
  });

  it("inventory_stock is still a plain view summing the ledger", () => {
    const ledger = executableSql(ledgerMigration());
    expect(ledger).toMatch(/CREATE VIEW public\.inventory_stock/);
    expect(ledger).toMatch(/SUM\(quantity_delta\)/);
    expect(ledger).not.toMatch(/MATERIALIZED/);
  });

  it("a correction is a new movement: the return is an INSERT, not an edit", () => {
    expect(returnBranch()).toMatch(/INSERT INTO public\.inventory_movements/);
  });
});

describe("Test 15: stock availability policy is unchanged", () => {
  it("no stock check blocks confirmation — negative balances remain permitted", () => {
    const body = integrationBody();
    // APSA's ledger has never floored stock at zero; introducing a check here
    // would be a new reservation/oversell policy this phase did not decide.
    expect(body).not.toMatch(/insufficient_stock/);
    expect(body).not.toMatch(/quantity_on_hand\s*[<>]/);
    expect(body).not.toMatch(/FROM public\.inventory_stock/);
  });

  it("migration 021 still constrains only that a delta is non-zero", () => {
    const ledger = executableSql(ledgerMigration());
    expect(ledger).toMatch(/quantity_delta\s+INTEGER NOT NULL CHECK \(quantity_delta <> 0\)/);
    expect(ledger).not.toMatch(/CHECK \(quantity_on_hand >= 0\)/);
  });

  it("the behaviour is documented rather than left implicit", () => {
    const sql = integrationSql();
    expect(sql).toContain("STOCK AVAILABILITY");
    expect(sql.toLowerCase()).toContain("negative");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER BOUNDARY & RPC PRIVILEGES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 16: the privileged RPC stays out of reach of JWT clients", () => {
  it("EXECUTE is revoked from PUBLIC, anon and authenticated", () => {
    expect(integrationBody()).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.transition_order_status_v1\(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT\)\s+FROM PUBLIC, anon, authenticated/,
    );
  });

  it("service_role retains the EXECUTE it needs", () => {
    expect(integrationBody()).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.transition_order_status_v1\(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT\)\s+TO service_role/,
    );
  });

  it("REVOKE precedes GRANT so the end state does not depend on statement order", () => {
    const body = integrationBody();
    expect(
      body.indexOf("REVOKE EXECUTE ON FUNCTION public.transition_order_status_v1"),
    ).toBeLessThan(body.indexOf("GRANT EXECUTE ON FUNCTION public.transition_order_status_v1"));
  });

  it("no new EXECUTE grant is handed to anon or authenticated anywhere in 026", () => {
    const body = integrationBody();
    expect(body).not.toMatch(/GRANT EXECUTE[\s\S]{0,200}TO\s+(anon|authenticated)/);
    expect(body).not.toMatch(/GRANT\s+INSERT[\s\S]{0,120}inventory_movements/);
  });

  it("the signature is unchanged, so 024's grants and the repository still match", () => {
    const declared =
      /transition_order_status_v1\(\s*p_organization_id UUID,\s*p_order_id\s+UUID,\s*p_axis\s+TEXT,\s*p_expected_from\s+TEXT,\s*p_to\s+TEXT,\s*p_changed_by\s+UUID DEFAULT NULL,\s*p_reason\s+TEXT DEFAULT NULL\s*\)/;
    expect(integrationBody()).toMatch(declared);
    expect(executableSql(rpcMigration())).toMatch(declared);
  });

  it("SECURITY DEFINER still pins its search_path", () => {
    expect(integrationBody()).toMatch(/SECURITY DEFINER\s+SET search_path = public, auth/);
  });

  it("the ledger table itself gained no client write privilege", () => {
    const ledger = executableSql(ledgerMigration());
    expect(ledger).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.inventory_movements FROM anon, authenticated/,
    );
    expect(ledger).toMatch(/"inventory_movements_insert_blocked"[\s\S]{0,120}WITH CHECK \(false\)/);
  });

  it("server-only modules are still dynamically imported inside API handlers", () => {
    const api = readSource("src/api/orders.ts");
    expect(api).not.toMatch(/^import .*from ["']@\/server\/orders\/(service|repository)["']/m);
    expect(api).not.toMatch(/^import .*from ["']@\/lib\/supabase\/server["']/m);
    expect(api).toMatch(/await import\("@\/server\/orders\/service"\)/);
  });
});

describe("Test 17: migration hygiene", () => {
  it("026 is forward-only — no DROP, no TRUNCATE, no reset", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP TYPE/i);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.\w+ DROP/i);
  });

  it("it replaces the function rather than recreating it", () => {
    expect(integrationBody()).toMatch(
      /CREATE OR REPLACE FUNCTION public\.transition_order_status_v1/,
    );
  });

  it("it adds no table, column, index or enum value", () => {
    const sql = integrationBody();
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/ADD VALUE/i);
    expect(sql).not.toMatch(/CREATE TYPE/i);
  });

  it("it is safe for orders and movements that already exist", () => {
    // Pre-existing confirmed orders have no 'sale' rows; the EXISTS guard means
    // cancelling one restocks nothing rather than inventing units.
    expect(returnBranch()).toMatch(/AND EXISTS \(/);
    // And no statement rewrites history.
    expect(integrationBody()).not.toMatch(/UPDATE public\.inventory_movements/);
    expect(integrationBody()).not.toMatch(/UPDATE public\.order_items/);
  });

  it("the merged migrations 021 and 023-025 were not edited", () => {
    for (const file of [
      "supabase/migrations/021_inventory_movements.sql",
      "supabase/migrations/023_orders.sql",
      "supabase/migrations/024_order_rpc.sql",
      "supabase/migrations/025_order_permissions.sql",
    ]) {
      expect(fs.existsSync(path.resolve(process.cwd(), file))).toBe(true);
      expect(readSource(file)).not.toContain("026_order_inventory_integration");
    }
    expect(fs.existsSync(path.resolve(process.cwd(), INTEGRATION_MIGRATION))).toBe(true);
  });
});
