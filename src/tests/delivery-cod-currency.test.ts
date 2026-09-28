/**
 * COD on a riel order must be typed, parsed, sent and read back in riel.
 *
 * The server stores `cod_currency` as the order's currency and takes
 * `codAmountMinor` as-is (create_delivery, migration 027). CreateDeliverySheet
 * used the USD-only CurrencyInput for it: a "$" prefix, `value / 100` display
 * and `parseFloat(x) * 100` parsing. On a KHR order, typing the ៛40,000 the
 * courier should collect sent 4,000,000 riel — one hundred times the order.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codDiffersFromTotal, parseCodAmount } from "@/lib/delivery-fee";
import { formatMoney } from "@/lib/money";

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SHEET = stripComments(
  readFileSync(resolve("src/components/delivery/CreateDeliverySheet.tsx"), "utf8"),
);

describe("parseCodAmount parses in the order's own currency, with integers only", () => {
  it("riel is riel: 40000 typed on a KHR order is 40,000 minor units, not 4,000,000", () => {
    expect(parseCodAmount("40000", "KHR")).toBe(40_000);
    expect(parseCodAmount("40,000", "KHR")).toBe(40_000);
  });

  it("riel has no decimals", () => {
    expect(parseCodAmount("40000.5", "KHR")).toBeNull();
  });

  it("dollars keep cents, at most two places, without float rounding", () => {
    expect(parseCodAmount("12.5", "USD")).toBe(1250);
    expect(parseCodAmount("19.99", "USD")).toBe(1999);
    expect(parseCodAmount("12.345", "USD")).toBeNull();
  });

  it("empty is 'no COD amount'; negative or junk is invalid", () => {
    expect(parseCodAmount("", "KHR")).toBe(0);
    expect(parseCodAmount("  ", "USD")).toBe(0);
    expect(parseCodAmount("-5", "KHR")).toBeNull();
    expect(parseCodAmount("abc", "USD")).toBeNull();
  });

  it("reads back with the right symbol for the currency", () => {
    expect(formatMoney({ amount: parseCodAmount("40000", "KHR")!, currency: "KHR" })).toBe(
      "៛40,000",
    );
    expect(formatMoney({ amount: parseCodAmount("12.5", "USD")!, currency: "USD" })).toBe("$12.50");
  });

  it("a riel COD equal to a riel total is not flagged as different", () => {
    const total = { amount: 40_000, currency: "KHR" as const };
    expect(
      codDiffersFromTotal({ amount: parseCodAmount("40000", "KHR")!, currency: "KHR" }, total),
    ).toBe(false);
  });
});

describe("CreateDeliverySheet uses the order currency for COD", () => {
  it("no longer uses the USD-only CurrencyInput or float parsing", () => {
    expect(SHEET).not.toContain("CurrencyInput");
    expect(SHEET).not.toMatch(/parseFloat/);
    expect(SHEET).not.toMatch(/\*\s*100/);
  });

  it("takes the COD currency from the order total, which is now required", () => {
    expect(SHEET).toContain("const codCurrency = orderTotal.currency;");
    expect(SHEET).toContain("parseCodAmount(codText, codCurrency)");
    expect(SHEET).toMatch(/orderTotal: Money;/);
    expect(SHEET).not.toMatch(/orderTotal\?: Money/);
  });

  it("labels the field with the currency and blocks submit on an invalid amount", () => {
    expect(SHEET).toContain('t("delivery.create.codAmount", { currency: codCurrency })');
    expect(SHEET).toContain("codInvalid");
    expect(SHEET).toMatch(
      /disabled=\{submitting \|\| providerName\.trim\(\)\.length === 0 \|\| codInvalid\}/,
    );
  });

  it("sends only a positive parsed amount", () => {
    expect(SHEET).toContain(
      "if (codEnabled && codMinor !== null && codMinor > 0) input.codAmountMinor = codMinor;",
    );
  });
});
