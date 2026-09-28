/**
 * Auth abuse limits — imported (dynamically) only by src/api/auth.ts handlers.
 *
 * Replaces the per-instance in-memory email cooldown (src/lib/auth-email-throttle.ts,
 * PR #76) with the shared PostgreSQL limiter, keeping its exact contract:
 *
 *   - Keys are HMAC digests of the NORMALIZED email (trim + lowercase) — the
 *     raw address never reaches the database or a log.
 *   - Every attempt counts, whether or not an account exists, so a full bucket
 *     says nothing about the account. Public email-addressed endpoints keep
 *     answering a throttled request exactly like a sent one (see auth.ts).
 *   - Supabase Auth's own limits remain behind this as the provider-side hard
 *     limit; this layer stops a caller before APSA spends a provider call.
 *
 * Values and rationale: src/server/rate-limit/policies.ts.
 *
 * Server-only.
 */
import { currentClientIp } from "./client-ip";
import { normalizeEmailForKey } from "./keys";
import { checkRateLimits, resetRateLimitFallbackStore } from "./limiter";
import { RATE_LIMITS } from "./policies";

export type AuthEmailPurpose = "password_reset" | "verification_resend";

async function resolveIp(clientIp: string | null | undefined): Promise<string | null> {
  return clientIp === undefined ? currentClientIp() : clientIp;
}

/**
 * Returns true — and records the attempt — when an auth email may be sent
 * now; false while the address (or client IP) is inside a limit.
 */
export async function claimAuthEmailSlot(
  purpose: AuthEmailPurpose,
  email: string,
  nowMs?: number,
  clientIp?: string | null,
): Promise<boolean> {
  const identity = normalizeEmailForKey(email);
  const cooldown =
    purpose === "password_reset"
      ? RATE_LIMITS.passwordResetCooldown
      : RATE_LIMITS.verificationResendCooldown;
  const decision = await checkRateLimits(
    [
      { rule: cooldown, parts: [identity] },
      { rule: RATE_LIMITS.authEmailHourly, parts: [identity] },
      { rule: RATE_LIMITS.authEmailIp, parts: [await resolveIp(clientIp)] },
    ],
    nowMs,
  );
  return decision.allowed;
}

/** Sign-in: per normalized email AND per client IP. */
export async function allowSignInAttempt(
  email: string,
  nowMs?: number,
  clientIp?: string | null,
): Promise<boolean> {
  const decision = await checkRateLimits(
    [
      { rule: RATE_LIMITS.signInIdentity, parts: [normalizeEmailForKey(email)] },
      { rule: RATE_LIMITS.signInIp, parts: [await resolveIp(clientIp)] },
    ],
    nowMs,
  );
  return decision.allowed;
}

/** Sign-up: per client IP (skipped when no IP is known; Supabase limits remain). */
export async function allowSignUpAttempt(
  nowMs?: number,
  clientIp?: string | null,
): Promise<boolean> {
  const decision = await checkRateLimits(
    [{ rule: RATE_LIMITS.signUpIp, parts: [await resolveIp(clientIp)] }],
    nowMs,
  );
  return decision.allowed;
}

/**
 * OTP / recovery-link verification: per normalized email when the link
 * carries one (a 6-digit code is guessable), and always per client IP.
 */
export async function allowOtpVerification(
  email: string | null,
  nowMs?: number,
  clientIp?: string | null,
): Promise<boolean> {
  const decision = await checkRateLimits(
    [
      { rule: RATE_LIMITS.otpVerifyIdentity, parts: [email ? normalizeEmailForKey(email) : null] },
      { rule: RATE_LIMITS.otpVerifyIp, parts: [await resolveIp(clientIp)] },
    ],
    nowMs,
  );
  return decision.allowed;
}

/** New-password submission during recovery: per client IP. */
export async function allowRecoveryCompletion(
  nowMs?: number,
  clientIp?: string | null,
): Promise<boolean> {
  const decision = await checkRateLimits(
    [{ rule: RATE_LIMITS.recoveryCompleteIp, parts: [await resolveIp(clientIp)] }],
    nowMs,
  );
  return decision.allowed;
}

/** Test hook — clears every attempt the per-process fallback store recorded. */
export function resetAuthRateLimits(): void {
  resetRateLimitFallbackStore();
}
