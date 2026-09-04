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
 *
 * NEVER import supabaseAdmin or SUPABASE_SERVICE_ROLE_KEY from browser-bundled code.
 * The createServerFn mechanism (TanStack Start) handles server/client code splitting.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  getCookie,
  setCookie,
  deleteCookie,
} from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import {
  COOKIE_ACCESS_TOKEN,
  COOKIE_REFRESH_TOKEN,
  COOKIE_OPTIONS,
  createServerClient,
  createRefreshClient,
} from "@/lib/supabase/server";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerSession {
  userId: string;
  email: string;
  emailVerified: boolean;
  accessToken: string;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function writeSessionCookies(accessToken: string, refreshToken: string): void {
  setCookie(COOKIE_ACCESS_TOKEN, accessToken, COOKIE_OPTIONS);
  setCookie(COOKIE_REFRESH_TOKEN, refreshToken, COOKIE_OPTIONS);
}

function clearSessionCookies(): void {
  deleteCookie(COOKIE_ACCESS_TOKEN, { path: "/" });
  deleteCookie(COOKIE_REFRESH_TOKEN, { path: "/" });
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
    const accessToken = getCookie(COOKIE_ACCESS_TOKEN);
    const refreshToken = getCookie(COOKIE_REFRESH_TOKEN);

    if (!accessToken || !refreshToken) return null;

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
      clearSessionCookies();
      return null;
    }

    const { session } = refreshData;
    // Write refreshed tokens back to cookies.
    writeSessionCookies(session.access_token, session.refresh_token);

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
  emailVerified: boolean;
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

    writeSessionCookies(
      authData.session.access_token,
      authData.session.refresh_token,
    );

    return {
      ok: true,
      emailVerified: Boolean(authData.user?.email_confirmed_at),
    };
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

    // If Supabase issued a session immediately (e.g. email confirmation disabled),
    // set the session cookies so the user is logged in right away.
    if (authData.session) {
      writeSessionCookies(
        authData.session.access_token,
        authData.session.refresh_token,
      );
    }

    const emailVerificationRequired = !authData.session;
    return { ok: true, emailVerificationRequired };
  });

// ── signOutFn ─────────────────────────────────────────────────────────────────

export const signOutFn = createServerFn().handler(async (): Promise<void> => {
  const accessToken = getCookie(COOKIE_ACCESS_TOKEN);

  // Revoke the server-side Supabase session (best effort — clears cookies regardless).
  if (accessToken) {
    try {
      const client = createServerClient(accessToken);
      await client.auth.signOut();
    } catch {
      // Ignore — cookies are cleared below regardless.
    }
  }

  clearSessionCookies();
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

    writeSessionCookies(
      authData.session.access_token,
      authData.session.refresh_token,
    );

    return { ok: true };
  });
