import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { summarizeHome } from "../server/home/service";
import type { HomeRows } from "../server/home/types";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";

function rows(): HomeRows {
  return {
    periodOrders: [
      {
        id: "order-paid-refunded-partially",
        organization_id: ORG_A,
        total_minor: 10000,
        currency: "USD",
        lifecycle_status: "confirmed",
        payment_status: "paid",
        refund_status: "partial",
        fulfillment_status: "processing",
        created_at: "2026-09-10T03:00:00.000Z",
      },
      {
        id: "order-pending",
        organization_id: ORG_A,
        total_minor: 20000,
        currency: "KHR",
        lifecycle_status: "draft",
        payment_status: "pending",
        refund_status: "none",
        fulfillment_status: "unfulfilled",
        created_at: "2026-09-10T03:00:00.000Z",
      },
    ],
    activeOrders: [
      {
        id: "order-paid-refunded-partially",
        organization_id: ORG_A,
        total_minor: 10000,
        currency: "USD",
        lifecycle_status: "confirmed",
        payment_status: "paid",
        refund_status: "partial",
        fulfillment_status: "processing",
        created_at: "2026-09-10T03:00:00.000Z",
      },
      {
        id: "order-pending",
        organization_id: ORG_A,
        total_minor: 20000,
        currency: "KHR",
        lifecycle_status: "draft",
        payment_status: "pending",
        refund_status: "none",
        fulfillment_status: "unfulfilled",
        created_at: "2026-09-10T03:00:00.000Z",
      },
    ],
    // This value is the existing Payment-ledger-derived net settlement. The
    // refund changes net money, never the paid order's status.
    settlements: [
      {
        order_id: "order-paid-refunded-partially",
        organization_id: ORG_A,
        currency: "USD",
        net_minor: 8000,
      },
      { order_id: "order-pending", organization_id: ORG_A, currency: "KHR", net_minor: 0 },
    ],
    stock: [
      {
        organization_id: ORG_A,
        product_id: "product-a",
        variant_id: "variant-a",
        quantity_on_hand: 0,
      },
      {
        organization_id: ORG_A,
        product_id: "product-b",
        variant_id: "variant-b",
        quantity_on_hand: 8,
      },
    ],
    deliveries: [
      {
        id: "delivery-ready",
        organization_id: ORG_A,
        order_id: "order-paid-refunded-partially",
        status: "ready",
      },
      {
        id: "delivery-transit",
        organization_id: ORG_A,
        order_id: "order-pending",
        status: "in_transit",
      },
    ],
  };
}

describe("Home command-center summary", () => {
  it("keeps currencies separate and does not turn a refunded paid order into payment work", () => {
    const summary = summarizeHome(rows(), { financials: true, inventory: true, delivery: true });
    expect(summary.revenues).toEqual([
      { currency: "KHR", amount: 0 },
      { currency: "USD", amount: 8000 },
    ]);
    expect(summary.attention.find((item) => item.id === "awaiting_payment")?.count).toBe(1);
    expect(summary.metrics.find((metric) => metric.id === "orders")?.value).toBe("2");
  });

  it("reports only live non-positive ledger stock and actionable delivery states", () => {
    const summary = summarizeHome(rows(), { financials: true, inventory: true, delivery: true });
    expect(summary.attention.find((item) => item.id === "low_stock")?.count).toBe(1);
    expect(summary.attention.find((item) => item.id === "awaiting_delivery")?.count).toBe(1);
  });

  it("returns a truthful partial response when financial, inventory, or delivery permission is absent", () => {
    const summary = summarizeHome(rows(), { financials: false, inventory: false, delivery: false });
    expect(summary.financialsAvailable).toBe(false);
    expect(summary.revenues).toEqual([]);
    expect(summary.attention.map((item) => item.id)).toEqual([
      "awaiting_payment",
      "orders_needing_action",
    ]);
  });

  it("keeps every Home source query explicitly scoped to the authenticated organization", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/server/home/repository.ts"),
      "utf8",
    );
    expect(
      source.match(/\.eq\("organization_id", organizationId\)/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain(ORG_B);
  });

  it("does not include a client-provided organization ID in the Home API contract", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/api/home.ts"), "utf8");
    expect(source).toContain('.select("organization_id")');
    expect(source).toContain("AuthorizationService.forRequest");
    expect(source).not.toMatch(/z\.object\(\{[^}]*organizationId/s);
  });
});
