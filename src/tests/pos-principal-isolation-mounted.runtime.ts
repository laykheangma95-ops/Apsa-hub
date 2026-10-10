/**
 * POS principal isolation: a member or organization switch under the mounted
 * POS screen must never show the previous principal's cart, customer or
 * checkout — and a revoked or unconfirmed customers.view_sensitive grant must
 * never show a selected customer's phone.
 *
 * Mounts the REAL <PosScreen> (src/routes/app.pos.tsx) under the REAL
 * <CapabilityProvider> and <CustomerSensitiveCacheGuard> exactly as the /app
 * layout does, so capabilities are a principal-keyed query with its real
 * pending / stale / denied states. Below that: real cart, customer picker,
 * checkout sheet and API adapters → the same service calls the server-function
 * handlers make → PGlite with EVERY migration. Only the transport (server-fn
 * boundary, Supabase admin client), the capability server function's session
 * lookup and the router hooks are replaced.
 *
 * The defect: the route is NOT remounted on a principal change, and it held the
 * cart and the selected customer in its own state, so organization B rendered
 * organization A's cart and customer (name and phone), and a member without
 * customers.view_sensitive rendered the phone a previous member had been
 * allowed to see. A revocation while POS stayed open left the phone on screen
 * too, because the selection was masked only when it was picked.
 *
 * Every case asserts the rendered page and, where a write is possible, the
 * persisted orders, stock movements, payments and customers.
 *
 * Run through src/tests/pos-principal-isolation-mounted.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();
const ORG_A = f.org;
const ORG_B = f.orgB;
/** Member 1: in both organizations, allowed to see customer phones. */
const USER_A = f.actor;
/** Member 2: in organization A only, WITHOUT customers.view_sensitive. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000b9";
await f.db.query("insert into auth.users(id,email) values($1,'member-2@test.invalid')", [USER_B]);

async function seedProduct(org: string, nameEn: string, price: number, barcode: string) {
  const product = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    nameEn,
    nameEn,
  ]);
  const variant = crypto.randomUUID();
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency,barcode)
     values($1,$2,$3,$4,'',$5,'USD',$6)`,
    [variant, org, product, `${nameEn}-sku`, price, barcode],
  );
  return { product, variant };
}
const SERUM = await seedProduct(ORG_A, "Serum", 2000, "88500011122"); // organization A
await seedProduct(ORG_B, "Toner", 1500, "88500033344"); // organization B

async function seedCustomer(org: string, name: string, phone: string) {
  const id = crypto.randomUUID();
  await f.db.query(
    `insert into customers(id,organization_id,display_name,primary_phone) values($1,$2,$3,$4)`,
    [id, org, name, phone],
  );
  return id;
}
const SOKHA = { name: "Sokha Chan", phone: "012345678" };
const DARA = { name: "Dara Lim", phone: "098765432" };
const SOKHA_ID = await seedCustomer(ORG_A, SOKHA.name, SOKHA.phone);
await seedCustomer(ORG_B, DARA.name, DARA.phone);

// ── Principals and their grants (what the server derives per membership) ────

const SELLER = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.apply_discount",
  "payments.record",
  "payments.read",
  "customers.read",
  "customers.create",
];
const principal = (user: string, org: string) => `${user}|${org}`;
const DEFAULT_GRANTS: Record<string, string[]> = {
  [principal(USER_A, ORG_A)]: [...SELLER, "customers.view_sensitive"],
  [principal(USER_A, ORG_B)]: [...SELLER, "customers.view_sensitive"],
  [principal(USER_B, ORG_A)]: [...SELLER],
};
let grants: Record<string, string[]> = structuredClone(DEFAULT_GRANTS);

const routeContext = { session: { userId: USER_A }, organizationId: ORG_A };
const current = () => principal(routeContext.session.userId, routeContext.organizationId);

function context(): AuthorizationContext {
  const granted = grants[current()] ?? [];
  return {
    organizationId: routeContext.organizationId,
    userId: routeContext.session.userId,
    can: (key: string) => granted.includes(key),
    require: (key: string) => {
      if (!granted.includes(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 });
      }
    },
  } as unknown as AuthorizationContext;
}

// ── Supabase admin client → PGlite (same shape as orders-new-order-money-mounted) ──

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
    let insertRow: Json | null = null;
    const chain: any = {
      insert(row: Json) {
        insertRow = row;
        return chain;
      },
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
      ilike(key: string, pattern: string) {
        values.push(pattern);
        where.push(`${identifier(key)} ilike $${values.length}`);
        return chain;
      },
      or(expression: string) {
        // PostgREST "a.ilike.%x%,b.ilike.%x%" — the only form the services send.
        const parts = expression.split(",").map((part) => {
          const [column, op, ...rest] = part.split(".");
          if (op !== "ilike") throw new Error(`Unsupported or(): ${expression}`);
          values.push(rest.join(".").replaceAll("*", "%"));
          return `${identifier(column!)} ilike $${values.length}`;
        });
        where.push(`(${parts.join(" or ")})`);
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options?.ascending === false ? "desc" : "asc"}`);
        return chain;
      },
      range(from: number, to: number) {
        max = to - from + 1;
        if (from > 0) ordering.push(`__offset__${from}`);
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
        try {
          if (insertRow) {
            const cols = Object.keys(insertRow).map(identifier);
            const params = cols.map((_, i) => `$${i + 1}`);
            const rows = JSON.parse(
              JSON.stringify(
                (
                  await f.db.query(
                    `insert into ${table}(${cols.join(",")}) values(${params.join(",")}) returning ${columns}`,
                    Object.values(insertRow).map((v) =>
                      v !== null && typeof v === "object" ? JSON.stringify(v) : v,
                    ),
                  )
                ).rows,
              ),
            );
            return single ? { data: rows[0], error: null } : { data: rows, error: null };
          }
          const offset = ordering.find((o) => o.startsWith("__offset__"));
          const order = ordering.filter((o) => !o.startsWith("__offset__"));
          let sql = `select ${columns} from ${table}`;
          if (where.length) sql += ` where ${where.join(" and ")}`;
          if (order.length) sql += ` order by ${order.join(",")}`;
          if (max !== undefined) sql += ` limit ${max}`;
          if (offset) sql += ` offset ${Number(offset.slice("__offset__".length))}`;
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
      if (table === "audit_logs") return { insert: async () => ({ error: null }) };
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

// ── Holdable server calls ────────────────────────────────────────────────────
//
// Each "hold" lets the server do its work (the principal is fixed when SENT)
// and keeps the RESPONSE back until release(), so it can arrive after a
// switch — the late-response cases.

type Gate = { release?: () => void };
const gates: Record<string, Gate[]> = {};
const holdNext: Record<string, boolean> = {};
async function maybeHold(name: string) {
  if (!holdNext[name]) return;
  holdNext[name] = false;
  const gate: Gate = {};
  (gates[name] ??= []).push(gate);
  await new Promise<void>((release) => (gate.release = release));
}
async function release(name: string, index = 0) {
  for (let i = 0; i < 200 && !gates[name]?.[index]?.release; i++) await settle(1);
  const gate = gates[name]?.[index];
  if (!gate?.release) throw new Error(`${name} #${index} never reached the server`);
  await act(async () => gate.release!());
  await settle(10);
}

const sentCreates: { idempotencyKey: string; organizationId: string; userId: string }[] = [];
const confirms: string[] = [];

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    const ctx = context();
    sentCreates.push({
      idempotencyKey: data.idempotencyKey,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    const { createOrder } = await import("@/server/orders/service");
    let outcome: { detail: unknown } | { error: unknown };
    try {
      outcome = {
        detail: await createOrder(ctx, {
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
          // Forwarded exactly as createOrderFn's handler forwards it.
          ...(data.expectedPrincipal ? { expectedPrincipal: data.expectedPrincipal } : {}),
        } as any),
      };
    } catch (error) {
      outcome = { error };
    }
    await maybeHold("createOrder");
    if ("error" in outcome) throw outcome.error;
    return outcome.detail;
  },
  transitionOrderLifecycleFn: async ({ data }: { data: Json }) => {
    confirms.push(data.orderId);
    const { transitionLifecycleStatus } = await import("@/server/orders/service");
    return transitionLifecycleStatus(context(), data.orderId, data.to, data.reason ?? null);
  },
  getOrderByIdFn: async ({ data }: { data: Json }) => {
    const { getOrderById } = await import("@/server/orders/service");
    return (getOrderById as any)(context(), data.orderId);
  },
}));
mock.module("@/api/payments", () => ({
  recordPaymentFn: async ({ data }: { data: Json }) => {
    const { recordPayment } = await import("@/server/payments/service");
    return recordPayment(context(), {
      orderId: data.orderId,
      method: data.method,
      amountMinor: data.amountMinor,
      reference: data.reference ?? null,
      idempotencyKey: data.idempotencyKey ?? null,
      note: data.note ?? null,
    });
  },
}));
mock.module("@/api/products", () => ({
  listProductsFn: async ({ data }: { data?: Json } = {}) => {
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(context(), { status: data?.status } as any);
  },
  lookupByBarcodeFn: async ({ data }: { data: Json }) => {
    const ctx = context();
    const { lookupByBarcode } = await import("@/server/products/service");
    const result = await lookupByBarcode(ctx, data.barcode);
    await maybeHold("barcode");
    return result;
  },
}));
mock.module("@/api/customers", () => ({
  searchCustomersFn: async ({ data }: { data: Json }) => {
    const ctx = context();
    const { searchCustomers } = await import("@/server/customers/service");
    const page = await searchCustomers(ctx, data as any);
    await maybeHold("searchCustomers");
    return page;
  },
  createCustomerFn: async ({ data }: { data: Json }) => {
    const ctx = context();
    const { createCustomer } = await import("@/server/customers/service");
    const row = await createCustomer(ctx, data as any);
    await maybeHold("createCustomer");
    return row;
  },
}));

// The capability server function: the snapshot the server derives for the
// session's CURRENT principal, as getActiveMemberCapabilitiesFn does.
let failCapabilities = false;
const capabilityCalls: string[] = [];
mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => {
    const who = { userId: routeContext.session.userId, org: routeContext.organizationId };
    capabilityCalls.push(principal(who.userId, who.org));
    await maybeHold("capabilities");
    if (failCapabilities) throw new TypeError("Failed to fetch");
    const granted = grants[principal(who.userId, who.org)];
    if (!granted) return { status: "no_membership" };
    return {
      status: "active",
      userId: who.userId,
      organizationId: who.org,
      role: "STAFF",
      permissions: granted,
    };
  },
}));

// ── Router hooks ─────────────────────────────────────────────────────────────

const { createElement } = await import("react");
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => routeContext,
  }),
  Link: ({ children, to: _to, ...rest }: any) => createElement("a", rest, children),
  useNavigate: () => () => {},
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app/pos" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

// ── DOM ──────────────────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app/pos" });
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
const { CustomerSensitiveCacheGuard } =
  await import("@/components/customers/CustomerSensitiveCacheGuard");
const { capabilityQueryKey } = await import("@/lib/capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const { Route } = await import("@/routes/app.pos");
const PosScreen = (Route as any).component as () => React.ReactElement;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

/** The /app layout's own wrapping, fed by the current route context. */
function tree() {
  const userId = routeContext.session.userId;
  const organizationId = routeContext.organizationId;
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityProvider,
      { userId, organizationId } as any,
      React.createElement(
        CustomerSensitiveCacheGuard,
        { userId, organizationId } as any,
        React.createElement(PosScreen),
      ),
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
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await settle(10);
}
/**
 * Switch the member and/or organization under the still-mounted POS screen —
 * a workspace switch: the /app guard hands the same route a new context.
 */
async function switchTo(next: { user?: string; org?: string }, rounds = 10) {
  if (next.user) routeContext.session.userId = next.user;
  if (next.org) routeContext.organizationId = next.org;
  await act(async () => root!.render(tree()));
  await settle(rounds);
}
/** Ask the server again whether the current principal's grants still hold. */
async function refreshCapabilities() {
  await act(async () => {
    await client
      .refetchQueries({
        queryKey: capabilityQueryKey(routeContext.session.userId, routeContext.organizationId),
      })
      .catch(() => {});
  });
  await settle(10);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
let baselineOrders: string[] = [];
let baselineCustomers: string[] = [];
beforeEach(async () => {
  baselineOrders = (await f.db.query<Json>("select id from orders")).rows.map((r) => r.id);
  baselineCustomers = (await f.db.query<Json>("select id from customers")).rows.map((r) => r.id);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  for (const list of Object.values(gates)) for (const gate of list) gate.release?.();
  for (const name of Object.keys(gates)) delete gates[name];
  for (const name of Object.keys(holdNext)) delete holdNext[name];
  sentCreates.length = 0;
  confirms.length = 0;
  capabilityCalls.length = 0;
  failCapabilities = false;
  grants = structuredClone(DEFAULT_GRANTS);
  routeContext.session.userId = USER_A;
  routeContext.organizationId = ORG_A;
});
afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
const cartPanel = () => document.querySelector("aside") as HTMLElement | null;
const dialog = () => document.querySelector("[role=dialog]") as HTMLElement | null;
const successShown = () => !!dialog()?.textContent?.includes(en.pos.success.title);
async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
function buttonIn(scope: ParentNode, label: string) {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function addProduct(name: string) {
  let row: Element | undefined;
  for (let i = 0; i < 60 && !row; i++) {
    row = [...document.querySelectorAll("main button, main [role=button]")].find(
      (el) => el.textContent?.includes(name) && !(el as HTMLButtonElement).disabled,
    );
    if (!row) await settle(2);
  }
  await click(row, `product ${name}`);
}
const cartNames = () =>
  [...(cartPanel()?.querySelectorAll("li p.text-body") ?? [])].map((p) => p.textContent!.trim());
/** The cart's "Add customer" control (its text also carries "Optional"). */
const addCustomerButton = () =>
  [...(cartPanel()?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.trim().startsWith(en.pos.customer.add),
  );
async function openCustomerPicker() {
  await click(addCustomerButton(), "Add customer");
}
/** Search the picker and pick `name` from the server's results. */
async function pickCustomer(name: string) {
  await openCustomerPicker();
  const search = dialog()!.querySelector(
    `input[aria-label="${en.pos.customer.search}"]`,
  ) as HTMLInputElement;
  await type(search, name.split(" ")[0]!);
  let result: Element | undefined;
  for (let i = 0; i < 60 && !result; i++) {
    result = [...(dialog()?.querySelectorAll("li button") ?? [])].find((b) =>
      b.textContent?.includes(name),
    );
    if (!result) await settle(2);
  }
  await click(result, `customer ${name}`);
}
async function openCheckout() {
  await click(buttonIn(cartPanel()!, en.pos.checkout), "cart Checkout");
}
async function confirmSale() {
  const d = dialog();
  await click(d && buttonIn(d, en.pos.confirmSale), "Confirm sale");
  await settle(10);
}
/** A keyboard-wedge scanner: a fast burst of keys, then Enter. */
async function scan(code: string) {
  await act(async () => {
    for (const key of [...code, "Enter"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
  });
  await settle();
}
/** The phone-width cart bar: the fixed bar that carries the item count. */
const cartBar = () =>
  [...document.querySelectorAll<HTMLElement>(".glass-bar")].find((el) =>
    buttonIn(el, en.pos.checkout),
  ) ?? null;
/** Whether a customer's identifying text is anywhere on the page. */
const shows = (value: string) => text().includes(value);

// ── Persisted figures ────────────────────────────────────────────────────────

async function persisted() {
  const orders = (
    await f.db.query<Json>(
      `select id, organization_id, created_by, customer_id, lifecycle_status, idempotency_key
         from orders where not (id = any($1::uuid[])) order by created_at, order_number`,
      [baselineOrders],
    )
  ).rows;
  const ids = orders.map((o) => o.id);
  const movements = (
    await f.db.query<Json>(
      `select m.organization_id, m.quantity_delta, oi.order_id
         from inventory_movements m
         join order_items oi on m.reference_type = 'order_item' and oi.id = m.reference_id
        where oi.order_id = any($1::uuid[])`,
      [ids],
    )
  ).rows;
  const payments = (
    await f.db.query<Json>(
      `select order_id, organization_id, amount_minor from payments where order_id = any($1::uuid[])`,
      [ids],
    )
  ).rows;
  const customers = (
    await f.db.query<Json>(
      `select id, organization_id, display_name from customers where not (id = any($1::uuid[]))`,
      [baselineCustomers],
    )
  ).rows;
  return { orders, movements, payments, customers };
}

/** A built till in A: Serum in the cart, Sokha (with phone) selected. */
async function buildTillInA() {
  await mount();
  await addProduct("Serum");
  await pickCustomer(SOKHA.name);
  // Harness sanity: member 1 in A may see the phone, and does.
  expect(cartNames()).toEqual(["Serum"]);
  expect(shows(SOKHA.name)).toBe(true);
  expect(shows(SOKHA.phone)).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Organization and member switches under the mounted screen
// ═══════════════════════════════════════════════════════════════════════════

describe("A principal switch never shows the previous principal's till", () => {
  it("A/B/C. organization A → B: A's cart, A's customer's name and A's customer's phone are gone", async () => {
    await buildTillInA();
    await switchTo({ org: ORG_B });

    expect(cartNames()).toEqual([]);
    expect(shows("Serum")).toBe(false);
    expect(shows(SOKHA.name)).toBe(false);
    expect(shows(SOKHA.phone)).toBe(false);
    // B's own till, ready for B's own catalog — and no customer selected.
    await addProduct("Toner");
    expect(cartNames()).toEqual(["Toner"]);
    expect(addCustomerButton()).toBeDefined();
    expect((await persisted()).orders).toHaveLength(0);
  });

  it("D. member A → B (no customers.view_sensitive): the phone member A could see is gone", async () => {
    await buildTillInA();
    await switchTo({ user: USER_B });

    expect(shows(SOKHA.phone)).toBe(false);
    expect(shows(SOKHA.name)).toBe(false);
    expect(cartNames()).toEqual([]);
  });

  it("E. member A → B while B's capabilities are still loading: nothing of A's — no stale grant reaches B", async () => {
    await buildTillInA();
    holdNext.capabilities = true;
    await switchTo({ user: USER_B });

    // B is unresolved: POS offers nothing, and certainly not A's till.
    expect(shows(SOKHA.phone)).toBe(false);
    expect(shows(SOKHA.name)).toBe(false);
    expect(shows("Serum")).toBe(false);

    await release("capabilities");
    // B resolved, without the grant. B picks the same customer itself: the
    // server withholds the phone, and nothing in the browser restores it.
    await addProduct("Serum");
    await pickCustomer(SOKHA.name);
    expect(shows(SOKHA.name)).toBe(true);
    expect(shows(SOKHA.phone)).toBe(false);
    await openCheckout();
    expect(dialog()?.textContent).toContain(SOKHA.name);
    expect(dialog()?.textContent).not.toContain(SOKHA.phone);
  });

  it("H. organization A → B → A: no A data in B, no B data back in A", async () => {
    await buildTillInA();
    await switchTo({ org: ORG_B });
    await addProduct("Toner");
    await pickCustomer(DARA.name);
    expect(shows(DARA.phone)).toBe(true); // member 1 holds the grant in B too
    expect(shows(SOKHA.name)).toBe(false);

    await switchTo({ org: ORG_A });
    expect(shows("Toner")).toBe(false);
    expect(shows(DARA.name)).toBe(false);
    expect(shows(DARA.phone)).toBe(false);
    // Back in A, a fresh till: A's old selection is not resurrected either.
    expect(cartNames()).toEqual([]);
    expect(shows(SOKHA.phone)).toBe(false);

    await switchTo({ org: ORG_B });
    expect(shows("Serum")).toBe(false);
    expect(shows(DARA.phone)).toBe(false);
    expect((await persisted()).orders).toHaveLength(0);
  });

  it("I. member A → B → A: each member sees only what their own grant allows", async () => {
    await buildTillInA();
    await switchTo({ user: USER_B });
    await addProduct("Serum");
    await pickCustomer(SOKHA.name);
    expect(shows(SOKHA.name)).toBe(true);
    expect(shows(SOKHA.phone)).toBe(false); // member 2 has no grant

    await switchTo({ user: USER_A });
    expect(cartNames()).toEqual([]); // member 2's till is not member 1's
    expect(shows(SOKHA.name)).toBe(false);
    await addProduct("Serum");
    await pickCustomer(SOKHA.name);
    expect(shows(SOKHA.phone)).toBe(true); // member 1's own grant, re-confirmed
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability changes while the same principal stays on POS
// ═══════════════════════════════════════════════════════════════════════════

describe("customers.view_sensitive is honoured at render, not only when a customer is picked", () => {
  it("F. allowed → revoked while POS stays open: the selected customer's phone disappears; the sale stays", async () => {
    await buildTillInA();
    await openCheckout();
    expect(dialog()?.textContent).toContain(SOKHA.phone);

    grants[principal(USER_A, ORG_A)] = grants[principal(USER_A, ORG_A)]!.filter(
      (key) => key !== "customers.view_sensitive",
    );
    await refreshCapabilities();

    expect(shows(SOKHA.phone)).toBe(false);
    expect(dialog()?.textContent).toContain(SOKHA.name); // name is not gated
    expect(cartNames()).toEqual(["Serum"]); // same principal: same sale
    // And the sale still goes through, attached to the same customer.
    await confirmSale();
    expect(successShown()).toBe(true);
    expect(shows(SOKHA.phone)).toBe(false);
    const p = await persisted();
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({
      organization_id: ORG_A,
      customer_id: SOKHA_ID,
      lifecycle_status: "confirmed",
    });
  });

  it("G. a capability refresh that FAILS: the phone is hidden — an unconfirmed grant shows nothing sensitive", async () => {
    await buildTillInA();
    failCapabilities = true;
    await refreshCapabilities();

    expect(shows(SOKHA.phone)).toBe(false);
    // The retained snapshot still runs the till (can()), so the sale is intact.
    expect(cartNames()).toEqual(["Serum"]);
    expect(shows(SOKHA.name)).toBe(true);

    // Confirmed again: shown again, from the server's own answer.
    failCapabilities = false;
    await refreshCapabilities();
    expect(shows(SOKHA.phone)).toBe(true);
  });

  it("G. a member whose capabilities are still PENDING sees no customer data at all", async () => {
    holdNext.capabilities = true;
    await mount();
    expect(shows(SOKHA.name)).toBe(false);
    expect(shows(SOKHA.phone)).toBe(false);
    expect(cartPanel()).toBeNull(); // POS offers nothing until the grant resolves
    await release("capabilities");
    expect(cartPanel()).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Late responses of the previous principal
// ═══════════════════════════════════════════════════════════════════════════

describe("A previous principal's late responses change nothing in the new one", () => {
  it("J. a late customer SEARCH of A's never fills B's picker", async () => {
    await mount();
    await addProduct("Serum");
    await openCustomerPicker();
    holdNext.searchCustomers = true;
    const search = dialog()!.querySelector(
      `input[aria-label="${en.pos.customer.search}"]`,
    ) as HTMLInputElement;
    await type(search, "Sokha");

    await switchTo({ org: ORG_B });
    await release("searchCustomers"); // A's results arrive in B
    expect(shows(SOKHA.name)).toBe(false);
    expect(shows(SOKHA.phone)).toBe(false);
    // B's own picker starts empty: a prompt, no results.
    await addProduct("Toner");
    await openCustomerPicker();
    expect(dialog()?.textContent).toContain(en.pos.customer.prompt.title);
    expect(dialog()?.textContent).not.toContain(SOKHA.name);
  });

  it("J. a late customer QUICK-CREATE of A's never becomes B's selected customer", async () => {
    await mount();
    await addProduct("Serum");
    await openCustomerPicker();
    await click(buttonIn(dialog()!, en.pos.customer.quickCreate), "Create new customer");
    await type(document.querySelector("#pos-cust-name") as HTMLInputElement, "Vanna Keo");
    await type(document.querySelector("#pos-cust-phone") as HTMLInputElement, "011222333");
    holdNext.createCustomer = true;
    await click(buttonIn(dialog()!, en.pos.customer.save), "Save customer");

    await switchTo({ org: ORG_B });
    await release("createCustomer");
    expect(shows("Vanna Keo")).toBe(false);
    expect(shows("011222333")).toBe(false);
    await addProduct("Toner");
    expect(addCustomerButton()).toBeDefined(); // B has no customer selected
    // A's request was A's: created in A, and only in A.
    const p = await persisted();
    expect(p.customers).toEqual([
      expect.objectContaining({ organization_id: ORG_A, display_name: "Vanna Keo" }),
    ]);
  });

  it("K. a late barcode LOOKUP of A's never adds A's product to B's cart", async () => {
    await mount();
    holdNext.barcode = true;
    await scan("88500011122"); // A's Serum

    await switchTo({ org: ORG_B });
    await release("barcode");
    expect(cartNames()).toEqual([]);
    expect(shows("Serum")).toBe(false);
    // B's own scans still work in B.
    await scan("88500033344");
    expect(cartNames()).toEqual(["Toner"]);
  });

  it("L/N. a late CHECKOUT of A's (pending at the switch) neither shows nor confirms in B; A's retry is replayed once", async () => {
    await buildTillInA();
    await openCheckout();
    holdNext.createOrder = true;
    await confirmSale(); // committed, response held

    await switchTo({ org: ORG_B });
    // N: the pending checkout is gone with A's till — no sheet, no spinner.
    expect(dialog()).toBeNull();
    expect(shows(en.pos.confirming)).toBe(false);
    await release("createOrder"); // L: A's success arrives in B
    expect(dialog()).toBeNull();
    expect(shows(SOKHA.name)).toBe(false);
    expect(cartNames()).toEqual([]);
    expect(confirms).toHaveLength(0);

    // Back in A the identical sale re-sends A's key: one order, not two.
    await switchTo({ org: ORG_A });
    await addProduct("Serum");
    await pickCustomer(SOKHA.name);
    await openCheckout();
    await confirmSale();
    expect(successShown()).toBe(true);
    expect(sentCreates.map((s) => s.idempotencyKey)).toEqual([
      sentCreates[0]!.idempotencyKey,
      sentCreates[0]!.idempotencyKey,
    ]);
    const p = await persisted();
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({
      organization_id: ORG_A,
      customer_id: SOKHA_ID,
      lifecycle_status: "confirmed",
    });
    expect(p.movements).toHaveLength(1);
    expect(p.payments).toHaveLength(0);
  });

  it("M. switching while checkout is OPEN closes it: B sees neither the sheet nor A's customer", async () => {
    await buildTillInA();
    await openCheckout();
    expect(dialog()?.textContent).toContain(SOKHA.phone);

    await switchTo({ user: USER_B });
    expect(dialog()).toBeNull();
    expect(shows(SOKHA.name)).toBe(false);
    expect(shows(SOKHA.phone)).toBe(false);
    expect((await persisted()).orders).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Writes, and the ordinary sale
// ═══════════════════════════════════════════════════════════════════════════

describe("Writes stay with their principal; an ordinary sale is unchanged", () => {
  it("O. after A → B, B's checkout writes B's order only — never A's customer, never in A", async () => {
    await buildTillInA();
    await switchTo({ org: ORG_B });
    await addProduct("Toner");
    await pickCustomer(DARA.name);
    await openCheckout();
    await confirmSale();
    expect(successShown()).toBe(true);

    const p = await persisted();
    expect(sentCreates.map((s) => s.organizationId)).toEqual([ORG_B]);
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]!.organization_id).toBe(ORG_B);
    expect(p.orders[0]!.customer_id).not.toBe(SOKHA_ID);
    expect(p.movements.map((m) => m.organization_id)).toEqual([ORG_B]);
    expect(p.payments).toHaveLength(0);
  });

  it("Q. same-principal sale with a customer: confirmed, stock once, paid once, phone shown to the granted member", async () => {
    await buildTillInA();
    await openCheckout();
    expect(dialog()?.textContent).toContain(SOKHA.phone);
    await confirmSale();
    expect(successShown()).toBe(true);
    expect(cartNames()).toEqual([]); // the sale cleared the cart (and the selection)

    await click(buttonIn(dialog()!, en.pos.success.recordPayment), "Record payment");
    await type(document.querySelector("#order-payment-amount") as HTMLInputElement, "20");
    await click(buttonIn(dialog()!, en.order.recordPaymentSheet.submit), "payment submit");
    await settle(10);

    const p = await persisted();
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({ customer_id: SOKHA_ID, lifecycle_status: "confirmed" });
    expect(p.movements).toHaveLength(1);
    expect(p.movements[0]).toMatchObject({ quantity_delta: -1, order_id: p.orders[0]!.id });
    expect(p.payments).toEqual([
      expect.objectContaining({ order_id: p.orders[0]!.id, amount_minor: 2000 }),
    ]);
  });

  it("R. the phone-width cart bar still opens checkout for the current till", async () => {
    await mount();
    await addProduct("Serum");
    const bar = cartBar();
    expect(bar).not.toBeNull();
    await click(buttonIn(bar!, en.pos.checkout), "cart bar Checkout");
    expect(dialog()?.textContent).toContain(en.pos.confirmSale);

    // And after a switch the bar belongs to the new till: gone until B adds.
    await switchTo({ org: ORG_B });
    expect(cartBar()).toBeNull();
    await addProduct("Toner");
    expect(cartBar()?.textContent).toContain("$15.00");
  });
});
