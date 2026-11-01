/**
 * The payment refusals of migrations 068 / 062 that the browser must tell
 * apart — ONE table, used by src/server/payments/service.ts to build the error
 * it throws and by the browser to recognise it.
 *
 * Why exact messages. Over the real server-function wire only `message`
 * survives: `statusCode` and `code` are dropped (src/tests/helpers/
 * server-fn-wire.ts). The server-function boundary passes APSA public domain
 * errors unchanged and replaces every other error with a sanitized internal
 * message (src/server/observability/server-fn-boundary.ts). So a message that
 * is EXACTLY one of these strings can only have come from the service throwing
 * that refusal; a message that merely contains a similar word ("outstanding",
 * "already", "excess") proves nothing and is never treated as one.
 *
 * Isomorphic: no server or browser imports.
 */

export const PAYMENT_REFUSALS = {
  order_not_payable: {
    code: "order_not_payable",
    message: "This order cannot take a payment in its current state",
  },
  exceeds_outstanding: {
    code: "payment_exceeds_outstanding",
    message: "The payment is more than the order's outstanding balance",
  },
  claim_exceeds_total: {
    code: "payment_claim_exceeds_total",
    message: "Other payments already cover this order's total; this claim cannot be reopened",
  },
  outstanding_changed: {
    code: "payment_outstanding_changed",
    message:
      "The order's outstanding amount changed after this payment was started — re-read it and try again",
  },
  no_excess: {
    code: "payment_no_excess",
    message: "The amount is not above the outstanding amount — record it as an ordinary payment",
  },
  no_recorded_excess: {
    code: "payment_no_recorded_excess",
    message: "This payment was not recorded with an excess",
  },
  exceeds_returnable_excess: {
    code: "payment_exceeds_returnable_excess",
    message: "The amount is more than the excess that can still be returned",
  },
  nothing_outstanding: {
    code: "payment_nothing_outstanding",
    message: "Nothing is outstanding on this order — this transfer cannot be recorded against it",
  },
  duplicate_transfer_reference: {
    code: "payment_duplicate_transfer_reference",
    message: "This transfer reference is already recorded on another payment",
  },
  excess_reinstatement_required: {
    code: "payment_excess_reinstatement_required",
    message: "This payment was recorded with an excess — reinstate it with the excess action",
  },
  excess_changed: {
    code: "payment_excess_changed",
    message:
      "Other payments changed what this order still owes, so this transfer's excess is no longer the one recorded — record the transfer again with its new excess",
  },
} as const;

export type PaymentClaimRefusal = keyof typeof PAYMENT_REFUSALS;

const BY_CODE = new Map<string, PaymentClaimRefusal>(
  (Object.keys(PAYMENT_REFUSALS) as PaymentClaimRefusal[]).map((kind) => [
    PAYMENT_REFUSALS[kind].code,
    kind,
  ]),
);
const BY_MESSAGE = new Map<string, PaymentClaimRefusal>(
  (Object.keys(PAYMENT_REFUSALS) as PaymentClaimRefusal[]).map((kind) => [
    PAYMENT_REFUSALS[kind].message,
    kind,
  ]),
);

/** The refusal a structured public code names, or null. */
export function paymentRefusalByCode(code: unknown): PaymentClaimRefusal | null {
  return typeof code === "string" ? (BY_CODE.get(code) ?? null) : null;
}

/** The refusal whose message this is EXACTLY (no substring, no case folding), or null. */
export function paymentRefusalByExactMessage(message: unknown): PaymentClaimRefusal | null {
  return typeof message === "string" ? (BY_MESSAGE.get(message) ?? null) : null;
}

/**
 * The refusals of record_payment_with_excess_v1 that prove the request's key
 * wrote nothing — EVER, not only now. The function answers a replay of a key
 * it already committed (the original member's original request) BEFORE any of
 * these checks, so the same request under the same key reaching one of them
 * means that key has no committed payment. Every other outcome — a refusal
 * raised before the database (permission, principal, rate limit, validation,
 * not found), an idempotency conflict, a network error, a timeout, an unknown
 * or sanitized server error, a malformed response — proves nothing about an
 * earlier attempt under the same key and must keep it.
 */
export const EXCESS_RECORDING_WRITE_FREE_REFUSALS: ReadonlySet<PaymentClaimRefusal> = new Set([
  "order_not_payable",
  "nothing_outstanding",
  "outstanding_changed",
  "no_excess",
  "duplicate_transfer_reference",
]);
