/**
 * Products catalogue pagination, search and filters — MOUNTED, through the
 * REAL server function, the REAL service and repository, and REAL SQL.
 *
 * Mounts the production Products screen (src/routes/app.products.tsx) in
 * happy-dom and drives it the way a merchant does: tap Load more, type into the
 * search box, switch Active/Archived and categories, lose the network, retry.
 * Between the screen and PostgreSQL:
 *
 *   screen → listCatalogProductsPage (src/lib/catalog) → listProductsPageFn
 *   (src/api/products, its real zod validator and real handler) →
 *   resolveAuthContext → the real AuthorizationContext → products service
 *   listProductsPage → repository listProductsPage / listVariantsByOrg →
 *   PGlite with every migration applied.
 *
 * Replaced, and only these:
 *   - createServerFn — it cannot run in a unit process; the stand-in runs the
 *     function's own validator, then its own handler.
 *   - the session cookie (getSessionFn) and the active-organization lookup —
 *     both answer from `server`, the principal the SERVER would resolve. The
 *     route's principal (`route`) is separate, so a sign-in in another tab
 *     (server moves, route does not) is expressible.
 *   - verifyActiveMembership — the same membership → role → permission read,
 *     as plain SQL over the same tables, so grants and revocations are real
 *     rows.
 *   - the capability snapshot — built by the real createCapabilityView for
 *     the route's principal; it keeps saying products.read throughout, so the
 *     SERVER's answer is what must decide (the stale-snapshot window).
 *   - the Supabase admin client — an SQL transport onto PGlite. It renders
 *     rows through json_agg exactly as PostgREST does (timestamps keep their
 *     microseconds), expands "*" to "%" in like/ilike values as PostgREST
 *     does, implements the `!inner` embed the search uses as an EXISTS over
 *     the child rows, answers `count: "exact"` with the whole filtered set's
 *     size, and cuts every response at max_rows = 1000 (lower in section I)
 *     WITHOUT an error, as Supabase's default PostgREST configuration does.
 *   - four TanStack Router hooks — there is no router in a unit process.
 *
 * Runs in its own process (products-catalog-mounted.test.ts): it installs DOM
 * globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

// Well past waitFor's own 5 s budget, so a hung case fails on its own message.
setDefaultTimeout(60_000);

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();

const OWNER_ROLE = "00000000-0000-0000-0000-000000000001";
/** Owner of every test organization. */
const U1 = "aaaaaaaa-0000-4000-8000-0000000000d1";
/** A second member of the same organizations, on a revocable custom role. */
const U2 = "aaaaaaaa-0000-4000-8000-0000000000d2";
for (const [id, email] of [
  [U1, "catalog-1@test.invalid"],
  [U2, "catalog-2@test.invalid"],
]) {
  await f.db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
}

let orgSeq = 0;
/**
 * A fresh organization with both members: U1 as Owner, U2 on a custom role
 * holding products.read alone (no products.view_cost), so revoking it touches
 * nobody else.
 */
async function newOrg(): Promise<{ org: string; viewerRole: string }> {
  orgSeq += 1;
  const org = crypto.randomUUID();
  await f.db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
     values($1,$2,$2,$3,$4)`,
    [org, `Catalog ${orgSeq}`, `catalog-${orgSeq}`, U1],
  );
  const viewerRole = crypto.randomUUID();
  await f.db.query(`insert into roles(id,organization_id,name) values($1,$2,'Catalog viewer')`, [
    viewerRole,
    org,
  ]);
  await f.db.query(
    `insert into role_permissions(role_id,permission_id)
     select $1, id from permissions where key = 'products.read'`,
    [viewerRole],
  );
  for (const [user, role] of [
    [U1, OWNER_ROLE],
    [U2, viewerRole],
  ]) {
    await f.db.query(
      `insert into memberships(user_id,organization_id,role_id,status) values($1,$2,$3,'active')`,
      [user, org, role],
    );
  }
  return { org, viewerRole };
}

async function newCategory(org: string, nameKm: string, nameEn: string): Promise<string> {
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into product_categories(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`,
    [id, org, nameKm, nameEn],
  );
  return id;
}

interface SeedOptions {
  /** SQL timestamptz per row; i = 0 is the newest by default. */
  createdAt?: (i: string) => string;
  status?: "ACTIVE" | "ARCHIVED" | "DRAFT";
  categoryId?: string | null;
  /** SQL text expression for name_en (null → no English name). */
  nameEn?: ((i: string) => string) | null;
  /** Variants per product (each with sku `<code>-V<n>`). */
  variants?: number;
}

/**
 * Insert `count` products named `<prefix>-00001` … in ONE statement (plus one
 * for their variants), so 10,000 products cost two statements, not 10,000.
 */
async function seedProducts(
  org: string,
  count: number,
  prefix: string,
  options: SeedOptions = {},
): Promise<void> {
  if (count === 0) return;
  const createdAt =
    options.createdAt ??
    ((i: string) => `timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => ${i})`);
  const nameEn = options.nameEn === undefined ? (i: string) => `'Item ' || ${i}` : options.nameEn;
  await f.db.query(
    `insert into products(id,organization_id,name_km,name_en,category_id,status,created_at)
     select gen_random_uuid(), $1, $2 || '-' || lpad((i + 1)::text, 5, '0'),
            ${nameEn ? nameEn("i") : "null"}, $3, $4::product_status, ${createdAt("i")}
       from generate_series(0, $5 - 1) as i`,
    [org, prefix, options.categoryId ?? null, options.status ?? "ACTIVE", count],
  );
  const variants = options.variants ?? 1;
  if (variants > 0) {
    await f.db.query(
      `insert into product_variants(organization_id,product_id,sku,barcode,name,price_amount,price_currency,
                                    cost_amount,cost_currency,created_at)
       select p.organization_id, p.id, p.name_km || '-V' || v, null, 'Size ' || v, 1000 + v, 'USD',
              400, 'USD', p.created_at + make_interval(secs => v)
         from products p cross join generate_series(1, $3) as v
        where p.organization_id = $1 and p.name_km like $2 || '-%'`,
      [org, prefix, variants],
    );
  }
}

/** One product with exactly these fields, and one variant; returns its id. */
async function product(
  org: string,
  fields: {
    nameKm: string;
    nameEn?: string | null;
    sku?: string | null;
    barcode?: string | null;
    variantName?: string;
    variantStatus?: "ACTIVE" | "ARCHIVED";
    status?: "ACTIVE" | "ARCHIVED";
    categoryId?: string | null;
    createdAt?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into products(id,organization_id,name_km,name_en,category_id,status,created_at)
     values($1,$2,$3,$4,$5,$6::product_status,coalesce($7::timestamptz, now()))`,
    [
      id,
      org,
      fields.nameKm,
      fields.nameEn ?? null,
      fields.categoryId ?? null,
      fields.status ?? "ACTIVE",
      fields.createdAt ?? null,
    ],
  );
  await f.db.query(
    `insert into product_variants(organization_id,product_id,sku,barcode,name,price_amount,price_currency,status)
     values($1,$2,$3,$4,$5,1500,'USD',$6::variant_status)`,
    [
      org,
      id,
      fields.sku ?? null,
      fields.barcode ?? null,
      fields.variantName ?? "",
      fields.variantStatus ?? "ACTIVE",
    ],
  );
  return id;
}

/**
 * The organization's products exactly as the list must show them, by a plain
 * SQL read independent of the code under test.
 */
async function dbOrder(
  org: string,
  where = "status = 'ACTIVE'",
  params: unknown[] = [],
): Promise<string[]> {
  const result = await f.db.query<{ name_km: string }>(
    `select name_km from products where organization_id = $1 and ${where}
      order by created_at desc, id desc`,
    [org, ...params],
  );
  return result.rows.map((row) => row.name_km);
}

// ── Principals: the route's (cache identity) and the server's (cookie) ──────

/** What the /app route guard resolved — the cache key's principal. */
const route = { userId: U1, organizationId: "" };
/** What the server resolves when a request is HANDLED (cookie + active org). */
const server: { userId: string | null; organizationId: string | null } = {
  userId: U1,
  organizationId: "",
};
/** What the capability snapshot says (presentation only; the server decides). */
let uiPermissions: string[] = ["products.read"];

function signInAs(userId: string, organizationId: string) {
  Object.assign(route, { userId, organizationId });
  Object.assign(server, { userId, organizationId });
}

// ── Supabase admin client → PGlite, answered the way PostgREST answers ──────

/** Supabase's default PostgREST max_rows: a longer answer is cut, silently. */
const MAX_ROWS = 1000;
/**
 * The max_rows this database answers under right now. A project can set it
 * lower than the default (or a proxy can cap a response), and nothing in the
 * response says so — section I runs the catalogue under 50 and 100.
 */
let maxRows = MAX_ROWS;
/** Every statement the transport ran: table, and rows returned. */
const statements: {
  table: string;
  rows: number;
  limit: number | undefined;
  /** The embedded child's own conditions, when the read used an !inner embed. */
  embedFilters: string[] | null;
  /** Whether the read asked for an exact count. */
  counted: boolean;
}[] = [];

function sqlTransport() {
  const identifier = (value: string) => {
    if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };
  // The one embed the catalogue search uses: products → product_variants.
  const EMBEDS: Record<string, { child: string; fk: string }> = {
    "products/product_variants": { child: "product_variants", fk: "product_id" },
  };
  function select(table: string) {
    const where: string[] = [];
    const embedWhere: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let embed: { name: string; child: string; fk: string; cols: string } | null = null;
    let single: "single" | "maybe" | null = null;
    let max: number | undefined;
    let skip: number | undefined;
    let counted = false;
    const target = (key: string): { list: string[]; column: string } => {
      const dot = key.indexOf(".");
      if (dot === -1) return { list: where, column: `t0.${identifier(key)}` };
      const [name, column] = [key.slice(0, dot), key.slice(dot + 1)];
      if (!embed || embed.name !== name) throw new Error(`Filter on unembedded ${key}`);
      return { list: embedWhere, column: `e.${identifier(column)}` };
    };
    const compare = (op: string) => (key: string, value: unknown) => {
      const { list, column } = target(key);
      values.push(value);
      list.push(`${column} ${op} $${values.length}`);
      return chain;
    };
    const chain: any = {
      select(cols = "*", options?: { count?: string }) {
        if (options?.count !== undefined && options.count !== "exact") {
          throw new Error(`Unsupported test count: ${options.count}`);
        }
        counted = options?.count === "exact";
        const embedded = /^\*, ([a-z_]+)!inner\(([a-z_]+)\)$/.exec(cols);
        if (embedded) {
          const spec = EMBEDS[`${table}/${embedded[1]}`];
          if (!spec) throw new Error(`Unsupported test embed: ${cols}`);
          embed = { name: embedded[1]!, ...spec, cols: identifier(embedded[2]!) };
          return chain;
        }
        if (cols !== "*" && !/^[a-z_0-9, ]+$/.test(cols)) {
          throw new Error(`Unsupported test select: ${cols}`);
        }
        columns = cols;
        return chain;
      },
      eq: compare("="),
      neq: compare("<>"),
      lt: compare("<"),
      gt: compare(">"),
      gte: compare(">="),
      // PostgREST expands "*" to "%" in a like/ilike value before Postgres sees it.
      ilike: (key: string, value: string) => compare("ilike")(key, value.replace(/\*/g, "%")),
      is(key: string, value: null) {
        if (value !== null) throw new Error("Unsupported test is()");
        const { list, column } = target(key);
        list.push(`${column} is null`);
        return chain;
      },
      in(key: string, list: unknown[]) {
        const { list: into, column } = target(key);
        const params = list.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        into.push(list.length ? `${column} in (${params.join(",")})` : "false");
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`t0.${identifier(key)} ${options.ascending ? "asc" : "desc"}`);
        return chain;
      },
      limit(n: number) {
        max = n;
        return chain;
      },
      range(from: number, to: number) {
        skip = from;
        max = to - from + 1;
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
        const conditions = [...where];
        let projection =
          columns === "*"
            ? "t0.*"
            : columns
                .split(",")
                .map((c) => `t0.${c.trim()}`)
                .join(",");
        if (embed) {
          const childFilter = [`e.${embed.fk} = t0.id`, ...embedWhere].join(" and ");
          conditions.push(`exists (select 1 from ${embed.child} e where ${childFilter})`);
          projection += `, (select coalesce(json_agg(json_build_object('${embed.cols}', e.${embed.cols})), '[]'::json)
                              from ${embed.child} e where ${childFilter}) as ${embed.name}`;
        }
        const filtered = conditions.length ? ` where ${conditions.join(" and ")}` : "";
        // Prefer: count=exact — the whole filtered set, past any limit or max_rows.
        const countSql = `select count(*)::int as n from ${table} t0${filtered}`;
        let inner = `select ${projection} from ${table} t0${filtered}`;
        if (ordering.length) inner += ` order by ${ordering.join(",")}`;
        const cap = Math.min(max ?? maxRows, maxRows);
        inner += ` limit ${cap}`;
        if (skip !== undefined) inner += ` offset ${skip}`;
        try {
          const result = await f.db.query<{ rows: unknown[] }>(
            `select coalesce(json_agg(t), '[]'::json) as rows from (${inner}) t`,
            values,
          );
          const rows = result.rows[0]!.rows as unknown[];
          const count = counted
            ? (await f.db.query<{ n: number }>(countSql, values)).rows[0]!.n
            : null;
          statements.push({
            table,
            rows: rows.length,
            limit: max,
            embedFilters: embed ? [...embedWhere] : null,
            counted,
          });
          if (single) {
            if (rows.length) return { data: rows[0], error: null };
            return single === "maybe"
              ? { data: null, error: null }
              : { data: null, error: { code: "PGRST116", message: "no rows" } };
          }
          return { data: rows, error: null, count };
        } catch (error) {
          return { data: null, error };
        }
      },
      then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
        return chain.execute().then(ok, fail);
      },
    };
    return chain;
  }
  return {
    from(table: string) {
      if (table === "audit_logs") return { insert: async () => ({ error: null }) };
      return select(identifier(table));
    },
  };
}

mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));

// ── createServerFn: the function's own validator, then its own handler ──────

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler(handler: (args: { data: unknown }) => unknown) {
          return async ({ data }: { data?: unknown } = {}) => handler({ data: validator(data) });
        },
      };
    },
    handler(handler: () => unknown) {
      return handler;
    },
  }),
}));

// ── Session and membership: answered from `server`, the handling-time principal

mock.module("@/api/auth", () => ({
  getSessionFn: async () =>
    server.userId ? { userId: server.userId, email: "x@test.invalid", emailVerified: true } : null,
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async (userId: string) =>
    server.userId === userId ? server.organizationId : null,
}));

const realMembership = { ...(await import("@/server/auth/membership")) };
mock.module("@/server/auth/membership", () => ({
  ...realMembership,
  verifyActiveMembership: async (userId: string, organizationId: string) => {
    const result = await f.db.query<any>(
      `select m.*, r.name as role_name, r.organization_id as role_org, r.system_role,
              coalesce(array_agg(p.key) filter (where p.key is not null), '{}') as permission_keys
         from memberships m
         join roles r on r.id = m.role_id
         left join role_permissions rp on rp.role_id = r.id
         left join permissions p on p.id = rp.permission_id
        where m.user_id = $1 and m.organization_id = $2 and m.status = 'active'
        group by m.id, r.id`,
      [userId, organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      membership: {
        id: row.id,
        user_id: row.user_id,
        organization_id: row.organization_id,
        role_id: row.role_id,
        status: row.status,
      },
      role: { id: row.role_id, organization_id: row.role_org, name: row.role_name },
      permissions: new Set<string>(row.permission_keys),
    };
  },
}));

// ── The product server functions: real, observed at the network boundary ────

const realProductsApi = { ...(await import("@/api/products")) } as Record<string, any>;

interface Call {
  fn: string;
  data: any;
  aborted: () => boolean;
}
/** Every product request as the browser sent it. */
const calls: Call[] = [];
/** The next N page requests fail on the wire and never reach the server. */
let failNext = 0;
/** When set, each page response is held (after the server answered) until released. */
let holding = false;
const held: (() => void)[] = [];

function observed(name: string) {
  const real = realProductsApi[name];
  if (typeof real !== "function") return real;
  return async (args: { data?: unknown; signal?: AbortSignal } = {}) => {
    const signal = args.signal;
    calls.push({
      fn: name,
      data: JSON.parse(JSON.stringify(args.data ?? null)),
      aborted: () => Boolean(signal?.aborted),
    });
    if (name === "listProductsPageFn" && failNext > 0) {
      failNext -= 1;
      throw new TypeError("Failed to fetch");
    }
    // The server handles the request NOW, as whoever `server` names now.
    const outcome = await real(args).then(
      (value: unknown) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (holding && name === "listProductsPageFn") {
      await new Promise<void>((resolve) => held.push(resolve));
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
}

mock.module("@/api/products", () => ({
  ...realProductsApi,
  listProductsFn: observed("listProductsFn"),
  listProductsPageFn: observed("listProductsPageFn"),
  listCategoriesFn: observed("listCategoriesFn"),
}));

/** Only the Products list's own page requests. */
const pageCalls = () => calls.filter((c) => c.fn === "listProductsPageFn");

/** The real server function, called as the server principal, outside any screen. */
async function page(data: Record<string, unknown> = {}): Promise<any> {
  return realProductsApi.listProductsPageFn({ data });
}

/** Walk every page of one question through the real server function. */
async function walk(
  data: Record<string, unknown> = {},
): Promise<{ names: string[]; pages: number; products: any[] }> {
  const names: string[] = [];
  const products: any[] = [];
  let before: unknown = undefined;
  let pages = 0;
  for (;;) {
    const result = await page({ ...data, ...(before ? { before } : {}) });
    pages += 1;
    for (const p of result.products) {
      names.push(p.nameKm);
      products.push(p);
    }
    if (!result.nextCursor) break;
    before = result.nextCursor;
    if (pages > 5000) throw new Error("walk never ended");
  }
  return { names, pages, products };
}

// ── Capabilities: the real view, for the route's principal ───────────────────

const { createCapabilityView } = await import("@/lib/capabilities");
const realCapabilitiesHook = { ...(await import("@/hooks/use-capabilities")) };
mock.module("@/hooks/use-capabilities", () => ({
  ...realCapabilitiesHook,
  useCapabilities: () =>
    createCapabilityView({
      result: {
        status: "active",
        userId: route.userId,
        organizationId: route.organizationId,
        role: null,
        permissions: uiPermissions as any,
      },
      isPending: false,
      isError: false,
      expectedUserId: route.userId,
      expectedOrganizationId: route.organizationId,
    }),
}));

// ── DOM and router ───────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app/products" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigations: string[] = [];
const realRouter = await import("@tanstack/react-router");
const { createElement } = await import("react");

mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => ({
      session: { userId: route.userId },
      organizationId: route.organizationId,
    }),
  }),
  Link: ({ children, to: _to, params: _params, search: _search, ...rest }: any) =>
    createElement("a", rest, children),
  Outlet: () => null,
  useNavigate: () => (opts: { to: string }) => {
    navigations.push(opts.to);
    return Promise.resolve();
  },
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app/products" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

const reducedMotionQuery = (query: string) => ({
  matches: query.includes("reduce"),
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = reducedMotionQuery;
(globalThis as any).matchMedia = reducedMotionQuery;
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, useQueryClient } = await import("@tanstack/react-query");
const { CATALOG_QUERY_ROOT, catalogKeys, enforceCatalogCachePrincipal } =
  await import("@/lib/catalog");
const i18n = (await import("@/lib/i18n")).default;
const { Route } = await import("@/routes/app.products");
const ProductListScreen = (Route as any).component as () => React.ReactElement;

/** The /app layout's part in this: enforce the cache principal during render. */
function AppLayout() {
  const queryClient = useQueryClient();
  enforceCatalogCachePrincipal(queryClient, route.userId, route.organizationId);
  return createElement(ProductListScreen);
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

function tree() {
  return createElement(QueryClientProvider, { client }, createElement(AppLayout));
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** At least 80 rounds AND 5 s of real time — never machine-speed dependent. */
async function waitFor(check: () => boolean, label: string) {
  const started = Date.now();
  for (let round = 0; ; round++) {
    if (check()) return;
    if (round >= 80 && Date.now() - started > 5000) {
      throw new Error(`Timed out waiting: ${label}. Screen: ${text().slice(0, 300)}`);
    }
    await settle(1);
  }
}

/** Nothing fetching for four consecutive rounds (a finished read can start another). */
async function readsSettled() {
  let quiet = 0;
  await waitFor(() => {
    quiet = client.isFetching() === 0 ? quiet + 1 : 0;
    return quiet >= 4;
  }, "reads settled");
}

async function mount(options: { client?: InstanceType<typeof QueryClient> } = {}) {
  client =
    options.client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await readsSettled();
}

async function rerender() {
  await act(async () => root!.render(tree()));
  await readsSettled();
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  calls.length = 0;
  statements.length = 0;
  failNext = 0;
  maxRows = MAX_ROWS;
  holding = false;
  while (held.length) held.shift()!();
  navigations.length = 0;
  uiPermissions = ["products.read"];
  if (i18n.language !== "en") await i18n.changeLanguage("en");
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";

/** Product Khmer names on screen, top to bottom. */
function shown(): string[] {
  // Product rows only: the bottom navigation's links carry no product name.
  return [...document.querySelectorAll("a")]
    .map((a) => a.querySelector('[lang="km"] .chip-text')?.textContent ?? null)
    .filter((name): name is string => name !== null);
}

function buttonNamed(name: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find(
      (b) => (b.textContent ?? "").trim() === name,
    ) ?? null
  );
}

const LOAD_MORE = "Load more products";
const RETRY = "Try again";
const END = "That's every product in this list";
const END_SEARCH = "No more matches";
const EMPTY = "No products yet";
const NO_MATCHES = "Nothing matches that";

async function tap(name: string) {
  const button = buttonNamed(name);
  if (!button) throw new Error(`No "${name}" button. Screen: ${text().slice(0, 400)}`);
  await act(async () => {
    button.click();
  });
}

/** Tap Load more until it is gone; returns the number of taps. */
async function loadEverything(): Promise<number> {
  let taps = 0;
  while (buttonNamed(LOAD_MORE)) {
    await tap(LOAD_MORE);
    await readsSettled();
    taps += 1;
    if (taps > 60) throw new Error("Load more never ended");
  }
  return taps;
}

function searchBox(): HTMLInputElement {
  const input = document.querySelector('input[type="search"]') as HTMLInputElement | null;
  if (!input) throw new Error(`No search box. Screen: ${text().slice(0, 300)}`);
  return input;
}

/** Type into the search box the way React sees a keystroke. */
async function type(value: string) {
  const input = searchBox();
  const setter = Object.getOwnPropertyDescriptor(
    (window as any).HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  });
}

/** Type, then wait until the search has been asked and answered. */
async function search(value: string) {
  const before = pageCalls().length;
  await type(value);
  await waitFor(() => pageCalls().length > before, `search "${value}" asked`);
  await readsSettled();
}

function expectNoDuplicates(names: string[]) {
  expect(new Set(names).size).toBe(names.length);
}

// ── A. Size boundaries ───────────────────────────────────────────────────────

describe("A. the list has no ceiling — size boundaries, mounted", () => {
  it("A1. 0 products: the empty state, and no Load more or end-of-list claim", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    await mount();

    expect(text()).toContain(EMPTY);
    expect(shown()).toEqual([]);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).not.toContain(END);
  });

  it("A2. 1 product: one row, the end of the list, no Load more", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1, "ONE");
    signInAs(U1, org);
    await mount();

    expect(shown()).toEqual(["ONE-00001"]);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END);
    expect(text()).toContain("1 product shown");
  });

  it("A3. exactly one page (50): end proven by the server's probe row, one request", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 50, "FIFTY");
    signInAs(U1, org);
    await mount();

    expect(shown()).toEqual(await dbOrder(org));
    expect(shown()).toHaveLength(50);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END);
    expect(pageCalls()).toHaveLength(1);
  });

  it("A4. 200 products — the old ceiling: four pages, every product once, then the end", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 200, "TWOH");
    signInAs(U1, org);
    await mount();

    expect(shown()).toHaveLength(50);
    expect(text()).toContain("Showing 50 products");
    const taps = await loadEverything();

    expect(taps).toBe(3);
    expect(shown()).toEqual(await dbOrder(org));
    expectNoDuplicates(shown());
    expect(text()).toContain(END);
    expect(text()).toContain("200 products shown");
    // No page claims a limit any more.
    expect(text()).not.toMatch(/first 200/i);
  });

  it("A5. 201 products: the 201st — invisible before this change — is reached", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 201, "TWOHONE");
    signInAs(U1, org);
    await mount();

    await loadEverything();
    expect(shown()).toHaveLength(201);
    expect(shown()).toEqual(await dbOrder(org));
    expect(shown()[200]).toBe("TWOHONE-00201");
    expect(text()).toContain("201 products shown");
    // Every continuation request named a cursor and nothing else positional.
    for (const call of pageCalls().slice(1)) {
      expect(Object.keys(call.data.before).sort()).toEqual(["createdAt", "id"]);
      expect(call.data.offset).toBeUndefined();
    }
  });

  it("A6. 1,000 products through the real server function: 20 pages, each product once, in order", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1000, "THOU");
    signInAs(U1, org);

    const walked = await walk();
    expect(walked.pages).toBe(20);
    expect(walked.names).toEqual(await dbOrder(org));
    expectNoDuplicates(walked.names);
  });

  it("A7. 10,000 products through the real server function: 200 pages, each product once, in order", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 10_000, "TENK");
    signInAs(U1, org);

    statements.length = 0;
    const walked = await walk();
    expect(walked.pages).toBe(200);
    expect(walked.names).toHaveLength(10_000);
    expect(walked.names).toEqual(await dbOrder(org));
    // No read ever asked for, or got, more than one page plus its probe row.
    const productReads = statements.filter((s) => s.table === "products");
    expect(Math.max(...productReads.map((s) => s.rows))).toBeLessThanOrEqual(51);
    expect(productReads.every((s) => s.limit! >= 1 && s.limit! <= 51)).toBe(true);
    // One read for page one, a same-instant/older pair for each later page,
    // and on the last page one read of the caller's ids that proves the API
    // sends at least 51 rows — so that page's 50-row answer was not cut.
    expect(productReads).toHaveLength(1 + 199 * 2 + 1);
  });
});

// ── B. Cursor correctness ────────────────────────────────────────────────────

describe("B. the cursor neither repeats nor skips", () => {
  it("B1. 130 products sharing ONE created_at (a one-transaction import): every product once, id order", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 130, "SAME", {
      createdAt: () => `timestamptz '2026-10-01 12:00:00.123456+00'`,
    });
    signInAs(U1, org);

    const walked = await walk();
    expect(walked.pages).toBe(3);
    expect(walked.names).toEqual(await dbOrder(org));
    expectNoDuplicates(walked.names);
  });

  it("B2. microseconds apart: the cursor keeps them, so neither row is lost", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 120, "MICRO", {
      createdAt: (i) =>
        `timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => ${i} * 0.000001)`,
    });
    signInAs(U1, org);

    const walked = await walk();
    expect(walked.names).toEqual(await dbOrder(org));
    const first = await page();
    expect(first.nextCursor.createdAt).toMatch(/\.\d{6}|\.\d{1,5}\+/);
  });

  it("B3. products created between page reads appear on refresh, never as a duplicate or a gap", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 120, "LIVE");
    signInAs(U1, org);
    await mount();

    await seedProducts(org, 7, "NEWER", {
      createdAt: (i) => `timestamptz '2026-10-02 12:00:00+00' - make_interval(secs => ${i})`,
    });
    await loadEverything();

    // The walk that was already under way finished the ORIGINAL list exactly.
    expect(shown()).toEqual(await dbOrder(org, "name_km like 'LIVE-%'"));
    expectNoDuplicates(shown());

    // Refresh (what Create Product's invalidation does): the new ones lead.
    await act(async () => {
      await client.invalidateQueries({ queryKey: [CATALOG_QUERY_ROOT, U1, org] });
    });
    await readsSettled();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org));
    expect(
      shown()
        .slice(0, 7)
        .every((n) => n.startsWith("NEWER-")),
    ).toBe(true);
  });

  it("B4. a page whose products carry 30 variants each: every variant arrives (PostgREST cuts at 1,000 rows)", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 60, "WIDE", { variants: 30 });
    signInAs(U1, org);

    const first = await page();
    expect(first.products).toHaveLength(50);
    const variantCount = first.products.reduce((n: number, p: any) => n + p.variants.length, 0);
    // 50 × 30 = 1,500 rows: one unchunked read would have stopped at 1,000.
    expect(variantCount).toBe(1500);
    expect(first.products.every((p: any) => p.variants.length === 30)).toBe(true);
    // Oldest first within each product, as before.
    const sizes = first.products[0].variants.map((v: any) => v.name);
    expect(sizes.slice(0, 3)).toEqual(["Size 1", "Size 2", "Size 3"]);
  });

  it("B5. one product with 1,200 variants: all 1,200, through the id-keyset continuation", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1, "HUGE", { variants: 1200 });
    signInAs(U1, org);
    statements.length = 0;

    const first = await page();
    expect(first.products[0].variants).toHaveLength(1200);
    const variantReads = statements.filter((s) => s.table === "product_variants");
    // The first read's exact count (1,200) says it is incomplete; the 200-row
    // read is short, but only the empty one after it proves the end.
    expect(variantReads.map((s) => s.rows)).toEqual([1000, 200, 0]);
    expect(variantReads.map((s) => s.counted)).toEqual([true, false, false]);
  });

  it("B6. the whole-catalogue read POS still uses gets every variant for 250 products (URL chunking)", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 250, "POS", { variants: 5 });
    signInAs(U1, org);
    statements.length = 0;

    const all = await realProductsApi.listProductsFn({ data: { status: "ACTIVE" } });
    expect(all).toHaveLength(250);
    expect(all.every((p: any) => p.variants.length === 5)).toBe(true);
    const variantReads = statements.filter((s) => s.table === "product_variants");
    // 250 ids → three groups of at most 100: no read carries a 250-id URL.
    expect(variantReads).toHaveLength(3);
  });
});

// ── C. Search across the whole catalogue ─────────────────────────────────────

describe("C. search asks the server, across the whole catalogue", () => {
  it("C1. finds the OLDEST of 260 products — far past the old 200-row page — from the first keystrokes", async () => {
    const { org } = await newOrg();
    await product(org, {
      nameKm: "កាហ្វេទឹកដោះគោ",
      nameEn: "Iced milk coffee",
      sku: "CF-001",
      createdAt: "2026-01-01 00:00:00+00",
    });
    await seedProducts(org, 260, "FILL");
    signInAs(U1, org);
    await mount();
    expect(shown()).not.toContain("កាហ្វេទឹកដោះគោ");

    await search("កាហ្វេ");
    expect(shown()).toEqual(["កាហ្វេទឹកដោះគោ"]);
    expect(text()).toContain(END_SEARCH);
    expect(pageCalls().at(-1)!.data).toEqual({ status: "ACTIVE", search: "កាហ្វេ" });
  });

  it("C2. Khmer name, English name (any case), SKU, barcode, variant name and Khmer-keyboard digits", async () => {
    const { org } = await newOrg();
    await product(org, {
      nameKm: "តែបៃតង",
      nameEn: "Green Tea",
      sku: "TEA-77",
      barcode: "8850123",
    });
    await product(org, {
      nameKm: "នំបុ័ង",
      nameEn: null,
      sku: "BRD-01",
      variantName: "Large loaf",
    });
    await product(org, { nameKm: "ទឹកក្រូច", nameEn: "Orange juice" });
    signInAs(U1, org);

    const names = async (q: string) => (await walk({ search: q })).names;
    expect(await names("តែ")).toEqual(["តែបៃតង"]);
    expect(await names("GREEN tea")).toEqual(["តែបៃតង"]);
    expect(await names("tea-77")).toEqual(["តែបៃតង"]);
    expect(await names("8850")).toEqual(["តែបៃតង"]);
    expect(await names("៨៨៥០")).toEqual(["តែបៃតង"]);
    expect(await names("large")).toEqual(["នំបុ័ង"]);
    expect(await names("brd")).toEqual(["នំបុ័ង"]);
    expect(await names("nothing-like-this")).toEqual([]);
    // A zero-width space a Khmer keyboard inserted, and stray whitespace, are not part of the question.
    expect(await names("  ទឹក\u200Bក្រូច  ")).toEqual(["ទឹកក្រូច"]);
  });

  it("C3. LIKE metacharacters are literal: '100%' and 'A_B' match only themselves", async () => {
    const { org } = await newOrg();
    await product(org, { nameKm: "ទឹក 100% ធម្មជាតិ", nameEn: "100% natural" });
    await product(org, { nameKm: "ទឹក 1000", nameEn: "1000 ml" });
    await product(org, { nameKm: "កូដ", sku: "A_B-1" });
    await product(org, { nameKm: "កូដ២", sku: "AXB-1" });
    signInAs(U1, org);

    expect((await walk({ search: "100%" })).names).toEqual(["ទឹក 100% ធម្មជាតិ"]);
    expect((await walk({ search: "a_b" })).names).toEqual(["កូដ"]);
    expect((await walk({ search: "\\" })).names).toEqual([]);
  });

  it("C4. filter-grammar text is just text: commas, parentheses and PostgREST operators match nothing extra", async () => {
    const { org } = await newOrg();
    const other = await newOrg();
    await product(other.org, { nameKm: "SECRET-OTHER-ORG", sku: "X1" });
    await product(org, { nameKm: "ធម្មតា", nameEn: "plain" });
    signInAs(U1, org);

    for (const q of [
      "a,organization_id.neq.x",
      "plain),or(name_km.ilike.*",
      "*",
      "%",
      "') or 1=1 --",
      "SECRET",
    ]) {
      const { names } = await walk({ search: q });
      expect(names).not.toContain("SECRET-OTHER-ORG");
    }
    // "*" is PostgREST's wildcard and cannot be escaped: it over-matches the
    // caller's OWN catalogue, never anyone else's.
    expect((await walk({ search: "*" })).names).toEqual(["ធម្មតា"]);
  });

  it("C5. a product that matches on several fields appears once; search pages like the list", async () => {
    const { org } = await newOrg();
    // 120 products that all match "tea" on name AND on SKU.
    await seedProducts(org, 120, "TEA", { nameEn: (i) => `'Tea blend ' || ${i}` });
    await seedProducts(org, 30, "COFFEE", { nameEn: (i) => `'Coffee ' || ${i}` });
    signInAs(U1, org);
    await mount();

    await search("tea");
    expect(shown()).toHaveLength(50);
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "name_km like 'TEA-%'"));
    expectNoDuplicates(shown());
    expect(text()).toContain("120 matching products shown");
    // Every page of the walk asked the same question.
    expect(
      new Set(
        pageCalls()
          .slice(1)
          .map((c) => c.data.search),
      ),
    ).toEqual(new Set(["tea"]));
  });

  it("C6. an ARCHIVED variant's SKU does not make its product match", async () => {
    const { org } = await newOrg();
    await product(org, { nameKm: "ចាស់", sku: "OLD-SKU-9", variantStatus: "ARCHIVED" });
    signInAs(U1, org);
    expect((await walk({ search: "OLD-SKU" })).names).toEqual([]);
  });

  it("C7. typing 'c','co','cof','coffee' quickly asks the server once, for the settled text", async () => {
    const { org } = await newOrg();
    await product(org, { nameKm: "កាហ្វេ", nameEn: "Coffee" });
    await product(org, { nameKm: "កូកូ", nameEn: "Cocoa" });
    signInAs(U1, org);
    await mount();
    const before = pageCalls().length;

    for (const partial of ["c", "co", "cof", "coffee"]) await type(partial);
    await waitFor(() => pageCalls().length > before, "debounced search asked");
    await readsSettled();

    const searches = pageCalls()
      .slice(before)
      .map((c) => c.data.search);
    expect(searches).toEqual(["coffee"]);
    expect(shown()).toEqual(["កាហ្វេ"]);
  });

  it("C8. a late answer to an earlier search never replaces the current one, and its request is aborted", async () => {
    const { org } = await newOrg();
    await product(org, { nameKm: "កាហ្វេ", nameEn: "Coffee" });
    await product(org, { nameKm: "កូកូ", nameEn: "Cocoa" });
    signInAs(U1, org);
    await mount();

    holding = true;
    await type("co");
    await waitFor(() => pageCalls().some((c) => c.data.search === "co"), "'co' asked");
    await settle();
    const early = pageCalls().find((c) => c.data.search === "co")!;
    await type("cocoa");
    await waitFor(() => pageCalls().some((c) => c.data.search === "cocoa"), "'cocoa' asked");
    // Release the LATE answer to "co" after "cocoa" was asked.
    while (held.length) held.shift()!();
    holding = false;
    await readsSettled();

    expect(early.aborted()).toBe(true);
    expect(shown()).toEqual(["កូកូ"]);
    expect(
      client.getQueryData(
        catalogKeys.productPagesFor(U1, org, {
          status: "ACTIVE",
          categoryId: null,
          search: "co",
        }),
      ),
    ).toBeUndefined();
  });

  it("C10. every variant-side search read is bound to the caller's organization (the work, not just the result)", async () => {
    const { org } = await newOrg();
    await product(org, { nameKm: "តែ", sku: "TEA-1" });
    signInAs(U1, org);
    statements.length = 0;

    await walk({ search: "tea" });
    const embedded = statements.filter((s) => s.embedFilters !== null);
    // Variant name, SKU and barcode: three reads, plus the SKU read's
    // continuation pair (its one-row answer is short, which proves nothing
    // until an empty answer does) — every one naming the organization.
    expect(embedded).toHaveLength(3 + 2);
    for (const read of embedded) {
      expect(read.embedFilters!.some((c) => c.startsWith("e.organization_id = "))).toBe(true);
      expect(read.embedFilters!.some((c) => c.startsWith("e.status = "))).toBe(true);
    }
  });

  it("C9. no matches: says so, and Clear search returns to the whole list", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 3, "ROW");
    signInAs(U1, org);
    await mount();

    await search("zzzz-not-here");
    expect(text()).toContain(NO_MATCHES);
    expect(shown()).toEqual([]);
    expect(text()).not.toContain(EMPTY);

    await tap("Clear search");
    await readsSettled();
    expect(searchBox().value).toBe("");
    expect(shown()).toEqual(await dbOrder(org));
  });
});

// ── D. Status and category ───────────────────────────────────────────────────

describe("D. status and category narrow the server's answer", () => {
  it("D1. Active / Archived each page their own list, and switching starts at page one", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 70, "ACT");
    await seedProducts(org, 60, "ARC", { status: "ARCHIVED" });
    await seedProducts(org, 4, "DRF", { status: "DRAFT" });
    signInAs(U1, org);
    await mount();

    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org));

    const before = pageCalls().length;
    await tap("Archived");
    await readsSettled();
    expect(pageCalls()[before]!.data).toEqual({ status: "ARCHIVED" });
    expect(shown()).toHaveLength(50);
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "status = 'ARCHIVED'"));
    // The list left behind was dropped, not kept with its walked pages.
    expect(
      client.getQueryData(
        catalogKeys.productPagesFor(U1, org, { status: "ACTIVE", categoryId: null, search: "" }),
      ),
    ).toBeUndefined();
    // DRAFT is not offered by this screen, but the server pages it honestly.
    expect((await walk({ status: "DRAFT" })).names).toEqual(await dbOrder(org, "status = 'DRAFT'"));
  });

  it("D2. a category pages only its products; search combines with category and with Archived", async () => {
    const { org } = await newOrg();
    const drinks = await newCategory(org, "ភេសជ្ជៈ", "Drinks");
    await seedProducts(org, 55, "DRINK", { categoryId: drinks, nameEn: (i) => `'Tea ' || ${i}` });
    await seedProducts(org, 40, "FOOD", { nameEn: (i) => `'Tea cake ' || ${i}` });
    await seedProducts(org, 5, "OLDDRINK", {
      categoryId: drinks,
      status: "ARCHIVED",
      nameEn: (i) => `'Tea ' || ${i}`,
    });
    signInAs(U1, org);
    await mount();

    // Category chips follow the app language setting (Khmer by default).
    await tap("ភេសជ្ជៈ");
    await readsSettled();
    expect(pageCalls().at(-1)!.data).toEqual({ status: "ACTIVE", categoryId: drinks });
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "category_id = $2 and status = 'ACTIVE'", [drinks]));

    await search("tea");
    await loadEverything();
    expect(shown()).toHaveLength(55);
    expect(shown().every((n) => n.startsWith("DRINK-"))).toBe(true);

    await tap("Archived");
    await readsSettled();
    expect(pageCalls().at(-1)!.data).toEqual({
      status: "ARCHIVED",
      categoryId: drinks,
      search: "tea",
    });
    expect(shown()).toEqual(
      await dbOrder(org, "category_id = $2 and status = 'ARCHIVED'", [drinks]),
    );

    await tap("All");
    await readsSettled();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "status = 'ARCHIVED'"));
  });

  it("D3. an empty category says so — not 'no products yet'", async () => {
    const { org } = await newOrg();
    await newCategory(org, "ផ្សេងៗ", "Misc");
    await seedProducts(org, 3, "ANY");
    signInAs(U1, org);
    await mount();

    await tap("ផ្សេងៗ");
    await readsSettled();
    expect(text()).toContain("Nothing in this category");
    expect(text()).not.toContain(EMPTY);
  });

  it("D4. another organization's category id matches nothing — it never widens the read", async () => {
    const { org } = await newOrg();
    const other = await newOrg();
    const foreign = await newCategory(other.org, "បរទេស", "Foreign");
    await seedProducts(other.org, 5, "THEIRS", { categoryId: foreign });
    await seedProducts(org, 5, "MINE");
    signInAs(U1, org);

    expect((await walk({ categoryId: foreign })).names).toEqual([]);
  });
});

// ── E. Network failures ──────────────────────────────────────────────────────

describe("E. a failed page is retried, never mistaken for the end", () => {
  it("E1. first page fails: the error and Try again, then the list", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 5, "NET");
    signInAs(U1, org);
    // The first try and both of the screen's quiet retries.
    failNext = 3;
    await mount();

    expect(text()).toContain("Products didn't load");
    expect(text()).not.toContain(EMPTY);
    await tap(RETRY);
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org));
  });

  it("E2. Load more fails: rows stay, the list says it is incomplete, Try again continues from the same cursor", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 80, "MORE");
    signInAs(U1, org);
    await mount();

    failNext = 3;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toHaveLength(50);
    expect(text()).toContain("More products didn't load");
    expect(text()).not.toContain(END);

    await tap(RETRY);
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org));
    const [failed, retried] = pageCalls().slice(-2);
    expect(retried!.data.before).toEqual(failed!.data.before);
  });
});

// ── F. Principal isolation ───────────────────────────────────────────────────

describe("F. principal isolation", () => {
  it("F1. Organization A → B → A in one tab: never a row of the other, cache emptied at each switch", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 60, "ORGA");
    await seedProducts(b.org, 60, "ORGB");
    signInAs(U1, a.org);
    await mount();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(a.org));

    signInAs(U1, b.org);
    await rerender();
    expect(shown().every((n) => n.startsWith("ORGB-"))).toBe(true);
    expect(client.getQueryCache().findAll({ queryKey: [CATALOG_QUERY_ROOT, U1, a.org] })).toEqual(
      [],
    );

    signInAs(U1, a.org);
    await rerender();
    expect(shown().every((n) => n.startsWith("ORGA-"))).toBe(true);
    // Back on A it starts again at page one — B's walk did not continue A's.
    expect(shown()).toHaveLength(50);
  });

  it("F2. member A → member B of the SAME organization: B's own permissions decide cost", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 3, "COST");
    signInAs(U1, org);
    const owner = await page();
    expect(owner.products[0].variants[0].cost).toEqual({ amount: 400, currency: "USD" });

    signInAs(U2, org);
    const viewer = await page();
    expect(viewer.servedAs).toEqual({ userId: U2, organizationId: org });
    expect(viewer.products[0].variants.every((v: any) => v.cost === null)).toBe(true);
  });

  it("F3. a sign-in in another tab between two pages: the late page is refused and every row leaves", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 80, "TABA");
    await seedProducts(b.org, 80, "TABB");
    signInAs(U1, a.org);
    await mount();

    // The cookie now names organization B; the screen still belongs to A.
    Object.assign(server, { userId: U1, organizationId: b.org });
    await tap(LOAD_MORE);
    await readsSettled();

    expect(shown()).toEqual([]);
    expect(text()).toContain("You switched account or business");
    expect(text()).not.toContain("TABB-");
  });

  it("F4. a delayed SEARCH answer that arrives after the principal changed is refused", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await product(a.org, { nameKm: "របស់A", nameEn: "shared word" });
    await product(b.org, { nameKm: "របស់B", nameEn: "shared word" });
    signInAs(U1, a.org);
    await mount();

    Object.assign(server, { userId: U1, organizationId: b.org });
    await search("shared");
    expect(shown()).toEqual([]);
    expect(text()).not.toContain("របស់B");
    expect(text()).toContain("You switched account or business");
  });

  it("F5. session expiry: the next page is unauthorized — rows leave and the merchant is sent to sign in", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 80, "EXP");
    signInAs(U1, org);
    await mount();

    Object.assign(server, { userId: null, organizationId: null });
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(navigations).toContain("/sign-in");
    // Not retried: an answer about WHO is asking cannot change on retry.
    expect(pageCalls()).toHaveLength(2);
  });

  it("F6. products.read revoked mid-session: the next page is refused and every loaded row leaves", async () => {
    const { org, viewerRole } = await newOrg();
    await seedProducts(org, 80, "REV");
    signInAs(U2, org);
    await mount();
    expect(shown()).toHaveLength(50);

    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(text()).toContain("You can't view products");
    // Search is not offered over a list the server refuses.
    expect(document.querySelector('input[type="search"]')).toBeNull();
    // And the server refuses a direct call too.
    await expect(page()).rejects.toThrow(/Missing permission/);
  });

  it("F7. refresh/remount with a new QueryClient starts at page one under the route's principal", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 80, "RLD");
    signInAs(U1, org);
    await mount();
    await loadEverything();
    await unmount();
    calls.length = 0;

    await mount();
    expect(shown()).toHaveLength(50);
    expect(pageCalls()).toHaveLength(1);
    expect(pageCalls()[0]!.data.before).toBeUndefined();
  });
});

// ── G. Cursor validation at the server boundary ──────────────────────────────

describe("G. a cursor is validated, and is only ever a position in the caller's own catalogue", () => {
  it("G1. malformed cursors and smuggled fields are refused by the validator", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    const id = crypto.randomUUID();
    const bad: Record<string, unknown>[] = [
      { before: { createdAt: "yesterday", id } },
      { before: { createdAt: "2026-10-01T12:00:00+00:00", id: "not-a-uuid" } },
      { before: { createdAt: "2026-10-01T12:00:00+00:00'; drop table products; --", id } },
      { before: { createdAt: "2026-10-01T12:00:00+00:00", id, organizationId: org } },
      { before: { createdAt: "2026-13-45T99:99:99+00:00", id } },
      { organizationId: org },
      { offset: 50 },
      { limit: 500 },
      { limit: 0 },
      { categoryId: "drinks" },
      { status: "DELETED" },
      { search: "x".repeat(401) },
    ];
    for (const data of bad) {
      await expect(page(data)).rejects.toThrow();
    }
  });

  it("G2. another organization's cursor only moves through the caller's own rows", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 60, "MINEA");
    await seedProducts(b.org, 60, "THEIRB", {
      createdAt: (i) => `timestamptz '2026-10-01 12:00:30+00' - make_interval(secs => ${i})`,
    });
    signInAs(U1, b.org);
    const foreign = (await page()).nextCursor;

    signInAs(U1, a.org);
    const result = await page({ before: foreign });
    expect(result.products.every((p: any) => p.organizationId === a.org)).toBe(true);
    // Strictly after the foreign position in (created_at, id) order — a row
    // sharing its instant with a smaller id belongs after it too.
    const expected = await dbOrder(a.org, "(created_at, id) < ($2::timestamptz, $3::uuid)", [
      foreign.createdAt,
      foreign.id,
    ]);
    expect(result.products.map((p: any) => p.nameKm)).toEqual(expected.slice(0, 50));
  });

  it("G3. a page's search is normalized once, on the server, and echoed back", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    const result = await page({ search: "  green\u200B   tea  " });
    expect(result.query).toEqual({ status: "ACTIVE", categoryId: null, search: "green tea" });
    expect(result.servedAs).toEqual({ userId: U1, organizationId: org });
  });
});

// ── H. Khmer on screen ───────────────────────────────────────────────────────

describe("H. Khmer", () => {
  it("H1. in Khmer the search, Load more and end of list read in Khmer", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 60, "KM");
    signInAs(U1, org);
    await i18n.changeLanguage("km");
    await mount();

    expect(searchBox().placeholder).toBe("ស្វែងរកទំនិញទាំងអស់");
    await tap("ផ្ទុកទំនិញបន្ថែម");
    await readsSettled();
    expect(text()).toContain("នេះជាទំនិញទាំងអស់ក្នុងបញ្ជីនេះ");
    expect(shown()).toHaveLength(60);
  });
});

// ── I. Under a lower API row cap ─────────────────────────────────────────────
//
// PostgREST cuts a response at max_rows without an error, and a project (or a
// proxy) can set that lower than the page plus its probe row. Nothing in the
// response says it was cut, so a short read proves nothing: only an EMPTY read
// proves the end. Every case here failed before that rule — the list stopped
// at the cap and said "That's every product".

/** The organization's products, newest first, with ids, by plain SQL. */
async function dbRows(org: string, where = "status = 'ACTIVE'", params: unknown[] = []) {
  const result = await f.db.query<{ id: string; name_km: string }>(
    `select id, name_km from products where organization_id = $1 and ${where}
      order by created_at desc, id desc`,
    [org, ...params],
  );
  return result.rows;
}

describe("I. a capped API response is never taken as the end of the list", () => {
  it("I1. max_rows 50, 201 products, mounted: Load more reaches all 201, then the end", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 201, "CAP");
    signInAs(U1, org);
    maxRows = 50;
    await mount();

    expect(shown()).toHaveLength(50);
    expect(buttonNamed(LOAD_MORE)).not.toBeNull();
    expect(text()).not.toContain(END);
    const taps = await loadEverything();

    expect(taps).toBe(4);
    expect(shown()).toEqual(await dbOrder(org));
    expectNoDuplicates(shown());
    expect(text()).toContain(END);
    expect(text()).toContain("201 products shown");
    // The cap was real: no read came back with more than 50 rows.
    expect(Math.max(...statements.map((s) => s.rows))).toBeLessThanOrEqual(50);
  });

  it("I2. max_rows 50, 1,000 products: 20 full pages through the server function, each product once, in order", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1000, "CAPK");
    signInAs(U1, org);
    maxRows = 50;

    const walked = await walk();
    expect(walked.pages).toBe(20);
    expect(walked.names).toEqual(await dbOrder(org));
    expect(walked.products.every((p: any) => p.variants.length === 1)).toBe(true);
  });

  it("I3. max_rows 100: the default page and the largest page (100) both walk 1,000 products exactly", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1000, "CAPH");
    signInAs(U1, org);
    maxRows = 100;

    expect((await walk()).names).toEqual(await dbOrder(org));
    const largest = await walk({ limit: 100 });
    expect(largest.pages).toBe(10);
    expect(largest.names).toEqual(await dbOrder(org));
  });

  it("I4. max_rows 50 inside a 130-product same-instant burst, between older and newer rows: no gap, no repeat", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 30, "NEWR", {
      createdAt: (i) => `timestamptz '2026-10-02 12:00:00+00' - make_interval(secs => ${i})`,
    });
    await seedProducts(org, 130, "BURST", {
      createdAt: () => `timestamptz '2026-10-01 12:00:00.123456+00'`,
    });
    await seedProducts(org, 30, "OLDR", {
      createdAt: (i) => `timestamptz '2026-09-30 12:00:00+00' - make_interval(secs => ${i})`,
    });
    signInAs(U1, org);
    maxRows = 50;

    for (const limit of [50, 100, 7]) {
      const walked = await walk({ limit });
      expect(walked.products.map((p: any) => p.id)).toEqual((await dbRows(org)).map((r) => r.id));
    }
  });

  it("I5. max_rows 50: a category and the Archived list each walk completely", async () => {
    const { org } = await newOrg();
    const drinks = await newCategory(org, "ភេសជ្ជៈ", "Drinks");
    await seedProducts(org, 120, "CDRINK", { categoryId: drinks });
    await seedProducts(org, 90, "COTHER");
    await seedProducts(org, 110, "CARCH", { status: "ARCHIVED", categoryId: drinks });
    signInAs(U1, org);
    maxRows = 50;

    expect((await walk({ categoryId: drinks })).names).toEqual(
      await dbOrder(org, "category_id = $2 and status = 'ACTIVE'", [drinks]),
    );
    expect((await walk({ status: "ARCHIVED" })).names).toEqual(
      await dbOrder(org, "status = 'ARCHIVED'"),
    );
    expect((await walk({ status: "ARCHIVED", categoryId: drinks })).names).toHaveLength(110);
  });

  it("I6. max_rows 50: search pages through 160 matches (names, SKUs, variant names), mounted, then the end", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 120, "TEAS", { nameEn: (i) => `'Tea blend ' || ${i}` });
    await seedProducts(org, 40, "TEAV", { nameEn: null });
    await f.db.query(
      `update product_variants set name = 'tea size' where organization_id = $1 and sku like 'TEAV-%'`,
      [org],
    );
    await seedProducts(org, 70, "COFF", { nameEn: (i) => `'Coffee ' || ${i}` });
    signInAs(U1, org);
    maxRows = 50;

    const walked = await walk({ search: "tea" });
    expect(walked.names).toEqual(await dbOrder(org, "name_km like 'TEA%'"));
    expect(walked.names).toHaveLength(160);

    await mount();
    await search("tea");
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "name_km like 'TEA%'"));
    expect(text()).toContain(END_SEARCH);
    expect(text()).toContain("160 matching products shown");
  });

  it("I7. empty and final pages under max_rows 50: 0, exactly 50, exactly 100 products", async () => {
    for (const [count, pages] of [
      [0, 1],
      [50, 1],
      [100, 2],
    ] as const) {
      const { org } = await newOrg();
      await seedProducts(org, count, `FIN${count}`);
      signInAs(U1, org);
      maxRows = 50;
      const walked = await walk();
      expect(walked.pages).toBe(pages);
      expect(walked.names).toEqual(await dbOrder(org));
      // Past the last product: nothing, and no cursor to follow.
      const tail = walked.products.at(-1);
      if (tail) {
        const past = await page({ before: { createdAt: tail.createdAt, id: tail.id } });
        expect(past.products).toEqual([]);
        expect(past.nextCursor).toBeNull();
      }
    }
  });

  it("I8. a cap too small to page safely fails visibly — never an end-of-list claim", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 80, "TINY");
    signInAs(U1, org);
    maxRows = 1;

    await expect(page()).rejects.toThrow(/too few rows/i);
    await mount();
    expect(text()).not.toContain(END);
    expect(text()).toContain("Products didn't load");
  });
});

describe("J. variants arrive complete under any row cap", () => {
  it("J1. max_rows 1,000: one product with 2,500 variants, and 50 products × 30 variants, all arrive", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1, "V2500", { variants: 2500 });
    signInAs(U1, org);
    const huge = await page();
    expect(huge.products[0].variants).toHaveLength(2500);
    expect(new Set(huge.products[0].variants.map((v: any) => v.id)).size).toBe(2500);

    const wide = await newOrg();
    await seedProducts(wide.org, 50, "V30", { variants: 30 });
    signInAs(U1, wide.org);
    const first = await page();
    expect(first.products.every((p: any) => p.variants.length === 30)).toBe(true);
    // Every variant sits under its own product.
    for (const p of first.products) {
      expect(p.variants.every((v: any) => v.sku.startsWith(`${p.nameKm}-V`))).toBe(true);
    }
  });

  it("J2. max_rows 100: 50 products × 3 variants (150 rows) — none lost to a short read", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 50, "V3", { variants: 3 });
    signInAs(U1, org);
    maxRows = 100;

    const first = await page();
    expect(first.products).toHaveLength(50);
    expect(first.products.every((p: any) => p.variants.length === 3)).toBe(true);
  });

  it("J3. max_rows 50: a 1,200-variant product and the POS whole-catalogue read keep every variant", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 1, "V1200", { variants: 1200 });
    await seedProducts(org, 40, "VPOS", { variants: 4 });
    signInAs(U1, org);
    maxRows = 50;

    const walked = await walk();
    const huge = walked.products.find((p: any) => p.nameKm === "V1200-00001");
    expect(huge.variants).toHaveLength(1200);
    expect(
      walked.products
        .filter((p: any) => p.nameKm.startsWith("VPOS-"))
        .every((p: any) => p.variants.length === 4),
    ).toBe(true);
  });

  it("J4. variants never cross organizations, whatever the cap", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 20, "VXA", { variants: 10 });
    await seedProducts(b.org, 20, "VXB", { variants: 10 });
    signInAs(U1, a.org);
    for (const cap of [50, 1000]) {
      maxRows = cap;
      const walked = await walk();
      const variants = walked.products.flatMap((p: any) => p.variants);
      expect(variants).toHaveLength(200);
      expect(variants.every((v: any) => v.sku.startsWith("VXA-"))).toBe(true);
    }
  });
});

describe("K. principal isolation and cursor checks hold under a capped API", () => {
  it("K1. max_rows 50, Organization A → B → A, mounted: each list complete, never a row of the other", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 120, "KORGA");
    await seedProducts(b.org, 130, "KORGB");
    maxRows = 50;
    signInAs(U1, a.org);
    await mount();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(a.org));

    signInAs(U1, b.org);
    await rerender();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(b.org));
    expect(text()).toContain("130 products shown");

    signInAs(U1, a.org);
    await rerender();
    expect(shown()).toHaveLength(50);
    expect(shown().every((n) => n.startsWith("KORGA-"))).toBe(true);
  });

  it("K2. max_rows 50, member switch in one organization: each member's walk is complete and cost follows the member", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 110, "KMEM");
    maxRows = 50;
    signInAs(U1, org);
    const owner = await walk();
    expect(owner.names).toEqual(await dbOrder(org));
    expect(owner.products.every((p: any) => p.variants[0].cost !== null)).toBe(true);

    signInAs(U2, org);
    const viewer = await walk();
    expect(viewer.names).toEqual(await dbOrder(org));
    expect(viewer.products.every((p: any) => p.variants[0].cost === null)).toBe(true);
  });

  it("K3. max_rows 50, session expiry mid-walk: the next page is refused, rows leave, sign-in", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 120, "KEXP");
    maxRows = 50;
    signInAs(U1, org);
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toHaveLength(100);

    Object.assign(server, { userId: null, organizationId: null });
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(navigations).toContain("/sign-in");
    expect(text()).not.toContain(END);
  });

  it("K4. max_rows 50, products.read revoked mid-walk: refused on the server, every row leaves", async () => {
    const { org, viewerRole } = await newOrg();
    await seedProducts(org, 120, "KREV");
    maxRows = 50;
    signInAs(U2, org);
    await mount();
    expect(shown()).toHaveLength(50);

    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(text()).toContain("You can't view products");
    await expect(page()).rejects.toThrow(/Missing permission/);
  });

  it("K5. max_rows 50, another organization's cursor: only the caller's own rows, strictly after it, completely", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedProducts(a.org, 140, "KFORA");
    await seedProducts(b.org, 60, "KFORB", {
      createdAt: (i) => `timestamptz '2026-10-01 12:00:30+00' - make_interval(secs => ${i})`,
    });
    maxRows = 50;
    signInAs(U1, b.org);
    const foreign = (await page()).nextCursor;

    signInAs(U1, a.org);
    const walked = await walk({ before: foreign });
    expect(walked.products.every((p: any) => p.organizationId === a.org)).toBe(true);
    expect(walked.names).toEqual(
      await dbOrder(a.org, "(created_at, id) < ($2::timestamptz, $3::uuid)", [
        foreign.createdAt,
        foreign.id,
      ]),
    );
  });

  it("K6. the browser refuses a page that would continue without moving (no endless Load more)", async () => {
    const { acceptCatalogPage } = await import("@/lib/catalog");
    const who = { userId: U1, organizationId: "org" };
    const query = { status: "ACTIVE" as const, categoryId: null, search: "" };
    const cursor = { createdAt: "2026-10-01T12:00:00+00:00", id: crypto.randomUUID() };
    const served = (products: unknown[], nextCursor: unknown) => ({
      products,
      nextCursor,
      servedAs: who,
      query,
    });

    // A cursor on an empty page, and the very cursor the page was asked from.
    expect(() => acceptCatalogPage(served([], cursor) as any, who, query, null)).toThrow(
      /did not move/,
    );
    expect(() => acceptCatalogPage(served([{}], cursor) as any, who, query, cursor)).toThrow(
      /did not move/,
    );
    // An honest end, and an honest continuation, are accepted.
    expect(acceptCatalogPage(served([], null) as any, who, query, cursor).nextCursor).toBeNull();
    const next = { ...cursor, id: crypto.randomUUID() };
    expect(acceptCatalogPage(served([{}], next) as any, who, query, cursor).nextCursor).toEqual(
      next,
    );
  });
});

describe("L. a short answer ends its read only when the API proved it could have sent more", () => {
  it("L1. a one-hit search over 260 products ends in one round: five field reads and one floor read, no re-scan", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 260, "HAY");
    await product(org, { nameKm: "ម្ជុល", nameEn: "Needle", sku: "NDL-1" });
    signInAs(U1, org);
    statements.length = 0;

    const result = await page({ search: "needle" });
    expect(result.products.map((p: any) => p.nameKm)).toEqual(["ម្ជុល"]);
    expect(result.nextCursor).toBeNull();
    const productReads = statements.filter((s) => s.table === "products");
    expect(productReads).toHaveLength(5 + 1);
    // The floor read: the caller's ids, as many as the page asks for.
    expect(productReads.filter((s) => s.embedFilters === null && s.rows === 51)).toHaveLength(1);
  });

  it("L2. nothing is remembered between requests: the cap lowered mid-process is caught on the next page", async () => {
    const { org } = await newOrg();
    await seedProducts(org, 230, "DROP");
    signInAs(U1, org);

    const first = await page();
    expect(first.products).toHaveLength(50);
    // A short answer under the default cap: this request measures a floor of 51.
    expect((await page({ search: "DROP-00001" })).products).toHaveLength(1);
    // The operator lowers max_rows while the server keeps running. A floor
    // carried over from the search would take every 30-row answer as the end.
    maxRows = 30;
    const rest = await walk({ before: first.nextCursor });
    expect([...first.products, ...rest.products].map((p: any) => p.nameKm)).toEqual(
      await dbOrder(org),
    );
  });

  it("L3. a catalogue smaller than a page still proves its end (no endless continuation)", async () => {
    for (const count of [1, 19, 50, 51]) {
      const { org } = await newOrg();
      await seedProducts(org, count, `SMALL${count}`);
      signInAs(U1, org);
      for (const cap of [1000, 50, 20]) {
        maxRows = cap;
        const walked = await walk();
        expect(walked.names).toEqual(await dbOrder(org));
      }
      maxRows = MAX_ROWS;
    }
  });
});
