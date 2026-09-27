/**
 * Account recovery policy — pure, client-safe.
 *
 * Shared by the auth server functions (src/api/auth.ts) and the recovery
 * screens so the password rule and the provider-error mapping live in one
 * place. Nothing here touches Supabase, cookies or tokens.
 *
 * Anti-enumeration contract (public, email-addressed requests):
 *   - A password-reset request and a signed-out verification resend answer
 *     the same way whether or not the email has an account. Supabase only
 *     sends mail — and so can only fail to send, rate-limit per user, or hit
 *     an SMTP/5xx error — for an existing account, and supabase-js surfaces a
 *     5xx as an AuthRetryableFetchError. Every provider answer, including
 *     transport-shaped ones, therefore collapses to the neutral "sent" result.
 *   - Only account-independent failures (a misconfigured app URL, checked
 *     before any provider call) are reported to a public caller.
 *   - A signed-in, unverified member resending to their OWN session address
 *     may see an honest rate-limit / outage answer: it discloses nothing about
 *     any other account.
 */

/** Matches signUpFn's server policy (src/api/auth.ts) — keep the two in step. */
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt, which Supabase Auth uses, ignores everything past 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72;

/**
 * Cooldown between resend / reset-request submissions. The React countdown is
 * UX only; the server enforces the same window (src/lib/auth-email-throttle.ts).
 */
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

export type ResendVerificationOutcome = "sent" | "rate_limited" | "service_unavailable";

/**
 * Only for a resend addressed to the caller's own session email — see the
 * contract at the top. Public, email-addressed requests never call this.
 */
export function classifyOwnVerificationResend(
  error: ProviderAuthError | null,
): ResendVerificationOutcome {
  if (!error) return "sent";
  if (isRateLimited(error)) return "rate_limited";
  if (isTransportFailure(error) || (error.status !== undefined && error.status >= 500)) {
    return "service_unavailable";
  }
  // Already-confirmed or otherwise refused: the neutral "sent" copy fits.
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

// ── Auth email redirect base (VITE_APP_URL) ─────────────────────────────────

export type AppBaseUrl =
  | { ok: true; origin: string | undefined }
  | { ok: false; reason: "malformed" | "scheme" | "credentials" | "not_origin" };

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates the configured canonical app URL before it is used to build an
 * auth-email redirect. Unset → `origin: undefined` (Supabase then falls back
 * to the project's Site URL). Anything set must be a bare absolute origin:
 * https (http only for localhost outside production), no credentials, no
 * path, query or fragment.
 */
export function resolveAppBaseUrl(raw: string | undefined, isProduction: boolean): AppBaseUrl {
  const value = raw?.trim() ?? "";
  if (!value) return { ok: true, origin: undefined };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const localHttp = !isProduction && url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (value.includes("?") || value.includes("#") || url.pathname.replace(/\/+$/, "") !== "") {
    return { ok: false, reason: "not_origin" };
  }
  return { ok: true, origin: url.origin };
}
