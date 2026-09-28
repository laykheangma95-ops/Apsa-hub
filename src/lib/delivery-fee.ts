/**
 * Delivery fee input rules for real order creation (migration 044).
 *
 * The delivery fee is what the MERCHANT CHARGES THE CUSTOMER for delivery —
 * never the courier's cost. It is an integer minor-unit input to the server's
 * own total calculation; create_order_v2 re-validates the bound below and adds
 * the fee into the total itself. Nothing here is authoritative: this module
 * only stops an obviously invalid value from being sent, and parses typed text
 * with integer arithmetic (parseMinorUnits) — never `parseFloat(x) * 100`.
 */
import { parseMinorUnits } from "@/lib/money";
import type { Currency, Money } from "@/types";

/** Mirrors create_order_v2's bound: $1,000.00 / 4,000,000៛. The server re-checks. */
export const DELIVERY_FEE_MAX_MINOR: Record<Currency, number> = { USD: 100_000, KHR: 4_000_000 };

/**
 * Typed delivery-fee text -> integer minor units, or null when it is not a
 * valid fee. Empty text is a fee of 0, which is the default.
 */
export function parseDeliveryFee(text: string, currency: Currency): number | null {
  if (text.trim() === "") return 0;
  const minor = parseMinorUnits(text, currency);
  if (minor === null || minor < 0 || minor > DELIVERY_FEE_MAX_MINOR[currency]) return null;
  return minor;
}

/**
 * True when a delivery's COD amount is not the order's total — a different
 * amount or a different currency. COD is what the courier collects and may
 * legitimately differ (part-paid order, balance only); this only decides when
 * the UI must say so out loud instead of showing two unexplained figures.
 */
export function codDiffersFromTotal(cod: Money, orderTotal: Money): boolean {
  return cod.currency !== orderTotal.currency || cod.amount !== orderTotal.amount;
}
