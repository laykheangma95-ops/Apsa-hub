/**
 * Authoritative Order settlement rule.
 *
 * Pure: no DB, no auth context, no I/O. This module is THE specification of
 * how much money has actually settled against an order and what that means
 * for the order's coarse payment axis — exactly the role ./state-machine.ts
 * plays for verification transitions. `sync_order_payment_status_v1`
 * (migration 039) implements this same rule in SQL so it can be applied
 * atomically; the rule is described once, here, so the two cannot silently
 * diverge (structural tests in src/tests/payment-order-integration.test.ts
 * assert the SQL matches).
 *
 * ── WHY AN AMOUNT, NOT A FLAG ────────────────────────────────────────────────
 *
 * An earlier draft of the Payment ↔ Order integration derived the order's
 * payment status from the EXISTENCE of a settled payment row ("any payment is
 * paid -> order is paid"). That is a financial-integrity bug: a $10 settled
 * payment against a $100 order would have marked the order fully paid, and a
 * partial refund would not have un-paid it. Settlement is an AMOUNT question,
 * so this module answers it in integer minor units and compares against the
 * order's own authoritative total (`orders.total_minor`, itself DB-constrained
 * to equal subtotal - discount + delivery — migration 023).
 *
 * ── WHAT COUNTS AS SETTLED ───────────────────────────────────────────────────
 *
 *   status 'paid'      counts, minus whatever has since been refunded
 *   status 'refunded'  counts the same way, which is exactly 0 by construction
 *                      (refund_payment_v1 only sets 'refunded' once the
 *                      cumulative refunds equal the full amount) — included
 *                      so the rule reads as "settled money, minus what went
 *                      back" rather than relying on that invariant
 *   status 'pending'   counts 0 — a claim, not money. This is what keeps an
 *                      unverified record, a screenshot-backed record, and an
 *                      un-settled COD collection out of the settled total
 *                      (SECURITY.md §41: evidence is never financial authority)
 *   status 'failed'    counts 0 — the claim was found not to hold up
 *   status 'reversed'  counts 0 — the whole claim was voided, refunds included
 *
 * ── CURRENCY ────────────────────────────────────────────────────────────────
 *
 * Only payments denominated in the ORDER's currency are summed. Two currencies
 * are never added together and no exchange rate is ever invented
 * (ARCHITECTURE.md). record_payment_v1 copies the order's currency onto every
 * payment it creates, so a mismatch cannot occur through the only write path
 * that exists — filtering here makes that a structural guarantee rather than
 * an assumption.
 *
 * ── MONEY IS INTEGER MINOR UNITS ────────────────────────────────────────────
 *
 * Every value in and out of this module is an INTEGER minor unit (USD cents,
 * KHR riel). There is no floating-point arithmetic and no floating-point
 * comparison anywhere here: non-integer input is rejected outright by
 * assertMinorUnit rather than being silently rounded into a comparison.
 */

/** Mirrors migration 034's public.payment_status. */
export type SettlementPaymentStatus = "pending" | "paid" | "failed" | "reversed" | "refunded";

/**
 * Mirrors migration 023's public.order_payment_status.
 *
 * Declared locally rather than imported from @/server/orders/state-machine on
 * purpose: no module under src/server/payments imports the Order domain (see
 * ./service.ts's header and the structural tests that enforce it). The four
 * values must stay identical to that enum — a test asserts they do.
 */
export type OrderPaymentStatusValue = "unpaid" | "pending" | "paid" | "failed";

/**
 * How the settled amount relates to the order total. Finer than the coarse
 * order axis, which has no 'partial' or 'overpaid' value of its own — this is
 * where that truth is preserved (see ./reconciliation.ts and migration 039's
 * order_payment_settlement view).
 */
export type OrderSettlementState = "unsettled" | "partial" | "settled" | "overpaid";

/** Payment statuses whose money counts toward the settled total (before refunds). */
export const SETTLED_PAYMENT_STATUSES: readonly SettlementPaymentStatus[] = ["paid", "refunded"];

export interface SettlementPayment {
  /** Integer minor units, always > 0 (migration 034 CHECK). */
  amountMinor: number;
  currency: string;
  status: SettlementPaymentStatus;
  /**
   * Sum of this payment's `refund` events, in integer minor units. Never
   * exceeds amountMinor (refund_payment_v1 rejects an over-refund), and is
   * never applied to a payment that is not itself settled.
   */
  refundedMinor: number;
}

export interface SettlementFacts {
  /** Settled money minus refunds, in integer minor units. Never negative. */
  netSettledMinor: number;
  /** Any payment for this order still awaiting a verdict. */
  hasPendingPayment: boolean;
  /** Any payment for this order whose claim was found not to hold up. */
  hasFailedPayment: boolean;
}

export interface OrderSettlement extends SettlementFacts {
  orderTotalMinor: number;
  /** How much of the order total is still unsettled. 0 once fully settled. */
  outstandingMinor: number;
  /** How much settled money EXCEEDS the order total. 0 unless overpaid. */
  overSettledMinor: number;
  state: OrderSettlementState;
  /** What orders.payment_status must be set to for these facts. */
  orderPaymentStatus: OrderPaymentStatusValue;
  /**
   * True only for `overpaid`. A partially settled order is an ordinary
   * Cambodian deposit/instalment workflow, not an anomaly; more money arriving
   * than was ever owed is unexplained and a human must look at it.
   */
  needsReview: boolean;
}

/**
 * Rejects any value that is not a safe integer. Money in APSA is an integer
 * minor unit everywhere; a float reaching a settlement comparison would be a
 * correctness bug, so it fails loudly here instead of being rounded away.
 */
function assertMinorUnit(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer minor amount, received ${String(value)}`);
  }
}

/**
 * Reduce an order's payments to the three facts the coarse order axis needs.
 * Payments in any currency other than the order's are excluded entirely.
 */
export function settlementFactsFromPayments(
  payments: readonly SettlementPayment[],
  orderCurrency: string,
): SettlementFacts {
  let netSettledMinor = 0;
  let hasPendingPayment = false;
  let hasFailedPayment = false;

  for (const payment of payments) {
    if (payment.currency !== orderCurrency) continue;

    assertMinorUnit(payment.amountMinor, "payment amount");
    assertMinorUnit(payment.refundedMinor, "refunded amount");

    if (payment.status === "pending") hasPendingPayment = true;
    if (payment.status === "failed") hasFailedPayment = true;

    if (SETTLED_PAYMENT_STATUSES.includes(payment.status)) {
      // Never negative: refund_payment_v1 refuses a refund that would exceed
      // the payment amount, so the remainder is always >= 0. Clamped anyway so
      // a hypothetical bad row can only under-count, never invent money.
      netSettledMinor += Math.max(payment.amountMinor - payment.refundedMinor, 0);
    }
  }

  return { netSettledMinor, hasPendingPayment, hasFailedPayment };
}

/**
 * Turn settlement facts into the coarse order payment status.
 *
 *   net > 0 and net >= total  -> 'paid'     (exactly settled, or overpaid)
 *   net > 0 and net <  total  -> 'pending'  (PARTIALLY settled — never 'paid')
 *   net = 0, a pending payment exists -> 'pending'
 *   net = 0, only failed payments     -> 'failed'
 *   otherwise                          -> 'unpaid'
 *
 * The `net > 0` guard matters for a zero-total order: without it, an order
 * with no payments at all would satisfy `0 >= 0` and be reported paid.
 *
 * OVERPAYMENT maps to 'paid' on the coarse axis — the order genuinely is
 * covered — and the excess is preserved in `overSettledMinor` / `state` /
 * `needsReview` rather than being rounded away. The order axis deliberately
 * gains no new enum value for it (migration 023 keeps that axis coarse); the
 * finer truth lives in the Payment/reconciliation domain, which is where a
 * human resolves it.
 */
export function classifySettlement(
  facts: SettlementFacts,
  orderTotalMinor: number,
): OrderSettlement {
  assertMinorUnit(orderTotalMinor, "order total");
  assertMinorUnit(facts.netSettledMinor, "net settled amount");

  const { netSettledMinor } = facts;
  const outstandingMinor = Math.max(orderTotalMinor - netSettledMinor, 0);
  const overSettledMinor = Math.max(netSettledMinor - orderTotalMinor, 0);

  let state: OrderSettlementState;
  if (netSettledMinor === 0) {
    state = "unsettled";
  } else if (netSettledMinor < orderTotalMinor) {
    state = "partial";
  } else if (netSettledMinor === orderTotalMinor) {
    state = "settled";
  } else {
    state = "overpaid";
  }

  let orderPaymentStatus: OrderPaymentStatusValue;
  if (netSettledMinor > 0 && netSettledMinor >= orderTotalMinor) {
    orderPaymentStatus = "paid";
  } else if (netSettledMinor > 0 || facts.hasPendingPayment) {
    orderPaymentStatus = "pending";
  } else if (facts.hasFailedPayment) {
    orderPaymentStatus = "failed";
  } else {
    orderPaymentStatus = "unpaid";
  }

  return {
    ...facts,
    orderTotalMinor,
    outstandingMinor,
    overSettledMinor,
    state,
    orderPaymentStatus,
    needsReview: state === "overpaid",
  };
}

/** Convenience: facts + classification in one call. */
export function computeOrderSettlement(
  payments: readonly SettlementPayment[],
  orderCurrency: string,
  orderTotalMinor: number,
): OrderSettlement {
  return classifySettlement(settlementFactsFromPayments(payments, orderCurrency), orderTotalMinor);
}
