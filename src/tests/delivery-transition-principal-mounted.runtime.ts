/**
 * Delivery transitions — Start preparing, Mark ready (ready for courier),
 * Mark in transit, Mark as delivered, Mark as failed, Cancel delivery — run as
 * the principal that started them, or not at all, and their answers stay with
 * that principal and that delivery. MOUNTED, through the REAL server functions
 * and REAL SQL.
 *
 * Mounts the REAL Delivery detail screen (src/routes/app.deliveries.$id.tsx)
 * under the real CapabilityProvider, and lets it reach the database through
 * the real client adapters and the REAL src/api/deliveries.ts and
 * src/api/orders.ts modules — their zod validators, their handlers
 * (resolveAuthContext), the real services and repositories, and PGlite with
 * EVERY migration. Only what sits outside the server process is replaced:
 *
 *   - `createServerFn` → validator + handler, called in-process;
 *   - the session (`getSessionFn`) and the member's active organization — the
 *     principal the server derives when it HANDLES a request (`server` below);
 *   - the membership lookup behind `AuthorizationService.forRequest` — the real
 *     AuthorizationContext over a per-member grant set;
 *   - the capability snapshot and the Supabase admin client (→ PGlite);
 *   - the router hooks.
 *
 * Two principals are modelled, because they can disagree:
 *
 *   route   what THIS tab's /app route context says is signed in;
 *   server  what the server derives when it HANDLES a request — shared by
 *           every tab, so another tab moves it alone.
 *
 * A dispatch gate holds a request after it left the screen but before the
 * server derives its principal (the lazily imported server-function module,
 * then the trip). A response gate holds the answer after the server committed.
 * Every case asserts what was written — delivery status, delivery history,
 * order fulfillment and its history, parcels, audit rows — and by whom, and
 * what each principal's cache and screen received.
 *
 * Run through src/tests/delivery-transition-principal-mounted.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setDefaultTimeout,
} from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import { principalOf } from "./helpers/refuse-only-principal";

type Json = Record<string, any>;

// A wait gives up after 5 s (waitFor); a case must outlive its own longest
// wait, or a failing case is abandoned mid-flight and runs into the next one.
setDefaultTimeout(30000);

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();
/** Organization A sells in riel. */
const ORG_A = "cccccccc-0000-4000-8000-0000000000d1";
await f.db.query(
  `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
   values($1,'Riel shop','Riel shop','delivery-riel-shop',$2,'KHR')`,
  [ORG_A, f.actor],
);
/** Organization B — the fixture's own. */
const ORG_B = f.org;
const USER_A = f.actor;
/** A second member of the same organizations. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000e9";
await f.db.query("insert into auth.users(id,email) values($1,'member-b@test.invalid')", [USER_B]);

const WATER = { product: crypto.randomUUID(), variant: crypto.randomUUID() };
await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
  WATER.product,
  ORG_A,
  "Water-km",
  "Water",
]);
await f.db.query(
  `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
   values($1,$2,$3,'Water-sku','',5000,'KHR')`,
  [WATER.variant, ORG_A, WATER.product],
);

// ── Principals and grants ────────────────────────────────────────────────────

/** What this tab's /app route context says. */
const route = { userId: USER_A, organizationId: ORG_A };
/** What the server derives when it HANDLES a request — shared by every tab. */
const server = { userId: USER_A, organizationId: ORG_A, signedIn: true };

const ALL_GRANTS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.confirm",
  "delivery.read",
  "delivery.create",
  "delivery.update",
];
/** Server-side grants per member: the ONLY authority a request is checked against. */
const grants = new Map<string, Set<string>>();
function resetGrants() {
  grants.set(USER_A, new Set(ALL_GRANTS));
  grants.set(USER_B, new Set(ALL_GRANTS));
}
resetGrants();

// ── Supabase admin client → PGlite ───────────────────────────────────────────

/** Audit rows the services wrote (the admin client's audit_logs inserts). */
const audits: Json[] = [];

function sqlTransport() {
  const identifier = (value: string) => {
    if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };
  function select(table: string) {
    const where: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let single = false;
    // maybeSingle(): no row is data null with NO error, as in Supabase; only
    // single() reports PGRST116.
    let maybe = false;
    let max: number | undefined;
    let skip: number | undefined;
    const chain: any = {
      select(cols = "*") {
        columns = cols;
        return chain;
      },
      eq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} = $${values.length}`);
        return chain;
      },
      neq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} <> $${values.length}`);
        return chain;
      },
      is(key: string, value: unknown) {
        where.push(`${identifier(key)} is ${value === null ? "null" : String(value)}`);
        return chain;
      },
      in(key: string, list: unknown[]) {
        const params = list.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        where.push(list.length ? `${identifier(key)} in (${params.join(",")})` : "false");
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options?.ascending === false ? "desc" : "asc"}`);
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
        single = true;
        return chain;
      },
      maybeSingle() {
        single = true;
        maybe = true;
        return chain;
      },
      async execute() {
        let sql = `select ${columns} from ${table}`;
        if (where.length) sql += ` where ${where.join(" and ")}`;
        if (ordering.length) sql += ` order by ${ordering.join(",")}`;
        if (max !== undefined) sql += ` limit ${max}`;
        if (skip !== undefined) sql += ` offset ${skip}`;
        try {
          const rows = JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows));
          if (single) {
            return rows.length
              ? { data: rows[0], error: null }
              : maybe
                ? { data: null, error: null }
                : { data: null, error: { code: "PGRST116" } };
          }
          return { data: rows, error: null };
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
      if (table === "audit_logs") {
        return {
          insert: async (row: Json) => {
            audits.push(row);
            return { error: null };
          },
        };
      }
      return select(identifier(table));
    },
    async rpc(name: string, input: Record<string, unknown>) {
      const entries = Object.entries(input);
      const sql = `select ${identifier(name)}(${entries
        .map(([key], i) => `${identifier(key)} => $${i + 1}`)
        .join(",")}) as result`;
      const values = entries.map(([, value]) =>
        value !== null && typeof value === "object" ? JSON.stringify(value) : value,
      );
      try {
        const result = await f.db.query<{ result: unknown }>(sql, values);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));

// ── The server process: real server functions, the derived principal ────────

/** createServerFn(): the validator runs on what the browser sent, then the handler. */
mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validate: (data: unknown) => unknown) {
      return {
        handler(handle: (args: { data: unknown }) => unknown) {
          return async ({ data }: { data?: unknown } = {}) => handle({ data: validate(data) });
        },
      };
    },
    handler(handle: () => unknown) {
      return handle;
    },
  }),
}));
mock.module("@/api/auth", () => ({
  getSessionFn: async () =>
    server.signedIn
      ? { userId: server.userId, email: "member@test.invalid", emailVerified: true }
      : null,
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => server.organizationId,
}));
const realAuthorization = await import("@/server/auth/authorization");
/** The real AuthorizationContext over THIS member's grants. */
function contextFor(userId: string, organizationId: string) {
  return new realAuthorization.AuthorizationContext({
    membership: { user_id: userId, organization_id: organizationId, role_id: "role" },
    role: { system_role: "STAFF" },
    permissions: new Set(grants.get(userId) ?? []),
  } as any);
}
mock.module("@/server/auth/authorization", () => ({
  ...realAuthorization,
  AuthorizationService: {
    ...realAuthorization.AuthorizationService,
    forRequest: async (userId: string, organizationId: string) =>
      contextFor(userId, organizationId),
  },
}));
/** The next N capability refreshes fail (a network or server error), as a refresh can. */
let failCapabilityRefreshes = 0;
// The capability snapshot the server derives for the session's CURRENT principal.
mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => {
    if (failCapabilityRefreshes > 0) {
      failCapabilityRefreshes -= 1;
      throw Object.assign(new Error("capability refresh failed"), { statusCode: 503 });
    }
    return {
      status: "active",
      userId: server.userId,
      organizationId: server.organizationId,
      role: "STAFF",
      permissions: [...(grants.get(server.userId) ?? [])],
    };
  },
}));

type Transition =
  "startPreparing" | "markReady" | "markInTransit" | "markDelivered" | "markFailed" | "cancel";

/** The REAL src/api/deliveries.ts, captured before its transitions are wrapped in gates. */
const REAL = { ...(await import("@/api/deliveries")) } as Json;
const REAL_FN: Record<Transition, (args: { data: unknown }) => Promise<any>> = {
  startPreparing: REAL.startPreparingDeliveryFn,
  markReady: REAL.markDeliveryReadyFn,
  markInTransit: REAL.markDeliveryInTransitFn,
  markDelivered: REAL.markDeliveryDeliveredFn,
  markFailed: REAL.markDeliveryFailedFn,
  cancel: REAL.cancelDeliveryFn,
};

interface SentTransition {
  fn: Transition;
  /** Exactly what the browser sent. */
  data: Json;
  /** The principal the server derived when it HANDLED the request (null: no session). */
  server: { userId: string; organizationId: string } | null;
}
const sent: SentTransition[] = [];
/** The server's answer to each transition request, in order: "ok" or "refused:<code>". */
const outcomes: string[] = [];
/** The next transition request waits before the server derives its principal. */
let holdDispatchNext = false;
const dispatchGates: (() => void)[] = [];
/** The next transition request commits server-side, then its response is lost. */
let loseNextResponse = false;
/** The next transition request commits server-side, then its response waits for release(). */
let holdResponseNext = false;
const heldResponses: (() => void)[] = [];

function refusalCode(error: unknown): string {
  const e = error as Json;
  if (typeof e?.code === "string") return e.code;
  if (e?.name === "ZodError") return "invalid_request";
  return String(e?.statusCode ?? "error");
}

/** One transition request through the real server function, behind the gates. */
async function serve(fn: Transition, args: { data: Json }) {
  if (holdDispatchNext) {
    holdDispatchNext = false;
    await new Promise<void>((go) => dispatchGates.push(go));
  }
  const lose = loseNextResponse;
  loseNextResponse = false;
  const holdResponse = holdResponseNext;
  holdResponseNext = false;
  // Derived when the server HANDLES it: the real handler's resolveAuthContext
  // reads the session in the same turn.
  const index =
    sent.push({
      fn,
      data: JSON.parse(JSON.stringify(args.data ?? {})),
      server: server.signedIn
        ? { userId: server.userId, organizationId: server.organizationId }
        : null,
    }) - 1;
  let outcome: { value: unknown } | { error: unknown };
  try {
    outcome = { value: await REAL_FN[fn](args) };
    outcomes[index] = "ok";
  } catch (error) {
    outcome = { error };
    outcomes[index] = `refused:${refusalCode(error)}`;
  }
  if (holdResponse) await new Promise<void>((release) => heldResponses.push(release));
  if (lose) throw new TypeError("Failed to fetch");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
mock.module("@/api/deliveries", () => ({
  ...REAL,
  startPreparingDeliveryFn: (args: { data: Json }) => serve("startPreparing", args),
  markDeliveryReadyFn: (args: { data: Json }) => serve("markReady", args),
  markDeliveryInTransitFn: (args: { data: Json }) => serve("markInTransit", args),
  markDeliveryDeliveredFn: (args: { data: Json }) => serve("markDelivered", args),
  markDeliveryFailedFn: (args: { data: Json }) => serve("markFailed", args),
  cancelDeliveryFn: (args: { data: Json }) => serve("cancel", args),
}));

// ── Router hooks ─────────────────────────────────────────────────────────────

const routeParams = { id: "" };
/** Every navigation a screen asked for (the router's own navigate is not mounted). */
const navigations: Json[] = [];
const { createElement } = await import("react");
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => ({
      session: { userId: route.userId },
      organizationId: route.organizationId,
    }),
    useParams: () => ({ ...routeParams }),
  }),
  Link: ({ children, to: _to, params: _params, ...rest }: any) =>
    createElement("a", rest, children),
  useNavigate: () => (options: Json) => {
    navigations.push(options);
  },
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

// ── DOM ──────────────────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const reducedMotionQuery = (query: string) => ({
  matches: /prefers-reduced-motion:\s*reduce/.test(query),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = reducedMotionQuery;
(globalThis as any).matchMedia = reducedMotionQuery;
(window as any).HTMLElement.prototype.scrollIntoView = function () {};
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CapabilityProvider } = await import("@/hooks/use-capabilities");
const { capabilityQueryKey } = await import("@/lib/capabilities");
const { deliveryKeys } = await import("@/lib/deliveries-query");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const DeliveryDetailScreen = ((await import("@/routes/app.deliveries.$id")).Route as any)
  .component as () => React.ReactElement;
const { createOrder, transitionLifecycleStatus } = await import("@/server/orders/service");
const ordersRepo = await import("@/server/orders/repository");
const deliveriesRepo = await import("@/server/deliveries/repository");
const deliveries = (await import("@/server/deliveries/service")) as any;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

/** The /app layout's own wrapping, fed by this tab's route context. */
function tree() {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityProvider,
      { userId: route.userId, organizationId: route.organizationId } as any,
      React.createElement(DeliveryDetailScreen),
    ),
  );
}
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function rerender() {
  await act(async () => root!.render(tree()));
  await settle(12);
}
/**
 * Every setQueryData the screen made (TanStack marks those writes `manual`):
 * the key written and the delivery it carried. A fetch is not a manual write,
 * so this separates "the server answered this principal's own read" from "a
 * callback put a response here".
 */
const manualWrites: {
  key: readonly unknown[];
  deliveryId: string | null;
  status: string | null;
}[] = [];
async function mount() {
  const own = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = own;
  own.getQueryCache().subscribe((event) => {
    if (client !== own) return; // a previous case's client, settling late
    if (event.type === "updated" && event.action.type === "success" && event.action.manual) {
      const data = event.action.data as any;
      manualWrites.push({
        key: event.query.queryKey,
        deliveryId: data?.id ?? null,
        status: data?.status ?? null,
      });
    }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await rerender();
}
/** THIS tab switches member and/or organization: its route and the server move together. */
async function switchTo(next: { user?: string; org?: string }) {
  if (next.user) route.userId = server.userId = next.user;
  if (next.org) route.organizationId = server.organizationId = next.org;
  await rerender();
}
/** ANOTHER tab signs in as someone else or switches organization: only the server moves. */
function otherTab(next: { user?: string; org?: string }) {
  if (next.user) server.userId = next.user;
  if (next.org) server.organizationId = next.org;
}
/** The same principal opens another delivery: the screen stays mounted, the param moves. */
async function navigateTo(deliveryId: string) {
  routeParams.id = deliveryId;
  await rerender();
}
/** The screen is unmounted, then mounted again for `next` — the SAME query client. */
async function remountAs(next: { user?: string; org?: string }) {
  await act(async () => root!.unmount());
  if (next.user) route.userId = server.userId = next.user;
  if (next.org) route.organizationId = server.organizationId = next.org;
  root = createRoot(container!);
  await rerender();
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(async () => {
  // Each case starts with a full rate-limit budget; the buckets are not a ledger.
  await f.db.query("delete from rate_limit_buckets");
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  manualWrites.length = 0;
  sent.length = 0;
  outcomes.length = 0;
  navigations.length = 0;
  audits.length = 0;
  holdDispatchNext = false;
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  loseNextResponse = false;
  holdResponseNext = false;
  for (const release of heldResponses) release();
  heldResponses.length = 0;
  resetGrants();
  route.userId = server.userId = USER_A;
  route.organizationId = server.organizationId = ORG_A;
  server.signedIn = true;
  failCapabilityRefreshes = 0;
});
afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement | null;
async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 500)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
function button(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}
async function typeInto(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error(`no input; page: ${text().slice(0, 400)}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
/**
 * At least 80 rounds, and at least 5 s of real time before giving up: a count
 * of event-loop turns alone made every wait depend on how fast the in-process
 * database answered on the machine running the suite.
 */
async function waitFor(check: () => unknown, label: string) {
  const deadline = Date.now() + 5000;
  for (let i = 0; i < 80 || Date.now() < deadline; i++) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${label}; page: ${text().slice(0, 500)}`);
}
/** Every read the screen has started has answered, across several idle rounds. */
async function readsSettled() {
  let idleRounds = 0;
  await waitFor(() => {
    idleRounds = client.isFetching() === 0 ? idleRounds + 1 : 0;
    return idleRounds >= 4;
  }, "the screen's own reads to settle");
}
async function releaseDispatch(index = 0) {
  for (let i = 0; i < 200 && !dispatchGates[index]; i++) await settle(1);
  if (!dispatchGates[index]) throw new Error(`request ${index} was never dispatched`);
  await act(async () => dispatchGates[index]!());
  await settle(12);
}
async function releaseResponse(index = 0) {
  for (let i = 0; i < 200 && !heldResponses[index]; i++) await settle(1);
  if (!heldResponses[index]) throw new Error(`response ${index} was never held`);
  await act(async () => heldResponses[index]!());
  await settle(12);
}
/** The screen's notices (role=status). */
const notices = () =>
  [...document.querySelectorAll("[role=status]")].map((el) => el.textContent ?? "").join(" | ");
/** The screen's permissions are re-read from the server, as the provider would. */
async function refreshPermissions(user = USER_A, org = ORG_A) {
  await act(async () => {
    await client.refetchQueries({ queryKey: capabilityQueryKey(user, org), exact: true });
  });
  await settle(6);
}

// ── Seeding: a delivery of A's order in organization A, in a given status ────

let seq = 0;
const pad = (n: number) => String(n).padStart(8, "0");
interface Seeded {
  orderId: string;
  deliveryId: string;
  /** The courier's tracking number — private delivery data, unique per delivery. */
  tracking: string;
}
/**
 * A confirmed order of A's, Pack Order's packed marker on it (only a packed
 * order's delivery may be ready, migration 054), and a delivery created by A
 * through the delivery RPC, then moved by A to `status`.
 */
async function seedDelivery(status: "pending" | "preparing" | "ready" | "in_transit") {
  seq += 1;
  const ctx = contextFor(USER_A, ORG_A);
  const order = await createOrder(ctx, {
    expectedPrincipal: principalOf(ctx),
    source: "MANUAL",
    items: [{ variantId: WATER.variant, quantity: 1, productId: WATER.product }],
    customerId: null,
    locationId: null,
    sourceConversationRef: null,
    idempotencyKey: `fixture-delivery-${pad(seq)}`,
  } as any);
  await transitionLifecycleStatus(ctx, order.id, "confirmed", null, principalOf(ctx));
  const packed = await ordersRepo.recordOrderPacked(ORG_A, order.id, USER_A);
  expect(packed.status).toBe("success");
  const tracking = `TRK-PRIVATE-${pad(seq)}`;
  const created = await deliveriesRepo.createDelivery(ORG_A, USER_A, {
    order_id: order.id,
    location_id: null,
    provider_id: null,
    provider_key: null,
    provider_name: "Courier Sokha",
    external_tracking_number: tracking,
    cod_amount_minor: 7700 + seq,
  } as any);
  expect(created.status).toBe("success");
  const deliveryId = created.delivery_id!;
  const walk = [
    ["preparing", "startPreparingDelivery"],
    ["ready", "markDeliveryReady"],
    ["in_transit", "markDeliveryInTransit"],
  ] as const;
  for (const [to, step] of walk) {
    if (status === "pending") break;
    await deliveries[step](ctx, deliveryId, null, principalOf(ctx));
    if (to === status) break;
  }
  expect((await deliveryState(deliveryId)).status).toBe(status);
  audits.length = 0; // the seed's own rows are setup, not under test
  return { orderId: order.id, deliveryId, tracking } satisfies Seeded;
}

async function openDelivery(seeded: Seeded) {
  routeParams.id = seeded.deliveryId;
  await mount();
  await waitFor(() => text().includes(seeded.tracking), "the delivery detail");
  await readsSettled();
}

// ── Persisted figures ────────────────────────────────────────────────────────

/** Everything one delivery's transitions can write, with who wrote it. */
async function deliveryState(deliveryId: string) {
  const q = async (sql: string) => (await f.db.query<Json>(sql, [deliveryId])).rows;
  const [delivery] = await q(
    "select status, organization_id, order_id from deliveries where id = $1",
  );
  return {
    status: delivery!.status as string,
    organization: delivery!.organization_id as string,
    history: await q(
      `select from_status, to_status, changed_by, reason from delivery_status_history
        where delivery_id = $1 order by created_at, id`,
    ),
    orderHistory: await q(
      `select h.axis, h.from_status, h.to_status, h.changed_by from order_status_history h
         join deliveries d on d.order_id = h.order_id
        where d.id = $1 order by h.changed_at, h.id`,
    ),
  };
}
/** Every table a transition can write, for an exact before/after comparison. */
async function writeSurface() {
  const q = async (sql: string) => JSON.stringify((await f.db.query(sql)).rows);
  return {
    deliveries: await q("select id, status, updated_at from deliveries order by id"),
    deliveryHistory: await q("select id from delivery_status_history order by id"),
    orders: await q("select id, lifecycle_status, fulfillment_status from orders order by id"),
    orderHistory: await q("select id from order_status_history order by id"),
    parcels: await q("select id, status from parcels order by id"),
    rateLimits: await q("select * from rate_limit_buckets order by 1"),
    audits: audits.length,
  };
}
type Surface = Awaited<ReturnType<typeof writeSurface>>;
function wroteSince(before: Surface, after: Surface): string[] {
  return (Object.keys(before) as (keyof Surface)[]).filter((k) => before[k] !== after[k]);
}

const who = (id: string | null | undefined) =>
  id === USER_A ? "A" : id === USER_B ? "B" : String(id);

// ── Cache figures ────────────────────────────────────────────────────────────

const detailKeyOf = (user: string, org: string, deliveryId: string) =>
  deliveryKeys.detail(user, org, deliveryId);
const cachedStatus = (user: string, org: string, deliveryId: string) =>
  (client.getQueryData(detailKeyOf(user, org, deliveryId)) as any)?.status ?? null;
const detailState = (user: string, org: string, deliveryId: string) =>
  client.getQueryState(detailKeyOf(user, org, deliveryId));
/** Every cached entry in one principal's partitions (deliveries, orders, …). */
function partitionOf(user: string, org: string) {
  return client
    .getQueryCache()
    .getAll()
    .filter((q) => q.queryKey[1] === user && q.queryKey[2] === org)
    .map((q) => ({
      key: JSON.stringify(q.queryKey),
      data: q.state.data === undefined ? undefined : JSON.stringify(q.state.data),
    }));
}
/** The keys in that partition whose stored DATA holds this delivery's private tracking number. */
const holdingTracking = (user: string, org: string, tracking: string) =>
  partitionOf(user, org)
    .filter((e) => e.data?.includes(tracking))
    .map((e) => e.key);
const writesInto = (user: string, org: string) =>
  manualWrites
    .filter((w) => w.key[1] === user && w.key[2] === org)
    .map((w) => `${JSON.stringify(w.key)}=${w.deliveryId}:${w.status}`);

// ── The six transitions, as a merchant performs them ─────────────────────────

/** A private reason, its own per case — never shown to anyone but its author. */
let PRIVATE_REASON = "";
let reasonSeq = 0;

interface TransitionCase {
  name: string;
  fn: Transition;
  from: "pending" | "preparing" | "ready" | "in_transit";
  to: string;
  /** The tap that starts it (and, for a reason transition, the typed reason and submit). */
  tap: () => Promise<void>;
  /** Taps again as the same member — the sheet is reopened if it closed. */
  retry: () => Promise<void>;
}
async function tapAdvance(label: string) {
  await waitFor(() => button(label) && !button(label)!.disabled, label);
  await click(button(label), label);
}
async function openReasonSheet(open: string) {
  await waitFor(() => button(open) && !button(open)!.disabled, open);
  await click(button(open), open);
  await waitFor(() => dialog(), `${open} (sheet)`);
}
async function typeReason(reason: string) {
  await typeInto(dialog()!.querySelector("#delivery-reason"), reason);
}
async function submitReason(submit: string) {
  await click(button(submit, dialog()!), `${submit} (sheet)`);
}
function reasonTransition(
  name: string,
  fn: Transition,
  from: TransitionCase["from"],
  to: string,
  open: string,
  submit: string,
): TransitionCase {
  return {
    name,
    fn,
    from,
    to,
    tap: async () => {
      await openReasonSheet(open);
      await typeReason(PRIVATE_REASON);
      await submitReason(submit);
    },
    retry: async () => {
      if (!dialog()) {
        await openReasonSheet(open);
        await typeReason(PRIVATE_REASON);
      }
      await submitReason(submit);
    },
  };
}
function advanceTransition(
  name: string,
  fn: Transition,
  from: TransitionCase["from"],
  to: string,
  label: string,
): TransitionCase {
  return { name, fn, from, to, tap: () => tapAdvance(label), retry: () => tapAdvance(label) };
}
const TRANSITIONS: TransitionCase[] = [
  advanceTransition(
    "Start preparing",
    "startPreparing",
    "pending",
    "preparing",
    en.delivery.startPreparing,
  ),
  advanceTransition("Ready for courier", "markReady", "preparing", "ready", en.delivery.markReady),
  advanceTransition(
    "In transit",
    "markInTransit",
    "ready",
    "in_transit",
    en.delivery.markInTransit,
  ),
  advanceTransition(
    "Delivered",
    "markDelivered",
    "in_transit",
    "delivered",
    en.delivery.markDelivered,
  ),
  reasonTransition(
    "Failed delivery",
    "markFailed",
    "in_transit",
    "failed",
    en.delivery.markFailed,
    en.delivery.failSheet.submit,
  ),
  reasonTransition(
    "Cancel delivery",
    "cancel",
    "pending",
    "cancelled",
    en.delivery.cancelDelivery,
    en.delivery.cancelSheet.submit,
  ),
];
const doneNotice = (to: string) =>
  en.delivery.actionDoneStatus.replace("{{status}}", en.status[to]);

/** Exactly one transition was written — this one, by `user` — and the delivery is in `to`. */
async function expectTransitionedBy(
  t: TransitionCase,
  seeded: Seeded,
  user: string,
  historyBefore: number,
) {
  const s = await deliveryState(seeded.deliveryId);
  expect(s.status).toBe(t.to);
  const added = s.history.slice(historyBefore);
  expect(added.map((h) => `${h.from_status}->${h.to_status}:${who(h.changed_by)}`)).toEqual([
    `${t.from}->${t.to}:${who(user)}`,
  ]);
  return s;
}
function evidence(label: string, extra: Json = {}) {
  console.log(
    `[evidence] ${label}: server=[${outcomes.join(",")}] handledAs=${JSON.stringify(
      sent.map((s) =>
        s.server
          ? `${who(s.server.userId)}@${s.server.organizationId === ORG_A ? "A" : "B"}`
          : "none",
      ),
    )} sentPrincipal=${JSON.stringify(sent.map((s) => s.data.expectedPrincipal ?? null))} ${JSON.stringify(extra)}`,
  );
}

beforeEach(() => {
  reasonSeq += 1;
  PRIVATE_REASON = `PRIVATE-REASON-${String(reasonSeq).padStart(4, "0")}`;
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 — a transition runs as the member who started it, or not at all
// ═══════════════════════════════════════════════════════════════════════════

for (const t of TRANSITIONS) {
  describe(`${t.name}: runs as the member who started it, or not at all`, () => {
    it("member A → B (same organization) while dispatching: refused before B's grant decides it, nothing written; A's retry is A's", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
      holdDispatchNext = true;
      await t.tap(); // left the screen as A, not yet at the server
      await switchTo({ user: USER_B });
      const before = await writeSurface();
      await releaseDispatch(); // handled while the session is member B's
      const wrote = wroteSince(before, await writeSurface());
      const during = await deliveryState(seeded.deliveryId);
      evidence(`${t.name}, member A→B while dispatching`, {
        status: during.status,
        history: during.history.slice(historyBefore).map((h) => who(h.changed_by)),
        wrote,
      });

      expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
      expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });
      expect(outcomes[0]).toBe("refused:principal_changed");
      expect(wrote).toEqual([]);
      expect(during.status).toBe(t.from);

      await switchTo({ user: USER_A });
      await readsSettled();
      await t.tap();
      await waitFor(() => outcomes.length === 2, "A's retry");
      expect(outcomes[1]).toBe("ok");
      await expectTransitionedBy(t, seeded, USER_A, historyBefore);
    });

    it("A lacks delivery.update, B holds it: B's grant never moves A's delivery", async () => {
      const seeded = await seedDelivery(t.from);
      grants.get(USER_A)!.delete("delivery.update");
      await openDelivery(seeded);
      holdDispatchNext = true;
      await t.tap();
      await switchTo({ user: USER_B });
      const before = await writeSurface();
      await releaseDispatch();
      const wrote = wroteSince(before, await writeSurface());
      evidence(`${t.name}, A unauthorized / B authorized`, { wrote });
      expect(outcomes[0]).toBe("refused:principal_changed");
      expect(wrote).toEqual([]);
      expect((await deliveryState(seeded.deliveryId)).status).toBe(t.from);

      // A's own request, as A: refused by A's own permission, nothing written.
      await switchTo({ user: USER_A });
      await readsSettled();
      const beforeRetry = await writeSurface();
      await t.retry();
      await waitFor(() => outcomes.length === 2, "A's own request");
      expect(outcomes[1]).toBe("refused:403");
      expect(wroteSince(beforeRetry, await writeSurface())).toEqual([]);
    });

    it("A holds delivery.update, B lacks it: refused as principal_changed — never B's 403 — nothing written", async () => {
      const seeded = await seedDelivery(t.from);
      grants.get(USER_B)!.delete("delivery.update");
      await openDelivery(seeded);
      holdDispatchNext = true;
      await t.tap();
      await switchTo({ user: USER_B });
      const before = await writeSurface();
      await releaseDispatch();
      const wrote = wroteSince(before, await writeSurface());
      evidence(`${t.name}, A authorized / B unauthorized`, { wrote });
      expect(outcomes[0]).toBe("refused:principal_changed");
      expect(wrote).toEqual([]);
    });

    it("organization A → B while dispatching: refused as principal_changed — not a misleading 404 — nothing written in either organization", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      holdDispatchNext = true;
      await t.tap();
      await switchTo({ user: USER_B, org: ORG_B });
      const before = await writeSurface();
      await releaseDispatch();
      const wrote = wroteSince(before, await writeSurface());
      evidence(`${t.name}, organization A→B`, { wrote });
      expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_B });
      expect(outcomes[0]).toBe("refused:principal_changed");
      expect(wrote).toEqual([]);
    });

    it("another tab signs in as member B: refused, the screen (still A's) is not moved; A's retry once A is back is A's", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
      otherTab({ user: USER_B }); // this tab still shows A
      const before = await writeSurface();
      await t.tap();
      await waitFor(() => outcomes.length === 1, "the request");
      const wrote = wroteSince(before, await writeSurface());
      evidence(`${t.name}, another tab as B`, { wrote });
      expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
      expect(outcomes[0]).toBe("refused:principal_changed");
      expect(wrote).toEqual([]);
      await readsSettled();
      expect(cachedStatus(USER_A, ORG_A, seeded.deliveryId)).toBe(t.from);
      expect(notices()).not.toContain(doneNotice(t.to));

      otherTab({ user: USER_A });
      await t.retry();
      await waitFor(() => outcomes.length === 2, "A's retry");
      expect(outcomes[1]).toBe("ok");
      await expectTransitionedBy(t, seeded, USER_A, historyBefore);
    });

    it("A → B → A while dispatching: lands as A — A's own transition, applied once", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
      holdDispatchNext = true;
      await t.tap();
      await switchTo({ user: USER_B });
      await switchTo({ user: USER_A });
      await releaseDispatch();
      await waitFor(() => outcomes.length === 1, "the request");
      expect(outcomes[0]).toBe("ok");
      await expectTransitionedBy(t, seeded, USER_A, historyBefore);
    });

    it("A stays signed in: the transition is A's, written into A's own detail entry and announced", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
      await t.tap();
      await waitFor(() => notices().includes(doneNotice(t.to)), "the done notice");
      expect(outcomes).toEqual(["ok"]);
      expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });
      const s = await expectTransitionedBy(t, seeded, USER_A, historyBefore);
      // Every order-fulfillment row this transition wrote is A's too.
      expect(
        s.orderHistory.filter((h) => h.changed_by !== USER_A && h.changed_by !== null),
      ).toEqual([]);
      expect(cachedStatus(USER_A, ORG_A, seeded.deliveryId)).toBe(t.to);
      expect(writesInto(USER_A, ORG_A)).toEqual([
        `${JSON.stringify(detailKeyOf(USER_A, ORG_A, seeded.deliveryId))}=${seeded.deliveryId}:${t.to}`,
      ]);
      expect(manualWrites.filter((w) => w.key[1] !== USER_A || w.key[2] !== ORG_A)).toEqual([]);
      expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
    });

    it("the real server function refuses a request that does not say who started it — before anything runs", async () => {
      const seeded = await seedDelivery(t.from);
      const before = await writeSurface();
      const reason =
        t.fn === "markFailed" || t.fn === "cancel" ? { reason: "Courier no-show" } : {};
      const refusals: string[] = [];
      for (const extra of [
        {},
        { expectedPrincipal: null },
        { expectedPrincipal: { userId: USER_A } },
        { expectedPrincipal: { userId: USER_A, organizationId: ORG_A, role: "OWNER" } },
      ]) {
        try {
          await REAL_FN[t.fn]({ data: { deliveryId: seeded.deliveryId, ...reason, ...extra } });
          refusals.push("ok");
        } catch (error) {
          refusals.push(refusalCode(error));
        }
      }
      const wrote = wroteSince(before, await writeSurface());
      evidence(`${t.name}, no initiating principal`, { refusals, wrote });
      expect(refusals).toEqual([
        "invalid_request",
        "invalid_request",
        "invalid_request",
        "invalid_request",
      ]);
      expect(wrote).toEqual([]);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #2 — a late answer stays with the principal and the delivery that asked
// ═══════════════════════════════════════════════════════════════════════════

for (const t of TRANSITIONS) {
  describe(`${t.name}: a late answer stays with the principal and the delivery that asked`, () => {
    for (const to of [
      {
        label: "member A → B in the same organization, B reads deliveries but cannot update them",
        user: USER_B,
        org: ORG_A,
        read: true,
      },
      {
        label: "organization A → B, B cannot read deliveries",
        user: USER_B,
        org: ORG_B,
        read: false,
      },
    ]) {
      it(`delayed success, ${to.label}: committed as A, never written, rendered or announced to B`, async () => {
        const seeded = await seedDelivery(t.from);
        await openDelivery(seeded);
        const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
        holdResponseNext = true;
        await t.tap();
        await waitFor(() => outcomes[0] === "ok", "A's transition committed");
        grants.get(USER_B)!.delete("delivery.update");
        if (!to.read) grants.get(USER_B)!.delete("delivery.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedStatus(to.user, to.org, seeded.deliveryId) === t.to,
            "B's own read",
          );
        await readsSettled();
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse(); // A's answer lands while B is shown
        await readsSettled();
        evidence(`late ${t.name}, ${to.label}`, {
          bWrites: writesInto(to.user, to.org),
          bHoldsTracking: holdingTracking(to.user, to.org, seeded.tracking),
          shows: text().slice(0, 160),
        });

        // The server's act is A's, and only A's.
        expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_A });
        await expectTransitionedBy(t, seeded, USER_A, historyBefore);

        // B's cache: no write from A's callback; every entry exactly as it was.
        expect(writesInto(to.user, to.org)).toEqual([]);
        expect(partitionOf(to.user, to.org)).toEqual(bBefore);
        if (!to.read) {
          expect(holdingTracking(to.user, to.org, seeded.tracking)).toEqual([]);
          expect(text()).not.toContain(seeded.tracking);
        }
        // B's screen: unchanged by A's completion — no A delivery, notice or sheet.
        expect(text()).toBe(shownBefore);
        expect(notices()).not.toContain(doneNotice(t.to));
        expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
        expect(navigations).toEqual([]);

        // A's partition: not written after A switched away — only marked stale.
        expect(writesInto(USER_A, ORG_A)).toEqual([]);
        expect(detailState(USER_A, ORG_A, seeded.deliveryId)?.isInvalidated).toBe(true);

        // A comes back: the committed result, read from the server as A.
        await switchTo({ user: USER_A, org: ORG_A });
        await waitFor(() => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to, "A's re-read");
        expect(writesInto(USER_A, ORG_A)).toEqual([]);
      });

      it(`delayed failure after the server committed, ${to.label}: nothing of A's reaches B — no error, notice or sheet`, async () => {
        const seeded = await seedDelivery(t.from);
        await openDelivery(seeded);
        holdResponseNext = true;
        loseNextResponse = true; // committed, then the response fails
        await t.tap();
        await waitFor(() => outcomes[0] === "ok", "A's transition committed");
        grants.get(USER_B)!.delete("delivery.update");
        if (!to.read) grants.get(USER_B)!.delete("delivery.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedStatus(to.user, to.org, seeded.deliveryId) === t.to,
            "B's own read",
          );
        await readsSettled();
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse();
        await readsSettled();
        evidence(`late ${t.name} failure, ${to.label}`, { shows: text().slice(0, 160) });
        expect(partitionOf(to.user, to.org)).toEqual(bBefore);
        expect(writesInto(to.user, to.org)).toEqual([]);
        expect(text()).toBe(shownBefore); // no A error banner, no A data, no notice
        expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
        // A's typed reason is in no field B could submit. (Once committed it is
        // part of the delivery's own history, which B's authorized read shows.)
        expect(
          [...document.querySelectorAll("input")].filter((i) => i.value.includes(PRIVATE_REASON)),
        ).toEqual([]);

        await switchTo({ user: USER_A, org: ORG_A });
        await waitFor(
          () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to,
          "A's recovery read",
        );
      });
    }

    it("delayed success, the same member opens another delivery (D1 → D2): D1's answer never overwrites D2", async () => {
      const d1 = await seedDelivery(t.from);
      const d2 = await seedDelivery(t.from);
      await openDelivery(d1);
      holdResponseNext = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "D1's transition committed");
      await navigateTo(d2.deliveryId);
      await waitFor(() => text().includes(d2.tracking), "D2's detail");
      await readsSettled();
      const d2Before = client.getQueryData(detailKeyOf(USER_A, ORG_A, d2.deliveryId));
      const shownBefore = text();
      await releaseResponse(); // D1's answer lands while D2 is shown
      await readsSettled();
      evidence(`late ${t.name}, D1 → D2`, {
        writes: writesInto(USER_A, ORG_A),
        shows: text().slice(0, 160),
      });
      expect(client.getQueryData(detailKeyOf(USER_A, ORG_A, d2.deliveryId))).toEqual(d2Before);
      expect(cachedStatus(USER_A, ORG_A, d2.deliveryId)).toBe(t.from);
      expect(text()).toBe(shownBefore);
      expect(text()).not.toContain(d1.tracking);
      expect(notices()).not.toContain(doneNotice(t.to));
      expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect((await deliveryState(d2.deliveryId)).status).toBe(t.from);
      // D1's entry was only marked stale; going back re-reads D1's committed status.
      expect(detailState(USER_A, ORG_A, d1.deliveryId)?.isInvalidated).toBe(true);
      await navigateTo(d1.deliveryId);
      await waitFor(() => cachedStatus(USER_A, ORG_A, d1.deliveryId) === t.to, "D1's re-read");
      await waitFor(() => text().includes(d1.tracking), "D1, shown again");
    });

    it("A → B → A, then the late answer: A sees its own committed delivery; B's partition untouched", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      holdResponseNext = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "A's transition committed");
      grants.get(USER_B)!.delete("delivery.read");
      await switchTo({ user: USER_B, org: ORG_B });
      await switchTo({ user: USER_A, org: ORG_A });
      await releaseResponse();
      await waitFor(
        () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to,
        "A's committed delivery",
      );
      expect(writesInto(USER_B, ORG_B)).toEqual([]);
      expect(holdingTracking(USER_B, ORG_B, seeded.tracking)).toEqual([]);
      await waitFor(() => text().includes(seeded.tracking), "A's delivery, shown");
    });

    it("the screen remounts as B before the answer: written nowhere, shown to no one", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      holdResponseNext = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "A's transition committed");
      grants.get(USER_B)!.delete("delivery.read");
      await remountAs({ user: USER_B, org: ORG_B });
      await readsSettled();
      const shownBefore = text();
      await releaseResponse();
      await readsSettled();
      expect(writesInto(USER_B, ORG_B)).toEqual([]);
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(text()).toBe(shownBefore);
      expect(text()).not.toContain(seeded.tracking);
    });

    it("A's delivery.read revoked in place, permissions and delivery re-read (denied), then the late answer: nothing restored; an authorized re-read recovers", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      holdResponseNext = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "A's transition committed");
      grants.get(USER_A)!.delete("delivery.read");
      await refreshPermissions();
      await act(async () => {
        await client.refetchQueries({
          queryKey: detailKeyOf(USER_A, ORG_A, seeded.deliveryId),
          exact: true,
        });
      });
      await settle(6);
      await waitFor(
        () => detailState(USER_A, ORG_A, seeded.deliveryId)?.status === "error",
        "the server's denied re-read",
      );
      expect(text()).not.toContain(seeded.tracking);
      await releaseResponse();
      await readsSettled();
      evidence(`late ${t.name}, A's read revoked in place`, {
        writes: writesInto(USER_A, ORG_A),
        detail: detailState(USER_A, ORG_A, seeded.deliveryId)?.status,
      });
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(detailState(USER_A, ORG_A, seeded.deliveryId)?.status).toBe("error");
      expect(text()).not.toContain(seeded.tracking);
      expect(notices()).not.toContain(doneNotice(t.to));

      // Legitimate recovery: the grant is restored and a FRESH authorized read
      // (never the old answer) shows A the committed delivery.
      grants.get(USER_A)!.add("delivery.read");
      await refreshPermissions();
      await act(async () => {
        await client.refetchQueries({
          queryKey: detailKeyOf(USER_A, ORG_A, seeded.deliveryId),
          exact: true,
        });
      });
      await waitFor(
        () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to,
        "the authorized re-read",
      );
      // The screen renders the re-read once its observer is notified.
      await waitFor(() => text().includes(seeded.tracking), "the delivery, shown again");
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
    });

    it("the permission refresh FAILS before the late answer (snapshot no longer trustworthy): not applied; a fresh authorized read recovers", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      holdResponseNext = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "A's transition committed");
      failCapabilityRefreshes = 1;
      await refreshPermissions();
      expect(client.getQueryState(capabilityQueryKey(USER_A, ORG_A))?.status).toBe("error");
      await releaseResponse();
      expect(writesInto(USER_A, ORG_A)).toEqual([]); // fail closed: not written
      expect(notices()).not.toContain(doneNotice(t.to));
      // A still holds delivery.read server-side: the re-read the late answer
      // asked for is the authorized recovery.
      await waitFor(
        () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to,
        "the authorized re-read",
      );
    });

    it("a lost response (same member): the screen re-reads the committed delivery; the transition was written once, by A, and a retry writes nothing", async () => {
      const seeded = await seedDelivery(t.from);
      await openDelivery(seeded);
      const historyBefore = (await deliveryState(seeded.deliveryId)).history.length;
      loseNextResponse = true;
      await t.tap();
      await waitFor(() => outcomes[0] === "ok", "A's transition committed");
      await waitFor(
        () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === t.to,
        "the committed delivery, re-read",
      );
      evidence(`lost ${t.name}`, { shows: text().slice(0, 160) });
      await expectTransitionedBy(t, seeded, USER_A, historyBefore);
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      // The same transition sent again (a retry of the lost request) is refused
      // by the delivery state machine and writes nothing.
      const before = await writeSurface();
      const reason = t.fn === "markFailed" || t.fn === "cancel" ? { reason: PRIVATE_REASON } : {};
      let retried = "ok";
      try {
        await REAL_FN[t.fn]({
          data: {
            deliveryId: seeded.deliveryId,
            ...reason,
            expectedPrincipal: { userId: USER_A, organizationId: ORG_A },
          },
        });
      } catch (error) {
        retried = refusalCode(error);
      }
      expect(retried).toBe("409");
      expect(wroteSince(before, await writeSurface())).toEqual([]);
      await expectTransitionedBy(t, seeded, USER_A, historyBefore);
    });
  });
}

describe("a newer transition is never overwritten by an older one's late answer", () => {
  it("Start preparing (answer held), A → B → A, then Cancel completes: the old answer does not bring 'preparing' back", async () => {
    const seeded = await seedDelivery("pending");
    await openDelivery(seeded);
    holdResponseNext = true;
    await tapAdvance(en.delivery.startPreparing); // attempt 1: committed, answer held
    await waitFor(() => outcomes[0] === "ok", "Start preparing committed");
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await waitFor(
      () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === "preparing",
      "A's re-read",
    );
    await openReasonSheet(en.delivery.cancelDelivery); // attempt 2, as A
    await typeReason(PRIVATE_REASON);
    await submitReason(en.delivery.cancelSheet.submit);
    await waitFor(
      () => cachedStatus(USER_A, ORG_A, seeded.deliveryId) === "cancelled",
      "the cancel",
    );
    await releaseResponse(); // attempt 1's answer: the PREPARING delivery
    await readsSettled();
    expect(outcomes).toEqual(["ok", "ok"]);
    expect((await deliveryState(seeded.deliveryId)).status).toBe("cancelled");
    expect(cachedStatus(USER_A, ORG_A, seeded.deliveryId)).toBe("cancelled");
    expect(notices()).toContain(doneNotice("cancelled"));
    expect(writesInto(USER_A, ORG_A).filter((w) => w.endsWith(":preparing"))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The reason sheets: a typed reason belongs to its member and its delivery
// ═══════════════════════════════════════════════════════════════════════════

const REASON_SHEETS = [
  {
    name: "Mark as failed",
    from: "in_transit" as const,
    open: en.delivery.markFailed,
    submit: en.delivery.failSheet.submit,
  },
  {
    name: "Cancel delivery",
    from: "pending" as const,
    open: en.delivery.cancelDelivery,
    submit: en.delivery.cancelSheet.submit,
  },
];
const reasonOnScreen = () => ({
  fields: [...document.querySelectorAll("input")]
    .map((i) => i.value)
    .filter((v) => v.includes(PRIVATE_REASON)),
  text: text().includes(PRIVATE_REASON) ? [PRIVATE_REASON] : [],
});
const noReason = { fields: [], text: [] };

for (const sheet of REASON_SHEETS) {
  describe(`${sheet.name}: the typed reason stays with the member and the delivery it was typed for`, () => {
    for (const to of [
      {
        label: "member A → B in the same organization, B's detail already cached",
        user: USER_B,
        org: ORG_A,
      },
      { label: "organization A → B", user: USER_B, org: ORG_B },
    ]) {
      it(`${to.label}: A's open sheet is gone at once — B can neither see nor submit it`, async () => {
        const seeded = await seedDelivery(sheet.from);
        await openDelivery(seeded);
        await switchTo({ user: to.user, org: to.org }); // B's detail is cached
        await switchTo({ user: USER_A, org: ORG_A });
        await readsSettled();
        await openReasonSheet(sheet.open);
        await typeReason(PRIVATE_REASON);
        expect(reasonOnScreen().fields.length).toBe(1); // A sees A's reason
        await switchTo({ user: to.user, org: to.org });
        const atSwitch = reasonOnScreen();
        const open = dialog();
        const submitAsB = open ? button(sheet.submit, open) : undefined;
        const submittable = Boolean(submitAsB && !submitAsB.disabled);
        if (submittable) await submitReason(sheet.submit);
        await settle(10);
        evidence(`${sheet.name} draft, ${to.label}`, {
          atSwitch,
          sheetOpenForB: open !== null,
          submittable,
        });
        expect(atSwitch).toEqual(noReason);
        expect({ sheetOpen: open !== null }).toEqual({ sheetOpen: false });
        expect(submittable).toBe(false);
        expect(sent).toEqual([]);
        expect((await deliveryState(seeded.deliveryId)).status).toBe(sheet.from);
      });
    }

    it("D1 → D2 (same member): D1's open sheet and typed reason are gone; nothing can be submitted against D2", async () => {
      const d1 = await seedDelivery(sheet.from);
      const d2 = await seedDelivery(sheet.from);
      await openDelivery(d1);
      await openReasonSheet(sheet.open);
      await typeReason(PRIVATE_REASON);
      await navigateTo(d2.deliveryId);
      await waitFor(() => text().includes(d2.tracking), "D2's detail");
      expect(reasonOnScreen()).toEqual(noReason);
      expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
      await openReasonSheet(sheet.open);
      expect(reasonOnScreen()).toEqual(noReason);
      expect(sent).toEqual([]);
    });

    it("A → B → A: A's reason does not come back; the sheet reopens empty", async () => {
      const seeded = await seedDelivery(sheet.from);
      await openDelivery(seeded);
      await openReasonSheet(sheet.open);
      await typeReason(PRIVATE_REASON);
      await switchTo({ user: USER_B });
      await switchTo({ user: USER_A });
      expect({ sheetOpen: dialog() !== null }).toEqual({ sheetOpen: false });
      expect(reasonOnScreen()).toEqual(noReason);
      await readsSettled();
      await openReasonSheet(sheet.open);
      expect(reasonOnScreen()).toEqual(noReason);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// In-place revocation: an earlier read is not proof of access now
// ═══════════════════════════════════════════════════════════════════════════

describe("Delivery detail: in-place delivery.read revocation", () => {
  it("A's delivery.read revoked and the permission refresh says so: the delivery on screen (tracking, COD) is withdrawn at once", async () => {
    const seeded = await seedDelivery("in_transit");
    await openDelivery(seeded);
    expect(text()).toContain(seeded.tracking);
    grants.get(USER_A)!.delete("delivery.read");
    await refreshPermissions(); // the delivery itself has NOT been re-read yet
    evidence("in-place delivery.read revocation, permissions refreshed only", {
      shows: text().slice(0, 160),
    });
    expect(text()).not.toContain(seeded.tracking);
    expect(text()).not.toContain(en.delivery.cod);
    expect(text()).toContain(en.delivery.denied);
    // A presentation gate: nothing was written or evicted to get there.
    expect(manualWrites).toEqual([]);
    grants.get(USER_A)!.add("delivery.read");
    await refreshPermissions();
    await waitFor(() => text().includes(seeded.tracking), "the delivery, readable again");
  });
});
