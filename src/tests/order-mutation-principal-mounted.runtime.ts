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
// The capability snapshot the server derives for the session's CURRENT principal.
mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => {
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
async function mount(which: Screen) {
  screen = which;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    // A refused attempt leaves A's sheet open with the key it was opened with.
    const sheetStillOpen = Boolean(dialog());
    if (sheetStillOpen) {
      // B's screen in between remounted the sheet (Order detail shows its
      // skeleton while B's read loads), so A types the amount again.
      const amount = document.querySelector("#order-payment-amount") as HTMLInputElement;
      if (!amount.value) await typeInto(amount, "10000");
      await click(button(en.order.recordPaymentSheet.submit, dialog()!), "Record payment (retry)");
      await settle(10);
    }
    const after = await orderState(orderId);
    evidence("order detail: payment, A's retry", after);

    expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(sheetStillOpen).toBe(true);
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
