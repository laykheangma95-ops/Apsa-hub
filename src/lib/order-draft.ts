/**
 * Pure order-draft arithmetic. No React, no formatting — components only render.
 */
import { addMoney, multiplyMoney, subtractMoney, usd } from "@/lib/money";
import type { Money, Product } from "@/types";

export type DiscountMode = "amount" | "percent";

export interface OrderDraftInput {
  unitPrice: Money;
  quantity: number;
  discountEnabled: boolean;
  discountMode: DiscountMode;
  /** integer cents when mode is "amount", whole percent when mode is "percent" */
  discountValue: number;
  /** integer cents */
  deliveryFeeCents: number;
}

export interface OrderDraftTotals {
  subtotal: Money;
  discount: Money;
  deliveryFee: Money;
  total: Money;
}

export function calculateDraftTotals(input: OrderDraftInput): OrderDraftTotals {
  const subtotal = multiplyMoney(input.unitPrice, Math.max(1, input.quantity));

  let discount = usd(0);
  if (input.discountEnabled && input.discountValue > 0) {
    discount =
      input.discountMode === "percent"
        ? multiplyMoney(subtotal, Math.min(100, input.discountValue) / 100)
        : usd(Math.min(input.discountValue, subtotal.amount));
  }

  const deliveryFee = usd(Math.max(0, input.deliveryFeeCents));
  const total = addMoney(subtractMoney(subtotal, discount), deliveryFee);

  return { subtotal, discount, deliveryFee, total };
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
