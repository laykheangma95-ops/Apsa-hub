/**
 * Parcel label payment state — pure, deterministic, fail-safe.
 *
 * Decides what a courier sees on a printed label: PAID (collect nothing), COD
 * (collect exactly this amount) or CHECK PAYMENT (collect nothing until the shop
 * confirms). It reads ONLY authoritative Payment-domain facts — the
 * order_payment_totals view (migration 040) for amounts and the payment rows'
 * own status/method/verification for ambiguity — and redesigns nothing:
 *
 *   - `received_minor` counts only payments whose status is paid/refunded, and
 *     a payment reaches `paid` only through verify_payment_v1 (staff, manager or
 *     bank). Evidence/screenshots never move status (SECURITY.md §41), so PAID
 *     here can never come from a screenshot or UI state.
 *   - The COD amount is the ledger's OUTSTANDING balance (total − net), never
 *     the full order total and never recomputed client-side (§18).
 *
 * Rules, evaluated in order (outstanding = max(0, total_minor − net_minor)):
 *
 *   1. No settlement row for the order          → CHECK (settlement_unavailable)
 *   2. outstanding = 0                          → PAID
 *   3. Any refund recorded (refunded_minor > 0) → CHECK (refunded)
 *        money went back to the customer; asking a courier to collect it again
 *        is never a decision a label should make.
 *   4. Any live pending payment that is NOT the
 *      plain COD expectation (a pending cash/KHQR/
 *      bank claim, or a duplicate_suspected row) → CHECK (payment_review)
 *        the customer says they paid and nobody has verified it yet.
 *   5. Any failed payment (verification mismatch) → CHECK (payment_failed)
 *   6. Any reversed payment, unless a live pending
 *      COD expectation exists                   → CHECK (payment_reversed)
 *   7. Otherwise                                 → COD, collect `outstanding`
 *        (`partial` when a verified deposit already reduced it).
 *
 * "Plain COD expectation" = method 'cod', status 'pending', verification
 * 'unverified': exactly what POS/RecordOrderPaymentSheet record when the sale is
 * cash-on-delivery ("collect payment when the order is delivered").
 */
import type { Currency, Money } from "@/types";

export type ParcelLabelPaymentState = "paid" | "cod" | "check";

export type ParcelLabelCheckReason =
  "settlement_unavailable" | "refunded" | "payment_review" | "payment_failed" | "payment_reversed";

export interface LabelSettlementTotals {
  total_minor: number;
  received_minor: number;
  refunded_minor: number;
  net_minor: number;
}

export interface LabelPaymentRow {
  method: string;
  status: string;
  verification_state: string;
}

export interface LabelPayment {
  state: ParcelLabelPaymentState;
  /** Amount the courier collects — present ONLY when state is "cod". */
  collect: Money | null;
  /** COD of a remaining balance after a verified deposit. */
  partial: boolean;
  /** Why the label says CHECK PAYMENT — present ONLY when state is "check". */
  checkReason: ParcelLabelCheckReason | null;
}

function isPlainCodExpectation(row: LabelPaymentRow): boolean {
  return (
    row.method === "cod" && row.status === "pending" && row.verification_state === "unverified"
  );
}

function check(reason: ParcelLabelCheckReason): LabelPayment {
  return { state: "check", collect: null, partial: false, checkReason: reason };
}

export function deriveLabelPayment(input: {
  currency: Currency;
  totals: LabelSettlementTotals | null;
  payments: LabelPaymentRow[];
}): LabelPayment {
  const { totals, payments, currency } = input;
  if (!totals) return check("settlement_unavailable");

  const outstanding = Math.max(0, totals.total_minor - totals.net_minor);
  if (outstanding === 0) {
    return { state: "paid", collect: null, partial: false, checkReason: null };
  }

  if (totals.refunded_minor > 0) return check("refunded");

  if (payments.some((p) => p.status === "pending" && !isPlainCodExpectation(p))) {
    return check("payment_review");
  }
  if (payments.some((p) => p.status === "failed")) return check("payment_failed");

  const hasCodExpectation = payments.some(isPlainCodExpectation);
  if (payments.some((p) => p.status === "reversed") && !hasCodExpectation) {
    return check("payment_reversed");
  }

  return {
    state: "cod",
    collect: { amount: outstanding, currency },
    partial: totals.net_minor > 0,
    checkReason: null,
  };
}
