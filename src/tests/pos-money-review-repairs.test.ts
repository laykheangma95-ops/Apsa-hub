/**
 * PR #117 independent-review repairs — pure-layer coverage.
 *
 *   P2 #1  posCartReducer clears the discount on every currency-context change
 *   P2 #2  parseDiscountAmount: strict, POS-local grammar (accepted/refused matrix)
 *   P2 #3  idempotency key holder: a late response releases only its own key
 *   P3     exact (BigInt) cart arithmetic and the MAX_CART_MINOR boundary
 *
 * The same behaviours are driven through the mounted <PosScreen> in
 * src/tests/pos-money-mounted.runtime.ts.
 *
 * Run: bun test src/tests/pos-money-review-repairs.test.ts
 */
import { describe, expect, it } from "bun:test";
import { createIdempotencyKeyHolder } from "@/lib/idempotency";
import { khr, parseMinorUnits, usd } from "@/lib/money";
import {
  calculateCartTotals,
  cartCurrencyContext,
  checkoutBlock,
  EMPTY_POS_CART,
  lineKey,
  lineTotal,
  MAX_CART_MINOR,
  NO_DISCOUNT,
  parseDiscountAmount,
  posCartReducer,
  type CartDiscountInput,
  type CartLine,
  type PosCartAction,
  type PosCartState,
} from "@/lib/pos-cart";
import type { Money } from "@/types";

function line(id: string, unitPrice: Money, quantity = 1): CartLine {
  return {
    key: lineKey(id),
    productId: id,
    nameKm: "ផលិតផល",
    nameEn: id,
    sku: id,
    quantity,
    unitPrice,
    stock: null,
  };
}

const SERUM = line("serum", usd(2000));
const TONER = line("toner", usd(3000));
const WATER = line("water", khr(5000));
const RICE = line("rice", khr(100000));

function run(...actions: PosCartAction[]): PosCartState {
  return actions.reduce(posCartReducer, EMPTY_POS_CART);
}
const add = (l: CartLine): PosCartAction => ({ type: "add", line: l });
const remove = (l: CartLine): PosCartAction => ({ type: "remove", key: l.key });
const discount = (mode: "amount" | "percent", text: string): PosCartAction => ({
  type: "discount",
  discount: { enabled: true, mode, text, currency: null },
});

function totalsOf(state: PosCartState) {
  return calculateCartTotals(state.lines, state.discount);
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 — a discount belongs to the currency context it was entered for
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #1: posCartReducer clears the discount on a currency-context change", () => {
  it("stamps the cart's own currency on a discount, whatever the caller passed", () => {
    const s = run(add(SERUM), {
      type: "discount",
      discount: { enabled: true, mode: "amount", text: "5", currency: "KHR" },
    });
    expect(s.discount.currency).toBe("USD");
    expect(totalsOf(s)).toMatchObject({ discount: usd(500), total: usd(1500) });
  });

  it("refuses to hold a discount for an empty or mixed cart", () => {
    expect(run(discount("amount", "5")).discount).toEqual(NO_DISCOUNT);
    expect(run(add(SERUM), add(WATER), discount("percent", "10")).discount).toEqual(NO_DISCOUNT);
  });

  const cases: [string, PosCartAction[]][] = [
    ["A. USD fixed → KHR", [add(SERUM), discount("amount", "5"), add(WATER), remove(SERUM)]],
    ["B. KHR fixed → USD", [add(RICE), discount("amount", "2,000"), add(SERUM), remove(RICE)]],
    ["C. USD percent → KHR", [add(SERUM), discount("percent", "50"), add(WATER), remove(SERUM)]],
    ["D. KHR percent → USD", [add(WATER), discount("percent", "10"), add(SERUM), remove(WATER)]],
    ["E. single → mixed", [add(SERUM), discount("amount", "5"), add(WATER)]],
    ["F. mixed → single", [add(SERUM), discount("amount", "5"), add(WATER), remove(WATER)]],
    ["G. empty → new currency", [add(SERUM), discount("amount", "5"), remove(SERUM), add(WATER)]],
    ["G'. empty → SAME currency", [add(SERUM), discount("amount", "5"), remove(SERUM), add(TONER)]],
    ["reset", [add(SERUM), discount("amount", "5"), { type: "reset" }, add(SERUM)]],
  ];
  for (const [label, actions] of cases) {
    it(`${label}: the discount is cleared, not kept dormant`, () => {
      const s = run(...actions);
      expect(s.discount).toEqual(NO_DISCOUNT);
      const t = totalsOf(s);
      if (t.kind === "priced") expect(t.discount.amount).toBe(0);
    });
  }

  it("the full review sequence never reactivates the old $5", () => {
    let s = run(add(SERUM), discount("amount", "5"));
    expect(totalsOf(s)).toMatchObject({ total: usd(1500) });
    for (const step of [add(WATER), remove(SERUM), add(TONER), remove(WATER)]) {
      s = posCartReducer(s, step);
      expect(s.discount).toEqual(NO_DISCOUNT);
    }
    expect(totalsOf(s)).toMatchObject({ subtotal: usd(3000), total: usd(3000) });
  });

  it("H. same-currency changes keep it; the change that alters the currency clears it", () => {
    let s = run(add(SERUM), discount("amount", "5"));
    s = posCartReducer(s, { type: "quantity", key: SERUM.key, quantity: 3 });
    s = posCartReducer(s, add(TONER));
    expect(totalsOf(s)).toMatchObject({ subtotal: usd(9000), discount: usd(500) });
    s = posCartReducer(s, remove(TONER));
    expect(totalsOf(s)).toMatchObject({ discount: usd(500) });
    s = posCartReducer(s, add(WATER));
    expect(s.discount).toEqual(NO_DISCOUNT);
  });

  it("I. replaying the same state (a re-render) is stable and cannot resurrect anything", () => {
    const s = run(add(SERUM), discount("amount", "5"), add(WATER), remove(WATER));
    expect(calculateCartTotals(s.lines, s.discount)).toEqual(
      calculateCartTotals(s.lines, s.discount),
    );
    expect(s.discount).toEqual(NO_DISCOUNT);
  });

  it("backstop: a discount stamped for another currency is never applied, in either mode", () => {
    for (const mode of ["amount", "percent"] as const) {
      const stale: CartDiscountInput = { enabled: true, mode, text: "5", currency: "USD" };
      const t = calculateCartTotals([WATER], stale);
      expect(t).toMatchObject({ kind: "priced", discount: khr(0), total: khr(5000) });
      const unstamped: CartDiscountInput = { ...stale, currency: null };
      expect(calculateCartTotals([SERUM], unstamped)).toMatchObject({ discount: usd(0) });
    }
  });

  it("the currency context distinguishes empty, each currency and mixed", () => {
    expect(cartCurrencyContext([])).toBe("");
    expect(cartCurrencyContext([SERUM, TONER])).toBe("USD");
    expect(cartCurrencyContext([WATER])).toBe("KHR");
    expect(cartCurrencyContext([SERUM, WATER])).toBe(cartCurrencyContext([WATER, SERUM]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #2 — strict discount-amount grammar
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #2: parseDiscountAmount accepts only unambiguous amounts", () => {
  const accepted: [string, "USD" | "KHR", number][] = [
    ["15", "USD", 1500],
    ["15.5", "USD", 1550],
    ["15.50", "USD", 1550],
    ["15.", "USD", 1500],
    ["0.05", "USD", 5],
    ["2,000", "USD", 200000],
    ["2,000.50", "USD", 200050],
    ["1,234,567.89", "USD", 123456789],
    [" 15 ", "USD", 1500],
    ["15000", "KHR", 15000],
    ["15,000", "KHR", 15000],
    ["2,000", "KHR", 2000],
    ["1,000,000", "KHR", 1000000],
    ["0", "KHR", 0],
  ];
  for (const [text, currency, minor] of accepted) {
    it(`${currency} "${text}" → ${minor}`, () => {
      expect(parseDiscountAmount(text, currency)).toBe(minor);
    });
  }

  const refusedBoth = [
    "1,5",
    "1,,5",
    ",15",
    "15,",
    "1,00",
    "2,00,0",
    "2,000,00",
    "0,500",
    "1.2.3",
    "1..5",
    "-5",
    "+5",
    "5$",
    "$5",
    "1e3",
    "1 000",
    "abc",
    "",
    ".",
    ".5",
    "15.500",
    "١٥", // non-ASCII digits
    "១៥", // Khmer digits
  ];
  for (const text of refusedBoth) {
    for (const currency of ["USD", "KHR"] as const) {
      it(`${currency} "${text}" is refused`, () => {
        expect(parseDiscountAmount(text, currency)).toBeNull();
      });
    }
  }

  for (const text of ["10.50", "1.5", "15.", "1,000.5"]) {
    it(`KHR "${text}" is refused — riel has no fractional unit`, () => {
      expect(parseDiscountAmount(text, "KHR")).toBeNull();
    });
  }

  it("refuses anything above MAX_CART_MINOR, and accepts MAX_CART_MINOR itself", () => {
    expect(parseDiscountAmount(String(MAX_CART_MINOR), "KHR")).toBe(MAX_CART_MINOR);
    expect(parseDiscountAmount(String(MAX_CART_MINOR + 1), "KHR")).toBeNull();
    expect(parseDiscountAmount("90071992547409.91", "USD")).toBe(MAX_CART_MINOR);
    expect(parseDiscountAmount("90071992547409.92", "USD")).toBeNull();
    expect(parseDiscountAmount("99999999999999999999", "USD")).toBeNull();
  });

  it("the shared parseMinorUnits is untouched (other callers keep their semantics)", () => {
    // The strictness is POS-local by design; this pins that the shared parser
    // was not globally changed under every other caller.
    expect(parseMinorUnits("1,5", "USD")).toBe(1500);
    expect(parseMinorUnits("19.99", "USD")).toBe(1999);
  });

  it("a refused amount is never applied by the cart, and blocks checkout", () => {
    const t = calculateCartTotals([line("x", usd(100000))], {
      enabled: true,
      mode: "amount",
      text: "1,5",
      currency: "USD",
    });
    expect(t).toMatchObject({ kind: "priced", discount: usd(0), discountProblem: "malformed" });
    expect(checkoutBlock(t)).toBe("discount");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #3 — a late response releases only the idempotency key it used
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #3: IdempotencyKeyHolder.release(key)", () => {
  it("a late response for an old key leaves a newer attempt's key held", () => {
    let n = 0;
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`);
    const old = holder.keyFor("usd-cart");
    const current = holder.keyFor("khr-cart"); // a newer attempt
    holder.release(old); // the old request finally answers
    expect(holder.keyFor("khr-cart")).toBe(current); // a retry still re-sends it
  });

  it("releasing the held key forgets it; no-argument release keeps its old meaning", () => {
    let n = 0;
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`);
    const a = holder.keyFor("cart");
    holder.release(a);
    const b = holder.keyFor("cart");
    expect(b).not.toBe(a);
    holder.release();
    expect(holder.keyFor("cart")).not.toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P3 — exact arithmetic: 0 ≤ discount ≤ subtotal, total = subtotal − discount ≥ 0
// ═══════════════════════════════════════════════════════════════════════════

describe("P3: exact cart arithmetic at the safe-integer boundary", () => {
  const percentInput = (p: number): CartDiscountInput => ({
    enabled: true,
    mode: "percent",
    text: String(p),
    currency: "USD",
  });

  it("the independently reproduced case: 100% of 9,006,988,797,149,282 is exactly the subtotal", () => {
    const subtotal = 9_006_988_797_149_282;
    const t = calculateCartTotals([line("x", usd(subtotal))], percentInput(100));
    expect(t).toMatchObject({
      kind: "priced",
      subtotal: usd(subtotal),
      discount: usd(subtotal),
      total: usd(0),
    });
  });

  const boundary = [
    MAX_CART_MINOR,
    MAX_CART_MINOR - 1,
    9_006_988_797_149_282,
    4_503_599_627_370_497, // 2^52 + 1
    123_456_789_012_345,
    1,
    0,
  ];
  for (const subtotal of boundary) {
    it(`every whole percent of ${subtotal} keeps the invariant exactly`, () => {
      for (let p = 0; p <= 100; p++) {
        const t = calculateCartTotals([line("x", usd(subtotal))], percentInput(p));
        if (t.kind !== "priced") throw new Error(`unexpected ${t.kind}`);
        const s = BigInt(t.subtotal.amount);
        const d = BigInt(t.discount.amount);
        const total = BigInt(t.total.amount);
        expect(s).toBe(BigInt(subtotal));
        expect(d >= 0n && d <= s).toBe(true);
        expect(total).toBe(s - d);
        expect(total >= 0n).toBe(true);
        expect(d).toBe((BigInt(subtotal) * BigInt(p) + 50n) / 100n);
        for (const v of [t.subtotal.amount, t.discount.amount, t.total.amount]) {
          expect(Number.isSafeInteger(v)).toBe(true);
        }
      }
    });
  }

  it("a fixed discount equal to a boundary subtotal yields exactly zero", () => {
    const t = calculateCartTotals([line("x", khr(MAX_CART_MINOR))], {
      enabled: true,
      mode: "amount",
      text: String(MAX_CART_MINOR),
      currency: "KHR",
    });
    expect(t).toMatchObject({ kind: "priced", discount: khr(MAX_CART_MINOR), total: khr(0) });
  });

  it("a subtotal past MAX_CART_MINOR is not priced and cannot check out", () => {
    // 3,002,399,751,580,331 × 3 = 9,007,199,254,740,993 = MAX + 2.
    const unit = 3_002_399_751_580_331;
    const atBound = calculateCartTotals(
      [line("x", usd(unit), 2), line("y", usd(3_002_399_751_580_329))],
      NO_DISCOUNT,
    );
    expect(atBound).toMatchObject({ kind: "priced", total: usd(MAX_CART_MINOR) });
    const over = calculateCartTotals([line("x", usd(unit), 3)], NO_DISCOUNT);
    expect(over).toEqual({ kind: "out_of_range", currency: "USD", itemCount: 3 });
    expect(over).not.toHaveProperty("total");
    expect(checkoutBlock(over)).toBe("out_of_range");
    // Two lines each safe, summing past the bound.
    const sum = calculateCartTotals(
      [line("a", khr(MAX_CART_MINOR)), line("b", khr(1))],
      NO_DISCOUNT,
    );
    expect(sum.kind).toBe("out_of_range");
  });

  it("a line total is computed exactly (no float rounding of price × quantity)", () => {
    expect(lineTotal(line("x", usd(3_002_399_751_580_330), 3)).amount).toBe(
      Number(3_002_399_751_580_330n * 3n),
    );
    expect(lineTotal(line("x", khr(5000), 2))).toEqual(khr(10000));
  });

  it("ordinary USD and KHR results are unchanged", () => {
    expect(calculateCartTotals([line("a", usd(3333))], percentInput(15))).toMatchObject({
      discount: usd(500),
      total: usd(2833),
    });
    expect(
      calculateCartTotals([line("w", khr(5000), 2)], {
        enabled: true,
        mode: "percent",
        text: "15",
        currency: "KHR",
      }),
    ).toMatchObject({ subtotal: khr(10000), discount: khr(1500), total: khr(8500) });
  });
});
