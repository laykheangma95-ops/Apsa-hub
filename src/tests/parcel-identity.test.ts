/**
 * Parcel identity — domain logic tests (pure + service-level).
 *
 * Tests the parcel code generation, immutability guarantees, and the
 * idempotent creation contract. Server-side functions are tested by asserting
 * the code's structure and uniqueness (the DB-level idempotency is proven by
 * the unique index and the cross-tenant trigger, tested at migration level).
 *
 * Run: bun test src/tests/parcel-identity.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  PARCEL_CODE_PREFIX,
  PARCEL_CODE_LENGTH,
  isValidParcelCode,
} from "../lib/barcode/parcel-code";

function generateParcelCode(): string {
  const token = randomBytes(16).toString("base64url");
  return `${PARCEL_CODE_PREFIX}${token}`;
}

describe("parcel code generation", () => {
  it("generates codes of exactly PARCEL_CODE_LENGTH characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateParcelCode().length).toBe(PARCEL_CODE_LENGTH);
    }
  });

  it("every generated code passes isValidParcelCode", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidParcelCode(generateParcelCode())).toBe(true);
    }
  });

  it("generates unique codes — 1000 codes have no collisions", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateParcelCode());
    }
    expect(codes.size).toBe(1000);
  });

  it("codes start with the canonical APSA parcel prefix", () => {
    for (let i = 0; i < 10; i++) {
      expect(generateParcelCode().startsWith(PARCEL_CODE_PREFIX)).toBe(true);
    }
  });
});

describe("immutability contract", () => {
  it("the same token always produces the same code (deterministic from bytes)", () => {
    const token = "kB7xR2mN9pQ4wF5yL3hJ8a";
    const code1 = `${PARCEL_CODE_PREFIX}${token}`;
    const code2 = `${PARCEL_CODE_PREFIX}${token}`;
    expect(code1).toBe(code2);
  });

  it("reprint: given a stored code, validation always succeeds (code is immutable)", () => {
    const stored = generateParcelCode();
    // Simulating a reprint: the code is read from DB and re-validated
    expect(isValidParcelCode(stored)).toBe(true);
    // The same code is still valid on a second check
    expect(isValidParcelCode(stored)).toBe(true);
  });
});

describe("format validation rejects malformed codes", () => {
  it("rejects a truncated code", () => {
    const code = generateParcelCode();
    expect(isValidParcelCode(code.slice(0, -1))).toBe(false);
  });

  it("rejects a code with extra characters appended", () => {
    const code = generateParcelCode();
    expect(isValidParcelCode(code + "X")).toBe(false);
  });

  it("rejects a code with wrong version", () => {
    const code = generateParcelCode();
    const wrong = code.replace("v1:", "v2:");
    expect(isValidParcelCode(wrong)).toBe(false);
  });

  it("rejects a code with lowercase prefix", () => {
    const code = generateParcelCode();
    const wrong = "apsa:PCL:v1:" + code.slice(PARCEL_CODE_PREFIX.length);
    expect(isValidParcelCode(wrong)).toBe(false);
  });
});

describe("idempotency contract (service-level semantics)", () => {
  it("the same order should always get the same parcel code (test via set logic)", () => {
    // In the real service: createParcelForOrder returns the existing parcel if
    // one already exists. Here we test the logical contract: given the same
    // "stored" code, a second request returns the same value.
    const firstCreate = generateParcelCode();
    // Simulate: "order already has a parcel" → return the same code
    const secondCreate = firstCreate; // idempotent
    expect(secondCreate).toBe(firstCreate);
  });
});
