/**
 * Scan-to-Pick domain — pure logic tests.
 *
 * Covers: correct product, wrong product, wrong variant, duplicate scan,
 * quantity complete, over scan, and session lifecycle.
 *
 * Run: bun test src/tests/scan-to-pick.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  createPickSession,
  computeProgress,
  validateScan,
  applyAcceptedScan,
  canPickOrder,
  type PickRequirement,
  type PickSession,
  type ScanResult,
} from "../lib/pick";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRequirement(overrides: Partial<PickRequirement> = {}): PickRequirement {
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

function sessionWith(requirements: PickRequirement[]): PickSession {
  return createPickSession("order-1", "APSA-2026-000001", requirements);
}

function applyScan(
  session: PickSession,
  barcode: string,
): { session: PickSession; result: ScanResult } {
  const result = validateScan(session, barcode);
  if (result.kind === "accepted") {
    return { session: applyAcceptedScan(session, result), result };
  }
  return { session, result };
}

// ── createPickSession ───────────────────────────────────────────────────────

describe("createPickSession", () => {
  it("creates a session with zero picked items", () => {
    const session = sessionWith([makeRequirement()]);
    expect(session.orderId).toBe("order-1");
    expect(session.picked).toHaveLength(0);
    expect(session.requirements).toHaveLength(1);
  });
});

// ── computeProgress ─────────────────────────────────────────────────────────

describe("computeProgress", () => {
  it("reports all items remaining when nothing is picked", () => {
    const session = sessionWith([
      makeRequirement({ quantityRequired: 3 }),
      makeRequirement({
        orderItemId: "item-2",
        variantId: "var-2",
        barcode: "999",
        quantityRequired: 2,
      }),
    ]);
    const progress = computeProgress(session);
    expect(progress.totalRequired).toBe(5);
    expect(progress.totalPicked).toBe(0);
    expect(progress.remaining).toBe(5);
    expect(progress.isComplete).toBe(false);
  });

  it("counts picked items correctly", () => {
    let session = sessionWith([makeRequirement({ quantityRequired: 2 })]);
    ({ session } = applyScan(session, "1234567890"));
    const progress = computeProgress(session);
    expect(progress.totalPicked).toBe(1);
    expect(progress.remaining).toBe(1);
    expect(progress.isComplete).toBe(false);
  });

  it("marks complete when all items are picked", () => {
    let session = sessionWith([makeRequirement({ quantityRequired: 1 })]);
    ({ session } = applyScan(session, "1234567890"));
    const progress = computeProgress(session);
    expect(progress.totalPicked).toBe(1);
    expect(progress.remaining).toBe(0);
    expect(progress.isComplete).toBe(true);
  });

  it("reports per-line progress", () => {
    let session = sessionWith([
      makeRequirement({ orderItemId: "item-1", barcode: "AAA", quantityRequired: 2 }),
      makeRequirement({
        orderItemId: "item-2",
        variantId: "var-2",
        barcode: "BBB",
        quantityRequired: 1,
      }),
    ]);
    ({ session } = applyScan(session, "AAA"));
    const progress = computeProgress(session);
    expect(progress.lines[0]!.quantityPicked).toBe(1);
    expect(progress.lines[0]!.isComplete).toBe(false);
    expect(progress.lines[1]!.quantityPicked).toBe(0);
    expect(progress.lines[1]!.isComplete).toBe(false);
  });
});

// ── validateScan — correct product ──────────────────────────────────────────

describe("validateScan — correct product", () => {
  it("accepts a scan matching the required barcode", () => {
    const session = sessionWith([makeRequirement({ barcode: "GOOD" })]);
    const result = validateScan(session, "GOOD");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.orderItemId).toBe("item-1");
      expect(result.variantId).toBe("var-1");
    }
  });

  it("accepts the correct variant when multiple lines exist", () => {
    const session = sessionWith([
      makeRequirement({ orderItemId: "item-1", barcode: "AAA" }),
      makeRequirement({ orderItemId: "item-2", variantId: "var-2", barcode: "BBB" }),
    ]);
    const result = validateScan(session, "BBB");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.orderItemId).toBe("item-2");
    }
  });
});

// ── validateScan — wrong product ────────────────────────────────────────────

describe("validateScan — wrong product", () => {
  it("rejects a barcode not in any requirement", () => {
    const session = sessionWith([makeRequirement({ barcode: "GOOD" })]);
    const result = validateScan(session, "BAD");
    expect(result.kind).toBe("wrong_product");
    if (result.kind === "wrong_product") {
      expect(result.scannedBarcode).toBe("BAD");
    }
  });

  it("rejects when requirements have no barcodes", () => {
    const session = sessionWith([makeRequirement({ barcode: null })]);
    const result = validateScan(session, "ANYTHING");
    expect(result.kind).toBe("wrong_product");
  });
});

// ── validateScan — wrong variant ───────────────────────────────────────────

describe("validateScan — wrong variant", () => {
  it("returns wrong_variant when barcode matches a sibling variant", () => {
    const session = sessionWith([
      makeRequirement({
        barcode: "AAA",
        variantName: "Size L",
        siblingBarcodes: ["BBB", "CCC"],
      }),
    ]);
    const result = validateScan(session, "BBB");
    expect(result.kind).toBe("wrong_variant");
    if (result.kind === "wrong_variant") {
      expect(result.scannedBarcode).toBe("BBB");
      expect(result.expectedVariantName).toBe("Size L");
    }
  });

  it("returns wrong_product when barcode matches no requirement or sibling", () => {
    const session = sessionWith([
      makeRequirement({
        barcode: "AAA",
        siblingBarcodes: ["BBB"],
      }),
    ]);
    const result = validateScan(session, "ZZZ");
    expect(result.kind).toBe("wrong_product");
  });

  it("prefers accepted over wrong_variant when barcode is a direct match", () => {
    const session = sessionWith([
      makeRequirement({
        barcode: "AAA",
        siblingBarcodes: ["BBB"],
      }),
    ]);
    const result = validateScan(session, "AAA");
    expect(result.kind).toBe("accepted");
  });

  it("returns wrong_variant with null expectedVariantName when variant has no name", () => {
    const session = sessionWith([
      makeRequirement({
        barcode: "AAA",
        variantName: null,
        siblingBarcodes: ["BBB"],
      }),
    ]);
    const result = validateScan(session, "BBB");
    expect(result.kind).toBe("wrong_variant");
    if (result.kind === "wrong_variant") {
      expect(result.expectedVariantName).toBeNull();
    }
  });
});

// ── validateScan — duplicate scan / quantity ────────────────────────────────

describe("validateScan — duplicate and quantity", () => {
  it("accepts duplicate scans up to the required quantity", () => {
    let session = sessionWith([makeRequirement({ barcode: "GOOD", quantityRequired: 3 })]);
    let result: ScanResult;

    ({ session, result } = applyScan(session, "GOOD"));
    expect(result.kind).toBe("accepted");

    ({ session, result } = applyScan(session, "GOOD"));
    expect(result.kind).toBe("accepted");

    ({ session, result } = applyScan(session, "GOOD"));
    expect(result.kind).toBe("accepted");

    const progress = computeProgress(session);
    expect(progress.isComplete).toBe(true);
  });

  it("rejects over-quantity scans", () => {
    let session = sessionWith([makeRequirement({ barcode: "GOOD", quantityRequired: 1 })]);
    ({ session } = applyScan(session, "GOOD"));

    const result = validateScan(session, "GOOD");
    expect(result.kind).toBe("already_complete");
  });

  it("reports over_quantity when one line is full but session is not complete", () => {
    let session = sessionWith([
      makeRequirement({ orderItemId: "item-1", barcode: "AAA", quantityRequired: 1 }),
      makeRequirement({
        orderItemId: "item-2",
        variantId: "var-2",
        barcode: "BBB",
        quantityRequired: 1,
      }),
    ]);
    ({ session } = applyScan(session, "AAA"));

    const result = validateScan(session, "AAA");
    expect(result.kind).toBe("over_quantity");
    if (result.kind === "over_quantity") {
      expect(result.productName).toBe("Red T-Shirt");
    }
  });
});

// ── validateScan — already complete ─────────────────────────────────────────

describe("validateScan — already complete", () => {
  it("returns already_complete when all items are picked", () => {
    let session = sessionWith([
      makeRequirement({ orderItemId: "item-1", barcode: "AAA", quantityRequired: 1 }),
      makeRequirement({
        orderItemId: "item-2",
        variantId: "var-2",
        barcode: "BBB",
        quantityRequired: 1,
      }),
    ]);
    ({ session } = applyScan(session, "AAA"));
    ({ session } = applyScan(session, "BBB"));

    const result = validateScan(session, "AAA");
    expect(result.kind).toBe("already_complete");
  });
});

// ── canPickOrder ────────────────────────────────────────────────────────────

describe("canPickOrder", () => {
  it("allows picking for confirmed + unfulfilled", () => {
    expect(canPickOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "unfulfilled" })).toBe(
      true,
    );
  });

  it("allows picking for confirmed + processing", () => {
    expect(canPickOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" })).toBe(
      true,
    );
  });

  it("denies picking for draft orders", () => {
    expect(canPickOrder({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
  });

  it("denies picking for cancelled orders", () => {
    expect(canPickOrder({ lifecycleStatus: "cancelled", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
  });

  it("denies picking for completed orders", () => {
    expect(canPickOrder({ lifecycleStatus: "completed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });

  it("denies picking for fulfilled orders", () => {
    expect(canPickOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" })).toBe(
      false,
    );
  });

  it("denies picking for fulfillment-cancelled orders", () => {
    expect(canPickOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "cancelled" })).toBe(
      false,
    );
  });
});

// ── Multi-line picking workflow ─────────────────────────────────────────────

describe("multi-line picking workflow", () => {
  it("tracks progress across multiple lines correctly", () => {
    let session = sessionWith([
      makeRequirement({
        orderItemId: "item-1",
        barcode: "AAA",
        quantityRequired: 2,
        productName: "Product A",
      }),
      makeRequirement({
        orderItemId: "item-2",
        variantId: "var-2",
        barcode: "BBB",
        quantityRequired: 3,
        productName: "Product B",
      }),
    ]);

    // Pick 1 of A
    ({ session } = applyScan(session, "AAA"));
    let progress = computeProgress(session);
    expect(progress.totalPicked).toBe(1);
    expect(progress.remaining).toBe(4);

    // Pick 1 of B
    ({ session } = applyScan(session, "BBB"));
    progress = computeProgress(session);
    expect(progress.totalPicked).toBe(2);
    expect(progress.remaining).toBe(3);

    // Pick 2nd A — completes that line
    ({ session } = applyScan(session, "AAA"));
    progress = computeProgress(session);
    expect(progress.lines[0]!.isComplete).toBe(true);
    expect(progress.lines[1]!.isComplete).toBe(false);
    expect(progress.totalPicked).toBe(3);

    // Pick remaining Bs
    ({ session } = applyScan(session, "BBB"));
    ({ session } = applyScan(session, "BBB"));
    progress = computeProgress(session);
    expect(progress.isComplete).toBe(true);
    expect(progress.remaining).toBe(0);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles requirement with null barcode — scan is wrong_product", () => {
    const session = sessionWith([makeRequirement({ barcode: null })]);
    const result = validateScan(session, "ANYTHING");
    expect(result.kind).toBe("wrong_product");
  });

  it("handles empty requirements list", () => {
    const session = sessionWith([]);
    const progress = computeProgress(session);
    expect(progress.totalRequired).toBe(0);
    expect(progress.isComplete).toBe(true);
  });

  it("handles single-item quantity=1 full cycle", () => {
    let session = sessionWith([makeRequirement({ barcode: "X", quantityRequired: 1 })]);
    const result = validateScan(session, "X");
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      session = applyAcceptedScan(session, result);
    }
    expect(computeProgress(session).isComplete).toBe(true);
    expect(validateScan(session, "X").kind).toBe("already_complete");
  });
});
