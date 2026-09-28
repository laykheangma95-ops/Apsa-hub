/**
 * Account recovery — forgot password, reset password, verification resend.
 *
 * Server behaviour is exercised for real in account-recovery.runtime.ts (run
 * in a child process: its module mocks are process-global). This file covers
 * the pure policy module and the screens' structural guarantees.
 *
 * Run: bun test src/tests/account-recovery.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/auth-js";
import {
  classifyOwnVerificationResend,
  classifyPasswordUpdate,
  PASSWORD_MIN_LENGTH,
  resolveAppBaseUrl,
  validateNewPassword,
} from "@/lib/auth-recovery";
import { claimAuthEmailSlot, resetAuthRateLimits } from "@/server/rate-limit/auth-limits";
import { setPrimaryRateLimitStore } from "@/server/rate-limit/limiter";
import { MemoryRateLimitStore } from "@/server/rate-limit/store";
import en from "../locales/en.json";
import km from "../locales/km.json";

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), "utf-8");

describe("account recovery server functions", () => {
  it("runs isolated account-recovery runtime checks", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/account-recovery.runtime.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});

describe("recovery policy", () => {
  it("matches the sign-up password minimum", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(read("src/api/auth.ts")).toMatch(/password: z\.string\(\)\.min\(8,/);
  });

  it("validates a new password pair", () => {
    expect(validateNewPassword("short", "short")).toBe("too_short");
    expect(validateNewPassword("x".repeat(73), "x".repeat(73))).toBe("too_long");
    expect(validateNewPassword("long-enough-1", "long-enough-2")).toBe("mismatch");
    expect(validateNewPassword("long-enough-1", "long-enough-1")).toBeNull();
  });

  it("classifies an own-address resend honestly, with real supabase-js error shapes", () => {
    expect(classifyOwnVerificationResend(null)).toBe("sent");
    expect(
      classifyOwnVerificationResend(
        new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"),
      ),
    ).toBe("rate_limited");
    expect(
      classifyOwnVerificationResend(new AuthRetryableFetchError("Error sending email", 500)),
    ).toBe("service_unavailable");
    expect(classifyOwnVerificationResend(new AuthRetryableFetchError("fetch failed", 0))).toBe(
      "service_unavailable",
    );
    expect(
      classifyOwnVerificationResend(new AuthApiError("Email already confirmed", 422, "conflict")),
    ).toBe("sent");
  });

  it("classifies password update failures", () => {
    expect(classifyPasswordUpdate({ status: 422, code: "weak_password" })).toBe("weak_password");
    expect(classifyPasswordUpdate({ status: 422, code: "same_password" })).toBe("same_password");
    expect(classifyPasswordUpdate({ status: 401 })).toBe("recovery_expired");
    expect(classifyPasswordUpdate({ name: "AuthSessionMissingError" })).toBe("recovery_expired");
    expect(classifyPasswordUpdate({ status: 500 })).toBe("unexpected_error");
  });
});

describe("app base URL validation", () => {
  it("accepts a bare https origin and normalises a trailing slash", () => {
    expect(resolveAppBaseUrl("https://app.apsa.test/", true)).toEqual({
      ok: true,
      origin: "https://app.apsa.test",
    });
    expect(resolveAppBaseUrl(" https://app.apsa.test:8443 ", true)).toEqual({
      ok: true,
      origin: "https://app.apsa.test:8443",
    });
  });

  it("treats unset as the documented Supabase Site URL fallback", () => {
    expect(resolveAppBaseUrl(undefined, true)).toEqual({ ok: true, origin: undefined });
    expect(resolveAppBaseUrl("   ", true)).toEqual({ ok: true, origin: undefined });
  });

  it("allows http only for localhost, and never in production", () => {
    expect(resolveAppBaseUrl("http://localhost:3000", false)).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
    expect(resolveAppBaseUrl("http://127.0.0.1:3000", false).ok).toBe(true);
    expect(resolveAppBaseUrl("http://localhost:3000", true)).toEqual({
      ok: false,
      reason: "scheme",
    });
    expect(resolveAppBaseUrl("http://app.apsa.test", false)).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("rejects unsafe or malformed values", () => {
    const cases: Array<[string, string]> = [
      ["javascript:alert(1)", "scheme"],
      ["data:text/html,x", "scheme"],
      ["file:///etc/passwd", "scheme"],
      ["ftp://app.apsa.test", "scheme"],
      ["https://user:pass@app.apsa.test", "credentials"],
      ["https://user@app.apsa.test", "credentials"],
      ["https://app.apsa.test/?a=1", "not_origin"],
      ["https://app.apsa.test?", "not_origin"],
      ["https://app.apsa.test/#x", "not_origin"],
      ["https://app.apsa.test/app", "not_origin"],
      ["app.apsa.test", "malformed"],
      ["//evil.test", "malformed"],
      ["https://", "malformed"],
    ];
    for (const [value, reason] of cases) {
      expect({ value, result: resolveAppBaseUrl(value, true) }).toEqual({
        value,
        result: { ok: false, reason },
      });
    }
  });
});

describe("server-side auth email throttle", () => {
  it("allows one email per address and purpose per cooldown window", async () => {
    // Same contract as the PR #76 cooldown, now on the shared limiter; the
    // store is pinned to memory so this test never reaches a database.
    const restore = setPrimaryRateLimitStore(new MemoryRateLimitStore());
    resetAuthRateLimits();
    const t0 = 1_000_000;
    const ip = null;
    expect(await claimAuthEmailSlot("password_reset", "a@example.com", t0, ip)).toBe(true);
    expect(await claimAuthEmailSlot("password_reset", " A@Example.com ", t0 + 59_000, ip)).toBe(
      false,
    );
    expect(await claimAuthEmailSlot("verification_resend", "a@example.com", t0, ip)).toBe(true);
    expect(await claimAuthEmailSlot("password_reset", "b@example.com", t0, ip)).toBe(true);
    expect(await claimAuthEmailSlot("password_reset", "a@example.com", t0 + 60_000, ip)).toBe(true);
    restore();
    resetAuthRateLimits();
  });

  it("is not the only guard: the client cooldown is documented as UX", () => {
    expect(read("src/lib/auth-recovery.ts")).toMatch(/React countdown is\s+\* UX only/);
    const limits = read("src/server/rate-limit/auth-limits.ts");
    expect(limits).toContain("remain behind this as the provider-side hard");
    // The per-process store is documented for exactly what it is.
    expect(read("src/server/rate-limit/store.ts")).toContain("NOT a distributed limiter");
  });
});

describe("recovery screens", () => {
  const screens = {
    "forgot-password.tsx": read("src/routes/forgot-password.tsx"),
    "reset-password.tsx": read("src/routes/reset-password.tsx"),
    "verify-email.tsx": read("src/routes/verify-email.tsx"),
  };

  it("never call Supabase from the browser or touch tokens directly", () => {
    for (const [name, source] of Object.entries(screens)) {
      expect({ name, client: /@\/lib\/supabase\/(client|server)/.test(source) }).toEqual({
        name,
        client: false,
      });
      expect({ name, supabaseJs: source.includes("@supabase/supabase-js") }).toEqual({
        name,
        supabaseJs: false,
      });
      expect({
        name,
        storage: /localStorage|sessionStorage|document\.cookie/.test(source),
      }).toEqual({ name, storage: false });
      expect({ name, logs: /console\.(log|info|warn|error)/.test(source) }).toEqual({
        name,
        logs: false,
      });
    }
  });

  it("wire the real server functions", () => {
    expect(screens["forgot-password.tsx"]).toContain("requestPasswordResetFn");
    expect(screens["reset-password.tsx"]).toContain("beginPasswordRecoveryFn");
    expect(screens["reset-password.tsx"]).toContain("completePasswordRecoveryFn");
    expect(screens["verify-email.tsx"]).toContain("resendVerificationFn");
  });

  it("guard every submit against double taps and cooldowns", () => {
    expect(screens["forgot-password.tsx"]).toMatch(
      /if \(loading \|\| cooldown\.remaining > 0\) return;/,
    );
    expect(screens["forgot-password.tsx"]).toMatch(/disabled=\{loading \|\| coolingDown\}/);
    expect(screens["reset-password.tsx"]).toMatch(/if \(loading\) return;/);
    expect(screens["reset-password.tsx"]).toMatch(/disabled=\{loading\}/);
    expect(screens["verify-email.tsx"]).toMatch(
      /if \(loading \|\| cooldown\.remaining > 0\) return;/,
    );
    expect(screens["verify-email.tsx"]).toMatch(/disabled=\{loading \|\| coolingDown\}/);
  });

  it("exchanges the single-use link token once and scrubs it from the URL", () => {
    const reset = screens["reset-password.tsx"];
    expect(reset).toMatch(/if \(started\.current\) return;/);
    expect(reset).toMatch(/navigate\(\{ to: "\/reset-password", search: \{\}, replace: true \}\)/);
  });

  it("/verify-email never forwards a recovery token to the server", async () => {
    const { VERIFY_EMAIL_OTP_TYPES } = await import("@/api/auth");
    expect([...VERIFY_EMAIL_OTP_TYPES]).not.toContain("recovery");
    const verify = screens["verify-email.tsx"];
    expect(verify).not.toMatch(/z\.enum\(\[[^\]]*"recovery"/);
    expect(verify).toMatch(/if \(!token \|\| !email \|\| !typeAllowed\) return;/);
  });

  it("the done state does not claim a global sign-out that was not confirmed", () => {
    expect(screens["reset-password.tsx"]).toMatch(
      /state\.otherSessionsRevoked\s*\?\s*t\("auth\.resetPassword\.doneBody"\)\s*:\s*t\("auth\.resetPassword\.doneBodyUnconfirmedSignOut"\)/,
    );
    expect(en.auth.resetPassword.doneBodyUnconfirmedSignOut).not.toMatch(/signed out everywhere/);
  });

  it("the invalid-link state offers a new link", () => {
    expect(screens["reset-password.tsx"]).toContain('to="/forgot-password"');
  });

  it("sign-in offers the forgot-password route", () => {
    expect(read("src/routes/sign-in.tsx")).toContain('to="/forgot-password"');
  });

  it("frames with dvh, labels inputs and uses password autocomplete hints", () => {
    for (const [name, source] of Object.entries(screens)) {
      expect({
        name,
        dvh: source.includes("min-h-dvh"),
        vh: source.includes("min-h-screen"),
      }).toEqual({ name, dvh: true, vh: false });
      expect({ name, i18n: source.includes("useTranslation") }).toEqual({ name, i18n: true });
    }
    expect(screens["reset-password.tsx"].match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(screens["forgot-password.tsx"]).toContain('autoComplete="email"');
  });
});

describe("recovery i18n parity", () => {
  type Tree = { [key: string]: string | Tree };
  function leaves(tree: Tree, prefix = ""): Array<[string, string]> {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[`${prefix}${key}`, value] as [string, string]]
        : leaves(value, `${prefix}${key}.`),
    );
  }
  function pick(tree: Tree, dotted: string): Tree {
    return dotted.split(".").reduce((node, part) => node[part] as Tree, tree);
  }

  for (const section of ["auth.forgotPassword", "auth.resetPassword", "verifyEmail"]) {
    it(`${section} has identical keys and non-empty Khmer copy`, () => {
      const enLeaves = leaves(pick(en as Tree, section));
      const kmLeaves = new Map(leaves(pick(km as Tree, section)));
      expect([...kmLeaves.keys()].sort()).toEqual(enLeaves.map(([key]) => key).sort());
      for (const [key] of enLeaves) {
        expect({ key, empty: (kmLeaves.get(key) ?? "").trim().length === 0 }).toEqual({
          key,
          empty: false,
        });
      }
    });
  }

  it("the forgot-password confirmation is the neutral, non-enumerating message", () => {
    expect(en.auth.forgotPassword.sentBody).toMatch(/^If an account exists for this email/);
  });

  it("sign-in has the forgot-password label in both locales", () => {
    expect(en.auth.signIn.forgotPassword.length).toBeGreaterThan(0);
    expect(km.auth.signIn.forgotPassword.length).toBeGreaterThan(0);
  });
});
