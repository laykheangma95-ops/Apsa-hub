/**
 * Pure POS cart arithmetic. No React, no formatting, no i18n.
 * Components render the result; they never compute money themselves.
 */
import { multiplyMoney, subtractMoney, usd } from "@/lib/money";
import type { Money, Product } from "@/types";
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

export interface CartTotals {
  subtotal: Money;
  discount: Money;
  total: Money;
  itemCount: number;
}

/** Mock cashier permission envelope. Never a production rule. */
export const DISCOUNT_LIMIT_PERCENT = 20;
export const DISCOUNT_LIMIT_CENTS = 1_000;

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
  /** integer cents for "amount", whole percent for "percent" */
  value: number;
}

export function calculateCartTotals(
  lines: CartLine[],
  discountInput: CartDiscountInput,
): CartTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotal(l).amount, 0);
  const subtotal = usd(subtotalCents);

  let discount = usd(0);
  if (discountInput.enabled && discountInput.value > 0) {
    discount =
      discountInput.mode === "percent"
        ? multiplyMoney(subtotal, Math.min(100, discountInput.value) / 100)
        : usd(Math.min(discountInput.value, subtotalCents));
  }

  // Totals can never go negative.
  const total = usd(Math.max(0, subtractMoney(subtotal, discount).amount));
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  return { subtotal, discount, total, itemCount };
}

/** True when the mock cashier limit is exceeded and a manager must approve. */
export function needsManagerApproval(
  discountInput: CartDiscountInput,
  totals: CartTotals,
): boolean {
  if (!discountInput.enabled || discountInput.value <= 0) return false;
  if (discountInput.mode === "percent") return discountInput.value > DISCOUNT_LIMIT_PERCENT;
  return totals.discount.amount > DISCOUNT_LIMIT_CENTS;
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
