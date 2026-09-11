/**
 * Khmer/English locale key parity.
 *
 * APSA is Khmer-first with English as the only other supported language
 * (CLAUDE.md — Localization/UX). Every key that exists in one locale file
 * must exist in the other, or a screen silently falls back to the wrong
 * language (react-i18next's fallbackLng) instead of showing a translated
 * string. This is a plain structural check on the two JSON trees — no
 * rendering, no i18next runtime involved.
 *
 * Run: bun test src/tests/i18n-key-parity.test.ts
 */
import { describe, it, expect } from "bun:test";
import en from "../locales/en.json";
import km from "../locales/km.json";

type JsonTree = { [key: string]: JsonTree | string | number | boolean | null };

function flattenKeys(tree: JsonTree, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as JsonTree, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

describe("Khmer/English locale key parity", () => {
  const enKeys = new Set(flattenKeys(en as JsonTree));
  const kmKeys = new Set(flattenKeys(km as JsonTree));

  it("every English key has a Khmer counterpart", () => {
    const missingInKhmer = [...enKeys].filter((key) => !kmKeys.has(key)).sort();
    expect(missingInKhmer).toEqual([]);
  });

  it("every Khmer key has an English counterpart", () => {
    const missingInEnglish = [...kmKeys].filter((key) => !enKeys.has(key)).sort();
    expect(missingInEnglish).toEqual([]);
  });

  it("the new settings.* keys exist in both locales", () => {
    const settingsKeysEn = [...enKeys].filter((key) => key.startsWith("settings."));
    expect(settingsKeysEn.length).toBeGreaterThan(0);
    for (const key of settingsKeysEn) {
      expect(kmKeys.has(key)).toBe(true);
    }
  });
});
