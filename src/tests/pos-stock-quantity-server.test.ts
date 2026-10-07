/**
 * POS stock → quantity: what the SERVER does with a quantity > 1 (V1 P2).
 *
 * The browser's stock figure is UX only. These tests pin the server's own
 * behaviour so a client fix can neither be undone server-side nor be
 * mistaken for authority:
 *
 *   - createOrder forwards the requested quantity to the create RPC exactly,
 *     and reads it back from order_items — quantity 5 stays 5.
 *   - createOrder never reads stock: there is no inventory table in its path,
 *     so it cannot invent a cap of 1 (or any cap). V1 policy (migration 026):
 *     confirming writes the PERSISTED quantity to the ledger with no
 *     availability check; a negative derived balance stays visible.
 *   - Quantity is still a positive integer, and a variant outside the
 *     caller's organization is still refused before any write.
 *
 * Uses a recording fake of the repository's DB client (same shape as
 * order-domain.test.ts), so no live database is needed.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-0000000000a1";
const ORG_B_ID = "bbbbbbbb-0000-0000-0000-0000000000b2";
const USER_A = "user-aaaa-0000-0000-0000-0000000000a1";
const PRODUCT_ID = "cccccccc-0000-0000-0000-0000000000c1";
const VARIANT_ID = "dddddddd-0000-0000-0000-0000000000d1";
const ORDER_ID = "11111111-0000-0000-0000-000000000011";
const IDEMPOTENCY_KEY = "fixture-bbbbbbbbbbbbbbbb";

function ctxFor(organizationId: string): AuthorizationContext {
  const perms = new Set(["orders.read", "orders.create", "orders.confirm"]);
  return {
    userId: USER_A,
    organizationId,
    roleId: "role",
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
  } as unknown as AuthorizationContext;
}

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

interface Recorded {
  tables: string[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

async function withDb<T>(
  tables: Record<string, QueryResult>,
  fn: (recorded: Recorded) => Promise<T>,
): Promise<T> {
  const { setOrderRepositoryDbForTests } = await import("../server/orders/repository");
  const recorded: Recorded = { tables: [], rpcs: [] };
  const restore = setOrderRepositoryDbForTests({
    from: (table: string) => {
      recorded.tables.push(table);
      return fakeQuery(tables[table] ?? { data: null, error: null });
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      recorded.rpcs.push({ fn: name, args });
      return { data: { status: "success", order_id: ORDER_ID }, error: null };
    },
  });
  try {
    return await fn(recorded);
  } finally {
    restore();
  }
}

const NO_ROW: QueryResult = { data: null, error: { code: "PGRST116", message: "no rows" } };

function variantIn(organizationId: string): QueryResult {
  return {
    data: {
      id: VARIANT_ID,
      product_id: PRODUCT_ID,
      organization_id: organizationId,
      status: "ACTIVE",
      price_currency: "USD",
    },
    error: null,
  };
}

/** The persisted order + line the RPC wrote for `quantity` units at $20.00. */
function persisted(quantity: number, currency: "USD" | "KHR" = "USD", unit = 2000) {
  const total = unit * quantity;
  return {
    orders: {
      data: {
        id: ORDER_ID,
        organization_id: ORG_A_ID,
        order_number: "APSA-2026-000011",
        customer_id: null,
        location_id: null,
        source: "POS",
        currency,
        subtotal_minor: total,
        discount_minor: 0,
        delivery_minor: 0,
        total_minor: total,
        lifecycle_status: "draft",
        payment_status: "unpaid",
        fulfillment_status: "unfulfilled",
        created_by: USER_A,
        created_at: "2026-10-07T00:00:00.000Z",
        updated_at: "2026-10-07T00:00:00.000Z",
      },
      error: null,
    },
    order_items: {
      data: [
        {
          id: "line-1",
          organization_id: ORG_A_ID,
          order_id: ORDER_ID,
          product_id: PRODUCT_ID,
          variant_id: VARIANT_ID,
          product_name_snapshot: "Serum",
          variant_name_snapshot: null,
          sku_snapshot: "SKU-1",
          unit_price_minor: unit,
          quantity,
          line_total_minor: total,
          created_at: "2026-10-07T00:00:00.000Z",
        },
      ],
      error: null,
    },
    order_status_history: { data: [], error: null },
  } satisfies Record<string, QueryResult>;
}

const INVENTORY_TABLE = /inventory|stock/i;

describe("B. a POS quantity > 1 survives order creation (server)", () => {
  for (const [currency, unit] of [
    ["USD", 2000],
    ["KHR", 5000],
  ] as const) {
    it(`${currency}: quantity 5 reaches the RPC as 5 and reads back as 5 × unit price`, async () => {
      const { createOrder } = await import("../server/orders/service");
      const { detail, recorded } = await withDb(
        { product_variants: variantIn(ORG_A_ID), ...persisted(5, currency, unit) },
        async (recorded) => ({
          recorded,
          detail: await createOrder(ctxFor(ORG_A_ID), {
            idempotencyKey: IDEMPOTENCY_KEY,
            source: "POS",
            items: [{ variantId: VARIANT_ID, quantity: 5, productId: PRODUCT_ID }],
          }),
        }),
      );
      const create = recorded.rpcs.find((c) => c.fn.startsWith("create_order"))!;
      expect(create.args["p_items"]).toEqual([
        { variant_id: VARIANT_ID, quantity: 5, product_id: PRODUCT_ID },
      ]);
      // The server sends no price: the RPC prices from the catalog.
      expect(JSON.stringify(create.args)).not.toMatch(/price|unit_price|line_total/);
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0]!.quantity).toBe(5);
      expect(detail.items[0]!.lineTotal).toEqual({ amount: unit * 5, currency });
      expect(detail.total).toEqual({ amount: unit * 5, currency });
    });
  }

  it("creating never reads stock — the server invents no cap at create time", async () => {
    const { createOrder } = await import("../server/orders/service");
    const recorded = await withDb(
      { product_variants: variantIn(ORG_A_ID), ...persisted(40) },
      async (recorded) => {
        await createOrder(ctxFor(ORG_A_ID), {
          idempotencyKey: IDEMPOTENCY_KEY,
          source: "POS",
          items: [{ variantId: VARIANT_ID, quantity: 40 }],
        });
        return recorded;
      },
    );
    expect(recorded.tables.filter((t) => INVENTORY_TABLE.test(t))).toEqual([]);
    const create = recorded.rpcs.find((c) => c.fn.startsWith("create_order"))!;
    expect((create.args["p_items"] as Array<{ quantity: number }>)[0]!.quantity).toBe(40);
  });

  for (const quantity of [0, -1, 1.5, Number.NaN, Infinity]) {
    it(`a forged quantity ${String(quantity)} is still refused before any write`, async () => {
      const { createOrder } = await import("../server/orders/service");
      const recorded = await withDb({ product_variants: variantIn(ORG_A_ID) }, async (rec) => {
        await expect(
          createOrder(ctxFor(ORG_A_ID), {
            idempotencyKey: IDEMPOTENCY_KEY,
            source: "POS",
            items: [{ variantId: VARIANT_ID, quantity }],
          }),
        ).rejects.toThrow(/positive integer/);
        return rec;
      });
      expect(recorded.rpcs.filter((c) => c.fn.startsWith("create_order"))).toEqual([]);
    });
  }
});

describe("J. organization isolation is unchanged", () => {
  it("a variant outside the caller's organization is not found; nothing is written", async () => {
    const { createOrder } = await import("../server/orders/service");
    // The org-scoped variant lookup returns no row for Org B's caller.
    const recorded = await withDb({ product_variants: NO_ROW }, async (rec) => {
      await expect(
        createOrder(ctxFor(ORG_B_ID), {
          idempotencyKey: IDEMPOTENCY_KEY,
          source: "POS",
          items: [{ variantId: VARIANT_ID, quantity: 5 }],
        }),
      ).rejects.toThrow(/not found/i);
      return rec;
    });
    expect(recorded.rpcs.filter((c) => c.fn.startsWith("create_order"))).toEqual([]);
  });
});

describe("ledger: confirming moves the PERSISTED quantity, with no availability check", () => {
  const sql = fs
    .readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/026_order_inventory_integration.sql"),
      "utf-8",
    )
    .replace(/\r\n/g, "\n");

  it("the sale movement is −order_items.quantity", () => {
    expect(sql).toMatch(/-\s*\w*\.?quantity/);
    expect(sql).toMatch(/'sale'/);
  });

  it("migration 026 keeps the ledger's negative-balance policy (no oversell gate)", () => {
    expect(sql).toMatch(/STOCK AVAILABILITY: THE EXISTING POLICY IS PRESERVED/);
  });
});
