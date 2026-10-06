/**
 * POS money correctness (V1 launch repair #1).
 *
 * The defects this pins, all reproduced against the previous pos-cart.ts:
 *
 *   1. calculateCartTotals summed line amounts and ALWAYS labelled the result
 *      USD. 2 × ៛5,000 rendered as "$100.00 ≈ ៛410,000" instead of ៛10,000.
 *   2. A fixed discount was entered and stored as USD cents whatever the cart
 *      currency, so a riel cart's discount was reinterpreted as cents.
 *   3. A cart mixing USD and KHR lines summed riel and cents into one number.
 *   4. needsManagerApproval — self-described as a "mock cashier permission
 *      envelope. Never a production rule." — blocked real checkout, including
 *      an Owner's, with no approval workflow behind it.
 *
 * Persisted-order agreement (L) and idempotent replay (M) run against the real
 * migrated SQL in src/tests/order-money-stock-safety.runtime.ts ("POS money").
 *
 * Run: bun test src/tests/pos-money-correctness.test.ts
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import en from "../locales/en.json";
import km from "../locales/km.json";
import { approximateCounterpart, formatMoney, khr, usd } from "@/lib/money";
import { isOrderCurrencyMismatch } from "@/lib/orders";
import {
  calculateCartTotals,
  cartCurrencies,
  checkoutBlock,
  discountProblemKey,
  lineKey,
  NO_DISCOUNT,
  type CartDiscountInput,
  type CartLine,
  type CartTotals,
  type PricedCartTotals,
} from "@/lib/pos-cart";
import type { Money } from "@/types";
import * as posCart from "@/lib/pos-cart";

const read = (p: string) => readFileSync(p, "utf8");

function line(id: string, unitPrice: Money, quantity = 1): CartLine {
  return {
    key: lineKey(id),
    productId: id,
    nameKm: "ផលិតផល",
    nameEn: "Product",
    sku: `SKU-${id}`,
    quantity,
    unitPrice,
    stock: 0,
  };
}

function amount(text: string, currency: "USD" | "KHR"): CartDiscountInput {
  return { enabled: true, mode: "amount", text, currency };
}

function percent(text: string, currency: "USD" | "KHR" = "USD"): CartDiscountInput {
  return { enabled: true, mode: "percent", text, currency };
}

function priced(totals: CartTotals): PricedCartTotals {
  if (totals.kind !== "priced") throw new Error(`expected a priced cart, got ${totals.kind}`);
  return totals;
}

// ── A–C. Totals keep the lines' own currency ─────────────────────────────────

describe("A. USD-only cart", () => {
  it("totals stay USD cents", () => {
    const t = priced(
      calculateCartTotals([line("a", usd(1250), 2), line("b", usd(399))], NO_DISCOUNT),
    );
    expect(t.currency).toBe("USD");
    expect(t.subtotal).toEqual(usd(2899));
    expect(t.discount).toEqual(usd(0));
    expect(t.total).toEqual(usd(2899));
    expect(t.itemCount).toBe(3);
    expect(checkoutBlock(t)).toBeNull();
  });
});

describe("B. KHR-only cart", () => {
  it("totals stay riel — never relabelled as dollars", () => {
    const t = priced(
      calculateCartTotals([line("a", khr(12500)), line("b", khr(3000), 3)], NO_DISCOUNT),
    );
    expect(t.currency).toBe("KHR");
    expect(t.subtotal).toEqual(khr(21500));
    expect(t.total).toEqual(khr(21500));
    expect(t.discount).toEqual(khr(0));
  });

  it("a large riel total stays an exact integer", () => {
    const t = priced(calculateCartTotals([line("a", khr(4_150_000), 25)], NO_DISCOUNT));
    expect(t.total).toEqual(khr(103_750_000));
    expect(formatMoney(t.total)).toBe("៛103,750,000");
  });
});

describe("C. 2 × KHR 5,000 = KHR 10,000", () => {
  it("is ៛10,000, not $100.00", () => {
    const t = priced(calculateCartTotals([line("water", khr(5000), 2)], NO_DISCOUNT));
    expect(t.total).toEqual(khr(10000));
    expect(formatMoney(t.total)).toBe("៛10,000");
    expect(formatMoney(t.total)).not.toBe("$100.00");
  });

  it("the ≈ hint is the DOLLAR counterpart of a riel total (display only)", () => {
    const t = priced(calculateCartTotals([line("water", khr(5000), 2)], NO_DISCOUNT));
    expect(approximateCounterpart(t.total)).toEqual(usd(244)); // 10,000 / 4,100
    // …and the riel counterpart of a dollar total, as before.
    expect(approximateCounterpart(usd(1000))).toEqual(khr(41000));
    // The authoritative value is untouched.
    expect(t.total).toEqual(khr(10000));
  });
});

// ── D–G. Discounts in the cart's own currency ────────────────────────────────

describe("D. USD percentage discount", () => {
  it("rounds half-up to the cent", () => {
    // 15% of $33.33 = 499.95¢ → 500¢.
    const t = priced(calculateCartTotals([line("a", usd(3333))], percent("15")));
    expect(t.discount).toEqual(usd(500));
    expect(t.total).toEqual(usd(2833));
  });

  it("accepts a trailing % sign and surrounding spaces", () => {
    const t = priced(calculateCartTotals([line("a", usd(1000))], percent(" 10% ")));
    expect(t.discount).toEqual(usd(100));
  });

  it("is never computed with floating-point drift", () => {
    // 7% of $10.05 = 70.35¢ → 70¢; 50% of 1¢ = 0.5¢ → 1¢ (half-up).
    expect(priced(calculateCartTotals([line("a", usd(1005))], percent("7"))).discount).toEqual(
      usd(70),
    );
    expect(priced(calculateCartTotals([line("a", usd(1))], percent("50"))).discount).toEqual(
      usd(1),
    );
  });
});

describe("E. KHR percentage discount", () => {
  it("is computed in riel, not cents", () => {
    const t = priced(calculateCartTotals([line("a", khr(5000), 2)], percent("15", "KHR")));
    expect(t.discount).toEqual(khr(1500));
    expect(t.total).toEqual(khr(8500));
  });

  it("rounds half-up to the riel", () => {
    // 15% of ៛10,010 = ៛1,501.5 → ៛1,502.
    const t = priced(calculateCartTotals([line("a", khr(10010))], percent("15", "KHR")));
    expect(t.discount).toEqual(khr(1502));
  });
});

describe("F. USD fixed discount", () => {
  it("parses dollars-and-cents into cents without float arithmetic", () => {
    const t = priced(calculateCartTotals([line("a", usd(5000))], amount("19.99", "USD")));
    expect(t.discount).toEqual(usd(1999));
    expect(t.total).toEqual(usd(3001));
  });

  it("keeps a half-typed amount working across re-renders", () => {
    // The input stores TEXT, so "2." is not reformatted to "2.00" mid-typing.
    const input = amount("2.", "USD");
    const first = calculateCartTotals([line("a", usd(5000))], input);
    const again = calculateCartTotals([line("a", usd(5000))], input);
    expect(priced(first).discount).toEqual(usd(200));
    expect(again).toEqual(first);
    expect(input.text).toBe("2.");
  });
});

describe("G. KHR fixed discount", () => {
  it("is whole riel — never multiplied into cents", () => {
    const t = priced(calculateCartTotals([line("a", khr(5000), 2)], amount("2,000", "KHR")));
    expect(t.discount).toEqual(khr(2000));
    expect(t.total).toEqual(khr(8000));
  });

  it("refuses decimals, because riel has none", () => {
    const t = priced(calculateCartTotals([line("a", khr(5000))], amount("10.50", "KHR")));
    expect(t.discountProblem).toBe("malformed");
    expect(t.discount).toEqual(khr(0));
    expect(checkoutBlock(t)).toBe("discount");
  });

  it("an amount typed for a USD cart is never applied to a KHR cart", () => {
    const t = priced(calculateCartTotals([line("a", khr(5000))], amount("5", "USD")));
    expect(t.discount).toEqual(khr(0));
    expect(t.discountProblem).toBeNull();
    expect(t.total).toEqual(khr(5000));
  });
});

describe("discount edge cases", () => {
  const cart = [line("a", usd(3000))];

  it("zero and empty discounts are no discount", () => {
    for (const input of [amount("", "USD"), amount("0", "USD"), percent("0"), percent("")]) {
      const t = priced(calculateCartTotals(cart, input));
      expect(t.discount).toEqual(usd(0));
      expect(t.discountProblem).toBeNull();
      expect(checkoutBlock(t)).toBeNull();
    }
  });

  it("a disabled discount is ignored whatever was typed", () => {
    const t = priced(calculateCartTotals(cart, { ...amount("999", "USD"), enabled: false }));
    expect(t.discount).toEqual(usd(0));
    expect(t.discountProblem).toBeNull();
  });

  it("the maximum valid discount is the whole subtotal (a zero total)", () => {
    expect(priced(calculateCartTotals(cart, amount("30.00", "USD"))).total).toEqual(usd(0));
    expect(priced(calculateCartTotals(cart, percent("100"))).total).toEqual(usd(0));
  });

  it("J. a discount above the subtotal is refused, never clamped and never negative", () => {
    const t = priced(calculateCartTotals(cart, amount("30.01", "USD")));
    expect(t.discountProblem).toBe("exceeds_subtotal");
    expect(t.discount).toEqual(usd(0));
    expect(t.total.amount).toBeGreaterThanOrEqual(0);
    expect(checkoutBlock(t)).toBe("discount");
  });

  it("a percent above 100 is refused", () => {
    const t = priced(calculateCartTotals(cart, percent("101")));
    expect(t.discountProblem).toBe("percent_out_of_range");
    expect(checkoutBlock(t)).toBe("discount");
  });

  it("malformed input is refused rather than guessed at", () => {
    for (const input of [
      amount("-5", "USD"),
      amount("abc", "USD"),
      amount("1.234", "USD"),
      amount("1e3", "USD"),
      amount("99999999999999999999", "USD"),
      percent("12.5"),
      percent("-10"),
      percent("ten"),
    ]) {
      const t = priced(calculateCartTotals(cart, input));
      expect(t.discountProblem).not.toBeNull();
      expect(t.discount).toEqual(usd(0));
      expect(t.total).toEqual(usd(3000));
    }
  });

  it("no input whatsoever yields a negative total", () => {
    const inputs = [
      ...["0", "1", "29.99", "30", "30.00", "30.01", "1000", "-1"].map((s) => amount(s, "USD")),
      ...["0", "1", "99", "100", "101", "1000"].map(percent),
    ];
    for (const input of inputs) {
      const t = priced(calculateCartTotals(cart, input));
      expect(t.total.amount).toBeGreaterThanOrEqual(0);
      expect(t.discount.amount).toBeLessThanOrEqual(t.subtotal.amount);
    }
  });

  it("each refusal names a reason the merchant can act on, in both languages", () => {
    const keys = [
      discountProblemKey("exceeds_subtotal", "amount", "USD"),
      discountProblemKey("malformed", "amount", "USD"),
      discountProblemKey("malformed", "amount", "KHR"),
      discountProblemKey("malformed", "percent", "USD"),
      discountProblemKey("percent_out_of_range", "percent", "KHR"),
    ];
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) {
      for (const locale of [en, km]) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as never)?.[k], locale);
        expect(typeof value).toBe("string");
      }
    }
  });
});

// ── H. Mixed-currency cart ───────────────────────────────────────────────────

describe("H. mixed-currency cart", () => {
  const mixed = [line("usd", usd(500)), line("khr", khr(5000), 2)];

  it("carries no total at all — nothing is summed or converted", () => {
    const t = calculateCartTotals(mixed, percent("10"));
    expect(t.kind).toBe("mixed_currency");
    expect(t).not.toHaveProperty("total");
    expect(t).not.toHaveProperty("subtotal");
    expect(t).not.toHaveProperty("discount");
    expect(t.itemCount).toBe(3);
    if (t.kind === "mixed_currency") expect(t.currencies).toEqual(["USD", "KHR"]);
  });

  it("blocks checkout", () => {
    expect(checkoutBlock(calculateCartTotals(mixed, NO_DISCOUNT))).toBe("mixed_currency");
  });

  it("the cart itself is preserved — removing one currency's lines restores a priced cart", () => {
    expect(cartCurrencies(mixed)).toEqual(["USD", "KHR"]);
    const t = priced(calculateCartTotals(mixed.slice(1), NO_DISCOUNT));
    expect(t.total).toEqual(khr(10000));
  });

  it("the server's own currency_mismatch is recognised from its message", () => {
    const err = Object.assign(
      new Error("All items must be priced in the organization's currency"),
      { statusCode: 409 },
    );
    expect(isOrderCurrencyMismatch(err)).toBe(true);
    expect(isOrderCurrencyMismatch(new Error("Order not found"))).toBe(false);
    expect(isOrderCurrencyMismatch("not an error")).toBe(false);
  });
});

// ── I. Mixed-currency / invalid checkout never reaches the server ────────────

describe("I. a refused cart never reaches createRealOrder", () => {
  const sheet = read("src/components/pos/PosCheckoutSheet.tsx");
  const completeReal = sheet.slice(
    sheet.indexOf("async function completeReal"),
    sheet.indexOf("const realConfirmed"),
  );

  it("completeReal returns before createRealOrder when the cart refuses checkout", () => {
    // Only while no order exists — a confirm retry for an order that already
    // exists is never blocked by the (now cleared) cart.
    const guard = completeReal.indexOf("if (!orderId && (!priced || block)) return;");
    const create = completeReal.indexOf("await createRealOrder(");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    // …and it is checked before the double-submit guard is taken.
    expect(completeReal.indexOf("submittingRef.current = true")).toBeGreaterThan(guard);
  });

  it("the prototype checkout refuses the same carts", () => {
    const complete = sheet.slice(
      sheet.indexOf("async function complete()"),
      sheet.indexOf("async function completeReal"),
    );
    const guard = complete.indexOf("if (!priced || block) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(complete.indexOf("createSale(")).toBeGreaterThan(guard);
  });

  it("the sheet's confirm footer is only offered for an unblocked cart", () => {
    expect(sheet).toMatch(/checkoutKind !== "unsellable" && block === null \?/);
    expect(sheet).toContain("<UnpricedCartNotice kind={totals.kind} />");
  });

  it("the discount sent is the cart's own minor units — no conversion on the way", () => {
    expect(completeReal).toMatch(/discountMinor: priced\.discount\.amount/);
    expect(completeReal).not.toMatch(/usdToKhr|khrToUsd|approximateCounterpart|KHR_PER_USD/);
  });

  it("every checkout button shares checkoutBlock", () => {
    const cart = read("src/components/pos/PosCart.tsx");
    const route = read("src/routes/app.pos.tsx");
    expect(cart).toMatch(/disabled=\{block !== null \|\| offline\}/);
    expect(route).toMatch(/disabled=\{block !== null \|\| offline\}/);
    expect(route).toMatch(/const block = checkoutBlock\(totals\)/);
  });
});

// ── K. The mock manager-approval rule is gone ───────────────────────────────

describe("K. no mock manager approval", () => {
  it("an Owner's large discount is not blocked by any client-side limit", () => {
    // 50% and $40 off were both above the removed mock "cashier limit" (20% / $10).
    for (const input of [percent("50"), amount("40.00", "USD")]) {
      const t = priced(calculateCartTotals([line("a", usd(8000))], input));
      expect(t.discountProblem).toBeNull();
      expect(checkoutBlock(t)).toBeNull();
    }
  });

  it("the mock rule and its constants no longer exist", () => {
    expect("needsManagerApproval" in posCart).toBe(false);
    expect("DISCOUNT_LIMIT_PERCENT" in posCart).toBe(false);
    expect("DISCOUNT_LIMIT_CENTS" in posCart).toBe(false);
    for (const file of [
      "src/lib/pos-cart.ts",
      "src/components/pos/PosCart.tsx",
      "src/routes/app.pos.tsx",
      "src/components/pos/PosCheckoutSheet.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/needsManagerApproval|approvalRequired|DISCOUNT_LIMIT/);
      expect(source).not.toMatch(/pos\.discount\.approval/);
    }
    expect(en.pos.discount).not.toHaveProperty("approval");
    expect(km.pos.discount).not.toHaveProperty("approval");
  });

  it("the real server authority is preserved: the discount control follows orders.apply_discount", () => {
    const route = read("src/routes/app.pos.tsx");
    expect(route).toMatch(/capabilities\.can\("orders\.apply_discount"\)/);
    // Without the grant no discount enters the totals at all.
    expect(route).toMatch(/calculateCartTotals\(lines, canDiscount \? discount : NO_DISCOUNT\)/);
    const cart = read("src/components/pos/PosCart.tsx");
    expect(cart).toMatch(/\{canDiscount && priced \?/);
    // …and the server still enforces it on every create.
    const service = read("src/server/orders/service.ts");
    expect(service).toMatch(
      /if \(discountMinor > 0\) \{\s*ctx\.require\("orders\.apply_discount"\);/,
    );
  });
});

// ── Display-only conversion, everywhere POS shows a total ───────────────────

describe("the ≈ hint is display-only and currency-aware", () => {
  it("no POS surface derives the hint by forcing a value into riel", () => {
    for (const file of [
      "src/components/pos/PosCart.tsx",
      "src/components/pos/PosCheckoutSheet.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/usdToKhr\(/);
      expect(source).toMatch(/approximateCounterpart\(/);
    }
  });

  it("the cart shows no total for a mixed cart — the cart bar shows a dash", () => {
    const route = read("src/routes/app.pos.tsx");
    expect(route).toMatch(/totals\.kind === "priced" \? formatMoney\(totals\.total\) : "—"/);
  });
});

// ── i18n ─────────────────────────────────────────────────────────────────────

describe("POS money copy exists in English and Khmer", () => {
  const keys = [
    "pos.discount.amountIn",
    "pos.discount.invalidUsd",
    "pos.discount.invalidKhr",
    "pos.discount.invalidPercent",
    "pos.discount.exceedsSubtotal",
    "pos.discount.blockedTitle",
    "pos.discount.fixShort",
    "pos.currency.mixedTitle",
    "pos.currency.mixedBody",
    "pos.currency.mixedShort",
    "pos.currency.serverMismatch.title",
    "pos.currency.serverMismatch.body",
  ];

  for (const key of keys) {
    it(`${key} is translated in both locales`, () => {
      const get = (locale: object) =>
        key.split(".").reduce<unknown>((o, k) => (o as never)?.[k], locale);
      const english = get(en);
      const khmer = get(km);
      expect(typeof english).toBe("string");
      expect(typeof khmer).toBe("string");
      expect(khmer).not.toBe(english);
      // Khmer copy is actually Khmer.
      expect(khmer as string).toMatch(/[ក-៿]/);
    });
  }

  it("the amount label keeps its currency placeholder", () => {
    expect(en.pos.discount.amountIn).toContain("{{currency}}");
    expect(km.pos.discount.amountIn).toContain("{{currency}}");
  });

  it("every pos.* key the POS money surfaces use resolves in both locales", () => {
    const sources = [
      "src/components/pos/PosCart.tsx",
      "src/components/pos/PosCheckoutSheet.tsx",
      "src/routes/app.pos.tsx",
    ].map(read);
    const used = new Set<string>();
    for (const source of sources) {
      for (const m of source.matchAll(/\bt\(\s*"(pos\.[A-Za-z.]+)"/g)) used.add(m[1]!);
      for (const m of source.matchAll(/"(pos\.(?:discount|currency)\.[A-Za-z.]+)"/g))
        used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    for (const key of used) {
      for (const locale of [en, km]) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as never)?.[k], locale);
        // A failure-copy prefix (`${failureKey}.title` / `.body`) resolves to
        // both; a notice prefix (`${copy}Title` / `${copy}Body`) likewise.
        const lookup = (k: string) =>
          k.split(".").reduce<unknown>((o, part) => (o as never)?.[part], locale);
        const resolved =
          typeof value === "string" ||
          (typeof (value as { title?: unknown })?.title === "string" &&
            typeof (value as { body?: unknown })?.body === "string") ||
          (typeof lookup(`${key}Title`) === "string" && typeof lookup(`${key}Body`) === "string");
        expect({ key, resolved }).toEqual({ key, resolved: true });
      }
    }
  });
});
