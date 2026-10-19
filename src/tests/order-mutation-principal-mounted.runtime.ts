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
import { overServerFnWire } from "./helpers/server-fn-wire";
import { markPublicDomainError } from "@/server/public-domain-error";

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
        // ForbiddenError: public, so the boundary passes it to the browser.
        throw markPublicDomainError(
          Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 }),
        );
      }
    },
  } as unknown as AuthorizationContext;
}
/** resolveAuthContext(): the session's member, its active organization — or 401. */
function serverContext(): AuthorizationContext {
  if (!server.signedIn) {
    // UnauthorizedError: public, so the boundary passes it to the browser.
    throw markPublicDomainError(Object.assign(new Error("Not authenticated"), { statusCode: 401 }));
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

// ── The server-function boundary: gates, outcomes, the derived principal ─────

type Gated = "lifecycle" | "payment" | "delivery";
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
/** The next request of this kind fails on the server with this error instead of running. */
const failNextWith = new Map<Gated, unknown>();

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
      const injected = failNextWith.get(fn);
      if (injected !== undefined) {
        failNextWith.delete(fn);
        throw injected;
      }
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
  // What the screen receives is what the real boundary and TanStack's
  // serialization deliver: only the message (src/tests/helpers/server-fn-wire.ts).
  if ("error" in outcome) throw await overServerFnWire(outcome.error, WIRE_FILE[fn]);
  return outcome.value;
}
const WIRE_FILE: Record<Gated, string> = {
  lifecycle: "src/api/orders.ts",
  payment: "src/api/payments.ts",
  delivery: "src/api/deliveries.ts",
};

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
/** This case reads the order's deliveries from the database (as A's grants allow). */
let realDeliveryReads = false;
mock.module("@/api/deliveries", () => ({
  // src/api/deliveries.ts listDeliveriesFn's handler — only when the case asks.
  listDeliveriesFn: async ({ data }: { data?: Json } = {}) => {
    if (!realDeliveryReads) return [];
    const { listDeliveries } = await import("@/server/deliveries/service");
    return listDeliveries(serverContext(), { order_id: data?.orderId, limit: 50 });
  },
  // src/api/deliveries.ts createDeliveryFn's handler, field for field.
  createDeliveryFn: async ({ data }: { data: Json }) =>
    serve("delivery", data, async (ctx) => {
      const { createDelivery } = await import("@/server/deliveries/service");
      return (createDelivery as any)(ctx, {
        orderId: data.orderId,
        locationId: data.locationId ?? null,
        providerId: data.providerId ?? null,
        providerKey: data.providerKey ?? null,
        providerName: data.providerName ?? null,
        externalTrackingNumber: data.externalTrackingNumber ?? null,
        codAmountMinor: data.codAmountMinor ?? null,
        expectedPrincipal: data.expectedPrincipal,
      });
    }),
}));
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
const km = (await import("@/locales/km.json")).default as any;
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
  navigations.length = 0;
  outcomes.length = 0;
  audits.length = 0;
  holdDispatchNext.clear();
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  loseNextResponse.clear();
  holdResponseNext.clear();
  for (const release of heldResponses) release();
  heldResponses.length = 0;
  failNextWith.clear();
  realDeliveryReads = false;
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
/**
 * At least 80 rounds, and at least 5 s of real time: a count of event-loop
 * turns alone made every wait depend on how fast the in-process database
 * answered on the machine running the suite.
 */
async function waitFor(check: () => unknown, label: string) {
  const deadline = Date.now() + 5000;
  for (let i = 0; i < 80 || Date.now() < deadline; i++) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${label}; page: ${text().slice(0, 500)}`);
}
/**
 * Every read the screen has started has answered. A comparison of what a
 * principal sees "before" and "after" a late response is only meaningful once
 * that principal's own legitimate reads are not still landing in between.
 */
async function readsSettled() {
  // Idle across several consecutive rounds: one read finishing can enable the
  // next (capabilities → pack state, detail → deliveries), so a single idle
  // instant between them is not "settled".
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
/** Confirmed, paid (a verified cash payment) and handed over at the counter: ready to complete. */
async function seedReadyToComplete(): Promise<string> {
  const orderId = await seedConfirmed();
  const payment = await f.record(10000, "cash", null, orderId, ORG_A);
  await f.verify(payment, "staff_confirmed", "unverified", ORG_A);
  await handOverAtCounter(orderId);
  audits.length = 0;
  return orderId;
}
/** The fulfillment move behind the screen's back: unfulfilled → fulfilled (goods with the customer). */
async function handOverAtCounter(orderId: string) {
  const r = await f.rpc("transition_order_status_v1", [
    ORG_A,
    orderId,
    "fulfillment",
    "unfulfilled",
    "fulfilled",
    USER_A,
    null,
  ]);
  if (r.status !== "success") throw new Error(JSON.stringify(r));
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
const completeActionButton = () => button(en.order.next.action.complete_order);
async function tapCompleteOrder() {
  await waitFor(
    () => completeActionButton() && !completeActionButton()!.disabled,
    "Complete order (Next step)",
  );
  await click(completeActionButton(), "Complete order (Next step)");
  await click(button(en.order.completeSheet.submit, dialog()!), "Complete order (sheet)");
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
  name: "Confirm" | "Cancel" | "Complete";
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
      // Both rows are written in one transaction with the same changed_at, so
      // their relative order is not defined: compare them as a set.
      expect(cancels.map((h) => `${h.axis}:${who(h.changed_by)}`).sort()).toEqual([
        "fulfillment:A",
        "lifecycle:A",
      ]);
    },
  },
  {
    name: "Complete",
    seed: seedReadyToComplete,
    tap: tapCompleteOrder,
    from: "confirmed",
    to: "completed",
    notice: en.order.completedNotice,
    expectDoneByA: (s) => {
      expect(s.lifecycle).toBe("completed");
      const completes = s.history.filter((h) => h.to_status === "completed");
      expect(completes.map((h) => `${h.axis}:${who(h.changed_by)}`)).toEqual(["lifecycle:A"]);
      // Completing moves no stock and no money: only the confirm's sale, one payment.
      expect(s.movements.map((m) => m.movement_type)).toEqual(["sale"]);
      expect(s.payments).toHaveLength(1);
    },
  },
];
/** Every grant that could let B act on the order's lifecycle or payments. */
const B_ACTION_GRANTS = [
  "orders.confirm",
  "orders.cancel",
  "orders.update",
  "payments.read",
  "payments.record",
  "payments.mark_cod",
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
        for (const key of B_ACTION_GRANTS) bGrants.delete(key);
        if (!to.read) bGrants.delete("orders.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedLifecycle(to.user, to.org, orderId) === action.to,
            "B's own read",
          );
        await readsSettled();
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse(); // A's response lands while B is shown
        await readsSettled();
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
        for (const key of B_ACTION_GRANTS) grants.get(USER_B)!.delete(key);
        if (!to.read) grants.get(USER_B)!.delete("orders.read");
        await switchTo({ user: to.user, org: to.org });
        if (to.read)
          await waitFor(
            () => cachedLifecycle(to.user, to.org, orderId) === action.to,
            "B's own read",
          );
        await readsSettled();
        const bBefore = partitionOf(to.user, to.org);
        const shownBefore = text();
        await releaseResponse();
        await readsSettled();
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
      await readsSettled();
      const shownBefore = text();
      await releaseResponse();
      await readsSettled();
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
// Order detail Smart Next Action: Complete, and the custody guard's refusals
// ═══════════════════════════════════════════════════════════════════════════

describe("Order detail: Complete runs as the member who asked, and a stale screen is refused", () => {
  it("member A → B during Complete: never completed as B; A's retry is A's", async () => {
    const orderId = await seedReadyToComplete();
    await openOrderDetail(orderId);
    holdDispatchNext.add("lifecycle");
    await tapCompleteOrder();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const during = await orderState(orderId);
    evidence("order detail: complete, member A→B while dispatching", during, wrote);

    await switchTo({ user: USER_A });
    await tapCompleteOrder();
    const after = await orderState(orderId);
    expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(during.lifecycle).toBe("confirmed");
    expect(outcomes[1]).toBe("ok");
    LIFECYCLE_ACTIONS[2]!.expectDoneByA(after);
  });

  it("A stays signed in: Complete is written into A's own entry once, closes the sheet and is announced", async () => {
    const orderId = await seedReadyToComplete();
    await openOrderDetail(orderId);
    await tapCompleteOrder();
    await waitFor(() => notices().includes(en.order.completedNotice), "the completed notice");
    expect(cachedLifecycle(USER_A, ORG_A, orderId)).toBe("completed");
    expect(dialog()).toBeNull();
    expect(completeActionButton()).toBeUndefined(); // a completed order offers no Complete
    const detailKey = JSON.stringify(detailKeyOf(USER_A, ORG_A, orderId));
    expect(writesInto(USER_A, ORG_A)).toEqual([`${detailKey}=completed`]);
    expect(outcomes).toEqual(["ok"]);
  });

  it("the sheet cannot submit twice while Complete is in flight", async () => {
    const orderId = await seedReadyToComplete();
    await openOrderDetail(orderId);
    holdResponseNext.add("lifecycle");
    await tapCompleteOrder();
    await committedAsA();
    const submit = buttonContaining(en.order.completing, dialog()!);
    expect(submit?.disabled).toBe(true);
    await click(submit, "Complete order (sheet, again)");
    await releaseResponse();
    await waitFor(() => notices().includes(en.order.completedNotice), "the completed notice");
    expect(sent.filter((s) => s.fn === "lifecycle")).toHaveLength(1);
  });

  it("stale screen: the payment is reversed after the screen read it — the server refuses Complete, nothing is announced, the order is re-read", async () => {
    const orderId = await seedReadyToComplete();
    await openOrderDetail(orderId);
    await waitFor(() => completeActionButton(), "Complete order (Next step)");
    const [payment] = (
      await f.db.query<{ id: string }>("select id from payments where order_id = $1", [orderId])
    ).rows;
    await f.reverse(payment!.id, ORG_A); // behind the screen's back: no longer paid
    const before = await writeSurface();
    await tapCompleteOrder();
    await waitFor(() => outcomes.length === 1, "the server's answer");
    const wrote = wroteSince(before, await writeSurface());
    console.log(
      `[evidence] stale Complete after reversal: server=[${outcomes.join(",")}] wrote=[${wrote}]`,
    );
    expect(outcomes[0]).toMatch(/^refused:/);
    expect(wrote).toEqual([]);
    expect((await orderState(orderId)).lifecycle).toBe("confirmed");
    expect(notices()).not.toContain(en.order.completedNotice);
    expect(dialog()).toBeNull();
    // The re-read withdraws Complete: the order is no longer paid.
    await waitFor(() => !completeActionButton(), "Complete withdrawn after the re-read");
  });

  it("stale screen: A's orders.update is revoked — Complete is refused by A's own permission (403), nothing written", async () => {
    const orderId = await seedReadyToComplete();
    await openOrderDetail(orderId);
    await waitFor(() => completeActionButton(), "Complete order (Next step)");
    grants.get(USER_A)!.delete("orders.update");
    const before = await writeSurface();
    await tapCompleteOrder();
    await waitFor(() => outcomes.length === 1, "the server's answer");
    expect(outcomes[0]).toBe("refused:403");
    expect(wroteSince(before, await writeSurface())).toEqual([]);
    expect(notices()).not.toContain(en.order.completedNotice);
  });
});

describe("Order detail: the custody guard's cancellation refusal reaches the merchant", () => {
  it("handed over at the counter after the screen read it: Cancel is refused (goods_with_customer), no stock returns, the reason is shown and Cancel is withdrawn", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await waitFor(() => button(en.order.cancel), "Cancel order");
    await handOverAtCounter(orderId); // behind the screen's back
    const before = await writeSurface();
    await tapCancelOrder();
    await waitFor(() => outcomes.length === 1, "the server's answer");
    const wrote = wroteSince(before, await writeSurface());
    const s = await orderState(orderId);
    console.log(
      `[evidence] stale Cancel after hand-over: server=[${outcomes.join(",")}] wrote=[${wrote}]`,
    );
    expect(outcomes[0]).toBe("refused:order_cancel_goods_with_customer");
    expect(wrote).toEqual([]);
    expect(s.lifecycle).toBe("confirmed");
    expect(s.movements.filter((m) => m.quantity_delta > 0)).toEqual([]); // nothing restocked
    expect(text()).toContain(en.order.error.cancelBlocked.title);
    expect(text()).toContain(en.order.error.cancelBlocked.goods_with_customer);
    expect(notices()).not.toContain(en.order.cancelledNotice);
    // The sheet closes so the reason is visible; its submit would be refused again.
    await waitFor(() => dialog() === null, "the cancel sheet closed");
    await waitFor(() => !button(en.order.cancel), "Cancel withdrawn after the re-read");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The custody refusal as the browser actually receives it
// ═══════════════════════════════════════════════════════════════════════════
//
// serve() hands the screen what the real server-function boundary and
// TanStack's ShallowErrorPlugin deliver (src/tests/helpers/server-fn-wire.ts):
// a bare Error carrying only the message. Each custody refusal is made real —
// the goods or a delivery move behind the screen's back, then the guard in the
// database refuses — and must still close the sheet, say why in both
// languages, and re-read the order so Cancel is withdrawn.

/** A delivery for the order, created behind the screen's back and moved to `status`. */
async function deliveryBehindScreen(orderId: string, status: "pending" | "in_transit") {
  const created = await f.rpc("create_delivery_v1", [
    ORG_A,
    orderId,
    USER_A,
    null,
    null,
    null,
    "Courier",
    null,
    null,
  ]);
  if (created.status !== "success") throw new Error(JSON.stringify(created));
  const chain = ["pending", "preparing", "ready", "in_transit"];
  for (let i = 0; chain[i] !== status; i++) {
    const to = chain[i + 1]!;
    // '→ ready' is the step Mark Packed makes (054); packing is not under test.
    const moved = await f.rpc("transition_delivery_status_v1", [
      ORG_A,
      created.delivery_id,
      chain[i],
      to,
      USER_A,
      to === "ready" ? "pack_order_packed" : null,
    ]);
    if (moved.status !== "success") throw new Error(JSON.stringify(moved));
  }
}

const CUSTODY_REFUSALS = [
  {
    code: "order_cancel_goods_with_customer",
    reason: "goods_with_customer",
    behindScreen: (orderId: string) => handOverAtCounter(orderId),
  },
  {
    code: "order_cancel_goods_dispatched",
    reason: "goods_dispatched",
    behindScreen: (orderId: string) => deliveryBehindScreen(orderId, "in_transit"),
  },
  {
    code: "order_cancel_active_delivery",
    reason: "active_delivery",
    behindScreen: (orderId: string) => deliveryBehindScreen(orderId, "pending"),
  },
] as const;

/** A's confirmed order on screen, Cancel offered — the screen has read its (empty) deliveries. */
async function openCancellableOrder(orderId: string) {
  grants.get(USER_A)!.add("delivery.read");
  realDeliveryReads = true;
  await openOrderDetail(orderId);
  await waitFor(() => button(en.order.cancel), "Cancel order");
  await readsSettled();
}

describe("Order detail: a custody refusal across the real server-function wire", () => {
  for (const refusal of CUSTODY_REFUSALS) {
    it(`${refusal.reason}: the sheet closes, the reason shows in English and Khmer, the order is re-read and Cancel is withdrawn — nothing written`, async () => {
      const orderId = await seedConfirmed();
      await openCancellableOrder(orderId);
      await refusal.behindScreen(orderId);
      const readAt = client.getQueryState(detailKeyOf(USER_A, ORG_A, orderId))!.dataUpdatedAt;
      const before = await writeSurface();
      await tapCancelOrder();
      await waitFor(() => outcomes.length === 1, "the server's answer");
      await waitFor(() => dialog() === null, "the cancel sheet closed");
      await waitFor(() => !button(en.order.cancel), "Cancel withdrawn after the re-read");
      await readsSettled();
      const wrote = wroteSince(before, await writeSurface());
      const s = await orderState(orderId);
      const rereadAt = client.getQueryState(detailKeyOf(USER_A, ORG_A, orderId))!.dataUpdatedAt;
      console.log(
        `[evidence] wire custody refusal ${refusal.reason}: server=[${outcomes}] wrote=[${wrote}] ` +
          `reread=${rereadAt > readAt} cancelOffered=${Boolean(button(en.order.cancel))}`,
      );
      expect(outcomes).toEqual([`refused:${refusal.code}`]);
      expect(wrote).toEqual([]); // no status, history, stock, payment, event, token or audit
      expect(audits).toEqual([]);
      expect(s.lifecycle).toBe("confirmed");
      expect(s.movements.filter((m) => m.quantity_delta > 0)).toEqual([]);
      expect(rereadAt).toBeGreaterThan(readAt);
      expect(text()).toContain(en.order.error.cancelBlocked.title);
      expect(text()).toContain(en.order.error.cancelBlocked[refusal.reason]);
      expect(text()).not.toContain(en.error.title);
      expect(text()).not.toContain(refusal.code); // the wire code is never shown
      expect(notices()).not.toContain(en.order.cancelledNotice);
      try {
        await act(async () => {
          await i18n.changeLanguage("km");
        });
        await settle(6);
        expect(text()).toContain(km.order.error.cancelBlocked.title);
        expect(text()).toContain(km.order.error.cancelBlocked[refusal.reason]);
      } finally {
        await act(async () => {
          await i18n.changeLanguage("en");
        });
      }
    });
  }

  it("delayed refusal, O1 → O2: O2's screen, sheet and Cancel are untouched; back on O1 Cancel is withdrawn", async () => {
    const o1 = await seedConfirmed();
    const o2 = await seedConfirmed();
    await openCancellableOrder(o2);
    await navigateOrder(o1);
    await deliveryBehindScreen(o1, "in_transit");
    holdResponseNext.add("lifecycle");
    await tapCancelOrder();
    await waitFor(() => outcomes.length === 1, "O1's refusal, held");
    await navigateOrder(o2);
    await waitFor(() => button(en.order.cancel), "O2's Cancel");
    await click(button(en.order.cancel), "O2's Cancel"); // O2's own sheet, open
    const shownBefore = text();
    await releaseResponse(); // O1's refusal, while O2 is shown
    await readsSettled();
    console.log(
      `[evidence] delayed custody refusal O1→O2: server=[${outcomes}] o2Unchanged=${text() === shownBefore} ` +
        `o2SheetOpen=${dialog() !== null} o2Writes=[${writesIntoDetailOf(o2)}]`,
    );
    expect(outcomes).toEqual(["refused:order_cancel_goods_dispatched"]);
    expect(text()).toBe(shownBefore);
    expect(text()).not.toContain(en.order.error.cancelBlocked.title);
    expect(dialog()).not.toBeNull(); // O2's own sheet stays open
    expect(writesIntoDetailOf(o2)).toEqual([]);
    expect(await lifecycleOf(o2)).toBe("confirmed");
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => dialog() === null, "O2's sheet dismissed");
    await navigateOrder(o1);
    await waitFor(() => !button(en.order.cancel), "O1's Cancel withdrawn by its own re-read");
    expect(await lifecycleOf(o1)).toBe("confirmed");
  });

  it("delayed refusal, member A → B: nothing of A's refusal reaches B's screen", async () => {
    const orderId = await seedConfirmed();
    grants.get(USER_B)!.add("delivery.read");
    await openCancellableOrder(orderId);
    await handOverAtCounter(orderId);
    holdResponseNext.add("lifecycle");
    await tapCancelOrder();
    await waitFor(() => outcomes.length === 1, "A's refusal, held");
    await switchTo({ user: USER_B });
    await readsSettled();
    const shownBefore = text();
    await releaseResponse();
    await readsSettled();
    console.log(
      `[evidence] delayed custody refusal A→B: server=[${outcomes}] bUnchanged=${text() === shownBefore} ` +
        `writesForB=[${writesInto(USER_B, ORG_A)}]`,
    );
    expect(outcomes).toEqual(["refused:order_cancel_goods_with_customer"]);
    expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_A });
    expect(text()).toBe(shownBefore);
    expect(text()).not.toContain(en.order.error.cancelBlocked.title);
    expect(writesInto(USER_B, ORG_A)).toEqual([]);
  });

  it("an unexpected server error carrying a custody code is sanitized: generic copy, the sheet stays open, nothing written", async () => {
    const orderId = await seedConfirmed();
    await openCancellableOrder(orderId);
    failNextWith.set(
      "lifecycle",
      Object.assign(new Error('duplicate key value violates "orders_pkey"'), {
        statusCode: 409,
        code: "order_cancel_goods_with_customer",
      }),
    );
    const before = await writeSurface();
    await tapCancelOrder();
    await waitFor(() => outcomes.length === 1, "the server's answer");
    await waitFor(() => text().includes(en.error.title), "the generic error");
    const wrote = wroteSince(before, await writeSurface());
    expect(wrote).toEqual([]);
    expect(text()).not.toContain(en.order.error.cancelBlocked.title);
    expect(text()).not.toContain("orders_pkey");
    expect(dialog()).not.toBeNull(); // not a custody refusal: the sheet stays for a retry
    expect(button(en.order.cancel)).toBeTruthy();
  });
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
        await readsSettled();
        const shownBefore = text();
        await releaseResponse();
        await readsSettled();
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

  it("opened from the Next step panel, A → B → A while A's submit is still in flight: the retry reuses A's key, so the late original and the retry are one payment", async () => {
    const nextStep = () =>
      [...document.querySelectorAll("section")].find(
        (el) => el.querySelector("h2")?.textContent?.trim() === en.order.next.title,
      ) ?? null;
    const openFromNextStep = async () => {
      await waitFor(
        () => nextStep() && button(en.order.next.action.record_payment, nextStep()!),
        "Next step: Record payment",
      );
      await click(
        button(en.order.next.action.record_payment, nextStep()!),
        "Next step: Record payment",
      );
      await typeInto(document.querySelector("#order-payment-amount"), PRIVATE_AMOUNT);
      await typeInto(document.querySelector("#order-payment-reference"), PRIVATE_REF);
    };
    const orderId = await seedConfirmed();
    await handOverAtCounter(orderId); // goods with the customer, unpaid: the panel offers Record payment
    await openOrderDetail(orderId);
    await openFromNextStep();
    holdDispatchNext.add("payment"); // left the screen as A, not yet at the server
    await submitPaymentSheet();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await openFromNextStep(); // the order still reads unpaid: A re-enters the payment
    await releaseDispatch(); // A's original lands now, as A
    await submitPaymentSheet("Record payment (A's retry from Next step)");
    await waitFor(() => outcomesOf("payment").length === 2, "A's retry");
    const after = await orderState(orderId);
    console.log(
      `[evidence] Next step retry during in-flight submit: outcomes=[${outcomesOf("payment")}] keys=${JSON.stringify(paymentKeys())} payments=${after.payments.length}`,
    );
    expect(outcomesOf("payment")).toEqual(["ok", "ok"]);
    expect(new Set(paymentKeys()).size).toBe(1); // the parked key came back: a replay
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
// P2 — Arrange delivery: created by, and its draft kept for, the member who started it
// ═══════════════════════════════════════════════════════════════════════════
//
// A types a courier and a tracking number. Two windows: (1) the screen
// switches to another member while A's draft is open — it must be gone, not
// submittable as B; (2) A's request left the screen as A and the server
// handles it after the switch — it must be refused, never executed with B's
// permissions or recorded as B's. A late answer must not navigate, close or
// announce anything on B's screen.

const PRIVATE_COURIER = "Private Courier A";
let PRIVATE_TRACKING = "";
let trackingSeq = 0;
async function openArrangeDelivery() {
  await waitFor(() => buttonContaining(en.order.arrangeDelivery), "Arrange delivery");
  await click(buttonContaining(en.order.arrangeDelivery), "Arrange delivery");
}
async function typeDeliveryDraft() {
  await openArrangeDelivery();
  await typeInto(document.querySelector("#delivery-provider-name"), PRIVATE_COURIER);
  await typeInto(document.querySelector("#delivery-tracking-number"), PRIVATE_TRACKING);
}
async function submitDeliverySheet(label = "Create delivery") {
  await click(button(en.delivery.create.submit, dialog()!), label);
}
function deliveryDraftOnScreen() {
  const values = [...document.querySelectorAll("input")].map((i) => i.value);
  return {
    fields: values.filter((v) => v === PRIVATE_COURIER || v === PRIVATE_TRACKING),
    text: [PRIVATE_COURIER, PRIVATE_TRACKING].filter((s) => text().includes(s)),
  };
}
const noDeliveryDraft = { fields: [], text: [] };
async function deliveriesOf(orderId: string) {
  return (
    await f.db.query<Json>(
      `select created_by, organization_id, provider_name, external_tracking_number, status
         from deliveries where order_id = $1 order by created_at`,
      [orderId],
    )
  ).rows.map((d) => ({
    by: who(d.created_by),
    org: d.organization_id === ORG_A ? "ORG_A" : d.organization_id,
    courier: d.provider_name,
    tracking: d.external_tracking_number,
  }));
}
const outcomesOfDelivery = () => outcomesOf("delivery");
const deliveryNavigations = () =>
  navigations.filter((n) => n.to === "/app/deliveries/$id").map((n) => n.params?.id);

describe("Order detail: Arrange delivery is created by, and its draft kept for, the member who started it", () => {
  beforeEach(() => {
    trackingSeq += 1;
    PRIVATE_TRACKING = `TRK-PRIVATE-${String(trackingSeq).padStart(4, "0")}`;
    grants.get(USER_A)!.add("delivery.create");
    grants.get(USER_B)!.add("delivery.create");
  });

  for (const to of [
    {
      label: "member A → B in the same organization, B's detail already cached",
      user: USER_B,
      org: ORG_A,
    },
    { label: "organization A → B", user: USER_B, org: ORG_B },
  ]) {
    it(`${to.label}: A's open draft is gone at once — B can neither see nor submit it`, async () => {
      const orderId = await seedConfirmed();
      await openOrderDetail(orderId);
      await switchTo({ user: to.user, org: to.org }); // B's detail is cached
      await switchTo({ user: USER_A, org: ORG_A });
      await typeDeliveryDraft();
      expect(deliveryDraftOnScreen().fields.length).toBe(2); // A sees A's draft
      await switchTo({ user: to.user, org: to.org });
      const atSwitch = deliveryDraftOnScreen();
      const sheet = dialog();
      const submitAsB = sheet ? button(en.delivery.create.submit, sheet) : undefined;
      const submittable = Boolean(submitAsB && !submitAsB.disabled);
      if (submittable) await submitDeliverySheet("B presses Create delivery on A's draft");
      await settle(10);
      const rows = await deliveriesOf(orderId);
      console.log(
        `[evidence] delivery draft, ${to.label}: atSwitch=${JSON.stringify(atSwitch)} sheetOpenForB=${sheet !== null} ` +
          `submittableAsB=${submittable} server=[${outcomesOfDelivery()}] deliveries=${JSON.stringify(rows)}`,
      );
      expect(atSwitch).toEqual(noDeliveryDraft);
      expect(sheet).toBeNull();
      expect(submittable).toBe(false);
      expect(rows).toEqual([]);
      expect(sent.filter((s) => s.fn === "delivery")).toEqual([]);
    });
  }

  it("A's request leaves the screen as A and the server handles it after a switch to B (same organization): refused, nothing written; A's retry is A's", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    holdDispatchNext.add("delivery");
    await submitDeliverySheet(); // left the screen as A
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch(); // handled while the session is B's
    const rowsDuring = await deliveriesOf(orderId);
    const deliveriesWritten = (await f.db.query<Json>("select count(*)::int n from deliveries"))
      .rows[0]!.n;
    console.log(
      `[evidence] delivery dispatch, A→B: server=[${outcomesOfDelivery()}] handledAs=${JSON.stringify(sent.find((s) => s.fn === "delivery")?.server)} deliveries=${JSON.stringify(rowsDuring)} navigations=${JSON.stringify(deliveryNavigations())}`,
    );
    expect(sent.find((s) => s.fn === "delivery")!.server).toEqual({
      userId: USER_B,
      organizationId: ORG_A,
    });
    expect(sent.find((s) => s.fn === "delivery")!.data.expectedPrincipal).toEqual({
      userId: USER_A,
      organizationId: ORG_A,
    });
    expect(outcomesOfDelivery()).toEqual(["refused:principal_changed"]);
    expect(rowsDuring).toEqual([]);
    expect(wroteSince(before, await writeSurface())).toEqual([]);
    expect(deliveryNavigations()).toEqual([]);
    void deliveriesWritten;

    await switchTo({ user: USER_A });
    await typeDeliveryDraft();
    await submitDeliverySheet("A's retry");
    await waitFor(() => outcomesOfDelivery().length === 2, "A's retry");
    expect(outcomesOfDelivery()).toEqual(["refused:principal_changed", "ok"]);
    expect(await deliveriesOf(orderId)).toEqual([
      { by: "A", org: "ORG_A", courier: PRIVATE_COURIER, tracking: PRIVATE_TRACKING },
    ]);
  });

  it("A lacks delivery.create, B holds it: B's grant never creates A's delivery", async () => {
    const orderId = await seedConfirmed();
    grants.get(USER_A)!.delete("delivery.create");
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    holdDispatchNext.add("delivery");
    await submitDeliverySheet();
    await switchTo({ user: USER_B });
    await releaseDispatch();
    const rows = await deliveriesOf(orderId);
    console.log(
      `[evidence] delivery, A unauthorized / B authorized: server=[${outcomesOfDelivery()}] deliveries=${JSON.stringify(rows)}`,
    );
    expect(outcomesOfDelivery()).toEqual(["refused:principal_changed"]);
    expect(rows).toEqual([]);
  });

  it("organization A → B while A's request is dispatching: refused as principal_changed — not a misleading 404 — nothing written", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    holdDispatchNext.add("delivery");
    await submitDeliverySheet();
    await switchTo({ user: USER_B, org: ORG_B });
    await releaseDispatch();
    console.log(`[evidence] delivery, org A→B: server=[${outcomesOfDelivery()}]`);
    expect(outcomesOfDelivery()).toEqual(["refused:principal_changed"]);
    expect(await deliveriesOf(orderId)).toEqual([]);
  });

  it("committed as A, the response held, then B is shown: B's screen is not navigated, closed or announced to; the delivery is A's", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    holdResponseNext.add("delivery");
    await submitDeliverySheet();
    await waitFor(() => outcomesOfDelivery()[0] === "ok", "A's delivery committed");
    await switchTo({ user: USER_B });
    await readsSettled();
    const shownBefore = text();
    await releaseResponse();
    await readsSettled();
    console.log(
      `[evidence] delivery late success, A→B: navigations=${JSON.stringify(deliveryNavigations())} B.writes=[${writesInto(USER_B, ORG_A).join(" ")}]`,
    );
    expect(deliveryNavigations()).toEqual([]);
    expect(text()).toBe(shownBefore);
    expect(writesInto(USER_B, ORG_A)).toEqual([]);
    expect(await deliveriesOf(orderId)).toEqual([
      { by: "A", org: "ORG_A", courier: PRIVATE_COURIER, tracking: PRIVATE_TRACKING },
    ]);
  });

  it("the screen remounts as B before the response: no draft, no navigation", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    holdResponseNext.add("delivery");
    await submitDeliverySheet();
    await waitFor(() => outcomesOfDelivery()[0] === "ok", "A's delivery committed");
    await remountAs({ user: USER_B });
    expect(deliveryDraftOnScreen()).toEqual(noDeliveryDraft);
    await releaseResponse();
    expect(deliveryNavigations()).toEqual([]);
    expect(deliveryDraftOnScreen()).toEqual(noDeliveryDraft);
    expect((await deliveriesOf(orderId)).map((d) => d.by)).toEqual(["A"]);
  });

  it("A → B → A: A's draft does not come back; A arranges the delivery again from an empty sheet", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    expect(dialog()).toBeNull();
    expect(deliveryDraftOnScreen()).toEqual(noDeliveryDraft);
    await openArrangeDelivery();
    expect(deliveryDraftOnScreen()).toEqual(noDeliveryDraft);
  });

  it("A stays signed in: Arrange delivery creates A's delivery once, closes the sheet and opens it", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typeDeliveryDraft();
    await submitDeliverySheet();
    await waitFor(() => deliveryNavigations().length === 1, "the new delivery opened");
    expect(outcomesOfDelivery()).toEqual(["ok"]);
    expect(sent.find((s) => s.fn === "delivery")!.data.expectedPrincipal).toEqual({
      userId: USER_A,
      organizationId: ORG_A,
    });
    expect(dialog()).toBeNull();
    expect(await deliveriesOf(orderId)).toEqual([
      { by: "A", org: "ORG_A", courier: PRIVATE_COURIER, tracking: PRIVATE_TRACKING },
    ]);
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

// ═══════════════════════════════════════════════════════════════════════════
// P2 — a late answer stays with the ORDER it was started on
// ═══════════════════════════════════════════════════════════════════════════
//
// Same member, same organization: the mounted Order detail moves from order O1
// to order O2 (the route param changes; the screen is not remounted) while
// O1's Confirm / Cancel / Record payment is in flight. O1's answer must never
// be written into O2's entry or shown under O2's URL — a merchant reading O1's
// detail on O2's screen and tapping Cancel would cancel O2.

const orderNumberOf = async (orderId: string) =>
  (await f.db.query<Json>("select order_number from orders where id = $1", [orderId])).rows[0]!
    .order_number as string;
const cachedOrderIdAt = (orderId: string) =>
  (client.getQueryData(detailKeyOf(USER_A, ORG_A, orderId)) as any)?.order?.id ?? null;
/** The same mounted screen moves to another order (the route param changes). */
async function navigateOrder(orderId: string) {
  routeParams.id = orderId;
  await rerender();
  await waitFor(() => cachedOrderIdAt(orderId) !== null && text().includes("Water"), "the order");
  await readsSettled();
}
/** Which of the two orders' numbers the screen shows. */
async function showing(o1: string, o2: string) {
  const [n1, n2] = [await orderNumberOf(o1), await orderNumberOf(o2)];
  return { o1: text().includes(n1), o2: text().includes(n2) };
}
/** The lifecycle carried by every callback write into one order's own detail entry. */
function writesIntoDetailOf(orderId: string) {
  const key = JSON.stringify(detailKeyOf(USER_A, ORG_A, orderId));
  return manualWrites.filter((w) => JSON.stringify(w.key) === key).map((w) => w.lifecycle);
}
const lifecycleOf = async (orderId: string) => (await orderState(orderId)).lifecycle;
const nameOf = (id: unknown, o1: string, o2: string) =>
  id === o1 ? "O1" : id === o2 ? "O2" : String(id);

describe("Order detail: a late lifecycle or payment answer stays with the order it was started on", () => {
  it("O1 → O2, delayed Confirm success: O2's entry and screen stay O2's; a Cancel tapped there cancels the order shown — O2 — and O1 stays confirmed", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    await navigateOrder(o2); // O2 cached: it renders without a skeleton
    await navigateOrder(o1);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    await releaseResponse(); // O1's confirmed detail, while O2 is shown
    await readsSettled();
    const o2Entry = cachedOrderIdAt(o2);
    const o2Cached = cachedLifecycle(USER_A, ORG_A, o2);
    const shownBeforeCancel = await showing(o1, o2);
    const noticeShown = notices();
    // The merchant acts on what this screen shows.
    await tapCancelOrder();
    await waitFor(() => outcomes.length >= 2, "the cancel");
    const [s1, s2] = [await orderState(o1), await orderState(o2)];
    console.log(
      `[evidence] O1→O2 delayed Confirm success, then Cancel: server=[${outcomes}] ` +
        `o2EntryHolds=${nameOf(o2Entry, o1, o2)} o2Cached=${o2Cached} ` +
        `shownAtCancel=${JSON.stringify(shownBeforeCancel)} notice=${JSON.stringify(noticeShown)} ` +
        `cancelTarget=${nameOf(sent[1]?.data.orderId, o1, o2)} persisted O1=${s1.lifecycle} O2=${s2.lifecycle}`,
    );
    expect(o2Entry).toBe(o2);
    expect(o2Cached).toBe("draft");
    expect(shownBeforeCancel).toEqual({ o1: false, o2: true });
    expect(noticeShown).not.toContain(en.order.confirmedNotice);
    expect(sent.map((s) => s.data.orderId)).toEqual([o1, o2]);
    expect(outcomes).toEqual(["ok", "ok"]);
    expectConfirmedBy(s1, USER_A); // O1: confirmed once, by A — never cancelled
    expect(s2.lifecycle).toBe("cancelled");
    expect(writesIntoDetailOf(o2)).toEqual(["cancelled"]); // only its own cancel
  });

  it("O1 → O2, delayed Confirm FAILURE (committed, response lost): nothing of O1's error or detail on O2; back on O1 the committed state is shown", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    await navigateOrder(o2);
    await navigateOrder(o1);
    holdResponseNext.add("lifecycle");
    loseNextResponse.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    const shownBefore = text();
    await releaseResponse(); // "Failed to fetch", while O2 is shown
    await readsSettled();
    const shownAfter = text();
    console.log(
      `[evidence] O1→O2 delayed Confirm failure: server=[${outcomes}] o2Unchanged=${shownAfter === shownBefore} ` +
        `o2Entry=${nameOf(cachedOrderIdAt(o2), o1, o2)} confirmEnabledOnO2=${confirmOrderButton()?.disabled === false}`,
    );
    expect(shownAfter).toBe(shownBefore); // no error banner, no O1 data
    expect(confirmOrderButton()?.disabled).toBe(false);
    expect(cachedOrderIdAt(o2)).toBe(o2);
    expect(cachedLifecycle(USER_A, ORG_A, o2)).toBe("draft");
    expect(writesIntoDetailOf(o2)).toEqual([]);
    expect(await lifecycleOf(o2)).toBe("draft");
    await navigateOrder(o1);
    await waitFor(() => cachedLifecycle(USER_A, ORG_A, o1) === "confirmed", "O1's re-read");
    expectConfirmedBy(await orderState(o1), USER_A);
  });

  it("O1 → O2 → O1, then O1's held success: O1 shows its committed state, O2's entry is untouched", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    await navigateOrder(o2);
    await navigateOrder(o1);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    await navigateOrder(o1);
    await releaseResponse();
    await waitFor(() => cachedLifecycle(USER_A, ORG_A, o1) === "confirmed", "O1 confirmed");
    await readsSettled();
    const shown = await showing(o1, o2);
    console.log(
      `[evidence] O1→O2→O1 late success: O1=${cachedLifecycle(USER_A, ORG_A, o1)} ` +
        `o2Entry=${nameOf(cachedOrderIdAt(o2), o1, o2)} shown=${JSON.stringify(shown)}`,
    );
    expect(cachedOrderIdAt(o1)).toBe(o1);
    expect(cachedOrderIdAt(o2)).toBe(o2);
    expect(cachedLifecycle(USER_A, ORG_A, o2)).toBe("draft");
    expect(writesIntoDetailOf(o2)).toEqual([]);
    expect(shown).toEqual({ o1: true, o2: false });
    expectConfirmedBy(await orderState(o1), USER_A);
    expect(await lifecycleOf(o2)).toBe("draft");
  });

  it("O1 → O2, then a NEWER Confirm on O2 completes before O1's answer: O2 is confirmed and shown as O2; O1's answer is written nowhere", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    await navigateOrder(o2);
    await navigateOrder(o1);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    const o2ConfirmDisabled = confirmOrderButton()?.disabled ?? null;
    console.log(
      `[evidence] O1→O2: O2's Confirm disabled by O1's pending confirm=${o2ConfirmDisabled}`,
    );
    expect(o2ConfirmDisabled).toBe(false); // O1's pending confirm is not O2's
    await tapConfirmOrder(); // O2's own confirm
    await waitFor(() => cachedLifecycle(USER_A, ORG_A, o2) === "confirmed", "O2's confirm");
    await releaseResponse(); // O1's answer, last
    await readsSettled();
    const shown = await showing(o1, o2);
    console.log(
      `[evidence] O1→O2 then a newer O2 confirm: server=[${outcomes}] ` +
        `o2Entry=${nameOf(cachedOrderIdAt(o2), o1, o2)} shown=${JSON.stringify(shown)}`,
    );
    expect(sent.map((s) => s.data.orderId)).toEqual([o1, o2]);
    expect(cachedOrderIdAt(o2)).toBe(o2);
    expect(writesIntoDetailOf(o2)).toEqual(["confirmed"]);
    expect(writesIntoDetailOf(o1)).toEqual([]);
    expect(shown).toEqual({ o1: false, o2: true });
    expectConfirmedBy(await orderState(o1), USER_A);
    expectConfirmedBy(await orderState(o2), USER_A);
  });

  it("O1 → O2, then the screen remounts before O1's answer: nothing is written into either entry", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    await remountAs({});
    await readsSettled();
    await releaseResponse();
    await readsSettled();
    expect(writesIntoDetailOf(o1)).toEqual([]);
    expect(writesIntoDetailOf(o2)).toEqual([]);
    expect(cachedOrderIdAt(o2)).toBe(o2);
    expect(await showing(o1, o2)).toEqual({ o1: false, o2: true });
    expectConfirmedBy(await orderState(o1), USER_A);
  });

  it("O1 → O2, then A's orders.read is revoked in place before O1's answer: the answer restores nothing; O2 is withdrawn", async () => {
    const o1 = await seedDraft();
    const o2 = await seedDraft();
    await openOrderDetail(o1);
    holdResponseNext.add("lifecycle");
    await tapConfirmOrder();
    await committedAsA();
    await navigateOrder(o2);
    grants.get(USER_A)!.delete("orders.read");
    await refreshPermissions();
    await releaseResponse();
    await readsSettled();
    const shown = await showing(o1, o2);
    console.log(
      `[evidence] O1→O2, orders.read revoked, late success: writes O1=[${writesIntoDetailOf(o1)}] ` +
        `O2=[${writesIntoDetailOf(o2)}] shown=${JSON.stringify(shown)}`,
    );
    expect(writesIntoDetailOf(o1)).toEqual([]);
    expect(writesIntoDetailOf(o2)).toEqual([]);
    expect(shown).toEqual({ o1: false, o2: false });
    expect(confirmOrderButton()).toBeUndefined();
  });

  it("O1 → O2, delayed Record payment success: nothing announced, closed or recorded on O2; O1 has its one payment", async () => {
    const o1 = await seedConfirmed();
    const o2 = await seedConfirmed();
    await openOrderDetail(o1);
    await navigateOrder(o2);
    await navigateOrder(o1);
    await typePaymentDraft("5000", "");
    holdResponseNext.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await navigateOrder(o2);
    await releaseResponse();
    await readsSettled();
    const [s1, s2] = [await orderState(o1), await orderState(o2)];
    console.log(
      `[evidence] O1→O2 delayed Record payment: notice=${JSON.stringify(notices())} sheet=${dialog() !== null} ` +
        `O1payments=${s1.payments.length} O2payments=${s2.payments.length}`,
    );
    expect(notices()).not.toContain(paymentNotice);
    expect(dialog()).toBeNull();
    expect(sent.map((s) => s.data.orderId)).toEqual([o1]);
    expect(s1.payments.map((p) => [p.recorded_by, p.amount_minor])).toEqual([[USER_A, 5000]]);
    expect(s2.payments).toEqual([]);
  });

  it("O1 → O2 with an open payment sheet after a lost response: the draft is not on O2; O2 records with its own key; back on O1 the same payment replays ONCE", async () => {
    const o1 = await seedConfirmed();
    const o2 = await seedConfirmed();
    await openOrderDetail(o1);
    await navigateOrder(o2);
    await navigateOrder(o1);
    await typePaymentDraft("5000", "");
    loseNextResponse.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await settle(12);
    await navigateOrder(o2);
    const shownOnO2 = {
      sheet: dialog() !== null,
      amount: [...document.querySelectorAll("input")].some((i) => i.value === "5000"),
    };
    await typePaymentDraft("7000", "");
    await submitPaymentSheet("Record payment on O2");
    await waitFor(() => outcomesOf("payment").length >= 2, "O2's payment");
    await navigateOrder(o1);
    await typePaymentDraft("5000", "");
    await submitPaymentSheet("Retry on O1");
    await waitFor(() => outcomesOf("payment").length >= 3, "O1's retry");
    const keys = paymentKeys();
    const [s1, s2] = [await orderState(o1), await orderState(o2)];
    console.log(
      `[evidence] O1→O2 payment sheet after a lost response: shownOnO2=${JSON.stringify(shownOnO2)} ` +
        `server=[${outcomesOf("payment")}] o2OwnKey=${keys[1] !== keys[0]} o1Replayed=${keys[2] === keys[0]} ` +
        `O1=[${s1.payments.map((p) => p.amount_minor)}] O2=[${s2.payments.map((p) => p.amount_minor)}]`,
    );
    expect(shownOnO2).toEqual({ sheet: false, amount: false });
    expect(sent.filter((s) => s.fn === "payment").map((s) => s.data.orderId)).toEqual([o1, o2, o1]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(outcomesOf("payment")).toEqual(["ok", "ok", "ok"]);
    expect(s1.payments.map((p) => [p.recorded_by, p.amount_minor])).toEqual([[USER_A, 5000]]);
    expect(s2.payments.map((p) => [p.recorded_by, p.amount_minor])).toEqual([[USER_A, 7000]]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — an unresolved payment's retry identity outlives the Order detail screen
// ═══════════════════════════════════════════════════════════════════════════
//
// Reproduced on 79f120a: the identity of a submitted-but-unanswered payment
// lived in Order detail's own refs, so UNMOUNTING the screen (navigate away,
// another member's screen, back) destroyed it. A's re-entry of the same
// payment then went out under a NEW key and the server recorded a second
// pending payment, a second `created` event and a second payments.record
// audit. Every case asserts those three SQL/audit facts, not only client keys.

const nextStepSection = () =>
  [...document.querySelectorAll("section")].find(
    (el) => el.querySelector("h2")?.textContent?.trim() === en.order.next.title,
  ) ?? null;
/** Smart Next Action → Record payment, then the draft typed into the sheet. */
async function typePaymentFromNextStep(amount = PRIVATE_AMOUNT, reference = PRIVATE_REF) {
  await waitFor(
    () => nextStepSection() && button(en.order.next.action.record_payment, nextStepSection()!),
    "Next step: Record payment",
  );
  await click(
    button(en.order.next.action.record_payment, nextStepSection()!),
    "Next step: Record payment",
  );
  await typeInto(document.querySelector("#order-payment-amount"), amount);
  if (reference) await typeInto(document.querySelector("#order-payment-reference"), reference);
}
/** One row per recorded payment, with its own `created` event and payments.record audit. */
async function paymentLedger(orderId: string) {
  const rows = (
    await f.db.query<Json>(
      `select p.id, p.recorded_by, p.amount_minor, p.method, p.reference, p.idempotency_key,
              (select count(*)::int from payment_events e
                where e.payment_id = p.id and e.event_type = 'created') as created_events
         from payments p where p.order_id = $1 order by p.created_at`,
      [orderId],
    )
  ).rows;
  return {
    rows: rows.map((r) => ({
      by: who(r.recorded_by),
      amount: Number(r.amount_minor),
      method: r.method as string,
      reference: (r.reference as string | null) ?? null,
      key: r.idempotency_key as string,
      createdEvents: r.created_events as number,
    })),
    allRecordAudits: audits.filter((a) => a.action === "payments.record").length,
  };
}
function ledgerEvidence(label: string, ledger: Awaited<ReturnType<typeof paymentLedger>>) {
  console.log(
    `[evidence] ${label}: outcomes=[${outcomesOf("payment")}] keys=${JSON.stringify(paymentKeys())} ` +
      `payments=${JSON.stringify(ledger.rows.map((r) => [r.by, r.amount, r.method, r.createdEvents]))} ` +
      `recordAudits=${ledger.allRecordAudits}`,
  );
}
/** Exactly one payment, A's, with one creation event and one creation audit. */
function expectOneLogicalPayment(ledger: Awaited<ReturnType<typeof paymentLedger>>) {
  expect(ledger.rows.map((r) => [r.by, r.amount, r.createdEvents])).toEqual([["A", 12345, 1]]);
  expect(ledger.allRecordAudits).toBe(1);
}

describe("Order detail: an unresolved payment's retry identity survives the screen unmounting", () => {
  beforeEach(() => {
    privateRefSeq += 1;
    PRIVATE_REF = `PRIVATE-BANK-REF-88${String(privateRefSeq).padStart(4, "0")}`;
  });

  it("REPRO: Next step → Record payment, dispatch held, unmount → B mounts (same QueryClient) → A again, original released, then A's retry: one payment, one created event, one audit", async () => {
    const orderId = await seedConfirmed();
    await handOverAtCounter(orderId); // goods with the customer, unpaid: Next step offers Record payment
    await openOrderDetail(orderId);
    await typePaymentFromNextStep();
    holdDispatchNext.add("payment"); // left the screen as A, not yet at the server
    await submitPaymentSheet();
    await remountAs({ user: USER_B });
    await remountAs({ user: USER_A });
    await typePaymentFromNextStep(); // the order still reads unpaid: A re-enters the same payment
    await releaseDispatch(); // A's original lands now, as A
    await submitPaymentSheet("Record payment (A's retry from Next step)");
    await waitFor(() => outcomesOf("payment").length === 2, "A's retry");
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("remount B→A, Next step retry", ledger);
    expect(outcomesOf("payment")).toEqual(["ok", "ok"]);
    expect(new Set(paymentKeys()).size).toBe(1);
    expectOneLogicalPayment(ledger);
  });

  it("CONTROL (no remount): the same sequence with the screen kept mounted records one payment", async () => {
    const orderId = await seedConfirmed();
    await handOverAtCounter(orderId);
    await openOrderDetail(orderId);
    await typePaymentFromNextStep();
    holdDispatchNext.add("payment");
    await submitPaymentSheet();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await typePaymentFromNextStep();
    await releaseDispatch();
    await submitPaymentSheet("Record payment (A's retry, no remount)");
    await waitFor(() => outcomesOf("payment").length === 2, "A's retry");
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("no remount control", ledger);
    expect(new Set(paymentKeys()).size).toBe(1);
    expectOneLogicalPayment(ledger);
  });

  it("payment-section entry, committed with the response LOST (uncertain), unmount → B → A, A's retry: one payment, one created event, one audit", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft(); // the payment section's own Record payment button
    holdResponseNext.add("payment");
    loseNextResponse.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await remountAs({ user: USER_B });
    await releaseResponse(); // A's failure lands while B's screen is mounted
    await remountAs({ user: USER_A });
    await typePaymentDraft();
    await submitPaymentSheet("Record payment (A's retry)");
    await waitFor(() => outcomesOf("payment").length === 2, "A's retry");
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("remount, lost response, payment-section retry", ledger);
    expect(outcomesOf("payment")).toEqual(["ok", "ok"]);
    expect(new Set(paymentKeys()).size).toBe(1);
    expectOneLogicalPayment(ledger);
  });

  it("A's original SUCCESS lands while B's screen is mounted: nothing reaches B, the identity is retired, and A's next identical payment is a new one", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await remountAs({ user: USER_B });
    await readsSettled();
    const shownToB = text();
    await releaseResponse();
    await readsSettled();
    expect(dialog()).toBeNull();
    expect(notices()).not.toContain(paymentNotice);
    expect(text()).toBe(shownToB);
    await remountAs({ user: USER_A });
    expectOneLogicalPayment(await paymentLedger(orderId));
    // Known outcome: a second identical payment is a legitimate new payment.
    await typePaymentDraft(PRIVATE_AMOUNT, `${PRIVATE_REF}-2`);
    await submitPaymentSheet("a legitimate second payment");
    await waitFor(() => outcomesOf("payment").length === 2, "the second payment");
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("late success under B, then a new payment", ledger);
    expect(new Set(paymentKeys()).size).toBe(2);
    expect(ledger.rows.map((r) => [r.by, r.amount, r.createdEvents])).toEqual([
      ["A", 12345, 1],
      ["A", 12345, 1],
    ]);
    expect(ledger.allRecordAudits).toBe(2);
  });

  it("the original success is known BEFORE A re-enters it (A's screen mounted): the identical entry is a new payment, never a silent replay", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    await submitPaymentSheet();
    await waitFor(() => notices().includes(paymentNotice), "the recorded notice");
    await remountAs({ user: USER_B });
    await remountAs({ user: USER_A });
    await typePaymentDraft(); // same amount, same reference
    await submitPaymentSheet("the identical second payment");
    await waitFor(() => outcomesOf("payment").length === 2, "the second payment");
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("success known, identical entry", ledger);
    expect(new Set(paymentKeys()).size).toBe(2);
    expect(ledger.rows).toHaveLength(2);
  });

  const changes = [
    { label: "amount", amount: "12346", reference: () => PRIVATE_REF, method: null },
    {
      label: "reference",
      amount: PRIVATE_AMOUNT,
      reference: () => `${PRIVATE_REF}-X`,
      method: null,
    },
    { label: "method", amount: PRIVATE_AMOUNT, reference: () => PRIVATE_REF, method: "khqr" },
  ] as const;
  for (const change of changes) {
    it(`a CHANGED ${change.label} after the remount never reuses the unresolved identity; the original's own retry still replays it`, async () => {
      const orderId = await seedConfirmed();
      await openOrderDetail(orderId);
      await typePaymentDraft();
      holdResponseNext.add("payment");
      loseNextResponse.add("payment");
      await submitPaymentSheet();
      await paymentCommittedAsA();
      await releaseResponse();
      await remountAs({ user: USER_B });
      await remountAs({ user: USER_A });
      await typePaymentDraft(change.amount, change.reference());
      if (change.method) await click(button(en.pos.method[change.method], dialog()!), "method");
      await submitPaymentSheet(`changed ${change.label}`);
      await waitFor(() => outcomesOf("payment").length === 2, "the changed payment");
      expect(outcomesOf("payment")).toEqual(["ok", "ok"]); // not a key-conflict refusal
      const [original, changed] = paymentKeys();
      expect(changed).not.toBe(original);
      await waitFor(() => dialog() === null, "the changed payment's sheet to close");
      // The original logical payment is still unresolved: its retry replays it.
      await typePaymentDraft();
      await submitPaymentSheet("the original's retry");
      await waitFor(() => outcomesOf("payment").length === 3, "the original's retry");
      expect(paymentKeys()[2]).toBe(original);
      const ledger = await paymentLedger(orderId);
      ledgerEvidence(`changed ${change.label}`, ledger);
      expect(ledger.rows).toHaveLength(2);
      expect(ledger.rows.every((r) => r.by === "A" && r.createdEvents === 1)).toBe(true);
      expect(ledger.allRecordAudits).toBe(2);
    });
  }

  it("two unresolved payments at once: each one's retry after the remount replays its own identity", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    for (const amount of ["12345", "700"]) {
      await typePaymentDraft(amount, amount === "700" ? "" : PRIVATE_REF);
      holdResponseNext.add("payment");
      loseNextResponse.add("payment");
      await submitPaymentSheet(`unresolved ${amount}`);
      await waitFor(() => heldResponses.length === (amount === "700" ? 2 : 1), `held ${amount}`);
      await releaseResponse(amount === "700" ? 1 : 0);
      await remountAs({ user: USER_A }); // the failed sheet goes with the screen
    }
    await remountAs({ user: USER_B });
    await remountAs({ user: USER_A });
    await typePaymentDraft("700", "");
    await submitPaymentSheet("retry 700");
    await waitFor(() => outcomesOf("payment").length === 3, "retry 700");
    await waitFor(() => dialog() === null, "sheet closed");
    await typePaymentDraft("12345", PRIVATE_REF);
    await submitPaymentSheet("retry 12345");
    await waitFor(() => outcomesOf("payment").length === 4, "retry 12345");
    const keys = paymentKeys();
    expect(keys[2]).toBe(keys[1]);
    expect(keys[3]).toBe(keys[0]);
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("two unresolved", ledger);
    expect(ledger.rows.map((r) => [r.amount, r.createdEvents])).toEqual([
      [12345, 1],
      [700, 1],
    ]);
    expect(ledger.allRecordAudits).toBe(2);
  });

  it("isolation: after A's unresolved payment, member B entering the identical payment on the same order gets B's own identity and B's own payment; A's retry still replays A's", async () => {
    const orderId = await seedConfirmed();
    await openOrderDetail(orderId);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    loseNextResponse.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await releaseResponse();
    await remountAs({ user: USER_B });
    await typePaymentDraft(); // B types the very same amount and reference
    await submitPaymentSheet("B's own payment");
    await waitFor(() => outcomesOf("payment").length === 2, "B's payment");
    await remountAs({ user: USER_A });
    await typePaymentDraft();
    await submitPaymentSheet("A's retry");
    await waitFor(() => outcomesOf("payment").length === 3, "A's retry");
    const keys = paymentKeys();
    expect(keys[1]).not.toBe(keys[0]); // B never received A's identity
    expect(keys[2]).toBe(keys[0]); // A's retry replays A's
    const ledger = await paymentLedger(orderId);
    ledgerEvidence("member isolation", ledger);
    expect(ledger.rows.map((r) => [r.by, r.createdEvents])).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
    expect(ledger.allRecordAudits).toBe(2);
  });

  it("isolation: A's unresolved payment on O1 is not O2's — the identical entry on O2 is O2's own payment; back on O1 the retry replays O1's", async () => {
    const o1 = await seedConfirmed();
    const o2 = await seedConfirmed();
    await openOrderDetail(o1);
    await typePaymentDraft();
    holdResponseNext.add("payment");
    loseNextResponse.add("payment");
    await submitPaymentSheet();
    await paymentCommittedAsA();
    await releaseResponse();
    await act(async () => root!.unmount());
    routeParams.id = o2;
    root = createRoot(container!);
    await rerender();
    await typePaymentDraft(); // identical amount and reference, on O2
    await submitPaymentSheet("O2's own payment");
    await waitFor(() => outcomesOf("payment").length === 2, "O2's payment");
    await act(async () => root!.unmount());
    routeParams.id = o1;
    root = createRoot(container!);
    await rerender();
    await typePaymentDraft();
    await submitPaymentSheet("O1's retry");
    await waitFor(() => outcomesOf("payment").length === 3, "O1's retry");
    const keys = paymentKeys();
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    const l1 = await paymentLedger(o1);
    const l2 = await paymentLedger(o2);
    ledgerEvidence("order isolation O1", l1);
    expect(l1.rows.map((r) => [r.by, r.amount, r.createdEvents])).toEqual([["A", 12345, 1]]);
    expect(l2.rows.map((r) => [r.by, r.amount, r.createdEvents])).toEqual([["A", 12345, 1]]);
    expect(l1.allRecordAudits).toBe(2); // one creation audit per order's one payment
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mobile: the refusal reason and the Next step action are where the merchant is
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured on the actual route in Chromium (320-430px, km and en): a custody
// refusal tapped from the always-visible sticky Cancel while scrolled down
// rendered its reason 700-1350px above the viewport; and at 320×568 / 360×640
// the Next step action sat under the sticky bar's glass at first paint, below
// the four-step workflow. happy-dom has no layout, so these pin the mechanism:
// the reason is scrolled into view, and the action precedes the workflow.

describe("Order detail: the refusal reason and the Next step action are on screen", () => {
  it("a custody refusal brings its reason into view", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const orderId = await seedConfirmed();
      await openOrderDetail(orderId);
      await waitFor(() => button(en.order.cancel), "Cancel order");
      await handOverAtCounter(orderId);
      await tapCancelOrder();
      await waitFor(
        () => text().includes(en.order.error.cancelBlocked.goods_with_customer),
        "the refusal reason",
      );
      expect(
        scrolled.some((t) => t.includes(en.order.error.cancelBlocked.goods_with_customer)),
      ).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("the Next step action comes before the four-step workflow", async () => {
    const orderId = await seedConfirmed();
    await handOverAtCounter(orderId); // unpaid, with the customer: Record payment is the action
    await openOrderDetail(orderId);
    await waitFor(
      () => nextStepSection() && button(en.order.next.action.record_payment, nextStepSection()!),
      "Next step: Record payment",
    );
    const section = nextStepSection()!;
    const action = button(en.order.next.action.record_payment, section)!;
    const workflow = section.querySelector(`ol[aria-label="${en.order.next.workflow}"]`)!;
    expect(workflow).not.toBeNull();
    expect(
      action.compareDocumentPosition(workflow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
