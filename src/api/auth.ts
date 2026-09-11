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

// ── Cookie constants — defined inline to avoid importing @/lib/supabase/server ─
// Keeping these here means auth.ts carries no static dependency on the admin module.
export const COOKIE_ACCESS_TOKEN = "sb-access-token";
export const COOKIE_REFRESH_TOKEN = "sb-refresh-token";

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
    .order("joined_at", { ascending: true });

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
  const activeMembership = memberships.find((membership) => membership.status === "active");
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

export type SignInError =
  | { ok: false; code: "invalid_credentials" }
  | { ok: false; code: "unexpected_error"; message: string };

export const signInFn = createServerFn()
  .validator((data: unknown) => SignInInput.parse(data))
  .handler(async ({ data }): Promise<SignInResult | SignInError> => {
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
      return { ok: false, code: "unexpected_error", message: error?.message ?? "Unknown error" };
    }

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
      return {
        ok: false,
        code: "unexpected_error",
        message:
          error instanceof Error
            ? error.message
            : "Sign-in succeeded but APSA could not load your access state.",
      };
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

export type SignUpError =
  | { ok: false; code: "email_taken" }
  | { ok: false; code: "weak_password"; message: string }
  | { ok: false; code: "unexpected_error"; message: string };

export const signUpFn = createServerFn()
  .validator((data: unknown) => SignUpInput.parse(data))
  .handler(async ({ data }): Promise<SignUpResult | SignUpError> => {
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
      return { ok: false, code: "unexpected_error", message: error.message };
    }

    // If Supabase issued a session immediately (email confirmation disabled),
    // set the session cookies so the user is logged in right away.
    if (authData.session) {
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
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rawMembership } = await (supabaseAdmin as any)
      .from("memberships")
      .select("organization_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("joined_at", { ascending: false })
      .limit(1)
      .single();

    if (!rawMembership) return;
    const membership = rawMembership as { organization_id: string };

    const { AuthorizationService } = await import("@/server/auth/authorization");
    const authCtx = await AuthorizationService.forRequest(userId, membership.organization_id);

    const { auditLog } = await import("@/server/auth/audit");
    await auditLog(authCtx, { action: "auth.sign_out", resourceType: "session" });
  } catch (err) {
    // Best-effort only — never block sign-out on audit failure.
    console.error("[APSA] auth.sign_out audit log failed (best-effort):", err);
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

  // 3. Clear the hardened session cookies. Always runs, regardless of the
  //    outcome of steps above.
  await clearSessionCookies();

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

const VerifyEmailInput = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  type: z.enum(["signup", "recovery", "invite"]).default("signup"),
});

export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

export interface VerifyEmailResult {
  ok: true;
}
export type VerifyEmailError =
  { ok: false; code: "invalid_token" } | { ok: false; code: "unexpected_error"; message: string };

export const verifyEmailFn = createServerFn()
  .validator((data: unknown) => VerifyEmailInput.parse(data))
  .handler(async ({ data }): Promise<VerifyEmailResult | VerifyEmailError> => {
    const url = process.env["VITE_SUPABASE_URL"]!;
    const anonKey = process.env["VITE_SUPABASE_ANON_KEY"]!;

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error } = await client.auth.verifyOtp({
      email: data.email,
      token: data.token,
      type: data.type,
    });

    if (error || !authData.session) {
      if (error?.status === 400 || error?.message?.includes("expired")) {
        return { ok: false, code: "invalid_token" };
      }
      return { ok: false, code: "unexpected_error", message: error?.message ?? "Unknown error" };
    }

    await writeSessionCookies(authData.session.access_token, authData.session.refresh_token);

    return { ok: true };
  });
