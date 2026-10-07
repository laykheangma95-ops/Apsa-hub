/**
 * Pure POS cart arithmetic. No React, no formatting, no i18n.
 * Components render the result; they never compute money themselves.
 */
import { parseMinorUnits } from "@/lib/money";
import type { Currency, Money, Product } from "@/types";
import type { DiscountMode } from "@/lib/order-draft";

export interface CartLine {
  /** stable line key: product id + variant */
  key: string;
  productId: string;
  /** Present on the production path — the variant DB UUID an order line prices/consumes. */
  variantId?: string;
  nameKm: string;
  nameEn: string;
  sku: string;
  variant?: string;
  quantity: number;
  unitPrice: Money;
  /**
   * The line's client-side cap: units available when it was added, or null
   * when POS holds no stock figure for it. null is the production path — the
   * catalog read carries no inventory (mapServerProductToUi), and the server
   * does not cap a sale by stock (create_order_v2 takes any positive integer;
   * confirming writes the persisted quantity to the ledger with no
   * availability check — migration 026). null is never a cap; 0 is "none left"
   * and never "unlimited". UX only: the server, not this number, is authority.
   */
  stock: number | null;
}

/** Why a typed discount is not applied. Checkout stays blocked while one is set. */
export type DiscountProblem = "malformed" | "percent_out_of_range" | "exceeds_subtotal";

/**
 * A cart whose lines all share one currency. Every Money here is in that
 * currency — the line prices' own currency, never a relabelled sum.
 */
export interface PricedCartTotals {
  kind: "priced";
  currency: Currency;
  subtotal: Money;
  discount: Money;
  total: Money;
  itemCount: number;
  /** Set when the typed discount is not valid; `discount` is then zero. */
  discountProblem: DiscountProblem | null;
}

/**
 * A cart holding lines priced in more than one currency. There is no honest
 * subtotal for it: adding riel to cents is meaningless, and converting at an
 * exchange rate would invent an order value the merchant never set. So this
 * shape carries no Money at all — nothing can render or submit a fake total —
 * and checkout is refused until the merchant removes one currency's lines.
 */
export interface MixedCurrencyCart {
  kind: "mixed_currency";
  currencies: Currency[];
  itemCount: number;
}

/**
 * A single-currency cart whose subtotal exceeds MAX_CART_MINOR — beyond the
 * integers a JS number represents exactly. Like a mixed cart it carries no
 * Money, so no inexact total can be shown or submitted, and it cannot check
 * out.
 */
export interface OutOfRangeCart {
  kind: "out_of_range";
  currency: Currency;
  itemCount: number;
}

export type CartTotals = PricedCartTotals | MixedCurrencyCart | OutOfRangeCart;

export function lineKey(productId: string, variant?: string): string {
  return variant ? `${productId}::${variant}` : productId;
}

/** A line's own total, exact (BigInt) — see "Exact money arithmetic" below. */
export function lineTotal(line: CartLine): Money {
  return { amount: Number(lineTotalMinor(line)), currency: line.unitPrice.currency };
}

/** A quantity a cart line can hold: a positive safe integer. */
function isLineQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity > 0;
}

/**
 * The most units one POS cart line can hold. An ORDER-ENTRY limit, not an
 * inventory claim: it is never shown as "available", and the server does not
 * enforce it (it accepts any positive integer quantity).
 *
 * It exists so every path agrees on one maximum. The quantity stepper clamps
 * to its max; if an add path let a line pass it, a single "−" on 1,005 sent
 * min(999, 1,004) = 999 and silently dropped six units from the sale.
 */
export const POS_MAX_LINE_QUANTITY = 999;

/**
 * The highest quantity a line may reach: the POS limit, or the known stock
 * when that is lower. A null stock (no figure) is bounded by the POS limit
 * only. Every cart mutation and every quantity stepper uses this — never a
 * literal of its own.
 */
export function lineQuantityLimit(stock: number | null): number {
  return stock === null ? POS_MAX_LINE_QUANTITY : Math.min(POS_MAX_LINE_QUANTITY, stock);
}

/** `quantity` bounded by the line's limit. */
function capQuantity(stock: number | null, quantity: number): number {
  return Math.min(lineQuantityLimit(stock), quantity);
}

/**
 * Add a line, or grow the existing line for the same key. A line with no unit
 * left (stock 0) never enters, and a quantity that is not a positive integer
 * is refused rather than coerced.
 */
export function addToCart(lines: CartLine[], line: CartLine): CartLine[] {
  if (!isLineQuantity(line.quantity)) return lines;
  const existing = lines.find((l) => l.key === line.key);
  if (!existing) {
    if (line.stock !== null && line.stock <= 0) return lines;
    return [...lines, { ...line, quantity: capQuantity(line.stock, line.quantity) }];
  }
  return lines.map((l) =>
    l.key === line.key ? { ...l, quantity: capQuantity(l.stock, l.quantity + line.quantity) } : l,
  );
}

/**
 * Set a line's quantity: at least 1, at most lineQuantityLimit(line.stock).
 * Anything that is not an integer (NaN, Infinity, 2.5) leaves the line as it
 * was — it is never coerced into a reset.
 */
export function setQuantity(lines: CartLine[], key: string, quantity: number): CartLine[] {
  if (!Number.isSafeInteger(quantity)) return lines;
  return lines.map((l) =>
    l.key === key ? { ...l, quantity: Math.max(1, capQuantity(l.stock, quantity)) } : l,
  );
}

export function removeLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => l.key !== key);
}

export interface CartDiscountInput {
  enabled: boolean;
  mode: DiscountMode;
  /**
   * What the merchant typed, kept as text so a half-typed "2." survives a
   * re-render. It is parsed against the cart's currency on every calculation
   * (dollars-and-cents for USD, whole riel for KHR) — never stored as cents
   * and reinterpreted later.
   */
  text: string;
  /**
   * The single cart currency this discount was entered for — stamped by
   * posCartReducer, for BOTH modes. A discount is never applied to a cart of
   * another currency: "5" means $5 or ៛5, and "10%" of a riel basket is not
   * the decision the merchant made about a dollar one.
   */
  currency: Currency | null;
}

export const NO_DISCOUNT: CartDiscountInput = {
  enabled: false,
  mode: "amount",
  text: "",
  currency: null,
};

/** The distinct currencies of a cart's lines, in first-seen order. */
export function cartCurrencies(lines: CartLine[]): Currency[] {
  const seen: Currency[] = [];
  for (const line of lines) {
    if (!seen.includes(line.unitPrice.currency)) seen.push(line.unitPrice.currency);
  }
  return seen;
}

/* ── Cart state ────────────────────────────────────────────────────────────
 *
 * Lines and discount live in ONE state, changed only through this reducer, so
 * the rule below cannot be skipped by any one code path (tap, scan, quantity,
 * remove, clear).
 *
 * The rule: a discount belongs to the currency context it was entered for.
 * Whenever the set of currencies in the cart changes — USD → KHR, single →
 * mixed, mixed → single, anything → empty — the discount is CLEARED, not kept
 * dormant. The previous version only hid a mismatched discount, so the same
 * "$5" silently came back when the cart returned to USD, and a percentage
 * carried from a dollar basket onto a replacement riel one.
 */

export interface PosCartState {
  lines: CartLine[];
  discount: CartDiscountInput;
}

export const EMPTY_POS_CART: PosCartState = { lines: [], discount: NO_DISCOUNT };

export type PosCartAction =
  | { type: "add"; line: CartLine }
  | { type: "quantity"; key: string; quantity: number }
  | { type: "remove"; key: string }
  | { type: "discount"; discount: CartDiscountInput }
  | { type: "reset" };

/** The cart's currency context: "" (empty), "USD", "KHR" or "KHR+USD" (mixed). */
export function cartCurrencyContext(lines: CartLine[]): string {
  return [...cartCurrencies(lines)].sort().join("+");
}

export function posCartReducer(state: PosCartState, action: PosCartAction): PosCartState {
  switch (action.type) {
    case "reset":
      return EMPTY_POS_CART;
    case "discount": {
      // Only a single-currency cart can carry a discount, and it is stamped
      // with that currency whatever the caller passed.
      const currencies = cartCurrencies(state.lines);
      if (currencies.length !== 1) return { ...state, discount: NO_DISCOUNT };
      return { ...state, discount: { ...action.discount, currency: currencies[0]! } };
    }
    default: {
      const lines =
        action.type === "add"
          ? addToCart(state.lines, action.line)
          : action.type === "quantity"
            ? setQuantity(state.lines, action.key, action.quantity)
            : removeLine(state.lines, action.key);
      if (cartCurrencyContext(lines) !== cartCurrencyContext(state.lines)) {
        return { lines, discount: NO_DISCOUNT };
      }
      return { lines, discount: state.discount };
    }
  }
}

/* ── Exact money arithmetic ────────────────────────────────────────────────
 *
 * Every cart amount is an integer number of minor units. Above
 * Number.MAX_SAFE_INTEGER a JS number can no longer represent every integer,
 * so `subtotal * percent` (or even `price * quantity`) silently rounds — the
 * independently reproduced case was a 100% discount on 9,006,988,797,149,282
 * coming out ONE minor unit larger than the subtotal, a -1 payable total.
 *
 * So: arithmetic runs in BigInt, and a result is turned back into a number
 * only when it is ≤ MAX_CART_MINOR. A cart past that bound is not priced at
 * all (kind "out_of_range") and cannot check out.
 */

/** The largest minor-unit amount POS prices, discounts or submits. */
export const MAX_CART_MINOR = Number.MAX_SAFE_INTEGER;
const MAX_CART_MINOR_BIG = BigInt(MAX_CART_MINOR);

function lineTotalMinor(line: CartLine): bigint {
  return BigInt(line.unitPrice.amount) * BigInt(line.quantity);
}

/**
 * Percent of a minor-unit amount, rounded half-up to the currency's own minor
 * unit (a cent for USD, a riel for KHR). Exact: BigInt division truncates,
 * which for these non-negative values is floor, and with 0 ≤ percent ≤ 100 the
 * result can never exceed the amount.
 */
function percentOf(amountMinor: bigint, percent: number): bigint {
  return (amountMinor * BigInt(percent) + 50n) / 100n;
}

/*
 * The discount-amount grammar POS accepts. Deliberately POS-local and strict,
 * checked BEFORE the shared parseMinorUnits (which strips every comma and so
 * read "1,5" or ",15" as 15): a comma is accepted only as a thousands
 * separator in correct three-digit groups, so the amount applied is always
 * the amount the merchant sees.
 *
 *   USD: 15 · 15.5 · 15.50 · 15. · 2,000 · 2,000.50
 *   KHR: 15000 · 15,000 · 2,000            (riel has no fractional unit)
 *
 * Refused: 1,5 · 1,,5 · ,15 · 15, · 1,00 · 2,00,0 · 2,000,00 · 1.2.3 · -5 ·
 * 5$ · 1e3 · any fraction of a riel · anything above MAX_CART_MINOR.
 */
const GROUPED_WHOLE = String.raw`(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)`;
const DISCOUNT_AMOUNT_GRAMMAR: Record<Currency, RegExp> = {
  USD: new RegExp(String.raw`^${GROUPED_WHOLE}(?:\.\d{0,2})?$`),
  KHR: new RegExp(String.raw`^${GROUPED_WHOLE}$`),
};
const WHOLE_PERCENT = /^\d{1,3}$/;

/** Minor units for a typed discount amount, or null when the text is not one. */
export function parseDiscountAmount(text: string, currency: Currency): number | null {
  const trimmed = text.trim();
  if (!DISCOUNT_AMOUNT_GRAMMAR[currency].test(trimmed)) return null;
  // Every comma left is a validated thousands separator, so removing them
  // (which parseMinorUnits does) cannot change the amount.
  const minor = parseMinorUnits(trimmed, currency);
  if (minor === null || minor > MAX_CART_MINOR) return null;
  return minor;
}

function resolveDiscount(
  input: CartDiscountInput,
  currency: Currency,
  subtotalMinor: bigint,
): { amount: bigint; problem: DiscountProblem | null } {
  if (!input.enabled) return { amount: 0n, problem: null };
  // Entered for another currency context: not this cart's discount, in either
  // mode. (posCartReducer clears it on the transition; this is the backstop.)
  if (input.currency !== currency) return { amount: 0n, problem: null };
  const text = input.text.trim();
  if (text === "") return { amount: 0n, problem: null };

  if (input.mode === "percent") {
    const cleaned = text.replace(/%$/, "").trim();
    if (!WHOLE_PERCENT.test(cleaned)) return { amount: 0n, problem: "malformed" };
    const percent = Number.parseInt(cleaned, 10);
    if (percent > 100) return { amount: 0n, problem: "percent_out_of_range" };
    return { amount: percentOf(subtotalMinor, percent), problem: null };
  }

  const amount = parseDiscountAmount(text, currency);
  if (amount === null) return { amount: 0n, problem: "malformed" };
  // Never clamped down to the subtotal: a merchant who typed $50 off a $30
  // cart meant something else, and quietly ringing it up as $30 off would be
  // a different sale than the one they entered. The server refuses it too
  // (discount_exceeds_subtotal), so it is caught here, with a reason.
  if (BigInt(amount) > subtotalMinor) return { amount: 0n, problem: "exceeds_subtotal" };
  return { amount: BigInt(amount), problem: null };
}

/**
 * Cart arithmetic in the lines' own currency.
 *
 * This is a PREVIEW. The server prices every line from the catalog and derives
 * subtotal/total itself (create_order_v2); the only money POS sends is the
 * discount, as integer minor units in that same currency, which the server
 * bounds to 0 ≤ discount ≤ subtotal.
 *
 * Invariant for every priced result: 0 ≤ discount ≤ subtotal ≤ MAX_CART_MINOR
 * and total = subtotal − discount ≥ 0, all exact integers.
 */
export function calculateCartTotals(
  lines: CartLine[],
  discountInput: CartDiscountInput,
): CartTotals {
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const currencies = cartCurrencies(lines);
  if (currencies.length > 1) return { kind: "mixed_currency", currencies, itemCount };

  // An empty cart has no currency of its own; its zero is never submitted
  // (checkout needs at least one line) and never shown (the cart renders its
  // empty state instead).
  const currency: Currency = currencies[0] ?? "USD";
  const subtotal = lines.reduce((sum, l) => sum + lineTotalMinor(l), 0n);
  if (subtotal > MAX_CART_MINOR_BIG) return { kind: "out_of_range", currency, itemCount };

  const { amount: discount, problem } = resolveDiscount(discountInput, currency, subtotal);
  return {
    kind: "priced",
    currency,
    subtotal: { amount: Number(subtotal), currency },
    discount: { amount: Number(discount), currency },
    total: { amount: Number(subtotal - discount), currency },
    itemCount,
    discountProblem: problem,
  };
}

/**
 * Why checkout is refused for this cart, or null when it may proceed. The one
 * rule every checkout button and the checkout sheet itself share.
 */
export type CheckoutBlock = "empty" | "mixed_currency" | "out_of_range" | "discount";

export function checkoutBlock(totals: CartTotals): CheckoutBlock | null {
  if (totals.itemCount === 0) return "empty";
  if (totals.kind === "mixed_currency") return "mixed_currency";
  if (totals.kind === "out_of_range") return "out_of_range";
  if (totals.discountProblem) return "discount";
  return null;
}

/**
 * The translation key explaining a refused discount. A whole percent and a
 * currency amount are typed differently, so they are explained differently.
 */
export function discountProblemKey(
  problem: DiscountProblem,
  mode: DiscountMode,
  currency: Currency,
): string {
  if (problem === "exceeds_subtotal") return "pos.discount.exceedsSubtotal";
  if (mode === "percent") return "pos.discount.invalidPercent";
  return currency === "USD" ? "pos.discount.invalidUsd" : "pos.discount.invalidKhr";
}

export type StockState = "available" | "low_stock" | "out_of_stock";

export function stockState(product: Product): StockState {
  // null = production path, inventory domain not yet connected — show as available.
  if (product.stock == null) return "available";
  if (product.stock <= 0) return "out_of_stock";
  if (product.stock <= product.lowStockThreshold) return "low_stock";
  return "available";
}

/**
 * Units available for sale, or null when POS holds no stock figure for the
 * product (the production path — see CartLine.stock). null means "no cap" and
 * stays distinct from 0, which means "none left": never collapse one into the
 * other (`?? 0`, `Math.max(1, …)`).
 */
export function availableStock(product: Product): number | null {
  if (product.stock == null) return null;
  return Math.max(0, product.stock - (product.reserved ?? 0));
}

/* ------------------------------ checkout routing ------------------------- */

/**
 * Which checkout a cart is allowed to use.
 *
 *   production — every line references a real, DB-backed product AND variant.
 *                The sale goes to the authoritative Order domain.
 *   prototype  — no line references production data at all. The `/design`
 *                mock catalog; a fabricated Sale is a prop, not a record.
 *   unsellable — anything else. Most importantly: a REAL product whose
 *                catalog row carries no sellable variant (mapServerProductToUi
 *                leaves `variantId` unset when a product has zero ACTIVE
 *                variants), and any cart mixing real and prototype lines.
 *
 * `unsellable` exists because the previous two-way test degraded silently: it
 * asked "is every line production?" and, on `false`, ran the PROTOTYPE
 * checkout. A single real-but-variantless product therefore routed an entire
 * cart of real goods into a browser-fabricated sale — the merchant saw an
 * order code and a "paid" chip for a sale no server had ever heard of. There
 * is no honest third path here: a cart APSA cannot turn into a real order must
 * refuse checkout and say why, never mint a receipt for it.
 */
export type CheckoutKind = "production" | "prototype" | "unsellable";

/** A real, DB-backed product id (and the only thing a real order line accepts). */
const PRODUCTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when this catalog row can actually be sold: a prototype product (which
 * only ever reaches the prototype checkout), or a real product that carries at
 * least one sellable variant. A real product with no ACTIVE variant is not a
 * product a merchant can ring up, and POS must not let it into the cart.
 */
export function isSellable(product: Product): boolean {
  if (!PRODUCTION_ID.test(product.id)) return true;
  return Boolean(product.variantId) || (product.productionVariants?.length ?? 0) > 0;
}

export function classifyCheckout(lines: CartLine[]): CheckoutKind {
  if (lines.length === 0) return "unsellable";
  const production = lines.filter(
    (l) => PRODUCTION_ID.test(l.productId) && PRODUCTION_ID.test(l.variantId ?? ""),
  ).length;
  if (production === lines.length) return "production";
  // Not "every line is prototype" by elimination — a real productId with a
  // missing variantId is neither, and must land in `unsellable`.
  const prototype = lines.filter((l) => !PRODUCTION_ID.test(l.productId)).length;
  if (prototype === lines.length) return "prototype";
  return "unsellable";
}
