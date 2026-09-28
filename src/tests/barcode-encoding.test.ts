/**
 * Barcode / QR encoding + APSA code format — pure unit tests.
 *
 * These are behavioural: they assert the actual encoded output (Code 128 symbol
 * values, module counts, QR geometry, Luhn check digits, payload safety), not
 * that a source string is present. No DB, no rendering runtime.
 *
 * Run: bun test src/tests/barcode-encoding.test.ts
 */
import { describe, it, expect } from "bun:test";
import { encodeCode128B, code128Modules, renderCode128Svg } from "../lib/barcode/code128";
import {
  APSA_BARCODE_LENGTH,
  formatApsaBarcode,
  isValidApsaBarcode,
  looksLikeApsaBarcode,
  luhnCheckDigit,
  orgBarcodePrefix,
} from "../lib/barcode/apsa-code";
import { orderQrPayload, parseApsaQrPayload, variantQrPayload } from "../lib/barcode/payload";
import { qrMatrix, renderQrSvg } from "../lib/barcode/qr";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";

describe("Code 128 encoding", () => {
  it("encodes with Start B, the correct checksum, and Stop", () => {
    // "A" = value 33. checksum = (104 + 33*1) % 103 = 34. Stop = 106.
    expect(encodeCode128B("A")).toEqual([104, 33, 34, 106]);
  });

  it("produces deterministic module runs (each symbol = 11 modules, Stop = 13)", () => {
    // "A" → Start B + data + checksum + Stop = 11 + 11 + 11 + 13 = 46 modules.
    expect(code128Modules("A")).toHaveLength(46);
  });

  it("is deterministic across calls", () => {
    expect(code128Modules("APSAK7Q400831527")).toEqual(code128Modules("APSAK7Q400831527"));
  });

  it("rejects characters outside printable ASCII", () => {
    expect(() => encodeCode128B("A\u0000B")).toThrow();
    expect(() => encodeCode128B("")).toThrow();
  });

  it("renders an SVG whose width tracks the module count + quiet zones", () => {
    const svg = renderCode128Svg("A", { moduleWidth: 2, quietModules: 10 });
    // (46 modules + 20 quiet) * 2 = 132
    expect(svg).toContain('width="132"');
    expect(svg.startsWith("<svg")).toBe(true);
  });
});

describe("APSA barcode format", () => {
  it("Luhn check digit matches the standard algorithm", () => {
    // Classic Luhn example: 7992739871 → check digit 3.
    expect(luhnCheckDigit("7992739871")).toBe(3);
    expect(luhnCheckDigit("00000000")).toBe(0);
  });

  it("builds a fixed-length, brand-marked, self-validating code", () => {
    const code = formatApsaBarcode(ORG_A, "831527");
    expect(code).toHaveLength(APSA_BARCODE_LENGTH);
    expect(looksLikeApsaBarcode(code)).toBe(true);
    expect(isValidApsaBarcode(code)).toBe(true);
  });

  it("gives each organization a stable, distinct prefix (no UUID leak)", () => {
    const a = orgBarcodePrefix(ORG_A);
    const b = orgBarcodePrefix(ORG_B);
    expect(a).toHaveLength(4);
    expect(a).toMatch(/^[0-9A-Z]{4}$/);
    expect(a).toBe(orgBarcodePrefix(ORG_A)); // deterministic
    expect(a).not.toBe(b);
    // The raw id must not appear in the code.
    expect(formatApsaBarcode(ORG_A, "1").includes(ORG_A.slice(0, 8))).toBe(false);
  });

  it("rejects a code whose check digit was tampered with", () => {
    const code = formatApsaBarcode(ORG_A, "831527");
    const broken = code.slice(0, -1) + String((Number(code.slice(-1)) + 1) % 10);
    expect(isValidApsaBarcode(broken)).toBe(false);
  });

  it("rejects non-APSA and malformed strings", () => {
    expect(isValidApsaBarcode("8850000000000")).toBe(false); // manufacturer EAN
    expect(isValidApsaBarcode("APSA123")).toBe(false);
    expect(isValidApsaBarcode("")).toBe(false);
  });

  it("pads short serials and refuses over-long or non-numeric ones", () => {
    expect(isValidApsaBarcode(formatApsaBarcode(ORG_A, "7"))).toBe(true);
    expect(() => formatApsaBarcode(ORG_A, "123456789")).toThrow();
    expect(() => formatApsaBarcode(ORG_A, "12x")).toThrow();
  });
});

describe("APSA QR payloads", () => {
  it("variant payload references the exact variant, no PII", () => {
    const payload = variantQrPayload(VARIANT_ID);
    expect(payload).toBe(`apsa:variant/${VARIANT_ID}`);
    expect(parseApsaQrPayload(payload)).toEqual({ kind: "variant", id: VARIANT_ID });
  });

  it("order payload references the order id only", () => {
    const payload = orderQrPayload(ORDER_ID);
    expect(payload).toBe(`apsa:order/${ORDER_ID}`);
    expect(parseApsaQrPayload(payload)).toEqual({ kind: "order", id: ORDER_ID });
  });

  it("never encodes anything but a UUID reference", () => {
    expect(() => variantQrPayload("not-a-uuid")).toThrow();
    expect(() => orderQrPayload("SELECT * FROM orders")).toThrow();
    // A payload with extra content does not parse.
    expect(parseApsaQrPayload("apsa:order/x;price=1000")).toBeNull();
    expect(parseApsaQrPayload("https://example.com")).toBeNull();
  });
});

describe("QR encoder", () => {
  it("produces a square matrix with the three finder patterns", () => {
    const m = qrMatrix("apsa:variant/short", "M");
    const n = m.length;
    expect(m.every((row) => row.length === n)).toBe(true);
    // Finder pattern outer corner is dark at (0,0), (0,n-1), (n-1,0).
    expect(m[0]![0]).toBe(true);
    expect(m[0]![n - 1]).toBe(true);
    expect(m[n - 1]![0]).toBe(true);
    // Finder centre 3x3 is dark; the ring around it is light.
    expect(m[3]![3]).toBe(true);
    expect(m[1]![1]).toBe(false);
  });

  it("is deterministic (same text → same matrix)", () => {
    expect(qrMatrix(orderQrPayload(ORDER_ID), "M")).toEqual(
      qrMatrix(orderQrPayload(ORDER_ID), "M"),
    );
  });

  it("grows the version to fit a longer payload", () => {
    const small = qrMatrix("apsa:x", "M").length;
    const big = qrMatrix(orderQrPayload(ORDER_ID), "M").length;
    expect(big).toBeGreaterThanOrEqual(small);
  });

  it("has a correct timing pattern (alternating row 6)", () => {
    const m = qrMatrix("apsa:variant/short", "M");
    expect(m[6]![8]).toBe(true); // even column → dark
    expect(m[6]![9]).toBe(false); // odd column → light
  });

  it("renders an SVG with a white quiet-zone background", () => {
    const svg = renderQrSvg("apsa:order/x", { moduleSize: 4, quietModules: 4 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#fff"');
  });
});
