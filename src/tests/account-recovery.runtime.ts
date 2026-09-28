/**
 * Account recovery — behavioural runtime checks for the real server functions
 * in src/api/auth.ts. Run in a child process by account-recovery.test.ts
 * because mock.module is process-global.
 *
 * Supabase is replaced by a small stateful fake that follows GoTrue /
 * supabase-js semantics closely enough for the security invariants:
 *   - errors are the real @supabase/auth-js classes (AuthApiError,
 *     AuthRetryableFetchError for 5xx/network, AuthWeakPasswordError,
 *     AuthSessionMissingError), returned as `{ error }` like supabase-js does;
 *   - OTPs are single-use and looked up per type, so a recovery token can
 *     only be verified as type "recovery";
 *   - sessions are server-side and revocable; `signOut({ scope: "global" })`
 *     revokes every session for the user;
 *   - password reset / resend succeed silently for unknown emails, and only an
 *     existing account can hit rate limits or SMTP failures.
 *
 * Cookies model a real browser: handlers read the request cookies, write to
 * the response, and the response is applied to the browser jar that the next
 * request is built from.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  AuthApiError,
  AuthError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from "@supabase/auth-js";

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

// ── Browser cookie jar ──────────────────────────────────────────────────────
const browser = new Map<string, string>();
let requestCookies = new Map<string, string>();
const cookieWrites: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
const cookieDeletes: string[] = [];

/** Builds the next request from what the browser holds now. */
function nextRequest() {
  requestCookies = new Map(browser);
}

async function send<T>(serverCall: () => Promise<T>): Promise<T> {
  nextRequest();
  return serverCall();
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: createServerFnMock(),
}));

mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => requestCookies.get(name),
  setCookie: (name: string, value: string, options: Record<string, unknown>) => {
    cookieWrites.push({ name, value, options });
    browser.set(name, value);
  },
  deleteCookie: (name: string) => {
    cookieDeletes.push(name);
    browser.delete(name);
  },
}));

// ── Fake Supabase Auth ──────────────────────────────────────────────────────
type Account = { id: string; email: string; password: string; confirmed: boolean };
type OtpType = "signup" | "invite" | "recovery";
type LiveSession = { userId: string; kind: "app" | "recovery"; refresh: string };

const accounts = new Map<string, Account>();
const otps = new Map<string, { type: OtpType; userId: string }>();
const liveSessions = new Map<string, LiveSession>();
let sequence = 0;

const calls: Array<{ method: string; args: unknown[] }> = [];
function record(method: string, ...args: unknown[]) {
  calls.push({ method, args });
}
function callsTo(method: string) {
  return calls.filter((call) => call.method === method);
}

// Failure knobs (null = behave normally).
let emailFailureForExistingAccount: AuthError | null;
let emailCallThrows: boolean;
let verifyOtpOutage: AuthError | "throw" | null;
let getUserOutage: AuthError | "throw" | null;
let updateUserFailure: AuthError | null;
let signOutFailure: AuthError | "throw" | null;

function addAccount(id: string, email: string, confirmed = true): Account {
  const account = { id, email, password: `old-password-${id}`, confirmed };
  accounts.set(email, account);
  return account;
}

function accountById(id: string): Account {
  const account = [...accounts.values()].find((candidate) => candidate.id === id);
  if (!account) throw new Error(`no account ${id}`);
  return account;
}

function startSession(userId: string, kind: LiveSession["kind"]) {
  sequence += 1;
  const access = `${kind}-access-${userId}-${sequence}`;
  const refresh = `${kind}-refresh-${userId}-${sequence}`;
  liveSessions.set(access, { userId, kind, refresh });
  return { access, refresh };
}

function userPayload(account: Account) {
  return {
    id: account.id,
    email: account.email,
    email_confirmed_at: account.confirmed ? "2026-01-01T00:00:00Z" : null,
  };
}

function sessionPayload(account: Account, kind: LiveSession["kind"]) {
  const { access, refresh } = startSession(account.id, kind);
  return { access_token: access, refresh_token: refresh, user: userPayload(account) };
}

/** Issues a token_hash recovery link, as Supabase does for resetPasswordForEmail. */
function issueRecoveryLink(email: string): string {
  sequence += 1;
  const tokenHash = `recovery-hash-${sequence}`;
  otps.set(tokenHash, { type: "recovery", userId: accounts.get(email)!.id });
  return tokenHash;
}

/** Issues a 6-digit token + email OTP of the given type. */
function issueEmailOtp(email: string, type: OtpType): string {
  sequence += 1;
  const token = String(100000 + sequence);
  otps.set(`${email}:${token}`, { type, userId: accounts.get(email)!.id });
  return token;
}

const otpExpired = () => new AuthApiError("Token has expired or is invalid", 403, "otp_expired");

function createFakeAuthClient() {
  let current: string | null = null;

  return {
    auth: {
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        record("signInWithPassword", credentials.email);
        const account = accounts.get(credentials.email);
        if (!account || account.password !== credentials.password) {
          return {
            data: { user: null, session: null },
            error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
          };
        }
        const session = sessionPayload(account, "app");
        return { data: { user: session.user, session }, error: null };
      },
      resetPasswordForEmail: async (email: string, options: unknown) => {
        record("resetPasswordForEmail", email, options);
        if (emailCallThrows) throw new TypeError("fetch failed");
        // GoTrue answers 200 for an unknown email; only a real send can fail.
        if (accounts.has(email) && emailFailureForExistingAccount) {
          return { data: null, error: emailFailureForExistingAccount };
        }
        return { data: {}, error: null };
      },
      resend: async (params: { type: string; email: string }) => {
        record("resend", params);
        if (emailCallThrows) throw new TypeError("fetch failed");
        const account = accounts.get(params.email);
        if (account && !account.confirmed && emailFailureForExistingAccount) {
          return { data: { user: null, session: null }, error: emailFailureForExistingAccount };
        }
        return { data: { user: null, session: null }, error: null };
      },
      verifyOtp: async (
        params:
          { token_hash: string; type: OtpType } | { email: string; token: string; type: OtpType },
      ) => {
        record("verifyOtp", params);
        if (verifyOtpOutage === "throw") throw new TypeError("fetch failed");
        if (verifyOtpOutage) return { data: { user: null, session: null }, error: verifyOtpOutage };

        const key = "token_hash" in params ? params.token_hash : `${params.email}:${params.token}`;
        const otp = otps.get(key);
        // Looked up per type: a recovery token never verifies as signup/invite.
        if (!otp || otp.type !== params.type) {
          return { data: { user: null, session: null }, error: otpExpired() };
        }
        otps.delete(key); // single use
        const account = accountById(otp.userId);
        if (otp.type === "signup") account.confirmed = true;
        const session = sessionPayload(account, otp.type === "recovery" ? "recovery" : "app");
        return { data: { user: session.user, session }, error: null };
      },
      getUser: async (jwt?: string) => {
        record("getUser", jwt);
        if (getUserOutage === "throw") throw new TypeError("fetch failed");
        if (getUserOutage) return { data: { user: null }, error: getUserOutage };
        const live = jwt ? liveSessions.get(jwt) : undefined;
        if (!live) {
          return { data: { user: null }, error: new AuthApiError("invalid JWT", 403, "bad_jwt") };
        }
        return { data: { user: userPayload(accountById(live.userId)) }, error: null };
      },
      setSession: async (tokens: { access_token: string; refresh_token: string }) => {
        record("setSession", tokens);
        const live = liveSessions.get(tokens.access_token);
        if (!live || live.refresh !== tokens.refresh_token) {
          return { data: { user: null, session: null }, error: new AuthSessionMissingError() };
        }
        current = tokens.access_token;
        return { data: {}, error: null };
      },
      updateUser: async (attributes: { password: string }) => {
        record("updateUser", attributes);
        const live = current ? liveSessions.get(current) : undefined;
        if (!live) return { data: { user: null }, error: new AuthSessionMissingError() };
        if (updateUserFailure) return { data: { user: null }, error: updateUserFailure };
        const account = accountById(live.userId);
        if (attributes.password === account.password) {
          return {
            data: { user: null },
            error: new AuthApiError(
              "New password should be different from the old password.",
              422,
              "same_password",
            ),
          };
        }
        if (attributes.password === "password123") {
          return {
            data: { user: null },
            error: new AuthWeakPasswordError("Password is known to be weak", 422, ["pwned"]),
          };
        }
        account.password = attributes.password;
        return { data: { user: userPayload(account) }, error: null };
      },
      signOut: async (options?: { scope?: string }) => {
        record("signOut", options);
        if (signOutFailure === "throw") throw new TypeError("fetch failed");
        if (signOutFailure) return { error: signOutFailure };
        const live = current ? liveSessions.get(current) : undefined;
        if (live && options?.scope === "global") {
          for (const [token, session] of liveSessions) {
            if (session.userId === live.userId) liveSessions.delete(token);
          }
        } else if (current) {
          liveSessions.delete(current);
        }
        current = null;
        return { error: null };
      },
    },
  };
}

mock.module("@supabase/supabase-js", () => ({
  createClient: () => createFakeAuthClient(),
}));

// getSessionFn's validator — only live *app* sessions count.
mock.module("@/lib/supabase/server", () => ({
  createServerClient: (accessToken: string) => ({
    auth: {
      getUser: async () => {
        const live = liveSessions.get(accessToken);
        return live?.kind === "app"
          ? { data: { user: userPayload(accountById(live.userId)) }, error: null }
          : { data: { user: null }, error: new AuthApiError("invalid JWT", 403, "bad_jwt") };
      },
      signOut: async () => {
        liveSessions.delete(accessToken);
        return { error: null };
      },
    },
  }),
  createRefreshClient: () => ({
    auth: {
      refreshSession: async () => ({
        data: { session: null },
        error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
      }),
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

const APP_URL = "https://app.apsa.test/";
process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";
process.env["VITE_APP_URL"] = APP_URL;

const auth = await import("@/api/auth");
const { checkAppGuardFn } = await import("@/api/app-guard");
const { resetAuthRateLimits: resetAuthEmailThrottle } =
  await import("@/server/rate-limit/auth-limits");
const {
  COOKIE_ACCESS_TOKEN,
  COOKIE_REFRESH_TOKEN,
  COOKIE_RECOVERY_ACCESS_TOKEN,
  COOKIE_RECOVERY_REFRESH_TOKEN,
} = auth;

const APP = [COOKIE_ACCESS_TOKEN, COOKIE_REFRESH_TOKEN].sort();
const RECOVERY = [COOKIE_RECOVERY_ACCESS_TOKEN, COOKIE_RECOVERY_REFRESH_TOKEN].sort();
const NEW_PASSWORD = { password: "new-password-1", confirmPassword: "new-password-1" };

const EMAIL_A = "owner-a@example.com";
const EMAIL_B = "owner-b@example.com";
const UNKNOWN_EMAIL = "nobody@example.com";

function jar(): string[] {
  return [...browser.keys()].sort();
}

/** Which account the browser's recovery cookie belongs to, if still valid. */
function recoveryOwner(): string | null {
  const token = browser.get(COOKIE_RECOVERY_ACCESS_TOKEN);
  const live = token ? liveSessions.get(token) : undefined;
  return live?.kind === "recovery" ? live.userId : null;
}

function appSessionsFor(userId: string): number {
  return [...liveSessions.values()].filter((s) => s.userId === userId && s.kind === "app").length;
}

async function signIn(email: string) {
  return send(() => auth.signInFn({ data: { email, password: accounts.get(email)!.password } }));
}

async function beginRecovery(tokenHash: string) {
  return send(() => auth.beginPasswordRecoveryFn({ data: { tokenHash } }));
}

async function recoveryStatus() {
  return send(() => auth.getPasswordRecoveryStatusFn());
}

async function completeRecovery(input = NEW_PASSWORD) {
  return send(() => auth.completePasswordRecoveryFn({ data: input }));
}

beforeEach(() => {
  browser.clear();
  requestCookies = new Map();
  cookieWrites.length = 0;
  cookieDeletes.length = 0;
  calls.length = 0;
  accounts.clear();
  otps.clear();
  liveSessions.clear();
  emailFailureForExistingAccount = null;
  emailCallThrows = false;
  verifyOtpOutage = null;
  getUserOutage = null;
  updateUserFailure = null;
  signOutFailure = null;
  process.env["VITE_APP_URL"] = APP_URL;
  resetAuthEmailThrottle();
  addAccount("user-a", EMAIL_A);
  addAccount("user-b", EMAIL_B);
});

afterAll(() => {
  Object.assign(console, originalConsole);
});

// Realistic provider failures for an EXISTING account.
const providerFailures: Array<[string, AuthError]> = [
  [
    "SMTP failure (5xx → AuthRetryableFetchError)",
    new AuthRetryableFetchError("Error sending recovery email", 500),
  ],
  ["gateway 503 (AuthRetryableFetchError)", new AuthRetryableFetchError("HTTP 503", 503)],
  [
    "network failure (AuthRetryableFetchError, status 0)",
    new AuthRetryableFetchError("fetch failed", 0),
  ],
  [
    "email rate limit (AuthApiError 429)",
    new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"),
  ],
  [
    "request rate limit (AuthApiError 429)",
    new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"),
  ],
  [
    "ordinary AuthApiError",
    new AuthApiError("Unable to process request", 400, "validation_failed"),
  ],
];

// ── 1. Forgot password — anti-enumeration ───────────────────────────────────

describe("requestPasswordResetFn", () => {
  it("calls Supabase password recovery with the configured reset URL", async () => {
    const result = await send(() =>
      auth.requestPasswordResetFn({ data: { email: ` ${EMAIL_A} ` } }),
    );
    expect(result).toEqual({ ok: true });
    expect(callsTo("resetPasswordForEmail")).toEqual([
      {
        method: "resetPasswordForEmail",
        args: [EMAIL_A, { redirectTo: "https://app.apsa.test/reset-password" }],
      },
    ]);
  });

  for (const [label, failure] of providerFailures) {
    it(`answers an existing account with ${label} exactly like an unknown email`, async () => {
      emailFailureForExistingAccount = failure;
      const existing = await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }));
      const unknown = await send(() =>
        auth.requestPasswordResetFn({ data: { email: UNKNOWN_EMAIL } }),
      );
      expect(existing).toEqual({ ok: true });
      expect(unknown).toEqual(existing);
      expect(callsTo("resetPasswordForEmail")).toHaveLength(2);
    });
  }

  it("answers a thrown transport error neutrally too", async () => {
    emailCallThrows = true;
    expect(await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }))).toEqual({
      ok: true,
    });
  });

  it("rejects a malformed email before calling Supabase", async () => {
    await expect(
      send(() => auth.requestPasswordResetFn({ data: { email: "not-an-email" } })),
    ).rejects.toThrow();
    expect(callsTo("resetPasswordForEmail")).toHaveLength(0);
  });

  it("never touches any cookie", async () => {
    await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }));
    expect(cookieWrites).toHaveLength(0);
    expect(cookieDeletes).toHaveLength(0);
  });
});

// ── 7. Server-side abuse control ────────────────────────────────────────────

describe("server-side email cooldown", () => {
  it("a direct caller cannot bypass the reset cooldown; the answer stays neutral", async () => {
    const first = await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }));
    const second = await send(() =>
      auth.requestPasswordResetFn({ data: { email: EMAIL_A.toUpperCase() } }),
    );
    expect(second).toEqual(first);
    expect(callsTo("resetPasswordForEmail")).toHaveLength(1);

    // A different address is independent.
    await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_B } }));
    expect(callsTo("resetPasswordForEmail")).toHaveLength(2);
  });

  it("throttles an unknown email identically to an existing one", async () => {
    await send(() => auth.requestPasswordResetFn({ data: { email: UNKNOWN_EMAIL } }));
    const throttled = await send(() =>
      auth.requestPasswordResetFn({ data: { email: UNKNOWN_EMAIL } }),
    );
    expect(throttled).toEqual({ ok: true });
    expect(callsTo("resetPasswordForEmail")).toHaveLength(1);
  });

  it("a public resend cannot bypass the cooldown and stays neutral", async () => {
    addAccount("user-u", "pending@example.com", false);
    await send(() => auth.resendVerificationFn({ data: { email: "pending@example.com" } }));
    const second = await send(() =>
      auth.resendVerificationFn({ data: { email: "pending@example.com" } }),
    );
    expect(second).toEqual({ ok: true });
    expect(callsTo("resend")).toHaveLength(1);
  });

  it("a signed-in member resending to their own address is told to wait", async () => {
    addAccount("user-u", "pending@example.com", false);
    await signIn("pending@example.com");
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({ ok: true });
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(callsTo("resend")).toHaveLength(1);
  });
});

// ── 8. VITE_APP_URL validation ──────────────────────────────────────────────

describe("VITE_APP_URL validation", () => {
  const unsafe = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://app.apsa.test",
    "http://app.apsa.test",
    "https://user:pass@app.apsa.test",
    "https://app.apsa.test/?next=https://evil.test",
    "https://app.apsa.test/#frag",
    "https://app.apsa.test/nested/path",
    "not a url",
    "//evil.test",
  ];

  for (const value of unsafe) {
    it(`refuses to send with VITE_APP_URL=${JSON.stringify(value)}`, async () => {
      process.env["VITE_APP_URL"] = value;
      expect(await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }))).toEqual({
        ok: false,
        code: "service_unavailable",
      });
      expect(
        await send(() => auth.resendVerificationFn({ data: { email: UNKNOWN_EMAIL } })),
      ).toEqual({ ok: false, code: "service_unavailable" });
      expect(callsTo("resetPasswordForEmail")).toHaveLength(0);
      expect(callsTo("resend")).toHaveLength(0);
    });
  }

  it("answers an invalid config identically for known and unknown emails", async () => {
    process.env["VITE_APP_URL"] = "javascript:alert(1)";
    const known = await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }));
    const unknown = await send(() =>
      auth.requestPasswordResetFn({ data: { email: UNKNOWN_EMAIL } }),
    );
    expect(unknown).toEqual(known);
  });

  it("falls back to the Supabase Site URL when unset", async () => {
    delete process.env["VITE_APP_URL"];
    expect(await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }))).toEqual({
      ok: true,
    });
    expect(callsTo("resetPasswordForEmail")[0]?.args[1]).toEqual({});
  });

  it("allows http://localhost outside production", async () => {
    process.env["VITE_APP_URL"] = "http://localhost:3000";
    await send(() => auth.requestPasswordResetFn({ data: { email: EMAIL_A } }));
    expect(callsTo("resetPasswordForEmail")[0]?.args[1]).toEqual({
      redirectTo: "http://localhost:3000/reset-password",
    });
  });
});

// ── Recovery link exchange ──────────────────────────────────────────────────

describe("beginPasswordRecoveryFn", () => {
  it("exchanges a token_hash link server-side into HttpOnly recovery cookies only", async () => {
    const result = await beginRecovery(issueRecoveryLink(EMAIL_A));

    expect(result).toEqual({ ok: true });
    expect(jar()).toEqual(RECOVERY);
    for (const write of cookieWrites) {
      expect(write.options["httpOnly"]).toBe(true);
      expect(write.options["sameSite"]).toBe("lax");
      expect(write.options["maxAge"]).toBe(15 * 60);
    }
    expect(recoveryOwner()).toBe("user-a");
    expect(JSON.stringify(result)).not.toContain("recovery-access");
  });

  it("accepts the token + email link shape", async () => {
    const token = issueEmailOtp(EMAIL_A, "recovery");
    const result = await send(() =>
      auth.beginPasswordRecoveryFn({ data: { token, email: EMAIL_A } }),
    );
    expect(result).toEqual({ ok: true });
    expect(callsTo("verifyOtp")[0]?.args[0]).toEqual({ email: EMAIL_A, token, type: "recovery" });
  });

  it("returns invalid_link for an expired or unknown link", async () => {
    expect(await beginRecovery("never-issued")).toEqual({ ok: false, code: "invalid_link" });
    expect(cookieWrites).toHaveLength(0);
    expect(jar()).toEqual([]);
  });

  it("distinguishes an outage (returned or thrown) from a bad link", async () => {
    verifyOtpOutage = new AuthRetryableFetchError("HTTP 503", 503);
    expect(await beginRecovery("hash")).toEqual({ ok: false, code: "service_unavailable" });
    verifyOtpOutage = "throw";
    expect(await beginRecovery("hash")).toEqual({ ok: false, code: "service_unavailable" });
  });
});

describe("completePasswordRecoveryFn", () => {
  it("refuses without a recovery session", async () => {
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("does not let an APSA app session stand in for a recovery session", async () => {
    await signIn(EMAIL_B);
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("rejects mismatched or short passwords server-side, without calling Supabase", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    await expect(
      completeRecovery({ password: "new-password-1", confirmPassword: "new-password-2" }),
    ).rejects.toThrow();
    await expect(
      completeRecovery({ password: "short", confirmPassword: "short" }),
    ).rejects.toThrow();
    expect(callsTo("updateUser")).toHaveLength(0);
  });

  it("maps reuse of the old password", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    const old = accountById("user-a").password;
    expect(await completeRecovery({ password: old, confirmPassword: old })).toEqual({
      ok: false,
      code: "same_password",
    });
  });
});

// ── 9. Recovery cookie cleanup matrix ───────────────────────────────────────

describe("recovery cookie cleanup matrix", () => {
  it("A. recovery starts → normal sign-in: recovery is dropped, app session kept", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    const result = await signIn(EMAIL_B);

    expect(result).toEqual({ ok: true, redirectTo: "/onboarding" });
    expect(jar()).toEqual(APP);
    expect(await recoveryStatus()).toEqual({ active: false });
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
    expect(accountById("user-a").password).toBe("old-password-user-a");
  });

  it("B. recovery starts → sign-out: nothing survives, the reset form cannot reopen", async () => {
    await signIn(EMAIL_B);
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    await send(() => auth.signOutFn());

    expect(jar()).toEqual([]);
    expect(await recoveryStatus()).toEqual({ active: false });
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
  });

  it("C. recovery A → recovery B: only B's recovery remains and only B is reset", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    await beginRecovery(issueRecoveryLink(EMAIL_B));

    expect(jar()).toEqual(RECOVERY);
    expect(recoveryOwner()).toBe("user-b");
    expect(await completeRecovery()).toEqual({ ok: true, otherSessionsRevoked: true });
    expect(accountById("user-b").password).toBe("new-password-1");
    expect(accountById("user-a").password).toBe("old-password-user-a");
  });

  it("D. recovery A → invalid recovery B: A's recovery is cleared before B is checked", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    expect(await beginRecovery("forged-or-expired")).toEqual({ ok: false, code: "invalid_link" });

    expect(jar()).toEqual([]);
    expect(await recoveryStatus()).toEqual({ active: false });
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
    expect(accountById("user-a").password).toBe("old-password-user-a");
  });

  it("D'. recovery A → recovery link outage: A's recovery does not survive", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    verifyOtpOutage = "throw";
    expect(await beginRecovery("any")).toEqual({ ok: false, code: "service_unavailable" });
    expect(jar()).toEqual([]);
  });

  it("E. recovery session expires: status and submit both clear it", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    liveSessions.clear(); // Supabase-side expiry/revocation

    expect(await recoveryStatus()).toEqual({ active: false });
    expect(jar()).toEqual([]);

    // Stale cookies still in a browser that never ran the status check:
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    liveSessions.clear();
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
    expect(jar()).toEqual([]);
  });

  it("F. status validation throws or gets a retryable error: recovery is cleared", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    getUserOutage = "throw";
    expect(await recoveryStatus()).toEqual({ active: false });
    expect(jar()).toEqual([]);

    getUserOutage = null;
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    getUserOutage = new AuthRetryableFetchError("HTTP 502", 502);
    expect(await recoveryStatus()).toEqual({ active: false });
    expect(jar()).toEqual([]);
  });

  it("G. successful reset: password changed, every session revoked, every cookie cleared", async () => {
    await signIn(EMAIL_A); // another device / tab of the same account
    const otherDevice = [...liveSessions.keys()];
    await beginRecovery(issueRecoveryLink(EMAIL_A));

    const result = await completeRecovery();

    expect(result).toEqual({ ok: true, otherSessionsRevoked: true });
    expect(callsTo("signOut")[0]?.args[0]).toEqual({ scope: "global" });
    expect(accountById("user-a").password).toBe("new-password-1");
    expect(otherDevice.some((token) => liveSessions.has(token))).toBe(false);
    expect(appSessionsFor("user-a")).toBe(0);
    expect(jar()).toEqual([]);
    expect(cookieWrites.filter((w) => APP.includes(w.name))).toHaveLength(2); // only the sign-in
  });

  it("H. password update fails: recovery kept for a retry, no app session, honest error", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));

    expect(
      await completeRecovery({ password: "password123", confirmPassword: "password123" }),
    ).toEqual({ ok: false, code: "weak_password" });
    expect(jar()).toEqual(RECOVERY);

    updateUserFailure = new AuthRetryableFetchError("HTTP 500", 500);
    expect(await completeRecovery()).toEqual({ ok: false, code: "unexpected_error" });
    expect(jar()).toEqual(RECOVERY);
    expect(callsTo("signOut")).toHaveLength(0);
    expect(accountById("user-a").password).toBe("old-password-user-a");
  });

  it("I. global sign-out returns an error: password changed, no false 'signed out everywhere'", async () => {
    await signIn(EMAIL_A);
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    signOutFailure = new AuthRetryableFetchError("HTTP 503", 503);

    const result = await completeRecovery();

    expect(result).toEqual({ ok: true, otherSessionsRevoked: false });
    expect(accountById("user-a").password).toBe("new-password-1");
    expect(jar()).toEqual([]);
  });

  it("I'. global sign-out throws: same truthful partial result, cookies still cleared", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    signOutFailure = "throw";

    expect(await completeRecovery()).toEqual({ ok: true, otherSessionsRevoked: false });
    expect(accountById("user-a").password).toBe("new-password-1");
    expect(jar()).toEqual([]);
  });

  it("J. recovery token replay: the reused link is refused and grants nothing", async () => {
    const link = issueRecoveryLink(EMAIL_A);
    expect(await beginRecovery(link)).toEqual({ ok: true });
    await completeRecovery();

    expect(await beginRecovery(link)).toEqual({ ok: false, code: "invalid_link" });
    expect(jar()).toEqual([]);
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
  });
});

// ── 10. Cross-account safety ────────────────────────────────────────────────

describe("cross-account safety", () => {
  it("user A signed in → opens user B's recovery link: A's app session is dropped", async () => {
    await signIn(EMAIL_A);
    expect(jar()).toEqual(APP);

    await beginRecovery(issueRecoveryLink(EMAIL_B));

    expect(jar()).toEqual(RECOVERY);
    expect(recoveryOwner()).toBe("user-b");
    expect(await send(() => auth.getSessionFn())).toBeNull();
    expect(await send(() => checkAppGuardFn())).toEqual({ ok: false, redirect: "/sign-in" });
  });

  it("normal sign-in by the same account while a stale recovery exists drops the recovery", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    await signIn(EMAIL_A);
    expect(jar()).toEqual(APP);
    expect(await completeRecovery()).toEqual({ ok: false, code: "recovery_expired" });
  });

  it("a failed sign-in attempt does not issue an app session", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    const result = await send(() =>
      auth.signInFn({ data: { email: EMAIL_B, password: "wrong-password" } }),
    );
    expect(result).toEqual({ ok: false, code: "invalid_credentials" });
    expect(jar()).toEqual(RECOVERY);
  });
});

// ── 1. Recovery token must never become a normal app session ────────────────

describe("/verify-email cannot accept a recovery token", () => {
  it("refuses type=recovery before Supabase is called and writes no session cookie", async () => {
    const token = issueEmailOtp(EMAIL_A, "recovery");
    const result = await send(() =>
      auth.verifyEmailFn({ data: { token, email: EMAIL_A, type: "recovery" } }),
    );

    expect(result).toEqual({ ok: false, code: "invalid_token" });
    expect(callsTo("verifyOtp")).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
    expect(jar()).toEqual([]);
  });

  it("refuses every other non-verification type the same way", async () => {
    for (const type of ["magiclink", "email", "email_change", "RECOVERY", ""]) {
      const token = issueEmailOtp(EMAIL_A, "recovery");
      const result = await send(() =>
        auth.verifyEmailFn({ data: { token, email: EMAIL_A, type } }),
      );
      expect({ type, result }).toEqual({ type, result: { ok: false, code: "invalid_token" } });
    }
    expect(callsTo("verifyOtp")).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
  });

  it("a recovery token relabelled as signup is rejected by Supabase and writes nothing", async () => {
    const token = issueEmailOtp(EMAIL_A, "recovery");
    for (const type of ["signup", "invite", undefined]) {
      const result = await send(() =>
        auth.verifyEmailFn({
          data: type ? { token, email: EMAIL_A, type } : { token, email: EMAIL_A },
        }),
      );
      expect(result).toEqual({ ok: false, code: "invalid_token" });
    }
    expect(cookieWrites.some((w) => APP.includes(w.name))).toBe(false);
    expect(jar()).toEqual([]);
  });

  it("a genuine signup token still verifies and drops any pending recovery", async () => {
    addAccount("user-u", "pending@example.com", false);
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    const token = issueEmailOtp("pending@example.com", "signup");

    const result = await send(() =>
      auth.verifyEmailFn({ data: { token, email: "pending@example.com", type: "signup" } }),
    );

    expect(result).toEqual({ ok: true });
    expect(jar()).toEqual(APP);
  });
});

// ── 5. Resend verification — anti-enumeration ───────────────────────────────

describe("resendVerificationFn", () => {
  it("sends a real signup resend to the typed email when nobody is signed in", async () => {
    const result = await send(() => auth.resendVerificationFn({ data: { email: EMAIL_A } }));
    expect(result).toEqual({ ok: true });
    expect(callsTo("resend")[0]?.args[0]).toEqual({
      type: "signup",
      email: EMAIL_A,
      options: { emailRedirectTo: "https://app.apsa.test/verify-email" },
    });
  });

  for (const [label, failure] of providerFailures) {
    it(`public: ${label} for a pending account looks exactly like an unknown email`, async () => {
      addAccount("user-u", "pending@example.com", false);
      emailFailureForExistingAccount = failure;
      const pending = await send(() =>
        auth.resendVerificationFn({ data: { email: "pending@example.com" } }),
      );
      const unknown = await send(() =>
        auth.resendVerificationFn({ data: { email: UNKNOWN_EMAIL } }),
      );
      expect(pending).toEqual({ ok: true });
      expect(unknown).toEqual(pending);
    });
  }

  it("public: a thrown transport error is neutral too", async () => {
    emailCallThrows = true;
    expect(await send(() => auth.resendVerificationFn({ data: { email: EMAIL_A } }))).toEqual({
      ok: true,
    });
  });

  it("uses the signed-in member's own address, ignoring any typed email", async () => {
    addAccount("user-u", "pending@example.com", false);
    await signIn("pending@example.com");
    const result = await send(() =>
      auth.resendVerificationFn({ data: { email: "victim@example.com" } }),
    );
    expect(result).toEqual({ ok: true });
    expect((callsTo("resend")[0]?.args[0] as { email: string }).email).toBe("pending@example.com");
  });

  it("own address: reports rate limits and outages honestly", async () => {
    addAccount("user-u", "pending@example.com", false);
    await signIn("pending@example.com");

    emailFailureForExistingAccount = new AuthApiError(
      "email rate limit exceeded",
      429,
      "over_email_send_rate_limit",
    );
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({
      ok: false,
      code: "rate_limited",
    });

    resetAuthEmailThrottle();
    emailFailureForExistingAccount = new AuthRetryableFetchError("Error sending email", 500);
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });

  it("does not resend for an already-verified member", async () => {
    await signIn(EMAIL_A);
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({
      ok: false,
      code: "already_verified",
    });
    expect(callsTo("resend")).toHaveLength(0);
  });

  it("requires an email when nobody is signed in", async () => {
    expect(await send(() => auth.resendVerificationFn({ data: {} }))).toEqual({
      ok: false,
      code: "email_required",
    });
    expect(callsTo("resend")).toHaveLength(0);
  });
});

// ── Session security ────────────────────────────────────────────────────────

describe("session security", () => {
  it("recovery cookies alone never pass the /app guard", async () => {
    await beginRecovery(issueRecoveryLink(EMAIL_A));
    expect(await send(() => auth.getSessionFn())).toBeNull();
    expect(await send(() => checkAppGuardFn())).toEqual({ ok: false, redirect: "/sign-in" });
  });

  it("an unverified member is still sent to /verify-email", async () => {
    addAccount("user-u", "pending@example.com", false);
    await signIn("pending@example.com");
    expect(await send(() => checkAppGuardFn())).toEqual({ ok: false, redirect: "/verify-email" });
  });

  it("never logs tokens, passwords, email addresses or raw provider messages", () => {
    // Every scenario above ran with console capture on; several logged failures.
    expect(logged.length).toBeGreaterThan(0);
    const joined = logged.join("\n");
    for (const secret of [
      "recovery-access",
      "recovery-refresh",
      "app-access",
      "recovery-hash",
      "new-password-1",
      "old-password",
      EMAIL_A,
      EMAIL_B,
      UNKNOWN_EMAIL,
      "pending@example.com",
      "Error sending recovery email",
      "email rate limit exceeded",
      "javascript:alert",
    ]) {
      expect({ secret, leaked: joined.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });
});
