/**
 * Pure POS cart arithmetic. No React, no formatting, no i18n.
 * Components render the result; they never compute money themselves.
 */
import { multiplyMoney, parseMinorUnits } from "@/lib/money";
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
  /** stock available at the moment the line was added */
  stock: number;
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

export type CartTotals = PricedCartTotals | MixedCurrencyCart;

export function lineKey(productId: string, variant?: string): string {
  return variant ? `${productId}::${variant}` : productId;
}

export function lineTotal(line: CartLine): Money {
  return multiplyMoney(line.unitPrice, line.quantity);
}

export function addToCart(lines: CartLine[], line: CartLine): CartLine[] {
  const existing = lines.find((l) => l.key === line.key);
  if (!existing) return [...lines, line];
  return lines.map((l) =>
    l.key === line.key
      ? {
          ...l,
          // When stock = 0 (unlimited — inventory not yet connected), don't cap.
          quantity:
            l.stock === 0
              ? l.quantity + line.quantity
              : Math.min(l.stock, l.quantity + line.quantity),
        }
      : l,
  );
}

export function setQuantity(lines: CartLine[], key: string, quantity: number): CartLine[] {
  return lines.map((l) =>
    l.key === key
      ? {
          ...l,
          // When stock = 0 (unlimited), allow any positive quantity.
          quantity:
            l.stock === 0 ? Math.max(1, quantity) : Math.max(1, Math.min(l.stock, quantity)),
        }
      : l,
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
   * The cart currency the amount was typed in. An "amount" discount typed for
   * a USD cart is never applied to a KHR cart (or the reverse): "5" means $5
   * or ៛5, and silently switching between them would move real money.
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

const WHOLE_PERCENT = /^\d{1,3}$/;

/**
 * Percent of a minor-unit amount, rounded half-up to the currency's own minor
 * unit (a cent for USD, a riel for KHR). Integer arithmetic only: the product
 * is an exact integer, and floor((x + 50) / 100) cannot be pushed across an
 * integer boundary by floating-point division.
 */
function percentOf(amountMinor: number, percent: number): number {
  return Math.floor((amountMinor * percent + 50) / 100);
}

function resolveDiscount(
  input: CartDiscountInput,
  currency: Currency,
  subtotalMinor: number,
): { amount: number; problem: DiscountProblem | null } {
  if (!input.enabled) return { amount: 0, problem: null };
  const text = input.text.trim();
  if (text === "") return { amount: 0, problem: null };

  if (input.mode === "percent") {
    const cleaned = text.replace(/%$/, "").trim();
    if (!WHOLE_PERCENT.test(cleaned)) return { amount: 0, problem: "malformed" };
    const percent = Number.parseInt(cleaned, 10);
    if (percent > 100) return { amount: 0, problem: "percent_out_of_range" };
    return { amount: percentOf(subtotalMinor, percent), problem: null };
  }

  // A fixed amount typed for another currency is not this cart's discount.
  if (input.currency !== currency) return { amount: 0, problem: null };
  const amount = parseMinorUnits(text, currency);
  if (amount === null) return { amount: 0, problem: "malformed" };
  // Never clamped down to the subtotal: a merchant who typed $50 off a $30
  // cart meant something else, and quietly ringing it up as $30 off would be
  // a different sale than the one they entered. The server refuses it too
  // (discount_exceeds_subtotal), so it is caught here, with a reason.
  if (amount > subtotalMinor) return { amount: 0, problem: "exceeds_subtotal" };
  return { amount, problem: null };
}

/**
 * Cart arithmetic in the lines' own currency.
 *
 * This is a PREVIEW. The server prices every line from the catalog and derives
 * subtotal/total itself (create_order_v2); the only money POS sends is the
 * discount, as integer minor units in that same currency, which the server
 * bounds to 0 ≤ discount ≤ subtotal.
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
  const subtotalMinor = lines.reduce((sum, l) => sum + lineTotal(l).amount, 0);
  const { amount: discountMinor, problem } = resolveDiscount(
    discountInput,
    currency,
    subtotalMinor,
  );

  return {
    kind: "priced",
    currency,
    subtotal: { amount: subtotalMinor, currency },
    discount: { amount: discountMinor, currency },
    // resolveDiscount never returns more than the subtotal, so this is ≥ 0.
    total: { amount: subtotalMinor - discountMinor, currency },
    itemCount,
    discountProblem: problem,
  };
}

/**
 * Why checkout is refused for this cart, or null when it may proceed. The one
 * rule every checkout button and the checkout sheet itself share.
 */
export type CheckoutBlock = "empty" | "mixed_currency" | "discount";

export function checkoutBlock(totals: CartTotals): CheckoutBlock | null {
  if (totals.itemCount === 0) return "empty";
  if (totals.kind === "mixed_currency") return "mixed_currency";
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

/** Units available for sale.
 * Returns 0 (meaning "unlimited" for the cart) when inventory is not connected (stock == null).
 * CartLine.stock stores this value; 0 means no cap.
 */
export function availableStock(product: Product): number {
  if (product.stock == null) return 0; // inventory not yet connected — no cap in cart
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
