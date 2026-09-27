/**
 * Account recovery policy — pure, client-safe.
 *
 * Shared by the auth server functions (src/api/auth.ts) and the recovery
 * screens so the password rule and the provider-error mapping live in one
 * place. Nothing here touches Supabase, cookies or tokens.
 *
 * Anti-enumeration contract:
 *   - A password-reset request answers the same way whether or not the email
 *     has an account. Supabase only sends mail (and can only fail to send, or
 *     rate-limit per user) for an existing account, so every provider-side
 *     answer collapses to the neutral "sent" result. Only a transport failure
 *     — which happens identically for any email — is reported as an error.
 *   - Verification resend reports a provider rate limit honestly (the product
 *     requirement) but never "no such account" / "already confirmed".
 */

/** Matches signUpFn's server policy (src/api/auth.ts) — keep the two in step. */
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt, which Supabase Auth uses, ignores everything past 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72;

/** Client cooldown between resend / reset-request submissions. */
export const AUTH_EMAIL_COOLDOWN_SECONDS = 60;

/** Lifetime of the HttpOnly recovery cookie — the window to choose a new password. */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;

export type NewPasswordIssue = "too_short" | "too_long" | "mismatch";

export function validateNewPassword(
  password: string,
  confirmPassword: string,
): NewPasswordIssue | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  if (password !== confirmPassword) return "mismatch";
  return null;
}

/** The subset of a Supabase AuthError this module relies on. */
export type ProviderAuthError = {
  name?: string | undefined;
  status?: number | undefined;
  code?: string | undefined;
};

/**
 * True when the request never got a real answer from Supabase Auth (network
 * down, timeout, 5xx gateway). That outcome is independent of which email was
 * submitted, so reporting it leaks nothing.
 */
export function isTransportFailure(error: ProviderAuthError): boolean {
  if (error.name === "AuthRetryableFetchError") return true;
  if (error.status === undefined || error.status === 0) return true;
  return error.status >= 502 && error.status <= 504;
}

export function isRateLimited(error: ProviderAuthError): boolean {
  return (
    error.status === 429 ||
    error.code === "over_email_send_rate_limit" ||
    error.code === "over_request_rate_limit"
  );
}

export type PasswordResetRequestOutcome = "sent" | "service_unavailable";

export function classifyPasswordResetRequest(
  error: ProviderAuthError | null,
): PasswordResetRequestOutcome {
  if (!error) return "sent";
  // Every provider-side answer — unknown user, rate limit, SMTP failure —
  // is indistinguishable to the caller. See the contract at the top.
  return isTransportFailure(error) ? "service_unavailable" : "sent";
}

export type ResendVerificationOutcome = "sent" | "rate_limited" | "service_unavailable";

export function classifyResendVerification(
  error: ProviderAuthError | null,
): ResendVerificationOutcome {
  if (!error) return "sent";
  if (isRateLimited(error)) return "rate_limited";
  if (isTransportFailure(error)) return "service_unavailable";
  // Unknown or already-confirmed email: answered with the same neutral copy
  // as a real send ("if this email is waiting for confirmation…").
  return "sent";
}

export type PasswordUpdateIssue =
  "weak_password" | "same_password" | "recovery_expired" | "unexpected_error";

export function classifyPasswordUpdate(error: ProviderAuthError): PasswordUpdateIssue {
  if (error.code === "weak_password" || error.name === "AuthWeakPasswordError") {
    return "weak_password";
  }
  if (error.code === "same_password") return "same_password";
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.code === "session_not_found" ||
    error.code === "session_expired" ||
    error.code === "bad_jwt" ||
    error.name === "AuthSessionMissingError"
  ) {
    return "recovery_expired";
  }
  return "unexpected_error";
}
