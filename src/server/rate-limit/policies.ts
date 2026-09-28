/**
 * Rate-limit policies — every limit APSA enforces, with its rationale.
 *
 * All windows are FIXED windows counted in PostgreSQL (migration 045,
 * consume_rate_limit()), so every server instance shares one counter per
 * bucket. See docs/OPERABILITY.md for the full design and the serverless
 * analysis.
 *
 * Values are chosen so a real person — including a busy merchant with several
 * cashiers — never meets them in normal use, while a script hammering one
 * identity, address or tenant is stopped within a window. Change a value here
 * only together with docs/OPERABILITY.md §4.
 */

export interface RateLimitRule {
  /** Stable identifier; also stored with each bucket for operations. */
  readonly id: string;
  /** Maximum hits allowed inside one window. */
  readonly limit: number;
  /** Fixed window length. */
  readonly windowSeconds: number;
}

function rule(id: string, limit: number, windowSeconds: number): RateLimitRule {
  return Object.freeze({ id, limit, windowSeconds });
}

export const RATE_LIMITS = {
  // ── Auth: public, unauthenticated, enumeration-sensitive ──────────────────
  //
  // Identity buckets are keyed by an HMAC digest of the NORMALIZED email —
  // the raw address is never stored. Every attempt counts (not only failures),
  // so the answer to "is this bucket full?" is the same whether or not the
  // account exists: the limiter itself cannot be used to enumerate accounts.

  /** 10 sign-in attempts per email per 15 min: many typo retries, no password spraying. */
  signInIdentity: rule("auth.sign_in.identity", 10, 15 * 60),
  /** 50 sign-in attempts per client IP per 15 min: a shared shop/NAT IP still fits. */
  signInIp: rule("auth.sign_in.ip", 50, 15 * 60),
  /** 10 account creations per client IP per hour. */
  signUpIp: rule("auth.sign_up.ip", 10, 60 * 60),
  /**
   * Password-reset and verification emails: one per address per 60 s (the
   * cooldown the screens already show, AUTH_EMAIL_COOLDOWN_SECONDS) …
   */
  passwordResetCooldown: rule("auth.password_reset.cooldown", 1, 60),
  verificationResendCooldown: rule("auth.verification_resend.cooldown", 1, 60),
  /** … and at most 5 per address per hour, so the cooldown cannot be walked. */
  authEmailHourly: rule("auth.email.hourly", 5, 60 * 60),
  /** 20 auth emails per client IP per hour, across addresses. */
  authEmailIp: rule("auth.email.ip", 20, 60 * 60),
  /** 10 OTP / recovery-link verifications per email per 15 min (6-digit codes are guessable). */
  otpVerifyIdentity: rule("auth.otp_verify.identity", 10, 15 * 60),
  /** 30 OTP / recovery-link verifications per client IP per 15 min. */
  otpVerifyIp: rule("auth.otp_verify.ip", 30, 15 * 60),
  /** 10 new-password submissions per client IP per 15 min (recovery session required anyway). */
  recoveryCompleteIp: rule("auth.recovery_complete.ip", 10, 15 * 60),

  // ── Orders: authenticated, high volume, idempotent ────────────────────────
  //
  // A busy POS runs at roughly one sale per 10–20 s per cashier. 60/min per
  // member is one order per second sustained; 600/min per organization is ten
  // members at that ceiling. An idempotent REPLAY of an order that already
  // exists is never blocked by these (see src/server/orders/service.ts).

  orderCreateMember: rule("orders.create.member", 60, 60),
  orderCreateOrganization: rule("orders.create.organization", 600, 60),

  // ── Payments: financial impact, audited ───────────────────────────────────
  //
  // Recording/verifying a payment is a per-order human action: 60/min per
  // member is far above any real counter. Refunds, reversals and corrections
  // move money back out and carry mandatory audit: 20/min per member.

  paymentMutateMember: rule("payments.mutate.member", 60, 60),
  paymentReversalMember: rule("payments.reversal.member", 20, 60),

  // ── Webhooks (future providers) ───────────────────────────────────────────
  /** Per provider per client IP, before any signature work. */
  webhookIp: rule("webhooks.ip", 600, 60),
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof RATE_LIMITS;
