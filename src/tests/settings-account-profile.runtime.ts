/**
 * Settings "Account" + sign-out audit tests — src/api/auth.ts's
 * getAccountProfileFn and the audit-logging addition to signOutFn.
 *
 * Isolated runtime file (spawned by settings-account-profile.test.ts), same
 * reason as auth-hardening.runtime.ts: bun:test's mock.module mutates the
 * shared module cache for the whole process, so this must not share a
 * process with any other test file.
 *
 * Run: bun test src/tests/settings-account-profile.runtime.ts
 */
import { describe, expect, it } from "bun:test";
import { mock } from "bun:test";

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

const deletedCookies: string[] = [];

function mockStartServerModule() {
  mock.module("@tanstack/react-start/server", () => ({
    getCookie: (name: string) => (name === "sb-access-token" ? "access-token" : "refresh-token"),
    setCookie: () => undefined,
    deleteCookie: (name: string) => {
      deletedCookies.push(name);
    },
  }));
}

describe("settings account profile + sign-out audit runtime", () => {
  it("getAccountProfileFn returns email + display name for a valid session", async () => {
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01" },
            },
            error: null,
          }),
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: (table: string) => {
          if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { display_name: "Sok Dara" }, error: null }),
              }),
            }),
          };
        },
      },
    }));

    const { getAccountProfileFn } = await import("@/api/auth");
    const result = await getAccountProfileFn();
    expect(result).toEqual({ email: "owner@example.com", displayName: "Sok Dara" });
  });

  it("getAccountProfileFn falls back to a null display name (never throws) when the profile read fails", async () => {
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01" },
            },
            error: null,
          }),
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: "db unavailable" } }),
            }),
          }),
        }),
      },
    }));

    const { getAccountProfileFn } = await import("@/api/auth");
    const result = await getAccountProfileFn();
    expect(result).toEqual({ email: "owner@example.com", displayName: null });
  });

  it("getAccountProfileFn returns null when there is no session (never leaks another user's row)", async () => {
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mock.module("@tanstack/react-start/server", () => ({
      getCookie: () => undefined,
      setCookie: () => undefined,
      deleteCookie: () => undefined,
    }));
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => {
        throw new Error("must not be called without a session");
      },
      createRefreshClient: () => {
        throw new Error("must not be called without a session");
      },
      supabaseAdmin: {
        from: () => {
          throw new Error("must not query the DB without a session");
        },
      },
    }));

    const { getAccountProfileFn } = await import("@/api/auth");
    expect(await getAccountProfileFn()).toBeNull();
  });

  it("signOutFn still calls client.auth.signOut() (session revocation) even when the best-effort audit lookup throws", async () => {
    deletedCookies.length = 0;
    let signOutCalled = false;
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01" },
            },
            error: null,
          }),
          signOut: async () => {
            signOutCalled = true;
            return { error: null };
          },
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: () => {
          throw new Error("simulated DB outage during audit lookup");
        },
      },
    }));

    const { signOutFn } = await import("@/api/auth");
    await expect(signOutFn()).resolves.toBeUndefined();
    // Revocation and cookie-clearing must never be skipped because the
    // (later, best-effort) audit step failed.
    expect(signOutCalled).toBe(true);
    expect(deletedCookies.sort()).toEqual(["sb-access-token", "sb-refresh-token"]);
  });

  it("signOutFn calls client.auth.signOut() and clears cookies when the user has no active organization membership (onboarding-only account)", async () => {
    deletedCookies.length = 0;
    let signOutCalled = false;
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: "user-1", email: "new@example.com", email_confirmed_at: "2026-01-01" },
            },
            error: null,
          }),
          signOut: async () => {
            signOutCalled = true;
            return { error: null };
          },
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: (table: string) => {
          if (table !== "memberships") throw new Error(`unexpected table: ${table}`);
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      single: async () => ({ data: null, error: { message: "no rows" } }),
                    }),
                  }),
                }),
              }),
            }),
          };
        },
      },
    }));

    const { signOutFn } = await import("@/api/auth");
    await expect(signOutFn()).resolves.toBeUndefined();
    expect(signOutCalled).toBe(true);
    expect(deletedCookies.sort()).toEqual(["sb-access-token", "sb-refresh-token"]);
  });

  it("signOutFn still calls client.auth.signOut() even when getUser() itself throws (user identification failure never blocks revocation)", async () => {
    deletedCookies.length = 0;
    let signOutCalled = false;
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => {
            throw new Error("simulated network failure identifying the user");
          },
          signOut: async () => {
            signOutCalled = true;
            return { error: null };
          },
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: () => {
          throw new Error("must not be reached — no userId was identified");
        },
      },
    }));

    const { signOutFn } = await import("@/api/auth");
    await expect(signOutFn()).resolves.toBeUndefined();
    expect(signOutCalled).toBe(true);
    expect(deletedCookies.sort()).toEqual(["sb-access-token", "sb-refresh-token"]);
  });

  it("signOutFn does not hang indefinitely when the audit write never resolves (bounded timeout)", async () => {
    deletedCookies.length = 0;
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockStartServerModule();
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01" },
            },
            error: null,
          }),
          signOut: async () => ({ error: null }),
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({ data: { session: null }, error: new Error("unused") }),
        },
      }),
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    // Never resolves — simulates a hung DB call during the
                    // membership lookup inside the best-effort audit step.
                    single: () => new Promise(() => {}),
                  }),
                }),
              }),
            }),
          }),
        }),
      },
    }));

    const { signOutFn } = await import("@/api/auth");
    const start = Date.now();
    await expect(signOutFn()).resolves.toBeUndefined();
    const elapsedMs = Date.now() - start;
    // Cookies must already be cleared (steps 1-3 complete) well before the
    // bounded audit timeout elapses.
    expect(deletedCookies.sort()).toEqual(["sb-access-token", "sb-refresh-token"]);
    // The audit step is capped — signOutFn must still resolve in a bounded
    // time, not hang forever on the never-resolving membership lookup.
    expect(elapsedMs).toBeLessThan(4000);
  });
});
