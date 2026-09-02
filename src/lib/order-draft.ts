/**
 * Pure order-draft arithmetic. No React, no formatting — components only render.
 */
import { addMoney, multiplyMoney, subtractMoney, usd } from "@/lib/money";
import type { Money } from "@/types";

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
