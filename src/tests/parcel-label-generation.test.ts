/**
 * Parcel label generation — comprehensive tests.
 *
 * Covers: parcel creation idempotency in the label flow, QR/Code128 payload
 * identity, PII exclusion from barcodes, legacy order support, label
 * determinism, and rendering correctness.
 *
 * Run: bun test src/tests/parcel-label-generation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildParcelLabel, type ParcelLabelInput } from "../lib/labels/parcel-label";
import { PARCEL_CODE_PREFIX, isValidParcelCode } from "../lib/barcode/parcel-code";
import { isCode128Encodable } from "../lib/barcode/code128";
import { parseApsaQrPayload } from "../lib/barcode/payload";

const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";
const PARCEL_CODE = `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
const FIXED_NOW = new Date("2026-10-01T10:30:00.000Z");

function baseInput(overrides: Partial<ParcelLabelInput> = {}): ParcelLabelInput {
  return {
    merchant: { businessName: "Dara Shop" },
    customer: {
      name: "Sokha",
      phone: "012345678",
      address: "12 St 240, BKK1, Phnom Penh",
      addressConfirmed: true,
    },
    order: {
      id: ORDER_ID,
      orderNumber: "APSA-2026-001048",
      itemCount: 3,
      items: [
        { quantity: 2, productName: "Classic Tee", variantName: "Black / M" },
        { quantity: 1, productName: "Cap", variantName: "White" },
      ],
    },
    reprint: false,
    payment: { state: "cod", collect: { amount: 75000, currency: "KHR" } },
    delivery: null,
    ...overrides,
  };
}

// ── Parcel creation semantics ────────────────────────────────────────────────

describe("parcel creation in label flow", () => {
  it("first print: label uses parcel code when present", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.parcelCode).toBe(PARCEL_CODE);
    expect(vm.qr!.payload).toBe(PARCEL_CODE);
  });

  it("second print: reuses the exact same parcel code", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE, reprint: true });
    const vm1 = buildParcelLabel(input, { now: FIXED_NOW });
    const vm2 = buildParcelLabel(input, { now: FIXED_NOW });
    expect(vm1.parcelCode).toBe(vm2.parcelCode);
    expect(vm1.qr!.payload).toBe(vm2.qr!.payload);
  });

  it("repeated prints always yield the same parcel identity", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE });
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const vm = buildParcelLabel(input, { now: FIXED_NOW });
      codes.add(vm.parcelCode!);
    }
    expect(codes.size).toBe(1);
    expect(codes.has(PARCEL_CODE)).toBe(true);
  });
});

// ── QR payload tests ─────────────────────────────────────────────────────────

describe("QR payload", () => {
  it("equals the parcel identity when a parcel code is present", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr!.payload).toBe(PARCEL_CODE);
  });

  it("renders NO QR (never an order-UUID fallback) when no parcel code exists", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: null }), { now: FIXED_NOW });
    expect(vm.qr).toBeNull();
    expect(vm.code128).toBeNull();
  });

  it("rejects a malformed parcel code instead of encoding it", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: `apsa:order/${ORDER_ID}` }), {
      now: FIXED_NOW,
    });
    expect(vm.qr).toBeNull();
    expect(vm.code128).toBeNull();
    expect(vm.parcelCode).toBeNull();
  });

  it("QR payload contains no UUID when parcel code is present", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr!.payload).not.toContain(ORDER_ID);
  });

  it("QR payload contains no PII", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr!.payload).not.toContain("Sokha");
    expect(vm.qr!.payload).not.toContain("012345678");
    expect(vm.qr!.payload).not.toContain("BKK1");
    expect(vm.qr!.payload).not.toContain("75000");
    expect(vm.qr!.payload).not.toContain("APSA-2026-001048");
  });

  it("QR payload contains no order identifiers when parcel code is present", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr!.payload).not.toContain("order");
    expect(vm.qr!.payload).not.toContain(ORDER_ID);
    expect(vm.qr!.payload).not.toContain("APSA-2026");
  });

  it("QR SVG is a valid SVG string", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr!.svg).toContain("<svg");
    expect(vm.qr!.svg).toContain("</svg>");
  });
});

// ── Code 128 tests ───────────────────────────────────────────────────────────

describe("Code 128 barcode", () => {
  it("is always present alongside the QR when a parcel code exists", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.qr).not.toBeNull();
    expect(vm.code128).not.toBeNull();
  });

  it("encodes the same parcel identity as the QR", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), {
      now: FIXED_NOW,
    });
    expect(vm.code128!.payload).toBe(vm.qr!.payload);
    expect(vm.code128!.payload).toBe(PARCEL_CODE);
  });

  it("Code 128 SVG is a valid SVG string", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), {
      now: FIXED_NOW,
    });
    expect(vm.code128!.svg).toContain("<svg");
    expect(vm.code128!.svg).toContain("</svg>");
  });

  it("parcel codes are encodable in Code 128 B", () => {
    for (let i = 0; i < 50; i++) {
      const code = `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
      expect(isCode128Encodable(code)).toBe(true);
    }
  });

  it("is absent (no order-UUID fallback) when no parcel code", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: null }), { now: FIXED_NOW });
    expect(vm.code128).toBeNull();
  });
});

// ── Legacy order support ─────────────────────────────────────────────────────

describe("legacy orders (no parcel code)", () => {
  it("before a parcel code is assigned: no codes are rendered at all", () => {
    // The dialog assigns the code (idempotently) and blocks Print until it has.
    const vm = buildParcelLabel(baseInput({ parcelCode: null }), { now: FIXED_NOW });
    expect(vm.parcelCode).toBeNull();
    expect(vm.qr).toBeNull();
    expect(parseApsaQrPayload(JSON.stringify(vm))).toBeNull();
    expect(JSON.stringify(vm)).not.toContain(`apsa:order/`);
  });

  it("after parcel creation: parcelCode is set, QR uses it", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.parcelCode).toBe(PARCEL_CODE);
    expect(vm.qr!.payload).toBe(PARCEL_CODE);
  });

  it("future prints reuse the parcel code forever", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE, reprint: true });
    for (let i = 0; i < 50; i++) {
      const vm = buildParcelLabel(input, { now: FIXED_NOW });
      expect(vm.parcelCode).toBe(PARCEL_CODE);
      expect(vm.qr!.payload).toBe(PARCEL_CODE);
    }
  });
});

// ── Label content tests ──────────────────────────────────────────────────────

describe("label content", () => {
  it("includes merchant name", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.merchantName).toBe("Dara Shop");
  });

  it("includes recipient name, phone, and address", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.customer.name).toBe("Sokha");
    expect(vm.customer.phone).toBe("012345678");
    expect(vm.customer.address).toBe("12 St 240, BKK1, Phnom Penh");
  });

  it("includes order number", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.orderNumber).toBe("APSA-2026-001048");
  });

  it("includes human-readable parcel code", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.parcelCode).toBe(PARCEL_CODE);
    expect(isValidParcelCode(vm.parcelCode!)).toBe(true);
  });

  it("includes print timestamp", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.printTimestamp).toBe("2026-10-01T10:30:00.000Z");
  });

  it("print timestamp defaults to current time when not specified", () => {
    const before = new Date().toISOString();
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }));
    const after = new Date().toISOString();
    expect(vm.printTimestamp >= before).toBe(true);
    expect(vm.printTimestamp <= after).toBe(true);
  });

  it("carries payment info (COD)", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.payment.state).toBe("cod");
    expect(vm.payment.paid).toBe(false);
    expect(vm.payment.collectFormatted).toBe("៛75,000");
  });

  it("carries payment info (paid)", () => {
    const vm = buildParcelLabel(
      baseInput({ parcelCode: PARCEL_CODE, payment: { state: "paid", collect: null } }),
      { now: FIXED_NOW },
    );
    expect(vm.payment.paid).toBe(true);
    expect(vm.payment.collectFormatted).toBeNull();
  });

  it("avoids duplicate information — no order ID in parcel code", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.parcelCode).not.toContain(ORDER_ID);
  });
});

// ── Rendering determinism ────────────────────────────────────────────────────

describe("rendering determinism", () => {
  it("same input produces identical output", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE });
    const vm1 = buildParcelLabel(input, { now: FIXED_NOW });
    const vm2 = buildParcelLabel(input, { now: FIXED_NOW });
    expect(vm1.qr!.svg).toBe(vm2.qr!.svg);
    expect(vm1.code128!.svg).toBe(vm2.code128!.svg);
    expect(vm1.printTimestamp).toBe(vm2.printTimestamp);
    expect(vm1.parcelCode).toBe(vm2.parcelCode);
    expect(vm1.merchantName).toBe(vm2.merchantName);
    expect(vm1.orderNumber).toBe(vm2.orderNumber);
  });

  it("QR SVG is stable across 100 runs", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE });
    const first = buildParcelLabel(input, { now: FIXED_NOW }).qr!.svg;
    for (let i = 0; i < 100; i++) {
      expect(buildParcelLabel(input, { now: FIXED_NOW }).qr!.svg).toBe(first);
    }
  });

  it("Code128 SVG is stable across 100 runs", () => {
    const input = baseInput({ parcelCode: PARCEL_CODE });
    const first = buildParcelLabel(input, { now: FIXED_NOW }).code128!.svg;
    for (let i = 0; i < 100; i++) {
      expect(buildParcelLabel(input, { now: FIXED_NOW }).code128!.svg).toBe(first);
    }
  });
});

// ── Reprint flag ─────────────────────────────────────────────────────────────

describe("reprint flag", () => {
  it("false for first print", () => {
    const vm = buildParcelLabel(baseInput({ reprint: false }), { now: FIXED_NOW });
    expect(vm.reprint).toBe(false);
  });

  it("true for reprint", () => {
    const vm = buildParcelLabel(baseInput({ reprint: true }), { now: FIXED_NOW });
    expect(vm.reprint).toBe(true);
  });

  it("reprint does not change the parcel identity", () => {
    const first = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE, reprint: false }), {
      now: FIXED_NOW,
    });
    const reprint = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE, reprint: true }), {
      now: FIXED_NOW,
    });
    expect(first.parcelCode).toBe(reprint.parcelCode);
    expect(first.qr!.payload).toBe(reprint.qr!.payload);
  });
});

// ── Security: no PII in barcodes ─────────────────────────────────────────────

describe("security: no PII in barcodes", () => {
  const PII_STRINGS = [
    "Sokha",
    "012345678",
    "BKK1",
    "Phnom Penh",
    "75000",
    "APSA-2026-001048",
    "Classic Tee",
    "Dara Shop",
  ];

  it("QR payload contains no PII from the label", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), {
      now: FIXED_NOW,
    });
    for (const pii of PII_STRINGS) {
      expect(vm.qr!.payload).not.toContain(pii);
    }
  });

  it("Code128 payload contains no PII from the label", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), {
      now: FIXED_NOW,
    });
    for (const pii of PII_STRINGS) {
      expect(vm.code128!.payload).not.toContain(pii);
    }
  });

  it("QR and Code128 encode exactly the same payload", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), {
      now: FIXED_NOW,
    });
    expect(vm.qr!.payload).toBe(vm.code128!.payload);
  });

  it("no UUID leakage in parcel code", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.parcelCode).not.toContain(ORDER_ID);
    // UUIDs have hyphens at positions 8,13,18,23 — parcel codes do not contain UUIDs
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(uuidPattern.test(vm.parcelCode!)).toBe(false);
  });
});

// ── Item overflow ────────────────────────────────────────────────────────────

describe("item overflow handling", () => {
  it("shows all items when under the limit", () => {
    const vm = buildParcelLabel(baseInput({ parcelCode: PARCEL_CODE }), { now: FIXED_NOW });
    expect(vm.items).toHaveLength(2);
    expect(vm.overflowCount).toBe(0);
  });

  it("truncates and reports overflow when over the limit", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      quantity: 1,
      productName: `Item ${i}`,
      variantName: null,
    }));
    const vm = buildParcelLabel(
      baseInput({
        parcelCode: PARCEL_CODE,
        order: { ...baseInput().order, items, itemCount: 12 },
      }),
      { maxItemLines: 8, now: FIXED_NOW },
    );
    // 8 printed rows: 7 one-row lines + the continuation row.
    expect(vm.items).toHaveLength(7);
    expect(vm.overflowCount).toBe(5);
  });
});
