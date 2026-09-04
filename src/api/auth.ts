/**
 * Auth server functions — the real server request boundary.
 *
 * These createServerFn wrappers are safe to import from route components.
 * TanStack Start replaces the handler body with an RPC stub in the client bundle,
 * so server-only imports inside handlers never reach the browser.
 *
 * Cookie layout:
 *   apsa-auth — HttpOnly, Secure, SameSite=Lax — Supabase access token
 *               Max-Age = 7 days (Supabase default refresh window)
 */

import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";

// ── Cookie name ────────────────────────────────────────────────────────────────

export const AUTH_COOKIE = "apsa-auth";

// ── Session result type ────────────────────────────────────────────────────────

export type SessionResult =
  | {
      status: "ok";
      userId: string;
      email: string;
      emailVerified: boolean;
      organizationId: string;
      membershipStatus: "active";
    }
  | { status: "unauthenticated" }
  | { status: "unverified"; userId: string; email: string }
  | { status: "no_org"; userId: string; email: string; emailVerified: boolean }
  | { status: "revoked"; reason: "suspended" | "removed" };

// ── getSessionFn ───────────────────────────────────────────────────────────────

/**
 * Reads the HttpOnly auth cookie, validates the Supabase JWT, resolves the
 * user's active organization membership, and returns a typed session result.
 *
 * Runs server-side on every call — both during SSR and during client SPA navigation.
 * The cookie is sent automatically by the browser on every request.
 *
 * Security guarantees:
 *   - Token validation uses supabase.auth.getUser() which calls the Supabase Auth server
 *   - No client-provided userId is ever trusted
 *   - Organization is resolved from validated membership, not from client input
 *   - Suspended/removed memberships are caught and returned as 'revoked'
 */
export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionResult> => {
    const token = getCookie(AUTH_COOKIE);
    if (!token) return { status: "unauthenticated" };

    // Dynamic import ensures server-only code never enters client bundle
    const { createServerClient } = await import("@/lib/supabase/server");
    const { supabaseAdmin } = await import("@/lib/supabase/server");

    // Validate token against Supabase Auth — this is the authoritative check
    const client = createServerClient(token);
    const {
      data: { user },
      error,
    } = await client.auth.getUser();

    if (error || !user) return { status: "unauthenticated" };

    const email = user.email ?? "";
    const emailVerified = Boolean(user.email_confirmed_at);

    // Enforce email verification — unverified users may not access business flows
    if (!emailVerified) {
      return { status: "unverified", userId: user.id, email };
    }

    // Resolve current organization: pick the oldest active membership deterministically.
    // This satisfies Blocker 7 (multi-org selection) — active wins over removed/suspended,
    // and joined_at ASC gives a deterministic result. Future org-switching can layer on top.
    type MRow = { organization_id: string; status: string; joined_at: string };
    const { data: rawMemberships, error: membershipError } = await supabaseAdmin
      .from("memberships")
      .select("organization_id, status, joined_at")
      .eq("user_id", user.id)
      .order("joined_at", { ascending: true });

    if (membershipError) return { status: "unauthenticated" };

    const rows = (rawMemberships ?? []) as MRow[];

    // Find the first ACTIVE membership
    const active = rows.find((m) => m.status === "active");

    if (!active) {
      // Check for revoked state: has a non-active membership but no active one
      const revoked = rows.find(
        (m) => m.status === "suspended" || m.status === "removed",
      );
      if (revoked) {
        return {
          status: "revoked",
          reason: revoked.status as "suspended" | "removed",
        };
      }

      // No membership at all → must complete onboarding
      return { status: "no_org", userId: user.id, email, emailVerified };
    }

    return {
      status: "ok",
      userId: user.id,
      email,
      emailVerified,
      organizationId: active.organization_id,
      membershipStatus: "active",
    };
  },
);

// ── setAuthCookieFn ────────────────────────────────────────────────────────────

/**
 * Called by the client immediately after a successful Supabase Auth sign-in
 * to persist the access token in an HttpOnly cookie.
 *
 * The client MUST NOT store the token in a place the server-side guard reads;
 * this cookie is the ONLY authority for SSR route protection.
 */
export const setAuthCookieFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (
      !data ||
      typeof data !== "object" ||
      !("accessToken" in data) ||
      typeof (data as { accessToken: unknown }).accessToken !== "string" ||
      !(data as { accessToken: string }).accessToken.length
    ) {
      throw new Error("Invalid accessToken");
    }
    return data as { accessToken: string };
  })
  .handler(async ({ data }) => {
    setCookie(AUTH_COOKIE, data.accessToken, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 3600, // 7 days — Supabase refresh window
    });
    return { ok: true };
  });

// ── clearAuthCookieFn ─────────────────────────────────────────────────────────

/**
 * Clear the auth cookie — called on sign-out or when a revoked session is detected.
 */
export const clearAuthCookieFn = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(AUTH_COOKIE, { path: "/" });
  return { ok: true };
});
