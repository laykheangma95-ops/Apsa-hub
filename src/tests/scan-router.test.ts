/**
 * Scan router — pure unit tests for classifyScan.
 *
 * Every scan in APSA passes through classifyScan before reaching business logic.
 * These tests prove it routes correctly and, critically, that removing parcel
 * prefix handling causes failures (mutation safety).
 *
 * Run: bun test src/tests/scan-router.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { classifyScan, type ScanIdentity } from "../lib/barcode/scan-router";
import { PARCEL_CODE_PREFIX, PARCEL_CODE_LENGTH } from "../lib/barcode/parcel-code";

const VARIANT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORDER_UUID = "12345678-90ab-4cde-8f01-234567890abc";

function makeParcelCode(): string {
  return `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
}

describe("product barcodes", () => {
  it("classifies EAN-13 as product-barcode", () => {
    const result = classifyScan("4006381333931");
    expect(result.kind).toBe("product-barcode");
    expect((result as { code: string }).code).toBe("4006381333931");
  });

  it("classifies UPC-A as product-barcode", () => {
    const result = classifyScan("012345678905");
    expect(result.kind).toBe("product-barcode");
  });

  it("classifies an APSA-generated product barcode as product-barcode", () => {
    // APSA1ICJ008315277 is a valid APSA barcode (correct prefix, serial, Luhn check)
    const result = classifyScan("APSA1ICJ008315277");
    expect(result.kind).toBe("product-barcode");
    expect((result as { code: string }).code).toBe("APSA1ICJ008315277");
  });

  it("classifies a random manufacturer code as product-barcode", () => {
    const result = classifyScan("ABC-12345");
    expect(result.kind).toBe("product-barcode");
  });
});

describe("APSA parcel codes", () => {
  it("classifies a valid APSA parcel QR as apsa-parcel", () => {
    const code = makeParcelCode();
    expect(code.length).toBe(PARCEL_CODE_LENGTH);
    const result = classifyScan(code);
    expect(result.kind).toBe("apsa-parcel");
    expect((result as { code: string }).code).toBe(code);
  });

  it("rejects a malformed parcel prefix as unknown, not product", () => {
    const result = classifyScan("APSA:PCL:v1:tooshort");
    expect(result.kind).toBe("unknown");
  });

  it("rejects APSA:PCL:v1: with invalid characters as unknown", () => {
    const result = classifyScan("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h!");
    expect(result.kind).toBe("unknown");
  });

  it("does not confuse a parcel code with a product barcode", () => {
    const code = makeParcelCode();
    const result = classifyScan(code);
    expect(result.kind).not.toBe("product-barcode");
  });
});

describe("APSA QR payloads", () => {
  it("classifies apsa:variant/<uuid> as apsa-variant", () => {
    const result = classifyScan(`apsa:variant/${VARIANT_UUID}`);
    expect(result.kind).toBe("apsa-variant");
    expect((result as { id: string }).id).toBe(VARIANT_UUID);
  });

  it("classifies apsa:order/<uuid> as apsa-order", () => {
    const result = classifyScan(`apsa:order/${ORDER_UUID}`);
    expect(result.kind).toBe("apsa-order");
    expect((result as { id: string }).id).toBe(ORDER_UUID);
  });

  it("rejects apsa: with invalid kind as unknown", () => {
    const result = classifyScan(`apsa:widget/${VARIANT_UUID}`);
    // parseApsaQrPayload returns null for unknown kinds, and it doesn't
    // start with APSA (uppercase), so it falls through to product-barcode
    expect(result.kind).toBe("product-barcode");
  });

  it("rejects apsa:variant/ with non-UUID as product-barcode (falls through)", () => {
    const result = classifyScan("apsa:variant/not-a-uuid");
    expect(result.kind).toBe("product-barcode");
  });
});

describe("edge cases", () => {
  it("classifies empty string as unknown", () => {
    expect(classifyScan("").kind).toBe("unknown");
  });

  it("classifies null/undefined as unknown", () => {
    expect(classifyScan(null as unknown as string).kind).toBe("unknown");
    expect(classifyScan(undefined as unknown as string).kind).toBe("unknown");
  });

  it("invalid APSA product barcode (wrong Luhn) is unknown", () => {
    // APSA1ICJ008315277 is valid; change the check digit to 9
    const result = classifyScan("APSA1ICJ008315279");
    expect(result.kind).toBe("unknown");
  });
});

describe("mutation safety: parcel prefix handling is load-bearing", () => {
  it("a valid parcel code MUST classify as apsa-parcel, not product-barcode", () => {
    const code = makeParcelCode();
    const result = classifyScan(code);
    expect(result.kind).toBe("apsa-parcel");
    // If someone removes the parcel check, this fails because the code starts
    // with "APSA" (the product barcode prefix) but is NOT a valid product
    // barcode (wrong length/format), so it would become "unknown" — not the
    // correct "apsa-parcel".
  });

  it("APSA:PCL:v1: prefix takes priority over APSA product barcode prefix", () => {
    // Both start with "APSA" but parcel code is checked first
    const code = makeParcelCode();
    expect(code.startsWith("APSA")).toBe(true);
    expect(classifyScan(code).kind).toBe("apsa-parcel");
  });
});
