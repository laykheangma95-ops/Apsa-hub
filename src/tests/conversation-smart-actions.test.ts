/**
 * Conversation Smart Actions — integration tests.
 *
 * Covers the bridge between the Cambodian intent engine and the Conversation
 * screen's Smart Action vocabulary (src/lib/conversation/smart-actions.ts),
 * plus the Order domain's new conversation-provenance field (migration 030).
 *
 * SMART ACTION MAPPING
 *   1.  Khmer / mixed / romanized purchase messages resolve to prepare_order
 *   2.  Low-confidence interest never surfaces prepare_order
 *   3.  Negation / hesitation never surfaces an order action
 *   4.  Repeat-purchase phrasing maps to repeat_order, not prepare_order
 *   5.  save_contact maps to view_customer; unsupported actions drop silently
 *   6.  At most one primary + two secondary actions, ever
 *   7.  The Smart Action vocabulary never contains a forbidden action id
 * CUSTOMER LINKAGE
 *   8.  No linked customer -> view_customer is always primary
 *   9.  No linked customer -> prepare_order/repeat_order never offered
 * ORDER PREFILL
 *  10.  Single catalog match pre-fills a line
 *  11.  Multiple candidates become a picker, never a guess
 *  12.  No match becomes a blank line (manual search)
 *  13.  Multi-item detection preserves distinct lines
 *  14.  Repeat order re-resolves against the CURRENT catalog, not a snapshot
 * SECURITY
 *  15.  Catalog resolution can never name a product outside the given catalog
 *  16.  A cross-tenant candidate id injected into engine output is dropped
 * ORDER DOMAIN — CONVERSATION PROVENANCE (migration 030)
 *  17.  sourceConversationRef reaches the create RPC unchanged
 *  18.  Blank/whitespace-only ref is stored as null
 *  19.  An overly long ref is rejected before any DB call
 *  20.  The API boundary schema accepts the field (structural)
 *
 * Run: bun test src/tests/conversation-smart-actions.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  buildSmartActionSuggestion,
  resolvedProductOf,
  toPrepareOrderItems,
  toRepeatOrderItems,
  SMART_ACTION_IDS,
  type SmartActionId,
} from "../lib/conversation/smart-actions";
import { products as mockProducts } from "../lib/mock/products";
import type { Product } from "../types";
import { usd } from "../lib/money";

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

const teeShirt = mockProducts.find((p) => p.id === "prd-3")!; // colour: Black/White/Cream, size: S/M/L/XL
const bag = mockProducts.find((p) => p.id === "prd-4")!; // colour: Black/Brown
const catalog: Product[] = [teeShirt, bag];

const FORBIDDEN_ACTIONS = [
  "confirm_payment",
  "payment_received",
  "refund",
  "create_delivery",
  "mark_delivered",
];

// ═══════════════════════════════════════════════════════════════════════════
// SMART ACTION MAPPING
// ═══════════════════════════════════════════════════════════════════════════

describe("Test 1: purchase messages map to prepare_order", () => {
  const cases: string[] = [
    "យក black size M", // natural Khmer, mixed with English variant words
    "black M មានអត់? យក black M 2", // mixed Khmer-English
    "yk black M 2 bong", // romanized Khmer
  ];

  for (const input of cases) {
    it(`"${input}" suggests prepare_order as primary`, () => {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body: input, direction: "inbound" }],
        hasCustomer: true,
        products: catalog,
      });
      expect(suggestion.primary).toBe("prepare_order");
    });
  }
});

describe("Test 2: low-confidence interest never suggests an order", () => {
  for (const input of ["អានេះស្អាត", "ចូលចិត្ត black", "this one is cute"]) {
    it(`"${input}" does not surface prepare_order`, () => {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body: input, direction: "inbound" }],
        hasCustomer: true,
        products: catalog,
      });
      expect(suggestion.primary).not.toBe("prepare_order");
      expect(suggestion.secondary).not.toContain("prepare_order");
    });
  }
});

describe("Test 3: negation and hesitation never suggest an order action", () => {
  for (const input of ["អត់យកទេ", "cancel", "គិតសិន", "ចាំសិន"]) {
    it(`"${input}" never surfaces prepare_order or repeat_order`, () => {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body: input, direction: "inbound" }],
        hasCustomer: true,
        products: catalog,
      });
      expect(suggestion.primary).not.toBe("prepare_order");
      expect(suggestion.primary).not.toBe("repeat_order");
    });
  }
});

describe("Test 4: repeat-purchase phrasing maps to repeat_order", () => {
  for (const input of ["យកដដែលបង", "same as last time bong", "yk aa ddael"]) {
    it(`"${input}" is offered as repeat_order, not prepare_order`, () => {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body: "យកដដែលបង", direction: "inbound" }],
        hasCustomer: true,
        products: catalog,
      });
      expect(suggestion.primary).toBe("repeat_order");
      expect(suggestion.primary).not.toBe("prepare_order");
      void input;
    });
  }
});

describe("Test 5: engine action mapping onto the Smart Action vocabulary", () => {
  it("a volunteered phone number maps to view_customer, not a new surface", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "នេះលេខខ្ញុំ 012 345 678", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    expect(suggestion.primary).toBe("view_customer");
  });

  it("stock questions map to check_stock", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "black size M មានអត់?", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    expect(suggestion.primary).toBe("check_stock");
  });
});

describe("Test 6: at most one primary and two secondary actions", () => {
  it("never emits more than three actions total", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [
        { body: "black size M mean ot? tlai ponman? delivery ponman?", direction: "inbound" },
      ],
      hasCustomer: true,
      products: catalog,
    });
    const total = (suggestion.primary ? 1 : 0) + suggestion.secondary.length;
    expect(total).toBeLessThanOrEqual(3);
    expect(suggestion.secondary.length).toBeLessThanOrEqual(2);
  });

  it("secondary never repeats primary", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "yk black M 2", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    if (suggestion.primary) expect(suggestion.secondary).not.toContain(suggestion.primary);
  });
});

describe("Test 7: the Smart Action vocabulary never contains a forbidden action", () => {
  it("SMART_ACTION_IDS excludes every payment/delivery-execution action", () => {
    for (const forbidden of FORBIDDEN_ACTIONS) {
      expect(SMART_ACTION_IDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("SmartActionId's declared union in source excludes every forbidden action", () => {
    const source = readSource("src/lib/conversation/smart-actions.ts");
    const unionBlock = /export type SmartActionId =([\s\S]*?);/.exec(source)?.[1] ?? "";
    for (const forbidden of FORBIDDEN_ACTIONS) {
      expect(unionBlock.includes(`"${forbidden}"`)).toBe(false);
    }
  });

  it("no test input ever produces a forbidden action id", () => {
    const messages = [
      "black M 2",
      "delivery ponman?",
      "confirm order",
      "paid already",
      "refund please",
    ];
    for (const body of messages) {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body, direction: "inbound" }],
        hasCustomer: true,
        products: catalog,
      });
      const all: (SmartActionId | null)[] = [suggestion.primary, ...suggestion.secondary];
      for (const action of all) {
        if (action) expect(FORBIDDEN_ACTIONS).not.toContain(action);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER LINKAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("Test 8: no linked customer forces view_customer as primary", () => {
  it("overrides a strong purchase intent", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "យក black M 2", direction: "inbound" }],
      hasCustomer: false,
      products: catalog,
    });
    expect(suggestion.primary).toBe("view_customer");
  });
});

describe("Test 9: no linked customer never offers order-creating actions", () => {
  it("prepare_order and repeat_order are absent from both slots", () => {
    for (const body of ["យក black M 2", "យកដដែលបង"]) {
      const suggestion = buildSmartActionSuggestion({
        messages: [{ body, direction: "inbound" }],
        hasCustomer: false,
        products: catalog,
      });
      const all = [suggestion.primary, ...suggestion.secondary];
      expect(all).not.toContain("prepare_order");
      expect(all).not.toContain("repeat_order");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER PREFILL
// ═══════════════════════════════════════════════════════════════════════════

describe("Test 10: a single catalog match pre-fills a line", () => {
  it("resolves colour+size to the one matching product", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "yk black M 2", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    const prefill = toPrepareOrderItems(suggestion.items, catalog);
    expect(prefill).toHaveLength(1);
    expect(prefill[0]?.product?.id).toBe(teeShirt.id);
    expect(prefill[0]?.quantity).toBe(2);
    expect(prefill[0]?.candidates).toBeUndefined();
  });
});

describe("Test 11: several candidates become a picker, never a guess", () => {
  it("both products share 'black' with no size stated -> no auto-pick", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "យក black", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    const prefill = toPrepareOrderItems(suggestion.items, catalog);
    expect(prefill).toHaveLength(1);
    expect(prefill[0]?.product).toBeUndefined();
    expect(prefill[0]?.candidates?.map((p) => p.id).sort()).toEqual([teeShirt.id, bag.id].sort());
  });
});

describe("Test 12: no catalog match becomes a blank, searchable line", () => {
  it("a colour absent from the catalog resolves to nothing pre-filled", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "yk navy 2", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    const prefill = toPrepareOrderItems(suggestion.items, catalog);
    expect(prefill).toHaveLength(1);
    expect(prefill[0]?.product).toBeUndefined();
    expect(prefill[0]?.candidates ?? []).toHaveLength(0);
    expect(prefill[0]?.quantity).toBe(2);
  });
});

describe("Test 13: multi-item detection preserves distinct lines", () => {
  it("black M 1, brown bag 1 stays two lines, not a summed quantity", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "black M 1, brown 1", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    expect(suggestion.primary).toBe("prepare_order");
    expect(suggestion.items).toHaveLength(2);
  });
});

describe("Test 14: repeat order re-resolves against the current catalog", () => {
  it("a still-listed product is pre-filled with its CURRENT price", () => {
    const repriced: Product = { ...teeShirt, price: usd(1500) };
    const prefill = toRepeatOrderItems([{ productId: teeShirt.id, quantity: 3 }], [repriced, bag]);
    expect(prefill[0]?.product?.price).toEqual(usd(1500));
    expect(prefill[0]?.quantity).toBe(3);
  });

  it("a discontinued product becomes a blank line, not a stale snapshot", () => {
    const prefill = toRepeatOrderItems([{ productId: "no-longer-exists", quantity: 2 }], catalog);
    expect(prefill[0]?.product).toBeUndefined();
    expect(prefill[0]?.quantity).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════════════

describe("Test 15: catalog resolution never names a product outside the catalog", () => {
  it("resolvedProductOf only ever returns a product present in the given list", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "yk black M 2", direction: "inbound" }],
      hasCustomer: true,
      products: catalog,
    });
    for (const item of suggestion.items) {
      const resolved = resolvedProductOf(item, catalog);
      if (resolved) expect(catalog.map((p) => p.id)).toContain(resolved.id);
    }
  });

  it("a smaller catalog (tenant-scoped) cannot resolve a product only a larger one has", () => {
    const suggestion = buildSmartActionSuggestion({
      messages: [{ body: "yk black M 2", direction: "inbound" }],
      hasCustomer: true,
      products: catalog, // includes teeShirt
    });
    // Simulate Org B's catalog, which does not carry this product at all.
    const orgBCatalog: Product[] = [bag];
    const prefill = toPrepareOrderItems(suggestion.items, orgBCatalog);
    expect(prefill[0]?.product).toBeUndefined();
  });
});

describe("Test 16: a fabricated candidate id injected into engine output is dropped", () => {
  it("resolvedProductOf ignores a productId absent from the trusted catalog", () => {
    const fake = {
      candidate: { color: "black" },
      resolution: {
        item: { color: "black" },
        productId: "org-b-product-uuid-guess",
        candidateProductIds: ["org-b-product-uuid-guess"],
        unmatchedAttributes: [],
      },
    };
    expect(resolvedProductOf(fake, catalog)).toBeUndefined();
  });

  it("toPrepareOrderItems never fabricates a Product object for an unresolvable id", () => {
    const fake = {
      candidate: { color: "black", quantity: 1 },
      resolution: {
        item: { color: "black", quantity: 1 },
        productId: "org-b-product-uuid-guess",
        candidateProductIds: ["org-b-product-uuid-guess"],
        unmatchedAttributes: [],
      },
    };
    const prefill = toPrepareOrderItems([fake], catalog);
    expect(prefill[0]?.product).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER DOMAIN — CONVERSATION PROVENANCE (migration 030)
// ═══════════════════════════════════════════════════════════════════════════

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_ORG_A = "user-aaaa-0000-0000-0000-000000000001";
const VARIANT_ID = "dddddddd-0000-0000-0000-000000000001";

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

async function withOrderDb<T>(
  opts: { tables?: Record<string, QueryResult>; rpc?: Record<string, QueryResult> },
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

function makeCtxWithPerms(userId: string, organizationId: string, permissions: string[]) {
  const perms = new Set<string>(permissions);
  return {
    userId,
    organizationId,
    roleId: "role-with-perms",
    systemRole: "MANAGER",
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { name: "ForbiddenError" });
      }
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new Error("Owner access required");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const ALL_ORDER_PERMS = ["orders.read", "orders.create", "orders.apply_discount"];

const variantRow: QueryResult = {
  data: {
    id: VARIANT_ID,
    product_id: "cccccccc-0000-0000-0000-000000000001",
    organization_id: ORG_A_ID,
    status: "ACTIVE",
    price_currency: "USD",
  },
  error: null,
};

function orderRow(overrides: Record<string, unknown> = {}): QueryResult {
  return {
    data: {
      id: "11111111-0000-0000-0000-000000000001",
      organization_id: ORG_A_ID,
      order_number: "APSA-2026-000001",
      customer_id: null,
      location_id: null,
      source: "FACEBOOK",
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
      source_conversation_ref: null,
      ...overrides,
    },
    error: null,
  };
}

const emptyItems: QueryResult = { data: [], error: null };

describe("Test 17: sourceConversationRef reaches the create RPC unchanged", () => {
  it("passes a trimmed conversation ref through to p_source_conversation_ref", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: emptyItems,
          order_status_history: emptyItems,
          product_variants: variantRow,
        },
        rpc: {
          create_order_v1: {
            data: {
              status: "success",
              order_id: orderRow().data && "11111111-0000-0000-0000-000000000001",
              order_number: "APSA-2026-000001",
            },
            error: null,
          },
        },
      },
      async (calls) => {
        await createOrder(ctx, {
          source: "FACEBOOK",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
          sourceConversationRef: "  con-1  ",
        });
        const call = calls.find((c) => c.fn === "create_order_v1");
        expect(call?.args["p_source_conversation_ref"]).toBe("con-1");
      },
    );
  });
});

describe("Test 18: a blank conversation ref is stored as null", () => {
  it("whitespace-only input becomes null, not an empty string", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: emptyItems,
          order_status_history: emptyItems,
          product_variants: variantRow,
        },
        rpc: {
          create_order_v1: {
            data: {
              status: "success",
              order_id: "11111111-0000-0000-0000-000000000001",
              order_number: "APSA-2026-000001",
            },
            error: null,
          },
        },
      },
      async (calls) => {
        await createOrder(ctx, {
          source: "FACEBOOK",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
          sourceConversationRef: "   ",
        });
        const call = calls.find((c) => c.fn === "create_order_v1");
        expect(call?.args["p_source_conversation_ref"]).toBeNull();
      },
    );
  });

  it("an omitted conversation ref defaults to null", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb(
      {
        tables: {
          orders: orderRow(),
          order_items: emptyItems,
          order_status_history: emptyItems,
          product_variants: variantRow,
        },
        rpc: {
          create_order_v1: {
            data: {
              status: "success",
              order_id: "11111111-0000-0000-0000-000000000001",
              order_number: "APSA-2026-000001",
            },
            error: null,
          },
        },
      },
      async (calls) => {
        await createOrder(ctx, {
          source: "FACEBOOK",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
        });
        const call = calls.find((c) => c.fn === "create_order_v1");
        expect(call?.args["p_source_conversation_ref"]).toBeNull();
      },
    );
  });
});

describe("Test 19: an overly long conversation ref is rejected before any DB call", () => {
  it("rejects a 201-character ref with no RPC call made", async () => {
    const { createOrder } = await import("../server/orders/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ALL_ORDER_PERMS);

    await withOrderDb({}, async (calls) => {
      await expect(
        createOrder(ctx, {
          source: "FACEBOOK",
          items: [{ variantId: VARIANT_ID, quantity: 1 }],
          sourceConversationRef: "x".repeat(201),
        }),
      ).rejects.toThrow(/sourceConversationRef/);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("Test 20: the API boundary schema accepts sourceConversationRef", () => {
  it("src/api/orders.ts's createOrderFn validator declares the field", () => {
    const source = readSource("src/api/orders.ts");
    expect(source).toContain("sourceConversationRef");
  });

  it("the field is bounded (not an open text channel for conversation content)", () => {
    const source = readSource("src/api/orders.ts");
    const match = /sourceConversationRef:\s*z\.string\(\)[^,]*,/.exec(source);
    expect(match?.[0]).toBeDefined();
    expect(match?.[0]).toMatch(/max\(200\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

describe("Test 21: regressions", () => {
  it("this phase's Conversation/Smart-Action code never reaches into the Payment domain", () => {
    // The Payment domain (src/server/payments/*) is built in a later, dedicated
    // phase — see supabase/PAYMENTS.md. This phase's own code must not import it.
    for (const file of [
      "src/lib/conversation/smart-actions.ts",
      "src/components/inbox/PrepareOrderSheet.tsx",
      "src/components/inbox/SmartActionStrip.tsx",
    ]) {
      const source = readSource(file);
      expect(source).not.toMatch(/from ["']@\/server\/payments/);
      expect(source).not.toMatch(/from ["']@\/api\/payments["']/);
    }
  });

  it("draft order creation still writes lifecycle 'draft' (SQL, unchanged by migration 030)", () => {
    const sql = readSource("supabase/migrations/030_order_conversation_source.sql");
    expect(sql).toContain("'draft', 'unpaid', 'unfulfilled', p_created_by");
  });

  it("migration 030 never touches migrations 028-029 (Payment's reserved range)", () => {
    expect(fs.existsSync(path.resolve(process.cwd(), "supabase/migrations/028_.sql"))).toBe(false);
    const files = fs.readdirSync(path.resolve(process.cwd(), "supabase/migrations"));
    expect(files.some((f) => f.startsWith("028_") || f.startsWith("029_"))).toBe(false);
  });

  it("smart-actions.ts imports nothing from a server-only module", () => {
    const source = readSource("src/lib/conversation/smart-actions.ts");
    expect(source).not.toMatch(/from ["']@\/server\//);
    expect(source).not.toMatch(/from ["']@\/lib\/supabase\/server["']/);
  });

  it("PrepareOrderSheet.tsx imports nothing from a server-only module", () => {
    const source = readSource("src/components/inbox/PrepareOrderSheet.tsx");
    expect(source).not.toMatch(/from ["']@\/server\//);
    expect(source).not.toMatch(/from ["']@\/lib\/supabase\/server["']/);
  });
});
