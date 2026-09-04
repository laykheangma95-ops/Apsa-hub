import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

function createServerFnMock() {
  return () => ({
    validator(validator: (data: unknown) => unknown) {
      return { handler<TArgs extends { data: unknown }, TResult>(handler: (args: { data: TArgs["data"] }) => TResult | Promise<TResult>) {
        return async ({ data }: TArgs) => handler({ data: validator(data) as TArgs["data"] });
      }};
    },
    handler<TResult>(handler: () => TResult | Promise<TResult>) { return handler; },
  });
}

let membershipStatus: "removed" | "suspended" = "removed";
function mockServerModule(rpc?: (...args: unknown[]) => Promise<unknown>) {
  mock.module("@/lib/supabase/server", () => ({
    createServerClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "pending@example.com", email_confirmed_at: null } }, error: null }) },
      rpc,
    }),
    createRefreshClient: () => ({ auth: { refreshSession: async () => ({ data: { session: null }, error: new Error("not used") }) } }),
    supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ single: async () => ({ data: { organization_id: "org-1", status: membershipStatus } }) }) }) }) }) }) }) },
  }));
}

describe("auth hardening runtime", () => {
  it("getSessionFn rejects unverified users with a non-authorized session state", async () => {
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mock.module("@tanstack/react-start/server", () => ({ getCookie: (name: string) => name === "sb-access-token" ? "access-token" : "refresh-token", setCookie: () => undefined, deleteCookie: () => undefined }));
    mockServerModule();
    const { getSessionFn } = await import("@/api/auth");
    expect((await getSessionFn())?.emailVerified).toBe(false);
  });

  it("createOrganizationFn independently rejects an unverified user before the RPC call", async () => {
    const rpcCalls: unknown[][] = [];
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mock.module("@/api/auth", () => ({ getSessionFn: async () => ({ userId: "user-1", email: "pending@example.com", emailVerified: false as const, accessToken: "access-token" }) }));
    mockServerModule(async (...args) => { rpcCalls.push(args); return { data: null, error: null }; });
    const { createOrganizationFn } = await import("@/server/org/create-organization");
    const result = await createOrganizationFn({ data: { legalName: "APSA Co", displayName: "APSA", slug: "apsa-co", currency: "USD" } });
    expect(result).toEqual({ ok: false, code: "email_not_verified" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("awaits cookie clearing before redirecting revoked or suspended members", async () => {
    mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
    mockServerModule();
    let releaseCookieClear: (() => void) | undefined;
    let notifyClearStarted: (() => void) | undefined;
    mock.module("@/api/auth", () => ({
      getSessionFn: async () => ({ userId: "user-1", email: "owner@example.com", emailVerified: true as const, accessToken: "access-token" }),
      clearAuthCookieFn: () => new Promise<{ ok: true }>((clear) => { releaseCookieClear = () => clear({ ok: true }); notifyClearStarted?.(); }),
    }));
    const { checkAppGuardFn } = await import("@/api/app-guard");
    for (const status of ["removed", "suspended"] as const) {
      membershipStatus = status;
      let guardResolved = false;
      const clearStarted = new Promise<void>((resolve) => { notifyClearStarted = resolve; });
      const guard = checkAppGuardFn().then((result) => { guardResolved = true; return result; });
      await clearStarted;
      expect(guardResolved).toBe(false);
      releaseCookieClear!();
      await expect(guard).resolves.toEqual({ ok: false, redirect: "/access-denied" });
    }
  });

  it("access-denied stays public so the revoked redirect cannot loop", () => {
    const accessDeniedCode = fs.readFileSync(path.resolve(process.cwd(), "src/routes/access-denied.tsx"), "utf-8");
    const appRouteCode = fs.readFileSync(path.resolve(process.cwd(), "src/routes/app.tsx"), "utf-8");
    expect(accessDeniedCode).toMatch(/createFileRoute\("\/access-denied"\)/);
    expect(accessDeniedCode).not.toMatch(/beforeLoad/);
    expect(appRouteCode).toMatch(/beforeLoad/);
  });
});
