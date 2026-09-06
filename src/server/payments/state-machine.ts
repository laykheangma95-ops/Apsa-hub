/**
 * Authoritative Payment state machine.
 *
 * Pure: no DB, no auth context, no I/O. Mirrors src/server/orders/state-machine.ts
 * exactly — the transition rules are a total function of their arguments so
 * they can be tested exhaustively and reused by every future caller (manual
 * confirmation UI, a future bank webhook adapter) with no chance of a second,
 * divergent copy of the rules appearing.
 *
 * ── TWO AXES ──────────────────────────────────────────────────────────────────
 *
 *   status              — the settlement outcome of this payment record:
 *                          pending -> paid -> (reversed | refunded), or failed.
 *   verification_state  — how much the claim "this money arrived" can be
 *                          trusted, and by what authority: unverified ->
 *                          staff_confirmed -> manager_verified -> bank_verified,
 *                          with mismatch/duplicate_suspected as review states.
 *
 * These are independent, exactly like Order's lifecycle/payment/fulfillment
 * axes: a payment can be "Paid · Staff confirmed" or "Pending · Needs review"
 * without either fact implying the other.
 *
 * ── WHY VERIFICATION DRIVES STATUS, NOT THE OTHER WAY AROUND ─────────────────
 *
 * Only verify_payment_v1 (migration 035) ever changes `status`, and it does so
 * as the DERIVED CONSEQUENCE of a verification_state change — never
 * independently. There is no "set status directly" entry point, mirroring
 * Order's "no arbitrary updates" invariant. See resultingPaymentStatus below,
 * which is the single, testable description of that mapping.
 *
 * ── EVIDENCE IS NEVER AN INPUT TO THIS MACHINE ───────────────────────────────
 *
 * Attaching evidence (a screenshot, a QR scan) has NO transition here. It
 * cannot move verification_state or status by itself — see
 * attach_payment_evidence_v1 (migration 035) and SECURITY.md §41. Only a
 * human (payments.manual_confirm / payments.verify) or a future bank adapter
 * result can drive this machine.
 */

// ── Status vocabularies (must match migration 034's enums exactly) ────────────

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "reversed", "refunded"] as const;

export const PAYMENT_VERIFICATION_STATES = [
  "unverified",
  "staff_confirmed",
  "manager_verified",
  "bank_verified",
  "mismatch",
  "duplicate_suspected",
] as const;

export const PAYMENT_METHODS = ["cash", "khqr", "bank_transfer", "cod"] as const;

export const PAYMENT_EVIDENCE_TYPES = ["screenshot", "qr_scan", "receipt", "other"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentVerificationState = (typeof PAYMENT_VERIFICATION_STATES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentEvidenceType = (typeof PAYMENT_EVIDENCE_TYPES)[number];

/** Terminal payment statuses: no verification transition may proceed past them. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ["reversed", "refunded"];

// ── Verification transition table ─────────────────────────────────────────────
//
// Exhaustive: a state maps to the complete set of states that may follow it.
// Anything not listed is invalid — no default-allow anywhere in this file.

/**
 * VERIFICATION
 *
 *   unverified -> staff_confirmed     a human confirms payment received
 *   unverified -> bank_verified       an API-confirmed bank payment can jump
 *                                     straight to bank-level trust with no
 *                                     manual step at all
 *   unverified -> mismatch            the claim did not hold up on inspection
 *
 *   staff_confirmed -> manager_verified   a manager re-confirms at higher trust
 *   staff_confirmed -> bank_verified       later reconciled against the bank
 *   staff_confirmed -> mismatch            found not to hold up after all
 *
 *   manager_verified -> bank_verified
 *   manager_verified -> mismatch
 *
 *   bank_verified -> mismatch          even bank-verified money can later be
 *                                      found disputed (a chargeback-like case)
 *
 *   mismatch -> unverified             investigated and restarted from scratch
 *
 *   duplicate_suspected -> unverified        reviewed and found to be a false
 *                                             positive (a legitimately resent
 *                                             screenshot, not a real duplicate)
 *   duplicate_suspected -> staff_confirmed   reviewed and accepted
 *   duplicate_suspected -> manager_verified  reviewed and accepted at higher trust
 *   duplicate_suspected -> mismatch          reviewed and found genuinely wrong
 */
export const VERIFICATION_TRANSITIONS: Readonly<
  Record<PaymentVerificationState, readonly PaymentVerificationState[]>
> = {
  unverified: ["staff_confirmed", "bank_verified", "mismatch"],
  staff_confirmed: ["manager_verified", "bank_verified", "mismatch"],
  manager_verified: ["bank_verified", "mismatch"],
  bank_verified: ["mismatch"],
  mismatch: ["unverified"],
  duplicate_suspected: ["unverified", "staff_confirmed", "manager_verified", "mismatch"],
};

export function isValidVerificationTransition(
  from: PaymentVerificationState,
  to: PaymentVerificationState,
): boolean {
  return VERIFICATION_TRANSITIONS[from].includes(to);
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/**
 * The payment `status` that results from moving to a given verification
 * state. This is a DERIVED CONSEQUENCE, never an independent instruction —
 * verify_payment_v1 (migration 035) applies exactly this mapping and nothing
 * else may change `status` outside reverse_payment_v1 / refund_payment_v1.
 */
export function resultingPaymentStatus(to: PaymentVerificationState): PaymentStatus {
  switch (to) {
    case "staff_confirmed":
    case "manager_verified":
    case "bank_verified":
      return "paid";
    case "mismatch":
      return "failed";
    case "unverified":
    case "duplicate_suspected":
      return "pending";
  }
}

// ── Who may perform each transition ───────────────────────────────────────────
//
// Permission keys only — the check itself is the caller's, against a
// server-verified AuthorizationContext. Keys are those seeded by migration
// 036 (PERMISSIONS_MATRIX.md §17).

/**
 * The permission required to move `verification_state` to a given target.
 *
 * staff_confirmed is the "Confirm payment received" action available even
 * with no bank integration at all (the core APSA payment principle). Every
 * other target is an escalation or a correction and requires payments.verify.
 */
export const VERIFICATION_TRANSITION_PERMISSIONS: Readonly<
  Record<PaymentVerificationState, string>
> = {
  unverified: "payments.verify",
  staff_confirmed: "payments.manual_confirm",
  manager_verified: "payments.verify",
  bank_verified: "payments.verify",
  mismatch: "payments.verify",
  duplicate_suspected: "payments.verify",
};
