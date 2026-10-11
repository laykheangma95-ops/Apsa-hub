/**
 * Order lifecycle (confirm / cancel / discard) and payment recording run as
 * the principal that started them — or not at all. MOUNTED, through REAL SQL.
 *
 * Mounts the REAL screens a merchant uses for these mutations:
 *
 *   - Order detail (src/routes/app.orders.$id.tsx): Confirm, Cancel, Record
 *     payment. Not keyed by principal — it stays mounted across a switch.
 *   - the conversation route (src/routes/app.inbox.$id.tsx → PrepareOrderSheet):
 *     Confirm / Discard a draft. Keyed by member + organization.
 *   - POS (src/routes/app.pos.tsx → PosCheckoutSheet): the confirm step of
 *     Confirm sale, and Record payment. The till is keyed by principal.
 *
 * Each sits under the real CapabilityProvider (the /app layout's), and reaches
 * the database through the real client adapters (confirmRealOrder,
 * cancelRealOrder, recordRealPayment) → the same service calls the
 * server-function handlers make → PGlite with EVERY migration. Only the
 * transport (server-fn boundary, Supabase admin client), the Inbox's
 * conversation reads, the delivery list and the router hooks are replaced.
 *
 * Two principals are modelled, because they can disagree:
 *
 *   route   what THIS tab's /app route context says is signed in;
 *   server  what the server derives when it HANDLES a request (the session
 *           cookie's member and that member's active organization at that
 *           moment) — shared by every tab, so another tab moves it alone.
 *
 * A dispatch gate holds a request after it left the screen but before the
 * server derives its principal (the lazily imported server-function module,
 * then the trip). Every case asserts what was written — order status, status
 * history, stock movements, parcels, payments, payment events, rate-limit
 * buckets and audit rows — and by whom.
 *
 * Run through src/tests/order-mutation-principal-mounted.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";
import { principalOf } from "./helpers/refuse-only-principal";

type Json = Record<string, any>;

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();
/** Organization A sells in riel. */
const ORG_A = "cccccccc-0000-4000-8000-0000000000a2";
await f.db.query(
  `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
   values($1,'Riel shop','Riel shop','mutation-riel-shop',$2,'KHR')`,
  [ORG_A, f.actor],
);
/** Organization B — the fixture's own. */
const ORG_B = f.org;
const USER_A = f.actor;
/** A second member of the same organizations. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000c9";
await f.db.query("insert into auth.users(id,email) values($1,'member-b@test.invalid')", [USER_B]);

async function seedProduct(org: string, nameEn: string, price: number, currency: "USD" | "KHR") {
  const product = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    `${nameEn}-km`,
    nameEn,
  ]);
  const variant = crypto.randomUUID();
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
     values($1,$2,$3,$4,'',$5,$6)`,
    [variant, org, product, `${nameEn}-sku`, price, currency],
  );
  return { product, variant };
}
const WATER = await seedProduct(ORG_A, "Water", 5000, "KHR"); // ៛5,000

const CUST_A = crypto.randomUUID();
await f.db.query(
  `insert into customers(id,organization_id,display_name,primary_phone) values($1,$2,'Sokha',null)`,
  [CUST_A, ORG_A],
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
  "orders.cancel",
  "orders.update",
  "orders.apply_discount",
  "customers.read",
  "payments.read",
  "payments.record",
  "payments.mark_cod",
  "messages.reply",
];
/** Server-side grants per member: the ONLY authority a request is checked against. */
const grants = new Map<string, Set<string>>();
function resetGrants() {
  grants.set(USER_A, new Set(ALL_GRANTS));
  grants.set(USER_B, new Set(ALL_GRANTS));
}
resetGrants();

function contextFor(userId: string, organizationId: string): AuthorizationContext {
  const granted = (key: string) => grants.get(userId)?.has(key) === true;
  return {
    organizationId,
    userId,
    can: granted,
    require: (key: string) => {
      if (!granted(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 });
      }
    },
  } as unknown as AuthorizationContext;
}
/** resolveAuthContext(): the session's member, its active organization — or 401. */
function serverContext(): AuthorizationContext {
  if (!server.signedIn) {
    throw Object.assign(new Error("Not authenticated"), { statusCode: 401 });
  }
  return contextFor(server.userId, server.organizationId);
}

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

// ── The server-function boundary: gates, outcomes, the derived principal ─────

type Gated = "lifecycle" | "payment";
interface SentMutation {
  fn: Gated;
  /** Exactly what the browser sent. */
  data: Json;
  /** The principal the server derived when it HANDLED the request (null: no session). */
  server: { userId: string; organizationId: string } | null;
}
const sent: SentMutation[] = [];
/** The server's answer to each gated request, in order: "ok" or "refused:<code>". */
const outcomes: string[] = [];
/** The server's answers to one kind of gated request only, in order. */
const outcomesOf = (fn: Gated) => outcomes.filter((_, i) => sent[i]?.fn === fn);
/** The next request of this kind waits before the server derives its principal. */
const holdDispatchNext = new Set<Gated>();
const dispatchGates: (() => void)[] = [];
/** The next request of this kind commits server-side, then its response is lost. */
const loseNextResponse = new Set<Gated>();
/** The next request of this kind commits server-side, then its response waits for release(). */
const holdResponseNext = new Set<Gated>();
const heldResponses: (() => void)[] = [];

async function serve<T>(fn: Gated, data: Json, run: (ctx: AuthorizationContext) => Promise<T>) {
  if (holdDispatchNext.has(fn)) {
    holdDispatchNext.delete(fn);
    await new Promise<void>((go) => dispatchGates.push(go));
  }
  const lose = loseNextResponse.delete(fn);
  const holdResponse = holdResponseNext.delete(fn);
  let outcome: { value: T } | { error: unknown };
  let index: number;
  try {
    const ctx = serverContext(); // derived when the server HANDLES it
    index =
      sent.push({
        fn,
        data: JSON.parse(JSON.stringify(data)),
        server: { userId: ctx.userId, organizationId: ctx.organizationId },
      }) - 1;
    try {
      outcome = { value: await run(ctx) };
      outcomes[index] = "ok";
    } catch (error) {
      outcome = { error };
      outcomes[index] = `refused:${(error as Json).code ?? (error as Json).statusCode ?? "error"}`;
    }
  } catch (error) {
    index = sent.push({ fn, data: JSON.parse(JSON.stringify(data)), server: null }) - 1;
    outcome = { error };
    outcomes[index] = `refused:${(error as Json).statusCode ?? "error"}`;
  }
  if (holdResponse) await new Promise<void>((release) => heldResponses.push(release));
  if (lose) throw new TypeError("Failed to fetch");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    const { createOrder } = await import("@/server/orders/service");
    return createOrder(serverContext(), {
      source: data.source,
      items: data.items.map((l: Json) => ({
        variantId: l.variantId,
        quantity: l.quantity,
        productId: l.productId,
      })),
      customerId: data.customerId ?? null,
      locationId: data.locationId ?? null,
      discountMinor: data.discountMinor,
      sourceConversationRef: data.sourceConversationRef ?? null,
      deliveryMinor: data.deliveryMinor,
      idempotencyKey: data.idempotencyKey,
      ...(data.shipping ? { shipping: data.shipping } : {}),
      expectedPrincipal: data.expectedPrincipal,
    });
  },
  // src/api/orders.ts transitionOrderLifecycleFn's handler, field for field.
  transitionOrderLifecycleFn: async ({ data }: { data: Json }) =>
    serve("lifecycle", data, async (ctx) => {
      const { transitionLifecycleStatus } = await import("@/server/orders/service");
      return (transitionLifecycleStatus as any)(
        ctx,
        data.orderId,
        data.to,
        data.reason ?? null,
        data.expectedPrincipal,
      );
    }),
  getOrderByIdFn: async ({ data }: { data: Json }) => {
    const { getOrderById } = await import("@/server/orders/service");
    return (getOrderById as any)(serverContext(), data.orderId);
  },
}));
mock.module("@/api/payments", () => ({
  // src/api/payments.ts recordPaymentFn's handler, field for field.
  recordPaymentFn: async ({ data }: { data: Json }) =>
    serve("payment", data, async (ctx) => {
      const { recordPayment } = await import("@/server/payments/service");
      return recordPayment(ctx, {
        orderId: data.orderId,
        method: data.method,
        amountMinor: data.amountMinor,
        reference: data.reference ?? null,
        idempotencyKey: data.idempotencyKey ?? null,
        note: data.note ?? null,
        expectedPrincipal: data.expectedPrincipal,
      } as any);
    }),
  listPaymentsFn: async ({ data }: { data?: Json } = {}) => {
    const { listPayments } = await import("@/server/payments/service");
    return (listPayments as any)(serverContext(), data ?? {});
  },
  getOrderSettlementFn: async ({ data }: { data: Json }) => {
    const { getOrderSettlement } = await import("@/server/payments/reconciliation");
    return getOrderSettlement(serverContext(), data.orderId);
  },
}));
mock.module("@/api/packing", () => ({
  getOrderPackStateFn: async ({ data }: { data: Json }) => {
    const { getOrderPackState } = await import("@/server/packing/service");
    return getOrderPackState(serverContext(), data.orderId);
  },
}));
mock.module("@/api/deliveries", () => ({ listDeliveriesFn: async () => [] }));
mock.module("@/api/products", () => ({
  listProductsFn: async ({ data }: { data?: Json } = {}) => {
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(serverContext(), { status: data?.status } as any);
  },
  lookupByBarcodeFn: async () => null,
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
    const ctx = serverContext();
    return {
      status: "active",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      role: "STAFF",
      permissions: [...(grants.get(ctx.userId) ?? [])],
    };
  },
}));

// ── Inbox reads: answered as the server would, for ITS principal ─────────────

const conversations = new Map<string, { org: string; customerId: string }>();
const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getConversation: async (cid: string) => {
    const c = conversations.get(cid);
    if (!c || c.org !== server.organizationId) {
      throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
    }
    return {
      id: cid,
      customerId: c.customerId,
      customerName: "Sokha",
      channel: "facebook",
      status: "needs_reply",
      messages: [],
      nextBeforeId: null,
      readThroughMessageId: null,
    };
  },
  getCustomer: async (customerId: string) => ({
    id: customerId,
    nameKm: "Sokha",
    nameEn: "Sokha",
    phone: null,
    identities: [],
    tags: [],
    orderCount: 0,
    lifetimeSpend: { amount: 0, currency: "USD" },
    companion: "minto",
  }),
  getRecentProducts: async () => [],
  markRealConversationRead: async () => {},
  getOlderConversationMessages: async () => ({ messages: [], nextBeforeId: null }),
  getMostRecentRealOrderForCustomer: async () => null,
}));

// ── Router hooks ─────────────────────────────────────────────────────────────

const routeParams = { id: "" };
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
  useNavigate: () => () => {},
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
const OrderDetailScreen = ((await import("@/routes/app.orders.$id")).Route as any)
  .component as () => React.ReactElement;
const ConversationScreen = ((await import("@/routes/app.inbox.$id")).Route as any)
  .component as () => React.ReactElement;
const PosScreen = ((await import("@/routes/app.pos")).Route as any)
  .component as () => React.ReactElement;
const { createOrder, transitionLifecycleStatus } = await import("@/server/orders/service");

type Screen = "order" | "inbox" | "pos";
let screen: Screen = "order";
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

/** The /app layout's own wrapping, fed by this tab's route context. */
function tree() {
  const component =
    screen === "order" ? OrderDetailScreen : screen === "inbox" ? ConversationScreen : PosScreen;
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityProvider,
      { userId: route.userId, organizationId: route.organizationId } as any,
      React.createElement(component),
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
 * Every setQueryData the screens made (TanStack marks those writes `manual`):
 * the key written and the order lifecycle it carried. A fetch is not a manual
 * write, so this separates "the server answered this principal's own read"
 * from "a callback put a response here".
 */
const manualWrites: { key: readonly unknown[]; lifecycle: string | null }[] = [];
async function mount(which: Screen) {
  screen = which;
  const own = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client = own;
  own.getQueryCache().subscribe((event) => {
    if (client !== own) return; // a previous case's client, settling late
    if (event.type === "updated" && event.action.type === "success" && event.action.manual) {
      manualWrites.push({
        key: event.query.queryKey,
        lifecycle: (event.action.data as any)?.order?.lifecycleStatus ?? null,
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
  audits.length = 0;
  holdDispatchNext.clear();
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  loseNextResponse.clear();
  holdResponseNext.clear();
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
function buttonContaining(fragment: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(fragment)) as
    HTMLButtonElement | undefined;
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
async function waitFor(check: () => unknown, label: string) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${label}; page: ${text().slice(0, 500)}`);
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

// ── Seeding: a draft (or confirmed) order, created by A in organization A ────

let orderSeq = 0;
/** Water × 2 (៛10,000), a draft created by member A — as the New Order sheet makes it. */
async function seedDraft(): Promise<string> {
  orderSeq += 1;
  const detail = await createOrder(contextFor(USER_A, ORG_A), {
    expectedPrincipal: principalOf(contextFor(USER_A, ORG_A)),
    source: "MANUAL",
    items: [{ variantId: WATER.variant, quantity: 2, productId: WATER.product }],
    customerId: null,
    locationId: null,
    sourceConversationRef: null,
    idempotencyKey: `fixture-mutation-${String(orderSeq).padStart(8, "0")}`,
  } as any);
  audits.length = 0; // the seed's own audit row is setup, not under test
  return detail.id;
}
/** The same order, confirmed by member A — ready to take a payment. */
async function seedConfirmed(): Promise<string> {
  const orderId = await seedDraft();
  await transitionLifecycleStatus(
    contextFor(USER_A, ORG_A),
    orderId,
    "confirmed",
    null,
    principalOf(contextFor(USER_A, ORG_A)),
  );
  audits.length = 0;
  return orderId;
}

// Order detail.

async function openOrderDetail(orderId: string) {
  routeParams.id = orderId;
  await mount("order");
  await waitFor(() => text().includes("Water"), "the order detail");
}
const confirmOrderButton = () => button(en.order.confirmOrder) ?? button(en.order.confirming);
async function tapConfirmOrder() {
  await waitFor(() => confirmOrderButton() && !confirmOrderButton()!.disabled, "Confirm order");
  await click(confirmOrderButton(), "Confirm order");
}
async function tapCancelOrder() {
  await waitFor(() => button(en.order.cancel), "Cancel order");
  await click(button(en.order.cancel), "Cancel order");
  await click(button(en.order.cancelSheet.submit, dialog()!), "Cancel order (sheet)");
}
async function tapRecordPayment(amount: string) {
  await waitFor(() => button(en.order.recordPayment), "Record payment");
  await click(button(en.order.recordPayment), "Record payment");
  await typeInto(document.querySelector("#order-payment-amount"), amount);
  await click(button(en.order.recordPaymentSheet.submit, dialog()!), "Record payment (sheet)");
}

// ── Persisted figures ────────────────────────────────────────────────────────

/** Everything one order's mutations can write, with who wrote it. */
async function orderState(orderId: string) {
  const q = async (sql: string) => (await f.db.query<Json>(sql, [orderId])).rows;
  const [order] = await q(
    "select lifecycle_status, payment_status, organization_id from orders where id = $1",
  );
  return {
    lifecycle: order!.lifecycle_status as string,
    paymentStatus: order!.payment_status as string,
    organization: order!.organization_id as string,
    history: await q(
      `select axis, from_status, to_status, changed_by from order_status_history
        where order_id = $1 order by changed_at`,
    ),
    movements: await q(
      `select m.created_by, m.quantity_delta, m.movement_type, m.organization_id
         from inventory_movements m
         join order_items oi on m.reference_type = 'order_item' and oi.id = m.reference_id
        where oi.order_id = $1`,
    ),
    parcels: await q("select created_by, organization_id from parcels where order_id = $1"),
    payments: await q(
      `select recorded_by, status, verification_state, amount_minor, currency, idempotency_key
         from payments where order_id = $1 order by created_at`,
    ),
    paymentEvents: await q(
      `select e.event_type, e.actor_user_id from payment_events e
         join payments p on p.id = e.payment_id where p.order_id = $1`,
    ),
  };
}
/** Every table these mutations can write, for an exact before/after comparison. */
async function writeSurface() {
  const q = async (sql: string) => JSON.stringify((await f.db.query(sql)).rows);
  return {
    orders: await q("select id, lifecycle_status, payment_status from orders order by id"),
    history: await q("select id from order_status_history order by id"),
    movements: await q("select id from inventory_movements order by id"),
    parcels: await q("select id from parcels order by id"),
    payments: await q("select id from payments order by id"),
    paymentEvents: await q("select id from payment_events order by id"),
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
/** Who each written row is attributed to, newest attempt's rows included. */
function attribution(s: Awaited<ReturnType<typeof orderState>>) {
  return {
    history: s.history.filter((h) => h.axis === "lifecycle").map((h) => who(h.changed_by)),
    movements: s.movements.map((m) => who(m.created_by)),
    parcels: s.parcels.map((p) => who(p.created_by)),
    payments: s.payments.map((p) => who(p.recorded_by)),
    paymentEvents: s.paymentEvents.map((e) => who(e.actor_user_id)),
    audits: audits.map((a) => `${a.action}:${who(a.actor_user_id)}`),
  };
}
function evidence(label: string, s: Awaited<ReturnType<typeof orderState>>, wrote?: string[]) {
  const a = attribution(s);
  console.log(
    `[evidence] ${label}: server=[${outcomes.join(",")}] lifecycle=${s.lifecycle} ` +
      `payment=${s.paymentStatus} history=[${a.history}] movements=[${a.movements}] ` +
      `parcels=[${a.parcels}] payments=[${a.payments}] paymentEvents=[${a.paymentEvents}] ` +
      `audits=[${a.audits}]` +
      (wrote ? ` refusalWrote=[${wrote.join(",")}]` : ""),
  );
}

/** A confirmation by `user`: the order, its stock and its parcel all name them. */
function expectConfirmedBy(s: Awaited<ReturnType<typeof orderState>>, user: string) {
  expect(s.lifecycle).toBe("confirmed");
  const confirms = s.history.filter((h) => h.axis === "lifecycle" && h.to_status === "confirmed");
  expect(confirms.map((h) => h.changed_by)).toEqual([user]);
  // Stock left once — one sale movement of −2 for the one line, by the confirmer.
  expect(s.movements).toEqual([
    { created_by: user, quantity_delta: -2, movement_type: "sale", organization_id: ORG_A },
  ]);
  expect(s.parcels).toEqual([{ created_by: user, organization_id: ORG_A }]);
  expect(s.payments).toHaveLength(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 — Order lifecycle: Order detail Confirm / Cancel
// ═══════════════════════════════════════════════════════════════════════════

describe("Order detail: a lifecycle change runs as the member who asked for it", () => {
  it("A. member A → B during Confirm: never confirmed as B; A's confirm is A's (history, stock, parcel, audit)", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder(); // left the screen as A, not yet at the server
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch(); // handled while the session is member B's
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: confirm, member A→B while dispatching", during, wrote);

    await switchTo({ user: USER_A });
    await tapConfirmOrder();
    const after = await orderState(orderId);
    evidence("order detail: confirm, A's retry", after);

    expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]); // no status, history, movement, parcel or audit row
    expect(during.lifecycle).toBe("draft");
    expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });

    expect(outcomes[1]).toBe("ok");
    expectConfirmedBy(after, USER_A);
    expect(audits.map((a) => [a.action, a.actor_user_id])).toEqual([["orders.update", USER_A]]);
  });

  it("B. member A → B during Cancel: never cancelled as B; A's cancel is A's", async () => {
    const orderId = await seedConfirmed(); // stock committed by A
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapCancelOrder();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: cancel, member A→B while dispatching", during, wrote);

    await switchTo({ user: USER_A });
    await tapCancelOrder();
    const after = await orderState(orderId);
    evidence("order detail: cancel, A's retry", after);

    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("confirmed");
    expect(outcomes[1]).toBe("ok");
    expect(after.lifecycle).toBe("cancelled");
    // Cancelling moves the lifecycle AND the fulfillment axis — both rows are A's.
    const cancels = after.history.filter((h) => h.to_status === "cancelled");
    expect(cancels.map((h) => [h.axis, h.changed_by])).toEqual([
      ["lifecycle", USER_A],
      ["fulfillment", USER_A],
    ]);
    // The committed stock came back once, attributed to the member who cancelled.
    const returns = after.movements.filter((m) => m.quantity_delta > 0);
    expect(returns.map((m) => [m.created_by, m.quantity_delta])).toEqual([[USER_A, 2]]);
    expect(audits.map((a) => [a.action, a.actor_user_id])).toEqual([["orders.cancel", USER_A]]);
  });

  it("E. organization A → B during Confirm: refused as principal_changed, nothing written in either organization", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder();
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    evidence("order detail: confirm, org A→B", await orderState(orderId), wrote);
    expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_B });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
  });

  it("G. another tab signs in as member B: Confirm is refused, never shown as confirmed; A's retry once A is back is A's", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    otherTab({ user: USER_B }); // this tab still shows A
    const before = await writeSurface();
    await tapConfirmOrder();
    const wrote = wroteSince(before, await writeSurface());
    const shownConfirmed = text().includes(en.order.confirmedNotice);
    evidence("order detail: confirm, other tab signed in as B", await orderState(orderId), wrote);

    otherTab({ user: USER_A });
    await tapConfirmOrder();
    const after = await orderState(orderId);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(shownConfirmed).toBe(false);
    expect(outcomes[1]).toBe("ok");
    expectConfirmedBy(after, USER_A);
  });

  it("F/I. rapid A → B → A while dispatching: lands as A — A's own confirm, applied once", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseDispatch(); // late, but A's own principal handles it
    const after = await orderState(orderId);
    evidence("order detail: rapid A→B→A", after);
    expect(sent[0]!.server!.userId).toBe(USER_A);
    expect(outcomes).toEqual(["ok"]);
    expectConfirmedBy(after, USER_A);
  });

  it("J. a lost response to A's confirm: the order is A's confirmed order, once — a retry adds nothing", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    loseNextResponse.add("lifecycle");
    await tapConfirmOrder(); // committed as A, response lost; the screen re-reads
    const after = await orderState(orderId);
    evidence("order detail: lost confirm", after);
    expect(outcomes).toEqual(["ok"]);
    expectConfirmedBy(after, USER_A);
  });

  it("L. B lacks orders.confirm: A's switched request is refused as principal_changed — never as B's own 403", async () => {
    const orderId = await seedDraft();
    grants.get(USER_B)!.delete("orders.confirm");
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(await writeSurface()).toEqual(before);
  });

  it("M. A lost orders.confirm (stale screen) while B holds it: a switch never lets B's grant confirm A's request; A is refused by A's own permission", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId); // A's snapshot still offers Confirm
    grants.get(USER_A)!.delete("orders.confirm"); // revoked server-side since
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: A unauthorized, B authorized", during, wrote);

    await switchTo({ user: USER_A });
    await tapConfirmOrder(); // A's own request: A's own (missing) grant decides
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("draft");
    expect(outcomes[1]).toBe("refused:403");
    expect((await orderState(orderId)).lifecycle).toBe("draft");
  });

  it("N1. the session expires while Confirm is dispatching: refused (401) with zero writes", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder();
    server.signedIn = false;
    const before = await writeSurface();
    await releaseDispatch();
    expect(outcomes[0]).toBe("refused:401");
    expect(await writeSurface()).toEqual(before);
  });

  it("N2. A's own grant is revoked (same principal): refused by A's permission (403) with zero writes", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId); // the screen still offers Confirm
    grants.get(USER_A)!.delete("orders.confirm");
    const before = await writeSurface();
    await tapConfirmOrder();
    expect(outcomes[0]).toBe("refused:403");
    expect(await writeSurface()).toEqual(before);
    expect((await orderState(orderId)).lifecycle).toBe("draft");
  });

  it("O. concurrent: this tab's held Confirm (A) and the other tab's own Cancel (B): only B's own cancel applies", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapConfirmOrder(); // this tab, as A
    otherTab({ user: USER_B });
    // The other tab, signed in as B, cancels the draft — its own legitimate request.
    await transitionLifecycleStatus(
      contextFor(USER_B, ORG_A),
      orderId,
      "cancelled",
      null,
      principalOf(contextFor(USER_B, ORG_A)),
    );
    await releaseDispatch(); // A's confirm arrives while the session is B's
    const after = await orderState(orderId);
    evidence("order detail: concurrent confirm (A) and cancel (B)", after);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(after.lifecycle).toBe("cancelled");
    expect(
      after.history.filter((h) => h.axis === "lifecycle").map((h) => who(h.changed_by)),
    ).toEqual(["B"]);
    expect(after.movements).toEqual([]);
    expect(after.parcels).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #2 — Payment recording: Order detail Record payment
// ═══════════════════════════════════════════════════════════════════════════

describe("Order detail: a payment is recorded by the member who recorded it", () => {
  it("D. member A → B during Record payment: never recorded by B — no payment, event, token or audit; A's retry on the same key is A's one pending payment", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    holdDispatchNext.add("payment");
    await tapRecordPayment("10000"); // ៛10,000 cash, left as A
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: payment, member A→B while dispatching", during, wrote);

    await switchTo({ user: USER_A });
    // The switch retired A's draft (the sheet is bound to its principal), but
    // not A's unresolved key: A reopens the sheet, types the amount again, and
    // the retry carries the key the first attempt was sent with.
    const sheetAfterSwitchBack = Boolean(dialog());
    await tapRecordPayment("10000");
    await settle(10);
    const after = await orderState(orderId);
    evidence("order detail: payment, A's retry", after);

    expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(sheetAfterSwitchBack).toBe(false);
    expect(sent.at(-1)!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(wrote).toEqual([]); // no payment, payment event, rate-limit token or audit row
    expect(during.payments).toEqual([]);
    expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });

    expect(outcomes.at(-1)).toBe("ok");
    expect(after.payments).toEqual([
      {
        recorded_by: USER_A,
        status: "pending",
        verification_state: "unverified",
        amount_minor: 10000,
        currency: "KHR",
        idempotency_key: sent.at(-1)!.data.idempotencyKey,
      },
    ]);
    expect(after.paymentEvents.map((e) => [e.event_type, e.actor_user_id])).toEqual([
      ["created", USER_A],
    ]);
    expect(
      audits.filter((a) => a.action === "payments.record").map((a) => a.actor_user_id),
    ).toEqual([USER_A]);
    // A claim is not a settlement: still unpaid until someone verifies it.
    expect(after.paymentStatus).not.toBe("paid");
  });

  it("E. organization A → B during Record payment: refused, and no rate-limit token is spent in B", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    holdDispatchNext.add("payment");
    await tapRecordPayment("10000");
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    evidence("order detail: payment, org A→B", await orderState(orderId), wrote);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
  });

  it("K. B never consumes A's key: A's identical-key retries never replay a payment B recorded — one payment, recorded by A, replayed not duplicated", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    otherTab({ user: USER_B });
    loseNextResponse.add("payment");
    await tapRecordPayment("10000"); // 0: handled under B; its response is lost
    const stage0 = await orderState(orderId);
    evidence("order detail: payment key, handled under B (response lost)", stage0);
    otherTab({ user: USER_A });
    loseNextResponse.add("payment");
    await click(button(en.order.recordPaymentSheet.submit, dialog()!), "retry 1"); // 1: as A, lost
    await settle(10);
    await click(button(en.order.recordPaymentSheet.submit, dialog()!), "retry 2"); // 2: as A
    await settle(10);
    const after = await orderState(orderId);
    evidence("order detail: payment key, A's identical-key retries", after);
    expect(outcomes).toEqual(["refused:principal_changed", "ok", "ok"]);
    expect(new Set(sent.map((s) => s.data.idempotencyKey)).size).toBe(1);
    expect(after.payments.map((p) => [p.recorded_by, p.amount_minor])).toEqual([[USER_A, 10000]]);
    expect(after.paymentEvents.map((e) => e.event_type)).toEqual(["created"]);
  });

  it("L. A may record, B may not: the switched request is principal_changed with zero writes — not B's 403 after B's token", async () => {
    const orderId = await seedConfirmed();
    grants.get(USER_B)!.delete("payments.record");
    await openOrderDetail(orderId);
    holdDispatchNext.add("payment");
    await tapRecordPayment("10000");
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(await writeSurface()).toEqual(before);
  });

  it("M. A may NOT record (stale screen), B may: B's grant never records A's payment; A's own retry is A's 403", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    grants.get(USER_A)!.delete("payments.record");
    holdDispatchNext.add("payment");
    await tapRecordPayment("10000");
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: payment, A unauthorized, B authorized", during, wrote);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.payments).toEqual([]);
  });

  it("I. a late response after A → B → A: A's payment, recorded once, by A", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    holdResponseNext.add("payment");
    await tapRecordPayment("10000"); // committed as A, response held
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseResponse();
    const after = await orderState(orderId);
    expect(outcomes).toEqual(["ok"]);
    expect(after.payments.map((p) => p.recorded_by)).toEqual([USER_A]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — a LATE lifecycle response: committed as A, answered after the switch
// ═══════════════════════════════════════════════════════════════════════════
//
// The server commits A's confirm / cancel as A, and its response is held
// before it reaches the browser. The screen — still mounted — switches to
// another principal; then the response arrives. It belongs to A's attempt
// only: never written into another principal's cache partition, never
// rendered to them, never announced to them, and never laid over a newer
// attempt.

const { ordersKeys } = await import("@/lib/orders-query");

/** Every cached entry in one principal's partitions (orders, payments, packing, inventory). */
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
/** The keys in that partition whose stored DATA holds this order. */
const holdingOrder = (user: string, org: string, orderId: string) =>
  partitionOf(user, org)
    .filter((e) => e.data?.includes(orderId))
    .map((e) => e.key);
const writesInto = (user: string, org: string) =>
  manualWrites
    .filter((w) => w.key[1] === user && w.key[2] === org)
    .map((w) => `${JSON.stringify(w.key)}=${w.lifecycle}`);
const detailKeyOf = (user: string, org: string, orderId: string) =>
  ordersKeys.detail(user, org, orderId);
/** The screen's notices (role=status) — not its other copy, which may name a status too. */
const notices = () =>
  [...document.querySelectorAll("[role=status]")].map((el) => el.textContent ?? "").join(" | ");
const cachedLifecycle = (user: string, org: string, orderId: string) =>
  (client.getQueryData(detailKeyOf(user, org, orderId)) as any)?.order?.lifecycleStatus ?? null;
async function committedAsA() {
  await waitFor(() => outcomes[0] === "ok", "A's request committed server-side");
}
/** The screen is unmounted, then mounted again for `next` — the SAME query client. */
async function remountAs(next: { user?: string; org?: string }) {
  await act(async () => root!.unmount());
  if (next.user) route.userId = server.userId = next.user;
  if (next.org) route.organizationId = server.organizationId = next.org;
  root = createRoot(container!);
  await rerender();
}
function lateEvidence(label: string, orderId: string, other: { user: string; org: string }) {
  console.log(
    `[evidence] ${label}: server=[${outcomes.join(",")}] ` +
      `A.detail=${cachedLifecycle(USER_A, ORG_A, orderId)} ` +
      `A.writes=[${writesInto(USER_A, ORG_A).join(" ")}] ` +
      `other.writes=[${writesInto(other.user, other.org).join(" ")}] ` +
      `other.holdsOrder=[${holdingOrder(other.user, other.org, orderId).join(" ")}] ` +
      `shows=${JSON.stringify(text().slice(0, 140))}`,
  );
}

interface LifecycleAction {
  name: "Confirm" | "Cancel";
  seed: () => Promise<string>;
  tap: () => Promise<void>;
  from: string;
  to: string;
  notice: string;
  expectDoneByA: (s: Awaited<ReturnType<typeof orderState>>) => void;
}
const LIFECYCLE_ACTIONS: LifecycleAction[] = [
  {
    name: "Confirm",
    seed: seedDraft,
    tap: tapConfirmOrder,
    from: "draft",
    to: "confirmed",
    notice: en.order.confirmedNotice,
    expectDoneByA: (s) => expectConfirmedBy(s, USER_A),
  },
  {
    name: "Cancel",
    seed: seedConfirmed,
    tap: tapCancelOrder,
    from: "confirmed",
    to: "cancelled",
    notice: en.order.cancelledNotice,
    expectDoneByA: (s) => {
      expect(s.lifecycle).toBe("cancelled");
      const cancels = s.history.filter((h) => h.to_status === "cancelled");
      expect(cancels.map((h) => [h.axis, h.changed_by])).toEqual([
        ["lifecycle", USER_A],
        ["fulfillment", USER_A],
      ]);
    },
  },
];

describe("Order detail: a late confirm / cancel response stays with the principal that started it", () => {
  for (const action of LIFECYCLE_ACTIONS) {
    const switches = [
      { label: "organization A → B, B lacks orders.read", user: USER_B, org: ORG_B, read: false },
      {
        label: "member A → B in the same organization, B lacks orders.read",
        user: USER_B,
        org: ORG_A,
        read: false,
      },
      {
        label:
          "member A → B in the same organization, B reads orders but holds no lifecycle or payment grant",
        user: USER_B,
        org: ORG_A,
        read: true,
      },
    ];
    for (const to of switches) {
      it(`${action.name}, ${to.label}: committed as A, never written, rendered or announced to B`, async () => {
        const orderId = await action.seed();
        await openOrderDetail(orderId);
        holdResponseNext.add("lifecycle");
        await action.tap();
        await committedAsA();
        const bGrants = grants.get(USER_B)!;
        for (const key of [
          "orders.confirm",
          "orders.cancel",
          "payments.read",
          "payments.record",
          "payments.mark_cod",
        ]) {
          bGrants.delete(key);
        }
        if (!to.read) bGrants.delete("orders.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedLifecycle(to.user, to.org, orderId) === action.to,
            "B's own read",
          );
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse(); // A's response lands while B is shown
        lateEvidence(`late ${action.name}, ${to.label}`, orderId, to);

        // The server's act is A's, and only A's.
        expect(outcomes).toEqual(["ok"]);
        expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_A });
        action.expectDoneByA(await orderState(orderId));

        // B's cache: no write from A's callback; every entry exactly as it was.
        expect(writesInto(to.user, to.org)).toEqual([]);
        expect(partitionOf(to.user, to.org)).toEqual(bBefore);
        if (!to.read) {
          expect(client.getQueryData(detailKeyOf(to.user, to.org, orderId))).toBeUndefined();
          expect(holdingOrder(to.user, to.org, orderId)).toEqual([]);
          expect(text()).not.toContain("Water");
        }
        // B's screen: unchanged by A's completion — no A order, no notice, no sheet.
        expect(text()).toBe(shownBefore);
        expect(notices()).not.toContain(action.notice);
        expect(dialog()).toBeNull();

        // A's partition: A's response is not cached after A switched away;
        // A's entry is only marked stale, for a re-read under A's own authority.
        expect(writesInto(USER_A, ORG_A)).toEqual([]);
        expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe(action.from);
        expect(client.getQueryState(detailKeyOf(USER_A, ORG_A, orderId))?.isInvalidated).toBe(true);

        // A comes back: the committed result, read from the server as A.
        await switchTo({ user: USER_A, org: ORG_A });
        await waitFor(() => cachedLifecycle(USER_A, ORG_A, orderId) === action.to, "A's re-read");
        expect(writesInto(USER_A, ORG_A)).toEqual([]);
        expect(writesInto(to.user, to.org)).toEqual([]);
      });
    }

    it(`${action.name}, A → B → A, then the late response: A sees its own committed order, B's partition untouched`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_B)!.delete("orders.read");
      await switchTo({ user: USER_B, org: ORG_B });
      await switchTo({ user: USER_A, org: ORG_A });
      await releaseResponse();
      await waitFor(
        () => cachedLifecycle(USER_A, ORG_A, orderId) === action.to,
        "A's committed order",
      );
      lateEvidence(`late ${action.name}, A→B→A`, orderId, { user: USER_B, org: ORG_B });
      action.expectDoneByA(await orderState(orderId));
      expect(writesInto(USER_B, ORG_B)).toEqual([]);
      expect(holdingOrder(USER_B, ORG_B, orderId)).toEqual([]);
      expect(text()).toContain("Water");
    });

    for (const to of [
      { label: "organization A → B, B lacks orders.read", user: USER_B, org: ORG_B, read: false },
      {
        label: "member A → B in the same organization, B reads orders",
        user: USER_B,
        org: ORG_A,
        read: true,
      },
    ])
      it(`${action.name}, failure after the server committed, ${to.label}: nothing reaches B; A's recovery re-reads A's order`, async () => {
        const orderId = await action.seed();
        await openOrderDetail(orderId);
        holdResponseNext.add("lifecycle");
        loseNextResponse.add("lifecycle"); // committed, then the response fails
        await action.tap();
        await committedAsA();
        for (const key of [
          "orders.confirm",
          "orders.cancel",
          "payments.read",
          "payments.record",
          "payments.mark_cod",
        ]) {
          grants.get(USER_B)!.delete(key);
        }
        if (!to.read) grants.get(USER_B)!.delete("orders.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedLifecycle(to.user, to.org, orderId) === action.to,
            "B's own read",
          );
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse();
        lateEvidence(`late ${action.name} failure, ${to.label}`, orderId, to);
        expect(partitionOf(to.user, to.org)).toEqual(bBefore);
        expect(writesInto(to.user, to.org)).toEqual([]);
        action.expectDoneByA(await orderState(orderId));
        expect(text()).toBe(shownBefore); // no A error banner, no A data, no notice
        if (!to.read) expect(holdingOrder(to.user, to.org, orderId)).toEqual([]);

        await switchTo({ user: USER_A, org: ORG_A });
        await waitFor(
          () => cachedLifecycle(USER_A, ORG_A, orderId) === action.to,
          "A's recovery read",
        );
        expect(text()).toContain("Water");
      });

    it(`${action.name}, A's cache evicted after the switch: the late callback does not bring A's order back`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_B)!.delete("orders.read");
      await switchTo({ user: USER_B, org: ORG_B });
      client.removeQueries({
        predicate: (q) => q.queryKey[1] === USER_A && q.queryKey[2] === ORG_A,
      });
      expect(partitionOf(USER_A, ORG_A)).toEqual([]);
      await releaseResponse();
      lateEvidence(`late ${action.name}, A evicted`, orderId, { user: USER_B, org: ORG_B });
      expect(client.getQueryData(detailKeyOf(USER_A, ORG_A, orderId))).toBeUndefined();
      expect(holdingOrder(USER_A, ORG_A, orderId)).toEqual([]);
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(writesInto(USER_B, ORG_B)).toEqual([]);
      expect(text()).not.toContain("Water");
    });

    it(`${action.name}, the screen remounts for B before the response: written nowhere, shown to no one`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_B)!.delete("orders.read");
      await remountAs({ user: USER_B, org: ORG_B });
      const shownBefore = text();
      await releaseResponse();
      lateEvidence(`late ${action.name}, remount as B`, orderId, { user: USER_B, org: ORG_B });
      action.expectDoneByA(await orderState(orderId));
      expect(writesInto(USER_B, ORG_B)).toEqual([]);
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe(action.from);
      expect(text()).toBe(shownBefore);
      expect(text()).not.toContain("Water");
    });

    it(`${action.name}, A's orders.read is revoked while the response is held (A → B → A): the late response does not render it to A`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_A)!.delete("orders.read");
      await switchTo({ user: USER_B, org: ORG_B });
      await switchTo({ user: USER_A, org: ORG_A }); // A's re-read is now refused
      await releaseResponse();
      lateEvidence(`late ${action.name}, A's read revoked`, orderId, { user: USER_B, org: ORG_B });
      action.expectDoneByA(await orderState(orderId));
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(cachedLifecycle(USER_A, ORG_A, orderId)).not.toBe(action.to);
      expect(notices()).not.toContain(action.notice);
    });
  }

  it("Confirm, A → B → A, then a NEWER attempt (Cancel) completes before the old Confirm response: the old response never overwrites it", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder(); // attempt 1: committed as A, response held
    await committedAsA();
    await switchTo({ user: USER_B, org: ORG_B });
    await switchTo({ user: USER_A, org: ORG_A });
    await waitFor(() => cachedLifecycle(USER_A, ORG_A, orderId) === "confirmed", "A's re-read");
    await tapCancelOrder(); // attempt 2, as A
    await waitFor(() => cachedLifecycle(USER_A, ORG_A, orderId) === "cancelled", "the cancel");
    expect(notices()).toContain(en.order.cancelledNotice);
    await releaseResponse(); // attempt 1's answer: the CONFIRMED order
    lateEvidence("late Confirm after a newer Cancel", orderId, { user: USER_B, org: ORG_B });
    expect(outcomes).toEqual(["ok", "ok"]);
    expect((await orderState(orderId)).lifecycle).toBe("cancelled");
    expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe("cancelled");
    expect(notices()).toContain(en.order.cancelledNotice);
    expect(notices()).not.toContain(en.order.confirmedNotice);
    expect(writesInto(USER_A, ORG_A).filter((w) => w.endsWith("=confirmed"))).toEqual([]);
  });

  it("A stays signed in: Confirm, then Cancel, are written into A's own detail entry and announced", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    await tapConfirmOrder();
    await waitFor(() => notices().includes(en.order.confirmedNotice), "the confirmed notice");
    expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe("confirmed");
    await tapCancelOrder();
    await waitFor(() => notices().includes(en.order.cancelledNotice), "the cancelled notice");
    expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe("cancelled");
    expect(dialog()).toBeNull();
    const detailKey = JSON.stringify(detailKeyOf(USER_A, ORG_A, orderId));
    expect(writesInto(USER_A, ORG_A)).toEqual([`${detailKey}=confirmed`, `${detailKey}=cancelled`]);
    expect(manualWrites.filter((w) => w.key[1] !== USER_A || w.key[2] !== ORG_A)).toEqual([]);
    expect(outcomes).toEqual(["ok", "ok"]);
  });

  // Adjacent: Record payment's completion has the same hook-level shape, but it
  // only INVALIDATES (never writes a response into the cache). Measured here:
  // nothing of A's reaches another principal's partition.
  for (const to of [
    {
      label: "organization A → B, B reads neither orders nor payments",
      user: USER_B,
      org: ORG_B,
      read: false,
    },
    {
      label: "member A → B in the same organization, B reads payments",
      user: USER_B,
      org: ORG_A,
      read: true,
    },
  ]) {
    it(`Record payment, ${to.label}: A's late response writes nothing into B's cache`, async () => {
      const orderId = await seedConfirmed();
      await openOrderDetail(orderId);
      holdResponseNext.add("payment");
      await tapRecordPayment("10000");
      await waitFor(() => outcomesOf("payment")[0] === "ok", "A's payment committed");
      if (!to.read) {
        grants.get(USER_B)!.delete("orders.read");
        grants.get(USER_B)!.delete("payments.read");
      }
      await switchTo({ user: to.user, org: to.org });
      await releaseResponse();
      const shownToB = notices();
      console.log(
        `[evidence] late Record payment, ${to.label}: B.writes=[${writesInto(to.user, to.org).join(" ")}] ` +
          `B.holdsOrder=[${holdingOrder(to.user, to.org, orderId).join(" ")}] ` +
          `B.notice=${JSON.stringify(shownToB)} sheetOpen=${dialog() !== null}`,
      );
      const s = await orderState(orderId);
      expect(s.payments.map((p) => p.recorded_by)).toEqual([USER_A]);
      expect(manualWrites).toEqual([]); // no callback wrote a response anywhere
      if (!to.read) expect(holdingOrder(to.user, to.org, orderId)).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — IN-PLACE revocation: same member, same organization, read revoked
// ═══════════════════════════════════════════════════════════════════════════
//
// No principal switch: A's own orders.read is revoked while A's committed
// confirm / cancel response is held, the screen learns of it (permissions and
// the order are re-read; the server refuses the read), and only then does the
// old response arrive. It must not put the denied order back.

const { capabilityQueryKey } = await import("@/lib/capabilities");
/** The screen's permissions are re-read from the server, as the provider would. */
async function refreshPermissions() {
  await act(async () => {
    await client.refetchQueries({ queryKey: capabilityQueryKey(USER_A, ORG_A), exact: true });
  });
  await settle(6);
}
/** A's order detail is re-read from the server, as a focus or retry would. */
async function rereadOrder(orderId: string) {
  await act(async () => {
    await client.refetchQueries({ queryKey: detailKeyOf(USER_A, ORG_A, orderId), exact: true });
  });
  await settle(6);
}
const detailStatus = (orderId: string) =>
  client.getQueryState(detailKeyOf(USER_A, ORG_A, orderId))?.status ?? "absent";

describe("Order detail: a late confirm / cancel response never restores an order A may no longer read", () => {
  for (const action of LIFECYCLE_ACTIONS) {
    it(`${action.name}: A's orders.read revoked in place, permissions and order re-read (denied), then the late response: nothing restored; an authorized re-read recovers`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_A)!.delete("orders.read");
      await refreshPermissions();
      await rereadOrder(orderId);
      await waitFor(() => detailStatus(orderId) === "error", "the server's denied re-read");
      expect(text()).not.toContain("Water");
      await releaseResponse();
      lateEvidence(`late ${action.name}, A's read revoked in place`, orderId, {
        user: USER_B,
        org: ORG_B,
      });
      action.expectDoneByA(await orderState(orderId));
      expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_A });
      expect(writesInto(USER_A, ORG_A)).toEqual([]); // the response was written nowhere
      expect(detailStatus(orderId)).toBe("error");
      expect(text()).not.toContain("Water");
      expect(notices()).not.toContain(action.notice);

      // Legitimate recovery: the grant is restored, and a FRESH authorized read
      // (never the old response) shows A the committed order.
      grants.get(USER_A)!.add("orders.read");
      await refreshPermissions();
      await rereadOrder(orderId);
      await waitFor(
        () => cachedLifecycle(USER_A, ORG_A, orderId) === action.to,
        "the authorized re-read",
      );
      expect(text()).toContain("Water");
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
    });

    it(`${action.name}: A's read revoked and A's order evicted before the late response: the response does not bring it back`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      grants.get(USER_A)!.delete("orders.read");
      await refreshPermissions();
      await act(async () => {
        client.removeQueries({ queryKey: ordersKeys.principal(USER_A, ORG_A) });
      });
      await settle(6);
      await releaseResponse();
      lateEvidence(`late ${action.name}, A's read revoked and evicted`, orderId, {
        user: USER_B,
        org: ORG_B,
      });
      action.expectDoneByA(await orderState(orderId));
      expect(writesInto(USER_A, ORG_A)).toEqual([]);
      expect(client.getQueryData(detailKeyOf(USER_A, ORG_A, orderId))).toBeUndefined();
      expect(text()).not.toContain("Water");
      expect(notices()).not.toContain(action.notice);
    });

    it(`${action.name}: the permission refresh FAILS before the late response (snapshot no longer trustworthy): not applied; a fresh authorized read recovers`, async () => {
      const orderId = await action.seed();
      await openOrderDetail(orderId);
      holdResponseNext.add("lifecycle");
      await action.tap();
      await committedAsA();
      failCapabilityRefreshes = 1;
      await refreshPermissions();
      expect(client.getQueryState(capabilityQueryKey(USER_A, ORG_A))?.status).toBe("error");
      await releaseResponse();
      lateEvidence(`late ${action.name}, permission refresh failed`, orderId, {
        user: USER_B,
        org: ORG_B,
      });
      action.expectDoneByA(await orderState(orderId));
      expect(writesInto(USER_A, ORG_A)).toEqual([]); // fail closed: not written
      expect(notices()).not.toContain(action.notice);
      // A still holds orders.read server-side: the re-read the late response
      // triggered is the authorized recovery.
      await waitFor(
        () => cachedLifecycle(USER_A, ORG_A, orderId) === action.to,
        "the authorized re-read",
      );
      expect(text()).toContain("Water");
    });
  }

  it("A's orders.read revoked in place and the permission refresh says so: the order already on screen is withdrawn at once — an earlier read is not proof of access now", async () => {
    const orderId = await seedDraft();
    await openOrderDetail(orderId);
    expect(text()).toContain("Water");
    grants.get(USER_A)!.delete("orders.read");
    await refreshPermissions(); // the order itself has NOT been re-read yet
    console.log(
      `[evidence] in-place revocation, permissions refreshed only: detail=${detailStatus(orderId)} shows=${JSON.stringify(text().slice(0, 120))}`,
    );
    expect(text()).not.toContain("Water");
    expect(text()).toContain(en.order.denied);
    // A presentation gate: nothing was written or evicted to get there.
    expect(manualWrites).toEqual([]);
    // Restored: the order is shown again.
    grants.get(USER_A)!.add("orders.read");
    await refreshPermissions();
    await waitFor(() => text().includes("Water"), "the order, readable again");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — Record payment's DRAFT and late outcome belong to the member who typed it
// ═══════════════════════════════════════════════════════════════════════════
//
// A types an amount and a private bank reference, submits (committed as A),
// and the response is held. The screen switches to another member whose order
// detail is already cached — it renders at once, no skeleton, no remount. A's
// draft must be gone from B's screen at that moment, never submittable as B,
// and A's late outcome must not close, announce or alter anything of B's.
// A's unresolved replay key stays A's: A's retry after returning lands on the
// same payment.

/** A private bank reference, its own per case (a repeated reference is flagged as a duplicate). */
let PRIVATE_REF = "";
let privateRefSeq = 0;
const PRIVATE_AMOUNT = "12345"; // ៛12,345
const paymentNotice = en.order.paymentRecordedNotice;
async function typePaymentDraft(amount = PRIVATE_AMOUNT, reference = PRIVATE_REF) {
  await waitFor(() => button(en.order.recordPayment), "Record payment");
  await click(button(en.order.recordPayment), "Record payment");
  await typeInto(document.querySelector("#order-payment-amount"), amount);
  if (reference) await typeInto(document.querySelector("#order-payment-reference"), reference);
}
async function submitPaymentSheet(label = "Record payment (sheet)") {
  await click(button(en.order.recordPaymentSheet.submit, dialog()!), label);
}
/**
 * Anything of A's DRAFT on screen: a field value, the sheet's read-back of the
 * typed amount, or the private reference anywhere on the page (no member here
 * holds payments.view_provider_reference, so no server read can show it). A
 * recorded payment's amount in the server-read payments list is not a draft.
 */
function draftOnScreen() {
  const values = [...document.querySelectorAll("input")].map((i) => i.value);
  const sheet = dialog()?.textContent ?? "";
  return {
    fields: values.filter((v) => v.includes(PRIVATE_REF) || v === PRIVATE_AMOUNT),
    text: [
      ...(text().includes(PRIVATE_REF) ? [PRIVATE_REF] : []),
      ...(sheet.includes("12,345") ? ["12,345 (sheet)"] : []),
    ],
  };
}
const noDraft = { fields: [], text: [] };
async function paymentCommittedAsA() {
  await waitFor(() => outcomesOf("payment")[0] === "ok", "A's payment committed server-side");
}
const paymentKeys = () => sent.filter((s) => s.fn === "payment").map((s) => s.data.idempotencyKey);
function expectOnePaymentByA(s: Awaited<ReturnType<typeof orderState>>, amount: number) {
  expect(s.payments.map((p) => [p.recorded_by, p.amount_minor])).toEqual([[USER_A, amount]]);
  expect(s.paymentEvents.map((e) => [e.event_type, e.actor_user_id])).toEqual([
    ["created", USER_A],
  ]);
  expect(audits.filter((a) => a.action === "payments.record").map((a) => a.actor_user_id)).toEqual([
    USER_A,
  ]);
}

describe("Order detail: Record payment's draft and late outcome stay with the member who typed it", () => {
  beforeEach(() => {
    privateRefSeq += 1;
    PRIVATE_REF = `PRIVATE-BANK-REF-77${String(privateRefSeq).padStart(4, "0")}`;
  });
  const switches = [
    {
      label:
        "member A → B in the same organization, B's detail already cached, B lacks payments.read and payments.view_provider_reference",
      user: USER_B,
      org: ORG_A,
      revoke: ["payments.read", "payments.view_provider_reference"],
    },
    {
      label:
        "member A → B in the same organization, B's detail already cached, B lacks payments.view_provider_reference only",
      user: USER_B,
      org: ORG_A,
      revoke: ["payments.view_provider_reference"],
    },
    { label: "organization A → B", user: USER_B, org: ORG_B, revoke: [] as string[] },
  ];
  for (const to of switches) {
    for (const outcome of ["success", "failure"] as const) {
      it(`${to.label}, delayed ${outcome}: A's amount and reference are gone from B's screen at once, and A's outcome changes nothing of B's`, async () => {
        const orderId = await seedConfirmed();
        await openOrderDetail(orderId);
        // B's detail is already cached: B's screen will render without a skeleton.
        await switchTo({ user: to.user, org: to.org });
        await switchTo({ user: USER_A, org: ORG_A });
        await typePaymentDraft();
        expect(draftOnScreen().fields.length).toBeGreaterThan(0); // A sees A's own draft
        holdResponseNext.add("payment");
        if (outcome === "failure") loseNextResponse.add("payment");
        await submitPaymentSheet();
        await paymentCommittedAsA();
        for (const key of to.revoke) grants.get(USER_B)!.delete(key);
        await switchTo({ user: to.user, org: to.org });
        const atSwitch = draftOnScreen();
        const sheetAtSwitch = dialog() !== null;
        const shownBefore = text();
        await releaseResponse();
        console.log(
          `[evidence] payment draft, ${to.label}, delayed ${outcome}: atSwitch=${JSON.stringify(atSwitch)} ` +
            `sheetOpenForB=${sheetAtSwitch} afterRelease=${JSON.stringify(draftOnScreen())} ` +
            `notices=${JSON.stringify(notices())} B.writes=[${writesInto(to.user, to.org).join(" ")}]`,
        );
        expect(atSwitch).toEqual(noDraft);
        expect(sheetAtSwitch).toBe(false);
        expect(draftOnScreen()).toEqual(noDraft);
        expect(dialog()).toBeNull();
        expect(notices()).not.toContain(paymentNotice);
        expect(text()).toBe(shownBefore); // A's outcome changed nothing on B's screen
        expect(writesInto(to.user, to.org)).toEqual([]);
        // The server's act: one payment, A's, under A's one key.
        expect(outcomesOf("payment")).toEqual(["ok"]);
        expect(sent.find((s) => s.fn === "payment")!.server).toEqual({
          userId: USER_A,
          organizationId: ORG_A,
        });
        expectOnePaymentByA(await orderState(orderId), 12345);
      });
    }
  }

  it("B opens B's own Record payment sheet before A's late success: A's outcome neither closes it nor announces itself", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await switchTo({ user: USER_B });
    await typePaymentDraft("777", "");
    await releaseResponse();
    const fields = [...document.querySelectorAll("input")].map((i) => i.value);
    console.log(
      `[evidence] B's own sheet after A's late success: open=${dialog() !== null} fields=${JSON.stringify(fields)} notices=${JSON.stringify(notices())}`,
    );
    expect(dialog()).not.toBeNull();
    expect(fields).toContain("777");
    expect(notices()).not.toContain(paymentNotice);
    expectOnePaymentByA(await orderState(orderId), 12345);
  });

  it("A → B → A after a delayed FAILURE: A's sheet comes back empty, and A's retry replays A's one payment under A's original key", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    loseNextResponse.add("payment"); // committed as A; the response is lost
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseResponse();
    expect(dialog()).toBeNull();
    expect(draftOnScreen()).toEqual(noDraft);
    await typePaymentDraft(PRIVATE_AMOUNT, PRIVATE_REF); // A re-enters A's own payment
    await submitPaymentSheet("Record payment (A's retry)");
    await waitFor(() => outcomesOf("payment").length === 2, "A's retry");
    const after = await orderState(orderId);
    console.log(
      `[evidence] A→B→A retry: outcomes=[${outcomesOf("payment")}] keys=${JSON.stringify(paymentKeys())} payments=${JSON.stringify(after.payments.map((p) => [who(p.recorded_by), p.amount_minor]))}`,
    );
    expect(outcomesOf("payment")).toEqual(["ok", "ok"]);
    expect(new Set(paymentKeys()).size).toBe(1); // the same key: a replay, not a second payment
    expectOnePaymentByA(after, 12345);
  });

  it("A → B → A after a delayed SUCCESS: A's sheet comes back empty and a new payment gets a new key", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseResponse();
    expect(dialog()).toBeNull();
    expect(draftOnScreen()).toEqual(noDraft);
    expectOnePaymentByA(await orderState(orderId), 12345);
    await typePaymentDraft("500", "");
    await submitPaymentSheet("a second payment");
    await waitFor(() => outcomesOf("payment").length === 2, "the second payment");
    expect(new Set(paymentKeys()).size).toBe(2);
    const after = await orderState(orderId);
    expect(after.payments.map((p) => [who(p.recorded_by), p.amount_minor])).toEqual([
      ["A", 12345],
      ["A", 500],
    ]);
  });

  it("the screen remounts as B before the delayed response: no draft, no sheet, no notice; one payment, A's", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await remountAs({ user: USER_B });
    expect(draftOnScreen()).toEqual(noDraft);
    expect(dialog()).toBeNull();
    await releaseResponse();
    expect(draftOnScreen()).toEqual(noDraft);
    expect(dialog()).toBeNull();
    expect(notices()).not.toContain(paymentNotice);
    expectOnePaymentByA(await orderState(orderId), 12345);
  });

  it("A stays signed in: Record payment still records once, closes the sheet and says a claim was recorded", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    await submitPaymentSheet();
    await waitFor(() => notices().includes(paymentNotice), "the recorded notice");
    expect(dialog()).toBeNull();
    expectOnePaymentByA(await orderState(orderId), 12345);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inbox → Prepare Order: Confirm / Discard a draft
// ═══════════════════════════════════════════════════════════════════════════

describe("Inbox: confirming or discarding a draft runs as the member who asked", () => {
  /** A conversation of its own, and a draft created in it as A. */
  async function draftInConversation() {
    const cid = crypto.randomUUID();
    conversations.set(cid, { org: ORG_A, customerId: CUST_A });
    routeParams.id = cid;
    await mount("inbox");
    await click(button(en.conversation.actions.title), "conversation actions");
    await click(buttonContaining(en.conversation.createOrder), "Create order row");
    await click(buttonContaining("Water", dialog()!), "pick Water");
    await click(button(en.common.increase, dialog()!), "quantity +");
    await click(button(en.conversation.prepareOrder.createDraft), "Create Draft Order");
    await waitFor(() => button(en.conversation.prepareOrder.confirmOrder, dialog()!), "the draft");
    const [row] = (
      await f.db.query<Json>("select id from orders where source_conversation_ref = $1", [cid])
    ).rows;
    return row!.id as string;
  }

  it("A. another tab signs in as member B during Confirm: refused, never confirmed as B; A's retry is A's", async () => {
    const orderId = await draftInConversation();
    otherTab({ user: USER_B });
    const before = await writeSurface();
    await click(button(en.conversation.prepareOrder.confirmOrder, dialog()!), "Confirm order");
    await settle(10);
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("inbox: confirm, other tab signed in as B", during, wrote);

    otherTab({ user: USER_A });
    await click(button(en.conversation.prepareOrder.confirmOrder, dialog()!), "Confirm again");
    await settle(10);
    const after = await orderState(orderId);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("draft");
    expect(outcomes[1]).toBe("ok");
    expectConfirmedBy(after, USER_A);
  });

  it("B. member A → B during Discard: the draft is never cancelled as B", async () => {
    const orderId = await draftInConversation();
    holdDispatchNext.add("lifecycle");
    await click(buttonContaining(en.conversation.prepareOrder.discardDraft, dialog()!), "Discard");
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("inbox: discard, member A→B while dispatching", during, wrote);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("draft");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POS: the confirm step of Confirm sale, and Record payment
// ═══════════════════════════════════════════════════════════════════════════

describe("POS: confirming a sale and recording its payment run as the cashier who started them", () => {
  async function ringUpWater() {
    await mount("pos");
    let row: Element | undefined;
    for (let i = 0; i < 60 && !row; i++) {
      row = [...document.querySelectorAll("main button, main [role=button]")].find(
        (el) => el.textContent?.includes("Water") && !(el as HTMLButtonElement).disabled,
      );
      if (!row) await settle(2);
    }
    await click(row, "product Water");
    await click(buttonContaining(en.pos.checkout, document.querySelector("aside")!), "Checkout");
  }
  const posOrderIds = async () =>
    (
      await f.db.query<Json>("select id from orders where source = 'POS' order by created_at")
    ).rows.map((r) => r.id as string);

  it("C. another tab signs in as member B before the confirm step: the sale's order is never confirmed as B", async () => {
    const known = new Set(await posOrderIds());
    await ringUpWater();
    holdDispatchNext.add("lifecycle");
    await click(button(en.pos.confirmSale, dialog()!), "Confirm sale"); // create (as A), then confirm held
    await waitFor(() => dispatchGates.length > 0, "the confirm step");
    otherTab({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const orderId = (await posOrderIds()).find((id) => !known.has(id))!;
    const during = await orderState(orderId);
    evidence("pos: confirm step, other tab signed in as B", during, wrote);

    otherTab({ user: USER_A });
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const after = await orderState(orderId);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("draft");
    expect(outcomes[1]).toBe("ok");
    expect(after.lifecycle).toBe("confirmed");
    expect(
      after.history.filter((h) => h.to_status === "confirmed").map((h) => h.changed_by),
    ).toEqual([USER_A]);
    expect(after.movements.map((m) => [m.created_by, m.quantity_delta])).toEqual([[USER_A, -1]]);
  });

  it("D. another tab signs in as member B during the sale's Record payment: never recorded by B; A's retry is A's", async () => {
    const known = new Set(await posOrderIds());
    await ringUpWater();
    await click(button(en.pos.confirmSale, dialog()!), "Confirm sale");
    await waitFor(() => dialog()?.textContent?.includes(en.pos.success.title), "the sale");
    const orderId = (await posOrderIds()).find((id) => !known.has(id))!;
    await click(button(en.pos.success.recordPayment, dialog()!), "Record payment");
    await typeInto(document.querySelector("#order-payment-amount"), "5000");
    otherTab({ user: USER_B });
    const before = await writeSurface();
    await click(button(en.order.recordPaymentSheet.submit, dialog()!), "payment submit");
    await settle(10);
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("pos: payment, other tab signed in as B", during, wrote);

    otherTab({ user: USER_A });
    await click(button(en.order.recordPaymentSheet.submit, dialog()!), "payment retry");
    await settle(10);
    const after = await orderState(orderId);
    expect(outcomesOf("lifecycle")).toEqual(["ok"]); // the sale's own confirm, as A
    expect(outcomesOf("payment")).toEqual(["refused:principal_changed", "ok"]);
    expect(wrote).toEqual([]);
    expect(during.payments).toEqual([]);
    expect(after.payments.map((p) => [p.recorded_by, p.amount_minor, p.status])).toEqual([
      [USER_A, 5000, "pending"],
    ]);
  });
});
