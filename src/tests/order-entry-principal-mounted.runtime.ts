/**
 * Orders → New Order and Inbox → Prepare Order run as the principal that
 * started them — or not at all. MOUNTED, through REAL SQL.
 *
 * Mounts the REAL <CreateRealOrderSheet> (as the Orders list mounts it: not
 * keyed by principal, so it stays mounted across a switch) and the REAL
 * conversation route (src/routes/app.inbox.$id.tsx → <PrepareOrderSheet>,
 * keyed by member + organization + conversation). Both reach the database
 * through the real createRealOrder / confirmRealOrder adapters → the same
 * service calls the server-function handlers make → PGlite with EVERY
 * migration. Only the transport (server-fn boundary, Supabase admin client),
 * the Inbox's conversation/customer reads, New Order's customer-picker reads
 * and the router hooks are replaced — each read answering, like the server,
 * for the principal the server derives.
 *
 * Two principals are modelled, because they can disagree:
 *
 *   route   what THIS tab's /app route context says is signed in — the
 *           principal the sheet was opened as and starts its attempt as;
 *   server  what the server derives when it HANDLES a request: the session
 *           cookie's member and that member's active organization at that
 *           moment. Shared by every tab of the browser, so another tab
 *           signing in or switching organization moves it while this tab's
 *           route still says the old principal.
 *
 * Between the tap and the server there is a window — createRealOrder lazily
 * imports the server-function module, then the request travels — modelled by
 * a dispatch gate placed BEFORE the server derives its principal. A switch
 * inside it (or a switch in another tab, any time) used to execute member A's
 * order as member B under A's replay key, or send organization A's customer
 * and variant into organization B. Every case asserts the persisted orders,
 * their creator, organization and customer, stock movements, payments, rate
 * limit buckets and audit rows — not only what the browser sent.
 *
 * Run through src/tests/order-entry-principal-mounted.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();
/** Organization A sells in riel. */
const ORG_A = "cccccccc-0000-4000-8000-0000000000a1";
await f.db.query(
  `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
   values($1,'Riel shop','Riel shop','principal-riel-shop',$2,'KHR')`,
  [ORG_A, f.actor],
);
/** Organization B — the fixture's own — sells in dollars. */
const ORG_B = f.org;
const USER_A = f.actor;
/** A second member, for a member switch. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000b9";
await f.db.query("insert into auth.users(id,email) values($1,'member-2@test.invalid')", [USER_B]);

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
await seedProduct(ORG_B, "Serum", 2000, "USD"); // $20.00

async function seedCustomer(org: string, name: string) {
  const customer = crypto.randomUUID();
  await f.db.query(
    `insert into customers(id,organization_id,display_name,primary_phone) values($1,$2,$3,$4)`,
    [customer, org, name, "012345678"],
  );
  return customer;
}
const CUST_A = await seedCustomer(ORG_A, "Sokha"); // organization A's customer
const CUST_B = await seedCustomer(ORG_B, "Dara"); // organization B's customer
const CUSTOMER_NAMES: Record<string, string> = { [CUST_A]: "Sokha", [CUST_B]: "Dara" };
const CUSTOMER_ORG: Record<string, string> = { [CUST_A]: ORG_A, [CUST_B]: ORG_B };

// ── Principals ───────────────────────────────────────────────────────────────

/** What this tab's /app route context says (the sheet's own principal). */
const route = { userId: USER_A, organizationId: ORG_A };
/** What the server derives when it HANDLES a request — shared by every tab. */
const server = { userId: USER_A, organizationId: ORG_A };
const SERVER_PERMISSIONS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.apply_discount",
  "customers.read",
];
/** `${userId}:${permission}` grants revoked server-side (a role change landing mid-request). */
const revoked = new Set<string>();

function serverContext(): AuthorizationContext {
  const { userId, organizationId } = server;
  const granted = (key: string) =>
    SERVER_PERMISSIONS.includes(key) && !revoked.has(`${userId}:${key}`);
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

// ── Supabase admin client → PGlite ───────────────────────────────────────────

/** Audit rows the services wrote (the admin client's audit_logs inserts). */
const audits: unknown[] = [];

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
          insert: async (row: unknown) => {
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

// ── Server functions = the same service calls their handlers make ───────────

interface SentCreate {
  /** Exactly what the browser sent. */
  data: Json;
  /** The principal the server derived when it HANDLED the request. */
  server: { userId: string; organizationId: string };
}
const sent: SentCreate[] = [];
/** The server's answer to each create, in order: "ok" or "refused:<code>". */
const outcomes: string[] = [];
/** The next create commits server-side, then its response is lost. */
let loseNextResponse = false;
/**
 * The next create has left the sheet but has NOT reached the server yet — the
 * lazily imported server-function module and the transport are still pending
 * — until releaseDispatch(). The server derives its principal only after.
 */
let holdDispatchNext = false;
const dispatchGates: (() => void)[] = [];
const confirms: string[] = [];

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    if (holdDispatchNext) {
      holdDispatchNext = false;
      await new Promise<void>((go) => dispatchGates.push(go));
    }
    const ctx = serverContext(); // derived when the server HANDLES it, as resolveAuthContext() does
    const index =
      sent.push({
        data: JSON.parse(JSON.stringify(data)),
        server: { userId: ctx.userId, organizationId: ctx.organizationId },
      }) - 1;
    const lose = loseNextResponse;
    loseNextResponse = false;
    let outcome: { detail: unknown } | { error: unknown };
    try {
      const { createOrder } = await import("@/server/orders/service");
      // src/api/orders.ts createOrderFn's handler, field for field.
      const detail = await createOrder(ctx, {
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
        ...(data.expectedPrincipal ? { expectedPrincipal: data.expectedPrincipal } : {}),
      });
      outcome = { detail };
      outcomes[index] = "ok";
    } catch (error) {
      outcome = { error };
      outcomes[index] = `refused:${(error as Json).code ?? (error as Json).statusCode ?? "error"}`;
    }
    if (lose) throw new TypeError("Failed to fetch");
    if ("error" in outcome) throw outcome.error;
    return outcome.detail;
  },
  transitionOrderLifecycleFn: async ({ data }: { data: Json }) => {
    confirms.push(data.orderId);
    const { transitionLifecycleStatus } = await import("@/server/orders/service");
    return transitionLifecycleStatus(serverContext(), data.orderId, data.to, data.reason ?? null);
  },
}));
mock.module("@/api/products", () => ({
  listProductsFn: async ({ data }: { data?: Json } = {}) => {
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(serverContext(), { status: data?.status } as any);
  },
  lookupByBarcodeFn: async () => null,
}));

// ── Inbox / customer reads: answered as the server would, for ITS principal ──

/** Conversation id → its organization and customer. */
const conversations = new Map<string, { org: string; customerId: string }>();
const notFound = (what: string) =>
  Object.assign(new Error(`${what} not found`), { statusCode: 404 });

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getConversation: async (cid: string) => {
    const c = conversations.get(cid);
    if (!c || c.org !== server.organizationId) throw notFound("Conversation");
    return {
      id: cid,
      customerId: c.customerId,
      customerName: CUSTOMER_NAMES[c.customerId],
      channel: "facebook",
      status: "needs_reply",
      messages: [],
      nextBeforeId: null,
      readThroughMessageId: null,
    };
  },
  getCustomer: async (customerId: string) => {
    if (CUSTOMER_ORG[customerId] !== server.organizationId) throw notFound("Customer");
    const name = CUSTOMER_NAMES[customerId]!;
    return {
      id: customerId,
      nameKm: name,
      nameEn: name,
      phone: null,
      identities: [],
      tags: [],
      orderCount: 0,
      lifetimeSpend: { amount: 0, currency: "USD" },
      companion: "minto",
    };
  },
  getRecentProducts: async () => [],
  markRealConversationRead: async () => {},
  getOlderConversationMessages: async () => ({ messages: [], nextBeforeId: null }),
  getMostRecentRealOrderForCustomer: async () => null,
  // New Order's customer picker: the server's organization's customers only.
  listRealCustomers: async () =>
    Object.keys(CUSTOMER_ORG)
      .filter((cid) => CUSTOMER_ORG[cid] === server.organizationId)
      .map((cid) => ({
        id: cid,
        nameKm: CUSTOMER_NAMES[cid]!,
        nameEn: CUSTOMER_NAMES[cid]!,
        phone: null,
        sensitiveVisible: false,
      })),
  searchRealCustomers: async () => ({
    customers: [],
    hasMore: false,
    truncated: false,
    phoneSearchDenied: false,
  }),
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
  Link: ({ children, to: _to, ...rest }: any) => createElement("a", rest, children),
  useNavigate: () => () => {},
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app/inbox" } };
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
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const { CreateRealOrderSheet } = await import("@/components/orders/CreateRealOrderSheet");
const { Route } = await import("@/routes/app.inbox.$id");
const ConversationScreen = (Route as any).component as () => React.ReactElement;

const UI_PERMISSIONS = [
  "orders.create",
  "orders.confirm",
  "orders.apply_discount",
  "customers.read",
  "messages.reply",
] as const;

let screen: "orders" | "inbox" = "orders";
/** The New Order sheet's parent state (the Orders list). */
let sheet = { open: true, created: [] as Json[] };
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

function tree() {
  const child =
    screen === "orders"
      ? React.createElement(CreateRealOrderSheet, {
          open: sheet.open,
          onOpenChange: (next: boolean) => {
            sheet.open = next;
          },
          onCreated: (order: Json) => sheet.created.push(order),
          userId: route.userId,
          organizationId: route.organizationId,
        })
      : React.createElement(ConversationScreen);
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(CapabilityFixtureProvider, { permissions: UI_PERMISSIONS } as any, child),
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
  await settle(10);
}
async function mount(which: "orders" | "inbox") {
  screen = which;
  sheet = { open: true, created: [] };
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
/**
 * ANOTHER tab signs in as someone else, or switches the active organization:
 * the server's derivation moves; this tab's route context does not.
 */
function otherTab(next: { user?: string; org?: string }) {
  if (next.user) server.userId = next.user;
  if (next.org) server.organizationId = next.org;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
/** Orders that existed before the current case (the ledgers are append-only). */
let baseline: string[] = [];
beforeEach(async () => {
  baseline = (await f.db.query<Json>("select id from orders")).rows.map((r) => r.id);
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
  confirms.length = 0;
  audits.length = 0;
  loseNextResponse = false;
  holdDispatchNext = false;
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  revoked.clear();
  route.userId = server.userId = USER_A;
  route.organizationId = server.organizationId = ORG_A;
});
afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement | null;
async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
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
async function releaseDispatch(index = 0) {
  for (let i = 0; i < 200 && !dispatchGates[index]; i++) await settle(1);
  if (!dispatchGates[index]) throw new Error(`request ${index} was never dispatched`);
  await act(async () => dispatchGates[index]!());
  await settle(10);
}
const createdText = (code: string) => en.createOrder.created.replace("{{code}}", code);
/** "Order <code> created", as New Order's confirmation prints it — or null. */
function newOrderBanner(): string | null {
  const pattern = new RegExp(en.orderCreate.created.replace("{{code}}", "(\\S+)"));
  return pattern.exec(text())?.[0] ?? null;
}

// Orders → New Order.

/** Water × 2 for organization A's customer Sokha: ៛10,000. */
async function buildWaterForSokha() {
  const d = dialog()!;
  const product = [...d.querySelectorAll("button")].find((b) =>
    ["Water", "Water-km"].includes(b.querySelector("span span")?.textContent?.trim() ?? ""),
  );
  await click(product, "product Water");
  await click(button(en.common.increase, dialog()!), "quantity +");
  let row: HTMLButtonElement | undefined;
  for (let i = 0; i < 40 && !row; i++) {
    row = [...dialog()!.querySelectorAll("ul button")].find((b) =>
      b.textContent?.includes("Sokha"),
    ) as HTMLButtonElement | undefined;
    if (!row) await settle(2);
  }
  await click(row, "customer Sokha");
  expect(dialog()!.textContent).toContain("៛10,000");
}
/** Serum × 1, no customer: $20.00. */
async function buildSerum() {
  const product = [...dialog()!.querySelectorAll("button")].find((b) =>
    ["Serum", "Serum-km"].includes(b.querySelector("span span")?.textContent?.trim() ?? ""),
  );
  await click(product, "product Serum");
  expect(dialog()!.textContent).toContain("$20.00");
}
async function submitNewOrder() {
  const control = button(en.orderCreate.submit);
  expect(control?.disabled).toBe(false);
  await click(control, "Create order");
  await settle(10);
}

// Inbox → Prepare Order.

/**
 * A conversation of its own per case: the Inbox replay registry is
 * page-lifetime by design (scoped member + organization + conversation), so
 * cases must not share one scope.
 */
function openConversation(org = ORG_A, customerId = CUST_A) {
  const cid = crypto.randomUUID();
  conversations.set(cid, { org, customerId });
  routeParams.id = cid;
  return cid;
}
/** Conversation actions → Create order → Water × 2: ៛10,000 for this conversation's customer. */
async function prepareWaterOrder() {
  await click(button(en.conversation.actions.title), "conversation actions");
  await click(buttonContaining(en.conversation.createOrder), "Create order row");
  await click(buttonContaining("Water", dialog()!), "pick Water");
  await click(button(en.common.increase, dialog()!), "quantity +");
  expect(dialog()!.textContent).toContain("៛10,000");
}
async function submitDraft() {
  const control = button(en.conversation.prepareOrder.createDraft);
  expect(control?.disabled).toBe(false);
  await click(control, "Create Draft Order");
  await settle(10);
}

// ── Persisted figures: the authoritative check ───────────────────────────────

interface Persisted {
  orders: Json[];
  /** Stock movements written for this case's orders. */
  movements: Json[];
  payments: Json[];
}
async function persisted(): Promise<Persisted> {
  const orders = (
    await f.db.query<Json>(
      `select id, order_number, organization_id, created_by, customer_id, source, lifecycle_status,
              currency, subtotal_minor, total_minor, source_conversation_ref, idempotency_key
         from orders
        where not (id = any($1::uuid[]))
        order by created_at, order_number`,
      [baseline],
    )
  ).rows;
  const ids = orders.map((o) => o.id);
  const movements = (
    await f.db.query<Json>(
      `select m.organization_id, m.variant_id, m.quantity_delta, m.movement_type, oi.order_id
         from inventory_movements m
         join order_items oi on m.reference_type = 'order_item' and oi.id = m.reference_id
        where oi.order_id = any($1::uuid[])`,
      [ids],
    )
  ).rows;
  const payments = (
    await f.db.query<Json>(`select id from payments where order_id = any($1::uuid[])`, [ids])
  ).rows;
  return { orders, movements, payments };
}

/** Everything a create can write, for an exact before/after comparison. */
async function writeSurface() {
  const q = async (sql: string) => JSON.stringify((await f.db.query(sql)).rows);
  return {
    orders: await q("select id from orders order by id"),
    items: await q("select id from order_items order by id"),
    movements: await q("select id from inventory_movements order by id"),
    payments: await q("select id from payments order by id"),
    rateLimits: await q("select * from rate_limit_buckets order by 1"),
    audits: audits.length,
  };
}

const who = (id: string) => (id === USER_A ? "A" : id === USER_B ? "B" : "?");
const where = (id: string) => (id === ORG_A ? "A" : id === ORG_B ? "B" : "?");
type Surface = Awaited<ReturnType<typeof writeSurface>>;
/** The tables (and audit rows) that changed between two surfaces. */
function wroteSince(before: Surface, after: Surface): string[] {
  return (Object.keys(before) as (keyof Surface)[]).filter((k) => before[k] !== after[k]);
}
/** One line of evidence per stage (printed by the wrapper only on failure). */
function evidence(label: string, p: Persisted, wrote?: string[]) {
  console.log(
    `[evidence] ${label}: requests=${sent.length} ` +
      `uniqueKeys=${new Set(sent.map((s) => s.data.idempotencyKey)).size} ` +
      `server=[${outcomes.join(",")}] orders=${p.orders.length} ` +
      `[${p.orders.map((o) => `${o.lifecycle_status}:by-${who(o.created_by)}:in-${where(o.organization_id)}`).join(",")}] ` +
      `movements=${p.movements.length} payments=${p.payments.length}` +
      (wrote ? ` refusalWrote=[${wrote.join(",")}]` : ""),
  );
}

/** Exactly one order, created by `user` in `org`, for `customer` — and nothing else written. */
function expectOneOrder(
  p: Persisted,
  want: {
    user: string;
    org: string;
    customer: string | null;
    currency: "KHR" | "USD";
    total: number;
    lifecycle?: "draft" | "confirmed";
  },
) {
  expect(p.orders).toHaveLength(1);
  expect(p.orders[0]).toMatchObject({
    created_by: want.user,
    organization_id: want.org,
    customer_id: want.customer,
    currency: want.currency,
    subtotal_minor: want.total,
    total_minor: want.total,
    lifecycle_status: want.lifecycle ?? "draft",
  });
  // The key the attempt was started with — every request of it carried it.
  expect(new Set(sent.map((s) => s.data.idempotencyKey))).toEqual(
    new Set([p.orders[0]!.idempotency_key]),
  );
  // No payment is ever taken by order creation.
  expect(p.payments).toHaveLength(0);
}

/** The order every case in organization A should end with: Water × 2 for Sokha, by A, ៛10,000. */
const WATER_BY_A = {
  user: USER_A,
  org: ORG_A,
  customer: CUST_A,
  currency: "KHR",
  total: 10000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Orders → New Order
// ═══════════════════════════════════════════════════════════════════════════

describe("Orders → New Order runs as the principal that started it", () => {
  it("member A → B (this tab) while the create is being dispatched: never executes as B; A's retry is one order, created by A", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder(); // left the sheet as A, not yet at the server
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch(); // handled while the session is member B's
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("orders: member A→B while dispatching", during, wroteSince(before, refusedSurface));
    const bShown = newOrderBanner();

    await switchTo({ user: USER_A });
    await buildWaterForSokha();
    await submitNewOrder();
    const p = await persisted();
    evidence("orders: member A→B, A's retry", p);

    expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A }); // what the server derived
    expect(outcomes[0]).toBe("refused:principal_changed");
    // Refused before anything: no order, line, movement, payment, audit row or
    // rate-limit token — exactly the database it found.
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    expect(bShown).toBeNull(); // B's session never shows A's order
    expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });

    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expect(newOrderBanner()).not.toBeNull();
    expectOneOrder(p, WATER_BY_A);
    expect(p.movements).toHaveLength(0); // a draft consumes no stock
  });

  it("organization A → B (this tab) while dispatching: A's customer and variant never reach B — no token spent there; A's retry is one order in A", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder();
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("orders: org A→B while dispatching", during, wroteSince(before, refusedSurface));

    await switchTo({ org: ORG_A });
    await buildWaterForSokha();
    await submitNewOrder();
    const p = await persisted();
    evidence("orders: org A→B, A's retry", p);

    expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_B });
    // Refused as what it is — not as "customer not found" in an organization
    // it was never meant for.
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);

    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expectOneOrder(p, WATER_BY_A);
  });

  it("another tab signs in as member B: this tab's create is refused (never silently B's); A's retry once A is back is one order by A", async () => {
    await mount("orders");
    await buildWaterForSokha();
    otherTab({ user: USER_B }); // this tab still shows A
    const before = await writeSurface();
    await submitNewOrder();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("orders: other tab signed in as B", during, wroteSince(before, refusedSurface));
    const shownAfterRefusal = newOrderBanner();
    const errorShown = text().includes(en.orderCreate.error.title);

    otherTab({ user: USER_A }); // the session is A's again
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("orders: other tab, A's retry", p);

    expect(sent[0]!.server.userId).toBe(USER_B);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    // Not "created": the merchant is told it did not go through.
    expect(shownAfterRefusal).toBeNull();
    expect(errorShown).toBe(true);

    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expect(newOrderBanner()).not.toBeNull();
    expect(sheet.created).toHaveLength(1);
    expectOneOrder(p, WATER_BY_A);
  });

  it("another tab switches the active organization to B: refused with zero writes in either organization; the retry in A is one order", async () => {
    await mount("orders");
    await buildWaterForSokha();
    otherTab({ org: ORG_B });
    const before = await writeSurface();
    await submitNewOrder();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence(
      "orders: other tab switched to organization B",
      during,
      wroteSince(before, refusedSurface),
    );

    otherTab({ org: ORG_A });
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("orders: other tab org, retry in A", p);

    expect(sent[0]!.server.organizationId).toBe(ORG_B);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    expect(outcomes[1]).toBe("ok");
    expectOneOrder(p, WATER_BY_A);
  });

  it("USD: member A → B while dispatching in the dollar organization; A's retry persists exactly $20.00 (2,000 cents)", async () => {
    route.organizationId = server.organizationId = ORG_B; // opened in the dollar organization
    await mount("orders");
    await buildSerum();
    holdDispatchNext = true;
    await submitNewOrder();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const refusedSurface = await writeSurface();
    evidence(
      "orders USD: member A→B while dispatching",
      await persisted(),
      wroteSince(before, refusedSurface),
    );

    await switchTo({ user: USER_A });
    await buildSerum();
    await submitNewOrder();
    const p = await persisted();
    evidence("orders USD: A's retry", p);

    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(outcomes[1]).toBe("ok");
    expectOneOrder(p, { user: USER_A, org: ORG_B, customer: null, currency: "USD", total: 2000 });
  });

  it("rapid A → B → A while dispatching: lands as A (its own principal), is never shown by the reset session, and A's rebuild is replayed — one order", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseDispatch(); // late completion, as A

    expect(sent[0]!.server.userId).toBe(USER_A);
    expect(outcomes[0]).toBe("ok");
    expect(newOrderBanner()).toBeNull(); // that session ended on the first switch
    expect(sheet.created).toHaveLength(0);

    await buildWaterForSokha();
    await submitNewOrder();
    const p = await persisted();
    evidence("orders: rapid A→B→A, rebuild", p);
    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(newOrderBanner()).not.toBeNull();
    expectOneOrder(p, WATER_BY_A);
  });

  it("refused under B, then a lost response as A, then a retry: one order, created by A", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder();
    await switchTo({ user: USER_B });
    await releaseDispatch();

    await switchTo({ user: USER_A });
    await buildWaterForSokha();
    loseNextResponse = true;
    await submitNewOrder(); // committed as A, response lost
    const lostErrorShown = text().includes(en.orderCreate.error.title);
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("orders: refused, lost, retried", p);

    expect(outcomes).toEqual(["refused:principal_changed", "ok", "ok"]);
    expect(lostErrorShown).toBe(true);
    expect(newOrderBanner()).not.toBeNull();
    expectOneOrder(p, WATER_BY_A);
  });

  it("a dispatch that completes late, after A's rebuild already created the order, is a replay — not a second order", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder(); // 0: held before the server
    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await buildWaterForSokha();
    await submitNewOrder(); // 1: same key, reaches the server first, accepted
    expect(newOrderBanner()).not.toBeNull();
    await releaseDispatch(); // 0 arrives — as A, same key, same request
    const p = await persisted();
    evidence("orders: late dispatch after completed rebuild", p);
    expect(outcomes).toEqual(["ok", "ok"]);
    expect(sheet.created).toHaveLength(1);
    expectOneOrder(p, WATER_BY_A);
  });

  it("permission revoked while dispatching (same principal): refused as a permission failure, zero writes", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder();
    revoked.add(`${USER_A}:orders.create`);
    const before = await writeSurface();
    await releaseDispatch();
    evidence("orders: permission revoked", await persisted());
    expect(outcomes[0]).toBe("refused:403");
    expect(await writeSurface()).toEqual(before);
    expect(text()).toContain(en.orderCreate.permission.title);
    expect(sheet.created).toHaveLength(0);
  });

  it("a principal switch is refused as principal_changed even when the new member could not create orders at all — that check runs first", async () => {
    await mount("orders");
    await buildWaterForSokha();
    holdDispatchNext = true;
    await submitNewOrder();
    revoked.add(`${USER_B}:orders.create`);
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(await writeSurface()).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inbox → Prepare Order (the real conversation route)
// ═══════════════════════════════════════════════════════════════════════════

describe("Inbox → Prepare Order runs as the principal that started it", () => {
  it("member A → B (this tab) while dispatching: never executes as B; A's retry is one draft by A for this conversation's customer — confirmed, one movement", async () => {
    const cid = openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("inbox: member A→B while dispatching", during, wroteSince(before, refusedSurface));

    await switchTo({ user: USER_A });
    await prepareWaterOrder();
    await submitDraft();
    const draftShown = dialog()?.textContent ?? "";
    await click(button(en.conversation.prepareOrder.confirmOrder, dialog()!), "Confirm order");
    await settle(10);
    const p = await persisted();
    evidence("inbox: member A→B, A's retry + confirm", p);

    expect(sent[0]!.server).toEqual({ userId: USER_B, organizationId: ORG_A });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    expect(sent[0]!.data.expectedPrincipal).toEqual({ userId: USER_A, organizationId: ORG_A });

    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expect(draftShown).toContain(createdText(p.orders[0]?.order_number ?? "?"));
    expect(text()).toContain(en.conversation.prepareOrder.confirmed);
    expectOneOrder(p, {
      user: USER_A,
      org: ORG_A,
      customer: CUST_A,
      currency: "KHR",
      total: 10000,
      lifecycle: "confirmed",
    });
    expect(p.orders[0]).toMatchObject({ source: "FACEBOOK", source_conversation_ref: cid });
    // Stock left once — one sale movement of −2 for the one line.
    expect(p.movements).toHaveLength(1);
    expect(p.movements[0]).toMatchObject({
      organization_id: ORG_A,
      variant_id: WATER.variant,
      movement_type: "sale",
      quantity_delta: -2,
    });
  });

  it("organization A → B (this tab) while dispatching: A's customer is never sent into B — no token spent there; A's retry is one draft in A", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft();
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("inbox: org A→B while dispatching", during, wroteSince(before, refusedSurface));

    await switchTo({ org: ORG_A });
    await prepareWaterOrder();
    await submitDraft();
    const p = await persisted();
    evidence("inbox: org A→B, A's retry", p);

    expect(sent[0]!.server).toEqual({ userId: USER_A, organizationId: ORG_B });
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expectOneOrder(p, WATER_BY_A);
  });

  it("another tab signs in as member B: the draft is refused, the conversation records no order; A's retry is one draft by A", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    otherTab({ user: USER_B });
    const before = await writeSurface();
    await submitDraft();
    const refusedSurface = await writeSurface();
    const during = await persisted();
    evidence("inbox: other tab signed in as B", during, wroteSince(before, refusedSurface));
    const refusalPage = text();

    otherTab({ user: USER_A });
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("inbox: other tab, A's retry", p);

    expect(sent[0]!.server.userId).toBe(USER_B);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(during.orders).toHaveLength(0);
    // Neither the sheet nor the conversation thread claimed an order.
    expect(refusalPage).toContain(en.conversation.prepareOrder.error.title);
    expect(refusalPage).not.toMatch(new RegExp(createdText("\\S+")));

    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expect(text()).toContain(createdText(p.orders[0]?.order_number ?? "?"));
    expectOneOrder(p, WATER_BY_A);
  });

  it("another tab switches the active organization to B: refused with zero writes; the retry in A is one draft", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    otherTab({ org: ORG_B });
    const before = await writeSurface();
    await submitDraft();
    const refusedSurface = await writeSurface();
    evidence(
      "inbox: other tab switched to organization B",
      await persisted(),
      wroteSince(before, refusedSurface),
    );

    otherTab({ org: ORG_A });
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("inbox: other tab org, retry in A", p);

    expect(sent[0]!.server.organizationId).toBe(ORG_B);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(refusedSurface).toEqual(before);
    expect(outcomes[1]).toBe("ok");
    expectOneOrder(p, WATER_BY_A);
  });

  it("rapid A → B → A while dispatching: lands as A, never reaches the remounted sheet, and A's rebuild is replayed — one draft", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseDispatch();

    expect(sent[0]!.server.userId).toBe(USER_A);
    expect(outcomes[0]).toBe("ok");
    expect(dialog()).toBeNull(); // the sheet that sent it was remounted, closed

    await prepareWaterOrder();
    await submitDraft();
    const p = await persisted();
    evidence("inbox: rapid A→B→A, rebuild", p);
    expect(sent[1]!.data.idempotencyKey).toBe(sent[0]!.data.idempotencyKey);
    expect(text()).toContain(createdText(p.orders[0]?.order_number ?? "?"));
    expectOneOrder(p, WATER_BY_A);
  });

  it("refused under B, then a lost response as A, then a retry: one draft, created by A", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft();
    await switchTo({ user: USER_B });
    await releaseDispatch();

    await switchTo({ user: USER_A });
    await prepareWaterOrder();
    loseNextResponse = true;
    await submitDraft();
    const lostErrorShown = text().includes(en.conversation.prepareOrder.error.title);
    await click(button(en.common.retry, dialog()!), "Try again");
    await settle(10);
    const p = await persisted();
    evidence("inbox: refused, lost, retried", p);

    expect(outcomes).toEqual(["refused:principal_changed", "ok", "ok"]);
    expect(lostErrorShown).toBe(true);
    expectOneOrder(p, WATER_BY_A);
  });

  it("a dispatch that completes late, after A's rebuild already created the draft, is a replay — not a second order", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft(); // 0: held before the server
    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await prepareWaterOrder();
    await submitDraft(); // 1: same key, first to the server, accepted
    await releaseDispatch();
    const p = await persisted();
    evidence("inbox: late dispatch after completed rebuild", p);
    expect(outcomes).toEqual(["ok", "ok"]);
    expectOneOrder(p, WATER_BY_A);
  });

  it("permission revoked while dispatching (same principal): refused as a permission failure, zero writes", async () => {
    openConversation();
    await mount("inbox");
    await prepareWaterOrder();
    holdDispatchNext = true;
    await submitDraft();
    revoked.add(`${USER_A}:orders.create`);
    const before = await writeSurface();
    await releaseDispatch();
    evidence("inbox: permission revoked", await persisted());
    expect(outcomes[0]).toBe("refused:403");
    expect(await writeSurface()).toEqual(before);
    expect(text()).toContain(en.conversation.prepareOrder.permission.title);
  });
});
