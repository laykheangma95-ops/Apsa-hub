/**
 * POS stock → cart quantity invariant (V1 P2: null stock capped every line at 1).
 *
 * What `Product.stock === null` means in APSA today: the production catalog
 * read (mapServerProductToUi) never carries an inventory figure — inventory is
 * its own domain — so POS holds NO stock number for a real product. The server
 * does not cap a sale by stock either: createOrder/create_order_v2 accept any
 * positive integer quantity, and confirming writes one 'sale' movement of the
 * persisted quantity with no availability check (migration 026 keeps the
 * ledger's negative-balance policy). So null must never become a cart cap.
 *
 * A finite figure (the /design mock catalog) is a real cap, and 0 is "none
 * left" — never "unlimited".
 *
 * Every test drives the same reducer every POS path dispatches through
 * (tap, variant sheet, scan, stepper).
 */
import { describe, expect, it } from "bun:test";
import {
  availableStock,
  calculateCartTotals,
  checkoutBlock,
  EMPTY_POS_CART,
  lineQuantityLimit,
  NO_DISCOUNT,
  POS_MAX_LINE_QUANTITY,
  posCartReducer,
  stockState,
  type CartLine,
  type PosCartAction,
  type PosCartState,
} from "@/lib/pos-cart";
import type { Product } from "@/types";

const PRODUCT_ID = "3f2504e0-4f89-41d3-9a0c-0000000000a1";
const VARIANT_ID = "3f2504e0-4f89-41d3-9a0c-0000000001a1";

function product(stock: number | null, extra: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    nameKm: "សេរ៉ូម",
    nameEn: "Serum",
    sku: "SKU-1",
    price: { amount: 2000, currency: "USD" },
    stock,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: VARIANT_ID,
    ...extra,
  };
}

/** The line POS builds when a product is tapped / scanned / added from the sheet. */
function lineFor(p: Product, quantity = 1, variant?: { id: string; name: string }): CartLine {
  return {
    key: variant ? `${p.id}::${variant.id}` : p.id,
    productId: p.id,
    variantId: variant?.id ?? p.variantId,
    nameKm: p.nameKm,
    nameEn: p.nameEn,
    sku: p.sku,
    ...(variant ? { variant: variant.name } : {}),
    quantity,
    unitPrice: p.price,
    stock: availableStock(p),
  };
}

function run(...actions: PosCartAction[]): PosCartState {
  return actions.reduce(posCartReducer, EMPTY_POS_CART);
}

const add = (line: CartLine): PosCartAction => ({ type: "add", line });
const qty = (key: string, quantity: number): PosCartAction => ({
  type: "quantity",
  key,
  quantity,
});

function quantities(state: PosCartState): number[] {
  return state.lines.map((l) => l.quantity);
}

describe("A. null stock (production: POS holds no stock figure) never caps the cart", () => {
  const p = product(null);

  it("availableStock reports 'no figure', not a number a cap can be made from", () => {
    expect(availableStock(p)).toBeNull();
    expect(stockState(p)).toBe("available");
  });

  it("add once → 1", () => {
    expect(quantities(run(add(lineFor(p))))).toEqual([1]);
  });

  it("increment to 2 with the stepper", () => {
    expect(quantities(run(add(lineFor(p)), qty(p.id, 2)))).toEqual([2]);
  });

  it("increment repeatedly (rapid +) reaches 5, then 20", () => {
    let state = run(add(lineFor(p)));
    for (let q = 2; q <= 20; q++) {
      state = posCartReducer(state, qty(p.id, q));
      if (q === 5) expect(quantities(state)).toEqual([5]);
    }
    expect(quantities(state)).toEqual([20]);
  });

  it("direct quantity (setQuantity to 5 in one action)", () => {
    expect(quantities(run(add(lineFor(p)), qty(p.id, 5)))).toEqual([5]);
  });

  it("the same SKU tapped repeatedly (double add / repeat scan) increments", () => {
    expect(quantities(run(add(lineFor(p)), add(lineFor(p)), add(lineFor(p))))).toEqual([3]);
  });

  it("adding a quantity > 1 from the variant sheet keeps it", () => {
    expect(quantities(run(add(lineFor(p, 4))))).toEqual([4]);
    expect(quantities(run(add(lineFor(p, 4)), add(lineFor(p, 3))))).toEqual([7]);
  });

  it("remove and re-add starts fresh at the added quantity, then grows", () => {
    const state = run(
      add(lineFor(p)),
      qty(p.id, 6),
      { type: "remove", key: p.id },
      add(lineFor(p)),
    );
    expect(quantities(state)).toEqual([1]);
    expect(quantities(posCartReducer(state, qty(p.id, 3)))).toEqual([3]);
  });
});

describe("C. zero stock stays distinct from null — never 'unlimited'", () => {
  const p = product(0);

  it("availableStock is 0 and the product shows out of stock", () => {
    expect(availableStock(p)).toBe(0);
    expect(stockState(p)).toBe("out_of_stock");
  });

  it("a zero-stock line cannot enter the cart", () => {
    expect(run(add(lineFor(p))).lines).toEqual([]);
    expect(run(add(lineFor(p, 5))).lines).toEqual([]);
  });

  it("fully reserved stock (stock − reserved = 0) cannot enter the cart either", () => {
    expect(availableStock(product(3, { reserved: 3 }))).toBe(0);
    expect(run(add(lineFor(product(3, { reserved: 3 })))).lines).toEqual([]);
  });
});

describe("D/E. finite stock is a real cap", () => {
  it("stock = 1 caps at 1 (stepper and repeat add)", () => {
    const p = product(1);
    expect(quantities(run(add(lineFor(p)), qty(p.id, 2)))).toEqual([1]);
    expect(quantities(run(add(lineFor(p)), add(lineFor(p))))).toEqual([1]);
  });

  it("stock = 5 allows exactly 5 and refuses 6", () => {
    const p = product(5);
    expect(quantities(run(add(lineFor(p)), qty(p.id, 5)))).toEqual([5]);
    expect(quantities(run(add(lineFor(p)), qty(p.id, 6)))).toEqual([5]);
    const sixTaps = Array.from({ length: 6 }, () => add(lineFor(p)));
    expect(quantities(run(...sixTaps))).toEqual([5]);
    expect(quantities(run(add(lineFor(p, 6))))).toEqual([5]);
  });

  it("reserved units are not sellable: stock 5, reserved 2 → cap 3", () => {
    const p = product(5, { reserved: 2 });
    expect(availableStock(p)).toBe(3);
    expect(quantities(run(add(lineFor(p)), qty(p.id, 9)))).toEqual([3]);
  });
});

describe("no NaN / Infinity / negative / fractional quantity ever reaches a line", () => {
  for (const stock of [null, 5] as const) {
    const p = product(stock);
    for (const bad of [Number.NaN, Infinity, -Infinity, 2.5, -3, 0]) {
      it(`stock ${String(stock)}: setQuantity(${bad}) leaves a positive integer`, () => {
        const state = run(add(lineFor(p)), qty(p.id, 3), qty(p.id, bad));
        const [q] = quantities(state);
        expect(Number.isSafeInteger(q)).toBe(true);
        expect(q).toBeGreaterThanOrEqual(1);
        // A non-number is ignored, never coerced into a reset to 1.
        if (!Number.isFinite(bad) || !Number.isInteger(bad)) expect(q).toBe(3);
      });
    }
    it(`stock ${String(stock)}: an add carrying a non-positive or non-integer quantity is refused`, () => {
      for (const bad of [Number.NaN, 0, -1, 1.5, Infinity]) {
        expect(run(add(lineFor(p, bad))).lines).toEqual([]);
      }
    });
  }
});

describe("F. variants: each variant line keeps its own quantity", () => {
  const red = { id: "3f2504e0-4f89-41d3-9a0c-0000000001b1", name: "Red" };
  const blue = { id: "3f2504e0-4f89-41d3-9a0c-0000000001b2", name: "Blue" };

  it("product without variants, null stock → quantity > 1", () => {
    const p = product(null);
    expect(quantities(run(add(lineFor(p)), qty(p.id, 4)))).toEqual([4]);
  });

  it("variant with null stock → quantity > 1, independent per variant", () => {
    const p = product(null);
    const state = run(
      add(lineFor(p, 1, red)),
      add(lineFor(p, 1, blue)),
      qty(`${p.id}::${red.id}`, 5),
      add(lineFor(p, 1, blue)),
    );
    expect(state.lines.map((l) => [l.variant, l.quantity])).toEqual([
      ["Red", 5],
      ["Blue", 2],
    ]);
  });

  it("variant with zero stock never enters; stock 1 caps; stock > 1 allows it", () => {
    expect(run(add(lineFor(product(0), 1, red))).lines).toEqual([]);
    const one = product(1);
    expect(quantities(run(add(lineFor(one, 1, red)), qty(`${one.id}::${red.id}`, 3)))).toEqual([1]);
    const many = product(4);
    expect(quantities(run(add(lineFor(many, 1, red)), qty(`${many.id}::${red.id}`, 4)))).toEqual([
      4,
    ]);
  });

  it("switching variant does not reset or cap the other line", () => {
    const p = product(null);
    const state = run(
      add(lineFor(p, 3, red)),
      add(lineFor(p, 1, blue)),
      { type: "remove", key: `${p.id}::${blue.id}` },
      add(lineFor(p, 2, blue)),
    );
    expect(state.lines.map((l) => [l.variant, l.quantity])).toEqual([
      ["Red", 3],
      ["Blue", 2],
    ]);
  });
});

describe("G/H/I. money still follows authoritative price × quantity (PR #117 intact)", () => {
  it("G. USD: null-stock quantity 5 × $20.00 = $100.00", () => {
    const p = product(null);
    const state = run(add(lineFor(p)), qty(p.id, 5));
    const totals = calculateCartTotals(state.lines, NO_DISCOUNT);
    expect(totals).toMatchObject({
      kind: "priced",
      currency: "USD",
      subtotal: { amount: 10000, currency: "USD" },
      total: { amount: 10000, currency: "USD" },
      itemCount: 5,
    });
    expect(checkoutBlock(totals)).toBeNull();
  });

  it("H. KHR: null-stock quantity 5 × ៛5,000 = ៛25,000 (whole riel)", () => {
    const p = product(null, { price: { amount: 5000, currency: "KHR" } });
    const state = run(add(lineFor(p)), qty(p.id, 5));
    const totals = calculateCartTotals(state.lines, NO_DISCOUNT);
    expect(totals).toMatchObject({
      kind: "priced",
      currency: "KHR",
      subtotal: { amount: 25000, currency: "KHR" },
      total: { amount: 25000, currency: "KHR" },
      itemCount: 5,
    });
  });

  it("I. a mixed USD + KHR cart with quantities > 1 is still refused, with no total", () => {
    const usd = product(null);
    const khr = product(null, {
      id: "3f2504e0-4f89-41d3-9a0c-0000000000c1",
      variantId: "3f2504e0-4f89-41d3-9a0c-0000000001c1",
      price: { amount: 5000, currency: "KHR" },
    });
    const state = run(add(lineFor(usd)), qty(usd.id, 3), add(lineFor(khr)), qty(khr.id, 4));
    const totals = calculateCartTotals(state.lines, NO_DISCOUNT);
    expect(quantities(state)).toEqual([3, 4]);
    expect(totals.kind).toBe("mixed_currency");
    expect("subtotal" in totals).toBe(false);
    expect(checkoutBlock(totals)).toBe("mixed_currency");
  });

  it("a fixed discount is kept across a null-stock quantity change in the same currency", () => {
    const p = product(null);
    let state = run(add(lineFor(p)));
    state = posCartReducer(state, {
      type: "discount",
      discount: { enabled: true, mode: "amount", text: "5", currency: null },
    });
    state = posCartReducer(state, qty(p.id, 5));
    const totals = calculateCartTotals(state.lines, state.discount);
    expect(totals).toMatchObject({
      kind: "priced",
      subtotal: { amount: 10000 },
      discount: { amount: 500 },
      total: { amount: 9500 },
    });
  });
});

describe("one POS line limit (999) on every reducer path — an order-entry limit, not stock", () => {
  const nul = product(null);

  it("the limit is 999, and the per-line limit is min(999, known stock)", () => {
    expect(POS_MAX_LINE_QUANTITY).toBe(999);
    expect(lineQuantityLimit(null)).toBe(999);
    expect(lineQuantityLimit(0)).toBe(0);
    expect(lineQuantityLimit(1)).toBe(1);
    expect(lineQuantityLimit(5)).toBe(5);
    expect(lineQuantityLimit(999)).toBe(999);
    expect(lineQuantityLimit(1000)).toBe(999);
    expect(lineQuantityLimit(5000)).toBe(999);
    // Never reported as availability: null stays "no figure".
    expect(availableStock(nul)).toBeNull();
  });

  it("null stock: 998 adds → 998, +1 → 999, +1 → still 999; 1,000 never exists", () => {
    let state = run(...Array.from({ length: 998 }, () => add(lineFor(nul))));
    expect(quantities(state)).toEqual([998]);
    state = posCartReducer(state, add(lineFor(nul)));
    expect(quantities(state)).toEqual([999]);
    for (let i = 0; i < 10; i++) state = posCartReducer(state, add(lineFor(nul)));
    expect(quantities(state)).toEqual([999]);
  });

  it("a first add or a bulk add above the limit is held at 999", () => {
    expect(quantities(run(add(lineFor(nul, 1005))))).toEqual([999]);
    expect(quantities(run(add(lineFor(nul, 500)), add(lineFor(nul, 600))))).toEqual([999]);
  });

  it("finite stock: 0 never enters; 1 → 1; 5 → 5; 999 → 999; 1,000 and 5,000 → 999", () => {
    expect(run(add(lineFor(product(0), 5))).lines).toEqual([]);
    for (const [stock, max] of [
      [1, 1],
      [5, 5],
      [999, 999],
      [1000, 999],
      [5000, 999],
    ] as const) {
      const p = product(stock);
      expect(quantities(run(add(lineFor(p, 1005))))).toEqual([max]);
      expect(quantities(run(add(lineFor(p)), qty(p.id, 1005)))).toEqual([max]);
    }
  });

  it("stepper boundary: 999 → 998 → 999 → (999)", () => {
    let state = run(add(lineFor(nul, 999)));
    state = posCartReducer(state, qty(nul.id, 998));
    expect(quantities(state)).toEqual([998]);
    state = posCartReducer(state, qty(nul.id, 999));
    expect(quantities(state)).toEqual([999]);
    state = posCartReducer(state, qty(nul.id, 1000));
    expect(quantities(state)).toEqual([999]);
  });

  it("setter values on a 500 line: 999 → 999; 1,000 / 1,005 → 999; NaN/∞/1.5 ignored; 0/−1 → 1 (pre-existing)", () => {
    const at500 = () => run(add(lineFor(nul, 500)));
    const after = (q: number) => quantities(posCartReducer(at500(), qty(nul.id, q)))[0];
    expect(after(999)).toBe(999);
    expect(after(1000)).toBe(999);
    expect(after(1005)).toBe(999);
    expect(after(Number.NaN)).toBe(500);
    expect(after(Infinity)).toBe(500);
    expect(after(1.5)).toBe(500);
    // Pre-existing (unchanged here): a non-positive integer resets to 1.
    expect(after(0)).toBe(1);
    expect(after(-1)).toBe(1);
  });

  it("totals at the boundary are exact integers: USD $19,960 / $19,980; KHR ៛4,990,000 / ៛4,995,000", () => {
    const totalAt = (p: Product, n: number) =>
      calculateCartTotals(run(add(lineFor(p, n))).lines, NO_DISCOUNT);
    expect(totalAt(nul, 998)).toMatchObject({ kind: "priced", total: { amount: 1_996_000 } });
    expect(totalAt(nul, 999)).toMatchObject({ kind: "priced", total: { amount: 1_998_000 } });
    expect(totalAt(nul, 1005)).toMatchObject({ kind: "priced", total: { amount: 1_998_000 } });
    const riel = product(null, { price: { amount: 5000, currency: "KHR" } });
    expect(totalAt(riel, 998)).toMatchObject({ total: { amount: 4_990_000, currency: "KHR" } });
    expect(totalAt(riel, 1005)).toMatchObject({ total: { amount: 4_995_000, currency: "KHR" } });
  });
});
