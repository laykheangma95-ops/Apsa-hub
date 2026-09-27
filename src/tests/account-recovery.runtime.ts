/**
 * Account recovery — behavioural runtime checks for the real server functions
 * in src/api/auth.ts, with Supabase and the cookie layer mocked at the module
 * boundary. Run in a child process by account-recovery.test.ts because
 * mock.module is process-global.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

function createServerFnMock() {
  return () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler<TArgs extends { data: unknown }, TResult>(
          handler: (args: { data: TArgs["data"] }) => TResult | Promise<TResult>,
        ) {
          return async ({ data }: TArgs) => handler({ data: validator(data) as TArgs["data"] });
        },
      };
    },
    handler<TResult>(handler: () => TResult | Promise<TResult>) {
      return handler;
    },
  });
}

type MockError = { name?: string; status?: number; code?: string; message?: string } | null;
type MockUser = { id: string; email: string; email_confirmed_at: string | null };
type CookieWrite = { name: string; value: string; options: Record<string, unknown> };

// ── Cookie layer: request cookies are read-only; writes go to the response ──
const requestCookies = new Map<string, string>();
const cookieWrites: CookieWrite[] = [];
const cookieDeletes: string[] = [];

// ── Supabase call log + scenario knobs ──────────────────────────────────────
type Call = { method: string; args: unknown[] };
const calls: Call[] = [];

let resetPasswordError: MockError;
let resetPasswordThrows: boolean;
let verifyOtpError: MockError;
let verifyOtpThrows: boolean;
let setSessionError: MockError;
let updateUserError: MockError;
let resendError: MockError;
let resendThrows: boolean;
let recoveryUserValid: boolean;
let sessionUser: MockUser | null;

const RECOVERY_ACCESS = "recovery-access-SECRET";
const RECOVERY_REFRESH = "recovery-refresh-SECRET";
const TEST_EMAIL = "merchant@example.com";

function resetScenario() {
  requestCookies.clear();
  cookieWrites.length = 0;
  cookieDeletes.length = 0;
  calls.length = 0;
  resetPasswordError = null;
  resetPasswordThrows = false;
  verifyOtpError = null;
  verifyOtpThrows = false;
  setSessionError = null;
  updateUserError = null;
  resendError = null;
  resendThrows = false;
  recoveryUserValid = true;
  sessionUser = null;
}

function record(method: string, ...args: unknown[]) {
  calls.push({ method, args });
}

function callsTo(method: string) {
  return calls.filter((call) => call.method === method);
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: createServerFnMock(),
}));

mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => requestCookies.get(name),
  setCookie: (name: string, value: string, options: Record<string, unknown>) => {
    cookieWrites.push({ name, value, options });
  },
  deleteCookie: (name: string) => {
    cookieDeletes.push(name);
  },
}));

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      resetPasswordForEmail: async (email: string, options: unknown) => {
        record("resetPasswordForEmail", email, options);
        if (resetPasswordThrows) throw new TypeError("fetch failed");
        return { data: {}, error: resetPasswordError };
      },
      verifyOtp: async (params: unknown) => {
        record("verifyOtp", params);
        if (verifyOtpThrows) throw new TypeError("fetch failed");
        if (verifyOtpError) return { data: { session: null, user: null }, error: verifyOtpError };
        return {
          data: {
            session: { access_token: RECOVERY_ACCESS, refresh_token: RECOVERY_REFRESH },
            user: { id: "user-1" },
          },
          error: null,
        };
      },
      getUser: async (jwt?: string) => {
        record("getUser", jwt);
        return recoveryUserValid && jwt === RECOVERY_ACCESS
          ? { data: { user: { id: "user-1" } }, error: null }
          : { data: { user: null }, error: { status: 401, code: "bad_jwt" } };
      },
      setSession: async (tokens: unknown) => {
        record("setSession", tokens);
        return { data: {}, error: setSessionError };
      },
      updateUser: async (attributes: unknown) => {
        record("updateUser", attributes);
        return { data: {}, error: updateUserError };
      },
      signOut: async (options?: unknown) => {
        record("signOut", options);
        return { error: null };
      },
      resend: async (params: unknown) => {
        record("resend", params);
        if (resendThrows) throw new TypeError("fetch failed");
        return { data: {}, error: resendError };
      },
    },
  }),
}));

// getSessionFn's validator — only the main APSA session cookies count.
mock.module("@/lib/supabase/server", () => ({
  createServerClient: (accessToken: string) => ({
    auth: {
      getUser: async () =>
        sessionUser && accessToken === "app-access"
          ? { data: { user: sessionUser }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
      signOut: async () => ({ error: null }),
    },
  }),
  createRefreshClient: () => ({
    auth: {
      refreshSession: async () => ({ data: { session: null }, error: { message: "no refresh" } }),
    },
  }),
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ limit: () => ({ single: async () => ({ data: null }) }) }),
          }),
          in: () => ({ order: async () => ({ data: [], error: null }) }),
        }),
      }),
    }),
  },
}));

// ── Log capture: nothing sensitive may reach the server logs ────────────────
const logged: string[] = [];
const originalConsole = { error: console.error, warn: console.warn, log: console.log };
for (const level of ["error", "warn", "log"] as const) {
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
}

process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";
process.env["VITE_APP_URL"] = "https://app.apsa.test/";

const auth = await import("@/api/auth");
const { checkAppGuardFn } = await import("@/api/app-guard");
const {
  COOKIE_ACCESS_TOKEN,
  COOKIE_REFRESH_TOKEN,
  COOKIE_RECOVERY_ACCESS_TOKEN,
  COOKIE_RECOVERY_REFRESH_TOKEN,
} = auth;

function withRecoveryCookies() {
  requestCookies.set(COOKIE_RECOVERY_ACCESS_TOKEN, RECOVERY_ACCESS);
  requestCookies.set(COOKIE_RECOVERY_REFRESH_TOKEN, RECOVERY_REFRESH);
}

function withAppSession(user: MockUser) {
  sessionUser = user;
  requestCookies.set(COOKIE_ACCESS_TOKEN, "app-access");
  requestCookies.set(COOKIE_REFRESH_TOKEN, "app-refresh");
}

beforeEach(resetScenario);

afterAll(() => {
  Object.assign(console, originalConsole);
});

// ── A. Forgot password ──────────────────────────────────────────────────────

describe("requestPasswordResetFn", () => {
  it("calls Supabase password recovery with the configured reset URL", async () => {
    const result = await auth.requestPasswordResetFn({ data: { email: ` ${TEST_EMAIL} ` } });

    expect(result).toEqual({ ok: true });
    expect(callsTo("resetPasswordForEmail")).toEqual([
      {
        method: "resetPasswordForEmail",
        args: [TEST_EMAIL, { redirectTo: "https://app.apsa.test/reset-password" }],
      },
    ]);
  });

  it("answers an existing and a non-existing email identically", async () => {
    const existing = await auth.requestPasswordResetFn({ data: { email: TEST_EMAIL } });

    resetPasswordError = { status: 400, code: "user_not_found", message: "User not found" };
    const missing = await auth.requestPasswordResetFn({ data: { email: "nobody@example.com" } });

    expect(missing).toEqual(existing);
  });

  it("never leaks account existence through provider errors", async () => {
    const providerErrors: MockError[] = [
      { status: 429, code: "over_email_send_rate_limit", message: "For security purposes…" },
      { status: 500, code: "unexpected_failure", message: "Error sending recovery email" },
      { status: 422, code: "email_address_invalid", message: "Email address is invalid" },
    ];
    for (const error of providerErrors) {
      resetPasswordError = error;
      const result = await auth.requestPasswordResetFn({ data: { email: TEST_EMAIL } });
      expect(result).toEqual({ ok: true });
      expect(JSON.stringify(result)).not.toContain(error?.message ?? "");
    }
  });

  it("reports only a transport failure, which is identical for every email", async () => {
    resetPasswordThrows = true;
    const result = await auth.requestPasswordResetFn({ data: { email: TEST_EMAIL } });
    expect(result).toEqual({ ok: false, code: "service_unavailable" });
  });

  it("rejects a malformed email before calling Supabase", async () => {
    await expect(
      auth.requestPasswordResetFn({ data: { email: "not-an-email" } }),
    ).rejects.toThrow();
    expect(callsTo("resetPasswordForEmail")).toHaveLength(0);
  });

  it("never touches session cookies", async () => {
    await auth.requestPasswordResetFn({ data: { email: TEST_EMAIL } });
    expect(cookieWrites).toHaveLength(0);
    expect(cookieDeletes).toHaveLength(0);
  });
});

// ── B. Recovery link + new password ─────────────────────────────────────────

describe("beginPasswordRecoveryFn", () => {
  it("exchanges a token_hash link server-side into HttpOnly recovery cookies only", async () => {
    const result = await auth.beginPasswordRecoveryFn({ data: { tokenHash: "hash-123" } });

    expect(result).toEqual({ ok: true });
    expect(callsTo("verifyOtp")[0]?.args[0]).toEqual({ token_hash: "hash-123", type: "recovery" });
    expect(cookieWrites.map((write) => write.name)).toEqual([
      COOKIE_RECOVERY_ACCESS_TOKEN,
      COOKIE_RECOVERY_REFRESH_TOKEN,
    ]);
    for (const write of cookieWrites) {
      expect(write.options["httpOnly"]).toBe(true);
      expect(write.options["sameSite"]).toBe("lax");
      expect(write.options["maxAge"]).toBe(15 * 60);
    }
    // The recovery session never becomes an APSA app session…
    expect(cookieWrites.some((write) => write.name === COOKIE_ACCESS_TOKEN)).toBe(false);
    // …and any other principal's session in this browser is cleared.
    expect(cookieDeletes).toEqual([COOKIE_ACCESS_TOKEN, COOKIE_REFRESH_TOKEN]);
    // The tokens are not handed back to the browser.
    expect(JSON.stringify(result)).not.toContain(RECOVERY_ACCESS);
  });

  it("accepts the token + email link shape", async () => {
    const result = await auth.beginPasswordRecoveryFn({
      data: { token: "123456", email: TEST_EMAIL },
    });
    expect(result).toEqual({ ok: true });
    expect(callsTo("verifyOtp")[0]?.args[0]).toEqual({
      email: TEST_EMAIL,
      token: "123456",
      type: "recovery",
    });
  });

  it("returns an honest invalid_link for an expired or reused link and sets no cookies", async () => {
    verifyOtpError = {
      status: 403,
      code: "otp_expired",
      message: "Token has expired or is invalid",
    };
    const result = await auth.beginPasswordRecoveryFn({ data: { tokenHash: "stale" } });

    expect(result).toEqual({ ok: false, code: "invalid_link" });
    expect(cookieWrites).toHaveLength(0);
    expect(cookieDeletes).toHaveLength(0);
  });

  it("distinguishes an outage from a bad link", async () => {
    verifyOtpThrows = true;
    const result = await auth.beginPasswordRecoveryFn({ data: { tokenHash: "hash" } });
    expect(result).toEqual({ ok: false, code: "service_unavailable" });
  });
});

describe("getPasswordRecoveryStatusFn", () => {
  it("is inactive without recovery cookies", async () => {
    expect(await auth.getPasswordRecoveryStatusFn()).toEqual({ active: false });
    expect(callsTo("getUser")).toHaveLength(0);
  });

  it("is active while the recovery session is valid", async () => {
    withRecoveryCookies();
    expect(await auth.getPasswordRecoveryStatusFn()).toEqual({ active: true });
    expect(callsTo("getUser")[0]?.args[0]).toBe(RECOVERY_ACCESS);
  });

  it("clears an expired recovery session", async () => {
    withRecoveryCookies();
    recoveryUserValid = false;
    expect(await auth.getPasswordRecoveryStatusFn()).toEqual({ active: false });
    expect(cookieDeletes).toEqual([COOKIE_RECOVERY_ACCESS_TOKEN, COOKIE_RECOVERY_REFRESH_TOKEN]);
  });
});

describe("completePasswordRecoveryFn", () => {
  const input = { password: "new-password-1", confirmPassword: "new-password-1" };

  it("updates the password, revokes every session and clears all auth cookies", async () => {
    withRecoveryCookies();
    const result = await auth.completePasswordRecoveryFn({ data: input });

    expect(result).toEqual({ ok: true });
    expect(callsTo("setSession")[0]?.args[0]).toEqual({
      access_token: RECOVERY_ACCESS,
      refresh_token: RECOVERY_REFRESH,
    });
    expect(callsTo("updateUser")[0]?.args[0]).toEqual({ password: "new-password-1" });
    expect(callsTo("signOut")[0]?.args[0]).toEqual({ scope: "global" });
    expect([...cookieDeletes].sort()).toEqual(
      [
        COOKIE_ACCESS_TOKEN,
        COOKIE_REFRESH_TOKEN,
        COOKIE_RECOVERY_ACCESS_TOKEN,
        COOKIE_RECOVERY_REFRESH_TOKEN,
      ].sort(),
    );
    // No session is issued by the reset itself — the member signs in again.
    expect(cookieWrites).toHaveLength(0);
  });

  it("refuses without a recovery session (expired window or direct visit)", async () => {
    const result = await auth.completePasswordRecoveryFn({ data: input });
    expect(result).toEqual({ ok: false, code: "recovery_expired" });
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("does not let an APSA app session stand in for a recovery session", async () => {
    withAppSession({ id: "user-2", email: "other@example.com", email_confirmed_at: "2026-01-01" });
    const result = await auth.completePasswordRecoveryFn({ data: input });
    expect(result).toEqual({ ok: false, code: "recovery_expired" });
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("rejects mismatched passwords server-side, without calling Supabase", async () => {
    withRecoveryCookies();
    await expect(
      auth.completePasswordRecoveryFn({
        data: { password: "new-password-1", confirmPassword: "new-password-2" },
      }),
    ).rejects.toThrow();
    await expect(
      auth.completePasswordRecoveryFn({ data: { password: "short", confirmPassword: "short" } }),
    ).rejects.toThrow();
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("maps a weak password to a specific, retryable error and keeps the recovery session", async () => {
    withRecoveryCookies();
    updateUserError = { name: "AuthWeakPasswordError", status: 422, code: "weak_password" };
    const result = await auth.completePasswordRecoveryFn({ data: input });
    expect(result).toEqual({ ok: false, code: "weak_password" });
    expect(cookieDeletes).toHaveLength(0);
    expect(callsTo("signOut")).toHaveLength(0);
  });

  it("maps reuse of the old password", async () => {
    withRecoveryCookies();
    updateUserError = { status: 422, code: "same_password" };
    expect(await auth.completePasswordRecoveryFn({ data: input })).toEqual({
      ok: false,
      code: "same_password",
    });
  });

  it("cleans up stale recovery state when the recovery session has expired", async () => {
    withRecoveryCookies();
    setSessionError = { status: 401, code: "session_expired" };
    const result = await auth.completePasswordRecoveryFn({ data: input });
    expect(result).toEqual({ ok: false, code: "recovery_expired" });
    expect(cookieDeletes).toEqual([COOKIE_RECOVERY_ACCESS_TOKEN, COOKIE_RECOVERY_REFRESH_TOKEN]);
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("returns a real error, not fake success, when Supabase fails", async () => {
    withRecoveryCookies();
    updateUserError = { status: 500, code: "unexpected_failure", message: "db down" };
    const result = await auth.completePasswordRecoveryFn({ data: input });
    expect(result).toEqual({ ok: false, code: "unexpected_error" });
    expect(callsTo("signOut")).toHaveLength(0);
  });
});

// ── C. Resend verification ──────────────────────────────────────────────────

describe("resendVerificationFn", () => {
  it("sends a real signup resend to the typed email when nobody is signed in", async () => {
    const result = await auth.resendVerificationFn({ data: { email: TEST_EMAIL } });
    expect(result).toEqual({ ok: true });
    expect(callsTo("resend")[0]?.args[0]).toEqual({
      type: "signup",
      email: TEST_EMAIL,
      options: { emailRedirectTo: "https://app.apsa.test/verify-email" },
    });
  });

  it("uses the signed-in member's own address, ignoring any typed email", async () => {
    withAppSession({ id: "user-1", email: TEST_EMAIL, email_confirmed_at: null });
    const result = await auth.resendVerificationFn({ data: { email: "victim@example.com" } });
    expect(result).toEqual({ ok: true });
    expect((callsTo("resend")[0]?.args[0] as { email: string }).email).toBe(TEST_EMAIL);
  });

  it("does not resend for an already-verified member", async () => {
    withAppSession({ id: "user-1", email: TEST_EMAIL, email_confirmed_at: "2026-01-01" });
    const result = await auth.resendVerificationFn({ data: {} });
    expect(result).toEqual({ ok: false, code: "already_verified" });
    expect(callsTo("resend")).toHaveLength(0);
  });

  it("requires an email when nobody is signed in", async () => {
    expect(await auth.resendVerificationFn({ data: {} })).toEqual({
      ok: false,
      code: "email_required",
    });
    expect(callsTo("resend")).toHaveLength(0);
  });

  it("reports a Supabase rate limit honestly", async () => {
    resendError = { status: 429, code: "over_email_send_rate_limit", message: "rate limited" };
    expect(await auth.resendVerificationFn({ data: { email: TEST_EMAIL } })).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });

  it("reports an outage instead of faking success", async () => {
    resendThrows = true;
    expect(await auth.resendVerificationFn({ data: { email: TEST_EMAIL } })).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });

  it("does not reveal whether the address has an account", async () => {
    resendError = { status: 400, code: "user_not_found", message: "User not found" };
    const missing = await auth.resendVerificationFn({ data: { email: "nobody@example.com" } });
    resendError = null;
    const existing = await auth.resendVerificationFn({ data: { email: TEST_EMAIL } });
    expect(missing).toEqual(existing);
  });
});

// ── D. Security ─────────────────────────────────────────────────────────────

describe("session security", () => {
  it("recovery cookies alone never pass the /app guard", async () => {
    withRecoveryCookies();
    expect(await auth.getSessionFn()).toBeNull();
    expect(await checkAppGuardFn()).toEqual({ ok: false, redirect: "/sign-in" });
  });

  it("an unverified member is still sent to /verify-email", async () => {
    withAppSession({ id: "user-1", email: TEST_EMAIL, email_confirmed_at: null });
    expect(await checkAppGuardFn()).toEqual({ ok: false, redirect: "/verify-email" });
  });

  it("never logs tokens, passwords or email addresses", () => {
    // Every scenario above ran with console capture on; several logged failures.
    expect(logged.length).toBeGreaterThan(0);
    const joined = logged.join("\n");
    for (const secret of [
      RECOVERY_ACCESS,
      RECOVERY_REFRESH,
      "new-password-1",
      TEST_EMAIL,
      "nobody@example.com",
      "hash-123",
    ]) {
      expect(joined).not.toContain(secret);
    }
  });
});
