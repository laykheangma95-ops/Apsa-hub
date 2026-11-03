/**
 * POS scan feedback: the "added" notice and the accepted-scan sound follow only
 * an add the cart actually accepted.
 *
 * The defect (PR #144 review): the route dispatched the add and then beeped and
 * said "Added to cart" unconditionally, but addToCart returns the cart
 * unchanged for a variant with no unit left or a line already at its limit —
 * a false confirmation, now audible.
 *
 * resolvePosScan is driven here with the REAL posCartReducer behind a store
 * that behaves like the route's (a ref advanced synchronously on every
 * dispatch). Only the lookup and the sound are fakes.
 */
import { describe, expect, it } from "bun:test";
import type { BarcodeLookupResult } from "@/lib/api";
import {
  EMPTY_POS_CART,
  posCartReducer,
  proposeAddOne,
  type CartLine,
  type PosCartAction,
  type PosCartState,
} from "@/lib/pos-cart";
import { resolvePosScan, scannedCartLine, type PosScanResult } from "@/lib/pos-scan";
import type { Product } from "@/types";

const USD = (amount: number) => ({ amount, currency: "USD" as const });

function product(id: string, stock: number | null, reserved = 0): Product {
  return {
    id,
    nameKm: `km-${id}`,
    nameEn: `en-${id}`,
    sku: `SKU-${id}`,
    price: USD(1000),
    stock,
    reserved,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: `v-${id}`,
  } as Product;
}

function lookupResult(p: Product): BarcodeLookupResult {
  return {
    product: p,
    variant: { id: `v-${p.id}`, sku: null, barcode: null, name: "", price: USD(1000) },
  };
}

/** The route's cart: a ref advanced by the same pure reducer on every dispatch. */
function store(initial: PosCartState = EMPTY_POS_CART) {
  let state = initial;
  return {
    read: () => state,
    dispatch: (action: PosCartAction) => {
      state = posCartReducer(state, action);
    },
  };
}

function harness(catalog: Record<string, Product | "throw">, initial?: PosCartState) {
  const cart = store(initial);
  let beeps = 0;
  const scan = (code: string): Promise<PosScanResult> =>
    resolvePosScan(code, {
      lookup: async (c) => {
        const hit = catalog[c];
        if (hit === "throw") throw new Error("network");
        return hit ? lookupResult(hit) : null;
      },
      readCart: cart.read,
      dispatch: cart.dispatch,
      playAccepted: () => {
        beeps += 1;
      },
    });
  const qty = (p: Product) => cart.read().lines.find((l) => l.productId === p.id)?.quantity ?? 0;
  return { scan, qty, beeps: () => beeps, cart };
}

describe("accepted scans add one unit and request one sound", () => {
  it("a normal scan adds one unit and beeps once", async () => {
    const serum = product("serum", null);
    const h = harness({ "111": serum });
    expect(await h.scan("111")).toEqual({ kind: "added", label: "en-serum" });
    expect(h.qty(serum)).toBe(1);
    expect(h.beeps()).toBe(1);
  });

  it("a second scan increments the same variant and beeps once more", async () => {
    const serum = product("serum", 5);
    const h = harness({ "111": serum });
    await h.scan("111");
    expect((await h.scan(" 111 ")).kind).toBe("added");
    expect(h.cart.read().lines).toHaveLength(1);
    expect(h.qty(serum)).toBe(2);
    expect(h.beeps()).toBe(2);
  });
});

describe("refused scans change nothing and stay silent", () => {
  it("zero available stock: no line, no sound, a limit notice", async () => {
    const soldout = product("soldout", 0);
    const h = harness({ "000": soldout });
    const before = h.cart.read();
    expect(await h.scan("000")).toEqual({ kind: "limit", label: "en-soldout" });
    expect(h.cart.read()).toBe(before);
    expect(h.beeps()).toBe(0);
  });

  it("every unit reserved counts as zero available", async () => {
    const held = product("held", 3, 3);
    const h = harness({ "333": held });
    expect((await h.scan("333")).kind).toBe("limit");
    expect(h.qty(held)).toBe(0);
    expect(h.beeps()).toBe(0);
  });

  it("a line already at its stock limit: unchanged, no sound", async () => {
    const single = product("single", 1);
    const h = harness({ "222": single });
    expect((await h.scan("222")).kind).toBe("added");
    const atLimit = h.cart.read();
    expect(await h.scan("222")).toEqual({ kind: "limit", label: "en-single" });
    expect(h.cart.read()).toBe(atLimit);
    expect(h.qty(single)).toBe(1);
    expect(h.beeps()).toBe(1);
  });

  it("a line at the POS order-entry limit (999) with no stock figure is refused", async () => {
    const serum = product("serum", null);
    const line = scannedCartLine(lookupResult(serum));
    const h = harness({ "111": serum }, { ...EMPTY_POS_CART, lines: [{ ...line, quantity: 999 }] });
    expect((await h.scan("111")).kind).toBe("limit");
    expect(h.qty(serum)).toBe(999);
    expect(h.beeps()).toBe(0);
  });

  it("a lookup miss is silent and changes nothing", async () => {
    const h = harness({});
    expect(await h.scan("999")).toEqual({ kind: "notFound" });
    expect(h.cart.read()).toBe(EMPTY_POS_CART);
    expect(h.beeps()).toBe(0);
  });

  it("a lookup error is silent and changes nothing", async () => {
    const h = harness({ "500": "throw" });
    expect(await h.scan("500")).toEqual({ kind: "error" });
    expect(h.cart.read()).toBe(EMPTY_POS_CART);
    expect(h.beeps()).toBe(0);
  });
});

describe("rapid and overlapping scans", () => {
  it("several fast scans stop beeping exactly when the stock limit is reached", async () => {
    const counted = product("counted", 3);
    const h = harness({ "444": counted });
    const results = await Promise.all(Array.from({ length: 6 }, () => h.scan("444")));
    expect(results.map((r) => r.kind)).toEqual([
      "added",
      "added",
      "added",
      "limit",
      "limit",
      "limit",
    ]);
    expect(h.qty(counted)).toBe(3);
    expect(h.beeps()).toBe(3);
  });

  it("acceptance reads the cart AFTER the lookup, not a snapshot from before it", async () => {
    const single = product("single", 1);
    const cart = store();
    let release!: (v: BarcodeLookupResult) => void;
    let beeps = 0;
    const pending = resolvePosScan("222", {
      lookup: () =>
        new Promise((r) => {
          release = r;
        }),
      readCart: cart.read,
      dispatch: cart.dispatch,
      playAccepted: () => {
        beeps += 1;
      },
    });
    // While the lookup is in flight the last unit enters the cart another way
    // (a tap, or an earlier scan that committed first).
    cart.dispatch({ type: "add", line: scannedCartLine(lookupResult(single)) });
    release(lookupResult(single));
    expect((await pending).kind).toBe("limit");
    expect(cart.read().lines[0]!.quantity).toBe(1);
    expect(beeps).toBe(0);
  });

  it("lookups resolving out of order still never pass the stock limit", async () => {
    const counted = product("counted", 2);
    const cart = store();
    const releases: Array<() => void> = [];
    let beeps = 0;
    const scans = Array.from({ length: 4 }, () =>
      resolvePosScan("444", {
        lookup: () =>
          new Promise((r) => {
            releases.push(() => r(lookupResult(counted)));
          }),
        readCart: cart.read,
        dispatch: cart.dispatch,
        playAccepted: () => {
          beeps += 1;
        },
      }),
    );
    for (const i of [3, 0, 2, 1]) releases[i]!();
    const kinds = (await Promise.all(scans)).map((r) => r.kind);
    expect(kinds.filter((k) => k === "added")).toHaveLength(2);
    expect(kinds.filter((k) => k === "limit")).toHaveLength(2);
    expect(cart.read().lines[0]!.quantity).toBe(2);
    expect(beeps).toBe(2);
  });
});

describe("proposeAddOne uses the cart's own add rule", () => {
  const line = (stock: number | null, quantity = 1): CartLine => ({
    ...scannedCartLine(lookupResult(product("p", stock))),
    quantity,
  });

  it("returns exactly the reducer's own next state for an accepted add", () => {
    const outcome = proposeAddOne(EMPTY_POS_CART, line(4));
    expect(outcome.kind).toBe("added");
    if (outcome.kind !== "added") return;
    expect(outcome.next).toEqual(posCartReducer(EMPTY_POS_CART, outcome.action));
    expect(outcome.next.lines[0]!.quantity).toBe(1);
  });

  it("always proposes ONE unit, whatever quantity the line carries", () => {
    const outcome = proposeAddOne(EMPTY_POS_CART, line(10, 7));
    expect(outcome.kind === "added" && outcome.next.lines[0]!.quantity).toBe(1);
  });

  it("does not mutate the state it is given", () => {
    const state: PosCartState = { ...EMPTY_POS_CART, lines: [line(2)] };
    const frozen = JSON.stringify(state);
    proposeAddOne(state, line(2));
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

describe("tap-to-add is unchanged (it does not go through the scan path)", () => {
  it("a tap adds, repeats increment, and stop at stock; zero stock never enters", () => {
    const tap = (state: PosCartState, stock: number | null, quantity = 1) =>
      posCartReducer(state, { type: "add", line: line(stock, quantity) });
    const line = (stock: number | null, quantity: number): CartLine => ({
      ...scannedCartLine(lookupResult(product("p", stock))),
      quantity,
    });
    let state = tap(EMPTY_POS_CART, 2);
    state = tap(state, 2);
    expect(state.lines[0]!.quantity).toBe(2);
    expect(tap(state, 2)).toEqual(state);
    expect(tap(EMPTY_POS_CART, 0)).toEqual(EMPTY_POS_CART);
    // The variant sheet adds a chosen quantity in one go, capped as before.
    expect(tap(EMPTY_POS_CART, 3, 5).lines[0]!.quantity).toBe(3);
  });
});
