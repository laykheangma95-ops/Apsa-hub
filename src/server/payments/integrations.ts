/**
 * Bank / API verification integration contract.
 *
 * This phase ships NO live external bank integration (ARCHITECTURE.md —
 * provider abstractions; MVP_ROADMAP.md §14 — "No real payment provider
 * required for first beta"). What it ships is the CONTRACT a future adapter
 * (ABA, Wing, Bakong/KHQR, or any other bank/API partner) must satisfy, so
 * that:
 *
 *   1. No provider-specific field or call ever appears in the domain layer
 *      (ARCHITECTURE.md — "provider abstractions ... no provider-specific
 *      calls appear in domain types").
 *   2. A future webhook handler can call `normalizeVerificationResult` and
 *      feed the result straight into the existing verify_payment_v1 RPC via
 *      src/server/payments/service.ts, with no schema change required here.
 *
 * NOTHING in this file is wired into service.ts's request path yet. It exists
 * so the shape is fixed, tested, and ready — not so it runs.
 */

import type { PaymentCurrency } from "./types";

/** What a caller supplies to ask an adapter to look up a transaction. */
export interface PaymentVerificationRequest {
  organizationId: string;
  paymentId: string;
  /** The reference as claimed by the merchant/customer (payments.reference). */
  reference: string | null;
  amountMinor: number;
  currency: PaymentCurrency;
}

/**
 * Normalized outcome of a verification attempt, independent of which
 * provider produced it. This is the shape verify_payment_v1's p_to /
 * p_metadata are derived from — never a provider's raw payload.
 */
export type PaymentVerificationOutcome =
  /** The provider confirms a matching transaction for this amount/reference. */
  | { kind: "verified"; providerReference: string; verifiedAt: string }
  /** The provider found a transaction, but amount/reference/time disagree. */
  | { kind: "mismatch"; reason: string }
  /** The provider reports this reference was already used by another transaction. */
  | { kind: "duplicate"; conflictingReference: string }
  /** The provider has no record of this transaction (yet, or at all). */
  | { kind: "not_found" }
  /** The adapter itself failed (network, auth, malformed response) — not a verdict. */
  | { kind: "adapter_error"; message: string };

/**
 * A bank/API verification adapter. Implementations live outside this domain
 * (e.g. a future `src/server/payments/providers/aba.ts`) and are never
 * imported by name from service.ts — only through this interface, so the
 * domain layer stays provider-agnostic per ARCHITECTURE.md.
 */
export interface PaymentVerificationAdapter {
  /** Stable identifier for audit/event metadata — never a display name. */
  readonly providerKey: string;

  /**
   * Ask the provider to verify a claimed transaction. Must never throw for an
   * ordinary "not found" or "mismatch" outcome — those are normal results,
   * not adapter failures. Reserve throwing/`adapter_error` for genuine
   * transport or protocol failures.
   */
  verify(request: PaymentVerificationRequest): Promise<PaymentVerificationOutcome>;
}

/**
 * The default adapter for this phase: it always reports "not_found", because
 * no live provider is integrated yet. This lets calling code exercise the
 * full contract shape (and be tested against it) without a real bank
 * connection, and gives a safe, explicit answer rather than silently
 * pretending verification succeeded.
 */
export const manualOnlyAdapter: PaymentVerificationAdapter = {
  providerKey: "manual_only",
  async verify(): Promise<PaymentVerificationOutcome> {
    return { kind: "not_found" };
  },
};

/**
 * Map a normalized adapter outcome to the verify_payment_v1 target
 * verification state + event metadata. Pure and DB-free, so the mapping is
 * independently testable from any adapter implementation.
 */
export function outcomeToVerificationTarget(
  outcome: PaymentVerificationOutcome,
):
  | { to: "bank_verified"; metadata: Record<string, unknown> }
  | { to: "mismatch"; metadata: Record<string, unknown> }
  | { to: null; metadata: Record<string, unknown> } {
  switch (outcome.kind) {
    case "verified":
      return {
        to: "bank_verified",
        metadata: { providerReference: outcome.providerReference, verifiedAt: outcome.verifiedAt },
      };
    case "mismatch":
      return { to: "mismatch", metadata: { reason: outcome.reason } };
    case "duplicate":
      return { to: "mismatch", metadata: { conflictingReference: outcome.conflictingReference } };
    case "not_found":
      return { to: null, metadata: {} };
    case "adapter_error":
      return { to: null, metadata: { adapterError: outcome.message } };
  }
}
