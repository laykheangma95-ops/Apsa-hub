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
  /** 10 account creations per client IP per hour (skipped when the IP is unknown). */
  signUpIp: rule("auth.sign_up.ip", 10, 60 * 60),
  /**
   * 5 sign-up attempts per normalized email per hour — the header-independent
   * dimension. Every attempt counts, whether or not the address is taken.
   */
  signUpIdentity: rule("auth.sign_up.identity", 5, 60 * 60),
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
  /**
   * 5 verifications per link token (token_hash) per 15 min — the dimension for
   * links that carry no email. A token_hash is unguessable, so this bounds
   * replay of one link, not guessing.
   */
  otpVerifyToken: rule("auth.otp_verify.token", 5, 15 * 60),
  /** 30 OTP / recovery-link verifications per client IP per 15 min. */
  otpVerifyIp: rule("auth.otp_verify.ip", 30, 15 * 60),
  /** 10 new-password submissions per client IP per 15 min (recovery session required anyway). */
  recoveryCompleteIp: rule("auth.recovery_complete.ip", 10, 15 * 60),
  /**
   * 10 new-password submissions per recovery session per 15 min, keyed by an
   * HMAC digest of the session's refresh token — header-independent.
   */
  recoveryCompleteSession: rule("auth.recovery_complete.session", 10, 15 * 60),

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

  // ── Product images: cost-bearing upload authority ─────────────────────────
  //
  // Each ticket is a signed URL that lets the holder write up to 5 MiB to
  // storage. A merchant setting up a catalogue adds a photo per product (and
  // retries failed phone uploads): 60/hour per member is one a minute for an
  // hour, 200/hour per organization is several staff doing that at once.
  // Beyond that, someone is scripting storage writes. Outstanding (issued but
  // not yet attached) tickets are capped separately in image-service.ts.

  productImageUploadMember: rule("products.image_upload.member", 60, 60 * 60),
  productImageUploadOrganization: rule("products.image_upload.organization", 200, 60 * 60),

  // ── Webhooks (future providers) ───────────────────────────────────────────
  /**
   * Per provider per client IP, before any signature work. SECONDARY only:
   * signature verification and replay protection are the primary controls,
   * and the bucket is skipped when the IP is unknown.
   */
  webhookIp: rule("webhooks.ip", 600, 60),
} as const satisfies Record<string, RateLimitRule>;

/**
 * What a limit does when the DURABLE (PostgreSQL) backend is unavailable.
 *
 *   memory_fallback — degrade to the per-instance memory store for that hit
 *                     (still enforcing, but N instances ⇒ up to N × limit).
 *   fail_closed     — refuse the operation with a retryable 503
 *                     (RateLimitUnavailableError) and never touch memory.
 */
export type BackendFailurePolicy = "memory_fallback" | "fail_closed";

/**
 * The failure policy per operation class — explicit, not a default.
 *
 * Refunds, reversals and corrections move money back out (or rewrite a
 * financial record) and are the target of a stolen-session or insider abuse
 * run; a per-instance limit would multiply by the instance count exactly when
 * the database is struggling. They FAIL CLOSED: the merchant retries in a
 * moment, nothing is mutated.
 *
 * Sign-in / auth emails / sign-up, order creation and routine payment
 * record/verify/attach degrade to memory: a database blip must not lock
 * merchants out of the POS or their account, each is behind authorization,
 * idempotency (orders, payments) or Supabase's own provider limits, and
 * every record/verify is additionally bounded by the payment state machine.
 */
export const BACKEND_FAILURE_POLICY = {
  auth: "memory_fallback",
  orderCreate: "memory_fallback",
  paymentMutation: "memory_fallback",
  financialReversal: "fail_closed",
  // A signed upload URL is cost-bearing write authority; a per-instance memory
  // limit would multiply by the instance count exactly when the database is
  // struggling. Photos are optional: the merchant retries in a moment.
  productImageUpload: "fail_closed",
  webhook: "memory_fallback",
} as const satisfies Record<string, BackendFailurePolicy>;

export type RateLimitRuleName = keyof typeof RATE_LIMITS;
