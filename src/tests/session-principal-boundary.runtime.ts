/**
 * The real session → principal → authorization boundary for protected
 * mutations (CORRECTION-004, PR #121).
 *
 * The native financial suites construct an AuthorizationContext directly, so
 * they never exercise how the server DERIVES the principal it compares
 * `expectedPrincipal` with. This suite runs that derivation for real:
 *
 *   cookie session → session provider user → email verified
 *     → canonical active organization (newest active membership, real SQL)
 *     → active membership + role + permission keys (real SQL)
 *     → AuthorizationService.forRequest → AuthorizationContext
 *     → assertExpectedPrincipal (first statement of the service)
 *     → permission → rate limit → reads → RPC → audit
 *
 * What is REAL (unmodified repository code):
 *   - createOrderFn and recordPaymentFn: their zod validators, handlers and
 *     each file's own resolveAuthContext (src/api/orders.ts, src/api/payments.ts);
 *   - getSessionFn / readCookieSession / buildSessionResult (src/api/auth.ts),
 *     including the refresh path and the cookie clearing on a dead session;
 *   - resolveActiveOrganizationId, the request-local membership prefetch,
 *     verifyActiveMembership, toMembershipContext, AuthorizationService and
 *     AuthorizationContext (src/server/auth/*);
 *   - assertExpectedPrincipal, the orders and payments services and
 *     repositories, the Postgres rate-limit store, auditLog;
 *   - runServerFnBoundary (src/server/observability/server-fn-boundary.ts),
 *     the middleware every server function runs inside: it opens the
 *     per-call RequestContext the membership prefetch is keyed by, and turns
 *     unexpected failures into a sanitized 500;
 *   - the database: PGlite with EVERY migration (create_order_v3,
 *     record_payment_v2, consume_rate_limit, the memberships / roles /
 *     role_permissions / permissions seed, audit_logs).
 *
 * What is SUBSTITUTED (external transport and session-provider boundaries):
 *   - TanStack Start's createServerFn factory and HTTP layer: a server
 *     function call runs validator → runServerFnBoundary → handler in-process,
 *     inside an HTTP-request store carrying that request's own cookie header
 *     (getCookie / setCookie / deleteCookie of @tanstack/react-start/server);
 *   - the Supabase Auth API (createServerClient(token).auth.getUser and
 *     createRefreshClient().auth.refreshSession): a token table — valid,
 *     expired, or unknown — standing in for the hosted session provider;
 *   - PostgREST: supabaseAdmin translates the query-builder calls the code
 *     makes (including the memberships → roles → role_permissions →
 *     permissions embed) into SQL against the migrated PGlite database. The
 *     filters, ordering and single-row semantics are the caller's own.
 *
 * Nothing mocks the principal resolver, membership authorization or
 * assertExpectedPrincipal. Organization selection changes are real
 * membership-row changes the canonical resolver reads.
 *
 * Run through src/tests/session-principal-boundary.test.ts (own process:
 * mock.module replaces modules process-wide).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

process.env["RATE_LIMIT_KEY_SECRET"] = "session-principal-boundary-synthetic-secret";

// ── Synthetic identities ─────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
/** Owner of A. */
const MEMBER_A = "a0000000-0000-4000-8000-000000000001";
/** Owner of A as well — a second member of the same organization. */
const MEMBER_B = "b0000000-0000-4000-8000-000000000002";
/** Owner in A and in B: the canonical organization decides which one acts. */
const MULTI = "c0000000-0000-4000-8000-000000000003";
/** Active in A under a role without orders.create. */
const LIMITED = "d0000000-0000-4000-8000-000000000004";
/** Owner of B only. */
const OWNER_B = "e0000000-0000-4000-8000-000000000005";
/** Signs in with an unverified email address. */
const UNVERIFIED = "f0000000-0000-4000-8000-000000000006";
const USERS = [MEMBER_A, MEMBER_B, MULTI, LIMITED, OWNER_B, UNVERIFIED];

const OWNER_ROLE = "00000000-0000-0000-0000-000000000001";

const PRODUCT_A = "aaaaaaaa-7777-4000-8000-000000000001";
const VARIANT_A = "aaaaaaaa-5555-4000-8000-000000000001";
const PRODUCT_B = "bbbbbbbb-7777-4000-8000-000000000001";
const VARIANT_B = "bbbbbbbb-5555-4000-8000-000000000001";

// ── Database: PGlite with every migration ────────────────────────────────────

const db = new PGlite();

// ── Substitute: the HTTP request (its own cookie header) ─────────────────────

/** One browser profile: a cookie jar shared by all its tabs. */
interface Browser {
  cookies: Map<string, string>;
}
interface HttpRequest {
  browser: Browser;
  /** The Cookie header this request carried, fixed when it was SENT. */
  cookies: Map<string, string>;
}
const http = new AsyncLocalStorage<HttpRequest>();

mock.module("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => http.getStore()?.cookies.get(name),
  setCookie: (name: string, value: string) => {
    const request = http.getStore();
    if (!request) throw new Error("setCookie outside a request");
    request.cookies.set(name, value);
    request.browser.cookies.set(name, value); // Set-Cookie on the response
  },
  deleteCookie: (name: string) => {
    const request = http.getStore();
    if (!request) throw new Error("deleteCookie outside a request");
    request.cookies.delete(name);
    request.browser.cookies.delete(name);
  },
  getRequestHeader: () => undefined,
}));

// ── Substitute: the server-function factory (transport only) ────────────────

const { runServerFnBoundary } = await import("@/server/observability/server-fn-boundary");

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => {
    const build = (validator?: (data: unknown) => unknown) => ({
      validator: (v: (data: unknown) => unknown) => build(v),
      inputValidator: (v: (data: unknown) => unknown) => build(v),
      handler: (fn: (args: { data: any }) => unknown) => (args?: { data?: unknown }) =>
        // The real APSA function middleware, around validation and handler.
        runServerFnBoundary(undefined, async () =>
          fn({ data: validator ? validator(args?.data) : args?.data }),
        ),
    });
    return build();
  },
}));

// ── Substitute: the session provider (Supabase Auth API) ─────────────────────

interface ProviderUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
}
const accessTokens = new Map<string, ProviderUser | "expired">();
const refreshTokens = new Map<string, ProviderUser>();
const providerCalls: string[] = [];
/** Optional hold: getUser for this token waits until released. */
const getUserHolds = new Map<string, Promise<void>>();

// ── Substitute: PostgREST over SQL ───────────────────────────────────────────

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Tables whose next read fails like a dropped database connection. */
const failingReads = new Set<string>();
/** Optional hold before a table read for a given user_id filter. */
const readHolds = new Map<string, Promise<void>>();
const membershipReads: string[] = [];

const MEMBERSHIP_EMBED = `m.*, (
  select to_jsonb(r) || jsonb_build_object('role_permissions', coalesce((
    select jsonb_agg(jsonb_build_object('permission', jsonb_build_object('key', p.key)))
      from role_permissions rp join permissions p on p.id = rp.permission_id
     where rp.role_id = r.id), '[]'::jsonb))
    from roles r where r.id = m.role_id) as role`;

function columnsSql(columns: string): string {
  if (columns.includes("role:roles(")) {
    if (columns !== "*, role:roles(*, role_permissions(permission:permissions(key)))") {
      throw new Error(`unsupported embed: ${columns}`);
    }
    return MEMBERSHIP_EMBED;
  }
  if (columns.trim() === "*") return "*";
  return columns
    .split(",")
    .map((c) => {
      const name = c.trim();
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported column: ${name}`);
      return ident(name);
    })
    .join(",");
}

const toParam = (value: unknown) =>
  value !== null && typeof value === "object" && !(value instanceof Date)
    ? JSON.stringify(value)
    : value;

function query(table: string) {
  const where: string[] = [];
  const values: unknown[] = [];
  const ordering: string[] = [];
  let columns = "*";
  let max: number | undefined;
  let single: "single" | "maybe" | undefined;
  let filterUser: string | undefined;
  const chain: any = {
    select(cols = "*") {
      columns = cols;
      return chain;
    },
    eq(key: string, value: unknown) {
      if (key === "user_id") filterUser = String(value);
      values.push(value);
      where.push(`${ident(key)} = $${values.length}`);
      return chain;
    },
    neq(key: string, value: unknown) {
      values.push(value);
      where.push(`${ident(key)} <> $${values.length}`);
      return chain;
    },
    is(key: string, value: unknown) {
      where.push(`${ident(key)} is ${value === null ? "null" : String(value)}`);
      return chain;
    },
    in(key: string, list: unknown[]) {
      const params = list.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      where.push(list.length ? `${ident(key)} in (${params.join(",")})` : "false");
      return chain;
    },
    order(key: string, options?: { ascending?: boolean }) {
      ordering.push(`${ident(key)} ${options?.ascending === false ? "desc" : "asc"}`);
      return chain;
    },
    limit(n: number) {
      max = n;
      return chain;
    },
    single() {
      single = "single";
      return chain;
    },
    maybeSingle() {
      single = "maybe";
      return chain;
    },
    async execute() {
      if (table === "memberships") membershipReads.push(filterUser ?? "?");
      const hold = filterUser ? readHolds.get(`${table}:${filterUser}`) : undefined;
      if (hold) await hold;
      if (failingReads.delete(table)) {
        return { data: null, error: { code: "08006", message: "connection failure" } };
      }
      const from = table === "memberships" ? "memberships m" : ident(table);
      let sql = `select ${columnsSql(columns)} from ${from}`;
      if (where.length) sql += ` where ${where.join(" and ")}`;
      if (ordering.length) sql += ` order by ${ordering.join(",")}`;
      if (max !== undefined) sql += ` limit ${max}`;
      try {
        const rows = JSON.parse(JSON.stringify((await db.query(sql, values)).rows));
        if (single === "single") {
          return rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: { code: "PGRST116", message: "not one row" } };
        }
        if (single === "maybe") return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as any).code, message: String(error) } };
      }
    },
    then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
      return chain.execute().then(ok, fail);
    },
  };
  return chain;
}

function insert(table: string, input: Record<string, unknown> | Record<string, unknown>[]) {
  const rows = Array.isArray(input) ? input : [input];
  const run = async () => {
    try {
      for (const row of rows) {
        const keys = Object.keys(row);
        await db.query(
          `insert into ${ident(table)} (${keys.map(ident).join(",")}) values (${keys
            .map((_, i) => `$${i + 1}`)
            .join(",")})`,
          keys.map((k) => toParam(row[k])),
        );
      }
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: { code: (error as any).code, message: String(error) } };
    }
  };
  return { then: (ok: any, fail?: any) => run().then(ok, fail) };
}

const supabaseAdmin = {
  from: (table: string) => ({
    select: (cols?: string) => query(table).select(cols),
    insert: (rows: any) => insert(table, rows),
  }),
  async rpc(name: string, args: Record<string, unknown>) {
    const entries = Object.entries(args ?? {});
    const sql = `select ${ident(name)}(${entries
      .map(([key], i) => `${ident(key)} => $${i + 1}`)
      .join(",")}) as result`;
    try {
      const result = await db.query<{ result: unknown }>(
        sql,
        entries.map(([, v]) => toParam(v)),
      );
      return { data: JSON.parse(JSON.stringify(result.rows[0]!.result)), error: null };
    } catch (error) {
      return { data: null, error: { code: (error as any).code, message: String(error) } };
    }
  },
};

mock.module("@/lib/supabase/server", () => ({
  COOKIE_ACCESS_TOKEN: "sb-access-token",
  COOKIE_REFRESH_TOKEN: "sb-refresh-token",
  COOKIE_OPTIONS: { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 604800 },
  supabaseAdmin,
  createServerClient: (accessToken: string) => ({
    auth: {
      getUser: async () => {
        providerCalls.push(`getUser:${accessToken}`);
        const hold = getUserHolds.get(accessToken);
        if (hold) await hold;
        const entry = accessTokens.get(accessToken);
        if (!entry || entry === "expired") {
          return { data: { user: null }, error: { message: "invalid JWT", status: 401 } };
        }
        return { data: { user: entry }, error: null };
      },
    },
  }),
  createRefreshClient: () => ({
    auth: {
      refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
        providerCalls.push(`refresh:${refresh_token}`);
        const user = refreshTokens.get(refresh_token);
        if (!user) return { data: { session: null }, error: { message: "invalid refresh" } };
        refreshTokens.delete(refresh_token); // refresh tokens are single use
        const session = mintSession(user);
        return { data: { session: { ...session, user } }, error: null };
      },
    },
  }),
}));

// ── The code under test (imported only after the substitutions) ──────────────

const { createOrderFn } = await import("@/api/orders");
const { recordPaymentFn } = await import("@/api/payments");

// ── Session helpers ──────────────────────────────────────────────────────────

let tokenSeq = 0;
function mintSession(user: ProviderUser) {
  const access_token = `at-${user.id.slice(0, 8)}-${++tokenSeq}`;
  const refresh_token = `rt-${user.id.slice(0, 8)}-${tokenSeq}`;
  accessTokens.set(access_token, user);
  refreshTokens.set(refresh_token, user);
  return { access_token, refresh_token };
}
function providerUser(id: string, verified = true): ProviderUser {
  return {
    id,
    email: `${id.slice(0, 8)}@test.invalid`,
    email_confirmed_at: verified ? "2026-10-01T00:00:00Z" : null,
  };
}
/** The browser's session cookies now belong to `userId` (a sign-in, in any tab). */
function signIn(browser: Browser, userId: string, verified = true) {
  const { access_token, refresh_token } = mintSession(providerUser(userId, verified));
  browser.cookies.set("sb-access-token", access_token);
  browser.cookies.set("sb-refresh-token", refresh_token);
  return { access_token, refresh_token };
}
const newBrowser = (): Browser => ({ cookies: new Map() });

/** Send a server-function request with the browser's cookies AS OF NOW. */
function send<T>(browser: Browser, call: () => Promise<T>): Promise<T> {
  return http.run({ browser, cookies: new Map(browser.cookies) }, call);
}

type Outcome =
  | { ok: true; value: any }
  | { ok: false; status: number | undefined; code: string | undefined; name: string };
async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const e = error as { statusCode?: number; code?: string; name: string; issues?: unknown };
    return {
      ok: false,
      status: e.statusCode ?? (e.issues ? 400 : undefined),
      code: e.code,
      name: e.name,
    };
  }
}

const principal = (userId: string, organizationId: string) => ({ userId, organizationId });

let keySeq = 0;
/** One logical checkout, started as `as`: its body is fixed when it is started. */
function startOrder(as: { userId: string; organizationId: string }, variant = VARIANT_A) {
  const data = {
    source: "MANUAL" as const,
    items: [{ variantId: variant, quantity: 1 }],
    idempotencyKey: `boundary-order-key-${String(++keySeq).padStart(4, "0")}`,
    expectedPrincipal: as,
  };
  return { data, sendFrom: (browser: Browser) => send(browser, () => createOrderFn({ data })) };
}
function startPayment(
  as: { userId: string; organizationId: string },
  orderId: string,
  amountMinor = 500,
) {
  const data = {
    orderId,
    method: "cash" as const,
    amountMinor,
    idempotencyKey: `boundary-payment-key-${String(++keySeq).padStart(4, "0")}`,
    expectedPrincipal: as,
  };
  return { data, sendFrom: (browser: Browser) => send(browser, () => recordPaymentFn({ data })) };
}

// ── Organization selection (real membership rows) ────────────────────────────

let clock = Date.parse("2026-10-01T00:00:00Z");
/** Make `organizationId` the member's canonical organization: its membership is now the newest. */
async function selectOrganization(userId: string, organizationId: string) {
  clock += 60_000;
  await db.query(
    `update memberships set joined_at = $3 where user_id = $1 and organization_id = $2`,
    [userId, organizationId, new Date(clock).toISOString()],
  );
}
async function setMembershipStatus(userId: string, organizationId: string, status: string) {
  await db.query(
    `update memberships set status = $3::membership_status where user_id = $1 and organization_id = $2`,
    [userId, organizationId, status],
  );
}

// ── The complete write surface ───────────────────────────────────────────────

/** Every row a create or a payment can write, in full, in a stable order. */
async function writeSurface() {
  const rows = async (table: string, order: string) =>
    (
      await db.query<{ r: unknown }>(`select to_jsonb(t) as r from ${table} t order by ${order}`)
    ).rows.map((row) => row.r);
  return {
    orders: await rows("orders", "id"),
    order_items: await rows("order_items", "id"),
    order_status_history: await rows("order_status_history", "id"),
    inventory_movements: await rows("inventory_movements", "id"),
    payments: await rows("payments", "id"),
    payment_events: await rows("payment_events", "id"),
    audit_logs: await rows("audit_logs", "id"),
    rate_limit_buckets: await rows("rate_limit_buckets", "1"),
  };
}
async function ordersOf(organizationId: string) {
  return (
    await db.query<{ id: string; organization_id: string; created_by: string; key: string }>(
      `select id, organization_id, created_by, idempotency_key as key from orders
        where organization_id = $1 order by created_at, id`,
      [organizationId],
    )
  ).rows;
}

// ── Setup ────────────────────────────────────────────────────────────────────

let limitedRole = "";

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  `);
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  for (const id of USERS) {
    await db.query(`insert into auth.users(id,email) values($1,$2)`, [id, `${id}@test.invalid`]);
  }
  await db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
     values($1,'A','A','boundary-a',$3),($2,'B','B','boundary-b',$3)`,
    [ORG_A, ORG_B, MEMBER_A],
  );
  // A system role that holds no orders.create (seeded by the migrations).
  limitedRole = (
    await db.query<{ id: string }>(
      `select r.id from roles r where r.organization_id is null and not exists (
         select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
          where rp.role_id = r.id and p.key = 'orders.create') order by r.id limit 1`,
    )
  ).rows[0]!.id;
  const member = (user: string, org: string, role: string, joined: string) =>
    db.query(
      `insert into memberships(user_id,organization_id,role_id,status,joined_at)
       values($1,$2,$3,'active',$4)`,
      [user, org, role, joined],
    );
  await member(MEMBER_A, ORG_A, OWNER_ROLE, "2026-09-01T00:00:00Z");
  await member(MEMBER_B, ORG_A, OWNER_ROLE, "2026-09-01T00:00:00Z");
  await member(MULTI, ORG_A, OWNER_ROLE, "2026-09-02T00:00:00Z");
  await member(MULTI, ORG_B, OWNER_ROLE, "2026-09-01T00:00:00Z");
  await member(LIMITED, ORG_A, limitedRole, "2026-09-01T00:00:00Z");
  await member(OWNER_B, ORG_B, OWNER_ROLE, "2026-09-01T00:00:00Z");
  await member(UNVERIFIED, ORG_A, OWNER_ROLE, "2026-09-01T00:00:00Z");
  await db.query(
    `insert into products(id,organization_id,name_km) values($1,$2,'ផលិតផល A'),($3,$4,'ផលិតផល B')`,
    [PRODUCT_A, ORG_A, PRODUCT_B, ORG_B],
  );
  await db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency,status)
     values($1,$2,$3,'SKU-A','Std',1500,'USD','ACTIVE'),($4,$5,$6,'SKU-B','Std',2500,'USD','ACTIVE')`,
    [VARIANT_A, ORG_A, PRODUCT_A, VARIANT_B, ORG_B, PRODUCT_B],
  );
}, 180_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // Every case starts from MULTI acting in A (A is its newest membership).
  await selectOrganization(MULTI, ORG_A);
  failingReads.clear();
  readHolds.clear();
  getUserHolds.clear();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

// ── The suite ────────────────────────────────────────────────────────────────

describe("setup sanity: the real chain is what decides", () => {
  it("the limited role really lacks orders.create, and MULTI's canonical organization follows its newest membership", async () => {
    expect(limitedRole).not.toBe(OWNER_ROLE);
    const browser = newBrowser();
    signIn(browser, MULTI);
    const inA = await outcome(startOrder(principal(MULTI, ORG_A)).sendFrom(browser));
    expect(inA.ok).toBe(true);
    await selectOrganization(MULTI, ORG_B);
    const inB = await outcome(startOrder(principal(MULTI, ORG_B), VARIANT_B).sendFrom(browser));
    expect(inB.ok).toBe(true);
    expect(inA.ok && inA.value.organizationId).toBe(ORG_A);
    expect(inB.ok && inB.value.organizationId).toBe(ORG_B);
  });
});

describe("matching principal: the request executes, as the server-derived principal", () => {
  it("member A's order is created in A by A; the write surface, rate limit and audit all move", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const before = await writeSurface();
    const request = startOrder(principal(MEMBER_A, ORG_A));
    const result = await outcome(request.sendFrom(browser));
    expect(result.ok).toBe(true);
    const after = await writeSurface();

    const order = (after.orders as any[]).find(
      (o) => o.idempotency_key === request.data.idempotencyKey,
    );
    expect(order.organization_id).toBe(ORG_A);
    expect(order.created_by).toBe(MEMBER_A);
    expect(after.orders.length).toBe(before.orders.length + 1);
    expect(after.order_items.length).toBe(before.order_items.length + 1);
    // Real Postgres rate-limit buckets were consumed (not a memory fallback).
    expect(after.rate_limit_buckets).not.toEqual(before.rate_limit_buckets);
    const audit = (after.audit_logs as any[]).filter((a) => a.resource_id === order.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].organization_id).toBe(ORG_A);
    expect(audit[0].actor_user_id).toBe(MEMBER_A);
    expect(audit[0].action).toBe("orders.create");
  });

  it("a cash payment by member A on A's order is recorded in A by A", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const created = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    if (!created.ok) throw new Error("setup: order not created");
    const before = await writeSurface();
    const result = await outcome(
      startPayment(principal(MEMBER_A, ORG_A), created.value.id).sendFrom(browser),
    );
    expect(result.ok).toBe(true);
    const after = await writeSurface();
    expect(after.payments.length).toBe(before.payments.length + 1);
    const payment = (after.payments as any[]).find((p) => p.order_id === created.value.id);
    expect(payment.organization_id).toBe(ORG_A);
    expect(payment.recorded_by).toBe(MEMBER_A);
    expect(after.rate_limit_buckets).not.toEqual(before.rate_limit_buckets);
  });
});

describe("member switch: started as member A, dispatched after the session became member B", () => {
  it("refused 409 principal_changed with zero writes; back as A, the original request succeeds once and replays safely", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const request = startOrder(principal(MEMBER_A, ORG_A));

    signIn(browser, MEMBER_B); // another tab signs in as B before the request leaves
    const before = await writeSurface();
    const refused = await outcome(request.sendFrom(browser));
    expect(refused).toEqual({
      ok: false,
      status: 409,
      code: "principal_changed",
      name: "PublicDomainError",
    });
    // Byte-for-byte: no order, line, history, movement, payment, audit row or rate-limit token.
    expect(await writeSurface()).toEqual(before);

    signIn(browser, MEMBER_A);
    const first = await outcome(request.sendFrom(browser));
    expect(first.ok).toBe(true);
    const replay = await outcome(request.sendFrom(browser));
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.value.id).toBe(first.ok && first.value.id);
    const persisted = (await ordersOf(ORG_A)).filter((o) => o.key === request.data.idempotencyKey);
    expect(persisted).toEqual([
      {
        id: first.ok ? first.value.id : "",
        organization_id: ORG_A,
        created_by: MEMBER_A,
        key: request.data.idempotencyKey,
      },
    ]);
    const audits = (
      await db.query(`select 1 from audit_logs where resource_id = $1`, [persisted[0]!.id])
    ).rows;
    expect(audits).toHaveLength(1); // the replay wrote no second audit row
  });

  it("a payment started as member A and sent as member B is refused with zero writes", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const created = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    if (!created.ok) throw new Error("setup: order not created");
    const payment = startPayment(principal(MEMBER_A, ORG_A), created.value.id);
    signIn(browser, MEMBER_B);
    const before = await writeSurface();
    const refused = await outcome(payment.sendFrom(browser));
    expect(refused).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect(await writeSurface()).toEqual(before);

    signIn(browser, MEMBER_A);
    const retried = await outcome(payment.sendFrom(browser));
    expect(retried.ok).toBe(true);
    const again = await outcome(payment.sendFrom(browser));
    expect(again.ok && again.value.id).toBe(retried.ok && retried.value.id);
    const rows = (
      await db.query<{ recorded_by: string; organization_id: string }>(
        `select recorded_by, organization_id from payments where order_id = $1`,
        [created.value.id],
      )
    ).rows;
    expect(rows).toEqual([{ recorded_by: MEMBER_A, organization_id: ORG_A }]);
  });
});

describe("organization switch: started in A, dispatched after the canonical organization became B", () => {
  it("refused 409 principal_changed with zero writes in A or B; back in A, the retry creates one order in A", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    const request = startOrder(principal(MULTI, ORG_A));

    await selectOrganization(MULTI, ORG_B);
    const before = await writeSurface();
    const refused = await outcome(request.sendFrom(browser));
    expect(refused).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect(await writeSurface()).toEqual(before);

    await selectOrganization(MULTI, ORG_A);
    const retried = await outcome(request.sendFrom(browser));
    expect(retried.ok).toBe(true);
    const inA = (await ordersOf(ORG_A)).filter((o) => o.key === request.data.idempotencyKey);
    const inB = (await ordersOf(ORG_B)).filter((o) => o.key === request.data.idempotencyKey);
    expect(inA).toHaveLength(1);
    expect(inA[0]).toMatchObject({ organization_id: ORG_A, created_by: MULTI });
    expect(inB).toEqual([]);
  });

  it("A → B → A between start and dispatch: the request executes as A (the principal it was started as)", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    const request = startOrder(principal(MULTI, ORG_A));
    await selectOrganization(MULTI, ORG_B);
    await selectOrganization(MULTI, ORG_A);
    const result = await outcome(request.sendFrom(browser));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.organizationId).toBe(ORG_A);
  });

  it("committed in A, response lost, refused after switching to B, retried back in A: one order, one audit row", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    const request = startOrder(principal(MULTI, ORG_A));
    const lost = await outcome(request.sendFrom(browser)); // committed; the browser never saw it
    expect(lost.ok).toBe(true);
    await selectOrganization(MULTI, ORG_B);
    const refused = await outcome(request.sendFrom(browser));
    expect(refused).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    await selectOrganization(MULTI, ORG_A);
    const retried = await outcome(request.sendFrom(browser));
    expect(retried.ok && retried.value.id).toBe(lost.ok && lost.value.id);
    const persisted = (await ordersOf(ORG_A)).filter((o) => o.key === request.data.idempotencyKey);
    expect(persisted).toHaveLength(1);
    expect(
      (await db.query(`select 1 from audit_logs where resource_id = $1`, [persisted[0]!.id])).rows,
    ).toHaveLength(1);
  });
});

describe("sessions the provider does not vouch for are refused before any principal exists", () => {
  it("missing session (no cookies): 401, nothing written, the membership tables never read", async () => {
    const browser = newBrowser();
    const before = await writeSurface();
    membershipReads.length = 0;
    const result = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    expect(result).toMatchObject({ ok: false, status: 401, name: "UnauthorizedError" });
    expect(membershipReads).toEqual([]);
    expect(await writeSurface()).toEqual(before);
  });

  it("expired session (access token rejected, refresh token dead): 401, cookies cleared, nothing written", async () => {
    const browser = newBrowser();
    const { access_token, refresh_token } = signIn(browser, MEMBER_A);
    accessTokens.set(access_token, "expired");
    refreshTokens.delete(refresh_token);
    const before = await writeSurface();
    providerCalls.length = 0;
    const result = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    expect(result).toMatchObject({ ok: false, status: 401, name: "UnauthorizedError" });
    expect(providerCalls).toEqual([`getUser:${access_token}`, `refresh:${refresh_token}`]);
    expect(browser.cookies.size).toBe(0);
    expect(await writeSurface()).toEqual(before);
  });

  it("expired access token refreshed by the provider for the SAME member: executes as that member", async () => {
    const browser = newBrowser();
    const { access_token } = signIn(browser, MEMBER_A);
    accessTokens.set(access_token, "expired");
    const result = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    expect(result.ok).toBe(true);
    expect(browser.cookies.get("sb-access-token")).not.toBe(access_token);
  });

  it("an access token whose refresh lands as ANOTHER member is refused by the principal check", async () => {
    const browser = newBrowser();
    const { access_token, refresh_token } = signIn(browser, MEMBER_A);
    accessTokens.set(access_token, "expired");
    // The provider's answer for this refresh token is member B (another tab re-authenticated).
    refreshTokens.set(refresh_token, providerUser(MEMBER_B));
    const before = await writeSurface();
    const result = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    expect(result).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect(await writeSurface()).toEqual(before);
  });

  it("unverified email: 401 even though the token is valid and the membership is active", async () => {
    const browser = newBrowser();
    signIn(browser, UNVERIFIED, false);
    const before = await writeSurface();
    membershipReads.length = 0;
    const result = await outcome(startOrder(principal(UNVERIFIED, ORG_A)).sendFrom(browser));
    expect(result).toMatchObject({ ok: false, status: 401, name: "UnauthorizedError" });
    expect(membershipReads).toEqual([]);
    expect(await writeSurface()).toEqual(before);
  });
});

describe("membership state is read per request, never assumed", () => {
  for (const status of ["suspended", "removed"] as const) {
    it(`${status} membership (the member's only one): 403, nothing written; reactivated, the same request succeeds`, async () => {
      const browser = newBrowser();
      signIn(browser, MEMBER_B);
      const request = startOrder(principal(MEMBER_B, ORG_A));
      await setMembershipStatus(MEMBER_B, ORG_A, status);
      try {
        const before = await writeSurface();
        const result = await outcome(request.sendFrom(browser));
        expect(result).toMatchObject({ ok: false, status: 403, name: "ForbiddenError" });
        expect(await writeSurface()).toEqual(before);
      } finally {
        await setMembershipStatus(MEMBER_B, ORG_A, "active");
      }
      const retried = await outcome(request.sendFrom(browser));
      expect(retried.ok).toBe(true);
    });
  }

  it("suspended in A while still active in B: never falls through to act in B — 409, nothing written anywhere", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    const request = startOrder(principal(MULTI, ORG_A));
    await setMembershipStatus(MULTI, ORG_A, "suspended");
    try {
      const before = await writeSurface();
      const result = await outcome(request.sendFrom(browser));
      expect(result).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
      expect(await writeSurface()).toEqual(before);
    } finally {
      await setMembershipStatus(MULTI, ORG_A, "active");
    }
  });

  it("membership lookup failure: a sanitized 500, no fallback to any other organization or member, nothing written", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    const before = await writeSurface();
    failingReads.add("memberships");
    const result = await outcome(startOrder(principal(MULTI, ORG_A)).sendFrom(browser));
    expect(result).toMatchObject({ ok: false, status: 500, code: "internal_error" });
    expect(failingReads.size).toBe(0); // the failure was really reached
    expect(await writeSurface()).toEqual(before);
    // The next request reads again and succeeds — nothing was cached from the failure.
    const next = await outcome(startOrder(principal(MULTI, ORG_A)).sendFrom(browser));
    expect(next.ok).toBe(true);
  });
});

describe("expectedPrincipal is a refuse-only precondition, never a credential", () => {
  it("absent: refused by the validator before any session or membership read", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const { expectedPrincipal: _omit, ...data } = startOrder(principal(MEMBER_A, ORG_A)).data;
    providerCalls.length = 0;
    membershipReads.length = 0;
    const before = await writeSurface();
    const result = await outcome(send(browser, () => createOrderFn({ data: data as any })));
    expect(result).toMatchObject({ ok: false, status: 400, name: "ZodError" });
    expect(providerCalls).toEqual([]);
    expect(membershipReads).toEqual([]);
    expect(await writeSurface()).toEqual(before);
  });

  it("naming an organization the member does not belong to: refused, nothing written in either organization", async () => {
    const browser = newBrowser();
    signIn(browser, MEMBER_A);
    const before = await writeSurface();
    const result = await outcome(
      startOrder(principal(MEMBER_A, ORG_B), VARIANT_B).sendFrom(browser),
    );
    expect(result).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect(await writeSurface()).toEqual(before);
  });

  it("naming a more privileged member of the same organization does not lend their permissions", async () => {
    const browser = newBrowser();
    signIn(browser, LIMITED);
    const before = await writeSurface();
    const borrowed = await outcome(startOrder(principal(MEMBER_A, ORG_A)).sendFrom(browser));
    expect(borrowed).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    // Truthful: the member's own permissions decide — and they lack orders.create.
    const own = await outcome(startOrder(principal(LIMITED, ORG_A)).sendFrom(browser));
    expect(own).toMatchObject({ ok: false, status: 403, name: "ForbiddenError" });
    expect(await writeSurface()).toEqual(before);
  });

  it("a matching assertion does not select the tenant: A's variant ordered as an organization-B principal is not found in B", async () => {
    const browser = newBrowser();
    signIn(browser, OWNER_B);
    const before = await writeSurface();
    const result = await outcome(
      startOrder(principal(OWNER_B, ORG_B), VARIANT_A).sendFrom(browser),
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
    // The rate-limit token is the only thing a refused-after-authorization create consumes.
    const after = await writeSurface();
    expect({ ...after, rate_limit_buckets: [] }).toEqual({ ...before, rate_limit_buckets: [] });
  });
});

describe("interleaved requests: authorization state is request-local", () => {
  it("member A (org A) and owner B (org B) in flight together, completed in reverse order: each executes as itself", async () => {
    const browserA = newBrowser();
    const browserB = newBrowser();
    const tokenA = signIn(browserA, MEMBER_A).access_token;
    signIn(browserB, OWNER_B);
    const holdA = gate();
    getUserHolds.set(tokenA, holdA.promise); // A has started; its session check is still pending

    const requestA = startOrder(principal(MEMBER_A, ORG_A));
    const requestB = startOrder(principal(OWNER_B, ORG_B), VARIANT_B);
    const pendingA = outcome(requestA.sendFrom(browserA));
    const resultB = await outcome(requestB.sendFrom(browserB)); // B runs start to finish meanwhile
    holdA.release();
    const resultA = await pendingA;

    expect(resultA.ok && resultA.value.organizationId).toBe(ORG_A);
    expect(resultB.ok && resultB.value.organizationId).toBe(ORG_B);
    const a = (await ordersOf(ORG_A)).find((o) => o.key === requestA.data.idempotencyKey);
    const b = (await ordersOf(ORG_B)).find((o) => o.key === requestB.data.idempotencyKey);
    expect(a).toMatchObject({ organization_id: ORG_A, created_by: MEMBER_A });
    expect(b).toMatchObject({ organization_id: ORG_B, created_by: OWNER_B });
  });

  it("the same member's two requests across an organization switch: the one held mid-resolution keeps its own organization", async () => {
    const browser = newBrowser();
    signIn(browser, MULTI);
    // Request 1 is held at its membership read (session already validated);
    // request 2 runs entirely after the switch to B.
    const holdMemberships = gate();
    const request1 = startOrder(principal(MULTI, ORG_A));
    readHolds.set(`memberships:${MULTI}`, holdMemberships.promise);
    membershipReads.length = 0;
    const pending1 = outcome(request1.sendFrom(browser));
    for (let i = 0; i < 500 && membershipReads.length === 0; i++) await Bun.sleep(1);
    expect(membershipReads).toEqual([MULTI]); // request 1 is parked at the read
    readHolds.delete(`memberships:${MULTI}`);
    await selectOrganization(MULTI, ORG_B);
    const request2 = startOrder(principal(MULTI, ORG_B), VARIANT_B);
    const result2 = await outcome(request2.sendFrom(browser));
    holdMemberships.release();
    const result1 = await pending1;

    // Request 1 read its memberships AFTER the switch (its read was held), so the
    // server derived B and refused it; request 2 executed in B. Neither leaked.
    expect(result1).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect(result2.ok && result2.value.organizationId).toBe(ORG_B);
    expect((await ordersOf(ORG_A)).some((o) => o.key === request1.data.idempotencyKey)).toBe(false);
    expect((await ordersOf(ORG_B)).some((o) => o.key === request1.data.idempotencyKey)).toBe(false);
  });

  it("a refused request interleaved with a matching one: only the matching one writes", async () => {
    const browserA = newBrowser();
    const browserB = newBrowser();
    signIn(browserA, MEMBER_A);
    const tokenB = signIn(browserB, MEMBER_B).access_token;
    const holdB = gate();
    getUserHolds.set(tokenB, holdB.promise);
    // B's tab sends a request that A's tab STARTED (stale page after a sign-in switch).
    const stale = startOrder(principal(MEMBER_A, ORG_A));
    const pendingStale = outcome(stale.sendFrom(browserB));
    const own = startOrder(principal(MEMBER_A, ORG_A));
    const ownResult = await outcome(own.sendFrom(browserA));
    holdB.release();
    const staleResult = await pendingStale;

    expect(ownResult.ok).toBe(true);
    expect(staleResult).toMatchObject({ ok: false, status: 409, code: "principal_changed" });
    expect((await ordersOf(ORG_A)).filter((o) => o.key === stale.data.idempotencyKey)).toEqual([]);
    expect((await ordersOf(ORG_A)).filter((o) => o.key === own.data.idempotencyKey)).toHaveLength(
      1,
    );
  });
});
