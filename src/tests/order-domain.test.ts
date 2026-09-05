/**
 * Production Order Domain Foundation tests.
 *
 * Structure mirrors src/tests/inventory-domain.test.ts: pure unit tests against
 * a mocked repository DB, plus source/migration structural assertions that need
 * no live database, plus live-DB checks that skip when Supabase is unconfigured.
 *
 * Coverage:
 *   CREATE
 *     1.  Successful single-item order creation
 *     2.  Multi-item order (subtotal is the sum of the lines)
 *     3.  Non-positive / non-integer quantities rejected
 *     4.  Server-authoritative pricing (the RPC receives no price at all)
 *     5.  Client cannot inject totals (no parameter exists; DB CHECKs back it)
 *     6.  Client cannot inject organization_id / user_id
 *     7.  Cross-org customer rejected
 *     8.  Cross-org product rejected
 *     9.  Cross-org variant rejected
 *    10.  Atomic failure leaves no partial order
 *   STATE MACHINE
 *    11.  Valid / invalid payment transitions
 *    12.  Valid / invalid fulfillment transitions
 *    13.  Valid / invalid lifecycle transitions, terminal behavior
 *    14.  The future inventory trigger point is explicit and documented
 *   READS
 *    15.  Org-scoped get by id; a guessed Org B id is not readable by Org A
 *    16.  List pagination and ordering
 *   SECURITY
 *    17.  Browser direct writes denied (RLS + REVOKE)
 *    18.  Server-authorized write path succeeds
 *    19.  No arbitrary-update escape hatch exists
 *    20.  Permission gates on every mutation
 *
 * Run: bun test src/tests/order-domain.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

// ── Environment check ─────────────────────────────────────────────────────────

let supabaseConfigured = false;

beforeAll(() => {
  supabaseConfigured =
    Boolean(process.env["VITE_SUPABASE_URL"]) && Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);

  if (!supabaseConfigured) {
    console.warn("[SKIP] Live DB tests require VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
});

async function requireSupabase<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!supabaseConfigured) {
    console.warn("[SKIP] Supabase not configured");
    return null;
  }
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("SUPABASE") ||
        e.message.includes("fetch failed") ||
        e.message.includes("ECONNREFUSED"))
    ) {
      console.warn("[SKIP] Supabase unreachable");
      return null;
    }
    throw e;
  }
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

/** Assert that fn() rejects, and return the error for further inspection. */
async function expectRejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected the call to reject, but it resolved");
}

// ── Context factory (mirrors inventory-domain.test.ts) ────────────────────────

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

/** Every order permission this phase defines. */
const ALL_ORDER_PERMS = [
  "orders.read",
  "orders.create",
  "orders.update",
  "orders.cancel",
  "orders.confirm",
  "orders.apply_discount",
  "payments.confirm",
];

// ── Fixture UUIDs ─────────────────────────────────────────────────────────────

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ORG_A = "user-aaaa-0000-0000-0000-000000000001";
const PRODUCT_ID = "cccccccc-0000-0000-0000-000000000001";
const VARIANT_ID = "dddddddd-0000-0000-0000-000000000001";
const VARIANT_2_ID = "dddddddd-0000-0000-0000-000000000002";
const OTHER_PRODUCT_ID = "eeeeeeee-0000-0000-0000-000000000001";
const CUSTOMER_ID = "99999999-0000-0000-0000-000000000001";
const LOCATION_ID = "ffffffff-0000-0000-0000-000000000001";
const ORDER_ID = "11111111-0000-0000-0000-000000000001";
/** A plausible-looking id that belongs to Org B — the IDOR probe. */
const ORG_B_ORDER_ID = "22222222-0000-0000-0000-000000000002";

// ── Source/migration readers (structural assertions, no DB needed) ────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

/**
 * The property names declared directly in an interface body, ignoring comments.
 * Used so a doc comment that mentions a forbidden concept cannot be mistaken
 * for a field that accepts it.
 */
function fieldNames(interfaceBody: string): string[] {
  return interfaceBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("/*") && !line.startsWith("//"))
    .map((line) => /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

const ordersMigration = () => readSource("supabase/migrations/023_orders.sql");
const rpcMigration = () => readSource("supabase/migrations/024_order_rpc.sql");
const permsMigration = () => readSource("supabase/migrations/025_order_permissions.sql");

// ── Mock repository DB ────────────────────────────────────────────────────────
//
// A minimal fluent fake for the supabase-js query builder shape used by
// src/server/orders/repository.ts, plus an .rpc() recorder so tests can inspect
// exactly what the server sent to the database.

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
  /** Per-RPC-name canned result. */
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

const variantRow: QueryResult = {
  data: {
    id: VARIANT_ID,
    product_id: PRODUCT_ID,
    organization_id: ORG_A_ID,
    status: "ACTIVE",
    price_currency: "USD",
  },
  error: null,
};

const customerRow: QueryResult = {
  data: { id: CUSTOMER_ID, organization_id: ORG_A_ID },
  error: null,
};

const locationRow: QueryResult = {
  data: { id: LOCATION_ID, organization_id: ORG_A_ID },
  error: null,
};

/** A stored order row, as the DB would return it after the create RPC. */
function orderRow(overrides: Record<string, unknown> = {}): QueryResult {
  return {
    data: {
      id: ORDER_ID,
      organization_id: ORG_A_ID,
      order_number: "APSA-2026-000001",
      customer_id: null,
      location_id: null,
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

const oneLine = itemRows([
  {
    id: "line-1",
    organization_id: ORG_A_ID,
    order_id: ORDER_ID,
    product_id: PRODUCT_ID,
    variant_id: VARIANT_ID,
    product_name_snapshot: "សេរ៉ូមវីតាមីន C",
    variant_name_snapshot: null,
    sku_snapshot: "SKU-1",
    unit_price_minor: 1800,
    quantity: 1,
    line_total_minor: 1800,
    created_at: "2026-09-05T00:00:00.000Z",
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 1: Successful order creation", () => {
  it("creates a draft order and returns it with its lines", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const detail = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
          audit_logs: { data: null, error: null },
        },
        rpc: {
          create_order_v1: {
            data: { status: "success", order_id: ORDER_ID, order_number: "APSA-2026-000001" },
            error: null,
          },
        },
      },
      () =>
        createOrder(ctx, {
          source: "POS",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
        }),
    );

    expect(detail.id).toBe(ORDER_ID);
    expect(detail.orderNumber).toBe("APSA-2026-000001");
    expect(detail.items).toHaveLength(1);
    expect(detail.total).toEqual({ amount: 1800, currency: "USD" });
  });

  it("a new order always starts draft / unpaid / unfulfilled", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const detail = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: {
          create_order_v1: {
            data: { status: "success", order_id: ORDER_ID },
            error: null,
          },
        },
      },
      () => createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 1 }] }),
    );

    expect(detail.lifecycleStatus).toBe("draft");
    expect(detail.paymentStatus).toBe("unpaid");
    expect(detail.fulfillmentStatus).toBe("unfulfilled");
  });

  it("creation requires orders.create", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read"]);
    await expectForbidden(() =>
      createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 1 }] }),
    );
  });

  it("SQL: the create RPC always inserts lifecycle 'draft'", () => {
    expect(rpcMigration()).toMatch(/'draft',\s*'unpaid',\s*'unfulfilled'/);
  });
});

describe("Test 2: Multi-item order", () => {
  it("sends every requested line to the create RPC", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow({ subtotal_minor: 3600, total_minor: 3600 }),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { create_order_v1: { data: { status: "success", order_id: ORDER_ID }, error: null } },
      },
      async (recorded) => {
        await createOrder(ctx, {
          source: "FACEBOOK",
          items: [
            { variantId: VARIANT_ID, quantity: 2 },
            { variantId: VARIANT_2_ID, quantity: 3 },
          ],
        });
        return recorded;
      },
    );

    const items = calls[0]?.args["p_items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ variant_id: VARIANT_ID, quantity: 2 });
    expect(items[1]).toEqual({ variant_id: VARIANT_2_ID, quantity: 3 });
  });

  it("SQL: subtotal is accumulated from the resolved lines, not supplied", () => {
    expect(rpcMigration()).toMatch(/v_subtotal\s*:=\s*v_subtotal \+ v_line_total/);
  });
});

describe("Test 3: Quantity must be a positive integer", () => {
  const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

  for (const quantity of [0, -1, -100, 1.5, Number.NaN]) {
    it(`rejects quantity ${String(quantity)} before any DB call`, async () => {
      const { createOrder } = await import("../server/orders/service");
      const calls = await withOrderDb({}, async (recorded) => {
        const err = await expectRejects(() =>
          createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity }] }),
        );
        expect(err.message).toContain("positive integer");
        return recorded;
      });
      // Nothing reached the database.
      expect(calls).toHaveLength(0);
    });
  }

  it("DB: order_items has a quantity > 0 constraint", () => {
    expect(ordersMigration()).toMatch(/quantity\s+INTEGER NOT NULL CHECK \(quantity > 0\)/);
  });

  it("SQL: the RPC rejects fractional quantities rather than rounding them", () => {
    // The guard compares the raw NUMERIC against its INTEGER cast.
    expect(rpcMigration()).toMatch(/\(v_item ->> 'quantity'\)::NUMERIC <> v_quantity/);
  });
});

describe("Test 4: Server-authoritative pricing", () => {
  it("the create RPC call carries no price of any kind", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { create_order_v1: { data: { status: "success", order_id: ORDER_ID }, error: null } },
      },
      async (recorded) => {
        await createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 2 }] });
        return recorded;
      },
    );

    const args = calls[0]!.args;
    const serialized = JSON.stringify(args);
    for (const forbidden of [
      "price",
      "unit_price",
      "line_total",
      "subtotal",
      "total",
      "currency",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The only monetary parameter is the discount input.
    expect(Object.keys(args).filter((k) => k.includes("minor"))).toEqual(["p_discount_minor"]);
  });

  it("SQL: the line price is read from product_variants inside the RPC", () => {
    expect(rpcMigration()).toMatch(
      /v_line_total\s*:=\s*v_variant\.price_amount::BIGINT \* v_quantity/,
    );
  });

  it("SQL: the order's currency comes from the organization, never a parameter", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(/SELECT default_currency INTO v_currency/);
    expect(sql).not.toMatch(/p_currency/);
  });
});

describe("Test 5: Client cannot inject totals", () => {
  it("CreateOrderServiceInput has no total/subtotal/price field", () => {
    const src = readSource("src/server/orders/service.ts");
    const start = src.indexOf("export interface CreateOrderServiceInput");
    const body = src.slice(start, src.indexOf("\n}", start));
    // Field names only — the doc comments explain what is deliberately absent,
    // and that explanation must not be read as the thing it rules out.
    const fields = fieldNames(body);
    expect(fields).toContain("source");
    expect(fields).toContain("items");
    expect(fields).toContain("discountMinor");
    for (const banned of [
      "total",
      "totalMinor",
      "subtotal",
      "subtotalMinor",
      "unitPrice",
      "price",
    ]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("the API boundary schema accepts no price field on a line", () => {
    const src = readSource("src/api/orders.ts");
    const schema = src.slice(
      src.indexOf("const orderLineSchema"),
      src.indexOf("// ── Internal helper"),
    );
    expect(schema).not.toContain("price");
    expect(schema).not.toContain("total");
  });

  it("DB: orders.total_minor is CHECK-constrained to its derived value", () => {
    expect(ordersMigration()).toMatch(
      /CONSTRAINT orders_total_is_derived CHECK \(\s*total_minor = subtotal_minor - discount_minor \+ delivery_minor\s*\)/,
    );
  });

  it("DB: order_items.line_total_minor is CHECK-constrained to unit_price * quantity", () => {
    expect(ordersMigration()).toMatch(
      /CONSTRAINT order_items_line_total_is_derived CHECK \(\s*line_total_minor = unit_price_minor \* quantity\s*\)/,
    );
  });

  it("DB: a discount can never exceed the subtotal", () => {
    expect(ordersMigration()).toMatch(/discount_minor <= subtotal_minor/);
    expect(rpcMigration()).toMatch(/p_discount_minor > v_subtotal/);
  });

  it("a non-zero discount requires orders.apply_discount", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.create", "orders.read"]);
    await expectForbidden(() =>
      createOrder(ctx, {
        source: "POS",
        items: [{ variantId: VARIANT_ID, quantity: 1 }],
        discountMinor: 500,
      }),
    );
  });

  it("DB: every money column is an integer type — no NUMERIC/FLOAT money", () => {
    const sql = ordersMigration();
    for (const column of [
      "subtotal_minor",
      "discount_minor",
      "delivery_minor",
      "total_minor",
      "unit_price_minor",
      "line_total_minor",
    ]) {
      expect(sql).toMatch(new RegExp(`${column}\\s+BIGINT`));
    }
    expect(sql).not.toMatch(
      /(subtotal|discount|delivery|total|unit_price|line_total)\w*\s+(NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT)/i,
    );
  });
});

describe("Test 6: Client cannot inject organization_id or user_id", () => {
  it("no API function accepts an organizationId or userId parameter", () => {
    const src = readSource("src/api/orders.ts");
    // A zod validator is the only way input reaches a handler, so it is enough
    // to prove no validator declares a tenant or actor field.
    expect(src).not.toMatch(/organizationId:\s*z\./);
    expect(src).not.toMatch(/organization_id:\s*z\./);
    expect(src).not.toMatch(/userId:\s*z\./);
    expect(src).not.toMatch(/user_id:\s*z\./);
    expect(src).not.toMatch(/createdBy:\s*z\./);
  });

  it("the API resolves the organization from DB membership", () => {
    const src = readSource("src/api/orders.ts");
    expect(src).toMatch(/from\("memberships"\)/);
    expect(src).toMatch(/\.eq\("status", "active"\)/);
  });

  it("the service passes ctx.organizationId and ctx.userId to the repository", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { create_order_v1: { data: { status: "success", order_id: ORDER_ID }, error: null } },
      },
      async (recorded) => {
        await createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 1 }] });
        return recorded;
      },
    );

    expect(calls[0]!.args["p_organization_id"]).toBe(ORG_A_ID);
    expect(calls[0]!.args["p_created_by"]).toBe(USER_ORG_A);
  });

  it("SQL: the write RPCs are not callable by any JWT client", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.create_order_v1[\s\S]*?FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.transition_order_status_v1[\s\S]*?FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.create_order_v1/);
  });
});

describe("Test 7: Cross-org customer rejected", () => {
  it("a customer belonging to another org is 'not found', never reaching the RPC", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      { tables: { customers: noRow, product_variants: variantRow } },
      async (recorded) => {
        const err = await expectRejects(() =>
          createOrder(ctx, {
            source: "FACEBOOK",
            items: [{ variantId: VARIANT_ID, quantity: 1 }],
            customerId: CUSTOMER_ID,
          }),
        );
        expect(err.message).toBe("Customer not found");
        expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
        return recorded;
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("SQL: the RPC re-checks customer ownership independently", () => {
    expect(rpcMigration()).toMatch(
      /FROM public\.customers\s+WHERE id = p_customer_id AND organization_id = p_organization_id/,
    );
  });

  it("DB: a trigger blocks a cross-tenant customer even on a service-role write", () => {
    const sql = ordersMigration();
    expect(sql).toMatch(/cross_tenant_customer/);
    expect(sql).toMatch(/CREATE TRIGGER order_cross_tenant_refs_check/);
  });
});

describe("Test 8: Cross-org product rejected", () => {
  it("a product that does not own the variant is rejected before the RPC", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      { tables: { product_variants: variantRow } },
      async (recorded) => {
        const err = await expectRejects(() =>
          createOrder(ctx, {
            source: "POS",
            // The variant really belongs to PRODUCT_ID; claiming another product
            // is how a caller would try to attach a line to a foreign product.
            items: [{ variantId: VARIANT_ID, quantity: 1, productId: OTHER_PRODUCT_ID }],
          }),
        );
        expect(err.message).toContain("does not belong to the given product_id");
        return recorded;
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("SQL: the RPC treats a caller-supplied product_id as a cross-check only", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(/v_claimed_pid <> v_variant\.product_id/);
    expect(sql).toMatch(/product_variant_mismatch/);
  });

  it("DB: a trigger requires order_items.product_id to be in the same org", () => {
    expect(ordersMigration()).toMatch(/cross_tenant_product/);
  });
});

describe("Test 9: Cross-org variant rejected", () => {
  it("a variant belonging to another org is 'not found', never reaching the RPC", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb({ tables: { product_variants: noRow } }, async (recorded) => {
      const err = await expectRejects(() =>
        createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 1 }] }),
      );
      expect(err.message).toBe("Product variant not found");
      expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
      return recorded;
    });
    expect(calls).toHaveLength(0);
  });

  it("the repository scopes every variant lookup by organization_id", () => {
    const src = readSource("src/server/orders/repository.ts");
    const fn = src.slice(src.indexOf("export async function findVariantForOrg"));
    expect(fn).toMatch(/\.eq\("organization_id", organizationId\)/);
  });

  it("SQL: the RPC's variant lookup is org-scoped", () => {
    expect(rpcMigration()).toMatch(
      /FROM public\.product_variants v\s+WHERE v\.id = \(v_item ->> 'variant_id'\)::UUID\s+AND v\.organization_id = p_organization_id/,
    );
  });

  it("DB: a trigger requires the variant to belong to the product AND the org", () => {
    expect(ordersMigration()).toMatch(/cross_tenant_variant/);
  });
});

describe("Test 10: Atomic failure leaves no partial order", () => {
  it("SQL: the create RPC validates every line before it writes anything", () => {
    const sql = rpcMigration();
    const pass1 = sql.indexOf("PASS 1");
    const pass2 = sql.indexOf("PASS 2");
    const firstInsert = sql.indexOf("INSERT INTO public.orders");

    expect(pass1).toBeGreaterThan(0);
    expect(pass2).toBeGreaterThan(pass1);
    // The first write in the function body comes after the validation pass.
    expect(firstInsert).toBeGreaterThan(pass2);
  });

  it("SQL: no early RETURN of a business status occurs after the order INSERT", () => {
    const sql = rpcMigration();
    const body = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.create_order_v1"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.transition_order_status_v1"),
    );
    const afterInsert = body.slice(body.indexOf("INSERT INTO public.orders"));
    // A plain RETURN does not roll back, so the only RETURN after the write must
    // be the success envelope.
    const returns = afterInsert.match(/RETURN jsonb_build_object\(\s*'status',\s*'(\w+)'/g) ?? [];
    expect(returns).toHaveLength(1);
    expect(returns[0]).toContain("'success'");
  });

  it("the service never reports success when the RPC returns a failure envelope", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const err = await expectRejects(() =>
      withOrderDb(
        {
          tables: { product_variants: variantRow },
          rpc: { create_order_v1: { data: { status: "variant_not_found" }, error: null } },
        },
        () => createOrder(ctx, { source: "POS", items: [{ variantId: VARIANT_ID, quantity: 1 }] }),
      ),
    );
    expect(err.message).toBe("Product variant not found");
  });

  it("order + items are one RPC call, not two independent inserts", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { create_order_v1: { data: { status: "success", order_id: ORDER_ID }, error: null } },
      },
      async (recorded) => {
        await createOrder(ctx, {
          source: "POS",
          items: [
            { variantId: VARIANT_ID, quantity: 1 },
            { variantId: VARIANT_2_ID, quantity: 1 },
          ],
        });
        return recorded;
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("create_order_v1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 11: Payment transitions", () => {
  it("accepts every documented valid payment transition", async () => {
    const { isValidPaymentTransition } = await import("../server/orders/state-machine");
    const valid: Array<[string, string]> = [
      ["unpaid", "pending"],
      ["unpaid", "paid"],
      ["unpaid", "failed"],
      ["pending", "paid"],
      ["pending", "failed"],
      ["pending", "unpaid"],
      ["failed", "pending"],
      ["failed", "paid"],
      ["failed", "unpaid"],
    ];
    for (const [from, to] of valid) {
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isValidPaymentTransition(from as any, to as any),
      ).toBe(true);
    }
  });

  it("rejects transitions out of 'paid' — refunds do not exist in this phase", async () => {
    const { isValidPaymentTransition, PAYMENT_TRANSITIONS } =
      await import("../server/orders/state-machine");
    expect(PAYMENT_TRANSITIONS.paid).toEqual([]);
    for (const to of ["unpaid", "pending", "failed"] as const) {
      expect(isValidPaymentTransition("paid", to)).toBe(false);
    }
  });

  it("does not model refunded / partially_refunded / partially_paid", async () => {
    const { ORDER_PAYMENT_STATUSES } = await import("../server/orders/state-machine");
    expect(ORDER_PAYMENT_STATUSES).toEqual(["unpaid", "pending", "paid", "failed"]);
    expect(ordersMigration()).not.toMatch(/'refunded'|'partially_refunded'|'partially_paid'/);
  });

  it("the service refuses an invalid payment transition", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      { tables: { orders: orderRow({ payment_status: "paid" }) } },
      async (recorded) => {
        const err = await expectRejects(() => transitionPaymentStatus(ctx, ORDER_ID, "unpaid"));
        expect(err.message).toContain("Cannot move payment status from 'paid' to 'unpaid'");
        expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
        return recorded;
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("the service performs a valid payment transition through the RPC", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const calls = await withOrderDb(
      {
        tables: {
          orders: orderRow({ payment_status: "unpaid" }),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { transition_order_status_v1: { data: { status: "success" }, error: null } },
      },
      async (recorded) => {
        await transitionPaymentStatus(ctx, ORDER_ID, "paid", "Cash at counter");
        return recorded;
      },
    );

    expect(calls[0]!.fn).toBe("transition_order_status_v1");
    expect(calls[0]!.args["p_axis"]).toBe("payment");
    expect(calls[0]!.args["p_expected_from"]).toBe("unpaid");
    expect(calls[0]!.args["p_to"]).toBe("paid");
    expect(calls[0]!.args["p_changed_by"]).toBe(USER_ORG_A);
  });

  it("payment transitions require payments.confirm", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read", "orders.update"]);
    await expectForbidden(() => transitionPaymentStatus(ctx, ORDER_ID, "paid"));
  });
});

describe("Test 12: Fulfillment transitions", () => {
  it("accepts every documented valid fulfillment transition", async () => {
    const { isValidFulfillmentTransition } = await import("../server/orders/state-machine");
    const valid: Array<[string, string]> = [
      ["unfulfilled", "processing"],
      ["unfulfilled", "fulfilled"],
      ["unfulfilled", "cancelled"],
      ["processing", "fulfilled"],
      ["processing", "unfulfilled"],
      ["processing", "cancelled"],
    ];
    for (const [from, to] of valid) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isValidFulfillmentTransition(from as any, to as any)).toBe(true);
    }
  });

  it("'fulfilled' and 'cancelled' are terminal — no 'returned' state exists yet", async () => {
    const { FULFILLMENT_TRANSITIONS, ORDER_FULFILLMENT_STATUSES } =
      await import("../server/orders/state-machine");
    expect(FULFILLMENT_TRANSITIONS.fulfilled).toEqual([]);
    expect(FULFILLMENT_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_FULFILLMENT_STATUSES).not.toContain("returned");
  });

  it("does not adopt the mock's courier-granularity fulfillment names", async () => {
    const { ORDER_FULFILLMENT_STATUSES } = await import("../server/orders/state-machine");
    for (const mockName of ["packing", "ready", "in_transit", "delivered", "confirmed"]) {
      expect(ORDER_FULFILLMENT_STATUSES as readonly string[]).not.toContain(mockName);
    }
  });

  it("the service refuses an invalid fulfillment transition", async () => {
    const { transitionFulfillmentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      { tables: { orders: orderRow({ fulfillment_status: "fulfilled" }) } },
      async () => {
        const err = await expectRejects(() =>
          transitionFulfillmentStatus(ctx, ORDER_ID, "processing"),
        );
        expect(err.message).toContain("Cannot move fulfillment status from 'fulfilled'");
      },
    );
  });

  it("cancelling fulfillment requires orders.cancel, not orders.update", async () => {
    const { transitionFulfillmentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read", "orders.update"]);
    await expectForbidden(() => transitionFulfillmentStatus(ctx, ORDER_ID, "cancelled"));
  });
});

describe("Test 13: Lifecycle transitions and terminal behavior", () => {
  it("accepts the documented lifecycle edges and no others", async () => {
    const { LIFECYCLE_TRANSITIONS } = await import("../server/orders/state-machine");
    expect(LIFECYCLE_TRANSITIONS.draft).toEqual(["confirmed", "cancelled"]);
    expect(LIFECYCLE_TRANSITIONS.confirmed).toEqual(["completed", "cancelled"]);
    expect(LIFECYCLE_TRANSITIONS.completed).toEqual([]);
    expect(LIFECYCLE_TRANSITIONS.cancelled).toEqual([]);
  });

  it("there is no way back from confirmed to draft", async () => {
    const { isValidLifecycleTransition } = await import("../server/orders/state-machine");
    expect(isValidLifecycleTransition("confirmed", "draft")).toBe(false);
  });

  it("a cancelled order accepts no further transition on any axis", async () => {
    const { transitionPaymentStatus, transitionFulfillmentStatus, transitionLifecycleStatus } =
      await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "cancelled", fulfillment_status: "cancelled" }),
        },
      },
      async () => {
        for (const call of [
          () => transitionPaymentStatus(ctx, ORDER_ID, "paid"),
          () => transitionFulfillmentStatus(ctx, ORDER_ID, "processing"),
          () => transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"),
        ]) {
          const err = await expectRejects(call);
          expect(err.message).toContain("cancelled");
          expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
        }
      },
    );
  });

  it("a completed order is likewise frozen", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      { tables: { orders: orderRow({ lifecycle_status: "completed" }) } },
      async () => {
        const err = await expectRejects(() => transitionPaymentStatus(ctx, ORDER_ID, "failed"));
        expect(err.message).toContain("completed");
      },
    );
  });

  it("confirming requires orders.confirm specifically", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      "orders.read",
      "orders.create",
      "orders.update",
      "orders.cancel",
    ]);
    await expectForbidden(() => transitionLifecycleStatus(ctx, ORDER_ID, "confirmed"));
  });

  it("cancelling requires orders.cancel specifically", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read", "orders.confirm"]);
    await expectForbidden(() => transitionLifecycleStatus(ctx, ORDER_ID, "cancelled"));
  });

  it("permission is checked before the order is loaded, so ids do not leak", async () => {
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.read"]);

    // No `orders` table result is configured: if the service read the order
    // before checking the permission, this would fail with "Order not found"
    // rather than Forbidden — telling an attacker the id was checked at all.
    await withOrderDb({}, async () => {
      await expectForbidden(() => transitionLifecycleStatus(ctx, ORG_B_ORDER_ID, "confirmed"));
    });
  });

  it("SQL: 'completed' requires the order to be both paid and fulfilled", () => {
    expect(rpcMigration()).toMatch(
      /p_to = 'completed'[\s\S]{0,220}payment_status <> 'paid' OR v_order\.fulfillment_status <> 'fulfilled'/,
    );
  });

  it("SQL: cancelling an order also cancels its fulfillment, in the same transaction", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(/p_axis = 'lifecycle' AND p_to = 'cancelled'/);
    expect(sql).toMatch(/UPDATE public\.orders SET fulfillment_status = 'cancelled'/);
  });

  it("SQL: the transition RPC is optimistic — it applies only from the expected state", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/v_current <> p_expected_from/);
    expect(sql).toMatch(/'stale'/);
  });

  it("a concurrent transition is surfaced as a conflict, not silently overwritten", async () => {
    const { transitionPaymentStatus } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      {
        tables: { orders: orderRow({ payment_status: "unpaid" }) },
        rpc: {
          transition_order_status_v1: {
            data: { status: "stale", current: "paid" },
            error: null,
          },
        },
      },
      async () => {
        const err = await expectRejects(() => transitionPaymentStatus(ctx, ORDER_ID, "pending"));
        expect(err.message).toContain("changed concurrently");
        expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
      },
    );
  });

  it("every transition writes a status-history row in the same transaction", () => {
    const sql = rpcMigration();
    const body = sql.slice(sql.indexOf("transition_order_status_v1"));
    expect(body).toMatch(/INSERT INTO public\.order_status_history/);
    expect(ordersMigration()).toMatch(/CREATE TABLE public\.order_status_history/);
  });
});

describe("Test 14: Future inventory trigger point is explicit", () => {
  it("names draft -> confirmed as the stock-consuming transition", async () => {
    const { STOCK_CONSUMING_TRANSITION } = await import("../server/orders/state-machine");
    expect(STOCK_CONSUMING_TRANSITION.axis).toBe("lifecycle");
    expect(STOCK_CONSUMING_TRANSITION.from).toBe("draft");
    expect(STOCK_CONSUMING_TRANSITION.to).toBe("confirmed");
    expect(STOCK_CONSUMING_TRANSITION.plannedMovementType).toBe("sale");
  });

  it("names confirmed -> cancelled as the stock-releasing transition", async () => {
    const { STOCK_RELEASING_TRANSITION } = await import("../server/orders/state-machine");
    expect(STOCK_RELEASING_TRANSITION.from).toBe("confirmed");
    expect(STOCK_RELEASING_TRANSITION.to).toBe("cancelled");
    expect(STOCK_RELEASING_TRANSITION.plannedMovementType).toBe("return");
  });

  it("is marked as NOT implemented in this phase", async () => {
    const { STOCK_CONSUMING_TRANSITION, STOCK_RELEASING_TRANSITION } =
      await import("../server/orders/state-machine");
    expect(STOCK_CONSUMING_TRANSITION.implemented).toBe(false);
    expect(STOCK_RELEASING_TRANSITION.implemented).toBe(false);
  });

  it("the Order domain does not call the Inventory domain yet", () => {
    for (const file of [
      "src/server/orders/service.ts",
      "src/server/orders/repository.ts",
      "src/api/orders.ts",
    ]) {
      const src = readSource(file);
      // Prose references to the future integration are expected; executable
      // imports and calls are not.
      expect(src).not.toMatch(/^\s*import[\s\S]{0,120}?from ["']@\/server\/inventory/m);
      expect(src).not.toMatch(/await import\(["']@\/server\/inventory/);
      expect(src).not.toMatch(/recordMovement\(/);
    }
  });

  it("no order migration writes to inventory_movements", () => {
    for (const sql of [ordersMigration(), rpcMigration(), permsMigration()]) {
      expect(sql).not.toMatch(/INSERT INTO public\.inventory_movements/);
    }
  });

  it("the trigger point is documented in the migration as well as the code", () => {
    expect(ordersMigration()).toContain("FUTURE INVENTORY TRIGGER POINT");
    expect(readSource("src/server/orders/service.ts")).toContain("FUTURE INVENTORY TRIGGER POINT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// READS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 15: Org-scoped reads", () => {
  it("getOrderById returns the order with items and history", async () => {
    const { getOrderById } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const detail = await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([
            {
              id: "hist-1",
              organization_id: ORG_A_ID,
              order_id: ORDER_ID,
              axis: "lifecycle",
              from_status: "draft",
              to_status: "confirmed",
              changed_by: USER_ORG_A,
              reason: null,
              changed_at: "2026-09-05T01:00:00.000Z",
            },
          ]),
        },
      },
      () => getOrderById(ctx, ORDER_ID),
    );

    expect(detail.id).toBe(ORDER_ID);
    expect(detail.items[0]!.productName).toBe("សេរ៉ូមវីតាមីន C");
    expect(detail.items[0]!.unitPrice).toEqual({ amount: 1800, currency: "USD" });
    expect(detail.statusHistory).toHaveLength(1);
    expect(detail.statusHistory[0]!.toStatus).toBe("confirmed");
  });

  it("a guessed Org B order UUID is not readable by Org A — plain 404, no detail", async () => {
    const { getOrderById } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    // The org-scoped query finds nothing, exactly as for a nonexistent id.
    await withOrderDb({ tables: { orders: noRow } }, async () => {
      const err = await expectRejects(() => getOrderById(ctx, ORG_B_ORDER_ID));
      expect(err.message).toBe("Order not found");
      expect((err as Error & { statusCode?: number }).statusCode).toBe(404);
      // No hint that the id exists elsewhere.
      expect(err.message).not.toContain("organization");
      expect(err.message).not.toContain("forbidden");
    });
  });

  it("every repository read filters on organization_id", () => {
    const src = readSource("src/server/orders/repository.ts");
    for (const table of ["orders", "order_items", "order_status_history"]) {
      const idx = src.indexOf(`.from("${table}")`);
      expect(idx).toBeGreaterThan(-1);
      const window = src.slice(idx, idx + 400);
      expect(window).toContain('.eq("organization_id", organizationId)');
    }
  });

  it("reads require orders.read", async () => {
    const { getOrderById, listOrders } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["orders.create"]);
    await expectForbidden(() => getOrderById(ctx, ORDER_ID));
    await expectForbidden(() => listOrders(ctx));
  });

  it("AuthorizationService rejects a user context for the wrong org (requires DB)", async () => {
    await requireSupabase(async () => {
      const { AuthorizationService } = await import("../server/auth/authorization");
      await expectForbidden(() => AuthorizationService.forRequest(USER_ORG_A, ORG_B_ID));
    });
  });
});

describe("Test 16: List pagination and ordering", () => {
  it("lists orders newest first with a stable secondary sort", () => {
    const src = readSource("src/server/orders/repository.ts");
    const fn = src.slice(src.indexOf("export async function listOrders"));
    expect(fn).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
    // Without an id tiebreak, rows sharing a created_at can appear twice or not at all.
    expect(fn).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });

  it("applies limit and a range-based offset", () => {
    const src = readSource("src/server/orders/repository.ts");
    const fn = src.slice(
      src.indexOf("export async function listOrders"),
      src.indexOf("export async function listOrderItems"),
    );
    expect(fn).toMatch(/query\.limit\(opts\.limit\)/);
    expect(fn).toMatch(/query\.range\(opts\.offset, opts\.offset \+ opts\.limit - 1\)/);
  });

  it("the API caps the page size so a caller cannot request the whole tenant", () => {
    const src = readSource("src/api/orders.ts");
    expect(src).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
    expect(src).toMatch(/limit: data\?\.limit \?\? 50/);
  });

  it("returns mapped summaries scoped to the caller's org", async () => {
    const { listOrders } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    const rows = await withOrderDb(
      {
        tables: {
          orders: itemRows([
            orderRow().data as Record<string, unknown>,
            orderRow({ id: "order-2", order_number: "APSA-2026-000002" }).data as Record<
              string,
              unknown
            >,
          ]),
        },
      },
      () => listOrders(ctx, { limit: 10 }),
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((o) => o.organizationId === ORG_A_ID)).toBe(true);
    expect(rows[0]!.total).toEqual({ amount: 1800, currency: "USD" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Test 17: Browser direct writes are denied", () => {
  const tables = ["orders", "order_items", "order_status_history"];

  for (const table of tables) {
    it(`${table}: RLS blocks INSERT, UPDATE and DELETE for JWT clients`, () => {
      const sql = ordersMigration();
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(
        new RegExp(`"${table}_insert_blocked"[\\s\\S]{0,120}WITH CHECK \\(false\\)`),
      );
      expect(sql).toMatch(
        new RegExp(`"${table}_(update_blocked|no_update)"[\\s\\S]{0,120}USING \\(false\\)`),
      );
      expect(sql).toMatch(new RegExp(`"${table}_no_delete"[\\s\\S]{0,120}USING \\(false\\)`));
    });

    it(`${table}: table privileges are revoked as well as policy-blocked`, () => {
      expect(ordersMigration()).toMatch(
        new RegExp(
          `REVOKE INSERT, UPDATE, DELETE ON public\\.${table}\\s+FROM anon, authenticated`,
        ),
      );
    });

    it(`${table}: members can still SELECT their own org's rows`, () => {
      expect(ordersMigration()).toMatch(
        new RegExp(
          `"${table}_select_member"[\\s\\S]{0,160}is_active_member_of\\(organization_id\\)`,
        ),
      );
    });
  }

  it("the order-number allocator is not readable by clients at all", () => {
    const sql = ordersMigration();
    expect(sql).toMatch(/ALTER TABLE public\.order_number_sequences ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL\s+ON public\.order_number_sequences FROM anon, authenticated/);
  });

  it("no financial table has a destructive cascade to catalog or customer records", () => {
    const sql = ordersMigration();
    // Order history must survive a customer/product/variant being removed.
    expect(sql).toMatch(/customer_id\s+UUID REFERENCES public\.customers\(id\) ON DELETE RESTRICT/);
    expect(sql).toMatch(
      /product_id\s+UUID NOT NULL REFERENCES public\.products\(id\) ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /variant_id\s+UUID NOT NULL REFERENCES public\.product_variants\(id\) ON DELETE RESTRICT/,
    );
  });

  it("order lines snapshot the catalog so later renames cannot rewrite history", () => {
    const sql = ordersMigration();
    expect(sql).toMatch(/product_name_snapshot TEXT NOT NULL/);
    expect(sql).toMatch(/variant_name_snapshot TEXT/);
    expect(sql).toMatch(/sku_snapshot\s+TEXT/);
  });
});

describe("Test 18: Server-authorized write path", () => {
  it("a fully permissioned caller completes the whole create → confirm → pay flow", async () => {
    const { createOrder, transitionLifecycleStatus, transitionPaymentStatus } =
      await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    // Create.
    await withOrderDb(
      {
        tables: {
          product_variants: variantRow,
          customers: customerRow,
          locations: locationRow,
          orders: orderRow(),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { create_order_v1: { data: { status: "success", order_id: ORDER_ID }, error: null } },
      },
      async () => {
        const created = await createOrder(ctx, {
          source: "FACEBOOK",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
          customerId: CUSTOMER_ID,
          locationId: LOCATION_ID,
        });
        expect(created.lifecycleStatus).toBe("draft");
      },
    );

    // Confirm — the future stock-consuming transition.
    const confirmCalls = await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "draft" }),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { transition_order_status_v1: { data: { status: "success" }, error: null } },
      },
      async (recorded) => {
        await transitionLifecycleStatus(ctx, ORDER_ID, "confirmed");
        return recorded;
      },
    );
    expect(confirmCalls[0]!.args["p_axis"]).toBe("lifecycle");
    expect(confirmCalls[0]!.args["p_to"]).toBe("confirmed");

    // Pay.
    const payCalls = await withOrderDb(
      {
        tables: {
          orders: orderRow({ lifecycle_status: "confirmed", payment_status: "unpaid" }),
          order_items: oneLine,
          order_status_history: itemRows([]),
        },
        rpc: { transition_order_status_v1: { data: { status: "success" }, error: null } },
      },
      async (recorded) => {
        await transitionPaymentStatus(ctx, ORDER_ID, "paid");
        return recorded;
      },
    );
    expect(payCalls[0]!.args["p_to"]).toBe("paid");
  });
});

describe("Test 19: No arbitrary-update escape hatch", () => {
  it("the repository exposes no generic update or delete for orders", () => {
    const src = readSource("src/server/orders/repository.ts");
    expect(src).not.toMatch(/export async function updateOrder\b/);
    expect(src).not.toMatch(/export async function deleteOrder\b/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });

  it("the service exposes no patch-shaped order mutation", () => {
    const src = readSource("src/server/orders/service.ts");
    expect(src).not.toMatch(/export async function updateOrder\b/);
    expect(src).not.toMatch(/Partial<OrderRow>/);
  });

  it("the API boundary offers no generic status setter", () => {
    const src = readSource("src/api/orders.ts");
    expect(src).not.toMatch(/setOrderStatusFn|updateOrderFn|patchOrderFn/);
    // Each axis has its own narrowly typed handler.
    expect(src).toContain("transitionOrderLifecycleFn");
    expect(src).toContain("transitionOrderPaymentFn");
    expect(src).toContain("transitionOrderFulfillmentFn");
  });

  it("all writes flow through the two transactional RPCs", () => {
    const src = readSource("src/server/orders/repository.ts");
    const rpcNames = [...src.matchAll(/db\.rpc\("(\w+)"/g)].map((m) => m[1]);
    expect(rpcNames.sort()).toEqual(["create_order_v1", "transition_order_status_v1"]);
  });
});

describe("Test 20: Order number strategy", () => {
  it("allocation is an atomic increment, never SELECT MAX + 1", () => {
    const sql = rpcMigration();
    expect(sql).toMatch(/ON CONFLICT \(organization_id, year\)\s+DO UPDATE SET last_number = /);
    // Strip comments: the migration explains in prose why MAX+1 is wrong, and
    // that explanation must not be mistaken for the pattern it warns against.
    const executable = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/MAX\(/i);
  });

  it("the reference is unique per organization, not globally", () => {
    expect(ordersMigration()).toMatch(
      /CREATE UNIQUE INDEX uniq_orders_number_per_org\s+ON public\.orders\(organization_id, order_number\)/,
    );
  });

  it("uses the DATA_MODEL §45 format", () => {
    expect(rpcMigration()).toMatch(/'APSA-' \|\| v_year::TEXT \|\| '-' \|\| lpad\(/);
  });

  it("is documented as a display reference, never a security identifier", () => {
    expect(ordersMigration()).toMatch(/never used as a security identifier/i);
    // Reads are by UUID + org, not by order_number.
    const repoSrc = readSource("src/server/orders/repository.ts");
    expect(repoSrc).not.toMatch(/\.eq\("order_number"/);
  });
});

describe("Test 21: Permission vocabulary", () => {
  it("adds only the two matrix-defined keys this phase needs", () => {
    const sql = permsMigration();
    expect(sql).toContain("'orders.confirm'");
    expect(sql).toContain("'orders.apply_discount'");
    // Keys for features this phase does not build must not be seeded.
    expect(sql).not.toContain("'orders.return'");
    expect(sql).not.toContain("'orders.change_price'");
    expect(sql).not.toContain("'orders.update_status'");
  });

  it("reuses the keys migration 003 already seeded", () => {
    const seeded = readSource("supabase/migrations/003_roles_permissions.sql");
    for (const key of [
      "orders.read",
      "orders.create",
      "orders.update",
      "orders.cancel",
      "payments.confirm",
    ]) {
      expect(seeded).toContain(`'${key}'`);
    }
    // And 025 does not redefine them.
    const sql = permsMigration();
    expect(sql).not.toMatch(/INSERT INTO public\.permissions[\s\S]{0,300}'orders\.read'/);
  });

  it("grants OWNER explicitly — 003's blanket grant does not cover later keys", () => {
    expect(permsMigration()).toMatch(/v_owner_id[\s\S]{0,600}role_permissions/);
  });

  it("only the state machine's declared keys are required by the service", async () => {
    const {
      LIFECYCLE_TRANSITION_PERMISSIONS,
      FULFILLMENT_TRANSITION_PERMISSIONS,
      PAYMENT_TRANSITION_PERMISSION,
    } = await import("../server/orders/state-machine");

    const used = new Set<string>([
      PAYMENT_TRANSITION_PERMISSION,
      ...Object.values(LIFECYCLE_TRANSITION_PERMISSIONS).filter((v): v is string => v !== null),
      ...Object.values(FULFILLMENT_TRANSITION_PERMISSIONS),
      "orders.read",
      "orders.create",
      "orders.apply_discount",
    ]);
    expect([...used].sort()).toEqual([
      "orders.apply_discount",
      "orders.cancel",
      "orders.confirm",
      "orders.create",
      "orders.read",
      "orders.update",
      "payments.confirm",
    ]);
  });
});

describe("Test 22: Migration hygiene", () => {
  it("the order migrations are forward-only — no DROP of existing objects", () => {
    for (const sql of [ordersMigration(), rpcMigration(), permsMigration()]) {
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/DROP TYPE/i);
      expect(sql).not.toMatch(/TRUNCATE/i);
    }
  });

  it("the permission migration is re-run safe", () => {
    const sql = permsMigration();
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it("no earlier migration was edited to accommodate orders", () => {
    // 023-025 are new files; the Inventory ledger migration must be untouched.
    const inventory = readSource("supabase/migrations/021_inventory_movements.sql");
    expect(inventory).not.toContain("orders");
    expect(fs.existsSync(path.resolve(process.cwd(), "supabase/migrations/023_orders.sql"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.resolve(process.cwd(), "supabase/migrations/024_order_rpc.sql")),
    ).toBe(true);
    expect(
      fs.existsSync(path.resolve(process.cwd(), "supabase/migrations/025_order_permissions.sql")),
    ).toBe(true);
  });
});
