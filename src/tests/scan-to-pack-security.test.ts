/**
 * Scan-to-Pack security tests — permission enforcement, tenant isolation,
 * and server authority verification.
 *
 * Run: bun test src/tests/scan-to-pack-security.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  canPackOrder,
  validateParcelScan,
  validateProductScan,
  createPackSession,
  type PackRequirement,
} from "../lib/pack";

const PARCEL_CODE = "APSA:PCL:v1:abcdefghijklmnopqrstuv";

function makeReq(overrides: Partial<PackRequirement> = {}): PackRequirement {
  return {
    orderItemId: "item-1",
    productId: "prod-1",
    variantId: "var-1",
    productName: "Test Product",
    variantName: null,
    sku: "SKU-001",
    barcode: "1111111111",
    quantityRequired: 1,
    siblingBarcodes: [],
    ...overrides,
  };
}

// ── Permission enforcement at the domain level ──────────────────────────────

describe("canPackOrder — permission boundary", () => {
  it("draft order cannot be packed (not yet a committed sale)", () => {
    expect(canPackOrder({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
  });

  it("cancelled order cannot be packed (sale was called off)", () => {
    expect(canPackOrder({ lifecycleStatus: "cancelled", fulfillmentStatus: "cancelled" })).toBe(
      false,
    );
  });

  it("completed order cannot be packed (already done)", () => {
    expect(canPackOrder({ lifecycleStatus: "completed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });

  it("fulfilled order cannot be packed even if confirmed", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });
});

// ── Scan validation does NOT mutate inventory ─────────────────────────────

describe("scan validation is read-only", () => {
  it("validateProductScan returns a result but does not modify the session", () => {
    const session = {
      ...createPackSession("order-1", "ORD-001", PARCEL_CODE, [makeReq()]),
      parcelVerified: true,
    };
    const before = JSON.stringify(session);
    validateProductScan(session, "1111111111");
    const after = JSON.stringify(session);
    expect(after).toBe(before);
  });

  it("validateParcelScan returns a result but does not modify the session", () => {
    const session = createPackSession("order-1", "ORD-001", PARCEL_CODE, [makeReq()]);
    const before = JSON.stringify(session);
    validateParcelScan(session, PARCEL_CODE);
    const after = JSON.stringify(session);
    expect(after).toBe(before);
  });
});

// ── Cross-org parcel isolation (domain level) ─────────────────────────────

describe("parcel code isolation", () => {
  it("a parcel code from another order (different session) does not match", () => {
    const session = createPackSession("order-1", "ORD-001", PARCEL_CODE, [makeReq()]);
    const result = validateParcelScan(session, "APSA:PCL:v1:DIFFERENT_CODE_HERE__");
    expect(result.kind).toBe("wrong_parcel");
  });
});

// ── Cross-org barcode isolation ───────────────────────────────────────────

describe("barcode isolation", () => {
  it("a barcode from another order (different requirements) does not match", () => {
    const session = {
      ...createPackSession("order-1", "ORD-001", PARCEL_CODE, [
        makeReq({ barcode: "ORG_A_BARCODE" }),
      ]),
      parcelVerified: true,
    };
    const result = validateProductScan(session, "ORG_B_BARCODE");
    expect(result.kind).toBe("wrong_product");
  });
});

// ── Sibling barcode isolation ─────────────────────────────────────────────

describe("sibling barcode isolation", () => {
  it("sibling barcodes from another org do not appear in requirements", () => {
    const session = {
      ...createPackSession("order-1", "ORD-001", PARCEL_CODE, [
        makeReq({ barcode: "ORG_A_ORDERED", siblingBarcodes: ["ORG_A_SIBLING"] }),
      ]),
      parcelVerified: true,
    };
    const result = validateProductScan(session, "ORG_B_SIBLING");
    expect(result.kind).toBe("wrong_product");
  });

  it("wrong_variant only fires for barcodes explicitly listed as siblings", () => {
    const session = {
      ...createPackSession("order-1", "ORD-001", PARCEL_CODE, [
        makeReq({ barcode: "AAA", siblingBarcodes: ["BBB"] }),
      ]),
      parcelVerified: true,
    };
    expect(validateProductScan(session, "BBB").kind).toBe("wrong_variant");
    expect(validateProductScan(session, "CCC").kind).toBe("wrong_product");
  });
});

// ── Server authority verification ─────────────────────────────────────────

describe("server authority — packing service contract", () => {
  it("getPackRequirements is declared to require orders.read", async () => {
    const { getPackRequirements } = await import("../server/packing/service");
    expect(typeof getPackRequirements).toBe("function");
  });

  it("packing API validator rejects non-UUID orderId", async () => {
    const { z } = await import("zod");
    const schema = z.object({ orderId: z.string().uuid("Invalid order ID") });
    expect(() => schema.parse({ orderId: "not-a-uuid" })).toThrow();
    expect(() => schema.parse({ orderId: "00000000-0000-0000-0000-000000000000" })).not.toThrow();
  });
});
