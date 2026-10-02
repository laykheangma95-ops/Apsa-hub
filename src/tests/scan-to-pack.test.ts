/**
 * Scan-to-Pack domain — pure display logic tests.
 *
 * Validation has moved to the server (src/server/packing/service.ts).
 * These tests cover client-side display logic: session creation, progress
 * computation, phase derivation, server result application, local duplicate
 * detection, canPackOrder eligibility, and session immutability.
 *
 * Run: bun test src/tests/scan-to-pack.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  createPackSession,
  computePackProgress,
  getPackPhase,
  applyServerParcelAccepted,
  applyServerProductAccepted,
  isLocalDuplicateScan,
  canPackOrder,
  type PackRequirement,
  type PackSession,
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
  return applyServerParcelAccepted(session);
}

function applyProductAccepted(
  session: PackSession,
  orderItemId: string,
  variantId: string,
  productName: string,
): PackSession {
  return applyServerProductAccepted(session, { orderItemId, variantId });
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

describe("applyServerParcelAccepted", () => {
  it("transitions to scanning_products phase", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    expect(session.parcelVerified).toBe(true);
    expect(getPackPhase(session)).toBe("scanning_products");
  });

  it("does not mutate the original session", () => {
    const original = sessionWith([makeRequirement()]);
    const before = JSON.stringify(original);
    verifyParcel(original);
    expect(JSON.stringify(original)).toBe(before);
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
    session = applyProductAccepted(session, "item-1", "var-1", "Red T-Shirt");
    const progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(1);
    expect(progress.remaining).toBe(2);
    expect(progress.isComplete).toBe(false);
  });

  it("reports complete when all items are packed", () => {
    let session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 2 })]));
    session = applyProductAccepted(session, "item-1", "var-1", "Red T-Shirt");
    session = applyProductAccepted(session, "item-1", "var-1", "Red T-Shirt");
    const progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(2);
    expect(progress.remaining).toBe(0);
    expect(progress.isComplete).toBe(true);
    expect(getPackPhase(session)).toBe("complete");
  });
});

// ── isLocalDuplicateScan ────────────────────────────────────────────────────

describe("isLocalDuplicateScan", () => {
  it("returns false when line is not full", () => {
    const session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 2 })]));
    expect(isLocalDuplicateScan(session, "item-1")).toBe(false);
  });

  it("returns true when line is full", () => {
    let session = verifyParcel(sessionWith([makeRequirement({ quantityRequired: 1 })]));
    session = applyProductAccepted(session, "item-1", "var-1", "Red T-Shirt");
    expect(isLocalDuplicateScan(session, "item-1")).toBe(true);
  });

  it("returns false for unknown order item", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    expect(isLocalDuplicateScan(session, "nonexistent")).toBe(false);
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

    session = applyProductAccepted(session, "item-1", "var-1", "Shirt");
    let progress = computePackProgress(session);
    expect(progress.totalPacked).toBe(1);
    expect(progress.remaining).toBe(2);

    session = applyProductAccepted(session, "item-2", "var-2", "Pants");
    session = applyProductAccepted(session, "item-2", "var-2", "Pants");
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
  it("applyServerProductAccepted does not mutate the session", () => {
    const session = verifyParcel(sessionWith([makeRequirement()]));
    const before = JSON.stringify(session);
    applyServerProductAccepted(session, { orderItemId: "item-1", variantId: "var-1" });
    expect(JSON.stringify(session)).toBe(before);
  });

  it("applyServerParcelAccepted does not mutate the session", () => {
    const session = sessionWith([makeRequirement()]);
    const before = JSON.stringify(session);
    applyServerParcelAccepted(session);
    expect(JSON.stringify(session)).toBe(before);
  });
});
