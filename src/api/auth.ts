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
  emailVerified: boolean;
  accessToken: string;
}

export type AuthRedirect = "/app" | "/onboarding" | "/verify-email" | "/access-denied";

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

type MembershipRow = {
  organization_id: string;
  status: string;
  created_at: string;
};

export type AuthenticatedRouteResult =
  | { ok: true; organizationId: string }
  | { ok: false; redirect: Exclude<AuthRedirect, "/app"> };

async function getMembershipRows(userId: string): Promise<{
  data: MembershipRow[] | null;
  error: { message?: string } | null;
}> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");

  const { data, error } = await supabaseAdmin
    .from("memberships")
    .select("organization_id, status, created_at")
    .eq("user_id", userId)
    .in("status", ["active", "suspended", "removed"])
    .order("created_at", { ascending: true });

  return {
    data: (data ?? null) as MembershipRow[] | null,
    error: error ? { message: error.message } : null,
  };
}

export async function resolveAuthenticatedRoute(
  session: ServerSession,
): Promise<AuthenticatedRouteResult> {
  if (!session.emailVerified) {
    return { ok: false, redirect: "/verify-email" };
  }

  const { data, error } = await getMembershipRows(session.userId);
  if (error) {
    await clearSessionCookies();
    throw new Error(error.message ?? "Unable to resolve organization membership");
  }

  const memberships = data ?? [];
  const activeMembership = memberships.find((membership) => membership.status === "active");

  if (activeMembership) {
    return { ok: true, organizationId: activeMembership.organization_id };
  }

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

export const getSessionFn = createServerFn().handler(
  async (): Promise<ServerSession | null> => {
    const { getCookie } = await import("@tanstack/react-start/server");
    const accessToken = getCookie(COOKIE_ACCESS_TOKEN);
    const refreshToken = getCookie(COOKIE_REFRESH_TOKEN);

    if (!accessToken || !refreshToken) return null;

    // Dynamic import — keeps @/lib/supabase/server out of the client bundle.
    const { createServerClient, createRefreshClient } = await import(
      "@/lib/supabase/server"
    );

    // Validate the access token via Supabase Auth API.
    const client = createServerClient(accessToken);
    const { data: { user }, error } = await client.auth.getUser();

    if (!error && user) {
      return {
        userId: user.id,
        email: user.email ?? "",
        emailVerified: Boolean(user.email_confirmed_at),
        accessToken,
      };
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

    return {
      userId: session.user.id,
      email: session.user.email ?? "",
      emailVerified: Boolean(session.user.email_confirmed_at),
      accessToken: session.access_token,
    };
  },
);

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

    const authenticatedSession: ServerSession = {
      userId: authData.session.user.id,
      email: authData.session.user.email ?? "",
      emailVerified: Boolean(authData.session.user.email_confirmed_at),
      accessToken: authData.session.access_token,
    };

    try {
      const routeResult = await resolveAuthenticatedRoute(authenticatedSession);

      // Revoked access clears any existing response cookies in the resolver.
      if (!routeResult.ok && routeResult.redirect === "/access-denied") {
        return { ok: true, redirectTo: routeResult.redirect };
      }

      // These cookies are for subsequent requests. This handler must not call
      // getSessionFn here because it reads only incoming request cookies.
      await writeSessionCookies(
        authData.session.access_token,
        authData.session.refresh_token,
      );

      return {
        ok: true,
        redirectTo: routeResult.ok ? "/app" : routeResult.redirect,
      };
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
      await writeSessionCookies(
        authData.session.access_token,
        authData.session.refresh_token,
      );
    }

    const emailVerificationRequired = !authData.session;
    return { ok: true, emailVerificationRequired };
  });

// ── signOutFn ─────────────────────────────────────────────────────────────────

export const signOutFn = createServerFn().handler(async (): Promise<void> => {
  const { getCookie } = await import("@tanstack/react-start/server");
  const accessToken = getCookie(COOKIE_ACCESS_TOKEN);

  // Revoke the server-side Supabase session (best effort — clears cookies regardless).
  if (accessToken) {
    try {
      // Dynamic import — keeps @/lib/supabase/server out of the client bundle.
      const { createServerClient } = await import("@/lib/supabase/server");
      const client = createServerClient(accessToken);
      await client.auth.signOut();
    } catch {
      // Ignore — cookies are cleared below regardless.
    }
  }

  await clearSessionCookies();
});

export const clearAuthCookieFn = createServerFn().handler(async (): Promise<void> => {
  await clearSessionCookies();
});

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

export interface VerifyEmailResult { ok: true }
export type VerifyEmailError =
  | { ok: false; code: "invalid_token" }
  | { ok: false; code: "unexpected_error"; message: string };

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

    await writeSessionCookies(
      authData.session.access_token,
      authData.session.refresh_token,
    );

    return { ok: true };
  });
