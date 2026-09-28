/**
 * Multi-organization canonical resolution — behavioral runtime checks.
 *
 * Isolated runtime file (spawned by multi-org-resolution.test.ts): bun:test's
 * mock.module mutates the shared module cache for the whole process.
 *
 * The schema lets one user hold memberships in several organizations. V1 has
 * no switcher, so every principal-scoped path must pick the SAME organization.
 * The /app guard, Home and Analytics once picked joined_at ASC while
 * capabilities, Customers and every other domain API picked joined_at DESC —
 * a user in two organizations saw Home for one and edited customers in the
 * other.
 *
 * The fake `memberships` table below honours the ORDER direction and LIMIT a
 * caller asks for, so a path that drifts back to ASC (or to "first active
 * row" over unordered rows) resolves Org A instead of Org B and fails here.
 *
 * Run: bun test src/tests/multi-org-resolution.runtime.ts
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // joined first — OWNER
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // joined later — CASHIER
const ORG_C = "cccccccc-0000-4000-8000-00000000000c"; // joined last — suspended

interface Row {
  user_id: string;
  organization_id: string;
  status: string;
  joined_at: string;
}

let membershipTable: Row[] = [];

/** Different grants per organization, so a wrong-org pick is observable. */
const PERMISSIONS_BY_ORG: Record<string, string[]> = {
  [ORG_A]: ["customers.read", "customers.view_sensitive", "analytics.read", "orders.read"],
  [ORG_B]: ["customers.read", "orders.read"],
  [ORG_C]: ["customers.read", "customers.view_sensitive", "analytics.read"],
};

/** Every organization an AuthorizationContext was built for, in call order. */
const forRequestCalls: string[] = [];

function createServerFnMock() {
  return () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler(handler: (args: { data: unknown }) => unknown) {
          return async (args?: { data?: unknown }) => handler({ data: validator(args?.data) });
        },
      };
    },
    handler(handler: () => unknown) {
      return handler;
    },
  });
}

/** A PostgREST-shaped builder over `membershipTable` that honours order + limit. */
function membershipsQuery() {
  const filters: Array<(row: Row) => boolean> = [];
  const orders: Array<{ column: keyof Row; ascending: boolean }> = [];
  let limit: number | null = null;

  const run = () => {
    let rows = membershipTable.filter((row) => filters.every((f) => f(row)));
    if (orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of orders) {
          if (a[column] === b[column]) continue;
          const cmp = a[column] < b[column] ? -1 : 1;
          return ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (limit !== null) rows = rows.slice(0, limit);
    return rows.map((row) => ({ ...row }));
  };

  const builder = {
    select: () => builder,
    eq: (column: keyof Row, value: string) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in: (column: keyof Row, values: string[]) => {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    order: (column: keyof Row, opts?: { ascending?: boolean }) => {
      orders.push({ column, ascending: opts?.ascending ?? true });
      return builder;
    },
    limit: (n: number) => {
      limit = n;
      return builder;
    },
    single: async () => {
      const rows = run();
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(resolve),
  };
  return builder;
}

mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => (name === "sb-access-token" ? "access" : "refresh"),
  setCookie: () => undefined,
  deleteCookie: () => undefined,
}));
mock.module("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: USER, email: "m@example.com", email_confirmed_at: "2026-01-01" } },
        error: null,
      }),
    },
  }),
  createRefreshClient: () => ({
    auth: { refreshSession: async () => ({ data: { session: null }, error: new Error("x") }) },
  }),
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "memberships") throw new Error(`unexpected table: ${table}`);
      return membershipsQuery();
    },
  },
}));

class ForbiddenError extends Error {}
class UnauthorizedError extends Error {}
mock.module("@/server/auth/authorization", () => ({
  ForbiddenError,
  UnauthorizedError,
  AuthorizationService: {
    forRequest: async (userId: string, organizationId: string) => {
      forRequestCalls.push(organizationId);
      const granted = PERMISSIONS_BY_ORG[organizationId] ?? [];
      return {
        userId,
        organizationId,
        systemRole: organizationId === ORG_A ? "OWNER" : "CASHIER",
        can: (key: string) => granted.includes(key),
      };
    },
  },
}));

// Domain services echo the organization the API resolved, and nothing else.
type Ctx = { organizationId: string };
mock.module("@/server/home/service", () => ({
  getHomeSummary: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
}));
mock.module("@/server/analytics/service", () => ({
  getBusinessSummary: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
  getTopSellingItems: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
  getCustomerSummary: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
}));
mock.module("@/server/customers/service", () => ({
  listCustomers: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
  searchCustomers: async (ctx: Ctx) => ({ organizationId: ctx.organizationId }),
}));

process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

const { checkAppGuardFn } = await import("@/api/app-guard");
const { getActiveMemberCapabilitiesFn } = await import("@/api/capabilities");
const { getHomeSummaryFn } = await import("@/api/home");
const { getBusinessSummaryFn, getTopSellingItemsFn, getCustomerSummaryFn } =
  await import("@/api/analytics");
const { listCustomersFn, searchCustomersFn } = await import("@/api/customers");
const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
const { pickCanonicalActiveMembership } = await import("@/lib/active-organization");
const { createCapabilityView, capabilityQueryKey } = await import("@/lib/capabilities");
const { customerKeys, enforceCustomerCachePrincipal } = await import("@/lib/customers-query");
const { analyticsKeys } = await import("@/lib/analytics-query");
const { homeQueryKey } = await import("@/lib/home-query");

function row(organizationId: string, joinedAt: string, status = "active"): Row {
  return { user_id: USER, organization_id: organizationId, status, joined_at: joinedAt };
}

/** Every principal-scoped path the V1 shell uses, resolved for the same user. */
async function resolveEveryPath() {
  forRequestCalls.length = 0;
  const guard = await checkAppGuardFn();
  if (!guard.ok) throw new Error(`guard redirected to ${guard.redirect}`);
  const capabilities = await getActiveMemberCapabilitiesFn();
  if (capabilities.status !== "active") throw new Error(`capabilities: ${capabilities.status}`);

  const range = { data: { range: "today" as const } };
  const home = (await getHomeSummaryFn(range)) as unknown as Ctx;
  const summary = (await getBusinessSummaryFn(range)) as unknown as Ctx;
  const top = (await getTopSellingItemsFn(range)) as unknown as Ctx;
  const cohort = (await getCustomerSummaryFn(range)) as unknown as Ctx;
  const customers = (await listCustomersFn({ data: {} })) as unknown as Ctx;
  const search = (await searchCustomersFn({ data: { query: "so" } })) as unknown as Ctx;
  const resolver = await resolveActiveOrganizationId(USER);

  return {
    guard: guard.organizationId,
    capabilities: capabilities.organizationId,
    home: home.organizationId,
    analyticsSummary: summary.organizationId,
    analyticsTopSellers: top.organizationId,
    analyticsCustomers: cohort.organizationId,
    customersList: customers.organizationId,
    customersSearch: search.organizationId,
    resolver,
    capabilitiesSnapshot: capabilities,
  };
}

function expectAllEqual(paths: Awaited<ReturnType<typeof resolveEveryPath>>, org: string) {
  const { capabilitiesSnapshot: _snapshot, ...orgs } = paths;
  for (const [path, resolved] of Object.entries(orgs)) {
    expect({ path, resolved }).toEqual({ path, resolved: org });
  }
  // Every AuthorizationContext was built for that same organization.
  expect(new Set(forRequestCalls)).toEqual(new Set([org]));
}

beforeEach(() => {
  membershipTable = [];
});

describe("canonical organization — one pick across every principal-scoped path", () => {
  it("a member of Org A (older) and Org B (newer) resolves Org B everywhere", async () => {
    membershipTable = [
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
    ];
    expectAllEqual(await resolveEveryPath(), ORG_B);
  });

  it("is independent of physical row order", async () => {
    membershipTable = [
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
    ];
    expectAllEqual(await resolveEveryPath(), ORG_B);
  });

  it("follows joined_at, not organization id, when the older membership has the larger id", async () => {
    membershipTable = [
      row(ORG_B, "2025-01-01T00:00:00.000Z"),
      row(ORG_A, "2026-03-01T00:00:00.000Z"),
    ];
    expectAllEqual(await resolveEveryPath(), ORG_A);
  });

  it("breaks an exact joined_at tie deterministically (organization_id DESC) on every path", async () => {
    const same = "2026-03-01T00:00:00.000Z";
    membershipTable = [row(ORG_B, same), row(ORG_A, same)];
    expectAllEqual(await resolveEveryPath(), ORG_B);
    membershipTable = [row(ORG_A, same), row(ORG_B, same)];
    expectAllEqual(await resolveEveryPath(), ORG_B);
  });

  it("never picks a newer suspended membership", async () => {
    membershipTable = [
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
      row(ORG_C, "2026-06-01T00:00:00.000Z", "suspended"),
    ];
    expectAllEqual(await resolveEveryPath(), ORG_B);
  });

  it("capabilities describe the canonical organization's grants, not another membership's", async () => {
    membershipTable = [
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
    ];
    const { capabilitiesSnapshot } = await resolveEveryPath();
    if (capabilitiesSnapshot.status !== "active") throw new Error("unreachable");
    // Org B is CASHIER-like: no view_sensitive, no analytics — Org A's OWNER
    // grants must not leak into the snapshot.
    expect(capabilitiesSnapshot.role).toBe("CASHIER");
    expect(capabilitiesSnapshot.permissions).not.toContain("customers.view_sensitive");
    expect(capabilitiesSnapshot.permissions).not.toContain("analytics.read");
  });
});

describe("cache partition follows the same canonical organization", () => {
  it("the capability view is 'ready' only because guard and snapshot agree on the org", async () => {
    membershipTable = [
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
    ];
    const paths = await resolveEveryPath();

    // The shell keys every cache on the guard's organization. The capability
    // view refuses a snapshot for any other organization — divergence would
    // surface as "denied" here and as an empty, permission-less shell.
    const view = createCapabilityView({
      result: paths.capabilitiesSnapshot,
      isPending: false,
      isError: false,
      expectedUserId: USER,
      expectedOrganizationId: paths.guard,
    });
    expect(view.state).toBe("ready");
    expect(view.organizationId).toBe(ORG_B);
    expect(view.can("customers.view_sensitive")).toBe(false);

    // Every cache key the shell builds carries that same organization.
    const keys = [
      capabilityQueryKey(USER, paths.guard),
      customerKeys.directory(USER, paths.guard),
      customerKeys.detail(USER, paths.guard, "c1"),
      analyticsKeys.summary(USER, paths.guard, "today"),
      homeQueryKey(USER, paths.guard, "today"),
    ];
    for (const key of keys) {
      expect(key).toContain(ORG_B);
      expect(key).not.toContain(ORG_A);
    }

    // And a customer entry cached for the other membership is evicted the
    // moment the shell enforces the canonical principal.
    const queryClient = new QueryClient();
    queryClient.setQueryData(customerKeys.directory(USER, ORG_A), { pages: [] });
    enforceCustomerCachePrincipal(queryClient, USER, ORG_A);
    enforceCustomerCachePrincipal(queryClient, USER, paths.guard);
    expect(queryClient.getQueryData(customerKeys.directory(USER, ORG_A))).toBeUndefined();
  });
});

describe("pickCanonicalActiveMembership — the rule itself", () => {
  it("returns null with no active membership", () => {
    expect(pickCanonicalActiveMembership([row(ORG_A, "2026-01-01T00:00:00Z", "removed")])).toBe(
      null,
    );
    expect(pickCanonicalActiveMembership([])).toBe(null);
  });

  it("is order-independent for every permutation", () => {
    const rows = [
      row(ORG_A, "2025-01-01T00:00:00.000Z"),
      row(ORG_B, "2026-03-01T00:00:00.000Z"),
      row(ORG_C, "2026-06-01T00:00:00.000Z", "suspended"),
    ];
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of perms) {
      const picked = pickCanonicalActiveMembership(p.map((i) => rows[i]!));
      expect(picked?.organization_id).toBe(ORG_B);
    }
  });
});
