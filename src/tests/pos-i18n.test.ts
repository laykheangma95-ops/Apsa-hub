/**
 * POS i18n: `pos.available` (PosProductList) and the search placeholder.
 * Run: bun test src/tests/pos-i18n.test.ts
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import en from "../locales/en.json";
import km from "../locales/km.json";

const locales = { en, km } as const;

describe("POS locale keys", () => {
  for (const [name, locale] of Object.entries(locales)) {
    it(`${name}: pos.available exists and keeps the count placeholder`, () => {
      expect(locale.pos.available).toContain("{{count}}");
    });
    it(`${name}: pos.searchPlaceholder exists and is short enough for 320px`, () => {
      expect(locale.pos.searchPlaceholder.length).toBeGreaterThan(0);
      expect(locale.pos.searchPlaceholder.length).toBeLessThanOrEqual(20);
    });
    it(`${name}: pos block has no Thai characters`, () => {
      expect(JSON.stringify(locale.pos)).not.toMatch(/[฀-๿]/);
    });
  }

  it("English placeholder still names name / SKU / barcode search", () => {
    expect(en.pos.searchPlaceholder).toMatch(/name/i);
    expect(en.pos.searchPlaceholder).toMatch(/SKU/);
    expect(en.pos.searchPlaceholder).toMatch(/barcode/i);
  });

  it("Khmer placeholder still mentions SKU", () => {
    expect(km.pos.searchPlaceholder).toContain("SKU");
  });

  it("every pos.* key used by PosProductList exists in both locales", () => {
    const src = readFileSync("src/components/pos/PosProductList.tsx", "utf8");
    const keys = [...src.matchAll(/\bt\("pos\.([A-Za-z.]+)"/g)].map((m) => m[1]);
    expect(keys).toContain("available");
    for (const key of keys) {
      for (const locale of [en, km]) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as never)?.[k], locale.pos);
        expect(typeof value).toBe("string");
      }
    }
  });
});
