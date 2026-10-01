/**
 * Parcel code format — pure unit tests.
 *
 * Validates the shape helpers that every scan path and label path depends on.
 * No DB, no network, no server imports.
 *
 * Run: bun test src/tests/parcel-code.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  PARCEL_CODE_PREFIX,
  PARCEL_CODE_LENGTH,
  PARCEL_CODE_TOKEN_LENGTH,
  isValidParcelCode,
  looksLikeParcelCode,
} from "../lib/barcode/parcel-code";

const VALID_CODE = "APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3hJ8a";

describe("constants", () => {
  it("prefix is APSA:PCL:v1:", () => {
    expect(PARCEL_CODE_PREFIX).toBe("APSA:PCL:v1:");
  });

  it("token length is 22 (base64url of 16 bytes)", () => {
    expect(PARCEL_CODE_TOKEN_LENGTH).toBe(22);
  });

  it("total code length is prefix + token = 34", () => {
    expect(PARCEL_CODE_LENGTH).toBe(PARCEL_CODE_PREFIX.length + PARCEL_CODE_TOKEN_LENGTH);
    expect(PARCEL_CODE_LENGTH).toBe(34);
  });
});

describe("isValidParcelCode", () => {
  it("accepts a well-formed 35-char code with base64url token", () => {
    expect(VALID_CODE.length).toBe(PARCEL_CODE_LENGTH);
    expect(isValidParcelCode(VALID_CODE)).toBe(true);
  });

  it("accepts codes with hyphens and underscores (base64url chars)", () => {
    expect(isValidParcelCode("APSA:PCL:v1:aB3-dE7_gH1jK5mN9pQ4wX")).toBe(true);
  });

  it("rejects wrong prefix", () => {
    expect(isValidParcelCode("APSA:PKG:v1:kB7xR2mN9pQ4wF5yL3hJ8a")).toBe(false);
    expect(isValidParcelCode("apsa:PCL:v1:kB7xR2mN9pQ4wF5yL3hJ8a")).toBe(false);
    expect(isValidParcelCode("XPSA:PCL:v1:kB7xR2mN9pQ4wF5yL3hJ8a")).toBe(false);
  });

  it("rejects wrong length (too short)", () => {
    expect(isValidParcelCode("APSA:PCL:v1:short")).toBe(false);
  });

  it("rejects wrong length (too long)", () => {
    expect(isValidParcelCode("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3hJ8aXX")).toBe(false);
  });

  it("rejects non-base64url characters in token", () => {
    expect(isValidParcelCode("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h!8a")).toBe(false);
    expect(isValidParcelCode("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h 8a")).toBe(false);
    expect(isValidParcelCode("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h+8a")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidParcelCode("")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidParcelCode(null as unknown as string)).toBe(false);
    expect(isValidParcelCode(undefined as unknown as string)).toBe(false);
    expect(isValidParcelCode(12345 as unknown as string)).toBe(false);
  });

  it("rejects an APSA product barcode (different format)", () => {
    expect(isValidParcelCode("APSAK7Q400831527")).toBe(false);
  });

  it("rejects an APSA QR payload (apsa:order/<uuid>)", () => {
    expect(isValidParcelCode("apsa:order/12345678-90ab-4cde-8f01-234567890abc")).toBe(false);
  });
});

describe("looksLikeParcelCode", () => {
  it("returns true for strings starting with the parcel prefix", () => {
    expect(looksLikeParcelCode(VALID_CODE)).toBe(true);
    expect(looksLikeParcelCode("APSA:PCL:v1:anything")).toBe(true);
  });

  it("returns false for other APSA codes", () => {
    expect(looksLikeParcelCode("APSAK7Q400831527")).toBe(false);
    expect(looksLikeParcelCode("apsa:order/abc")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(looksLikeParcelCode(null as unknown as string)).toBe(false);
    expect(looksLikeParcelCode(undefined as unknown as string)).toBe(false);
  });
});

describe("server code generation produces valid codes", () => {
  it("crypto.randomBytes(16).toString('base64url') is 22 chars", () => {
    // Simulating what the server does — 16 bytes → base64url is always 22 chars
    // (128 bits / 6 bits per char = 21.33, padded to 22 without trailing =)
    for (let i = 0; i < 100; i++) {
      const token = randomBytes(16).toString("base64url");
      expect(token.length).toBe(22);
      const code = `${PARCEL_CODE_PREFIX}${token}`;
      expect(isValidParcelCode(code)).toBe(true);
    }
  });

  it("generates unique codes (100 codes, no collisions)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = randomBytes(16).toString("base64url");
      const code = `${PARCEL_CODE_PREFIX}${token}`;
      codes.add(code);
    }
    expect(codes.size).toBe(100);
  });
});
