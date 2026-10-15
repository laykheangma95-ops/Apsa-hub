/**
 * Client idempotency-key lifecycle through the REAL createRealOrder()
 * (src/lib/api/index.ts), with only the server function stubbed so the test
 * can see exactly which key each attempt sends. The server-side guarantees are
 * proven against real SQL in order-money-stock-safety.runtime.ts.
 */
import { describe, expect, it, mock } from "bun:test";

const sent: Array<Record<string, unknown>> = [];
let failNext = 0;

function serverDetail(id: string) {
  const money = (amount: number) => ({ amount, currency: "USD" });
  return {
    id,
    organizationId: "org",
    orderNumber: "APSA-2026-000001",
    customerId: null,
    locationId: null,
    source: "POS",
    currency: "USD",
    subtotal: money(1500),
    discount: money(0),
    delivery: money(250),
    total: money(1750),
    lifecycleStatus: "draft",
    paymentStatus: "unpaid",
    refundStatus: "none",
    fulfillmentStatus: "unfulfilled",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sourceConversationRef: null,
    items: [],
    statusHistory: [],
  };
}

mock.module("../api/orders", () => ({
  createOrderFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push(data);
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("network failure");
    }
    return serverDetail(crypto.randomUUID());
  },
}));

const { createRealOrder } = await import("../lib/api");
const { createIdempotencyKeyHolder } = await import("../lib/idempotency");
const { parseDeliveryFee, codDiffersFromTotal, DELIVERY_FEE_MAX_MINOR } =
  await import("../lib/delivery-fee");

const request = () => ({
  principal: {
    userId: "aaaaaaaa-0000-4000-8000-000000000002",
    organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
  },
  source: "POS" as const,
  items: [{ variantId: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
  customerId: null,
  deliveryMinor: 250,
});

describe("createRealOrder idempotency-key lifecycle", () => {
  it("a failed attempt keeps its key; the retry re-sends the same key; the next order gets a new one", async () => {
    sent.length = 0;
    const keys = createIdempotencyKeyHolder();
    failNext = 1;
    await expect(createRealOrder({ ...request(), idempotency: keys })).rejects.toThrow("network");
    const detail = await createRealOrder({ ...request(), idempotency: keys });
    expect(detail.order.deliveryFee).toEqual({ amount: 250, currency: "USD" });
    // Same basket again, after success: a genuinely new order.
    await createRealOrder({ ...request(), idempotency: keys });

    const [failed, retried, next] = sent.map((d) => d.idempotencyKey as string);
    expect(failed).toMatch(/^[0-9a-f-]{36}$/);
    expect(retried).toBe(failed);
    expect(next).not.toBe(failed);
  });

  it("changing the request after a failure issues a fresh key (a different request is a different order)", async () => {
    sent.length = 0;
    const keys = createIdempotencyKeyHolder();
    failNext = 1;
    await expect(createRealOrder({ ...request(), idempotency: keys })).rejects.toThrow();
    await createRealOrder({ ...request(), deliveryMinor: 300, idempotency: keys });
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  });

  it("never sends the holder itself, and never sends a price or total", async () => {
    sent.length = 0;
    await createRealOrder({ ...request(), idempotency: createIdempotencyKeyHolder() });
    expect(Object.keys(sent[0]!).sort()).toEqual(
      // expectedPrincipal: the required, refuse-only precondition (CORRECTION-004).
      [
        "customerId",
        "deliveryMinor",
        "expectedPrincipal",
        "idempotencyKey",
        "items",
        "source",
      ].sort(),
    );
  });

  it("separate flows hold separate keys", async () => {
    sent.length = 0;
    await createRealOrder({ ...request(), idempotency: createIdempotencyKeyHolder() });
    await createRealOrder({ ...request(), idempotency: createIdempotencyKeyHolder() });
    expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
  });
});

describe("delivery fee parsing is integer-only and bounded", () => {
  it("parses with integer arithmetic, defaults empty to 0, rejects junk and out-of-range", () => {
    expect(parseDeliveryFee("", "USD")).toBe(0);
    expect(parseDeliveryFee("1.5", "USD")).toBe(150);
    expect(parseDeliveryFee("19.99", "USD")).toBe(1999); // 19.99*100 is 1998.999… as a float
    expect(parseDeliveryFee("0.07", "USD")).toBe(7);
    expect(parseDeliveryFee("1,000", "USD")).toBe(100000);
    expect(parseDeliveryFee("1000.01", "USD")).toBeNull();
    expect(parseDeliveryFee("-1", "USD")).toBeNull();
    expect(parseDeliveryFee("1.234", "USD")).toBeNull();
    expect(parseDeliveryFee("abc", "USD")).toBeNull();
    expect(parseDeliveryFee("5000", "KHR")).toBe(5000);
    expect(parseDeliveryFee("50.5", "KHR")).toBeNull();
    expect(parseDeliveryFee(String(DELIVERY_FEE_MAX_MINOR.KHR + 1), "KHR")).toBeNull();
  });

  it("names a COD amount that is not the order total", () => {
    const usd = (amount: number) => ({ amount, currency: "USD" as const });
    expect(codDiffersFromTotal(usd(1200), usd(1000))).toBe(true);
    expect(codDiffersFromTotal(usd(1000), usd(1000))).toBe(false);
    expect(codDiffersFromTotal({ amount: 1000, currency: "KHR" }, usd(1000))).toBe(true);
  });
});
