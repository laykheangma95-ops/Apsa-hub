/**
 * Pure order-draft arithmetic. No React, no formatting — components only render.
 */
import { parseDeliveryFee } from "@/lib/delivery-fee";
import { usd } from "@/lib/money";
import {
  calculateCartTotals,
  cartCurrencies,
  checkoutBlock,
  MAX_CART_MINOR,
  NO_DISCOUNT,
  type CartDiscountInput,
  type DiscountProblem,
  type MixedCurrencyCart,
  type OutOfRangeCart,
  type PricedLine,
} from "@/lib/pos-cart";
import type { Currency, Money, Product } from "@/types";

export type DiscountMode = "amount" | "percent";

/*
 * ── Draft money (Inbox Prepare Order / Create Order) ──────────────────────
 *
 * Every amount here is in the draft's OWN currency — the one currency its
 * priced lines share. There is no USD default: the previous version seeded
 * the line sum, the discount and the delivery fee with usd(0), so the first
 * riel line threw "Cannot add different currencies" and the sheet crashed,
 * and an empty draft advertised a "$0.00" total and a dollar fee field.
 *
 * The line and discount arithmetic is POS's own (calculateCartTotals, exact
 * BigInt, currency-checked) rather than a second implementation. This adds
 * the one thing a chat order has that a POS sale does not: a delivery fee,
 * typed as text and bound to the currency it was typed in.
 *
 * All of it is a PREVIEW. The server prices the lines from the catalog,
 * requires one organization currency, bounds the fee and derives every total
 * itself (create_order_v2). The only money a real Inbox order sends is the
 * delivery fee, as integer minor units in this same currency.
 */

/** What the merchant typed as the delivery fee, and the currency it was typed for. */
export interface DraftDeliveryFee {
  /** Kept as text so a half-typed "1." survives a re-render; parsed on use. */
  text: string;
  /**
   * The single draft currency the fee was entered for. A fee is never applied
   * to a draft of another currency: "5" means $5.00 or ៛5, never both.
   */
  currency: Currency | null;
}

export const NO_DELIVERY_FEE: DraftDeliveryFee = { text: "", currency: null };

/** A draft whose priced lines all share one currency. Every Money is in it. */
export interface PricedDraftTotals {
  kind: "priced";
  currency: Currency;
  subtotal: Money;
  discount: Money;
  deliveryFee: Money;
  total: Money;
  itemCount: number;
  /** Set when the typed discount is not valid; `discount` is then zero. */
  discountProblem: DiscountProblem | null;
  /** True when the typed fee is not a valid fee; `deliveryFee` is then zero. */
  deliveryFeeInvalid: boolean;
}

/** No line has a product yet: there is no currency, so there is no amount. */
export interface EmptyDraft {
  kind: "empty";
  itemCount: 0;
}

/**
 * Mixed-currency and out-of-range drafts carry no Money at all, exactly like
 * their POS counterparts: nothing can render or submit a summed, converted or
 * inexact total for them.
 */
export type DraftTotals = PricedDraftTotals | EmptyDraft | MixedCurrencyCart | OutOfRangeCart;

/** The currency a single-currency draft is in, or null (empty or mixed). */
export function draftCurrency(lines: readonly PricedLine[]): Currency | null {
  const currencies = cartCurrencies(lines);
  return currencies.length === 1 ? currencies[0]! : null;
}

export function calculateDraftTotals(
  lines: readonly PricedLine[],
  discountInput: CartDiscountInput = NO_DISCOUNT,
  deliveryFeeInput: DraftDeliveryFee = NO_DELIVERY_FEE,
): DraftTotals {
  if (lines.length === 0) return { kind: "empty", itemCount: 0 };
  const cart = calculateCartTotals(lines, discountInput);
  if (cart.kind !== "priced") return cart;

  const { currency } = cart;
  // Typed for another currency context: not this draft's fee. (The sheets
  // clear it on that transition; this is the backstop.)
  const feeText = deliveryFeeInput.currency === currency ? deliveryFeeInput.text : "";
  const parsedFee = parseDeliveryFee(feeText, currency);
  const fee = parsedFee ?? 0;

  const total = BigInt(cart.total.amount) + BigInt(fee);
  if (total > BigInt(MAX_CART_MINOR)) {
    return { kind: "out_of_range", currency, itemCount: cart.itemCount };
  }
  return {
    kind: "priced",
    currency,
    subtotal: cart.subtotal,
    discount: cart.discount,
    deliveryFee: { amount: fee, currency },
    total: { amount: Number(total), currency },
    itemCount: cart.itemCount,
    discountProblem: cart.discountProblem,
    deliveryFeeInvalid: parsedFee === null,
  };
}

/** Why a draft cannot be submitted, or null when its money allows it. */
export type DraftBlock = "empty" | "mixed_currency" | "out_of_range" | "discount" | "delivery_fee";

export function draftBlock(totals: DraftTotals): DraftBlock | null {
  if (totals.kind === "empty") return "empty";
  if (totals.kind === "priced" && totals.deliveryFeeInvalid) return "delivery_fee";
  return checkoutBlock(totals);
}

/** Variant chips are rendered from this shape; selection order follows option order. */
export function defaultVariantSelection(
  options: { name: string; values: string[] }[] | undefined,
): Record<string, string> {
  const selection: Record<string, string> = {};
  for (const option of options ?? []) {
    const first = option.values[0];
    if (first) selection[option.name] = first;
  }
  return selection;
}

export function variantLabel(selection: Record<string, string>): string | undefined {
  const values = Object.values(selection);
  return values.length > 0 ? values.join(" · ") : undefined;
}

/*
 * ── Production variant resolution ──────────────────────────────────────────
 *
 * `mapServerProductToUi` (src/lib/api/index.ts) sets `Product.variantId` to
 * the FIRST ACTIVE variant and only exposes `productionVariants` when the
 * product has more than one. Submitting `product.variantId` for such a
 * product silently sells whichever variant the server happened to return
 * first — the wrong-variant defect class already fixed in PosVariantSheet and
 * PrepareOrderSheet. Every order-entry surface resolves the variant through
 * these three helpers so there is one rule, not one per sheet.
 *
 * `productionVariants` is ACTIVE-only by construction: the server builds it
 * from listVariantsByProduct(), which filters `status = "ACTIVE"` unless
 * archived rows are explicitly requested (src/server/products/repository.ts).
 * An ARCHIVED variant therefore never reaches a picker built from this list.
 */

/** The product shape these helpers need — anything carrying the variant fields. */
type VariantBearing = Pick<Product, "variantId" | "price" | "productionVariants">;

/** True only when the merchant must explicitly pick one of several ACTIVE variants. */
export function needsVariantChoice(product: VariantBearing | null | undefined): boolean {
  return (product?.productionVariants?.length ?? 0) > 1;
}

/**
 * The variant a freshly selected product starts on.
 *
 * A single-variant product resolves itself; a multi-variant one starts
 * UNCHOSEN (null) so submit stays blocked until the merchant chooses. Never
 * falls back to `product.variantId` in the multi-variant case — that fallback
 * IS the defect.
 */
export function defaultProductVariantId(product: VariantBearing | null | undefined): string | null {
  if (!product || needsVariantChoice(product)) return null;
  return product.variantId ?? null;
}

/**
 * The price that must drive every line total: the chosen variant's own price
 * when one is chosen, else the product's (which, for a single-variant product,
 * already IS that one variant's price).
 */
export function productVariantPrice(
  product: VariantBearing | null | undefined,
  variantId: string | null | undefined,
): Money {
  const chosen = product?.productionVariants?.find((v) => v.variantId === variantId);
  return chosen?.price ?? product?.price ?? usd(0);
}
