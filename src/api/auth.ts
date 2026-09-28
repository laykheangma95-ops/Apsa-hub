/**
 * Server-side auth API — TanStack Start server functions.
 *
 * Session architecture:
 *   - Two HttpOnly cookies: sb-access-token + sb-refresh-token
 *   - Secure in production; SameSite=Lax; path=/
 *   - On every protected request: access token is validated via Supabase.auth.getUser()
 *   - If access token expired: refresh_token is used to obtain new tokens
 *   - Refreshed tokens are written back to cookies in the same response
 *   - Browser auth state (supabase.auth) is UX only, not authorization truth
 *
 * Security constraints:
 *   - No SUPABASE_JWT_SECRET used — validation always via Supabase Auth API
 *   - No service-role key in browser code
 *   - Email verification enforced independently here AND in createOrganizationFn
 *   - No client-supplied user_id, org_id, or role_id trusted for auth decisions
 *   - @/lib/supabase/server is imported dynamically inside handler bodies only —
 *     never at module scope — so the service-role Proxy never enters the client bundle
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  classifyOwnVerificationResend,
  classifyPasswordUpdate,
  isTransportFailure,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RECOVERY_WINDOW_SECONDS,
  resolveAppBaseUrl,
  type PasswordUpdateIssue,
  type ProviderAuthError,
} from "@/lib/auth-recovery";
import {
  CANONICAL_MEMBERSHIP_ORDER,
  pickCanonicalActiveMembership,
} from "@/lib/active-organization";

// ── Cookie constants — defined inline to avoid importing @/lib/supabase/server ─
// Keeping these here means auth.ts carries no static dependency on the admin module.
export const COOKIE_ACCESS_TOKEN = "sb-access-token";
export const COOKIE_REFRESH_TOKEN = "sb-refresh-token";
// Password-recovery session — never read by getSessionFn or the /app guard.
export const COOKIE_RECOVERY_ACCESS_TOKEN = "sb-recovery-access-token";
export const COOKIE_RECOVERY_REFRESH_TOKEN = "sb-recovery-refresh-token";

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerSession {
  userId: string;
  email: string;
  emailVerified: true;
  accessToken: string;
}

export interface UnverifiedServerSession {
  userId: string;
  email: string;
  emailVerified: false;
  accessToken: string;
}

export type SessionResult = ServerSession | UnverifiedServerSession | null;
export type AuthRedirect = "/app" | "/onboarding" | "/verify-email" | "/access-denied";

type AuthUserLike = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
};

// ── Cookie helpers ────────────────────────────────────────────────────────────

async function writeSessionCookies(accessToken: string, refreshToken: string): Promise<void> {
  const { setCookie } = await import("@tanstack/react-start/server");
  setCookie(COOKIE_ACCESS_TOKEN, accessToken, COOKIE_OPTIONS);
  setCookie(COOKIE_REFRESH_TOKEN, refreshToken, COOKIE_OPTIONS);
}

async function clearSessionCookies(): Promise<void> {
  const { deleteCookie } = await import("@tanstack/react-start/server");
  deleteCookie(COOKIE_ACCESS_TOKEN, { path: "/" });
  deleteCookie(COOKIE_REFRESH_TOKEN, { path: "/" });
}

async function writeRecoveryCookies(accessToken: string, refreshToken: string): Promise<void> {
  const { setCookie } = await import("@tanstack/react-start/server");
  const options = { ...COOKIE_OPTIONS, maxAge: RECOVERY_WINDOW_SECONDS };
  setCookie(COOKIE_RECOVERY_ACCESS_TOKEN, accessToken, options);
  setCookie(COOKIE_RECOVERY_REFRESH_TOKEN, refreshToken, options);
}

/**
 * Drops any pending password-recovery authorization. Called on every
 * identity transition — sign-in, sign-up/verification that issues a session,
 * sign-out, and the start of any new recovery-link attempt — so a recovery
 * begun for one account can never outlive a change of principal.
 */
async function clearRecoveryCookies(): Promise<void> {
  const { deleteCookie } = await import("@tanstack/react-start/server");
  deleteCookie(COOKIE_RECOVERY_ACCESS_TOKEN, { path: "/" });
  deleteCookie(COOKIE_RECOVERY_REFRESH_TOKEN, { path: "/" });
}

export const clearAuthCookieFn = createServerFn().handler(async (): Promise<void> => {
  await clearSessionCookies();
});

function buildSessionResult(user: AuthUserLike, accessToken: string): Exclude<SessionResult, null> {
  const baseSession = {
    userId: user.id,
    email: user.email ?? "",
    accessToken,
  };

  if (!user.email_confirmed_at) {
    return {
      ...baseSession,
      emailVerified: false,
    };
  }

  return {
    ...baseSession,
    emailVerified: true,
  };
}

type MembershipRow = {
  organization_id: string;
  status: string;
  joined_at: string;
};

export type AuthenticatedRouteResult =
  { ok: true; organizationId: string } | { ok: false; redirect: Exclude<AuthRedirect, "/app"> };

async function getMembershipRows(userId: string): Promise<{
  data: MembershipRow[] | null;
  error: { message?: string } | null;
}> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("memberships")
    .select("organization_id, status, joined_at")
    .eq("user_id", userId)
    .in("status", ["active", "suspended", "removed"])
    .order(CANONICAL_MEMBERSHIP_ORDER.column, { ascending: CANONICAL_MEMBERSHIP_ORDER.ascending });

  return {
    data: (data ?? null) as MembershipRow[] | null,
    error: error ? { message: error.message } : null,
  };
}

export async function resolveAuthenticatedRoute(
  session: Exclude<SessionResult, null>,
): Promise<AuthenticatedRouteResult> {
  if (!session.emailVerified) return { ok: false, redirect: "/verify-email" };

  const { data, error } = await getMembershipRows(session.userId);
  if (error) {
    await clearSessionCookies();
    throw new Error(error.message ?? "Unable to resolve organization membership");
  }

  const memberships = data ?? [];
  const activeMembership = pickCanonicalActiveMembership(memberships);
  if (activeMembership) return { ok: true, organizationId: activeMembership.organization_id };

  const revokedMembership = memberships.find(
    (membership) => membership.status === "suspended" || membership.status === "removed",
  );
  if (revokedMembership) {
    await clearSessionCookies();
    return { ok: false, redirect: "/access-denied" };
  }

  return { ok: false, redirect: "/onboarding" };
}

// ── getSessionFn ─────────────────────────────────────────────────────────────
//
// Validates the cookie-based auth session on every protected request.
// Handles access-token expiry by refreshing with the stored refresh token.
// Writes refreshed tokens back to cookies.
//
// Returns null when:
//   - No cookies present (not signed in)
//   - Refresh token is invalid/expired (session fully expired)
//   - Supabase auth API is unreachable (treated as unauthenticated)

export const getSessionFn = createServerFn().handler(async (): Promise<SessionResult> => {
  const { getCookie } = await import("@tanstack/react-start/server");
  const accessToken = getCookie(COOKIE_ACCESS_TOKEN);
  const refreshToken = getCookie(COOKIE_REFRESH_TOKEN);

  if (!accessToken || !refreshToken) return null;

  // Dynamic import — keeps @/lib/supabase/server out of the client bundle.
  const { createServerClient, createRefreshClient } = await import("@/lib/supabase/server");

  // Validate the access token via Supabase Auth API.
  const client = createServerClient(accessToken);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();

  if (!error && user) {
    return buildSessionResult(user, accessToken);
  }

  // Access token invalid or expired — try refresh.
  const refreshClient = createRefreshClient();
  const { data: refreshData, error: refreshError } = await refreshClient.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (refreshError || !refreshData.session) {
    // Refresh failed — session fully expired, clear cookies.
    await clearSessionCookies();
    return null;
  }

  const { session } = refreshData;
  // Write refreshed tokens back to cookies.
  await writeSessionCookies(session.access_token, session.refresh_token);

  return buildSessionResult(session.user, session.access_token);
});

// ── signInFn ──────────────────────────────────────────────────────────────────

const SignInInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SignInInput = z.infer<typeof SignInInput>;

export interface SignInResult {
  ok: true;
  redirectTo: AuthRedirect;
}

/**
 * `unexpected_error` never carries provider or database text: `reference` is
 * the request's support ID (src/server/observability/request-id.ts) so a
 * failed sign-in can be matched to its server log line.
 */
export type SignInError =
  | { ok: false; code: "invalid_credentials" }
  | { ok: false; code: "rate_limited" }
  | { ok: false; code: "unexpected_error"; reference?: string };

export const signInFn = createServerFn()
  .validator((data: unknown) => SignInInput.parse(data))
  .handler(async ({ data }): Promise<SignInResult | SignInError> => {
    // Counted for EVERY attempt, before Supabase is asked anything, so a full
    // bucket says nothing about whether the account exists.
    const { allowSignInAttempt } = await import("@/server/rate-limit/auth-limits");
    if (!(await allowSignInAttempt(data.email))) return { ok: false, code: "rate_limited" };

    const url = process.env["VITE_SUPABASE_URL"]!;
    const anonKey = process.env["VITE_SUPABASE_ANON_KEY"]!;

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error } = await client.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (error || !authData.session) {
      if (error?.status === 400 || error?.status === 422) {
        return { ok: false, code: "invalid_credentials" };
      }
      await logProviderFailure("auth.sign_in", error ?? { name: "AuthUnknownError" });
      return { ok: false, code: "unexpected_error", ...(await supportReference()) };
    }

    // A different (or the same) principal just authenticated: no recovery
    // begun earlier in this browser may survive it.
    await clearRecoveryCookies();

    const authenticatedSession = buildSessionResult(
      authData.session.user,
      authData.session.access_token,
    );

    try {
      const routeResult = await resolveAuthenticatedRoute(authenticatedSession);
      if (!routeResult.ok && routeResult.redirect === "/access-denied") {
        return { ok: true, redirectTo: routeResult.redirect };
      }

      await writeSessionCookies(authData.session.access_token, authData.session.refresh_token);

      return { ok: true, redirectTo: routeResult.ok ? "/app" : routeResult.redirect };
    } catch (error) {
      // Credentials were valid but the membership lookup failed. The
      // database's text goes to the server log only, never to the browser.
      const { reportServerError } = await import("@/server/observability/errors");
      reportServerError(error, { event: "auth.sign_in.access_state_failed" });
      return { ok: false, code: "unexpected_error", ...(await supportReference()) };
    }
  });

// ── signUpFn ──────────────────────────────────────────────────────────────────

const SignUpInput = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(100),
});

export type SignUpInput = z.infer<typeof SignUpInput>;

export interface SignUpResult {
  ok: true;
  emailVerificationRequired: boolean;
}

/**
 * `weak_password.message` is Supabase's password-policy sentence (which rule
 * failed) and is shown as-is. `unexpected_error` carries no provider text —
 * only the request's support `reference`.
 */
export type SignUpError =
  | { ok: false; code: "email_taken" }
  | { ok: false; code: "weak_password"; message: string }
  | { ok: false; code: "rate_limited" }
  | { ok: false; code: "unexpected_error"; reference?: string };

export const signUpFn = createServerFn()
  .validator((data: unknown) => SignUpInput.parse(data))
  .handler(async ({ data }): Promise<SignUpResult | SignUpError> => {
    const { allowSignUpAttempt } = await import("@/server/rate-limit/auth-limits");
    if (!(await allowSignUpAttempt(data.email))) return { ok: false, code: "rate_limited" };

    const url = process.env["VITE_SUPABASE_URL"]!;
    const anonKey = process.env["VITE_SUPABASE_ANON_KEY"]!;

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error } = await client.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: { display_name: data.displayName },
      },
    });

    if (error) {
      if (error.message?.includes("already registered") || error.status === 422) {
        return { ok: false, code: "email_taken" };
      }
      if (error.message?.includes("Password")) {
        return { ok: false, code: "weak_password", message: error.message };
      }
      await logProviderFailure("auth.sign_up", error);
      return { ok: false, code: "unexpected_error", ...(await supportReference()) };
    }

    // If Supabase issued a session immediately (email confirmation disabled),
    // set the session cookies so the user is logged in right away.
    if (authData.session) {
      await clearRecoveryCookies();
      await writeSessionCookies(authData.session.access_token, authData.session.refresh_token);
    }

    const emailVerificationRequired = !authData.session;
    return { ok: true, emailVerificationRequired };
  });

// ── signOutFn ─────────────────────────────────────────────────────────────────
//
// Order matters: (1) identify the user, (2) revoke the Supabase session,
// (3) clear the hardened cookies, (4) write the best-effort audit row last,
// bounded by a timeout. Revocation and cookie-clearing must never wait on —
// or be skipped because of — the audit step. A user with no active
// organization membership yet (e.g. mid-onboarding) simply gets no audit
// row — audit_logs.organization_id is NOT NULL, so there is nothing
// tenant-scoped to attach it to, and sign-out must still succeed.
//
// The bounded timeout matters because this runs in a Cloudflare Worker: a
// truly detached ("fire and forget") promise can be killed once the
// response is sent, silently dropping the audit write. Awaiting it here
// (capped, so it can never hang the caller) keeps it inside the handler's
// own lifetime instead.

const AUDIT_TIMEOUT_MS = 2000;

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function auditSignOutBestEffort(userId: string): Promise<void> {
  try {
    const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
    const organizationId = await resolveActiveOrganizationId(userId);
    if (!organizationId) return;

    const { AuthorizationService } = await import("@/server/auth/authorization");
    const authCtx = await AuthorizationService.forRequest(userId, organizationId);

    const { auditLog } = await import("@/server/auth/audit");
    await auditLog(authCtx, { action: "auth.sign_out", resourceType: "session" });
  } catch (err) {
    // Best-effort only — never block sign-out on audit failure. Structured and
    // redacted: never the raw error or its cause chain.
    const { reportServerError } = await import("@/server/observability/errors");
    reportServerError(err, { event: "auth.sign_out.audit_failed" });
  }
}

export const signOutFn = createServerFn().handler(async (): Promise<void> => {
  const { getCookie } = await import("@tanstack/react-start/server");
  const accessToken = getCookie(COOKIE_ACCESS_TOKEN);

  let userId: string | null = null;

  if (accessToken) {
    try {
      // Dynamic import — keeps @/lib/supabase/server out of the client bundle.
      const { createServerClient } = await import("@/lib/supabase/server");
      const client = createServerClient(accessToken);

      // 1. Identify the user for the audit step below. Isolated in its own
      //    try/catch so a getUser() failure can never skip step 2 (revocation).
      try {
        const {
          data: { user },
        } = await client.auth.getUser();
        userId = user?.id ?? null;
      } catch {
        // Ignore — audit below is best-effort and simply skips without a userId.
      }

      // 2. Revoke the server-side Supabase session promptly.
      await client.auth.signOut();
    } catch {
      // Ignore — cookies are cleared below regardless.
    }
  }

  // 3. Clear the hardened session cookies — and any pending password
  //    recovery. Always runs, regardless of the outcome of steps above.
  await clearSessionCookies();
  await clearRecoveryCookies();

  // 4. Best-effort sign-out audit, bounded so it can never delay the caller
  //    past AUDIT_TIMEOUT_MS.
  if (userId) {
    await withTimeout(auditSignOutBestEffort(userId), AUDIT_TIMEOUT_MS);
  }
});

// ── getAccountProfileFn ──────────────────────────────────────────────────────
//
// Read-only, self-scoped (profiles RLS: a user may only ever read their own
// row — see 001_auth_profiles.sql). No organization/membership involved, so
// this is safe for every signed-in user regardless of role.

export interface AccountProfile {
  email: string;
  displayName: string | null;
}

export const getAccountProfileFn = createServerFn().handler(
  async (): Promise<AccountProfile | null> => {
    const session = await getSessionFn();
    if (!session) return null;

    const { supabaseAdmin } = await import("@/lib/supabase/server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("profiles")
      .select("display_name")
      .eq("id", session.userId)
      .single();

    if (error || !data) return { email: session.email, displayName: null };

    const row = data as { display_name: string | null };
    return { email: session.email, displayName: row.display_name };
  },
);

// ── verifyEmailFn ─────────────────────────────────────────────────────────────
//
// Called after the user clicks the email verification link.
// Exchanges the OTP token for a session and sets cookies.
//
// Only email-verification token types are accepted. A recovery token must
// never become a normal APSA session: it is handled exclusively by
// beginPasswordRecoveryFn, which keeps it in the separate recovery cookies.
// Any other type is refused before Supabase is called.

export const VERIFY_EMAIL_OTP_TYPES = ["signup", "invite"] as const;
type VerifyEmailOtpType = (typeof VERIFY_EMAIL_OTP_TYPES)[number];

function isVerifyEmailOtpType(type: string): type is VerifyEmailOtpType {
  return (VERIFY_EMAIL_OTP_TYPES as readonly string[]).includes(type);
}

const VerifyEmailInput = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  type: z.string().default("signup"),
});

export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

export interface VerifyEmailResult {
  ok: true;
}
export type VerifyEmailError =
  | { ok: false; code: "invalid_token" }
  | { ok: false; code: "rate_limited" }
  | { ok: false; code: "unexpected_error"; reference?: string };

export const verifyEmailFn = createServerFn()
  .validator((data: unknown) => VerifyEmailInput.parse(data))
  .handler(async ({ data }): Promise<VerifyEmailResult | VerifyEmailError> => {
    if (!isVerifyEmailOtpType(data.type)) return { ok: false, code: "invalid_token" };
    const type = data.type;

    // A 6-digit code is guessable: bounded per address and per client IP.
    const { allowOtpVerification } = await import("@/server/rate-limit/auth-limits");
    if (!(await allowOtpVerification(data.email))) return { ok: false, code: "rate_limited" };

    const url = process.env["VITE_SUPABASE_URL"]!;
    const anonKey = process.env["VITE_SUPABASE_ANON_KEY"]!;

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error } = await client.auth.verifyOtp({
      email: data.email,
      token: data.token,
      type,
    });

    if (error || !authData.session) {
      if (error?.status === 400 || error?.message?.includes("expired")) {
        return { ok: false, code: "invalid_token" };
      }
      await logProviderFailure("auth.verify_email", error ?? { name: "AuthUnknownError" });
      return { ok: false, code: "unexpected_error", ...(await supportReference()) };
    }

    await clearRecoveryCookies();
    await writeSessionCookies(authData.session.access_token, authData.session.refresh_token);

    return { ok: true };
  });

// ── Account recovery ─────────────────────────────────────────────────────────
//
// Recovery session architecture:
//   - A valid recovery link is exchanged server-side (verifyOtp, type
//     "recovery"). The resulting Supabase session is written to two SEPARATE
//     HttpOnly cookies (sb-recovery-*) that getSessionFn and the /app guard
//     never read — opening a reset link does not sign anyone into APSA.
//   - The recovery cookies live for RECOVERY_WINDOW_SECONDS at most and are
//     only accepted by completePasswordRecoveryFn.
//   - Any APSA session already in the browser is cleared when the recovery
//     begins, so two principals never share one browser session.
//   - Any earlier recovery is cleared BEFORE a new link is processed, and on
//     every identity transition (sign-in, sign-out, session-issuing
//     verification), so a failed or later attempt can never fall back to an
//     older account's recovery.
//   - After the password is changed, every session for that user is revoked
//     (scope "global") and all auth cookies are cleared; the member signs in
//     again with the new password. If global revocation cannot be confirmed
//     the result says so — it never claims "signed out everywhere".
//   - Public email-addressed requests (reset, resend) are anti-enumerating:
//     see src/lib/auth-recovery.ts. The server enforces the email cooldown
//     and hourly/IP limits in the shared PostgreSQL limiter
//     (src/server/rate-limit/auth-limits.ts); Supabase remains the hard limit.
//   - Tokens and email addresses are never logged or returned to the client.

function createAnonAuthClient() {
  const url = process.env["VITE_SUPABASE_URL"]!;
  const anonKey = process.env["VITE_SUPABASE_ANON_KEY"]!;
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Where an auth email link should land. Built only from the configured
 * canonical URL — never from the request Host header, which an attacker can
 * set to point a genuine reset email at their own domain. When unset,
 * Supabase falls back to the project's Site URL. A set-but-invalid value
 * (not a bare https origin) yields `ok: false`: the caller must not send.
 */
function appRedirectUrl(
  pathname: string,
): { ok: true; redirectTo: string | undefined } | { ok: false } {
  const base = resolveAppBaseUrl(
    process.env["VITE_APP_URL"],
    process.env["NODE_ENV"] === "production",
  );
  if (!base.ok) {
    // The reason only — the configured value is not echoed.
    void import("@/server/observability/logger").then(({ serverLog }) =>
      serverLog.error("auth.app_url_invalid", { reason: base.reason }),
    );
    return { ok: false };
  }
  return { ok: true, redirectTo: base.origin ? `${base.origin}${pathname}` : undefined };
}

async function logProviderFailure(operation: string, error: ProviderAuthError): Promise<void> {
  // Status and code only — never the message (it can echo the email) or tokens.
  const { serverLog } = await import("@/server/observability/logger");
  serverLog.error(`${operation}.provider_failed`, {
    errorClass: error.name ?? "AuthError",
    ...(typeof error.status === "number" ? { statusCode: error.status } : {}),
    ...(error.code ? { errorCode: error.code } : {}),
    retryable: isTransportFailure(error),
  });
}

/** The current request's support ID, for an `unexpected_error` result. */
async function supportReference(): Promise<{ reference?: string }> {
  const { currentRequestId } = await import("@/server/observability/request-context");
  const reference = currentRequestId();
  return reference ? { reference } : {};
}

async function readRecoveryCookies(): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  const { getCookie } = await import("@tanstack/react-start/server");
  const accessToken = getCookie(COOKIE_RECOVERY_ACCESS_TOKEN);
  const refreshToken = getCookie(COOKIE_RECOVERY_REFRESH_TOKEN);
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

// ── requestPasswordResetFn ───────────────────────────────────────────────────

const RequestPasswordResetInput = z.object({
  email: z.string().trim().email(),
});

export type RequestPasswordResetResult = { ok: true } | { ok: false; code: "service_unavailable" };

export const requestPasswordResetFn = createServerFn()
  .validator((data: unknown) => RequestPasswordResetInput.parse(data))
  .handler(async ({ data }): Promise<RequestPasswordResetResult> => {
    // Account-independent configuration failure: reported before any send.
    const redirect = appRedirectUrl("/reset-password");
    if (!redirect.ok) return { ok: false, code: "service_unavailable" };

    // Inside a limit: nothing is sent, and the answer is the neutral one.
    const { claimAuthEmailSlot } = await import("@/server/rate-limit/auth-limits");
    if (!(await claimAuthEmailSlot("password_reset", data.email))) return { ok: true };

    let providerError: ProviderAuthError | null;
    try {
      const { error } = await createAnonAuthClient().auth.resetPasswordForEmail(
        data.email,
        redirect.redirectTo ? { redirectTo: redirect.redirectTo } : {},
      );
      providerError = error;
    } catch {
      providerError = { name: "AuthUnknownError" };
    }

    if (providerError) await logProviderFailure("auth.password_reset_request", providerError);

    // Unknown account, rate limit, SMTP failure, retryable 5xx, thrown
    // transport error — all answered identically. See src/lib/auth-recovery.ts.
    return { ok: true };
  });

// ── beginPasswordRecoveryFn ──────────────────────────────────────────────────
//
// Accepts either link shape Supabase email templates can produce:
//   token_hash (recommended: {{ .TokenHash }}) or token + email
//   ({{ .Token }} / {{ .Email }} — the shape /verify-email already uses).

const BeginPasswordRecoveryInput = z.union([
  z.object({ tokenHash: z.string().min(1) }),
  z.object({ token: z.string().min(1), email: z.string().email() }),
]);

export type BeginPasswordRecoveryResult =
  { ok: true } | { ok: false; code: "invalid_link" | "service_unavailable" | "rate_limited" };

export const beginPasswordRecoveryFn = createServerFn()
  .validator((data: unknown) => BeginPasswordRecoveryInput.parse(data))
  .handler(async ({ data }): Promise<BeginPasswordRecoveryResult> => {
    // A new link attempt replaces any earlier recovery BEFORE the token is
    // checked: if this link fails, no older recovery may remain usable.
    await clearRecoveryCookies();

    // Bounded per address (token + email links carry a guessable code), per
    // link token (token_hash links), and per client IP when a trusted header
    // is configured — after the old recovery is already gone.
    const { allowOtpVerification } = await import("@/server/rate-limit/auth-limits");
    if (
      !(await allowOtpVerification(
        "email" in data ? data.email : null,
        undefined,
        undefined,
        "tokenHash" in data ? data.tokenHash : null,
      ))
    ) {
      return { ok: false, code: "rate_limited" };
    }

    const client = createAnonAuthClient();
    let result: Awaited<ReturnType<typeof client.auth.verifyOtp>>;
    try {
      result = await client.auth.verifyOtp(
        "tokenHash" in data
          ? { token_hash: data.tokenHash, type: "recovery" }
          : { email: data.email, token: data.token, type: "recovery" },
      );
    } catch {
      return { ok: false, code: "service_unavailable" };
    }

    const { data: authData, error } = result;
    if (error || !authData.session) {
      if (error && isTransportFailure(error)) {
        await logProviderFailure("auth.password_recovery_verify", error);
        return { ok: false, code: "service_unavailable" };
      }
      return { ok: false, code: "invalid_link" };
    }

    // One principal per browser: a recovery for this account must not sit
    // next to another account's live APSA session.
    await clearSessionCookies();
    await writeRecoveryCookies(authData.session.access_token, authData.session.refresh_token);
    return { ok: true };
  });

// ── getPasswordRecoveryStatusFn ──────────────────────────────────────────────
//
// Lets /reset-password survive a reload without the (single-use) link token.

export const getPasswordRecoveryStatusFn = createServerFn().handler(
  async (): Promise<{ active: boolean }> => {
    const recovery = await readRecoveryCookies();
    if (!recovery) return { active: false };

    try {
      const { data, error } = await createAnonAuthClient().auth.getUser(recovery.accessToken);
      if (!error && data.user) return { active: true };
    } catch {
      // Could not be validated — fall through: an unverifiable recovery is
      // not kept around.
    }

    await clearRecoveryCookies();
    return { active: false };
  },
);

// ── completePasswordRecoveryFn ───────────────────────────────────────────────

const CompletePasswordRecoveryInput = z
  .object({
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * `otherSessionsRevoked: false` means the password WAS changed but Supabase
 * did not confirm the global sign-out — other devices may still be signed
 * in. The screen must not claim "signed out everywhere" in that case.
 */
export type CompletePasswordRecoveryResult =
  { ok: true; otherSessionsRevoked: boolean } | { ok: false; code: PasswordUpdateIssue };

export const completePasswordRecoveryFn = createServerFn()
  .validator((data: unknown) => CompletePasswordRecoveryInput.parse(data))
  .handler(async ({ data }): Promise<CompletePasswordRecoveryResult> => {
    const recovery = await readRecoveryCookies();
    if (!recovery) return { ok: false, code: "recovery_expired" };

    const { allowRecoveryCompletion } = await import("@/server/rate-limit/auth-limits");
    if (!(await allowRecoveryCompletion(recovery.refreshToken))) {
      return { ok: false, code: "unexpected_error" };
    }

    const client = createAnonAuthClient();
    try {
      const { error: sessionError } = await client.auth.setSession({
        access_token: recovery.accessToken,
        refresh_token: recovery.refreshToken,
      });
      if (sessionError) {
        const issue = classifyPasswordUpdate(sessionError);
        if (issue === "recovery_expired") await clearRecoveryCookies();
        else await logProviderFailure("auth.password_recovery_session", sessionError);
        return { ok: false, code: issue === "recovery_expired" ? issue : "unexpected_error" };
      }

      const { error: updateError } = await client.auth.updateUser({ password: data.password });
      if (updateError) {
        const issue = classifyPasswordUpdate(updateError);
        if (issue === "recovery_expired") await clearRecoveryCookies();
        if (issue === "unexpected_error") {
          await logProviderFailure("auth.password_update", updateError);
        }
        return { ok: false, code: issue };
      }
    } catch {
      return { ok: false, code: "unexpected_error" };
    }

    // The password is changed. Revoke every session for this user — including
    // the recovery session and any other device — then clear every auth cookie
    // in this browser whatever the outcome. A returned OR thrown revocation
    // failure is reported truthfully, never as "signed out everywhere".
    let otherSessionsRevoked: boolean;
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: "global" });
      otherSessionsRevoked = !signOutError;
      if (signOutError) {
        await logProviderFailure("auth.password_recovery_global_sign_out", signOutError);
      }
    } catch {
      otherSessionsRevoked = false;
      await logProviderFailure("auth.password_recovery_global_sign_out", {
        name: "AuthUnknownError",
      });
    }
    await clearRecoveryCookies();
    await clearSessionCookies();
    return { ok: true, otherSessionsRevoked };
  });

// ── Verification resend ──────────────────────────────────────────────────────

/**
 * The email of the signed-in, not-yet-verified member, if any — so
 * /verify-email can offer a one-tap resend. Returns nothing for anyone else.
 */
export const getPendingVerificationFn = createServerFn().handler(
  async (): Promise<{ email: string } | null> => {
    const session = await getSessionFn();
    if (!session || session.emailVerified || !session.email) return null;
    return { email: session.email };
  },
);

const ResendVerificationInput = z.object({
  email: z.string().trim().email().optional(),
});

export type ResendVerificationResult =
  | { ok: true }
  | {
      ok: false;
      code: "rate_limited" | "service_unavailable" | "already_verified" | "email_required";
    };

export const resendVerificationFn = createServerFn()
  .validator((data: unknown) => ResendVerificationInput.parse(data))
  .handler(async ({ data }): Promise<ResendVerificationResult> => {
    // A signed-in member can only resend to their own address — the typed
    // email is ignored whenever a session exists.
    const session = await getSessionFn();
    if (session?.emailVerified) return { ok: false, code: "already_verified" };

    const ownAddress = Boolean(session?.email);
    const email = session?.email || data.email;
    if (!email) return { ok: false, code: "email_required" };

    // Account-independent configuration failure: reported before any send.
    const redirect = appRedirectUrl("/verify-email");
    if (!redirect.ok) return { ok: false, code: "service_unavailable" };

    const { claimAuthEmailSlot } = await import("@/server/rate-limit/auth-limits");
    if (!(await claimAuthEmailSlot("verification_resend", email))) {
      // Own address: an honest "wait". Public: the neutral answer.
      return ownAddress ? { ok: false, code: "rate_limited" } : { ok: true };
    }

    let providerError: ProviderAuthError | null;
    try {
      const { error } = await createAnonAuthClient().auth.resend({
        type: "signup",
        email,
        options: redirect.redirectTo ? { emailRedirectTo: redirect.redirectTo } : {},
      });
      providerError = error;
    } catch {
      providerError = { name: "AuthUnknownError" };
    }

    if (providerError) await logProviderFailure("auth.verification_resend", providerError);

    // Public, email-addressed request: every provider answer is neutral, so
    // nothing reveals whether the address has an account.
    if (!ownAddress) return { ok: true };

    const outcome = classifyOwnVerificationResend(providerError);
    return outcome === "sent" ? { ok: true } : { ok: false, code: outcome };
  });
