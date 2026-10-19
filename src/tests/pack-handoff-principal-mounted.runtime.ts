/**
 * Mark Packed, Retry delivery ready and Courier Handoff run as the principal
 * that started them — or not at all — and their answers stay with it.
 * MOUNTED, through the REAL server functions and REAL SQL.
 *
 * Mounts the REAL screens a warehouse member uses for these mutations:
 *
 *   - Pack Order (src/routes/app.pack.$orderId.tsx): Mark Packed — with no
 *     delivery yet (the packed marker on the order) and with a pending delivery
 *     (readied with the marker);
 *   - Order detail's "Retry delivery ready" action
 *     (src/components/fulfillment/RetryDeliveryReadyAction.tsx, behind the
 *     boundary Order detail renders it through);
 *   - Courier Handoff (src/routes/app.handoff.$parcelCode.tsx): Confirm Handoff.
 *
 * Each sits under the real CapabilityProvider and reaches the database through
 * the REAL src/api/packing.ts and src/api/handoff.ts modules — their zod
 * validators, their handlers (resolveAuthContext), the real services and
 * repositories, and PGlite with EVERY migration. Only what sits outside the
 * server process is replaced: `createServerFn` (validator + handler,
 * in-process), the session and the member's active organization (the
 * principal the server derives when it HANDLES a request), the membership
 * lookup behind `AuthorizationService.forRequest` (the real
 * AuthorizationContext over a per-member grant set), the capability snapshot,
 * the Supabase admin client (→ PGlite), toasts, the camera sheet and the router
 * hooks.
 *
 * Two principals are modelled, because they can disagree:
 *
 *   route   what THIS tab's /app route context says is signed in;
 *   server  what the server derives when it HANDLES a request — shared by
 *           every tab, so another tab moves it alone.
 *
 * A dispatch gate holds a request after it left the screen but before the
 * server derives its principal; a response gate holds the answer after the
 * server committed. Every case asserts what was written — order fulfillment,
 * order and delivery history, delivery status, parcels — and by whom, and what
 * each principal's screen and cache received.
 *
 * Run through src/tests/pack-handoff-principal-mounted.test.ts (own process).
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
const ORG_A = "cccccccc-0000-4000-8000-0000000000e1";
await f.db.query(
  `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
   values($1,'Riel shop','Riel shop','pack-handoff-riel-shop',$2,'KHR')`,
  [ORG_A, f.actor],
);
/** Organization B — the fixture's own. */
const ORG_B = f.org;
const USER_A = f.actor;
/** A second member of the same organizations. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000f3";
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
  // Mark Packed, Retry delivery ready and Courier Handoff require it.
  "delivery.handoff",
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
    let counted = false;
    let skip: number | undefined;
    const chain: any = {
      select(cols = "*", options?: { count?: "exact" }) {
        columns = cols;
        // Prefer: count=exact — the whole filtered set (listVariantsByOrg asks).
        counted = options?.count === "exact";
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
        const filtered = where.length ? ` where ${where.join(" and ")}` : "";
        sql += filtered;
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
          const count = counted
            ? Number(
                (
                  await f.db.query<{ n: number }>(
                    `select count(*)::int as n from ${table}${filtered}`,
                    values,
                  )
                ).rows[0]!.n,
              )
            : null;
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
// The capability snapshot the server derives for the session's CURRENT principal.
mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => ({
    status: "active",
    userId: server.userId,
    organizationId: server.organizationId,
    role: "STAFF",
    permissions: [...(grants.get(server.userId) ?? [])],
  }),
}));

type Op = "markPacked" | "retryReady" | "confirmHandoff";

/** The REAL server functions, captured before they are wrapped in gates. */
const REAL_PACKING = { ...(await import("@/api/packing")) } as Json;
const REAL_HANDOFF = { ...(await import("@/api/handoff")) } as Json;
const REAL_OP: Record<Op, (args: { data: unknown }) => Promise<any>> = {
  markPacked: REAL_PACKING.markOrderPackedFn,
  retryReady: REAL_PACKING.retryPackedDeliveryReadyFn,
  confirmHandoff: REAL_HANDOFF.confirmHandoffFn,
};

interface Sent {
  op: Op;
  /** Exactly what the browser sent. */
  data: Json;
  /** The principal the server derived when it HANDLED the request (null: no session). */
  server: { userId: string; organizationId: string } | null;
}
const sent: Sent[] = [];
/** Per request: "ok:<result kind>" or "refused:<code>". */
const outcomes: string[] = [];
/** The next request waits before the server derives its principal. */
let holdDispatchNext = false;
const dispatchGates: (() => void)[] = [];
/** The next request commits server-side, then its response waits for release(). */
let holdResponseNext = false;
const heldResponses: (() => void)[] = [];
/** The next request commits server-side, then its response is lost. */
let loseNextResponse = false;

function refusalCode(error: unknown): string {
  const e = error as Json;
  if (typeof e?.code === "string") return e.code;
  if (e?.name === "ZodError") return "invalid_request";
  return String(e?.statusCode ?? e?.status ?? "error");
}

/** One request through the real server function, behind the gates. */
async function serve(op: Op, args: { data: Json }) {
  if (holdDispatchNext) {
    holdDispatchNext = false;
    await new Promise<void>((go) => dispatchGates.push(go));
  }
  const holdResponse = holdResponseNext;
  holdResponseNext = false;
  const lose = loseNextResponse;
  loseNextResponse = false;
  // Derived when the server HANDLES it: the real handler's resolveAuthContext
  // reads the session in the same turn.
  const index =
    sent.push({
      op,
      data: JSON.parse(JSON.stringify(args.data ?? {})),
      server: server.signedIn
        ? { userId: server.userId, organizationId: server.organizationId }
        : null,
    }) - 1;
  let outcome: { value: any } | { error: unknown };
  try {
    const value = await REAL_OP[op](args);
    outcome = { value };
    outcomes[index] = `ok:${value?.kind ?? "?"}`;
  } catch (error) {
    outcome = { error };
    outcomes[index] = `refused:${refusalCode(error)}`;
  }
  if (holdResponse) await new Promise<void>((release) => heldResponses.push(release));
  if (lose) throw new TypeError("Failed to fetch");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
mock.module("@/api/packing", () => ({
  ...REAL_PACKING,
  markOrderPackedFn: (args: { data: Json }) => serve("markPacked", args),
  retryPackedDeliveryReadyFn: (args: { data: Json }) => serve("retryReady", args),
}));
mock.module("@/api/handoff", () => ({
  ...REAL_HANDOFF,
  confirmHandoffFn: (args: { data: Json }) => serve("confirmHandoff", args),
}));

// ── Chrome outside the screens' own state ───────────────────────────────────

/** Every toast a screen raised. */
const notifications: string[] = [];
const realFeedback = await import("@/lib/feedback");
mock.module("@/lib/feedback", () => ({
  ...realFeedback,
  notifySuccess: (title: string) => notifications.push(`success:${title}`),
  notifyError: (title: string) => notifications.push(`error:${title}`),
  notifyInfo: (title: string) => notifications.push(`info:${title}`),
}));
mock.module("@/components/barcode/CameraScanSheet", () => ({ CameraScanSheet: () => null }));
const realBottomNav = await import("@/design-system/BottomNav");
mock.module("@/design-system/BottomNav", () => ({ ...realBottomNav, BottomNav: () => null }));

// ── Router hooks ─────────────────────────────────────────────────────────────

const routeParams: Json = { orderId: "", parcelCode: "" };
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
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const PackScreen = ((await import("@/routes/app.pack.$orderId")).Route as any)
  .component as () => React.ReactElement;
const HandoffScreen = ((await import("@/routes/app.handoff.$parcelCode")).Route as any)
  .component as () => React.ReactElement;
const { RetryDeliveryReadyBoundary } =
  await import("@/components/fulfillment/RetryDeliveryReadyAction");
/** Order detail's host: the boundary, fed by the /app route context (app.orders.$id.tsx). */
function RetryHost() {
  return React.createElement(RetryDeliveryReadyBoundary, {
    userId: route.userId,
    organizationId: route.organizationId,
    orderId: routeParams.orderId,
  });
}
const { createOrder, transitionLifecycleStatus } = await import("@/server/orders/service");
const ordersRepo = await import("@/server/orders/repository");
const deliveriesRepo = await import("@/server/deliveries/repository");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;
let screen: () => React.ReactElement = PackScreen;

/** The /app layout's own wrapping, fed by this tab's route context. */
function tree() {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityProvider,
      { userId: route.userId, organizationId: route.organizationId } as any,
      React.createElement(screen),
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
 * Every setQueryData a screen made (TanStack marks those writes `manual`): a
 * fetch is not a manual write, so this separates "the server answered this
 * principal's own read" from "a callback put a response here".
 */
const manualWrites: (readonly unknown[])[] = [];
async function mount(which: () => React.ReactElement) {
  screen = which;
  const own = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = own;
  own.getQueryCache().subscribe((event) => {
    if (client !== own) return; // a previous case's client, settling late
    if (event.type === "updated" && event.action.type === "success" && event.action.manual) {
      manualWrites.push(event.query.queryKey);
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
  notifications.length = 0;
  navigations.length = 0;
  audits.length = 0;
  holdDispatchNext = false;
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  holdResponseNext = false;
  for (const release of heldResponses) release();
  heldResponses.length = 0;
  loseNextResponse = false;
  resetGrants();
  route.userId = server.userId = USER_A;
  route.organizationId = server.organizationId = ORG_A;
  server.signedIn = true;
});
afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
function button(label: string) {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}
async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 500)}`);
  await act(async () => {
    (el as HTMLElement).click();
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
  throw new Error(`timed out waiting for ${label}; page: ${text().slice(0, 600)}`);
}
/** Every read the screen has started has answered, across several idle rounds. */
async function readsSettled() {
  let idle = 0;
  await waitFor(() => {
    idle = client.isFetching() === 0 ? idle + 1 : 0;
    return idle >= 4;
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

// ── Seeding (as A, in organization A) ────────────────────────────────────────

let seq = 0;
const pad = (n: number) => String(n).padStart(8, "0");
interface Seeded {
  orderId: string;
  parcelCode: string;
  deliveryId: string | null;
}
/** A confirmed order of A's, with its APSA Parcel (created at confirmation). */
async function confirmedOrder(): Promise<Seeded> {
  seq += 1;
  const ctx = contextFor(USER_A, ORG_A);
  const order = await createOrder(ctx, {
    expectedPrincipal: principalOf(ctx),
    source: "MANUAL",
    items: [{ variantId: WATER.variant, quantity: 1, productId: WATER.product }],
    customerId: null,
    locationId: null,
    sourceConversationRef: null,
    idempotencyKey: `pack-handoff-${pad(seq)}`,
  } as any);
  await transitionLifecycleStatus(ctx, order.id, "confirmed", null, principalOf(ctx));
  const parcel = (
    await f.db.query<Json>(
      "select parcel_code from parcels where order_id = $1 and status <> 'void'",
      [order.id],
    )
  ).rows[0];
  expect(parcel?.parcel_code).toBeTruthy();
  return { orderId: order.id, parcelCode: parcel!.parcel_code, deliveryId: null };
}
/** A delivery arranged by A through the delivery RPC — left pending. */
async function arrange(s: Seeded): Promise<Seeded> {
  const created = await deliveriesRepo.createDelivery(ORG_A, USER_A, {
    order_id: s.orderId,
    location_id: null,
    provider_id: null,
    provider_key: null,
    provider_name: "Courier Sokha",
    external_tracking_number: `TRK-PACK-${pad(seq)}`,
    cod_amount_minor: 9100 + seq,
  } as any);
  expect(created.status).toBe("success");
  return { ...s, deliveryId: created.delivery_id! };
}
/** Mark Packed: confirmed, parcel, not packed; with or without a pending delivery. */
async function seedPackable(withDelivery: boolean) {
  const s = await confirmedOrder();
  return withDelivery ? arrange(s) : s;
}
/** Retry delivery ready: packed by A (the marker), then a delivery arranged and left pending. */
async function seedRetryable() {
  const s = await confirmedOrder();
  expect((await ordersRepo.recordOrderPacked(ORG_A, s.orderId, USER_A)).status).toBe("success");
  return arrange(s);
}
/** Courier Handoff: packed, delivery readied by A. */
async function seedHandoffReady() {
  const s = await seedRetryable();
  const r = await deliveriesRepo.readyPackedDelivery(ORG_A, s.orderId, s.deliveryId!, USER_A);
  expect(r.status).toBe("success");
  return s;
}

// ── Persisted figures ────────────────────────────────────────────────────────

const who = (id: string | null | undefined) =>
  id === USER_A ? "A" : id === USER_B ? "B" : String(id);
/** Everything one order's packing and handoff can write, with who wrote it. */
async function persisted(orderId: string) {
  const q = async (sql: string) => (await f.db.query<Json>(sql, [orderId])).rows;
  const [order] = await q("select lifecycle_status, fulfillment_status from orders where id = $1");
  return {
    order: `${order!.lifecycle_status}/${order!.fulfillment_status}`,
    deliveries: (
      await q("select status from deliveries where order_id = $1 order by created_at")
    ).map((r) => r.status as string),
    orderHistory: (
      await q(
        `select axis, from_status, to_status, changed_by, reason from order_status_history
          where order_id = $1 order by changed_at, id`,
      )
    ).map(
      (r) => `${r.axis}:${r.from_status}->${r.to_status}:${who(r.changed_by)}:${r.reason ?? ""}`,
    ),
    deliveryHistory: (
      await q(
        `select h.from_status, h.to_status, h.changed_by, h.reason from delivery_status_history h
           join deliveries d on d.id = h.delivery_id
          where d.order_id = $1 order by h.created_at, h.id`,
      )
    ).map((r) => `${r.from_status}->${r.to_status}:${who(r.changed_by)}:${r.reason ?? ""}`),
    parcels: (await q("select status from parcels where order_id = $1")).map(
      (r) => r.status as string,
    ),
  };
}
type Persisted = Awaited<ReturnType<typeof persisted>>;
/** The history rows written since `before`. */
function addedRows(before: Persisted, after: Persisted) {
  return [
    ...after.orderHistory.slice(before.orderHistory.length),
    ...after.deliveryHistory.slice(before.deliveryHistory.length),
  ];
}
/** Every table either organization could have had written, for an exact before/after comparison. */
async function writeSurface() {
  const q = async (sql: string) => JSON.stringify((await f.db.query(sql)).rows);
  return {
    orders: await q("select id, lifecycle_status, fulfillment_status from orders order by id"),
    orderHistory: await q("select id from order_status_history order by id"),
    deliveries: await q("select id, status from deliveries order by id"),
    deliveryHistory: await q("select id from delivery_status_history order by id"),
    parcels: await q("select id, status from parcels order by id"),
    audits: audits.length,
  };
}
type Surface = Awaited<ReturnType<typeof writeSurface>>;
async function wroteSince(before: Surface): Promise<string[]> {
  const after = await writeSurface();
  return (Object.keys(before) as (keyof Surface)[]).filter((k) => before[k] !== after[k]);
}
/** The order items and quantities, exactly as the Pack screen sends them. */
async function packedLinesOf(orderId: string) {
  return (
    await f.db.query<Json>("select id, quantity from order_items where order_id = $1", [orderId])
  ).rows.map((r) => ({ orderItemId: r.id as string, quantity: Number(r.quantity) }));
}

// ── The three operations, as a member performs them ─────────────────────────

const MARK = en.packSession.markPacked.action;
const RETRY = en.order.retryDeliveryReady;
const CONFIRM = en.courierHandoff.confirm;

interface OpCase {
  name: string;
  op: Op;
  seed: () => Promise<Seeded>;
  /** Mounts the screen for the seeded order / parcel. */
  open: (s: Seeded) => Promise<void>;
  /** Brings the mounted screen to the point where the action can be tapped. */
  prepare: () => Promise<void>;
  tap: () => Promise<void>;
  /** The persisted state once the action is done. */
  done: (p: Persisted) => boolean;
  /** The request's own data, as the screen sends it (for the validator cases). */
  request: (s: Seeded) => Promise<Json>;
  /** The initiator's success, as the screen announces it. */
  successSeen: () => boolean;
  /** The initiator's failure, as the screen announces it. */
  failureSeen: () => boolean;
}
async function preparePack() {
  await waitFor(() => button(en.packSession.manual.confirm) || button(MARK), "Pack Order");
  for (let i = 0; i < 10; i++) {
    const b = button(en.packSession.manual.confirm);
    if (!b) break;
    await click(b, "manual confirm");
  }
  await waitFor(() => button(MARK) && !button(MARK)!.disabled, "Mark Packed enabled");
}
async function prepareRetry() {
  await waitFor(() => button(RETRY) && !button(RETRY)!.disabled, "Retry delivery ready");
}
async function prepareHandoff() {
  await waitFor(() => button(CONFIRM) && !button(CONFIRM)!.disabled, "Confirm Handoff");
}
const packCase = (name: string, withDelivery: boolean): OpCase => ({
  name,
  op: "markPacked",
  seed: () => seedPackable(withDelivery),
  open: async (s) => {
    routeParams.orderId = s.orderId;
    await mount(PackScreen);
  },
  prepare: preparePack,
  tap: () => click(button(MARK), MARK),
  done: (p) => (withDelivery ? p.deliveries[0] === "ready" : p.order === "confirmed/processing"),
  request: async (s) => ({ orderId: s.orderId, packedLines: await packedLinesOf(s.orderId) }),
  successSeen: () => notifications.some((n) => n.startsWith("success:")),
  failureSeen: () => notifications.some((n) => n.startsWith("error:")),
});
const OPS: OpCase[] = [
  packCase("Mark Packed (no delivery yet)", false),
  packCase("Mark Packed (delivery pending)", true),
  {
    name: "Retry delivery ready",
    op: "retryReady",
    seed: seedRetryable,
    open: async (s) => {
      routeParams.orderId = s.orderId;
      await mount(RetryHost);
    },
    prepare: prepareRetry,
    tap: () => click(button(RETRY), RETRY),
    done: (p) => p.deliveries[0] === "ready",
    request: async (s) => ({ orderId: s.orderId }),
    successSeen: () => notifications.some((n) => n.startsWith("success:")),
    failureSeen: () => text().includes(en.order.retryDeliveryReadyFailed),
  },
  {
    name: "Courier Handoff",
    op: "confirmHandoff",
    seed: seedHandoffReady,
    open: async (s) => {
      routeParams.parcelCode = s.parcelCode;
      await mount(HandoffScreen);
    },
    prepare: prepareHandoff,
    tap: () => click(button(CONFIRM), CONFIRM),
    done: (p) => p.deliveries[0] === "in_transit",
    request: async (s) => ({ parcelCode: s.parcelCode }),
    successSeen: () => text().includes(en.courierHandoff.success.title),
    failureSeen: () => text().includes(en.courierHandoff.error.body),
  },
];

function handledAs() {
  return sent.map((x) =>
    x.server ? `${who(x.server.userId)}@${x.server.organizationId === ORG_A ? "A" : "B"}` : "none",
  );
}
function evidence(label: string, extra: Json = {}) {
  console.log(
    `[evidence] ${label}: server=[${outcomes.join(",")}] handledAs=${JSON.stringify(handledAs())} ` +
      `sentPrincipal=${JSON.stringify(sent.map((x) => x.data.expectedPrincipal ?? null))} ${JSON.stringify(extra)}`,
  );
}
const A_PRINCIPAL = { userId: USER_A, organizationId: ORG_A };

/** The action is done, once, by A: every row it wrote names A. */
async function expectDoneByA(c: OpCase, s: Seeded, before: Persisted) {
  const after = await persisted(s.orderId);
  expect(c.done(after)).toBe(true);
  const rows = addedRows(before, after);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((r) => !r.includes(":A:"))).toEqual([]);
}

for (const c of OPS) {
  describe(`${c.name}: runs as the member who started it, or not at all`, () => {
    it("A alone: A's own action, sent as A and attributed to A", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      await c.tap();
      await waitFor(() => c.successSeen(), "A's success");
      evidence(`${c.name} | A alone`);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.startsWith("ok:")).toBe(true);
      expect(sent[0]!.data.expectedPrincipal).toEqual(A_PRINCIPAL);
      await expectDoneByA(c, s, before);
    });

    it("member A → B (same organization, this tab) while dispatching, both authorized: refused, nothing written; A's retry is A's", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      holdDispatchNext = true;
      await c.tap(); // left the screen as A, not yet at the server
      await switchTo({ user: USER_B });
      const surface = await writeSurface();
      await releaseDispatch(); // handled while the session is member B's
      const wrote = await wroteSince(surface);
      await readsSettled();
      evidence(`${c.name} | A→B same org`, { wrote });
      expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
      expect(sent[0]!.data.expectedPrincipal).toEqual(A_PRINCIPAL);
      expect(outcomes).toEqual(["refused:principal_changed"]);
      expect(wrote).toEqual([]);
      // B's screen says nothing of A's request.
      expect(notifications).toEqual([]);
      expect(navigations).toEqual([]);

      await switchTo({ user: USER_A });
      await c.prepare();
      await c.tap();
      await waitFor(() => outcomes.length === 2, "A's retry");
      expect(outcomes[1]!.startsWith("ok:")).toBe(true);
      await expectDoneByA(c, s, before);
    });

    it("A lacks delivery.handoff, B holds it: B's grant never performs A's request", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      grants.get(USER_A)!.delete("delivery.handoff"); // revoked after the screen loaded
      holdDispatchNext = true;
      await c.tap();
      await switchTo({ user: USER_B });
      const surface = await writeSurface();
      await releaseDispatch();
      const wrote = await wroteSince(surface);
      evidence(`${c.name} | A unauthorized / B authorized`, { wrote });
      expect(outcomes).toEqual(["refused:principal_changed"]);
      expect(wrote).toEqual([]);
    });

    it("A holds delivery.handoff, B lacks it: refused as principal_changed — never B's 403 — nothing written", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      grants.get(USER_B)!.delete("delivery.handoff");
      holdDispatchNext = true;
      await c.tap();
      await switchTo({ user: USER_B });
      const surface = await writeSurface();
      await releaseDispatch();
      const wrote = await wroteSince(surface);
      evidence(`${c.name} | A authorized / B unauthorized`, { wrote });
      expect(outcomes).toEqual(["refused:principal_changed"]);
      expect(wrote).toEqual([]);
    });

    it("another tab signs in as member B: refused; A's screen shows A's failure, never a success; A's retry once A is back is A's", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      otherTab({ user: USER_B }); // this tab still shows A
      const surface = await writeSurface();
      await c.tap();
      await waitFor(() => outcomes.length === 1, "the server's answer");
      await readsSettled();
      const wrote = await wroteSince(surface);
      evidence(`${c.name} | another tab as B`, { wrote });
      expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
      expect(outcomes).toEqual(["refused:principal_changed"]);
      expect(wrote).toEqual([]);
      expect(c.successSeen()).toBe(false);
      expect(navigations).toEqual([]);
      await waitFor(() => c.failureSeen(), "A's failure");

      otherTab({ user: USER_A });
      notifications.length = 0;
      await c.prepare();
      await c.tap();
      await waitFor(() => outcomes.length === 2, "A's retry");
      expect(outcomes[1]!.startsWith("ok:")).toBe(true);
      await expectDoneByA(c, s, before);
    });

    for (const to of [
      { label: "organization A → B (same member, this tab)", tab: "this", user: undefined },
      { label: "another tab switches organization A → B", tab: "other", user: undefined },
      { label: "member AND organization A@A → B@B (this tab)", tab: "this", user: USER_B },
    ] as const) {
      it(`${to.label} while dispatching: refused as principal_changed — not a misleading not-found — nothing written in either organization`, async () => {
        const s = await c.seed();
        await c.open(s);
        await c.prepare();
        holdDispatchNext = true;
        await c.tap();
        if (to.tab === "this")
          await switchTo({ org: ORG_B, ...(to.user ? { user: to.user } : {}) });
        else otherTab({ org: ORG_B });
        const surface = await writeSurface();
        await releaseDispatch();
        const wrote = await wroteSince(surface);
        evidence(`${c.name} | ${to.label}`, { wrote });
        expect(sent[0]!.server?.organizationId).toBe(ORG_B);
        expect(outcomes).toEqual(["refused:principal_changed"]);
        expect(wrote).toEqual([]);
      });
    }

    it("A → B → A while dispatching: lands as A — A's own action, applied once", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      holdDispatchNext = true;
      await c.tap();
      await switchTo({ user: USER_B });
      await switchTo({ user: USER_A });
      await releaseDispatch();
      await waitFor(() => outcomes.length === 1, "the server's answer");
      expect(sent[0]!.server).toEqual(A_PRINCIPAL);
      expect(outcomes[0]!.startsWith("ok:")).toBe(true);
      await expectDoneByA(c, s, before);
    });

    it("A's own grant revoked (no switch): refused by A's own permission (403), nothing written", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      grants.get(USER_A)!.delete("delivery.handoff");
      const surface = await writeSurface();
      await c.tap();
      await waitFor(() => outcomes.length === 1, "the server's answer");
      expect(outcomes).toEqual(["refused:403"]);
      expect(await wroteSince(surface)).toEqual([]);
    });

    it("the real server function refuses a request that does not say who started it — before anything runs", async () => {
      const s = await c.seed();
      const data = await c.request(s);
      const surface = await writeSurface();
      const refusals: string[] = [];
      for (const extra of [
        {},
        { expectedPrincipal: null },
        { expectedPrincipal: { userId: USER_A } },
        { expectedPrincipal: { ...A_PRINCIPAL, role: "OWNER" } },
        { expectedPrincipal: { userId: "not-a-uuid", organizationId: ORG_A } },
      ]) {
        try {
          await REAL_OP[c.op]({ data: { ...data, ...extra } });
          refusals.push("ok");
        } catch (error) {
          refusals.push(refusalCode(error));
        }
      }
      const wrote = await wroteSince(surface);
      evidence(`${c.name} | no initiating principal`, { refusals, wrote });
      expect(refusals).toEqual(Array(5).fill("invalid_request"));
      expect(wrote).toEqual([]);
    });
  });

  describe(`${c.name}: an answer stays with the member who asked`, () => {
    it("delayed success, member A → B (same organization): committed as A; B's screen is not announced to, navigated or written into", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      holdResponseNext = true;
      await c.tap();
      await waitFor(() => outcomes[0]?.startsWith("ok:"), "A's action committed");
      await switchTo({ user: USER_B });
      await readsSettled();
      const shownBefore = text();
      const writesBefore = manualWrites.length;
      await releaseResponse(); // A's answer lands while B is shown
      await readsSettled();
      evidence(`${c.name} | late success to B`);
      expect(sent[0]!.server).toEqual(A_PRINCIPAL);
      await expectDoneByA(c, s, before);
      expect(notifications).toEqual([]);
      expect(navigations).toEqual([]);
      expect(text()).toBe(shownBefore);
      expect(manualWrites.slice(writesBefore).filter((k) => k[1] === USER_B)).toEqual([]);
    });

    it("delayed failure after the server committed (response lost), member A → B: nothing of A's reaches B", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      holdResponseNext = true;
      loseNextResponse = true;
      await c.tap();
      await waitFor(() => outcomes[0]?.startsWith("ok:"), "A's action committed");
      await switchTo({ user: USER_B });
      await readsSettled();
      const shownBefore = text();
      await releaseResponse();
      await readsSettled();
      evidence(`${c.name} | late failure to B`);
      await expectDoneByA(c, s, before);
      expect(notifications).toEqual([]);
      expect(navigations).toEqual([]);
      expect(text()).toBe(shownBefore);
    });

    it("a lost response (same member): A is told it failed; A's retry is answered from the committed state and writes nothing more", async () => {
      const s = await c.seed();
      await c.open(s);
      await c.prepare();
      const before = await persisted(s.orderId);
      loseNextResponse = true;
      await c.tap();
      await waitFor(() => outcomes[0]?.startsWith("ok:"), "A's action committed");
      await waitFor(() => c.failureSeen(), "A's failure notice");
      await expectDoneByA(c, s, before);
      const committed = await persisted(s.orderId);
      const surface = await writeSurface();
      // The retry: the same action, from the same screen, as the same member.
      await c.tap();
      await waitFor(() => outcomes.length === 2, "A's retry");
      evidence(`${c.name} | lost response, retry`);
      expect(outcomes[1]!.startsWith("ok:")).toBe(true);
      expect(sent[1]!.data.expectedPrincipal).toEqual(A_PRINCIPAL);
      expect(await wroteSince(surface)).toEqual([]);
      expect(await persisted(s.orderId)).toEqual(committed);
    });
  });
}
