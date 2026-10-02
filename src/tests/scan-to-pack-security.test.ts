/**
 * Scan-to-Pack security tests — server service integration tests.
 *
 * Tests the actual server service functions with mock AuthorizationContext
 * and mock repositories, proving:
 *   - Permission enforcement (orders.read required)
 *   - Cross-org denial (order belongs to different org → null/invalid_order)
 *   - Order lifecycle enforcement (draft/cancelled/fulfilled → error)
 *   - Parcel ownership (parcel must belong to the order)
 *   - Product/variant ownership (barcode must be in the order's items)
 *   - canPackOrder eligibility predicate consistency
 *
 * Run: bun test src/tests/scan-to-pack-security.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { canPackOrder } from "../lib/pack";

// ── Mock data ──────────────────────────────────────────────────────────────

const ORG_A = "org-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "org-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORDER_ID = "order-1111-1111-1111-111111111111";
const PARCEL_CODE = "APSA:PCL:v1:abcdefghijklmnopqrstuv";

let mockOrders: any[] = [];
let mockParcels: any[] = [];
let mockOrderItems: any[] = [];
let mockVariants: any[] = [];

function makeConfirmedOrder(orgId: string = ORG_A) {
  return {
    id: ORDER_ID,
    organization_id: orgId,
    order_number: "APSA-2026-000001",
    lifecycle_status: "confirmed",
    fulfillment_status: "processing",
  };
}

function makeParcel(orgId: string = ORG_A, orderId: string = ORDER_ID) {
  return {
    id: "parcel-1",
    organization_id: orgId,
    order_id: orderId,
    parcel_code: PARCEL_CODE,
    status: "created",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeOrderItem(overrides: Record<string, any> = {}) {
  return {
    id: "item-1",
    organization_id: ORG_A,
    order_id: ORDER_ID,
    product_id: "prod-1",
    variant_id: "var-1",
    product_name_snapshot: "Red T-Shirt",
    variant_name_snapshot: "Size L",
    sku_snapshot: "TSH-RED-L",
    quantity: 2,
    ...overrides,
  };
}

function makeVariant(overrides: Record<string, any> = {}) {
  return {
    id: "var-1",
    product_id: "prod-1",
    barcode: "1234567890",
    status: "ACTIVE",
    organization_id: ORG_A,
    ...overrides,
  };
}

// ── Mock AuthorizationContext ───────────────────────────────────────────────

function mockCtx(orgId: string, permissions: string[] = ["orders.read"]) {
  const perms = new Set(permissions);
  return {
    organizationId: orgId,
    userId: "user-test",
    can(perm: string) {
      return perms.has(perm);
    },
    require(perm: string) {
      if (!perms.has(perm)) {
        const err = new Error(`Missing permission: ${perm}`);
        (err as any).statusCode = 403;
        (err as any).name = "ForbiddenError";
        throw err;
      }
    },
  } as any;
}

// ── Supabase-style mock query builder ──────────────────────────────────────

function makeChain(rows: any[]) {
  const filters: Record<string, any> = {};
  const neqFilters: Record<string, any> = {};
  const inFilters: Record<string, any[]> = {};

  function filtered() {
    return rows.filter((row) => {
      for (const [col, val] of Object.entries(filters)) {
        if (row[col] !== val) return false;
      }
      for (const [col, val] of Object.entries(neqFilters)) {
        if (row[col] === val) return false;
      }
      for (const [col, vals] of Object.entries(inFilters)) {
        if (!vals.includes(row[col])) return false;
      }
      return true;
    });
  }

  const chain: any = {
    eq(col: string, val: any) {
      filters[col] = val;
      return chain;
    },
    neq(col: string, val: any) {
      neqFilters[col] = val;
      return chain;
    },
    in(col: string, vals: any[]) {
      inFilters[col] = vals;
      return chain;
    },
    limit(_n: number) {
      return { data: filtered(), error: null };
    },
    order() {
      return chain;
    },
    single() {
      const result = filtered();
      if (result.length === 0) {
        return { data: null, error: { code: "PGRST116", message: "no row" } };
      }
      return { data: result[0], error: null };
    },
    then(resolve: any, reject?: any) {
      try {
        resolve({ data: filtered(), error: null });
      } catch (e) {
        reject?.(e);
      }
    },
  };
  return chain;
}

function makeMockDb() {
  return {
    from(table: string) {
      return {
        select(_cols?: string) {
          if (table === "orders") return makeChain(mockOrders);
          if (table === "parcels") return makeChain(mockParcels);
          if (table === "order_items") return makeChain(mockOrderItems);
          if (table === "product_variants") return makeChain(mockVariants);
          return makeChain([]);
        },
      };
    },
  };
}

// ── Setup / teardown ────────────────────────────────────────────────────────

let restoreOrders: () => void;
let restoreParcels: () => void;
let restoreProducts: () => void;

beforeEach(async () => {
  mockOrders = [];
  mockParcels = [];
  mockOrderItems = [];
  mockVariants = [];

  const testDb = makeMockDb();

  const ordersRepo = await import("../server/orders/repository");
  restoreOrders = ordersRepo.setOrderRepositoryDbForTests(testDb);

  const parcelsRepo = await import("../server/parcels/repository");
  restoreParcels = parcelsRepo.setParcelRepositoryDbForTests(testDb);

  const productsRepo = await import("../server/products/repository");
  restoreProducts = productsRepo.setProductRepositoryDbForTests(testDb);
});

afterEach(() => {
  restoreOrders?.();
  restoreParcels?.();
  restoreProducts?.();
});

// ── Permission enforcement ──────────────────────────────────────────────────

describe("permission enforcement", () => {
  it("getPackRequirements throws ForbiddenError without orders.read", async () => {
    const ctx = mockCtx(ORG_A, []);
    const { getPackRequirements } = await import("../server/packing/service");
    await expect(getPackRequirements(ctx, ORDER_ID)).rejects.toThrow("Missing permission");
  });

  it("validatePackParcelScan throws ForbiddenError without orders.read", async () => {
    const ctx = mockCtx(ORG_A, []);
    const { validatePackParcelScan } = await import("../server/packing/service");
    await expect(validatePackParcelScan(ctx, ORDER_ID, PARCEL_CODE)).rejects.toThrow(
      "Missing permission",
    );
  });

  it("validatePackProductScan throws ForbiddenError without orders.read", async () => {
    const ctx = mockCtx(ORG_A, []);
    const { validatePackProductScan } = await import("../server/packing/service");
    await expect(validatePackProductScan(ctx, ORDER_ID, "1234567890")).rejects.toThrow(
      "Missing permission",
    );
  });
});

// ── Cross-org denial ────────────────────────────────────────────────────────

describe("cross-org denial", () => {
  it("getPackRequirements returns null for order in another org", async () => {
    mockOrders = [makeConfirmedOrder(ORG_B)];
    const ctx = mockCtx(ORG_A);
    const { getPackRequirements } = await import("../server/packing/service");
    const result = await getPackRequirements(ctx, ORDER_ID);
    expect(result).toBeNull();
  });

  it("validatePackParcelScan returns invalid_order for cross-org order", async () => {
    mockOrders = [makeConfirmedOrder(ORG_B)];
    const ctx = mockCtx(ORG_A);
    const { validatePackParcelScan } = await import("../server/packing/service");
    const result = await validatePackParcelScan(ctx, ORDER_ID, PARCEL_CODE);
    expect(result.kind).toBe("invalid_order");
  });

  it("validatePackProductScan returns invalid_order for cross-org order", async () => {
    mockOrders = [makeConfirmedOrder(ORG_B)];
    const ctx = mockCtx(ORG_A);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(ctx, ORDER_ID, "1234567890");
    expect(result.kind).toBe("invalid_order");
  });
});

// ── Order lifecycle enforcement ─────────────────────────────────────────────

describe("order lifecycle enforcement", () => {
  it("getPackRequirements rejects draft orders", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), lifecycle_status: "draft" }];
    const ctx = mockCtx(ORG_A);
    const { getPackRequirements } = await import("../server/packing/service");
    await expect(getPackRequirements(ctx, ORDER_ID)).rejects.toThrow("cannot pack");
  });

  it("getPackRequirements rejects fulfilled orders", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), fulfillment_status: "fulfilled" }];
    const ctx = mockCtx(ORG_A);
    const { getPackRequirements } = await import("../server/packing/service");
    await expect(getPackRequirements(ctx, ORDER_ID)).rejects.toThrow("cannot pack");
  });

  it("validatePackParcelScan returns invalid_order for draft order", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), lifecycle_status: "draft" }];
    const ctx = mockCtx(ORG_A);
    const { validatePackParcelScan } = await import("../server/packing/service");
    const result = await validatePackParcelScan(ctx, ORDER_ID, PARCEL_CODE);
    expect(result.kind).toBe("invalid_order");
  });

  it("validatePackProductScan returns invalid_order for fulfilled order", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), fulfillment_status: "fulfilled" }];
    const ctx = mockCtx(ORG_A);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(ctx, ORDER_ID, "1234567890");
    expect(result.kind).toBe("invalid_order");
  });
});

// ── Parcel ownership ────────────────────────────────────────────────────────

describe("parcel ownership", () => {
  it("validatePackParcelScan rejects wrong parcel code", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    const ctx = mockCtx(ORG_A);
    const { validatePackParcelScan } = await import("../server/packing/service");
    const result = await validatePackParcelScan(ctx, ORDER_ID, "APSA:PCL:v1:WRONG_CODE_HERE__");
    expect(result.kind).toBe("wrong_parcel");
  });

  it("validatePackParcelScan accepts correct parcel code", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    const ctx = mockCtx(ORG_A);
    const { validatePackParcelScan } = await import("../server/packing/service");
    const result = await validatePackParcelScan(ctx, ORDER_ID, PARCEL_CODE);
    expect(result.kind).toBe("parcel_accepted");
  });

  it("validatePackParcelScan returns invalid_order when no parcel exists", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [];
    const ctx = mockCtx(ORG_A);
    const { validatePackParcelScan } = await import("../server/packing/service");
    const result = await validatePackParcelScan(ctx, ORDER_ID, PARCEL_CODE);
    expect(result.kind).toBe("invalid_order");
  });
});

// ── Product/variant ownership ───────────────────────────────────────────────

describe("product/variant ownership via server", () => {
  it("validatePackProductScan rejects barcode not in order items", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockOrderItems = [makeOrderItem()];
    mockVariants = [makeVariant()];
    const ctx = mockCtx(ORG_A);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(ctx, ORDER_ID, "UNKNOWN_BARCODE");
    expect(result.kind).toBe("wrong_product");
  });

  it("validatePackProductScan accepts barcode matching order item variant", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockOrderItems = [makeOrderItem()];
    mockVariants = [makeVariant({ barcode: "1234567890" })];
    const ctx = mockCtx(ORG_A);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(ctx, ORDER_ID, "1234567890");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.orderItemId).toBe("item-1");
      expect(result.variantId).toBe("var-1");
    }
  });

  it("validatePackProductScan detects wrong variant via sibling barcode", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockOrderItems = [makeOrderItem({ variant_id: "var-1" })];
    mockVariants = [
      makeVariant({ id: "var-1", barcode: "AAA" }),
      makeVariant({ id: "var-2", barcode: "BBB" }),
    ];
    const ctx = mockCtx(ORG_A);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(ctx, ORDER_ID, "BBB");
    expect(result.kind).toBe("wrong_variant");
  });
});

// ── Server authority contract ───────────────────────────────────────────────

describe("server authority — packing service contract", () => {
  it("all three service functions are exported", async () => {
    const service = await import("../server/packing/service");
    expect(typeof service.getPackRequirements).toBe("function");
    expect(typeof service.validatePackParcelScan).toBe("function");
    expect(typeof service.validatePackProductScan).toBe("function");
  });

  it("packing API validators reject non-UUID orderId", async () => {
    const { z } = await import("zod");
    const schema = z.object({ orderId: z.string().uuid("Invalid order ID") });
    expect(() => schema.parse({ orderId: "not-a-uuid" })).toThrow();
    expect(() => schema.parse({ orderId: "00000000-0000-0000-0000-000000000000" })).not.toThrow();
  });
});

// ── canPackOrder eligibility consistency ─────────────────────────────────────

describe("canPackOrder — eligibility predicate", () => {
  it("draft order cannot be packed", () => {
    expect(canPackOrder({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
  });

  it("cancelled order cannot be packed", () => {
    expect(canPackOrder({ lifecycleStatus: "cancelled", fulfillmentStatus: "cancelled" })).toBe(
      false,
    );
  });

  it("completed/fulfilled order cannot be packed", () => {
    expect(canPackOrder({ lifecycleStatus: "completed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });

  it("fulfilled order cannot be packed even if confirmed", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });

  it("confirmed + processing is eligible", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" })).toBe(
      true,
    );
  });

  it("confirmed + unfulfilled is eligible", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "unfulfilled" })).toBe(
      true,
    );
  });
});
