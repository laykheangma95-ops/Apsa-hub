/**
 * getActiveMemberCapabilitiesFn — server authority tests.
 *
 * Isolated runtime file (spawned by capabilities-server.test.ts) for the same
 * reason as auth-hardening.runtime.ts: bun:test's mock.module mutates the
 * shared module cache for the whole process.
 *
 * What must hold:
 *   - identity comes from the cookie session, never from a caller-supplied value;
 *   - the organization comes from the caller's own active membership row;
 *   - permissions come from the existing resolver, not from a role name;
 *   - anything unresolved fails closed.
 *
 * Run: bun test src/tests/capabilities-server.runtime.ts
 */
import { describe, expect, it, mock } from "bun:test";

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

interface SessionShape {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
}

/** Records every filter the handler applied, so we can assert on them. */
interface MembershipCall {
  table: string;
  filters: Record<string, unknown>;
}

function mockEnvironment(options: {
  user: SessionShape | null;
  membershipOrgId: string | null;
  calls: MembershipCall[];
}) {
  mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
  mock.module("@tanstack/react-start/server", () => ({
    getCookie: (name: string) =>
      options.user ? (name === "sb-access-token" ? "access" : "refresh") : undefined,
    setCookie: () => undefined,
    deleteCookie: () => undefined,
  }));

  mock.module("@/lib/supabase/server", () => ({
    createServerClient: () => ({
      auth: {
        getUser: async () => ({
          data: { user: options.user },
          error: options.user ? null : new Error("no user"),
        }),
      },
    }),
    createRefreshClient: () => ({
      auth: {
        refreshSession: async () => ({ data: { session: null }, error: new Error("expired") }),
      },
    }),
    supabaseAdmin: {
      from: (table: string) => {
        const call: MembershipCall = { table, filters: {} };
        options.calls.push(call);
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            call.filters[column] = value;
            return builder;
          },
          order: () => builder,
          limit: () => builder,
          single: async () =>
            options.membershipOrgId
              ? { data: { organization_id: options.membershipOrgId }, error: null }
              : { data: null, error: { message: "no rows" } },
        };
        return builder;
      },
    },
  }));
}

function mockAuthorization(permissions: string[], systemRole: string | null, orgId: string) {
  mock.module("@/server/auth/authorization", () => ({
    AuthorizationService: {
      forRequest: async (userId: string, organizationId: string) => ({
        userId,
        organizationId,
        systemRole,
        can: (key: string) => permissions.includes(key),
      }),
    },
  }));
  return orgId;
}

function mockAuthorizationThrows() {
  mock.module("@/server/auth/authorization", () => ({
    AuthorizationService: {
      forRequest: async () => {
        throw new Error("No active membership in this organization");
      },
    },
  }));
}

describe("getActiveMemberCapabilitiesFn — server authority", () => {
  it("derives the snapshot from the session user and the membership organization", async () => {
    const calls: MembershipCall[] = [];
    mockEnvironment({
      user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01" },
      membershipOrgId: "org-1",
      calls,
    });
    mockAuthorization(["orders.read", "team.read"], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    const result = await getActiveMemberCapabilitiesFn();

    expect(result).toEqual({
      status: "active",
      userId: "user-1",
      organizationId: "org-1",
      role: "OWNER",
      permissions: ["orders.read", "team.read"],
    });

    // The membership lookup is scoped to the session user and active rows only.
    const membershipCall = calls.find((call) => call.table === "memberships");
    expect(membershipCall?.filters["user_id"]).toBe("user-1");
    expect(membershipCall?.filters["status"]).toBe("active");
  });

  it("takes no input at all — a crafted organization id, role or permission list cannot reach it", async () => {
    const calls: MembershipCall[] = [];
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: "2026-01-01" },
      membershipOrgId: "org-1",
      calls,
    });
    mockAuthorization(["orders.read"], "CASHIER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");

    // Callers cannot influence the answer even when they try to pass one.
    const forged = {
      data: {
        organization_id: "org-victim",
        user_id: "user-victim",
        role: "OWNER",
        permissions: ["orders.refund", "team.remove"],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getActiveMemberCapabilitiesFn as any)(forged);

    expect(result).toEqual({
      status: "active",
      userId: "user-1",
      organizationId: "org-1",
      role: "CASHIER",
      permissions: ["orders.read"],
    });
    const membershipCall = calls.find((call) => call.table === "memberships");
    expect(membershipCall?.filters["user_id"]).toBe("user-1");
    expect(membershipCall?.filters["organization_id"]).toBeUndefined();
  });

  it("returns only keys the resolver granted — a role label grants nothing on its own", async () => {
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: "2026-01-01" },
      membershipOrgId: "org-1",
      calls: [],
    });
    mockAuthorization([], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    const result = await getActiveMemberCapabilitiesFn();

    expect(result).toEqual({
      status: "active",
      userId: "user-1",
      organizationId: "org-1",
      role: "OWNER",
      permissions: [],
    });
  });

  it("never echoes back a permission key outside the declared UI vocabulary", async () => {
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: "2026-01-01" },
      membershipOrgId: "org-1",
      calls: [],
    });
    // The resolver "grants" a privileged internal key the UI does not consult.
    mockAuthorization(["orders.read", "org.ownership_transfer"], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    const result = await getActiveMemberCapabilitiesFn();

    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("unreachable");
    expect(result.permissions).toEqual(["orders.read"]);
  });

  it("fails closed with no session", async () => {
    mockEnvironment({ user: null, membershipOrgId: "org-1", calls: [] });
    mockAuthorization(["orders.read"], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    expect(await getActiveMemberCapabilitiesFn()).toEqual({ status: "unauthenticated" });
  });

  it("fails closed for an unverified email, without reading membership", async () => {
    const calls: MembershipCall[] = [];
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: null },
      membershipOrgId: "org-1",
      calls,
    });
    mockAuthorization(["orders.read"], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    expect(await getActiveMemberCapabilitiesFn()).toEqual({ status: "email_unverified" });
    expect(calls.find((call) => call.table === "memberships")).toBeUndefined();
  });

  it("fails closed when the caller has no active membership", async () => {
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: "2026-01-01" },
      membershipOrgId: null,
      calls: [],
    });
    mockAuthorization(["orders.read"], "OWNER", "org-1");

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    expect(await getActiveMemberCapabilitiesFn()).toEqual({ status: "no_membership" });
  });

  it("fails closed — never an empty 'active' snapshot — when the resolver throws", async () => {
    mockEnvironment({
      user: { id: "user-1", email: "a@b.c", email_confirmed_at: "2026-01-01" },
      membershipOrgId: "org-1",
      calls: [],
    });
    mockAuthorizationThrows();

    const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
    expect(await getActiveMemberCapabilitiesFn()).toEqual({ status: "no_membership" });
  });
});
