/**
 * Authorization context collapse — identical security semantics, fewer reads.
 *
 * Isolated runtime file (spawned by authz-context-collapse.test.ts) because
 * bun:test's mock.module mutates the shared module cache for the whole process.
 *
 * An in-memory multi-organization database (memberships, roles,
 * role_permissions, permissions) sits behind a fake supabaseAdmin that
 * understands the PostgREST embedded select the new path uses. Every scenario
 * runs BOTH:
 *   - LEGACY: a verbatim copy of the former resolver chain (active-org read,
 *     then memberships → roles → role_permissions → permissions), and
 *   - NEW:    the real resolveActiveOrganizationId + AuthorizationService,
 * and asserts the same allow/deny outcome, the same organization, the same
 * role and the same permission set — and counts the database round trips.
 *
 * Run: bun test ./src/tests/authz-context-collapse.runtime.ts
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ── In-memory database ────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

const U_OWNER = "10000000-0000-4000-8000-000000000001";
const U_MANAGER = "10000000-0000-4000-8000-000000000002";
const U_CASHIER = "10000000-0000-4000-8000-000000000003";
const U_MULTI = "10000000-0000-4000-8000-000000000004"; // cashier in A, owner in B
const U_SUSPENDED = "10000000-0000-4000-8000-000000000005";
const U_REMOVED = "10000000-0000-4000-8000-000000000006";
const U_NONE = "10000000-0000-4000-8000-000000000007";
const U_B_OWNER = "10000000-0000-4000-8000-000000000008";
const USERS = [U_OWNER, U_MANAGER, U_CASHIER, U_MULTI, U_SUSPENDED, U_REMOVED, U_NONE, U_B_OWNER];

const R_OWNER = "20000000-0000-4000-8000-000000000001";
const R_MANAGER = "20000000-0000-4000-8000-000000000002";
const R_CASHIER = "20000000-0000-4000-8000-000000000003";

const PERMISSION_KEYS = [
  "orders.view",
  "orders.create",
  "orders.refund",
  "products.read",
  "products.write",
  "inventory.adjust",
  "payments.record",
  "team.manage",
];

type Row = Record<string, unknown>;
interface Db {
  memberships: Row[];
  roles: Row[];
  role_permissions: Row[];
  permissions: Row[];
}

function seed(): Db {
  const permissions = PERMISSION_KEYS.map((key, i) => ({
    id: `30000000-0000-4000-8000-00000000000${i}`,
    key,
  }));
  const pid = (key: string) => permissions.find((p) => p.key === key)!.id;
  const grant = (roleId: string, keys: string[]) =>
    keys.map((k) => ({ role_id: roleId, permission_id: pid(k) }));
  const membership = (
    n: number,
    userId: string,
    orgId: string,
    roleId: string,
    status: string,
    joinedAt: string,
  ) => ({
    id: `40000000-0000-4000-8000-00000000000${n}`,
    user_id: userId,
    organization_id: orgId,
    role_id: roleId,
    status,
    joined_at: joinedAt,
    invited_by: null,
  });
  return {
    permissions,
    roles: [
      { id: R_OWNER, organization_id: null, system_role: "OWNER", name: "Owner" },
      { id: R_MANAGER, organization_id: null, system_role: "MANAGER", name: "Manager" },
      { id: R_CASHIER, organization_id: null, system_role: "CASHIER", name: "Cashier" },
    ],
    role_permissions: [
      ...grant(R_OWNER, PERMISSION_KEYS),
      ...grant(R_MANAGER, [
        "orders.view",
        "orders.create",
        "orders.refund",
        "products.read",
        "products.write",
        "inventory.adjust",
        "payments.record",
      ]),
      ...grant(R_CASHIER, ["orders.view", "orders.create", "products.read", "payments.record"]),
    ],
    memberships: [
      membership(1, U_OWNER, ORG_A, R_OWNER, "active", "2026-01-01T00:00:00Z"),
      membership(2, U_MANAGER, ORG_A, R_MANAGER, "active", "2026-01-02T00:00:00Z"),
      membership(3, U_CASHIER, ORG_A, R_CASHIER, "active", "2026-01-03T00:00:00Z"),
      membership(4, U_MULTI, ORG_A, R_CASHIER, "active", "2026-01-04T00:00:00Z"),
      membership(5, U_MULTI, ORG_B, R_OWNER, "active", "2026-02-01T00:00:00Z"),
      membership(6, U_SUSPENDED, ORG_A, R_CASHIER, "suspended", "2026-01-05T00:00:00Z"),
      membership(7, U_REMOVED, ORG_A, R_MANAGER, "removed", "2026-01-06T00:00:00Z"),
      membership(8, U_B_OWNER, ORG_B, R_OWNER, "active", "2026-01-07T00:00:00Z"),
    ],
  };
}

let db = seed();
let failTables = new Set<string>();
/** Every supabaseAdmin.from(table) call, in order — one per DB round trip. */
let dbReads: string[] = [];

const DB_ERROR = { message: "simulated database failure" };

function embedAuthority(membership: Row): Row {
  const role = db.roles.find((r) => r["id"] === membership["role_id"]);
  if (!role) return { ...membership, role: null };
  const rolePermissions = db.role_permissions
    .filter((rp) => rp["role_id"] === role["id"])
    .map((rp) => {
      const p = db.permissions.find((perm) => perm["id"] === rp["permission_id"]);
      return { permission: p ? { key: p["key"] } : null };
    });
  return { ...membership, role: { ...role, role_permissions: rolePermissions } };
}

function builder(table: keyof Db) {
  dbReads.push(table);
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let columns = "*";
  let orderBy: { column: string; ascending: boolean } | null = null;

  const execute = () => {
    if (failTables.has(table)) return { data: null, error: DB_ERROR };
    const embedded = table === "memberships" && columns.includes("role:roles(");
    if (embedded && (failTables.has("roles") || failTables.has("role_permissions"))) {
      // One embedded select fails as a whole when any joined relation fails.
      return { data: null, error: DB_ERROR };
    }
    let rows = db[table].filter(
      (row) => eqs.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c])),
    );
    if (orderBy) {
      const { column, ascending } = orderBy;
      rows = [...rows].sort((a, b) =>
        String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : ascending ? 1 : -1,
      );
    }
    let out: Row[] = rows.map((r) => ({ ...r }));
    if (embedded) out = out.map(embedAuthority);
    else if (columns !== "*") {
      const keep = columns.split(",").map((c) => c.trim());
      out = out.map((r) => Object.fromEntries(keep.map((k) => [k, r[k]])));
    }
    return { data: out, error: null };
  };

  const b = {
    select: (cols: string) => {
      columns = cols;
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqs.push([column, value]);
      return b;
    },
    in: (column: string, values: unknown[]) => {
      ins.push([column, values]);
      return b;
    },
    order: (column: string, opts: { ascending: boolean }) => {
      orderBy = { column, ascending: opts.ascending };
      return b;
    },
    single: async () => {
      const { data, error } = execute();
      if (error) return { data: null, error };
      if (!data || data.length !== 1) return { data: null, error: { message: "not single" } };
      return { data: data[0], error: null };
    },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject),
  };
  return b;
}

const supabaseAdmin = { from: (table: keyof Db) => builder(table) };
mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin,
  createServerClient: () => {
    throw new Error("not used");
  },
  createRefreshClient: () => {
    throw new Error("not used");
  },
}));

const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
const { verifyActiveMembership } = await import("@/server/auth/membership");
const { AuthorizationService, ForbiddenError, UnauthorizedError } =
  await import("@/server/auth/authorization");
const { runServerFnBoundary } = await import("@/server/observability/server-fn-boundary");
const { pickCanonicalActiveMembership, CANONICAL_MEMBERSHIP_ORDER } =
  await import("@/lib/active-organization");
const { setLogSink } = await import("@/server/observability/logger");
// Rejections are logged by the boundary; they are expected here.
setLogSink(() => {});

// ── LEGACY reference: the former chain, verbatim in its queries ───────────────

interface Snapshot {
  organizationId: string;
  userId: string;
  roleId: string;
  systemRole: unknown;
  permissions: string[];
}

async function legacyVerify(userId: string, organizationId: string): Promise<Snapshot | null> {
  const { data: m, error } = await supabaseAdmin
    .from("memberships")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .single();
  if (error || !m) return null;
  const membership = m as Row;
  const { data: r, error: roleError } = await supabaseAdmin
    .from("roles")
    .select("*")
    .eq("id", membership["role_id"])
    .single();
  if (roleError || !r) return null;
  const role = r as Row;
  const { data: rps, error: rpError } = (await supabaseAdmin
    .from("role_permissions")
    .select("permission_id")
    .eq("role_id", role["id"])) as { data: Row[] | null; error: unknown };
  if (rpError) return null;
  const ids = (rps ?? []).map((rp) => rp["permission_id"]);
  let keys: string[] = [];
  if (ids.length > 0) {
    const { data: perms } = (await supabaseAdmin
      .from("permissions")
      .select("key")
      .in("id", ids)) as { data: Row[] | null };
    keys = (perms ?? []).map((p) => p["key"] as string);
  }
  return {
    organizationId: membership["organization_id"] as string,
    userId: membership["user_id"] as string,
    roleId: membership["role_id"] as string,
    systemRole: role["system_role"],
    permissions: [...new Set(keys)].sort(),
  };
}

type ChainResult = { ok: true; ctx: Snapshot } | { ok: false; error: string };

async function legacyChain(userId: string): Promise<ChainResult> {
  const { data, error } = (await supabaseAdmin
    .from("memberships")
    .select("organization_id, status, joined_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order(CANONICAL_MEMBERSHIP_ORDER.column, {
      ascending: CANONICAL_MEMBERSHIP_ORDER.ascending,
    })) as {
    data: Array<{ organization_id: string; status: string; joined_at: string }> | null;
    error: unknown;
  };
  if (error) return { ok: false, error: "Error" };
  const picked = pickCanonicalActiveMembership(data ?? []);
  if (!picked) return { ok: false, error: "ForbiddenError" };
  const ctx = await legacyVerify(userId, picked.organization_id);
  return ctx ? { ok: true, ctx } : { ok: false, error: "UnauthorizedError" };
}

// ── NEW path: the real modules, inside a real server-function boundary ────────

const META = { name: "listProductsFn", filename: "src/api/products.ts" };

function snapshot(authCtx: {
  organizationId: string;
  userId: string;
  roleId: string;
  systemRole: unknown;
  permissions: Set<string>;
}): Snapshot {
  return {
    organizationId: authCtx.organizationId,
    userId: authCtx.userId,
    roleId: authCtx.roleId,
    systemRole: authCtx.systemRole,
    permissions: [...authCtx.permissions].sort(),
  };
}

/** The resolveAuthContext shape every src/api/*.ts helper uses. */
async function newChainBody(userId: string) {
  const organizationId = await resolveActiveOrganizationId(userId);
  if (!organizationId) throw new ForbiddenError("No active organization membership");
  return AuthorizationService.forRequest(userId, organizationId);
}

async function newChain(userId: string): Promise<ChainResult> {
  try {
    const authCtx = await runServerFnBoundary(META, () => newChainBody(userId));
    return { ok: true, ctx: snapshot(authCtx) };
  } catch (e) {
    const name = (e as Error).name;
    return {
      ok: false,
      error: name === "ForbiddenError" || name === "UnauthorizedError" ? name : "Error",
    };
  }
}

async function newVerify(userId: string, orgId: string): Promise<Snapshot | null> {
  const ctx = await verifyActiveMembership(userId, orgId);
  if (!ctx) return null;
  return {
    organizationId: ctx.membership.organization_id,
    userId: ctx.membership.user_id,
    roleId: ctx.membership.role_id,
    systemRole: ctx.role.system_role,
    permissions: [...ctx.permissions].sort(),
  };
}

beforeEach(() => {
  db = seed();
  failTables = new Set();
  dbReads = [];
});
afterEach(() => {
  failTables = new Set();
});

// ── Equivalence ───────────────────────────────────────────────────────────────

describe("new path ≡ legacy path", () => {
  it("verifyActiveMembership: identical for every user × organization", async () => {
    for (const userId of USERS) {
      for (const orgId of [ORG_A, ORG_B, "ffffffff-0000-4000-8000-000000000099"]) {
        expect(await newVerify(userId, orgId), `${userId}@${orgId}`).toEqual(
          await legacyVerify(userId, orgId),
        );
      }
    }
  });

  it("full chain (resolve active org → forRequest): identical for every user", async () => {
    for (const userId of USERS) {
      expect(await newChain(userId), userId).toEqual(await legacyChain(userId));
    }
  });
});

// ── Role semantics ────────────────────────────────────────────────────────────

describe("owner / manager / cashier distinctions are unchanged", () => {
  const can = async (userId: string, key: string) => {
    const r = await newChain(userId);
    return r.ok && r.ctx.permissions.includes(key);
  };

  it("owner: everything, including team.manage", async () => {
    const r = await newChain(U_OWNER);
    expect(r).toMatchObject({ ok: true, ctx: { organizationId: ORG_A, systemRole: "OWNER" } });
    for (const key of PERMISSION_KEYS) expect(await can(U_OWNER, key), key).toBe(true);
  });

  it("manager: refund + product write allowed, team.manage denied", async () => {
    expect(await can(U_MANAGER, "orders.refund")).toBe(true);
    expect(await can(U_MANAGER, "products.write")).toBe(true);
    expect(await can(U_MANAGER, "team.manage")).toBe(false);
  });

  it("cashier: orders.view/products.read allowed; refund, product write, stock adjust denied", async () => {
    expect(await can(U_CASHIER, "orders.view")).toBe(true);
    expect(await can(U_CASHIER, "products.read")).toBe(true);
    for (const key of ["orders.refund", "products.write", "inventory.adjust", "team.manage"]) {
      expect(await can(U_CASHIER, key), key).toBe(false);
    }
  });

  it("require() throws ForbiddenError for a missing capability", async () => {
    const ctx = await runServerFnBoundary(META, () => newChainBody(U_CASHIER));
    expect(() => ctx.require("orders.refund")).toThrow(ForbiddenError);
    expect(() => ctx.requireOwner()).toThrow(ForbiddenError);
  });
});

// ── Denials ───────────────────────────────────────────────────────────────────

describe("fails closed", () => {
  it("suspended membership → denied", async () => {
    expect(await newChain(U_SUSPENDED)).toEqual({ ok: false, error: "ForbiddenError" });
    expect(await verifyActiveMembership(U_SUSPENDED, ORG_A)).toBeNull();
  });

  it("removed membership → denied", async () => {
    expect(await newChain(U_REMOVED)).toEqual({ ok: false, error: "ForbiddenError" });
    expect(await verifyActiveMembership(U_REMOVED, ORG_A)).toBeNull();
  });

  it("user with no organization → denied", async () => {
    expect(await newChain(U_NONE)).toEqual({ ok: false, error: "ForbiddenError" });
  });

  it("wrong organization → UnauthorizedError (no cross-org access)", async () => {
    await expect(AuthorizationService.forRequest(U_CASHIER, ORG_B)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(AuthorizationService.forRequest(U_B_OWNER, ORG_A)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("wrong organization right after resolving: the parked context is NOT used", async () => {
    await expect(
      runServerFnBoundary(META, async () => {
        const org = await resolveActiveOrganizationId(U_CASHIER);
        expect(org).toBe(ORG_A);
        return AuthorizationService.forRequest(U_CASHIER, ORG_B);
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("another user right after resolving: the parked context is NOT used", async () => {
    const ctx = await runServerFnBoundary(META, async () => {
      await resolveActiveOrganizationId(U_OWNER);
      dbReads = [];
      return AuthorizationService.forRequest(U_CASHIER, ORG_A);
    });
    expect(dbReads).toEqual(["memberships"]);
    expect(snapshot(ctx)).toMatchObject({ userId: U_CASHIER, systemRole: "CASHIER" });
    expect(ctx.can("team.manage")).toBe(false);
  });

  it("dangling role → denied", async () => {
    db.roles = db.roles.filter((r) => r["id"] !== R_CASHIER);
    expect(await newChain(U_CASHIER)).toEqual({ ok: false, error: "UnauthorizedError" });
    expect(await newChain(U_CASHIER)).toEqual(await legacyChain(U_CASHIER));
  });

  it("membership read failure → error, never a context", async () => {
    failTables.add("memberships");
    expect(await newChain(U_OWNER)).toEqual({ ok: false, error: "Error" });
    expect(await verifyActiveMembership(U_OWNER, ORG_A)).toBeNull();
  });

  it("role / role_permissions read failure → no context", async () => {
    for (const table of ["roles", "role_permissions"]) {
      failTables = new Set([table]);
      expect((await newChain(U_OWNER)).ok, table).toBe(false);
      expect(await verifyActiveMembership(U_OWNER, ORG_A), table).toBeNull();
    }
  });

  it("empty user id → denied", async () => {
    expect(await newChain("")).toEqual({ ok: false, error: "ForbiddenError" });
    await expect(AuthorizationService.forRequest("", ORG_A)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

// ── Org switching, revocation, no carry-over ─────────────────────────────────

describe("freshness", () => {
  it("org switching resolves the new organization's role, with no permission leakage", async () => {
    // Newest active membership wins: owner of B.
    expect(await newChain(U_MULTI)).toMatchObject({
      ok: true,
      ctx: { organizationId: ORG_B, systemRole: "OWNER" },
    });
    // Leaves B: the next call resolves A as CASHIER — none of B's owner rights.
    db.memberships = db.memberships.map((m) =>
      m["user_id"] === U_MULTI && m["organization_id"] === ORG_B
        ? { ...m, status: "suspended" }
        : m,
    );
    const r = await newChain(U_MULTI);
    expect(r).toMatchObject({ ok: true, ctx: { organizationId: ORG_A, systemRole: "CASHIER" } });
    if (r.ok) {
      expect(r.ctx.permissions).not.toContain("team.manage");
      expect(r.ctx.permissions).not.toContain("orders.refund");
    }
    expect(r).toEqual(await legacyChain(U_MULTI));
  });

  it("permission revocation takes effect on the very next call", async () => {
    let r = await newChain(U_MANAGER);
    expect(r.ok && r.ctx.permissions.includes("orders.refund")).toBe(true);
    db.role_permissions = db.role_permissions.filter(
      (rp) =>
        !(
          rp["role_id"] === R_MANAGER &&
          rp["permission_id"] === "30000000-0000-4000-8000-000000000002"
        ),
    );
    r = await newChain(U_MANAGER);
    expect(r.ok && r.ctx.permissions.includes("orders.refund")).toBe(false);
  });

  it("membership suspension takes effect on the very next call", async () => {
    expect((await newChain(U_MANAGER)).ok).toBe(true);
    db.memberships = db.memberships.map((m) =>
      m["user_id"] === U_MANAGER ? { ...m, status: "suspended" } : m,
    );
    expect(await newChain(U_MANAGER)).toEqual({ ok: false, error: "ForbiddenError" });
  });

  it("the parked context is single-use: a second verify in the same call re-reads the DB", async () => {
    await runServerFnBoundary(META, async () => {
      const org = await resolveActiveOrganizationId(U_MANAGER);
      const first = await AuthorizationService.forRequest(U_MANAGER, org!);
      expect(first.can("orders.refund")).toBe(true);
      // Revoked mid-call (e.g. by a role change this very call made).
      db.role_permissions = db.role_permissions.filter(
        (rp) =>
          !(
            rp["role_id"] === R_MANAGER &&
            rp["permission_id"] === "30000000-0000-4000-8000-000000000002"
          ),
      );
      dbReads = [];
      const second = await AuthorizationService.forRequest(U_MANAGER, org!);
      expect(dbReads).toEqual(["memberships"]);
      expect(second.can("orders.refund")).toBe(false);
    });
  });

  it("nothing carries over between server-function calls", async () => {
    await runServerFnBoundary(META, () => resolveActiveOrganizationId(U_OWNER));
    dbReads = [];
    const ctx = await runServerFnBoundary(META, () =>
      AuthorizationService.forRequest(U_OWNER, ORG_A),
    );
    expect(dbReads).toEqual(["memberships"]);
    expect(ctx.isOwner()).toBe(true);
  });

  it("outside a server-function boundary nothing is parked", async () => {
    await resolveActiveOrganizationId(U_OWNER);
    dbReads = [];
    await verifyActiveMembership(U_OWNER, ORG_A);
    expect(dbReads).toEqual(["memberships"]);
  });
});

// ── Round trips ───────────────────────────────────────────────────────────────

describe("database round trips per authorized call", () => {
  it("BEFORE: 5 sequential reads (memberships ×2, roles, role_permissions, permissions)", async () => {
    dbReads = [];
    expect((await legacyChain(U_OWNER)).ok).toBe(true);
    expect(dbReads).toEqual([
      "memberships",
      "memberships",
      "roles",
      "role_permissions",
      "permissions",
    ]);
  });

  it("AFTER: 1 read (memberships with role + permissions embedded)", async () => {
    dbReads = [];
    expect((await newChain(U_OWNER)).ok).toBe(true);
    expect(dbReads).toEqual(["memberships"]);
  });

  it("AFTER, verify alone (forSlug / can / direct callers): 1 read instead of 4", async () => {
    dbReads = [];
    expect(await AuthorizationService.can(U_CASHIER, ORG_A, "orders.view")).toBe(true);
    expect(dbReads).toEqual(["memberships"]);
  });
});
