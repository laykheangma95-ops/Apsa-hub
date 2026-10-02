/**
 * Scan-to-Pack domain — pure logic tests.
 *
 * Covers: correct parcel, wrong parcel, correct product, wrong product,
 * wrong variant, duplicate scan, incomplete pack, completed pack, and
 * session lifecycle phases.
 *
 * Run: bun test src/tests/scan-to-pack.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  createPackSession,
  computePackProgress,
  getPackPhase,
  validateParcelScan,
  applyParcelScan,
  validateProductScan,
  applyAcceptedPackScan,
  canPackOrder,
  type PackRequirement,
  type PackSession,
  type ProductScanResult,
} from "../lib/pack";

// ── Fixtures ────────────────────────────────────────────────────────────────

const PARCEL_CODE = "APSA:PCL:v1:abcdefghijklmnopqrstuv";

function makeRequirement(overrides: Partial<PackRequirement> = {}): PackRequirement {
  return {
    orderItemId: "item-1",
    productId: "prod-1",
    variantId: "var-1",
    productName: "Red T-Shirt",
    variantName: "Size L",
    sku: "TSH-RED-L",
    barcode: "1234567890",
    quantityRequired: 2,
    siblingBarcodes: [],
    ...overrides,
  };
}

function sessionWith(
  requirements: PackRequirement[],
  parcelCode: string = PARCEL_CODE,
): PackSession {
  return createPackSession("order-1", "APSA-2026-000001", parcelCode, requirements);
}

function verifyParcel(session: PackSession): PackSession {
  const result = validateParcelScan(session, session.expectedParcelCode);
  if (result.kind === "parcel_accepted") {
    return applyParcelScan(session, result);
  }
  throw new Error(`Expected parcel_accepted, got ${result.kind}`);
}

function applyProductScan(
  session: PackSession,
  barcode: string,
): { session: PackSession; result: ProductScanResult } {
  const result = validateProductScan(session, barcode);
  if (result.kind === "accepted") {
    return { session: applyAcceptedPackScan(session, result), result };
  }
  return { session, result };
}

// ── createPackSession ───────────────────────────────────────────────────────

describe("createPackSession", () => {
  it("creates a session in awaiting_parcel phase", () => {
    const session = sessionWith([makeRequirement()]);
    expect(session.orderId).toBe("order-1");
    expect(session.parcelVerified).toBe(false);
    expect(session.packed).toHaveLength(0);
    expect(session.requirements).toHaveLength(1);
    expect(getPackPhase(session)).toBe("awaiting_parcel");
  });
});

// ── Parcel verification ─────────────────────────────────────────────────────

describe("validateParcelScan", () => {
  it("accepts the correct parcel code", () => {
    const session = sessionWith([makeRequirement()]);
    const result = validateParcelScan(session, PARCEL_CODE);
    expect(result.kind).toBe("parcel_accepted");
  });

  it("rejects a wrong parcel code", () => {
    const session = sessionWith([makeRequirement()]);
    const result = validateParcelScan(session, "APSA:PCL:v1:WRONG_CODE_HERE_____");
    expect(result.kind).toBe("wrong_parcel");
  });

  it("returns parcel_already_verified after verification", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    const result = validateParcelScan(session, PARCEL_CODE);
    expect(result.kind).toBe("parcel_already_verified");
  });
});

describe("applyParcelScan", () => {
  it("transitions to scanning_products phase", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    expect(session.parcelVerified).toBe(true);
    expect(getPackPhase(session)).toBe("scanning_products");
  });
});

// ── computePackProgress ─────────────────────────────────────────────────────

describe("computePackProgress", () => {
  it("reports all items remaining when nothing is packed", () => {
    const session = verifyParcel(
      sessionWith([
        makeRequirement({ quantityRequired: 3 }),
        makeRequirement({
          orderItemId: "item-2",
          variantId: "var-2",
          barcode: "999",
          quantityRequired: 2,
        }),
      ]),
    );
    const progress = computePackProgress(session);
    expect(progress.totalRequired).toBe(5);
    expect(progress.totalPacked).toBe(0);
    expect(progress.remaining).toBe(5);
    expect(progress.isComplete).toBe(false);
  });

  it("tracks partial progress", () => {
    let session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 3 })]));
    const scan1 = applyProductScan(session, "1234567890");
    session = scan1.session;
    const progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(1);
    expect(progress.remaining).toBe(2);
    expect(progress.isComplete).toBe(false);
  });

  it("reports complete when all items are packed", () => {
    let session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 2 })]));
    session = applyProductScan(session, "1234567890").session;
    session = applyProductScan(session, "1234567890").session;
    const progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(2);
    expect(progress.remaining).toBe(0);
    expect(progress.isComplete).toBe(true);
    expect(getPackPhase(session)).toBe("complete");
  });
});

// ── Product scan validation ─────────────────────────────────────────────────

describe("validateProductScan", () => {
  it("rejects scan when parcel is not verified", () => {
    const session = sessionWith([makeRequirement()]);
    const result = validateProductScan(session, "1234567890");
    expect(result.kind).toBe("parcel_not_verified");
  });

  it("accepts a correct product barcode", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    const result = validateProductScan(session, "1234567890");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.orderItemId).toBe("item-1");
      expect(result.productName).toBe("Red T-Shirt");
    }
  });

  it("rejects a wrong product barcode", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    const result = validateProductScan(session, "UNKNOWN");
    expect(result.kind).toBe("wrong_product");
  });

  it("detects wrong variant via sibling barcodes", () => {
    const session = verifyParcel(
      sessionWith([makeRequirement({ barcode: "AAA", siblingBarcodes: ["BBB"] })]),
    );
    const result = validateProductScan(session, "BBB");
    expect(result.kind).toBe("wrong_variant");
  });

  it("reports duplicate_scan when one line is full but others remain", () => {
    let session = verifyParcel(
      sessionWith([
        makeRequirement({ orderItemId: "item-1", barcode: "AAA", quantityRequired: 1 }),
        makeRequirement({
          orderItemId: "item-2",
          variantId: "var-2",
          barcode: "BBB",
          quantityRequired: 1,
        }),
      ]),
    );
    session = applyProductScan(session, "AAA").session;
    const result = validateProductScan(session, "AAA");
    expect(result.kind).toBe("duplicate_scan");
  });

  it("reports already_complete when all items are packed", () => {
    let session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 1 })]));
    session = applyProductScan(session, "1234567890").session;
    const result = validateProductScan(session, "SOME_OTHER");
    expect(result.kind).toBe("already_complete");
  });
});

// ── Multi-line packing ──────────────────────────────────────────────────────

describe("multi-line packing", () => {
  it("tracks progress across multiple order lines", () => {
    let session = verifyParcel(
      sessionWith([
        makeRequirement({
          orderItemId: "item-1",
          variantId: "var-1",
          barcode: "AAA",
          quantityRequired: 1,
        }),
        makeRequirement({
          orderItemId: "item-2",
          variantId: "var-2",
          barcode: "BBB",
          quantityRequired: 2,
        }),
      ]),
    );

    session = applyProductScan(session, "AAA").session;
    let progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(1);
    expect(progress.remaining).toBe(2);

    session = applyProductScan(session, "BBB").session;
    session = applyProductScan(session, "BBB").session;
    progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(3);
    expect(progress.isComplete).toBe(true);
    expect(getPackPhase(session)).toBe("complete");
  });
});

// ── canPackOrder ────────────────────────────────────────────────────────────

describe("canPackOrder", () => {
  it("allows confirmed + processing", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" })).toBe(
      true,
    );
  });

  it("allows confirmed + unfulfilled", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "unfulfilled" })).toBe(
      true,
    );
  });

  it("rejects draft orders", () => {
    expect(canPackOrder({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
  });

  it("rejects cancelled orders", () => {
    expect(canPackOrder({ lifecycleStatus: "cancelled", fulfillmentStatus: "cancelled" })).toBe(
      false,
    );
  });

  it("rejects fulfilled orders", () => {
    expect(canPackOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });
});

// ── Immutability ────────────────────────────────────────────────────────────

describe("session immutability", () => {
  it("validateProductScan does not mutate the session", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    const before = JSON.stringify(session);
    validateProductScan(session, "1234567890");
    expect(JSON.stringify(session)).toBe(before);
  });

  it("validateParcelScan does not mutate the session", () => {
    const session = sessionWith([makeRequirement()]);
    const before = JSON.stringify(session);
    validateParcelScan(session, PARCEL_CODE);
    expect(JSON.stringify(session)).toBe(before);
  });
});
