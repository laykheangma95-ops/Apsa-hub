/**
 * Perf instrumentation — behavior is unchanged with the flag ON or OFF.
 *
 * Isolated runtime file (spawned by perf-instrumentation.test.ts) because
 * bun:test's mock.module mutates the shared module cache for the whole process.
 *
 * Every scenario runs the REAL auth chain (getSessionFn, checkAppGuardFn,
 * resolveActiveOrganizationId, verifyActiveMembership, AuthorizationService)
 * over a mocked Supabase, once with APSA_PERF_INSTRUMENTATION unset and once
 * with it set to "true", inside the real server-function boundary, and asserts:
 *   - identical results / identical errors in both modes;
 *   - no perf line at all when OFF;
 *   - exactly one perf line per call when ON, carrying no PII, no IDs, no
 *     tokens and no error text.
 *
 * Run: bun test src/tests/perf-instrumentation.runtime.ts
 */
import { afterEach, describe, expect, it, mock } from "bun:test";

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

const USER_ID = "11111111-2222-3333-4444-555555555555";
const ORG_ID = "99999999-8888-7777-6666-555555555555";
const ROLE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EMAIL = "merchant.owner@example.com";
const ACCESS = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyIn0", "c2lnbmF0dXJlc2lnbmF0dXJl"].join(
  ".",
);
const REFRESH = "refresh-token-value-abcdef";
const DB_ERROR_TEXT = 'relation "memberships" violates constraint for merchant.owner@example.com';

interface World {
  cookies: boolean;
  userValid: boolean;
  emailVerified: boolean;
  refreshOk: boolean;
  guardRows: Array<{ organization_id: string; status: string; joined_at: string }>;
  guardError: boolean;
  activeOrgError: boolean;
  membershipRow: Record<string, unknown> | null;
  roleRow: Record<string, unknown> | null;
  rolePermissionsError: boolean;
  permissionKeys: string[];
}

function defaultWorld(): World {
  return {
    cookies: true,
    userValid: true,
    emailVerified: true,
    refreshOk: false,
    guardRows: [{ organization_id: ORG_ID, status: "active", joined_at: "2026-01-01T00:00:00Z" }],
    guardError: false,
    activeOrgError: false,
    membershipRow: {
      id: "m1",
      user_id: USER_ID,
      organization_id: ORG_ID,
      role_id: ROLE_ID,
      status: "active",
    },
    roleRow: { id: ROLE_ID, system_role: "CASHIER", organization_id: null },
    rolePermissionsError: false,
    permissionKeys: ["orders.view", "orders.create"],
  };
}

let world = defaultWorld();
let cookieWrites: string[] = [];
let cookieDeletes: string[] = [];

const user = () => ({
  id: USER_ID,
  email: EMAIL,
  email_confirmed_at: world.emailVerified ? "2026-01-01T00:00:00.000Z" : null,
});

function tableResult(table: string, filters: Record<string, unknown>) {
  if (table === "memberships") {
    // The guard reads with .in("status", …); the resolver with .eq("status","active");
    // verifyActiveMembership adds .eq("organization_id", …) and .single().
    if ("organization_id" in filters) {
      return world.membershipRow
        ? { data: world.membershipRow, error: null }
        : { data: null, error: { message: DB_ERROR_TEXT } };
    }
    if (filters["status"] === "active") {
      if (world.activeOrgError) return { data: null, error: { message: DB_ERROR_TEXT } };
      return { data: world.guardRows.filter((r) => r.status === "active"), error: null };
    }
    if (world.guardError) return { data: null, error: { message: DB_ERROR_TEXT } };
    return { data: world.guardRows, error: null };
  }
  if (table === "roles") {
    return world.roleRow
      ? { data: world.roleRow, error: null }
      : { data: null, error: { message: DB_ERROR_TEXT } };
  }
  if (table === "role_permissions") {
    if (world.rolePermissionsError) return { data: null, error: { message: DB_ERROR_TEXT } };
    return {
      data: world.permissionKeys.map((_, i) => ({ permission_id: `p${i}` })),
      error: null,
    };
  }
  if (table === "permissions") {
    return { data: world.permissionKeys.map((key) => ({ key })), error: null };
  }
  return { data: null, error: { message: "unknown table" } };
}

function builder(table: string) {
  const filters: Record<string, unknown> = {};
  const b = {
    select: () => b,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return b;
    },
    in: (column: string, value: unknown) => {
      filters[`${column}:in`] = value;
      return b;
    },
    order: () => b,
    single: async () => tableResult(table, filters),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(tableResult(table, filters)).then(resolve, reject),
  };
  return b;
}

mock.module("@tanstack/react-start", () => ({ createServerFn: createServerFnMock() }));
mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) =>
    world.cookies ? (name === "sb-access-token" ? ACCESS : REFRESH) : undefined,
  setCookie: (name: string) => cookieWrites.push(name),
  deleteCookie: (name: string) => cookieDeletes.push(name),
}));
mock.module("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () =>
        world.userValid
          ? { data: { user: user() }, error: null }
          : { data: { user: null }, error: new Error("expired") },
    },
  }),
  createRefreshClient: () => ({
    auth: {
      refreshSession: async () =>
        world.refreshOk
          ? {
              data: {
                session: { access_token: ACCESS, refresh_token: REFRESH, user: user() },
              },
              error: null,
            }
          : { data: { session: null }, error: new Error("expired") },
    },
  }),
  supabaseAdmin: { from: (table: string) => builder(table) },
}));

const { getSessionFn } = await import("@/api/auth");
const { checkAppGuardFn } = await import("@/api/app-guard");
const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
const { verifyActiveMembership } = await import("@/server/auth/membership");
const { AuthorizationService, ForbiddenError, UnauthorizedError } =
  await import("@/server/auth/authorization");
const { runServerFnBoundary } = await import("@/server/observability/server-fn-boundary");
const { setLogSink } = await import("@/server/observability/logger");

/** The resolveAuthContext shape every src/api/*.ts file uses. */
async function orderListHandler() {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) throw new UnauthorizedError("Not authenticated");
  const organizationId = await resolveActiveOrganizationId(session.userId);
  if (!organizationId) throw new ForbiddenError("No active organization membership");
  const authCtx = await AuthorizationService.forRequest(session.userId, organizationId);
  authCtx.require("orders.view");
  return {
    organizationId: authCtx.organizationId,
    permissions: [...authCtx.permissions].sort(),
    orders: [{ code: "A-1" }],
  };
}

type Outcome = { ok: true; value: unknown } | { ok: false; name: string; message: string };

/** Run under the real boundary with the flag in the given state. */
async function run(
  flag: boolean,
  meta: { name: string; filename: string },
  fn: () => Promise<unknown>,
): Promise<{ outcome: Outcome; lines: string[]; error?: unknown }> {
  if (flag) {
    process.env["APSA_PERF_INSTRUMENTATION"] = "true";
    process.env["APSA_RUNTIME_ENV"] = "staging";
  } else {
    delete process.env["APSA_PERF_INSTRUMENTATION"];
    delete process.env["APSA_RUNTIME_ENV"];
  }
  cookieWrites = [];
  cookieDeletes = [];
  const lines: string[] = [];
  const restore = setLogSink((_level, line) => lines.push(line));
  try {
    const value = await runServerFnBoundary(meta, fn);
    return { outcome: { ok: true, value }, lines };
  } catch (error) {
    const e = error as Error;
    // The support reference is a fresh random ID per call; compare the rest.
    const message = e.message.replace(/req_[0-9a-f]{20}/g, "req_X");
    return { outcome: { ok: false, name: e.name, message }, lines, error };
  } finally {
    restore();
    delete process.env["APSA_PERF_INSTRUMENTATION"];
    delete process.env["APSA_RUNTIME_ENV"];
  }
}

const perfLines = (lines: string[]) =>
  lines.filter((l) => (JSON.parse(l) as { event: string }).event === "perf.server_function");

function assertCleanPerfLine(line: string) {
  for (const forbidden of [USER_ID, ORG_ID, ROLE_ID, EMAIL, ACCESS, REFRESH, "violates", "SQL"]) {
    expect(line).not.toContain(forbidden);
  }
  const record = JSON.parse(line) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    expect(value, key).not.toBe("[REDACTED]");
  }
  expect(Object.keys(record).sort()).not.toContain("userId");
  expect(Object.keys(record).sort()).not.toContain("organizationId");
}

async function compare(
  meta: { name: string; filename: string },
  fn: () => Promise<unknown>,
): Promise<{ on: Awaited<ReturnType<typeof run>>; off: Awaited<ReturnType<typeof run>> }> {
  const off = await run(false, meta, fn);
  const offWrites = [...cookieWrites];
  const offDeletes = [...cookieDeletes];
  const on = await run(true, meta, fn);
  expect(on.outcome).toEqual(off.outcome);
  expect(cookieWrites).toEqual(offWrites);
  expect(cookieDeletes).toEqual(offDeletes);
  expect(perfLines(off.lines)).toEqual([]);
  // Every non-perf line is identical in shape (IDs/timestamps aside).
  const shape = (lines: string[]) =>
    lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["event"] !== "perf.server_function")
      .map((r) => ({ level: r["level"], event: r["event"], errorClass: r["errorClass"] }));
  expect(shape(on.lines)).toEqual(shape(off.lines));
  const perf = perfLines(on.lines);
  expect(perf).toHaveLength(1);
  assertCleanPerfLine(perf[0]!);
  return { on, off };
}

const ORDERS = { name: "listOrdersFn", filename: "src/api/orders.ts" };
const GUARD = { name: "checkAppGuardFn", filename: "src/api/app-guard.ts" };

afterEach(() => {
  world = defaultWorld();
  delete process.env["APSA_PERF_INSTRUMENTATION"];
  delete process.env["APSA_RUNTIME_ENV"];
});

describe("authorization chain: identical with instrumentation on and off", () => {
  it("allowed request: same value, one perf line with every phase", async () => {
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toEqual({
      ok: true,
      value: {
        organizationId: ORG_ID,
        permissions: ["orders.create", "orders.view"],
        orders: [{ code: "A-1" }],
      },
    });
    const record = JSON.parse(perfLines(on.lines)[0]!) as Record<string, unknown>;
    expect(record["route"]).toBe("orders.listOrdersFn");
    expect(record["outcome"]).toBe("ok");
    for (const field of [
      "identityMs",
      "getUserMs",
      "activeOrgMs",
      "membershipMs",
      "membershipRowMs",
      "rolesMs",
      "rolePermissionsMs",
      "permissionsMs",
      "authzMs",
      "queryMs",
      "totalMs",
    ]) {
      expect(typeof record[field], field).toBe("number");
    }
    expect(record["refreshMs"]).toBeUndefined();
    expect(typeof record["requestId"]).toBe("string");
  });

  it("missing permission: same ForbiddenError", async () => {
    world.permissionKeys = ["customers.view"];
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "ForbiddenError" });
    expect(on.error).toBeInstanceOf(ForbiddenError);
    expect(JSON.parse(perfLines(on.lines)[0]!)["outcome"]).toBe("error");
  });

  it("no membership row: same UnauthorizedError", async () => {
    world.membershipRow = null;
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "UnauthorizedError" });
  });

  it("role lookup failure: same fail-closed result", async () => {
    world.roleRow = null;
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "UnauthorizedError" });
  });

  it("role_permissions failure: same fail-closed result", async () => {
    world.rolePermissionsError = true;
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "UnauthorizedError" });
  });

  it("no active organization: same ForbiddenError", async () => {
    world.guardRows = [];
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "ForbiddenError" });
  });

  it("unauthenticated: same UnauthorizedError", async () => {
    world.cookies = false;
    const { on } = await compare(ORDERS, orderListHandler);
    expect(on.outcome).toMatchObject({ ok: false, name: "UnauthorizedError" });
  });

  it("database error: same sanitized public error, no DB text in any line", async () => {
    world.activeOrgError = true;
    const { on, off } = await compare(ORDERS, orderListHandler);
    expect(on.outcome.ok).toBe(false);
    if (!on.outcome.ok) {
      expect(on.outcome.message).not.toContain("violates");
      expect(on.outcome.message).not.toContain(EMAIL);
    }
    for (const line of [...on.lines, ...off.lines]) expect(line).not.toContain(EMAIL);
  });

  it("verifyActiveMembership returns the same context directly (outside a boundary)", async () => {
    const off = await verifyActiveMembership(USER_ID, ORG_ID);
    process.env["APSA_PERF_INSTRUMENTATION"] = "true";
    process.env["APSA_RUNTIME_ENV"] = "staging";
    const on = await verifyActiveMembership(USER_ID, ORG_ID);
    expect(on).toEqual(off);
    expect([...(on?.permissions ?? [])].sort()).toEqual(["orders.create", "orders.view"]);
  });
});

describe("session + /app guard: identical with instrumentation on and off", () => {
  it("active member → ok with the same organization", async () => {
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toMatchObject({ ok: true, value: { ok: true, organizationId: ORG_ID } });
    const record = JSON.parse(perfLines(on.lines)[0]!) as Record<string, unknown>;
    expect(record["route"]).toBe("app-guard.checkAppGuardFn");
    expect(typeof record["guardMembershipsMs"]).toBe("number");
    expect(typeof record["identityMs"]).toBe("number");
  });

  it("no session → /sign-in", async () => {
    world.cookies = false;
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toEqual({ ok: true, value: { ok: false, redirect: "/sign-in" } });
  });

  it("unverified email → /verify-email", async () => {
    world.emailVerified = false;
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toEqual({ ok: true, value: { ok: false, redirect: "/verify-email" } });
  });

  it("no membership → /onboarding", async () => {
    world.guardRows = [];
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toEqual({ ok: true, value: { ok: false, redirect: "/onboarding" } });
  });

  it("suspended membership → /access-denied and the same cookie clearing", async () => {
    world.guardRows = [{ organization_id: ORG_ID, status: "suspended", joined_at: "2026-01-01" }];
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toEqual({ ok: true, value: { ok: false, redirect: "/access-denied" } });
  });

  it("guard membership read failure → same sanitized error", async () => {
    world.guardError = true;
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome.ok).toBe(false);
  });

  it("expired access token → same refresh result and cookie writes, refresh timed", async () => {
    world.userValid = false;
    world.refreshOk = true;
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toMatchObject({ ok: true, value: { ok: true } });
    const record = JSON.parse(perfLines(on.lines)[0]!) as Record<string, unknown>;
    expect(typeof record["refreshMs"]).toBe("number");
  });

  it("failed refresh → same null session and cookie deletion", async () => {
    world.userValid = false;
    world.refreshOk = false;
    const { on } = await compare(GUARD, () => checkAppGuardFn());
    expect(on.outcome).toEqual({ ok: true, value: { ok: false, redirect: "/sign-in" } });
  });
});
