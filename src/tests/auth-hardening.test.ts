import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";

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

afterEach(() => {
  mock.restore();
});

describe("auth hardening", () => {
  it("getSessionFn rejects unverified users with a non-authorized session state", async () => {
    mock.module("@tanstack/react-start", () => ({
      createServerFn: createServerFnMock(),
    }));
    mock.module("@tanstack/react-start/server", () => ({
      getCookie: (name: string) => (name === "sb-access-token" ? "access-token" : "refresh-token"),
      setCookie: () => undefined,
      deleteCookie: () => undefined,
    }));
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "user-1",
                email: "pending@example.com",
                email_confirmed_at: null,
              },
            },
            error: null,
          }),
        },
      }),
      createRefreshClient: () => ({
        auth: {
          refreshSession: async () => ({
            data: { session: null },
            error: new Error("refresh should not run"),
          }),
        },
      }),
    }));

    const { getSessionFn } = await import("@/api/auth");
    const session = await getSessionFn();

    expect(session).not.toBeNull();
    expect(session?.emailVerified).toBe(false);
  });

  it("createOrganizationFn independently rejects an unverified user before the RPC call", async () => {
    const rpcCalls: unknown[] = [];

    mock.module("@tanstack/react-start", () => ({
      createServerFn: createServerFnMock(),
    }));
    mock.module("@/api/auth", () => ({
      getSessionFn: async () => ({
        userId: "user-1",
        email: "pending@example.com",
        emailVerified: false as const,
        accessToken: "access-token",
      }),
    }));
    mock.module("@/lib/supabase/server", () => ({
      createServerClient: () => ({
        rpc: async (...args: unknown[]) => {
          rpcCalls.push(args);
          return { data: null, error: null };
        },
      }),
    }));

    const { createOrganizationFn } = await import("@/server/org/create-organization");
    const result = await createOrganizationFn({
      data: {
        legalName: "APSA Co",
        displayName: "APSA",
        slug: "apsa-co",
        currency: "USD",
      },
    });

    expect(result).toEqual({ ok: false, code: "email_not_verified" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("revoked membership clears auth cookies before redirecting to /access-denied", async () => {
    const callOrder: string[] = [];

    mock.module("@tanstack/react-start", () => ({
      createServerFn: createServerFnMock(),
    }));
    mock.module("@/api/auth", () => ({
      getSessionFn: async () => ({
        userId: "user-1",
        email: "owner@example.com",
        emailVerified: true as const,
        accessToken: "access-token",
      }),
      clearAuthCookieFn: async () => {
        callOrder.push("clear");
        return { ok: true as const };
      },
    }));
    mock.module("@/lib/supabase/server", () => ({
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: () => ({
                    single: async () => ({
                      data: {
                        organization_id: "org-1",
                        status: "removed",
                      },
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      },
    }));

    const { checkAppGuardFn } = await import("@/api/app-guard");
    const result = await checkAppGuardFn();
    callOrder.push("return");

    expect(result).toEqual({ ok: false, redirect: "/access-denied" });
    expect(callOrder).toEqual(["clear", "return"]);
  });

  it("access-denied stays public so the revoked redirect cannot loop", () => {
    const accessDeniedCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/access-denied.tsx"),
      "utf-8",
    );
    const appRouteCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/app.tsx"),
      "utf-8",
    );

    expect(accessDeniedCode).toMatch(/createFileRoute\("\/access-denied"\)/);
    expect(accessDeniedCode).not.toMatch(/beforeLoad/);
    expect(appRouteCode).toMatch(/beforeLoad/);
  });
});
