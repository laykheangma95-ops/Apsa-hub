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
/** Optional post-processing of a response body (malformed-shape scenarios). */
let mutateResponse: ((rows: Row[]) => Row[]) | null = null;

const DB_ERROR = { code: "08006", message: "simulated database failure" };

// ── PostgREST emulation ───────────────────────────────────────────────────────
//
// The fake does NOT recognise the production select string. It interprets any
// select with PostgREST's grammar (`*`, columns, `alias:relation(...)`) against
// a relationship catalog that mirrors the real foreign keys (migrations 003 and
// 006). An unknown relationship is PGRST200, an unknown column 42703, exactly
// what hosted PostgREST returns. To-one embeds are an object or null, to-many
// embeds an array. roles→permissions is modelled as the many-to-many PostgREST
// infers through role_permissions, because hosted PostgREST accepts that
// shortcut too — the parser, not the database, has to reject that shape.

type Relationship =
  | { kind: "toOne"; target: keyof Db; localColumn: string }
  | { kind: "toMany"; target: keyof Db; foreignColumn: string }
  | {
      kind: "manyToMany";
      target: keyof Db;
      via: keyof Db;
      viaLocalColumn: string;
      viaTargetColumn: string;
    };

const SCHEMA: Record<keyof Db, { columns: string[]; relationships: Record<string, Relationship> }> =
  {
    memberships: {
      columns: ["id", "user_id", "organization_id", "role_id", "status", "joined_at", "invited_by"],
      // memberships.role_id → roles.id
      relationships: { roles: { kind: "toOne", target: "roles", localColumn: "role_id" } },
    },
    roles: {
      columns: ["id", "organization_id", "system_role", "name"],
      relationships: {
        // role_permissions.role_id → roles.id
        role_permissions: { kind: "toMany", target: "role_permissions", foreignColumn: "role_id" },
        memberships: { kind: "toMany", target: "memberships", foreignColumn: "role_id" },
        permissions: {
          kind: "manyToMany",
          target: "permissions",
          via: "role_permissions",
          viaLocalColumn: "role_id",
          viaTargetColumn: "permission_id",
        },
      },
    },
    role_permissions: {
      columns: ["role_id", "permission_id"],
      relationships: {
        // role_permissions.permission_id → permissions.id
        permissions: { kind: "toOne", target: "permissions", localColumn: "permission_id" },
        roles: { kind: "toOne", target: "roles", localColumn: "role_id" },
      },
    },
    permissions: {
      columns: ["id", "key"],
      relationships: {
        role_permissions: {
          kind: "toMany",
          target: "role_permissions",
          foreignColumn: "permission_id",
        },
      },
    },
  };

type SelectNode =
  | { kind: "star" }
  | { kind: "column"; name: string }
  | { kind: "embed"; alias: string; relation: string; children: SelectNode[] };

interface PgError {
  code: string;
  message: string;
}

function splitTopLevel(select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) throw { code: "PGRST100", message: "unbalanced parentheses" };
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (depth !== 0) throw { code: "PGRST100", message: "unbalanced parentheses" };
  parts.push(current.trim());
  return parts;
}

function parseSelect(select: string): SelectNode[] {
  return splitTopLevel(select).map((item): SelectNode => {
    if (item === "*") return { kind: "star" };
    if (/^\w+$/.test(item)) return { kind: "column", name: item };
    const embed = /^(?:(\w+):)?(\w+)\(([\s\S]*)\)$/.exec(item);
    if (!embed) throw { code: "PGRST100", message: `unparsable select item: ${item}` };
    const [, alias, relation, inner] = embed;
    return {
      kind: "embed",
      alias: alias ?? relation!,
      relation: relation!,
      children: parseSelect(inner!),
    };
  });
}

/** Validate a parsed select against the catalog; returns every table it touches. */
function validate(table: keyof Db, nodes: SelectNode[], touched: Set<string>): void {
  touched.add(table);
  for (const node of nodes) {
    if (node.kind === "column" && !SCHEMA[table].columns.includes(node.name)) {
      throw { code: "42703", message: `column ${table}.${node.name} does not exist` };
    }
    if (node.kind === "embed") {
      const rel = SCHEMA[table].relationships[node.relation];
      if (!rel) {
        throw {
          code: "PGRST200",
          message: `Could not find a relationship between '${table}' and '${node.relation}' in the schema cache`,
        };
      }
      if (rel.kind === "manyToMany") touched.add(rel.via);
      validate(rel.target, node.children, touched);
    }
  }
}

function project(table: keyof Db, row: Row, nodes: SelectNode[]): Row {
  const out: Row = {};
  for (const node of nodes) {
    if (node.kind === "star") Object.assign(out, row);
    else if (node.kind === "column") out[node.name] = row[node.name];
    else {
      const rel = SCHEMA[table].relationships[node.relation]!;
      if (rel.kind === "toOne") {
        const target = db[rel.target].find((r) => r["id"] === row[rel.localColumn]);
        out[node.alias] = target ? project(rel.target, target, node.children) : null;
      } else if (rel.kind === "toMany") {
        out[node.alias] = db[rel.target]
          .filter((r) => r[rel.foreignColumn] === row["id"])
          .map((r) => project(rel.target, r, node.children));
      } else {
        const ids = db[rel.via]
          .filter((v) => v[rel.viaLocalColumn] === row["id"])
          .map((v) => v[rel.viaTargetColumn]);
        out[node.alias] = db[rel.target]
          .filter((r) => ids.includes(r["id"]))
          .map((r) => project(rel.target, r, node.children));
      }
    }
  }
  return out;
}

/** Run one select the way PostgREST would. Exported to the fidelity tests below. */
function runSelect(
  table: keyof Db,
  select: string,
  filter: (row: Row) => boolean = () => true,
): { data: Row[] | null; error: PgError | null } {
  let nodes: SelectNode[];
  const touched = new Set<string>();
  try {
    nodes = parseSelect(select);
    validate(table, nodes, touched);
  } catch (e) {
    return { data: null, error: e as PgError };
  }
  // One statement: it fails as a whole when any table it reads fails.
  if ([...touched].some((t) => failTables.has(t))) return { data: null, error: DB_ERROR };
  const rows = db[table].filter(filter).map((r) => project(table, r, nodes));
  return { data: mutateResponse ? mutateResponse(rows) : rows, error: null };
}

function builder(table: keyof Db) {
  dbReads.push(table);
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let columns = "*";
  let orderBy: { column: string; ascending: boolean } | null = null;

  const execute = () => {
    const result = runSelect(
      table,
      columns,
      (row) => eqs.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c])),
    );
    if (result.error || !orderBy) return result;
    const { column, ascending } = orderBy;
    const data = [...result.data!].sort((a, b) =>
      String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : ascending ? 1 : -1,
    );
    return { data, error: null };
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
      if (!data || data.length !== 1) {
        return { data: null, error: { code: "PGRST116", message: "not single" } };
      }
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
const { verifyActiveMembership, MEMBERSHIP_CONTEXT_SELECT, toMembershipContext } =
  await import("@/server/auth/membership");
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
  mutateResponse = null;
});
afterEach(() => {
  failTables = new Set();
  mutateResponse = null;
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

  it("role / role_permissions / permissions read failure → no context", async () => {
    for (const table of ["roles", "role_permissions", "permissions"]) {
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

// ── Exact embedded relationship path ──────────────────────────────────────────

/** The select proven against PostgREST over the real schema (see PR #89). */
const PROVEN_SELECT = "*, role:roles(*, role_permissions(permission:permissions(key)))";

describe("exact embedded relationship path", () => {
  it("production uses exactly the proven select: memberships → roles → role_permissions → permissions", () => {
    expect(MEMBERSHIP_CONTEXT_SELECT).toBe(PROVEN_SELECT);
  });

  it("the proven select returns the shape PostgREST returns: role object, role_permissions array, {permission:{key}}", () => {
    const { data, error } = runSelect(
      "memberships",
      PROVEN_SELECT,
      (r) => r["user_id"] === U_OWNER,
    );
    expect(error).toBeNull();
    const role = data![0]!["role"] as Row;
    expect(Array.isArray(role)).toBe(false);
    expect(role["id"]).toBe(R_OWNER);
    expect(Array.isArray(role["role_permissions"])).toBe(true);
    const rp = (role["role_permissions"] as Row[])[0]!;
    expect(Object.keys(rp)).toEqual(["permission"]);
    expect(Object.keys(rp["permission"] as Row)).toEqual(["key"]);
  });

  it.each([
    [
      "wrong role_permissions relationship",
      "*, role:roles(*, role_permission(permission:permissions(key)))",
      "PGRST200",
    ],
    [
      "wrong permissions relationship",
      "*, role:roles(*, role_permissions(permission:permission(key)))",
      "PGRST200",
    ],
    [
      "wrong roles relationship",
      "*, role:role(*, role_permissions(permission:permissions(key)))",
      "PGRST200",
    ],
    ["permissions embedded one level too high", "*, role:roles(*), permissions(key)", "PGRST200"],
    [
      "role_permissions embedded on memberships",
      "*, role_permissions(permission:permissions(key))",
      "PGRST200",
    ],
    [
      "unknown permission column",
      "*, role:roles(*, role_permissions(permission:permissions(nokey)))",
      "42703",
    ],
    [
      "unbalanced parentheses",
      "*, role:roles(*, role_permissions(permission:permissions(key))",
      "PGRST100",
    ],
  ])("%s → %s, and production would get no context", (_label, select, code) => {
    const { data, error } = runSelect("memberships", select);
    expect(data).toBeNull();
    expect(error?.code).toBe(code);
  });

  it("wrong nesting depth PostgREST accepts (roles→permissions many-to-many) is rejected by the parser", () => {
    const { data, error } = runSelect(
      "memberships",
      "*, role:roles(*, permission:permissions(key))",
      (r) => r["user_id"] === U_OWNER,
    );
    expect(error).toBeNull(); // the database accepts it …
    expect(toMembershipContext(data![0] as never)).toBeNull(); // … the parser does not.
  });

  it("wrong aliases grant nothing", () => {
    for (const select of [
      "*, roles(*, role_permissions(permission:permissions(key)))", // no `role:` alias
      "*, role:roles(*, role_permissions(perm:permissions(key)))", // no `permission:` alias
      "*, role:roles(*, role_permissions(permissions(key)))",
    ]) {
      const { data, error } = runSelect("memberships", select, (r) => r["user_id"] === U_OWNER);
      expect(error, select).toBeNull();
      const ctx = toMembershipContext(data![0] as never);
      expect(ctx === null || ctx.permissions.size === 0, select).toBe(true);
    }
  });
});

// ── Malformed response shapes (full chain) ────────────────────────────────────

describe("malformed embedded response → fail closed", () => {
  const withRole = (fn: (role: Row | undefined, row: Row) => Row) => (rows: Row[]) =>
    rows.map((row) => fn(row["role"] as Row | undefined, row));

  it.each([
    ["missing role object", withRole((_role, { role: _drop, ...row }) => row)],
    ["role null", withRole((_role, row) => ({ ...row, role: null }))],
    ["role returned as an array", withRole((role, row) => ({ ...row, role: [role] }))],
    [
      "role for a different role id",
      withRole((role, row) => ({
        ...row,
        role: { ...role, id: R_OWNER === row["role_id"] ? R_CASHIER : R_OWNER },
      })),
    ],
    [
      "missing role_permissions",
      withRole(({ role_permissions: _d, ...role } = {}, row) => ({ ...row, role })),
    ],
    [
      "role_permissions null",
      withRole((role, row) => ({ ...row, role: { ...role, role_permissions: null } })),
    ],
    [
      "role_permissions an object",
      withRole((role, row) => ({
        ...row,
        role: { ...role, role_permissions: { permission: { key: "team.manage" } } },
      })),
    ],
  ])("%s → UnauthorizedError (401), nothing granted", async (_label, mutate) => {
    mutateResponse = mutate;
    for (const userId of [U_OWNER, U_MANAGER, U_CASHIER]) {
      const outcome = await chainOutcome(userId);
      expect(outcome, userId).toEqual({ ok: false, name: "UnauthorizedError", statusCode: 401 });
    }
  });

  it("a permission entry with no permission object / key / a non-string key grants exactly that entry nothing", async () => {
    mutateResponse = withRole((role, row) => ({
      ...row,
      role: {
        ...role,
        role_permissions: (role!["role_permissions"] as Array<{ permission: { key: string } }>).map(
          (rp) =>
            rp.permission.key === "team.manage"
              ? { permission: null }
              : rp.permission.key === "orders.refund"
                ? { permission: {} }
                : rp.permission.key === "inventory.adjust"
                  ? { permission: { key: 42 } }
                  : rp.permission.key === "payments.record"
                    ? {}
                    : rp,
        ),
      },
    }));
    const r = await newChain(U_OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const key of ["team.manage", "orders.refund", "inventory.adjust", "payments.record"]) {
      expect(r.ctx.permissions, key).not.toContain(key);
    }
    expect(r.ctx.permissions).toEqual([
      "orders.create",
      "orders.view",
      "products.read",
      "products.write",
    ]);
  });
});

// ── Error classification ──────────────────────────────────────────────────────

type Outcome = { ok: true } | { ok: false; name: string; statusCode: number | undefined };

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome & { message?: string }> {
  try {
    await runServerFnBoundary(META, run);
    return { ok: true };
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    return { ok: false, name: err.name, statusCode: err.statusCode };
  }
}

async function chainOutcome(userId: string): Promise<Outcome> {
  return outcomeOf(() => newChainBody(userId));
}

async function chainMessage(userId: string): Promise<string> {
  try {
    await runServerFnBoundary(META, () => newChainBody(userId));
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("error classification", () => {
  it("A. infrastructure failure while resolving the embedded context → sanitized InternalServerError 500, not 401", async () => {
    for (const table of ["memberships", "roles", "role_permissions", "permissions"]) {
      failTables = new Set([table]);
      for (const userId of [U_OWNER, U_CASHIER, U_MULTI]) {
        expect(await chainOutcome(userId), `${table}/${userId}`).toEqual({
          ok: false,
          name: "InternalServerError",
          statusCode: 500,
        });
        const message = await chainMessage(userId);
        expect(message).not.toContain("simulated database failure");
        expect(message).not.toContain(table);
      }
    }
  });

  it("A. (legacy for comparison) a roles/role_permissions failure used to surface as 401 / a context with no permissions", async () => {
    failTables = new Set(["roles"]);
    expect(await legacyChain(U_OWNER)).toEqual({ ok: false, error: "UnauthorizedError" });
    failTables = new Set(["permissions"]);
    const legacy = await legacyChain(U_OWNER);
    expect(legacy.ok && legacy.ctx.permissions).toEqual([]);
  });

  it("A'. verify-only path (forSlug / can / forRequest with nothing prefetched) keeps its legacy semantics: query failure → null → 401", async () => {
    failTables = new Set(["role_permissions"]);
    expect(await outcomeOf(() => AuthorizationService.forRequest(U_OWNER, ORG_A))).toEqual({
      ok: false,
      name: "UnauthorizedError",
      statusCode: 401,
    });
    expect(await AuthorizationService.can(U_OWNER, ORG_A, "orders.view")).toBe(false);
  });

  it("B. permissions relationship / query failure → fail closed, no permission granted anywhere", async () => {
    for (const table of ["role_permissions", "permissions"]) {
      failTables = new Set([table]);
      expect((await newChain(U_OWNER)).ok, table).toBe(false);
      expect(await verifyActiveMembership(U_OWNER, ORG_A), table).toBeNull();
      for (const key of PERMISSION_KEYS) {
        expect(await AuthorizationService.can(U_OWNER, ORG_A, key), `${table}/${key}`).toBe(false);
      }
    }
  });

  it("C. missing / suspended / removed membership → ForbiddenError 403 via the resolver; UnauthorizedError 401 via forRequest", async () => {
    for (const userId of [U_NONE, U_SUSPENDED, U_REMOVED]) {
      expect(await chainOutcome(userId), userId).toEqual({
        ok: false,
        name: "ForbiddenError",
        statusCode: 403,
      });
      expect(await outcomeOf(() => AuthorizationService.forRequest(userId, ORG_A)), userId).toEqual(
        {
          ok: false,
          name: "UnauthorizedError",
          statusCode: 401,
        },
      );
    }
    // Unchanged from the legacy chain.
    for (const userId of [U_NONE, U_SUSPENDED, U_REMOVED]) {
      expect(await legacyChain(userId)).toEqual({ ok: false, error: "ForbiddenError" });
    }
  });
});

// ── In-flight revocation window ───────────────────────────────────────────────

const REFUND_ID = "30000000-0000-4000-8000-000000000002";
const revokeManagerRefund = () => {
  db.role_permissions = db.role_permissions.filter(
    (rp) => !(rp["role_id"] === R_MANAGER && rp["permission_id"] === REFUND_ID),
  );
};

describe("in-flight revocation window (resolve → revoke → first forRequest)", () => {
  it("permission revoked between resolve and the first forRequest: THIS invocation still sees the resolve-time snapshot; the next invocation re-reads", async () => {
    const first = await runServerFnBoundary(META, async () => {
      const org = await resolveActiveOrganizationId(U_MANAGER);
      revokeManagerRefund(); // lands after the snapshot was read
      dbReads = [];
      const ctx = await AuthorizationService.forRequest(U_MANAGER, org!);
      expect(dbReads).toEqual([]); // consumed the snapshot, no re-read
      return ctx;
    });
    // Observed semantics: the snapshot is as of the resolve read, a few ms earlier
    // in the same invocation.
    expect(first.can("orders.refund")).toBe(true);

    dbReads = [];
    const next = await newChain(U_MANAGER);
    expect(dbReads).toEqual(["memberships"]);
    expect(next.ok && next.ctx.permissions.includes("orders.refund")).toBe(false);
  });

  it("membership suspended in the same window: this invocation proceeds on the snapshot; the next is denied", async () => {
    const first = await runServerFnBoundary(META, async () => {
      const org = await resolveActiveOrganizationId(U_MANAGER);
      db.memberships = db.memberships.map((m) =>
        m["user_id"] === U_MANAGER ? { ...m, status: "suspended" } : m,
      );
      return AuthorizationService.forRequest(U_MANAGER, org!);
    });
    expect(first.systemRole).toBe("MANAGER");
    expect(await chainOutcome(U_MANAGER)).toEqual({
      ok: false,
      name: "ForbiddenError",
      statusCode: 403,
    });
  });

  it("legacy had the same class of window, just shifted: a revocation after its permissions read is equally invisible to that invocation", async () => {
    const ctx = await legacyVerify(U_MANAGER, ORG_A);
    revokeManagerRefund();
    expect(ctx!.permissions).toContain("orders.refund");
  });
});

// ── Overlapping request contexts ──────────────────────────────────────────────

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("overlapping server-function calls never cross-consume", () => {
  it("different users: A and B both park, then verify in reverse order — each gets its own context, zero extra reads", async () => {
    const aParked = gate();
    const bParked = gate();
    const aGo = gate();
    const reads: Record<string, number> = {};
    const call = (userId: string, parked: ReturnType<typeof gate>, go: Promise<void>) =>
      runServerFnBoundary(META, async () => {
        const org = await resolveActiveOrganizationId(userId);
        parked.open();
        await go;
        const before = dbReads.length;
        const ctx = await AuthorizationService.forRequest(userId, org!);
        reads[userId] = dbReads.length - before;
        return ctx;
      });
    const pA = call(U_OWNER, aParked, aGo.opened);
    const pB = call(
      U_CASHIER,
      bParked,
      Promise.all([aParked.opened, bParked.opened]).then(() => {}),
    );
    await Promise.all([aParked.opened, bParked.opened]);
    const b = await pB; // B consumes first …
    aGo.open();
    const a = await pA; // … which must not affect A's parked context.
    expect(snapshot(a)).toMatchObject({
      userId: U_OWNER,
      organizationId: ORG_A,
      systemRole: "OWNER",
    });
    expect(snapshot(b)).toMatchObject({
      userId: U_CASHIER,
      organizationId: ORG_A,
      systemRole: "CASHIER",
    });
    expect(b.can("team.manage")).toBe(false);
    expect(a.can("team.manage")).toBe(true);
    expect(reads).toEqual({ [U_OWNER]: 0, [U_CASHIER]: 0 });
  });

  it("different orgs, same user: a concurrent call for org A cannot consume the call that parked org B", async () => {
    const parked = gate();
    const done = gate();
    const pB = runServerFnBoundary(META, async () => {
      const org = await resolveActiveOrganizationId(U_MULTI); // B (owner)
      parked.open();
      await done.opened;
      const before = dbReads.length;
      const ctx = await AuthorizationService.forRequest(U_MULTI, org!);
      return { ctx, reads: dbReads.length - before };
    });
    await parked.opened;
    const a = await runServerFnBoundary(META, async () => {
      const before = dbReads.length;
      const ctx = await AuthorizationService.forRequest(U_MULTI, ORG_A);
      return { ctx, reads: dbReads.length - before };
    });
    done.open();
    const b = await pB;
    expect(a.reads).toBe(1); // nothing parked in its own context → reads the DB
    expect(snapshot(a.ctx)).toMatchObject({ organizationId: ORG_A, systemRole: "CASHIER" });
    expect(a.ctx.can("team.manage")).toBe(false);
    expect(b.reads).toBe(0); // its own parked context is intact
    expect(snapshot(b.ctx)).toMatchObject({ organizationId: ORG_B, systemRole: "OWNER" });
  });

  it("many interleaved calls across users and orgs: every result matches its own legacy chain", async () => {
    const users = [U_OWNER, U_MANAGER, U_CASHIER, U_MULTI, U_B_OWNER, U_SUSPENDED, U_NONE];
    const expected = await Promise.all(users.map((u) => legacyChain(u)));
    const results = await Promise.all(
      [...users, ...users.slice().reverse()].map(async (u) => ({ u, r: await newChain(u) })),
    );
    for (const { u, r } of results) expect(r, u).toEqual(expected[users.indexOf(u)]!);
  });
});
