/**
 * Orders list pagination and filters — MOUNTED, through the REAL server
 * function, the REAL service and repository, and REAL SQL.
 *
 * Mounts the production Orders screen (src/routes/app.orders.tsx) in happy-dom
 * and drives it the way a merchant does: scroll to the bottom, tap Load more,
 * tap it again, lose the network, retry, pick a filter (cases F*). Between the
 * screen and PostgreSQL:
 *
 *   screen → listRealOrdersPage (src/lib/api) → listOrdersPageFn (src/api/orders,
 *   its real zod validator and real handler) → resolveAuthContext → the real
 *   AuthorizationContext → orders service listOrdersPage → repository
 *   listOrders → PGlite with every migration applied.
 *
 * Replaced, and only these:
 *   - createServerFn — it cannot run in a unit process; the stand-in runs the
 *     function's own validator, then its own handler.
 *   - the session cookie (getSessionFn) and the active-organization lookup —
 *     both answer from `server`, the principal the SERVER would resolve. The
 *     route's principal (`route`) is separate, so a sign-in in another tab
 *     (server moves, route does not) is expressible.
 *   - verifyActiveMembership — the same membership → role → permission read,
 *     written as plain SQL over the same tables because the SQL transport
 *     cannot express PostgREST's embedded select. Grants and revocations are
 *     therefore real rows.
 *   - the Supabase admin client — an SQL transport onto PGlite that returns
 *     rows through json_agg, exactly as PostgREST does, so timestamps keep
 *     their microseconds. It also answers PostgREST's exact count (and a
 *     head-only count) so Home's own repository counts over the same rows
 *     (cases H*).
 *   - four TanStack Router hooks — there is no router in a unit process. The
 *     route's search (`?filter=`) is a small store: the route's own
 *     validateSearch reads it, and the screen's navigate() writes it, as the
 *     router would.
 *
 * Runs in its own process (orders-pagination-mounted.test.ts): it installs DOM
 * globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import { postgrestOverPglite } from "./helpers/postgrest-pglite";

// Well past waitFor's own 5 s budget: a case that hangs fails on its own
// "Timed out waiting" and stops there. With bun's 5 s default the two raced,
// the abandoned case kept acting on the DOM, and every later case failed too.
setDefaultTimeout(30_000);

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();

const { orderMatchesListFilter } = await import("@/lib/order-list-filters");
type OrderListFilter = import("@/lib/order-list-filters").OrderListFilter;
type OrderListFilterAxes = import("@/lib/order-list-filters").OrderListFilterAxes;
/** What an order inserted without statuses holds (migration 023's defaults). */
const DEFAULT_AXES: OrderListFilterAxes = {
  lifecycle: "draft",
  payment: "unpaid",
  fulfillment: "unfulfilled",
};

const OWNER_ROLE = "00000000-0000-0000-0000-000000000001";
/** Owner of every test organization. */
const U1 = "aaaaaaaa-0000-4000-8000-0000000000c1";
/** A second member of the same organizations, on a revocable custom role. */
const U2 = "aaaaaaaa-0000-4000-8000-0000000000c2";
for (const [id, email] of [
  [U1, "pager-1@test.invalid"],
  [U2, "pager-2@test.invalid"],
]) {
  await f.db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
}

let orgSeq = 0;
/**
 * A fresh organization with both members: U1 as Owner, U2 on a custom role
 * holding orders.read alone (so revoking it touches nobody else). Returns the
 * organization id and the custom role id.
 */
async function newOrg(): Promise<{ org: string; viewerRole: string }> {
  orgSeq += 1;
  const org = crypto.randomUUID();
  await f.db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
     values($1,$2,$2,$3,$4)`,
    [org, `Pager ${orgSeq}`, `pager-${orgSeq}`, U1],
  );
  const viewerRole = crypto.randomUUID();
  await f.db.query(`insert into roles(id,organization_id,name) values($1,$2,'Order viewer')`, [
    viewerRole,
    org,
  ]);
  await f.db.query(
    `insert into role_permissions(role_id,permission_id)
     select $1, id from permissions where key = 'orders.read'`,
    [viewerRole],
  );
  for (const [user, role] of [
    [U1, OWNER_ROLE],
    [U2, viewerRole],
  ]) {
    await f.db.query(
      `insert into memberships(user_id,organization_id,role_id,status)
       select $1,$2,$3,'active'
       where not exists (select 1 from memberships where user_id=$1 and organization_id=$2)`,
      [user, org, role],
    );
  }
  return { org, viewerRole };
}

/**
 * Insert `count` orders. `createdAt(i)` is SQL evaluated per row (i = 0 is the
 * newest unless the expression says otherwise); the default spaces them one
 * second apart.
 */
async function seedOrders(
  org: string,
  count: number,
  prefix: string,
  createdAt: (i: number) => string = (i) =>
    `timestamptz '2026-10-01 12:00:00+00' - make_interval(secs => ${i})`,
  axes: (i: number) => OrderListFilterAxes = () => DEFAULT_AXES,
): Promise<void> {
  const chunk = 200;
  for (let start = 0; start < count; start += chunk) {
    const values: string[] = [];
    for (let i = start; i < Math.min(count, start + chunk); i++) {
      const code = `${prefix}-${String(i + 1).padStart(4, "0")}`;
      const { lifecycle, payment, fulfillment } = axes(i);
      values.push(
        `(gen_random_uuid(),'${org}','${code}','MANUAL','USD',1000,1000,'${f.actor}',${createdAt(i)},
          '${lifecycle}','${payment}','${fulfillment}')`,
      );
    }
    const insert = `insert into orders(id,organization_id,order_number,source,currency,
         subtotal_minor,total_minor,created_by,created_at,
         lifecycle_status,payment_status,fulfillment_status) values ${values.join(",")}`;
    if (values.some((row) => !row.includes("'unpaid'"))) {
      // Only the Payment domain may give an order a payment status
      // (guard_order_financial_state, migration 040). The filter cases need
      // every status combination to exist, so this disposable database writes
      // them with triggers suspended for this one statement.
      await f.db.exec(`set session_replication_role = replica; ${insert};
        set session_replication_role = origin;`);
    } else {
      await f.db.query(insert);
    }
  }
}

/**
 * The organization's orders exactly as the list must show them — under
 * `filter`, by the filter's written specification (orderMatchesListFilter),
 * never by the SQL under test.
 */
async function dbOrder(org: string, filter: OrderListFilter = "all"): Promise<string[]> {
  const result = await f.db.query<{
    order_number: string;
    lifecycle_status: OrderListFilterAxes["lifecycle"];
    payment_status: OrderListFilterAxes["payment"];
    fulfillment_status: OrderListFilterAxes["fulfillment"];
  }>(
    `select order_number, lifecycle_status, payment_status, fulfillment_status
       from orders where organization_id=$1
     order by created_at desc, id desc`,
    [org],
  );
  return result.rows
    .filter((row) =>
      orderMatchesListFilter(filter, {
        lifecycle: row.lifecycle_status,
        payment: row.payment_status,
        fulfillment: row.fulfillment_status,
      }),
    )
    .map((row) => row.order_number);
}

// ── Principals: the route's (cache identity) and the server's (cookie) ──────

/** What the /app route guard resolved — the cache key's principal. */
const route = { userId: U1, organizationId: "" };
/** What the server resolves when a request is HANDLED (cookie + active org). */
const server: { userId: string; organizationId: string } | { userId: null; organizationId: null } =
  { userId: U1, organizationId: "" };

function signInAs(userId: string, organizationId: string) {
  Object.assign(route, { userId, organizationId });
  Object.assign(server, { userId, organizationId });
}

// ── Supabase admin client → PGlite, rows rendered the way PostgREST renders them

function sqlTransport() {
  // The shared PGlite PostgREST stand-in (it also answers the Waiting for
  // pickup filter's deliveries embed); audit rows are not this suite's subject.
  const transport = postgrestOverPglite(f.db);
  return {
    rpc: transport.rpc,
    from(table: string) {
      if (table === "audit_logs") return { insert: async () => ({ error: null }) };
      return transport.from(table);
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

// ── The order server functions: real, observed at the network boundary ─────

const realOrdersApi = { ...(await import("@/api/orders")) } as Record<string, any>;

interface Call {
  fn: string;
  data: any;
}
/** Every list request as the browser sent it. */
const calls: Call[] = [];
/** The next N list requests fail on the wire and never reach the server. */
let failNext = 0;
/** When set, each list response is held (after the server answered) until released. */
let holding = false;
const held: (() => void)[] = [];

function observed(name: string) {
  const real = realOrdersApi[name];
  if (typeof real !== "function") return real;
  return async (args: { data?: unknown } = {}) => {
    calls.push({ fn: name, data: JSON.parse(JSON.stringify(args.data ?? null)) });
    if (failNext > 0) {
      failNext -= 1;
      throw new TypeError("Failed to fetch");
    }
    // The server handles the request NOW, as whoever `server` names now.
    const outcome = await real(args).then(
      (value: unknown) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
}

mock.module("@/api/orders", () => ({
  ...realOrdersApi,
  listOrdersFn: observed("listOrdersFn"),
  listOrdersPageFn: observed("listOrdersPageFn"),
}));

/** Only the Orders list's own requests (the bottom nav never opens here). */
const listCalls = () => calls.filter((c) => c.fn === "listOrdersPageFn" || c.fn === "listOrdersFn");

// ── DOM and router ───────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app/orders" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigations: string[] = [];
/** Every navigate() call's search, as the screen sent it. */
const searchNavigations: unknown[] = [];
const realRouter = await import("@tanstack/react-router");
const { createElement, useSyncExternalStore } = await import("react");

/** The URL's raw search (?filter=…), as the router would hold it. */
let rawSearch: Record<string, unknown> = {};
const searchListeners = new Set<() => void>();
function setRouteSearch(next: Record<string, unknown>) {
  rawSearch = next;
  for (const listener of searchListeners) listener();
}
const subscribeSearch = (listener: () => void) => {
  searchListeners.add(listener);
  return () => searchListeners.delete(listener);
};
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => ({
      session: { userId: route.userId },
      organizationId: route.organizationId,
    }),
    useSearch: () => {
      const raw = useSyncExternalStore(subscribeSearch, () => rawSearch);
      return options.validateSearch ? options.validateSearch(raw) : raw;
    },
  }),
  Link: ({ children, to: _to, params: _params, search: _search, ...rest }: any) =>
    createElement("a", rest, children),
  useNavigate: () => (opts: { to: string; search?: any }) => {
    navigations.push(opts.to);
    if (opts.search !== undefined) {
      searchNavigations.push(opts.search);
      setRouteSearch(typeof opts.search === "function" ? opts.search(rawSearch) : opts.search);
    }
    return Promise.resolve();
  },
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app/orders" } };
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
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const { enforceOrderCachePrincipal, ordersKeys } = await import("@/lib/orders-query");
const i18n = (await import("@/lib/i18n")).default;
const { Route } = await import("@/routes/app.orders");
const OrderListScreen = (Route as any).component as () => React.ReactElement;

/** The /app layout's part in this: enforce the cache principal during render. */
function AppLayout() {
  const queryClient = useQueryClient();
  enforceOrderCachePrincipal(queryClient, route.userId, route.organizationId);
  return createElement(OrderListScreen);
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

function tree() {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      CapabilityFixtureProvider,
      // The capability snapshot keeps saying orders.read throughout: the
      // server's answer is what must decide, as in the stale-snapshot window
      // after a real revocation.
      { permissions: ["orders.read", "orders.create"] },
      createElement(AppLayout),
    ),
  );
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
    if (round >= 80 && Date.now() - started > 5000) throw new Error(`Timed out waiting: ${label}`);
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
  failNext = 0;
  holding = false;
  while (held.length) held.shift()!();
  navigations.length = 0;
  searchNavigations.length = 0;
  setRouteSearch({});
  if (i18n.language !== "en") await i18n.changeLanguage("en");
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";

/** Order codes on screen, top to bottom. */
function shown(): string[] {
  return [...document.querySelectorAll("a")]
    .map((a) => a.querySelector("span")?.textContent ?? "")
    .filter((code) => /^[A-Z]+\d*-\d{4}$/.test(code));
}

function buttonNamed(name: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find(
      (b) => (b.textContent ?? "").trim() === name,
    ) ?? null
  );
}

const LOAD_MORE = "Load more orders";
const RETRY = "Try again";
const END = "You've reached your oldest order";
const EMPTY = "No orders yet";

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
    if (taps > 50) throw new Error("Load more never ended");
  }
  return taps;
}

function expectNoDuplicates(codes: string[]) {
  expect(new Set(codes).size).toBe(codes.length);
}

// ── Cases ────────────────────────────────────────────────────────────────────

describe("Orders list pagination — size boundaries", () => {
  it("A. 0 orders: the empty state, and no Load more or end-of-list claim", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    await mount();

    expect(text()).toContain(EMPTY);
    expect(shown()).toEqual([]);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).not.toContain(END);
  });

  it("B. 1 order: one row, the end of the list, no Load more", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 1, "ONE");
    signInAs(U1, org);
    await mount();

    expect(shown()).toEqual(["ONE-0001"]);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END);
    expect(text()).toContain("1 order shown");
    expect(text()).not.toContain(EMPTY);
  });

  it("C. exactly one full page (50): all 50, end of list proven by the server, one request", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 50, "FULL");
    signInAs(U1, org);
    await mount();

    expect(shown()).toEqual(await dbOrder(org));
    expect(shown()).toHaveLength(50);
    // A full page alone does not prove more exist: the server looked and found none.
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END);
    expect(text()).toContain("50 orders shown");
    expect(listCalls()).toHaveLength(1);
  });

  it("D. 51 orders: 50, then Load more reaches the 51st and the end", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 51, "FIFTYONE");
    signInAs(U1, org);
    await mount();

    expect(shown()).toHaveLength(50);
    expect(buttonNamed(LOAD_MORE)).not.toBeNull();
    expect(text()).not.toContain(END);
    expect(text()).toContain("Showing 50 orders");

    await tap(LOAD_MORE);
    await readsSettled();

    expect(shown()).toEqual(await dbOrder(org));
    expect(shown()).toHaveLength(51);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END);
    expect(text()).toContain("51 orders shown");
  });

  it("E. 120 orders: three pages, every order once, in the database's order", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "MANY");
    signInAs(U1, org);
    await mount();

    const taps = await loadEverything();

    expect(taps).toBe(2);
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual(await dbOrder(org));
    expect(codes).toHaveLength(120);
    expect(text()).toContain("120 orders shown");
    // Page 1 without a cursor; each later page continues from the last row.
    const sent = listCalls();
    expect(sent.map((c) => c.fn)).toEqual([
      "listOrdersPageFn",
      "listOrdersPageFn",
      "listOrdersPageFn",
    ]);
    expect(sent[0]!.data?.before).toBeUndefined();
    expect(sent[1]!.data.before.id).toBeString();
    expect(sent[2]!.data.before.createdAt).toBeString();
  });

  it("F. 260 orders: six pages to the end", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 260, "BIG");
    signInAs(U1, org);
    await mount();

    expect(await loadEverything()).toBe(5);
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual(await dbOrder(org));
    expect(text()).toContain("260 orders shown");
  });
});

describe("Orders list pagination — ordering and concurrency", () => {
  it("G. equal created_at: 75 orders in one instant page by id, none skipped or repeated", async () => {
    const { org } = await newOrg();
    // One transaction's worth of orders: identical timestamps.
    await seedOrders(org, 75, "TIE", () => `timestamptz '2026-10-01 12:00:00.5+00'`);
    // Bracketing rows so the tie group sits mid-list and straddles a page.
    await seedOrders(
      org,
      10,
      "NEWER",
      (i) => `timestamptz '2026-10-01 13:00:00+00' - make_interval(secs => ${i})`,
    );
    await seedOrders(
      org,
      10,
      "OLDER",
      (i) => `timestamptz '2026-10-01 11:00:00+00' - make_interval(secs => ${i})`,
    );
    signInAs(U1, org);
    await mount();

    await loadEverything();
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual(await dbOrder(org));
    expect(codes).toHaveLength(95);
  });

  it("H. microsecond neighbours inside one millisecond are neither merged nor skipped", async () => {
    const { org } = await newOrg();
    // 120 orders, 1 µs apart: a cursor truncated to milliseconds would treat
    // the whole run as one instant and lose rows at every page boundary.
    await seedOrders(
      org,
      120,
      "MICRO",
      (i) =>
        `timestamptz '2026-10-01 12:00:00.000900+00' - make_interval(secs => ${i} / 1000000.0)`,
    );
    signInAs(U1, org);
    await mount();

    await loadEverything();
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual(await dbOrder(org));
    expect(codes).toHaveLength(120);
  });

  it("I. orders created between page requests: no row repeated or skipped; they arrive on refresh", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "BASE");
    signInAs(U1, org);
    await mount();
    const firstPage = shown();

    // Someone else creates 7 orders while this merchant is on page 1.
    await seedOrders(org, 7, "LATE", (i) => `now() - make_interval(secs => ${i})`);

    await loadEverything();
    const paged = shown();
    expectNoDuplicates(paged);
    // The walk continues exactly where page 1 ended: the 120 originals, once each.
    expect(paged.slice(0, 50)).toEqual(firstPage);
    expect(paged).toEqual((await dbOrder(org)).filter((code) => code.startsWith("BASE")));

    // A refresh (what creating an order or returning to the tab does) re-walks
    // the same number of pages from the top: the new orders lead, nothing doubles.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U1, org) });
    });
    await readsSettled();
    const refreshed = shown();
    expectNoDuplicates(refreshed);
    expect(refreshed.slice(0, 7)).toEqual((await dbOrder(org)).slice(0, 7));
    expect(refreshed).toEqual((await dbOrder(org)).slice(0, refreshed.length));
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org));
  });

  it("J. repeated Load more taps: one request per page, never a doubled page", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 160, "TAP");
    signInAs(U1, org);
    await mount();
    calls.length = 0;

    holding = true;
    const button = buttonNamed(LOAD_MORE)!;
    await act(async () => {
      for (let i = 0; i < 6; i++) button.click();
    });
    await settle(4);
    // Busy, announced, and still the one request.
    expect(text()).toContain("Loading more orders…");
    expect(buttonNamed("Loading more orders…")?.getAttribute("aria-disabled")).toBe("true");
    await tap("Loading more orders…");
    await tap("Loading more orders…");
    expect(listCalls()).toHaveLength(1);

    holding = false;
    while (held.length) held.shift()!();
    await readsSettled();

    expect(listCalls()).toHaveLength(1);
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual((await dbOrder(org)).slice(0, 100));
  });
});

describe("Orders list pagination — failures are honest", () => {
  it("K. a failed Load more keeps the loaded rows, says the list is incomplete, and Retry finishes it", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "NET");
    signInAs(U1, org);
    await mount();

    // The request and both automatic retries fail.
    failNext = 3;
    calls.length = 0;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(listCalls()).toHaveLength(3);

    expect(shown()).toEqual((await dbOrder(org)).slice(0, 50));
    expect(text()).toContain("More orders didn't load");
    expect(text()).toContain("This list isn't complete yet");
    expect(text()).not.toContain(END);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "More orders didn't load",
    );

    await tap(RETRY);
    await readsSettled();
    expect(text()).not.toContain("More orders didn't load");
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org));
    expect(text()).toContain(END);
  });

  it("L. a failed first page is an error with Retry — never the empty state or an end claim", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 3, "FIRST");
    signInAs(U1, org);
    failNext = 3;
    await mount();

    expect(text()).toContain("Orders didn't load");
    expect(text()).not.toContain(EMPTY);
    expect(text()).not.toContain(END);
    expect(shown()).toEqual([]);

    await tap(RETRY);
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org));
    expect(text()).toContain(END);
  });

  it("M. a failed refresh keeps the rows but says they may be out of date", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 60, "STALE");
    signInAs(U1, org);
    await mount();
    await loadEverything();

    failNext = 3;
    await act(async () => {
      await client.refetchQueries({ queryKey: ordersKeys.listPages(U1, org) }).catch(() => {});
    });
    await readsSettled();
    expect(text()).toContain("This list couldn't refresh");
    expect(shown()).toHaveLength(60);
  });

  it("Y. a one-off network blip is retried quietly; a refusal about who is asking is never retried", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 120, "BLIP");
    signInAs(U2, org);
    await mount();

    failNext = 1;
    calls.length = 0;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(listCalls()).toHaveLength(2);
    expect(text()).not.toContain("More orders didn't load");
    expect(shown()).toEqual((await dbOrder(org)).slice(0, 100));

    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    calls.length = 0;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(listCalls()).toHaveLength(1);
    expect(text()).toContain("You can't view orders");
  });
});

describe("Orders list pagination — principal and cache isolation", () => {
  it("N. member switch in one organization (U1 → U2): U2 starts at page 1 and never sees U1's pages", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "MEM");
    signInAs(U1, org);
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toHaveLength(100);
    calls.length = 0;

    signInAs(U2, org);
    await rerender();

    // U2's own walk, from the top: no cursor carried over from U1.
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data?.before).toBeUndefined();
    expect(shown()).toEqual((await dbOrder(org)).slice(0, 50));
    expect(client.getQueryData(ordersKeys.listPages(U1, org))).toBeUndefined();
  });

  it("O. organization switch A → B → A: each list is its own, from page 1, no rows crossing", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 70, "ORGA");
    await seedOrders(b.org, 70, "ORGB");
    signInAs(U1, a.org);
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(a.org));

    signInAs(U1, b.org);
    await rerender();
    expect(shown().every((code) => code.startsWith("ORGB-"))).toBe(true);
    expect(shown()).toEqual((await dbOrder(b.org)).slice(0, 50));
    expect(client.getQueryData(ordersKeys.listPages(U1, a.org))).toBeUndefined();

    calls.length = 0;
    signInAs(U1, a.org);
    await rerender();
    expect(listCalls()[0]!.data?.before).toBeUndefined();
    expect(shown().every((code) => code.startsWith("ORGA-"))).toBe(true);
    expect(shown()).toEqual((await dbOrder(a.org)).slice(0, 50));
    await loadEverything();
    expectNoDuplicates(shown());
    expect(shown()).toEqual(await dbOrder(a.org));
  });

  it("P. a late page for A, delivered after switching to B and back, is stored nowhere", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 120, "LATEA");
    await seedOrders(b.org, 30, "LATEB");
    signInAs(U1, a.org);
    await mount();

    holding = true;
    await tap(LOAD_MORE);
    await settle(4);
    expect(held).toHaveLength(1);

    // Switch to B while A's page 2 is in flight.
    holding = false;
    signInAs(U1, b.org);
    await rerender();
    expect(shown()).toEqual(await dbOrder(b.org));

    // A's late page lands now.
    held.shift()!();
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(b.org));
    expect(shown().some((code) => code.startsWith("LATEA-"))).toBe(false);

    // Back to A: a fresh first page, not page 1 + the orphaned page 2.
    calls.length = 0;
    signInAs(U1, a.org);
    await rerender();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data?.before).toBeUndefined();
    expect(shown()).toEqual((await dbOrder(a.org)).slice(0, 50));
    expect(buttonNamed(LOAD_MORE)).not.toBeNull();
  });

  it("Q. a page answered for another principal (sign-in in another tab) is refused, and A's rows leave too", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 120, "TABA");
    await seedOrders(b.org, 120, "TABB");
    signInAs(U1, a.org);
    await mount();
    expect(shown()).toHaveLength(50);

    // Another tab signs in to B: the cookie moves, this tab's route does not.
    Object.assign(server, { userId: U1, organizationId: b.org });
    await tap(LOAD_MORE);
    await readsSettled();

    expect(shown().some((code) => code.startsWith("TABB-"))).toBe(false);
    expect(shown()).toEqual([]);
    expect(text()).toContain("You switched account or business");
    expect(text()).not.toContain(END);
    const cached = client.getQueryData<any>(ordersKeys.listPages(U1, a.org));
    const cachedCodes = (cached?.pages ?? []).flatMap((p: any) => p.orders.map((o: any) => o.code));
    expect(cachedCodes.some((code: string) => code.startsWith("TABB-"))).toBe(false);
  });

  it("R. same-organization member in another tab (U1 → U2 server-side) is refused the same way", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 80, "TABM");
    signInAs(U1, org);
    await mount();

    Object.assign(server, { userId: U2, organizationId: org });
    await tap(LOAD_MORE);
    await readsSettled();

    expect(shown()).toEqual([]);
    expect(text()).toContain("You switched account or business");
  });

  it("Z. a REFRESH answered for another organization never files its orders under this principal", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 5, "REFA");
    await seedOrders(b.org, 5, "REFB");
    signInAs(U1, a.org);
    await mount();
    expect(shown()).toEqual(await dbOrder(a.org));

    // Another tab switches business; this tab's list refreshes (focus, a create).
    Object.assign(server, { userId: U1, organizationId: b.org });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U1, a.org) });
    });
    await readsSettled();

    expect(shown().some((code) => code.startsWith("REFB-"))).toBe(false);
    const cachedUnderA = JSON.stringify(
      client.getQueriesData({ queryKey: ordersKeys.principal(U1, a.org) }),
    );
    expect(cachedUnderA).not.toContain("REFB-");
  });

  it("S. orders.read revoked between pages: the server refuses page 2 and every loaded row leaves the screen", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 120, "REV");
    signInAs(U2, org);
    await mount();
    expect(shown()).toHaveLength(50);

    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    await tap(LOAD_MORE);
    await readsSettled();

    expect(shown()).toEqual([]);
    expect(text()).toContain("You can't view orders");
    expect(text()).not.toContain(END);
    expect(buttonNamed(LOAD_MORE)).toBeNull();

    // Restored: the list comes back from the server, not from a stale page.
    await f.db.query(
      `insert into role_permissions(role_id,permission_id)
       select $1, id from permissions where key = 'orders.read'`,
      [viewerRole],
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U2, org) });
    });
    await readsSettled();
    expect(shown()).toEqual((await dbOrder(org)).slice(0, 50));
  });

  it("T. session expiry: rows leave, sign-in is requested; re-authentication reloads from page 1", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 90, "EXP");
    signInAs(U1, org);
    await mount();

    Object.assign(server, { userId: null, organizationId: null });
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(navigations).toContain("/sign-in");

    // Signed back in as the same member (the /app guard re-resolves).
    signInAs(U1, org);
    calls.length = 0;
    await act(async () => {
      await client.resetQueries({ queryKey: ordersKeys.listPages(U1, org) });
    });
    await readsSettled();
    expect(listCalls()[0]!.data?.before).toBeUndefined();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org));
  });

  it("U. cache eviction: a remount after garbage collection starts again at page 1", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "GC");
    signInAs(U1, org);
    const shared = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
    });
    await mount({ client: shared });
    await loadEverything();
    expect(shown()).toHaveLength(120);

    await unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(shared.getQueryData(ordersKeys.listPages(U1, org))).toBeUndefined();

    calls.length = 0;
    await mount({ client: shared });
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data?.before).toBeUndefined();
    expect(shown()).toEqual((await dbOrder(org)).slice(0, 50));
  });
});

describe("Orders list pagination — the server function boundary", () => {
  const pageFn = () => realOrdersApi.listOrdersPageFn as (args: { data?: unknown }) => Promise<any>;

  it("V. a cursor never crosses tenants: another organization's position yields only the caller's orders", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 5, "XA");
    await seedOrders(b.org, 5, "XB");
    signInAs(U1, b.org);
    const bPage = await pageFn()({ data: { limit: 1 } });
    signInAs(U1, a.org);

    const page = await pageFn()({ data: { before: bPage.nextCursor } });
    expect(page.servedAs).toEqual({ userId: U1, organizationId: a.org });
    expect(page.orders.every((o: any) => o.organizationId === a.org)).toBe(true);
  });

  it("W. malformed, tampered and oversized requests are refused before any read", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    const bad = [
      { before: { createdAt: "2026-10-01T12:00:00Z", id: "not-a-uuid" } },
      { before: { createdAt: "yesterday", id: crypto.randomUUID() } },
      { before: { createdAt: "2026-10-01T12:00:00Z),id.gt.0", id: crypto.randomUUID() } },
      {
        before: { createdAt: "2026-10-01T12:00:00Z", id: crypto.randomUUID(), organizationId: org },
      },
      { organizationId: org },
      { offset: 50 },
      { limit: 1000 },
    ];
    for (const data of bad) {
      await expect(pageFn()({ data })).rejects.toThrow();
    }
  });

  it("X. orders.read is required for every page, cursor or not", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 3, "PERM");
    signInAs(U2, org);
    const first = await pageFn()({ data: { limit: 1 } });
    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    await expect(pageFn()({ data: {} })).rejects.toThrow(/permission/i);
    await expect(pageFn()({ data: { before: first.nextCursor } })).rejects.toThrow(/permission/i);
  });
});

// ── Filters ──────────────────────────────────────────────────────────────────
//
// The nine Orders filters (src/lib/order-list-filters.ts), through the same
// real server function, service, repository and SQL as the cases above.

const CHIP: Record<OrderListFilter, string> = {
  all: "All",
  awaiting_payment: "Payment due",
  to_pack: "Needs preparation",
  waiting_pickup: "Packed · Waiting for pickup",
  draft: "Drafts",
  processing: "Processing",
  fulfilled: "Fulfilled, not completed",
  completed: "Completed",
  cancelled: "Cancelled",
};
const FILTERS = Object.keys(CHIP) as OrderListFilter[];
/**
 * The chips this screen's member is offered. The capability snapshot below
 * holds orders.read and orders.create, not delivery.read, so Packed · Waiting
 * for pickup — a delivery fact the server refuses without it — is not offered.
 */
const VISIBLE = FILTERS.filter((filter) => filter !== "waiting_pickup");
const END_FILTERED = "No older orders match this filter";
const EMPTY_FILTERED = "No orders match this filter";

const LIFECYCLES = ["draft", "confirmed", "completed", "cancelled"] as const;
const PAYMENTS = ["unpaid", "pending", "paid", "failed"] as const;
const FULFILLMENTS = ["unfulfilled", "processing", "fulfilled", "cancelled"] as const;
/** Every combination of the three status columns — 64 orders. */
const EVERY_COMBINATION: OrderListFilterAxes[] = LIFECYCLES.flatMap((lifecycle) =>
  PAYMENTS.flatMap((payment) =>
    FULFILLMENTS.map((fulfillment) => ({ lifecycle, payment, fulfillment })),
  ),
);

const CONFIRMED_TO_PACK: OrderListFilterAxes = {
  lifecycle: "confirmed",
  payment: "unpaid",
  fulfillment: "unfulfilled",
};

/**
 * An element's accessible name from the two sources a container can carry,
 * in accname's order: the text aria-labelledby points at, else aria-label.
 */
function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  }
  return element.getAttribute("aria-label")?.trim() ?? "";
}

/**
 * The group a screen reader announces as `name`: an element whose ROLE is
 * group and whose computed name is `name`. A name on a div with no role is
 * never announced (ARIA prohibits naming the generic role), so such a div is
 * not found here.
 */
function groupNamed(name: string): HTMLElement | null {
  const groups = [...document.querySelectorAll('[role="group"]')] as HTMLElement[];
  return groups.find((group) => accessibleName(group) === name) ?? null;
}

function filterRow(): HTMLElement | null {
  return groupNamed("Filter orders");
}

function chipButtons(): HTMLButtonElement[] {
  return [...(filterRow()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
}

/** The chips that announce themselves as pressed. */
/** A chip's label, without the count badge the attention chips carry. */
function chipLabel(button: Element): string {
  return (button.querySelector(".chip-text")?.textContent ?? button.textContent ?? "").trim();
}

function pressedChips(): string[] {
  return chipButtons()
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map(chipLabel);
}

async function choose(filter: OrderListFilter) {
  const chip = chipButtons().find((b) => chipLabel(b) === CHIP[filter]);
  if (!chip) throw new Error(`No "${CHIP[filter]}" chip. Screen: ${text().slice(0, 400)}`);
  await act(async () => {
    chip.click();
  });
  await readsSettled();
}

/** Keys under `prefix` that hold data. */
function cachedUnder(prefix: readonly unknown[]): (readonly unknown[])[] {
  return client
    .getQueriesData({ queryKey: prefix })
    .filter(([, data]) => data !== undefined)
    .map(([key]) => key);
}

/** The filter each list request asked for (absent = all). */
const sentFilters = () => listCalls().map((c) => c.data?.filter ?? "all");

describe("Orders filters — each filter is exactly its server-side predicate", () => {
  const pageFn = () => realOrdersApi.listOrdersPageFn as (args: { data?: unknown }) => Promise<any>;

  it("FA. every combination of the three status columns lands in exactly the orders each filter promises", async () => {
    const { org } = await newOrg();
    await seedOrders(org, EVERY_COMBINATION.length, "MAP", undefined, (i) => EVERY_COMBINATION[i]!);
    signInAs(U1, org);

    const served: Record<string, string[]> = {};
    for (const filter of FILTERS) {
      const page = await pageFn()({
        data: filter === "all" ? { limit: 100 } : { filter, limit: 100 },
      });
      expect(page.filter).toBe(filter);
      expect(page.nextCursor).toBeNull();
      served[filter] = page.orders.map((o: any) => o.orderNumber);
      // The SQL agrees with the written specification, row for row, in order.
      expect(served[filter]).toEqual(await dbOrder(org, filter));
    }

    // Counts written out by hand from the definitions, so the specification is
    // not only checked against itself.
    expect(Object.fromEntries(FILTERS.map((f) => [f, served[f]!.length]))).toEqual({
      all: 64,
      awaiting_payment: 36, // 3 live lifecycles × {unpaid, pending, failed} × 4 fulfillments
      draft: 12, // 4 payments × 3 non-cancelled fulfillments
      to_pack: 4,
      waiting_pickup: 0, // no deliveries in this organization (order-attention-lists covers them)
      processing: 4,
      fulfilled: 4,
      completed: 12,
      cancelled: 28, // 16 cancelled sales + 12 cancelled fulfillments of live ones
    });

    // The six progress filters partition the list: every order exactly once.
    const progress = ["draft", "to_pack", "processing", "fulfilled", "completed", "cancelled"];
    const placed = progress.flatMap((f) => served[f]!);
    expectNoDuplicates(placed);
    expect([...placed].sort()).toEqual([...served.all!].sort());

    // Spot checks against the axes themselves.
    const byCode = new Map(
      (await pageFn()({ data: { limit: 100 } })).orders.map((o: any) => [o.orderNumber, o]),
    );
    for (const code of served.awaiting_payment!) {
      const o: any = byCode.get(code);
      expect(o.lifecycleStatus).not.toBe("cancelled");
      expect(["unpaid", "pending", "failed"]).toContain(o.paymentStatus);
    }
    for (const code of served.cancelled!) {
      const o: any = byCode.get(code);
      expect(o.lifecycleStatus === "cancelled" || o.fulfillmentStatus === "cancelled").toBe(true);
    }
  });

  it("FB. an unknown, injected or mistyped filter is refused before any read", async () => {
    const { org } = await newOrg();
    signInAs(U1, org);
    for (const filter of [
      "ALL",
      "Draft",
      "unpaid",
      "lifecycle_status.eq.draft",
      "draft,organization_id.neq.x",
      "",
      42,
      ["draft"],
      { eq: "draft" },
      null,
    ]) {
      await expect(pageFn()({ data: { filter } })).rejects.toThrow();
    }
  });

  it("FC. a filter never widens the tenant: another organization's cursor under a filter yields only the caller's orders", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 6, "FXA");
    await seedOrders(b.org, 6, "FXB");
    signInAs(U1, b.org);
    const bPage = await pageFn()({ data: { filter: "draft", limit: 1 } });
    signInAs(U1, a.org);

    const page = await pageFn()({ data: { filter: "draft", before: bPage.nextCursor } });
    expect(page.servedAs).toEqual({ userId: U1, organizationId: a.org });
    expect(page.orders.every((o: any) => o.organizationId === a.org)).toBe(true);
  });

  it("FD. orders.read is required under every filter", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 3, "FPERM");
    signInAs(U2, org);
    await pageFn()({ data: { filter: "draft" } });
    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    for (const filter of FILTERS) {
      await expect(pageFn()({ data: { filter } })).rejects.toThrow(/permission/i);
    }
  });
});

describe("Orders filters — paging a filtered list", () => {
  it("FE. 130 matching orders among 260: three filtered pages, every match once, an honest filtered end", async () => {
    const { org } = await newOrg();
    // Drafts and orders to pack interleaved second by second.
    await seedOrders(org, 260, "MIX", undefined, (i) =>
      i % 2 === 0 ? DEFAULT_AXES : CONFIRMED_TO_PACK,
    );
    signInAs(U1, org);
    setRouteSearch({ filter: "to_pack" });
    await mount();

    expect(pressedChips()).toEqual(["Needs preparation"]);
    expect(shown()).toEqual((await dbOrder(org, "to_pack")).slice(0, 50));
    expect(text()).not.toContain(END_FILTERED);

    expect(await loadEverything()).toBe(2);
    const codes = shown();
    expectNoDuplicates(codes);
    expect(codes).toEqual(await dbOrder(org, "to_pack"));
    expect(codes).toHaveLength(130);
    expect(text()).toContain(END_FILTERED);
    expect(text()).toContain("130 matching orders shown");
    expect(text()).not.toContain(END);
    // Every page asked for the filter; each later page continued from a cursor.
    expect(sentFilters()).toEqual(["to_pack", "to_pack", "to_pack"]);
    expect(listCalls()[0]!.data.before).toBeUndefined();
    expect(listCalls()[2]!.data.before.id).toBeString();
  });

  it("FF. switching filter starts the new list at its first page; switching back starts that one over", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 240, "SW", undefined, (i) =>
      i % 3 === 0 ? CONFIRMED_TO_PACK : DEFAULT_AXES,
    );
    signInAs(U1, org);
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toHaveLength(100);

    calls.length = 0;
    await choose("draft");
    expect(searchNavigations.at(-1)).toEqual({ filter: "draft" });
    expect(pressedChips()).toEqual(["Drafts"]);
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data).toEqual({ filter: "draft" });
    expect(shown()).toEqual((await dbOrder(org, "draft")).slice(0, 50));
    // The All list walked before is gone, not kept two pages deep.
    expect(client.getQueryData(ordersKeys.listPagesFor(U1, org, "all"))).toBeUndefined();

    calls.length = 0;
    await choose("all");
    expect(searchNavigations.at(-1)).toEqual({});
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data).toEqual({});
    expect(shown()).toEqual((await dbOrder(org)).slice(0, 50));
    expect(client.getQueryData(ordersKeys.listPagesFor(U1, org, "draft"))).toBeUndefined();
  });

  it("FG. orders created and changed while paging a filter: no match repeated or skipped; they arrive on refresh", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "CPACK", undefined, () => CONFIRMED_TO_PACK);
    await seedOrders(
      org,
      60,
      "CDRAFT",
      (i) => `timestamptz '2026-10-01 12:00:00.5+00' - make_interval(secs => ${i * 2})`,
    );
    signInAs(U1, org);
    setRouteSearch({ filter: "to_pack" });
    await mount();
    const firstPage = shown();

    // Meanwhile: new orders to pack, new drafts, and one older order still to
    // load starts packing (it leaves this filter).
    await seedOrders(
      org,
      7,
      "NEWPACK",
      (i) => `now() - make_interval(secs => ${i})`,
      () => CONFIRMED_TO_PACK,
    );
    await seedOrders(org, 5, "NEWDRAFT", (i) => `now() - make_interval(secs => ${i})`);
    await f.db.query(
      `update orders set fulfillment_status='processing'
        where organization_id=$1 and order_number='CPACK-0110'`,
      [org],
    );

    await loadEverything();
    const paged = shown();
    expectNoDuplicates(paged);
    expect(paged.slice(0, 50)).toEqual(firstPage);
    // The walk continued exactly where page 1 ended, and only matching rows.
    expect(paged.slice(50)).toEqual(
      (await dbOrder(org, "to_pack")).filter((c) => c.startsWith("CPACK")).slice(50),
    );
    expect(paged).not.toContain("CPACK-0110");
    expect(paged.some((c) => c.includes("DRAFT"))).toBe(false);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U1, org) });
    });
    await readsSettled();
    const refreshed = shown();
    expectNoDuplicates(refreshed);
    expect(refreshed.slice(0, 7)).toEqual((await dbOrder(org, "to_pack")).slice(0, 7));
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));
  });

  it("FH. a filter with no matches is its own empty state, offers All, and never claims an end or a Load more", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 12, "NOMATCH");
    signInAs(U1, org);
    setRouteSearch({ filter: "completed" });
    await mount();

    expect(text()).toContain(EMPTY_FILTERED);
    expect(text()).not.toContain(EMPTY);
    expect(text()).not.toContain(END_FILTERED);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(shown()).toEqual([]);

    await tap("Show all orders");
    await readsSettled();
    expect(pressedChips()).toEqual(["All"]);
    expect(shown()).toEqual(await dbOrder(org));
  });

  it("FI. exactly one full filtered page (50): the server proves the end with one request", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 100, "HALF", undefined, (i) =>
      i % 2 === 0 ? DEFAULT_AXES : CONFIRMED_TO_PACK,
    );
    signInAs(U1, org);
    setRouteSearch({ filter: "draft" });
    await mount();

    expect(shown()).toEqual(await dbOrder(org, "draft"));
    expect(shown()).toHaveLength(50);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
    expect(text()).toContain(END_FILTERED);
    expect(listCalls()).toHaveLength(1);
  });
});

describe("Orders filters — changing filter while a request is in flight", () => {
  it("FJ. a Load more still in flight for the old filter lands nowhere, and the new filter can page at once", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 260, "PEND", undefined, (i) =>
      i % 2 === 0 ? DEFAULT_AXES : CONFIRMED_TO_PACK,
    );
    signInAs(U1, org);
    await mount();

    holding = true;
    await tap(LOAD_MORE);
    await settle(4);
    expect(held).toHaveLength(1);

    holding = false;
    await choose("to_pack");
    expect(shown()).toEqual((await dbOrder(org, "to_pack")).slice(0, 50));

    // The new filter's Load more is not blocked by the old one's request.
    calls.length = 0;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(sentFilters()).toEqual(["to_pack"]);
    expect(shown()).toEqual((await dbOrder(org, "to_pack")).slice(0, 100));

    // The All page lands now.
    held.shift()!();
    await readsSettled();
    expect(shown()).toEqual((await dbOrder(org, "to_pack")).slice(0, 100));
    expect(shown().every((c) => c.startsWith("PEND-"))).toBe(true);
    expect(client.getQueryData(ordersKeys.listPagesFor(U1, org, "all"))).toBeUndefined();
    const toPack = new Set(await dbOrder(org, "to_pack"));
    expect(shown().every((c) => toPack.has(c))).toBe(true);
  });

  it("FK. a FIRST page still in flight for the old filter never appears under the new one", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 40, "FIRSTA", undefined, () => DEFAULT_AXES);
    await seedOrders(
      org,
      40,
      "FIRSTB",
      (i) => `timestamptz '2026-10-01 11:00:00+00' - make_interval(secs => ${i})`,
      () => CONFIRMED_TO_PACK,
    );
    signInAs(U1, org);
    setRouteSearch({ filter: "draft" });
    holding = true;
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(tree()));
    await settle(4);
    expect(held).toHaveLength(1);
    expect(shown()).toEqual([]);

    holding = false;
    await choose("to_pack");
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));

    held.shift()!();
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));
    expect(shown().some((c) => c.startsWith("FIRSTA-"))).toBe(false);
    expect(client.getQueryData(ordersKeys.listPagesFor(U1, org, "draft"))).toBeUndefined();
    expect(text()).toContain(END_FILTERED);
  });

  it("FL. rapid taps across several chips: one list on screen, the last one chosen", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 64, "RAPID", undefined, (i) => EVERY_COMBINATION[i]!);
    signInAs(U1, org);
    await mount();

    await act(async () => {
      for (const filter of ["draft", "cancelled", "awaiting_payment", "completed"] as const) {
        chipButtons()
          .find((b) => chipLabel(b) === CHIP[filter])!
          .click();
      }
    });
    await readsSettled();
    expect(pressedChips()).toEqual(["Completed"]);
    expect(shown()).toEqual(await dbOrder(org, "completed"));
    const cachedFilters = client
      .getQueriesData({ queryKey: ordersKeys.listPages(U1, org) })
      .filter(([, data]) => data !== undefined)
      .map(([key]) => key.at(-1));
    expect(cachedFilters).toEqual(["completed"]);
  });
});

describe("Orders filters — failures are honest", () => {
  it("FM. a failed filtered Load more keeps the rows, says so, and Retry continues the same filter", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "FNET", undefined, () => CONFIRMED_TO_PACK);
    signInAs(U1, org);
    setRouteSearch({ filter: "to_pack" });
    await mount();

    failNext = 3;
    calls.length = 0;
    await tap(LOAD_MORE);
    await readsSettled();
    expect(listCalls()).toHaveLength(3);
    expect(sentFilters()).toEqual(["to_pack", "to_pack", "to_pack"]);
    expect(shown()).toEqual((await dbOrder(org, "to_pack")).slice(0, 50));
    expect(text()).toContain("More orders didn't load");
    expect(text()).not.toContain(END_FILTERED);

    await tap(RETRY);
    await readsSettled();
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));
    expect(text()).toContain(END_FILTERED);
  });

  it("FN. a failed first filtered page is an error with Retry — never the filtered empty state", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 3, "FFIRST");
    signInAs(U1, org);
    setRouteSearch({ filter: "draft" });
    failNext = 3;
    await mount();

    expect(text()).toContain("Orders didn't load");
    expect(text()).not.toContain(EMPTY_FILTERED);
    expect(text()).not.toContain(END_FILTERED);

    await tap(RETRY);
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org, "draft"));
    expect(sentFilters().at(-1)).toBe("draft");
  });

  it("FO. a page that says it answers a different filter is never shown under this one", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 10, "FMIS");
    signInAs(U1, org);
    const { acceptOrderListPage } = await import("@/lib/orders");
    const page = await (realOrdersApi.listOrdersPageFn as any)({ data: {} });
    expect(page.filter).toBe("all");
    expect(() => acceptOrderListPage(page, { userId: U1, organizationId: org }, "draft")).toThrow(
      /different filter/,
    );
    expect(
      acceptOrderListPage(page, { userId: U1, organizationId: org }, "all").orders,
    ).toHaveLength(10);
  });
});

describe("Orders filters — principal and cache isolation", () => {
  it("FP. member switch under a filter (U1 → U2): U2 starts that filter at page 1, U1's filtered pages are gone", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "FMEM");
    signInAs(U1, org);
    setRouteSearch({ filter: "draft" });
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toHaveLength(100);
    calls.length = 0;

    signInAs(U2, org);
    await rerender();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data).toEqual({ filter: "draft" });
    expect(shown()).toEqual((await dbOrder(org, "draft")).slice(0, 50));
    expect(cachedUnder(ordersKeys.principal(U1, org))).toEqual([]);
  });

  it("FQ. organization switch A → B → A under a filter: each its own filtered list, from page 1", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 140, "FORGA", undefined, (i) =>
      i % 2 === 0 ? CONFIRMED_TO_PACK : DEFAULT_AXES,
    );
    await seedOrders(b.org, 140, "FORGB", undefined, (i) =>
      i % 2 === 0 ? CONFIRMED_TO_PACK : DEFAULT_AXES,
    );
    signInAs(U1, a.org);
    setRouteSearch({ filter: "to_pack" });
    await mount();
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual((await dbOrder(a.org, "to_pack")).slice(0, 70));

    signInAs(U1, b.org);
    await rerender();
    expect(shown().every((c) => c.startsWith("FORGB-"))).toBe(true);
    expect(shown()).toEqual((await dbOrder(b.org, "to_pack")).slice(0, 50));
    expect(cachedUnder(ordersKeys.principal(U1, a.org))).toEqual([]);

    calls.length = 0;
    signInAs(U1, a.org);
    await rerender();
    expect(listCalls()[0]!.data).toEqual({ filter: "to_pack" });
    expect(shown().every((c) => c.startsWith("FORGA-"))).toBe(true);
    await loadEverything();
    expectNoDuplicates(shown());
    expect(shown()).toEqual(await dbOrder(a.org, "to_pack"));
  });

  it("FR. a late filtered page for A, delivered after switching to B, is stored nowhere", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 120, "FLATEA");
    await seedOrders(b.org, 20, "FLATEB");
    signInAs(U1, a.org);
    setRouteSearch({ filter: "draft" });
    await mount();

    holding = true;
    await tap(LOAD_MORE);
    await settle(4);
    expect(held).toHaveLength(1);

    holding = false;
    signInAs(U1, b.org);
    await rerender();
    expect(shown()).toEqual(await dbOrder(b.org, "draft"));

    held.shift()!();
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(b.org, "draft"));
    expect(JSON.stringify(client.getQueriesData({ queryKey: ["orders"] }))).not.toContain(
      "FLATEA-",
    );
  });

  it("FS. a filtered page answered for another organization (another tab) is refused, rows and filters leave", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 120, "FTABA");
    await seedOrders(b.org, 120, "FTABB");
    signInAs(U1, a.org);
    setRouteSearch({ filter: "draft" });
    await mount();
    expect(shown()).toHaveLength(50);

    Object.assign(server, { userId: U1, organizationId: b.org });
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(text()).toContain("You switched account or business");
    expect(filterRow()).toBeNull();
    expect(JSON.stringify(client.getQueriesData({ queryKey: ["orders"] }))).not.toContain("FTABB-");
  });

  it("FT. orders.read revoked while filtered: page 2 is refused and every row leaves; restored, the filter returns", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 120, "FREV");
    signInAs(U2, org);
    setRouteSearch({ filter: "draft" });
    await mount();
    expect(shown()).toHaveLength(50);

    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(text()).toContain("You can't view orders");
    expect(filterRow()).toBeNull();

    // A chip cannot be used to ask again: there are none. Restored:
    await f.db.query(
      `insert into role_permissions(role_id,permission_id)
       select $1, id from permissions where key = 'orders.read'`,
      [viewerRole],
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U2, org) });
    });
    await readsSettled();
    expect(pressedChips()).toEqual(["Drafts"]);
    expect(shown()).toEqual((await dbOrder(org, "draft")).slice(0, 50));
  });

  it("FU. session expiry while filtered: rows leave, sign-in is requested; re-authentication reloads the filter from page 1", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 90, "FEXP", undefined, () => CONFIRMED_TO_PACK);
    signInAs(U1, org);
    setRouteSearch({ filter: "to_pack" });
    await mount();

    Object.assign(server, { userId: null, organizationId: null });
    await tap(LOAD_MORE);
    await readsSettled();
    expect(shown()).toEqual([]);
    expect(navigations).toContain("/sign-in");

    signInAs(U1, org);
    calls.length = 0;
    await act(async () => {
      await client.resetQueries({ queryKey: ordersKeys.listPages(U1, org) });
    });
    await readsSettled();
    expect(listCalls()[0]!.data).toEqual({ filter: "to_pack" });
    await loadEverything();
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));
  });

  it("FV. remount and eviction: the URL keeps the filter, and a cold cache starts it at page 1", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 120, "FGC");
    signInAs(U1, org);
    setRouteSearch({ filter: "draft" });
    const shared = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
    });
    await mount({ client: shared });
    await loadEverything();
    expect(shown()).toHaveLength(120);

    await unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(shared.getQueryData(ordersKeys.listPagesFor(U1, org, "draft"))).toBeUndefined();

    calls.length = 0;
    await mount({ client: shared });
    expect(pressedChips()).toEqual(["Drafts"]);
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]!.data).toEqual({ filter: "draft" });
    expect(shown()).toEqual((await dbOrder(org, "draft")).slice(0, 50));
  });

  it("FW. a create or a delivery change refreshes the filtered list (the list prefix still reaches it)", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 10, "FINV", undefined, () => CONFIRMED_TO_PACK);
    signInAs(U1, org);
    setRouteSearch({ filter: "to_pack" });
    await mount();
    expect(shown()).toHaveLength(10);

    await seedOrders(
      org,
      2,
      "FINVNEW",
      (i) => `now() - make_interval(secs => ${i})`,
      () => CONFIRMED_TO_PACK,
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ordersKeys.list(U1, org) });
    });
    await readsSettled();
    expect(shown()).toEqual(await dbOrder(org, "to_pack"));
    expect(shown()).toHaveLength(12);
  });
});

describe("Orders filters — URL, language and accessibility", () => {
  it("FX. the URL names the filter: unknown values read as All, chips write it back with replace", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 5, "FURL");
    signInAs(U1, org);
    setRouteSearch({ filter: "drop table orders" });
    await mount();
    expect(pressedChips()).toEqual(["All"]);
    expect(listCalls()[0]!.data).toEqual({});
    expect(shown()).toEqual(await dbOrder(org));

    await choose("awaiting_payment");
    expect(searchNavigations.at(-1)).toEqual({ filter: "awaiting_payment" });
    expect(pressedChips()).toEqual(["Payment due"]);
    // Tapping the chip already selected asks for nothing new.
    calls.length = 0;
    await choose("awaiting_payment");
    expect(listCalls()).toHaveLength(0);
  });

  it("FY. every offered chip, one pressed, in a labelled group; each a real button reachable by keyboard", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 3, "FACC");
    signInAs(U1, org);
    await mount();

    const buttons = chipButtons();
    expect(buttons.map((b) => chipLabel(b))).toEqual(VISIBLE.map((f) => CHIP[f]));
    expect(buttons.every((b) => b.type === "button" && !b.disabled)).toBe(true);
    expect(buttons.every((b) => ["true", "false"].includes(b.getAttribute("aria-pressed")!))).toBe(
      true,
    );
    expect(pressedChips()).toEqual(["All"]);
    // Selection is never colour alone: only the chosen chip carries a mark,
    // and the mark moves with the selection.
    const marked = () =>
      chipButtons()
        .filter((b) => b.querySelector("svg"))
        .map((b) => chipLabel(b));
    expect(marked()).toEqual(["All"]);
    await choose("to_pack");
    expect(marked()).toEqual(["Needs preparation"]);
    expect(pressedChips()).toEqual(["Needs preparation"]);
    // A chip label is never cut: no truncation on the chip or its text.
    expect(buttons.some((b) => /truncate|line-clamp/.test(b.innerHTML + b.className))).toBe(false);
  });

  it("GA. a screen reader meets the chips as ONE group named 'Filter orders' that holds every chip", async () => {
    const { org } = await newOrg();
    await seedOrders(org, 2, "FGRP");
    signInAs(U1, org);
    await mount();

    const group = filterRow();
    expect(group).not.toBeNull();
    expect(group!.getAttribute("role")).toBe("group");

    // The name sits on the group and on nothing else: not on a role-less
    // wrapper, where it would be silently dropped.
    const named = [...document.querySelectorAll("[aria-label],[aria-labelledby]")].filter(
      (element) => accessibleName(element) === "Filter orders",
    );
    expect(named).toEqual([group!]);

    // Each offered chip belongs to that group (its nearest group is it),
    // keeps its own name, and announces whether it is pressed.
    const chips = [...document.querySelectorAll("button")].filter((button) =>
      FILTERS.some((f) => chipLabel(button) === CHIP[f]),
    );
    expect(chips).toHaveLength(VISIBLE.length);
    expect(chips.every((chip) => chip.closest('[role="group"]') === group)).toBe(true);
    expect(chips.map((chip) => [chipLabel(chip), chip.getAttribute("aria-pressed")])).toEqual(
      VISIBLE.map((f) => [CHIP[f], f === "all" ? "true" : "false"]),
    );

    // Choosing a chip moves the pressed state inside the same group.
    await choose("processing");
    expect(filterRow()).toBe(group);
    expect(pressedChips()).toEqual(["Processing"]);
  });

  it("GB. when the chips change size after the first measure (a late Khmer font), the chosen chip is brought back on screen", async () => {
    // happy-dom has no layout, so the browser's part is played by hand: a
    // ResizeObserver whose callbacks this test fires, and the boxes Chromium
    // measured after a Khmer refresh (the chosen chip 72px off the left edge).
    const observers: { callback: () => void; targets: Element[] }[] = [];
    const original = globalThis.ResizeObserver;
    (globalThis as any).ResizeObserver = class {
      private entry: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      disconnect() {
        observers.splice(observers.indexOf(this.entry), 1);
      }
    };
    try {
      const { org } = await newOrg();
      await seedOrders(org, 2, "FFNT");
      signInAs(U1, org);
      setRouteSearch({ filter: "fulfilled" });
      await mount();

      const row = filterRow()!;
      const chosen = chipButtons().find((b) => b.getAttribute("aria-pressed") === "true")!;
      // The row and every chip are watched, so any change of size re-measures.
      const watched = observers.flatMap((o) => o.targets);
      expect(watched).toContain(row);
      expect(chipButtons().every((chip) => watched.includes(chip))).toBe(true);

      const box = (left: number, right: number) =>
        ({ left, right, top: 0, bottom: 44, width: right - left, height: 44 }) as DOMRect;
      row.getBoundingClientRect = () => box(0, 360);
      chosen.getBoundingClientRect = () => box(-72, 176);
      row.scrollLeft = 500;
      await act(async () => {
        for (const observer of [...observers]) observer.callback();
      });
      // Scrolled back by exactly the 72px that were off screen.
      expect(row.scrollLeft).toBe(428);
    } finally {
      (globalThis as any).ResizeObserver = original;
    }
  });

  it("FZ. Khmer: every chip, the filtered empty state and the filtered end read in Khmer", async () => {
    const km = (await import("@/locales/km.json")).default as any;
    const { org } = await newOrg();
    await seedOrders(org, 4, "FKM");
    signInAs(U1, org);
    await i18n.changeLanguage("km");
    setRouteSearch({ filter: "draft" });
    await mount();

    // In Khmer the same group carries the Khmer name.
    const group = groupNamed(km.orderList.filtersLabel);
    expect(group).not.toBeNull();
    const labels = [...group!.querySelectorAll("button")].map((b) => chipLabel(b));
    expect(labels).toEqual(VISIBLE.map((f) => km.orderList.filters[f]));
    expect(text()).toContain(km.orderList.endFiltered.title);

    await act(async () => {
      [...group!.querySelectorAll("button")]
        .find((b) => chipLabel(b) === km.orderList.filters.completed)!
        .click();
    });
    await readsSettled();
    expect(text()).toContain(km.orderList.emptyFilter.title);
    expect(text()).toContain(km.orderList.emptyFilter.showAll);
    expect(text()).not.toContain("No orders match this filter");
  });
});

// ── Home → Orders ────────────────────────────────────────────────────────────
//
// Home's attention cards open this screen (src/lib/home-attention.ts): "Orders
// awaiting payment" on the Awaiting payment filter, "Orders needing action" on
// All. The card's number comes from Home's OWN repository query
// (src/server/home/repository.ts getHomeOrderSummary), the list from the
// Orders server function: two different pieces of SQL over the same PGlite,
// held here to the same orders.

/** Wide enough to hold every seeded order; the attention counts ignore it anyway. */
const HOME_RANGE = { from: "2026-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" };

async function homeOrderCounts(org: string) {
  const { getHomeOrderSummary } = await import("@/server/home/repository");
  return getHomeOrderSummary(org, HOME_RANGE);
}

/**
 * Mount the Orders screen exactly where Home's card sends it: the card's own
 * destination, its search written into the URL as the router would.
 */
async function openFromHomeCard(id: "awaiting_payment" | "orders_needing_action") {
  const { attentionDestination } = await import("@/lib/home-attention");
  const destination = attentionDestination(id, (key) => key === "orders.read");
  if (!destination || destination.to !== "/app/orders") {
    throw new Error(`${id} does not open the Orders list`);
  }
  setRouteSearch(destination.search);
  await mount();
  return destination;
}

/** Order numbers Home's "needing action" predicate admits, read straight from the table. */
async function needingAction(org: string): Promise<string[]> {
  const result = await f.db.query<{ order_number: string }>(
    `select order_number from orders
      where organization_id = $1 and lifecycle_status <> 'cancelled'
        and (lifecycle_status = 'draft' or fulfillment_status = 'unfulfilled')`,
    [org],
  );
  return result.rows.map((row) => row.order_number);
}

describe("Home → Orders — the card's number is the list it opens", () => {
  it("HA. Awaiting payment: Home's count and the filtered list are the same orders, page after page", async () => {
    const { org } = await newOrg();
    await seedOrders(
      org,
      EVERY_COMBINATION.length,
      "HOME",
      undefined,
      (i) => EVERY_COMBINATION[i]!,
    );
    // Sixty older drafts, unpaid: the filtered list now runs past one page.
    await seedOrders(
      org,
      60,
      "HOMEOLD",
      (i) => `timestamptz '2026-09-01 12:00:00+00' - make_interval(secs => ${i})`,
    );
    signInAs(U1, org);

    const counts = await homeOrderCounts(org);
    // 36 of the 64 combinations (3 live lifecycles × unpaid|pending|failed × 4
    // fulfillments) plus the 60 drafts.
    expect(counts.awaitingPaymentCount).toBe(96);

    const destination = await openFromHomeCard("awaiting_payment");
    expect(destination.search).toEqual({ filter: "awaiting_payment" });
    // Arrives with the filter chosen and visible, and asks the server for it.
    expect(pressedChips()).toEqual(["Payment due"]);
    expect(listCalls()[0]!.data).toEqual({ filter: "awaiting_payment" });

    await loadEverything();
    expectNoDuplicates(shown());
    expect(shown()).toHaveLength(counts.awaitingPaymentCount);
    expect(shown()).toEqual(await dbOrder(org, "awaiting_payment"));
    expect(sentFilters().every((sent) => sent === "awaiting_payment")).toBe(true);
    expect(text()).toContain(END_FILTERED);
  });

  it("HB. Orders needing action opens All, which holds every order the card counts; no one filter does", async () => {
    const { org } = await newOrg();
    await seedOrders(org, EVERY_COMBINATION.length, "ACT", undefined, (i) => EVERY_COMBINATION[i]!);
    signInAs(U1, org);

    const counts = await homeOrderCounts(org);
    const counted = await needingAction(org);
    // 16 drafts (every payment × every fulfillment) + confirmed and completed
    // orders still unfulfilled (2 × 4 payments).
    expect(counts.actionNeededCount).toBe(24);
    expect(counted).toHaveLength(counts.actionNeededCount);

    const destination = await openFromHomeCard("orders_needing_action");
    expect(destination.search).toEqual({});
    expect(pressedChips()).toEqual(["All"]);
    expect(listCalls()[0]!.data).toEqual({});
    await loadEverything();
    const all = shown();
    expect(counted.filter((code) => !all.includes(code))).toEqual([]);

    // Any narrower filter would land on fewer orders than the number tapped.
    for (const filter of FILTERS.filter((name) => name !== "all")) {
      const list = await dbOrder(org, filter);
      const missing = counted.filter((code) => !list.includes(code)).length;
      expect({ filter, missesSome: missing > 0 }).toEqual({ filter, missesSome: true });
    }
  });

  it("HC. nothing awaiting payment: Home has no number to show, and the filter says it is empty, not ended", async () => {
    const { org } = await newOrg();
    const settled = EVERY_COMBINATION.filter(
      (axes) => !orderMatchesListFilter("awaiting_payment", axes),
    );
    await seedOrders(org, settled.length, "SETTLED", undefined, (i) => settled[i]!);
    signInAs(U1, org);

    expect((await homeOrderCounts(org)).awaitingPaymentCount).toBe(0);

    // Home renders no card at zero; a saved link or Back can still land here.
    await openFromHomeCard("awaiting_payment");
    expect(pressedChips()).toEqual(["Payment due"]);
    expect(shown()).toEqual([]);
    expect(text()).toContain(EMPTY_FILTERED);
    expect(text()).not.toContain(END_FILTERED);
    expect(buttonNamed(LOAD_MORE)).toBeNull();
  });

  it("HD. organization switch under the card's filter: each organization's list is its own Home count", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await seedOrders(a.org, 7, "HORGA");
    await seedOrders(b.org, 12, "HORGB");
    await seedOrders(b.org, 4, "HORGBPAID", undefined, () => ({
      lifecycle: "confirmed",
      payment: "paid",
      fulfillment: "unfulfilled",
    }));
    signInAs(U1, a.org);
    await openFromHomeCard("awaiting_payment");
    expect(shown()).toHaveLength((await homeOrderCounts(a.org)).awaitingPaymentCount);
    expect(shown().every((code) => code.startsWith("HORGA-"))).toBe(true);

    signInAs(U1, b.org);
    await rerender();
    expect(pressedChips()).toEqual(["Payment due"]);
    expect(shown().every((code) => code.startsWith("HORGB-"))).toBe(true);
    expect(shown()).toHaveLength((await homeOrderCounts(b.org)).awaitingPaymentCount);
    expect(shown()).toHaveLength(12);
    expect(cachedUnder(ordersKeys.principal(U1, a.org))).toEqual([]);
  });

  it("HE. orders.read revoked after Home drew the card: the server refuses the filtered list, no rows", async () => {
    const { org, viewerRole } = await newOrg();
    await seedOrders(org, 5, "HREV");
    signInAs(U2, org);
    // Home showed the card while U2 could still read orders.
    expect((await homeOrderCounts(org)).awaitingPaymentCount).toBe(5);
    await f.db.query(`delete from role_permissions where role_id = $1`, [viewerRole]);

    // This tab's capability snapshot still says orders.read (stale), so the
    // card was a link; the server is what refuses.
    await openFromHomeCard("awaiting_payment");
    expect(listCalls()[0]!.data).toEqual({ filter: "awaiting_payment" });
    expect(shown()).toEqual([]);
    expect(text()).toContain("You can't view orders");
    expect(filterRow()).toBeNull();
  });
});
