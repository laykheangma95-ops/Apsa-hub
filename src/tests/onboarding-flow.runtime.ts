/**
 * Founder onboarding runtime tests.
 *
 * Exercises createOrganizationFn end-to-end against mocked transport, and
 * asserts the structural invariants of the /onboarding route.
 *
 * Covered:
 *   1. Successful organization creation via the RPC
 *   2. slug_taken (RPC status, and a raw PostgreSQL 23505 escaping the RPC)
 *   3. Unverified user denied — RPC never called
 *   4. Unauthenticated user denied — RPC never called
 *   5. RPC/backend failure returns a real error, never a fake success
 *   6. Successful creation redirects to /app
 *
 * Run indirectly: bun test src/tests/onboarding-flow.test.ts
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

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

type MockUser = {
  id: string;
  email: string;
  email_confirmed_at: string | null;
};

type RpcCall = { fn: string; params: Record<string, unknown> };

const requestCookies = new Map<string, string>();
const deleteCookieCalls: string[] = [];
const rpcCalls: RpcCall[] = [];
const tableReads: string[] = [];
const serverClientTokens: Array<string | undefined> = [];

let currentUser: MockUser;
let rpcResult: unknown;
let rpcError: { message?: string; code?: string } | null;

const ONBOARDING_ROUTE = path.resolve(process.cwd(), "src/routes/onboarding.tsx");
const routeCode = fs.readFileSync(ONBOARDING_ROUTE, "utf-8");

function resetScenario() {
  requestCookies.clear();
  requestCookies.set("sb-access-token", "access-token");
  requestCookies.set("sb-refresh-token", "refresh-token");
  deleteCookieCalls.length = 0;
  rpcCalls.length = 0;
  tableReads.length = 0;
  serverClientTokens.length = 0;

  currentUser = {
    id: "founder-1",
    email: "founder@example.com",
    email_confirmed_at: "2026-09-04T00:00:00.000Z",
  };

  rpcResult = { status: "success", org_id: "org-9", slug: "angkor-coffee" };
  rpcError = null;
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: createServerFnMock(),
}));

mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => requestCookies.get(name),
  setCookie: () => {},
  deleteCookie: (name: string) => {
    requestCookies.delete(name);
    deleteCookieCalls.push(name);
  },
}));

mock.module("@/lib/supabase/server", () => ({
  createServerClient: (accessToken?: string) => {
    serverClientTokens.push(accessToken);
    return {
      auth: {
        getUser: async () =>
          requestCookies.get("sb-access-token")
            ? { data: { user: currentUser }, error: null }
            : { data: { user: null }, error: { message: "missing access token" } },
      },
      // Any table read from the organization creation path would be a slug
      // pre-check — recorded so the test can assert it never happens.
      from: (table: string) => {
        tableReads.push(table);
        throw new Error(`unexpected table read: ${table}`);
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        return { data: rpcError ? null : rpcResult, error: rpcError };
      },
    };
  },
  createRefreshClient: () => ({
    auth: {
      refreshSession: async () => ({
        data: { session: null },
        error: { message: "refresh not used" },
      }),
    },
  }),
  supabaseAdmin: {
    from: (table: string) => {
      tableReads.push(table);
      return {
        select: () => ({
          eq: () => ({ in: () => ({ order: async () => ({ data: [], error: null }) }) }),
        }),
      };
    },
  },
}));

process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

const { createOrganizationFn } = await import("@/api/org");

const VALID_INPUT = {
  legalName: "Angkor Coffee",
  displayName: "Angkor Coffee",
  slug: "angkor-coffee",
};

beforeEach(() => {
  resetScenario();
});

// ── 1. Successful organization creation ───────────────────────────────────────

describe("successful organization creation", () => {
  it("creates the organization through the create_organization_for_founder RPC", async () => {
    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: true, orgId: "org-9", slug: "angkor-coffee" });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.fn).toBe("create_organization_for_founder");
  });

  it("passes exactly the RPC parameter contract and never a founder user id", async () => {
    await createOrganizationFn({ data: VALID_INPUT });

    expect(rpcCalls[0]!.params).toEqual({
      p_legal_name: "Angkor Coffee",
      p_display_name: "Angkor Coffee",
      p_slug: "angkor-coffee",
      p_business_type: null,
      p_currency: "USD",
    });
    expect(Object.keys(rpcCalls[0]!.params)).not.toContain("p_founder_user_id");
  });

  it("calls the RPC under the founder's own JWT, not the service role", async () => {
    await createOrganizationFn({ data: VALID_INPUT });

    expect(serverClientTokens).toContain("access-token");
  });

  it("performs no slug availability pre-check before the RPC", async () => {
    await createOrganizationFn({ data: VALID_INPUT });

    expect(tableReads).toEqual([]);
  });

  it("rejects an organization_id supplied by the client", async () => {
    await expect(
      createOrganizationFn({
        data: { ...VALID_INPUT, organizationId: "org-belonging-to-someone-else" } as never,
      }),
    ).resolves.toEqual({ ok: true, orgId: "org-9", slug: "angkor-coffee" });

    // The client-supplied id is stripped by the validator and never forwarded.
    expect(JSON.stringify(rpcCalls[0]!.params)).not.toContain("org-belonging-to-someone-else");
  });
});

// ── 2. slug_taken ─────────────────────────────────────────────────────────────

describe("slug conflict", () => {
  it("returns slug_taken when the RPC reports the slug is claimed", async () => {
    rpcResult = { status: "slug_taken" };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: false, code: "slug_taken" });
  });

  it("maps a raw PostgreSQL 23505 unique violation to slug_taken", async () => {
    rpcError = { code: "23505", message: "duplicate key value violates unique constraint" };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: false, code: "slug_taken" });
  });

  it("surfaces a friendly slug_taken message on the onboarding form", () => {
    expect(routeCode).toMatch(/case "slug_taken":/);
    expect(routeCode).toMatch(/onboarding\.errors\.slugTaken/);
  });
});

// ── 3. Unverified user denied ─────────────────────────────────────────────────

describe("unverified user", () => {
  it("is denied with email_not_verified and the RPC is never called", async () => {
    currentUser = { ...currentUser, email_confirmed_at: null };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: false, code: "email_not_verified" });
    expect(rpcCalls).toHaveLength(0);
  });
});

// ── 4. Unauthenticated user denied ────────────────────────────────────────────

describe("unauthenticated user", () => {
  it("is denied with unauthenticated and the RPC is never called", async () => {
    requestCookies.clear();

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: false, code: "unauthenticated" });
    expect(rpcCalls).toHaveLength(0);
  });
});

// ── 5. RPC failure returns a real error ───────────────────────────────────────

describe("backend failure", () => {
  it("returns internal_error with the real message, never a fake success", async () => {
    rpcError = { message: "connection to database failed" };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({
      ok: false,
      code: "internal_error",
      message: "connection to database failed",
    });
  });

  it("returns unauthenticated when the RPC itself rejects an anonymous caller", async () => {
    rpcError = { message: "unauthenticated: auth.uid() is null" };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({ ok: false, code: "unauthenticated" });
  });

  it("returns invalid_input when the DB check constraint rejects the payload", async () => {
    rpcResult = { status: "invalid_input", detail: "organizations_slug_format" };

    const result = await createOrganizationFn({ data: VALID_INPUT });

    expect(result).toEqual({
      ok: false,
      code: "invalid_input",
      detail: "organizations_slug_format",
    });
  });

  it("rejects a malformed slug before any request is made", async () => {
    await expect(
      createOrganizationFn({ data: { ...VALID_INPUT, slug: "-bad-" } }),
    ).rejects.toThrow();

    expect(rpcCalls).toHaveLength(0);
  });
});

// ── 6. Successful redirect to /app ────────────────────────────────────────────

describe("onboarding route", () => {
  it("no longer renders the placeholder", () => {
    expect(routeCode).not.toMatch(/coming soon/i);
  });

  it("submits through the server function, never a direct client insert", () => {
    expect(routeCode).toMatch(/createOrganizationFn/);
    expect(routeCode).not.toMatch(/\.rpc\(/);
    expect(routeCode).not.toMatch(/@\/lib\/supabase\/client/);
    expect(routeCode).not.toMatch(/\.insert\(/);
    expect(routeCode).not.toMatch(/supabaseAdmin/);
  });

  it("redirects to /app after a successful creation", () => {
    expect(routeCode).toMatch(/if \(result\.ok\) \{\s*\n\s*await navigate\(\{ to: "\/app" \}\);/);
  });

  it("guards the page server-side in beforeLoad, not in an effect", () => {
    expect(routeCode).toMatch(/beforeLoad/);
    expect(routeCode).toMatch(/checkAppGuardFn/);
    expect(routeCode).not.toMatch(/useEffect/);
  });

  it("sends founders who already have an organization straight to /app", () => {
    expect(routeCode).toMatch(/if \(result\.ok\) throw redirect\(\{ to: "\/app" \}\);/);
  });

  it("prevents double submit and shows loading + error state", () => {
    expect(routeCode).toMatch(/if \(submitting\) return;/);
    expect(routeCode).toMatch(/disabled=\{submitting\}/);
    expect(routeCode).toMatch(/aria-busy=\{submitting\}/);
    expect(routeCode).toMatch(/role="alert"/);
  });

  it("uses i18n keys for every user-facing string", () => {
    expect(routeCode).toMatch(/useTranslation/);
    expect(routeCode).toMatch(/t\("onboarding\.title"\)/);
    expect(routeCode).toMatch(/t\("onboarding\.submit"\)/);
  });

  it("performs no slug availability lookup in the browser", () => {
    expect(routeCode).not.toMatch(/slugAvailable|checkSlug|isSlugTaken/i);
  });
});

// ── Locale coverage ───────────────────────────────────────────────────────────

describe("localization", () => {
  const en = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "src/locales/en.json"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
  const km = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "src/locales/km.json"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;

  it("defines the onboarding namespace in both English and Khmer", () => {
    expect(en["onboarding"]).toBeDefined();
    expect(km["onboarding"]).toBeDefined();
  });

  it("has identical key shapes in both locales", () => {
    const flatten = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
            flatten(child, prefix ? `${prefix}.${key}` : key),
          )
        : [prefix];

    expect(flatten(km["onboarding"]).sort()).toEqual(flatten(en["onboarding"]).sort());
  });
});
