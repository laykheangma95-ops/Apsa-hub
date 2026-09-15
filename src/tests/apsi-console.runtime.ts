/**
 * Apsi FIND-layer behaviour, against a stand-in domain layer.
 *
 * Spawned as its own bun process by apsi-console.test.ts: it replaces
 * `@/lib/api` and `@/lib/inventory` with recording doubles, which must not
 * leak into the shared module cache of the rest of the suite.
 *
 * The doubles behave the way the real boundary behaves, and that is the point
 * of the whole file: they record every call, so a test can assert that a
 * request for data the member may not see was NEVER ISSUED — not merely that
 * its result was hidden afterwards.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { UiPermissionKey } from "@/lib/capabilities";

const calls: string[] = [];

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERY_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const VARIANT_ID = "55555555-5555-4555-8555-555555555555";

const usd = (minor: number) => ({ amountMinor: minor, currency: "USD" as const });

mock.module("@/lib/api", () => ({
  getRealOrderDetail: async (id: string) => {
    calls.push(`order:${id}`);
    if (id !== ORDER_ID) throw new Error("not found");
    return {
      order: {
        id: ORDER_ID,
        code: "APSA-1042",
        total: usd(1980),
        lifecycleStatus: "confirmed",
        paymentStatus: "pending_payment",
        fulfillmentStatus: "packing",
      },
      items: [],
    };
  },
  getRealPaymentDetail: async (id: string) => {
    calls.push(`payment:${id}`);
    if (id !== PAYMENT_ID) throw new Error("not found");
    return {
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: usd(1980),
      status: "pending",
      verificationState: "unverified",
    };
  },
  getRealDeliveryDetail: async (id: string) => {
    calls.push(`delivery:${id}`);
    if (id !== DELIVERY_ID) throw new Error("not found");
    return {
      id: DELIVERY_ID,
      orderId: ORDER_ID,
      status: "in_transit",
      providerName: "J&T",
      externalTrackingNumber: "JT-9001",
    };
  },
  getCustomer360: async (id: string) => {
    calls.push(`customer:${id}`);
    if (id !== CUSTOMER_ID) throw new Error("not found");
    return {
      customer: {
        id: CUSTOMER_ID,
        nameKm: "សុខា",
        nameEn: "Sokha",
        // What the SERVER sends a caller without customers.view_sensitive.
        phone: "",
        sensitiveVisible: false,
        orderCount: 9,
        lastPurchaseAt: "2026-09-01T00:00:00.000Z",
      },
      orders: [],
      events: [],
      notes: [],
      activeConversationId: null,
    };
  },
  lookupProductByBarcode: async (barcode: string) => {
    calls.push(`barcode:${barcode}`);
    if (barcode !== "8850007123456") return null;
    return {
      id: "prod-1",
      variantId: VARIANT_ID,
      nameKm: "កូកា ៣៣០ម.ល",
      nameEn: "Coca-Cola 330ml",
      sku: "SKU-COKE-330",
      barcode: "8850007123456",
      price: usd(75),
      stock: null,
    };
  },
  lookupProductBySku: async (sku: string) => {
    calls.push(`sku:${sku}`);
    return null;
  },
  listRealDeliveries: async (options: { search?: string }) => {
    calls.push(`delivery-search:${options.search}`);
    return {
      items: [
        {
          id: DELIVERY_ID,
          orderId: ORDER_ID,
          orderCode: "APSA-1042",
          status: "in_transit",
          providerName: "J&T",
          externalTrackingNumber: "JT-9001",
          customerName: "Sokha",
        },
      ],
      hasMore: false,
      truncated: false,
    };
  },
}));

mock.module("@/lib/inventory", () => ({
  getVariantStock: async (variantId: string) => {
    calls.push(`stock:${variantId}`);
    return { variantId, productId: "prod-1", quantityOnHand: 14, byLocation: [] };
  },
}));

const { classifyApsiQuery } = await import("@/lib/apsi/input");
const { planApsiLookup, runApsiLookup, APSI_PROBE_PERMISSION } = await import("@/lib/apsi/lookup");

function grantsFor(keys: readonly UiPermissionKey[]) {
  const set = new Set<string>(keys);
  return { can: (key: UiPermissionKey) => set.has(key) };
}

const ALL: readonly UiPermissionKey[] = [
  "orders.read",
  "payments.read",
  "delivery.read",
  "customers.read",
  "products.read",
  "inventory.read",
];

afterEach(() => {
  calls.length = 0;
});

describe("Apsi FIND — deterministic lookup", () => {
  it("routes a pasted order id straight to the Order domain", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(ORDER_ID), grantsFor(ALL));

    const order = outcome.results.find((r) => r.kind === "order");
    expect(order).toBeDefined();
    expect(order).toMatchObject({ id: ORDER_ID, code: "APSA-1042" });
    expect(calls).toContain(`order:${ORDER_ID}`);
  });

  it("finds a delivery by tracking number through the real server-side search", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor(ALL));

    expect(calls).toContain("delivery-search:JT-9001");
    expect(outcome.results.some((r) => r.kind === "delivery" && r.id === DELIVERY_ID)).toBe(true);
  });

  it("looks a barcode up exactly, and asks Inventory for the balance separately", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("8850007123456"), grantsFor(ALL));

    const product = outcome.results.find((r) => r.kind === "product");
    expect(product).toMatchObject({ sku: "SKU-COKE-330", stock: 14 });
    expect(calls).toContain("barcode:8850007123456");
    expect(calls).toContain(`stock:${VARIANT_ID}`);
  });

  it("never asks Inventory for stock without inventory.read, and never guesses it", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery("8850007123456"),
      grantsFor(["products.read"]),
    );

    const product = outcome.results.find((r) => r.kind === "product");
    // null is "not checked", never 0. A guessed zero would read as out of stock.
    expect(product).toMatchObject({ stock: null });
    expect(calls.some((call) => call.startsWith("stock:"))).toBe(false);
  });

  it("reports a failed probe as a failure, never as 'nothing found'", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const outcome = await runApsiLookup(classifyApsiQuery(missing), grantsFor(ALL));

    expect(outcome.results).toEqual([]);
    expect(outcome.failed.length).toBeGreaterThan(0);
  });

  it("returns one card when a barcode and a SKU probe resolve to the same product", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("8850007123456"), grantsFor(ALL));
    const products = outcome.results.filter((r) => r.kind === "product");
    expect(products).toHaveLength(1);
  });
});

describe("Apsi permission model — withheld before the request, not after", () => {
  it("never issues a Payment read for a member without payments.read", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(PAYMENT_ID), grantsFor(["orders.read"]));

    expect(calls.some((call) => call.startsWith("payment:"))).toBe(false);
    expect(outcome.results.some((r) => r.kind === "payment")).toBe(false);
    expect(outcome.skipped.map((s) => s.permission)).toContain("payments.read");
  });

  it("never issues a Customer read for a member without customers.read", async () => {
    await runApsiLookup(classifyApsiQuery(CUSTOMER_ID), grantsFor(["orders.read"]));

    expect(calls.some((call) => call.startsWith("customer:"))).toBe(false);
  });

  it("never issues a Delivery read or search for a member without delivery.read", async () => {
    await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor(["products.read"]));

    expect(calls.some((call) => call.startsWith("delivery"))).toBe(false);
  });

  it("never issues an Order read for a member without orders.read", async () => {
    await runApsiLookup(classifyApsiQuery(ORDER_ID), grantsFor(["payments.read"]));

    expect(calls.some((call) => call.startsWith("order:"))).toBe(false);
  });

  it("passes the server's withheld customer phone through untouched", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery(CUSTOMER_ID),
      grantsFor(["customers.read"]),
    );

    const customer = outcome.results.find((r) => r.kind === "customer");
    expect(customer).toMatchObject({ phone: "", sensitiveVisible: false });
  });

  it("issues nothing at all for a member with no supported access", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor([]));

    expect(calls).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped.length).toBeGreaterThan(0);
  });

  it("declares a permission for every probe the classifier can emit", () => {
    const plan = classifyApsiQuery(ORDER_ID);
    const freeText = classifyApsiQuery("APSA-1042");
    for (const probe of [...plan.probes, ...freeText.probes]) {
      expect(APSI_PROBE_PERMISSION[probe.kind]).toBeTruthy();
    }
    expect(planApsiLookup(plan, grantsFor([])).runnable).toEqual([]);
  });
});
