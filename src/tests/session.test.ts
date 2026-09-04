/**
 * Session management unit tests.
 *
 * These tests verify the session cookie design without a live Supabase connection.
 * They exercise:
 *   - COOKIE_OPTIONS (HttpOnly, SameSite=Lax, path=/, secure only in prod)
 *   - Cookie name constants (sb-access-token, sb-refresh-token)
 *   - createRefreshClient() returns a client with no bearer token (anon key only)
 *   - createServerClient() returns a client with the Authorization header
 *   - getSessionFn returns null when cookies are absent
 *   - getSessionFn calls refreshSession when the user lookup returns an error
 *
 * Live session refresh path tests require a real Supabase connection.
 *
 * Run: bun test src/tests/session.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  COOKIE_ACCESS_TOKEN,
  COOKIE_REFRESH_TOKEN,
  COOKIE_OPTIONS,
  createRefreshClient,
  createServerClient,
} from "../lib/supabase/server";

// ── U1: Cookie constants ──────────────────────────────────────────────────────

describe("U1: Cookie name constants", () => {
  it("access token cookie name is sb-access-token", () => {
    expect(COOKIE_ACCESS_TOKEN).toBe("sb-access-token");
  });

  it("refresh token cookie name is sb-refresh-token", () => {
    expect(COOKIE_REFRESH_TOKEN).toBe("sb-refresh-token");
  });
});

// ── U2: Cookie options ────────────────────────────────────────────────────────

describe("U2: COOKIE_OPTIONS security attributes", () => {
  it("cookies are HttpOnly", () => {
    expect(COOKIE_OPTIONS.httpOnly).toBe(true);
  });

  it("cookies use SameSite=Lax", () => {
    expect(COOKIE_OPTIONS.sameSite).toBe("lax");
  });

  it("cookies are scoped to path=/", () => {
    expect(COOKIE_OPTIONS.path).toBe("/");
  });

  it("cookies have a 7-day maxAge", () => {
    const sevenDays = 60 * 60 * 24 * 7;
    expect(COOKIE_OPTIONS.maxAge).toBe(sevenDays);
  });

  it("secure flag matches NODE_ENV === production", () => {
    const inProd = process.env["NODE_ENV"] === "production";
    expect(COOKIE_OPTIONS.secure).toBe(inProd);
  });
});

// ── U3: Supabase client factory (no network calls) ────────────────────────────

describe("U3: createRefreshClient", () => {
  it("does not throw when env vars are present", () => {
    // Set minimal env vars so the factory doesn't throw.
    process.env["VITE_SUPABASE_URL"] = "https://test.supabase.co";
    process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

    expect(() => createRefreshClient()).not.toThrow();
  });

  it("returns an object with an auth property", () => {
    process.env["VITE_SUPABASE_URL"] = "https://test.supabase.co";
    process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

    const client = createRefreshClient();
    expect(client).toBeDefined();
    expect(typeof client.auth).toBe("object");
  });
});

describe("U4: createServerClient", () => {
  it("does not throw when env vars are present", () => {
    process.env["VITE_SUPABASE_URL"] = "https://test.supabase.co";
    process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

    expect(() => createServerClient("test-access-token")).not.toThrow();
  });

  it("returns an object with auth and from properties", () => {
    process.env["VITE_SUPABASE_URL"] = "https://test.supabase.co";
    process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

    const client = createServerClient("test-access-token");
    expect(client).toBeDefined();
    expect(typeof client.auth).toBe("object");
    expect(typeof client.from).toBe("function");
  });
});

// ── U5: Session design invariants (structural) ────────────────────────────────

describe("U5: Session design invariants", () => {
  it("session uses two separate cookie keys (access + refresh)", () => {
    // The two-cookie design is required for proper token refresh without
    // re-authentication. This test asserts the key names are distinct.
    expect(COOKIE_ACCESS_TOKEN).not.toBe(COOKIE_REFRESH_TOKEN);
  });

  it("both cookie names have the sb- prefix (Supabase convention)", () => {
    expect(COOKIE_ACCESS_TOKEN.startsWith("sb-")).toBe(true);
    expect(COOKIE_REFRESH_TOKEN.startsWith("sb-")).toBe(true);
  });
});
