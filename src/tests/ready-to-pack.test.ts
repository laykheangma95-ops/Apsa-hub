/**
 * Ready-to-Pack queue + parcel label — eligibility predicate and service.
 *
 * Behavioural: the pure predicate is asserted across the axis matrix, and the
 * service is driven against a mocked db to prove a confirmed/unfulfilled order
 * appears, cancelled/completed/draft do not, PAID vs COD is derived from the
 * order's own payment_status, and the parcel label carries only fulfillment PII
 * gated on customers.view_sensitive.
 *
 * Run: bun test src/tests/ready-to-pack.test.ts
 */
import { describe, it, expect } from "bun:test";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import {
  isReadyToPackEligible,
  ORDER_LIFECYCLE_STATUSES,
  ORDER_FULFILLMENT_STATUSES,
} from "../server/orders/state-machine";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";
const CUSTOMER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeCtx(permissions: string[]): AuthorizationContext {
  const perms = new Set(permissions);
  return {
    userId: "user-1",
    organizationId: ORG_A,
    roleId: "role",
    systemRole: "MANAGER",
    permissions: perms,
    can: (k: string) => perms.has(k),
    require: (k: string) => {
      if (!perms.has(k)) throw new ForbiddenError(`Missing permission: ${k}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("owner");
    },
  } as unknown as AuthorizationContext;
}

describe("isReadyToPackEligible (pure)", () => {
  it("is true only for confirmed + unfulfilled", () => {
    for (const lifecycleStatus of ORDER_LIFECYCLE_STATUSES) {
      for (const fulfillmentStatus of ORDER_FULFILLMENT_STATUSES) {
        const expected = lifecycleStatus === "confirmed" && fulfillmentStatus === "unfulfilled";
        expect(isReadyToPackEligible({ lifecycleStatus, fulfillmentStatus })).toBe(expected);
      }
    }
  });

  it("excludes cancelled, completed, and already-processing orders", () => {
    expect(isReadyToPackEligible({ lifecycleStatus: "cancelled", fulfillmentStatus: "unfulfilled" })).toBe(false);
    expect(isReadyToPackEligible({ lifecycleStatus: "completed", fulfillmentStatus: "unfulfilled" })).toBe(false);
    expect(isReadyToPackEligible({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" })).toBe(false);
    expect(isReadyToPackEligible({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(false);
  });
});

// ── Service (mocked db) ─────────────────────────────────────────────────────────

interface Tables {
  orders?: unknown;
  order_items?: unknown;
  customers?: unknown;
  customer_addresses?: unknown;
  organizations?: unknown;
  deliveries?: unknown;
}

/**
 * Minimal fake supabase builder keyed by table name; each terminal (await,
 * .single(), .maybeSingle()) yields that table's canned {data,error}.
 */
function makeDb(tables: Tables) {
  const result = (table: string) => {
    const data = (tables as Record<string, unknown>)[table] ?? null;
    return { data, error: data === null ? { code: "PGRST116", message: "no rows" } : null };
  };
  return {
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        single: async () => result(table),
        maybeSingle: async () => result(table),
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve(result(table)).then(resolve, reject),
      };
      return q;
    },
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    organization_id: ORG_A,
    order_number: "APSA-2026-001048",
    customer_id: CUSTOMER_ID,
    location_id: null,
    source: "FACEBOOK",
    currency: "KHR",
    subtotal_minor: 75000,
    discount_minor: 0,
    delivery_minor: 0,
    total_minor: 75000,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    refund_status: "none",
    fulfillment_status: "unfulfilled",
    created_by: "user-1",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    source_conversation_ref: null,
    ...overrides,
  };
}

async function withDb<T>(tables: Tables, fn: () => Promise<T>): Promise<T> {
  const orders = await import("../server/orders/repository");
  const fulfil = await import("../server/fulfillment/repository");
  const restoreOrders = orders.setOrderRepositoryDbForTests(makeDb(tables));
  const restoreFulfil = fulfil.setFulfillmentRepositoryDbForTests(makeDb(tables));
  try {
    return await fn();
  } finally {
    restoreFulfil();
    restoreOrders();
  }
}

describe("listReadyToPack", () => {
  it("returns a confirmed/unfulfilled order as a COD collect row", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow()],
        order_items: [{ order_id: ORDER_ID, quantity: 3 }],
        customers: [{ id: CUSTOMER_ID, display_name: "Sokha" }],
        deliveries: [],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderNumber).toBe("APSA-2026-001048");
    expect(rows[0]!.customerName).toBe("Sokha");
    expect(rows[0]!.itemCount).toBe(3);
    expect(rows[0]!.paid).toBe(false);
    expect(rows[0]!.collect).toEqual({ amount: 75000, currency: "KHR" });
  });

  it("shows PAID (collect 0) when the order's payment_status is paid", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow({ payment_status: "paid" })],
        order_items: [{ order_id: ORDER_ID, quantity: 1 }],
        customers: [{ id: CUSTOMER_ID, display_name: "Sokha" }],
        deliveries: [],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows[0]!.paid).toBe(true);
    expect(rows[0]!.collect).toEqual({ amount: 0, currency: "KHR" });
  });

  it("excludes an order the DB somehow returned that is not eligible", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow({ fulfillment_status: "fulfilled" }), orderRow({ lifecycle_status: "cancelled" })],
        order_items: [],
        customers: [],
        deliveries: [],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows).toHaveLength(0);
  });

  it("requires orders.read", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    await withDb({ orders: [] }, async () => {
      await expect(listReadyToPack(makeCtx([]))).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe("getParcelLabelData", () => {
  it("requires customers.view_sensitive on top of orders.read", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    await withDb({ orders: orderRow() }, async () => {
      await expect(
        getParcelLabelData(makeCtx(["orders.read"]), ORDER_ID),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("assembles authoritative COD data with only fulfillment PII", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow(),
        order_items: [
          {
            id: "l1",
            order_id: ORDER_ID,
            product_id: "p1",
            variant_id: "v1",
            product_name_snapshot: "Classic Tee",
            variant_name_snapshot: "Black / M",
            sku_snapshot: "TEE-BM",
            unit_price_minor: 25000,
            quantity: 2,
            line_total_minor: 50000,
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [
          { house_no: "12", street: "St 240", sangkat: "Boeng Keng Kang", khan: "Chamkarmon", city: "Phnom Penh", province: null, country: "KH", landmark: null, is_default: true },
        ],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
      },
      () => getParcelLabelData(makeCtx(["orders.read", "customers.view_sensitive"]), ORDER_ID),
    );
    expect(data.merchant.businessName).toBe("Dara Shop");
    expect(data.customer.name).toBe("Sokha");
    expect(data.customer.phone).toBe("012345678");
    expect(data.customer.address).toContain("Boeng Keng Kang");
    expect(data.order.itemCount).toBe(2);
    expect(data.payment.paid).toBe(false);
    expect(data.payment.collect).toEqual({ amount: 75000, currency: "KHR" });
    // No PII beyond name/phone/address — the shape has no email/notes fields at all.
    expect(Object.keys(data.customer).sort()).toEqual(["address", "name", "phone"]);
  });

  it("shows PAID with nothing to collect for a paid order", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow({ payment_status: "paid" }),
        order_items: [],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
      },
      () => getParcelLabelData(makeCtx(["orders.read", "customers.view_sensitive"]), ORDER_ID),
    );
    expect(data.payment.paid).toBe(true);
    expect(data.payment.collect).toBeNull();
  });

  it("refuses a draft order (no committed sale to ship)", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    await withDb({ orders: orderRow({ lifecycle_status: "draft" }) }, async () => {
      await expect(
        getParcelLabelData(makeCtx(["orders.read", "customers.view_sensitive"]), ORDER_ID),
      ).rejects.toThrow(/confirmed order/i);
    });
  });
});
