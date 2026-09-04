/**
 * Slug validation unit tests.
 *
 * Verifies that the Zod slugSchema matches the DB constraint:
 *   CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$')
 *
 * Constraint analysis:
 *   - First char: [a-z0-9]  (no hyphen)
 *   - Middle:     [a-z0-9-]{1,61}  (min 1 middle char)
 *   - Last char:  [a-z0-9]  (no hyphen)
 *   - Total:      3 (min) to 63 (max) characters
 *
 * Run: bun test src/tests/slug-validation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { slugSchema } from "../server/org/create-organization";

function valid(slug: string): boolean {
  return slugSchema.safeParse(slug).success;
}

function invalid(slug: string): boolean {
  return !slugSchema.safeParse(slug).success;
}

// ── Valid slugs ───────────────────────────────────────────────────────────────

describe("Valid slugs (should pass)", () => {
  it("3-char minimum: abc", () => expect(valid("abc")).toBe(true));
  it("3-char minimum with digit: a1b", () => expect(valid("a1b")).toBe(true));
  it("all lowercase letters: acme", () => expect(valid("acme")).toBe(true));
  it("hyphen in middle: my-shop", () => expect(valid("my-shop")).toBe(true));
  it("multiple hyphens: my-great-shop", () => expect(valid("my-great-shop")).toBe(true));
  it("digits in slug: shop123", () => expect(valid("shop123")).toBe(true));
  it("starts and ends with digit: 1abc1", () => expect(valid("1abc1")).toBe(true));
  it("63-char maximum slug", () => {
    const slug = "a" + "b".repeat(61) + "c"; // 63 chars
    expect(valid(slug)).toBe(true);
  });
  it("mixed lowercase + digits + hyphen", () => expect(valid("apsa-hub-2024")).toBe(true));
  it("slug that looks like a domain prefix", () => expect(valid("my-business")).toBe(true));
});

// ── Invalid slugs ─────────────────────────────────────────────────────────────

describe("Invalid slugs (should fail)", () => {
  it("empty string", () => expect(invalid("")).toBe(true));
  it("1 char: a", () => expect(invalid("a")).toBe(true));
  it("2 chars: ab", () => expect(invalid("ab")).toBe(true));
  it("leading hyphen: -abc", () => expect(invalid("-abc")).toBe(true));
  it("trailing hyphen: abc-", () => expect(invalid("abc-")).toBe(true));
  it("uppercase: Abc", () => expect(invalid("Abc")).toBe(true));
  it("uppercase in middle: my-Shop", () => expect(invalid("my-Shop")).toBe(true));
  it("space in slug", () => expect(invalid("my shop")).toBe(true));
  it("underscore in slug", () => expect(invalid("my_shop")).toBe(true));
  it("special chars: my@shop", () => expect(invalid("my@shop")).toBe(true));
  it("64 chars (over max)", () => {
    const slug = "a" + "b".repeat(62) + "c"; // 64 chars
    expect(invalid(slug)).toBe(true);
  });
  it("double hyphen: my--shop", () => {
    // DB constraint allows --; this is valid per the regex. Verify our schema matches DB.
    // The DB constraint is '[a-z0-9-]{1,61}' which allows adjacent hyphens.
    // So my--shop should be valid.
    expect(valid("my--shop")).toBe(true);
  });
});

// ── Boundary conditions ───────────────────────────────────────────────────────

describe("Boundary conditions", () => {
  it("exactly 3 chars", () => expect(valid("a1b")).toBe(true));
  it("exactly 63 chars", () => {
    const slug = "a" + "-".repeat(61) + "b"; // 63 chars, hyphens in middle
    expect(valid(slug)).toBe(true);
  });
  it("64 chars is too long", () => {
    const slug = "a" + "b".repeat(62) + "c"; // 64 chars
    expect(invalid(slug)).toBe(true);
  });
  it("2 chars is too short", () => expect(invalid("ab")).toBe(true));
});
