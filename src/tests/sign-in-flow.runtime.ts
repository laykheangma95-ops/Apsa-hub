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

type MembershipRow = {
  organization_id: string;
  status: "active" | "suspended" | "removed";
  created_at: string;
};

type MockError = { status?: number; message?: string } | null;

const cookieStore = new Map<string, string>();
const setCookieCalls: string[] = [];
const deleteCookieCalls: string[] = [];

let currentUser: MockUser;
let membershipRows: MembershipRow[];
let membershipError: MockError;
let signInError: MockError;
let refreshError: MockError;

function resetScenario() {
  cookieStore.clear();
  setCookieCalls.length = 0;
  deleteCookieCalls.length = 0;

  currentUser = {
    id: "user-1",
    email: "owner@example.com",
    email_confirmed_at: "2026-09-04T00:00:00.000Z",
  };

  membershipRows = [
    {
      organization_id: "org-1",
      status: "active",
      created_at: "2026-09-04T00:00:00.000Z",
    },
  ];

  membershipError = null;
  signInError = null;
  refreshError = { message: "refresh not used" };
}

function makeSession() {
  return {
    access_token: "access-token",
    refresh_token: "refresh-token",
    user: currentUser,
  };
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: createServerFnMock(),
}));

mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => cookieStore.get(name),
  setCookie: (name: string, value: string) => {
    cookieStore.set(name, value);
    setCookieCalls.push(name);
  },
  deleteCookie: (name: string) => {
    cookieStore.delete(name);
    deleteCookieCalls.push(name);
  },
}));

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { session: signInError ? null : makeSession(), user: currentUser },
        error: signInError,
      }),
      signUp: async () => ({ data: { session: null }, error: null }),
      verifyOtp: async () => ({ data: { session: makeSession() }, error: null }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

mock.module("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: cookieStore.get("sb-access-token") ? currentUser : null },
        error: cookieStore.get("sb-access-token") ? null : { message: "missing access token" },
      }),
    },
  }),
  createRefreshClient: () => ({
    auth: {
      refreshSession: async () => ({
        data: { session: null },
        error: refreshError,
      }),
    },
  }),
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            order: async () => ({
              data: membershipRows,
              error: membershipError,
            }),
          }),
        }),
      }),
    }),
  },
}));

process.env["VITE_SUPABASE_URL"] = "https://apsa.test.supabase.co";
process.env["VITE_SUPABASE_ANON_KEY"] = "anon-test-key";

const authModule = await import("@/api/auth");
const appGuardModule = await import("@/api/app-guard");

const {
  COOKIE_ACCESS_TOKEN,
  COOKIE_REFRESH_TOKEN,
  signInFn,
} = authModule;
const { checkAppGuardFn } = appGuardModule;

beforeEach(() => {
  resetScenario();
});

describe("sign-in flow runtime", () => {
  it("signs in a verified user with an active membership and redirects to /app", async () => {
    const result = await signInFn({
      data: { email: "owner@example.com", password: "secret123" },
    });

    expect(result).toEqual({ ok: true, redirectTo: "/app" });
    expect(setCookieCalls).toEqual([COOKIE_ACCESS_TOKEN, COOKIE_REFRESH_TOKEN]);
    expect(cookieStore.get(COOKIE_ACCESS_TOKEN)).toBe("access-token");
    expect(cookieStore.get(COOKIE_REFRESH_TOKEN)).toBe("refresh-token");
    expect(deleteCookieCalls).toHaveLength(0);
  });

  it("redirects a verified user with no memberships to /onboarding", async () => {
    membershipRows = [];

    const result = await signInFn({
      data: { email: "owner@example.com", password: "secret123" },
    });

    expect(result).toEqual({ ok: true, redirectTo: "/onboarding" });
  });

  it("redirects an unverified user to /verify-email", async () => {
    currentUser = {
      ...currentUser,
      email_confirmed_at: null,
    };

    const result = await signInFn({
      data: { email: "owner@example.com", password: "secret123" },
    });

    expect(result).toEqual({ ok: true, redirectTo: "/verify-email" });
  });

  it("keeps invalid credentials on the sign-in page with a real error", async () => {
    signInError = { status: 400, message: "Invalid login credentials" };

    const result = await signInFn({
      data: { email: "owner@example.com", password: "wrong-password" },
    });

    expect(result).toEqual({ ok: false, code: "invalid_credentials" });
    expect(setCookieCalls).toHaveLength(0);
  });

  it("clears auth cookies before redirecting revoked members to /access-denied", async () => {
    membershipRows = [
      {
        organization_id: "org-1",
        status: "removed",
        created_at: "2026-09-04T00:00:00.000Z",
      },
    ];

    const result = await signInFn({
      data: { email: "owner@example.com", password: "secret123" },
    });

    expect(result).toEqual({ ok: true, redirectTo: "/access-denied" });
    expect(deleteCookieCalls).toEqual([COOKIE_ACCESS_TOKEN, COOKIE_REFRESH_TOKEN]);
    expect(cookieStore.has(COOKIE_ACCESS_TOKEN)).toBe(false);
    expect(cookieStore.has(COOKIE_REFRESH_TOKEN)).toBe(false);
  });

  it("clears auth cookies before the /app guard redirects revoked members to /access-denied", async () => {
    membershipRows = [
      {
        organization_id: "org-1",
        status: "suspended",
        created_at: "2026-09-04T00:00:00.000Z",
      },
    ];
    cookieStore.set(COOKIE_ACCESS_TOKEN, "access-token");
    cookieStore.set(COOKIE_REFRESH_TOKEN, "refresh-token");

    const result = await checkAppGuardFn();

    expect(result).toEqual({ ok: false, redirect: "/access-denied" });
    expect(deleteCookieCalls).toEqual([COOKIE_ACCESS_TOKEN, COOKIE_REFRESH_TOKEN]);
  });

  it("removes the placeholder handler and guards against client-only submission bugs", () => {
    const routeCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/sign-in.tsx"),
      "utf-8",
    );

    expect(routeCode).not.toMatch(/coming soon/i);
    expect(routeCode).toMatch(/signInFn/);
    expect(routeCode).not.toMatch(/signInWithPassword/);
    expect(routeCode).not.toMatch(/@\/lib\/supabase\/client/);
    expect(routeCode).toMatch(/if \(loading\) return;/);
    expect(routeCode).toMatch(/disabled=\{loading\}/);
    expect(routeCode).toMatch(/className="w-full"/);
  });
});
