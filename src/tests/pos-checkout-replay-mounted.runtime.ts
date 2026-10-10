/**
 * POS checkout replay identity across a member / organization switch.
 *
 * Mounts the REAL <PosScreen> (src/routes/app.pos.tsx) → real
 * <PosCheckoutSheet> → real createRealOrder / confirmRealOrder /
 * recordRealPayment adapters → the same service calls the server-function
 * handlers make → PGlite with EVERY migration. Only the transport (server-fn
 * boundary, Supabase admin client) and the router hooks are replaced.
 *
 * The defect: the sheet stays mounted while the member or organization
 * changes, and it replaced its one replay-key holder on every switch. A create
 * the server committed but whose response was lost therefore lost its key on
 * "A → B → back to A": the identical retry minted a new key and
 * create_order_v3 correctly persisted a SECOND order (an orphan draft beside
 * the confirmed one). Every case below asserts the persisted orders, stock
 * movements and payments — not only the keys the browser sent.
 *
 * Run through src/tests/pos-checkout-replay-mounted.test.ts (own process).
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
const USER_A = f.actor;
/** A second member, for a member switch under the mounted checkout. */
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000b9";
await f.db.query("insert into auth.users(id,email) values($1,'member-2@test.invalid')", [USER_B]);

async function seedProduct(org: string, nameEn: string, price: number) {
  const product = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    nameEn,
    nameEn,
  ]);
  const variant = crypto.randomUUID();
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
     values($1,$2,$3,$4,'',$5,'USD')`,
    [variant, org, product, `${nameEn}-sku`, price],
  );
  return { product, variant };
}
const SERUM = await seedProduct(ORG_A, "Serum", 2000); // organization A
await seedProduct(ORG_B, "Toner", 1500); // organization B

// ── Principal: the route context AND the server's derived context ───────────

const routeContext = { session: { userId: USER_A }, organizationId: ORG_A };
const SERVER_PERMISSIONS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.apply_discount",
  "payments.record",
  "payments.read",
];
function context(): AuthorizationContext {
  return {
    organizationId: routeContext.organizationId,
    userId: routeContext.session.userId,
    can: (key: string) => SERVER_PERMISSIONS.includes(key),
    require: (key: string) => {
      if (!SERVER_PERMISSIONS.includes(key)) {
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
  idempotencyKey: string;
  /** The principal the server derived when the request was SENT. */
  userId: string;
  organizationId: string;
  data: Json;
}
const sent: SentCreate[] = [];
/** Audit rows the services wrote (the admin client's audit_logs inserts). */
const audits: unknown[] = [];
/** The next create commits server-side, then its response is lost. */
let loseNextResponse = false;
/** The next create commits server-side, then its response waits for release(). */
let holdNext = false;
const held: (() => void)[] = [];
/** The next create is refused before it reaches the database. */
let refuseNext = false;
/**
 * The next create has left the sheet but has NOT reached the server yet — the
 * lazily imported server-function module and the transport are still pending
 * — until releaseDispatch(). The server derives the principal only when it
 * HANDLES the request (the session cookie and the member's active
 * organization at that moment), so a switch inside this window is what the
 * server sees.
 */
let holdDispatchNext = false;
const dispatchGates: (() => void)[] = [];
/** The server's answer to each request, in order: "ok" or "refused:<code>". */
const outcomes: string[] = [];
const confirms: string[] = [];

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    if (holdDispatchNext) {
      holdDispatchNext = false;
      await new Promise<void>((go) => dispatchGates.push(go));
    }
    const ctx = context(); // derived when the server HANDLES it, as resolveAuthContext() does
    const index =
      sent.push({
        idempotencyKey: data.idempotencyKey,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        data: JSON.parse(JSON.stringify(data)),
      }) - 1;
    const lose = loseNextResponse;
    loseNextResponse = false;
    const hold = holdNext;
    holdNext = false;
    const refuse = refuseNext;
    refuseNext = false;
    if (refuse) throw Object.assign(new Error("Order service unavailable"), { statusCode: 503 });
    let outcome: { detail: unknown } | { error: unknown };
    try {
      const { createOrder } = await import("@/server/orders/service");
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
        // Forwarded exactly as createOrderFn's handler forwards it.
        expectedPrincipal: data.expectedPrincipal,
      } as any);
      outcome = { detail };
      outcomes[index] = "ok";
    } catch (error) {
      outcome = { error };
      outcomes[index] = `refused:${(error as Json).code ?? (error as Json).statusCode ?? "error"}`;
    }
    if (hold) await new Promise<void>((release) => (held[index] = release));
    if (lose) throw new TypeError("Failed to fetch");
    if ("error" in outcome) throw outcome.error;
    return outcome.detail;
  },
  transitionOrderLifecycleFn: async ({ data }: { data: Json }) => {
    confirms.push(data.orderId);
    const { transitionLifecycleStatus } = await import("@/server/orders/service");
    // Forwarded exactly as transitionOrderLifecycleFn's handler forwards it.
    return transitionLifecycleStatus(
      context(),
      data.orderId,
      data.to,
      data.reason ?? null,
      data.expectedPrincipal,
    );
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
      // Forwarded exactly as recordPaymentFn's handler forwards it.
      expectedPrincipal: data.expectedPrincipal,
    });
  },
}));
mock.module("@/api/products", () => ({
  listProductsFn: async ({ data }: { data?: Json } = {}) => {
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(context(), { status: data?.status } as any);
  },
  lookupByBarcodeFn: async () => null,
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
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const { Route } = await import("@/routes/app.pos");
const PosScreen = (Route as any).component as () => React.ReactElement;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

function tree() {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityFixtureProvider,
      {
        permissions: [
          "orders.create",
          "orders.confirm",
          "orders.apply_discount",
          "payments.record",
        ],
      } as any,
      React.createElement(PosScreen),
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
/** Switch the member and/or organization under the still-mounted POS screen. */
async function switchTo(next: { user?: string; org?: string }) {
  if (next.user) routeContext.session.userId = next.user;
  if (next.org) routeContext.organizationId = next.org;
  await act(async () => root!.render(tree()));
  await settle(10);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
/** Orders that existed before the current case (the ledgers are append-only). */
let baseline: string[] = [];
beforeEach(async () => {
  baseline = (await f.db.query<Json>("select id from orders")).rows.map((r) => r.id);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  for (const r of held) r?.();
  held.length = 0;
  sent.length = 0;
  confirms.length = 0;
  loseNextResponse = false;
  holdNext = false;
  refuseNext = false;
  holdDispatchNext = false;
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  outcomes.length = 0;
  audits.length = 0;
  routeContext.session.userId = USER_A;
  routeContext.organizationId = ORG_A;
});
afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";
const cartPanel = () => document.querySelector("aside") as HTMLElement;
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
  [...cartPanel().querySelectorAll("li p.text-body")].map((p) => p.textContent!.trim());
/** Replace the cart with exactly `names`, one of each. */
async function setCart(names: string[]) {
  for (const name of cartNames()) {
    await click(
      buttonIn(cartPanel(), en.pos.cart.remove.replace("{{name}}", name)),
      `remove ${name}`,
    );
  }
  for (const name of names) await addProduct(name);
  expect(cartNames()).toEqual(names);
}
/**
 * The identical cart X for a retry: kept as it is when the cart still holds it
 * (same principal), rebuilt identically otherwise — a principal switch mounts a
 * fresh till with an empty cart (src/routes/app.pos.tsx, principal isolation),
 * and the rebuilt cart is the same request, so it re-sends the same key.
 */
async function ensureCart(names: string[]) {
  if (JSON.stringify(cartNames()) !== JSON.stringify(names)) await setCart(names);
}
async function openCheckout() {
  await click(buttonIn(cartPanel(), en.pos.checkout), "cart Checkout");
}
/** Open checkout unless the (still open) sheet is already up. */
async function ensureCheckout() {
  if (!dialog()) await openCheckout();
}
async function confirmSale() {
  const d = dialog();
  await click(d && buttonIn(d, en.pos.confirmSale), "Confirm sale");
  await settle(10);
}
async function retrySale() {
  const d = dialog()!;
  await click(buttonIn(d, en.common.retry), "Try again");
  await settle(10);
}
async function closeSheet() {
  const scrim = dialog()?.parentElement?.querySelector(":scope > button[aria-label]");
  await click(scrim, "sheet close");
}
async function release(index: number) {
  for (let i = 0; i < 200 && !held[index]; i++) await settle(1);
  if (!held[index]) throw new Error(`request ${index} never reached the server`);
  await act(async () => held[index]!());
  await settle(10);
}
async function recordCashPayment(amount: string) {
  await click(buttonIn(dialog()!, en.pos.success.recordPayment), "Record payment");
  const input = document.querySelector("#order-payment-amount") as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, amount);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  await click(buttonIn(dialog()!, en.order.recordPaymentSheet.submit), "payment submit");
  await settle(10);
}

// ── Persisted figures: the authoritative duplicate check ─────────────────────

interface Persisted {
  orders: Json[];
  /** Stock movements written for this case's orders. */
  movements: Json[];
  payments: Json[];
}
async function persisted(): Promise<Persisted> {
  const orders = (
    await f.db.query<Json>(
      `select id, organization_id, created_by, lifecycle_status, payment_status, currency,
              total_minor, idempotency_key
         from orders
        where source = 'POS' and not (id = any($1::uuid[]))
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
    await f.db.query<Json>(
      `select id, order_id, organization_id, amount_minor from payments where order_id = any($1::uuid[])`,
      [ids],
    )
  ).rows;
  return { orders, movements, payments };
}
const inOrg = (rows: Json[], org: string) => rows.filter((r) => r.organization_id === org);
const keys = () => sent.map((s) => s.idempotencyKey);

/** One line of evidence per case (printed by the wrapper only on failure). */
function evidence(label: string, p: Persisted) {
  console.log(
    `[evidence] ${label}: requests=${sent.length} uniqueKeys=${new Set(keys()).size} ` +
      `orders=${p.orders.length} [${p.orders.map((o) => o.lifecycle_status).join(",")}] ` +
      `movements=${p.movements.length} payments=${p.payments.length} ` +
      `creators=[${p.orders.map((o) => (o.created_by === USER_A ? "A" : o.created_by === USER_B ? "B" : "?")).join(",")}] ` +
      `server=[${outcomes.join(",")}]`,
  );
}

/** The single, confirmed, once-deducted order a replayed checkout must leave. */
function expectOneConfirmedSale(p: Persisted, org = ORG_A) {
  expect(p.orders).toHaveLength(1);
  expect(p.orders[0]).toMatchObject({
    organization_id: org,
    lifecycle_status: "confirmed",
    currency: "USD",
  });
  // Stock left once — one sale movement of −1 for the one line.
  expect(p.movements).toHaveLength(1);
  expect(p.movements[0]).toMatchObject({
    organization_id: org,
    movement_type: "sale",
    quantity_delta: -1,
    order_id: p.orders[0]!.id,
  });
  expect(p.orders[0]!.idempotency_key).toBe(sent[0]!.idempotencyKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// The reproduction: a committed-but-lost create, A → B → A, identical retry
// ═══════════════════════════════════════════════════════════════════════════

describe("POS checkout keeps its replay key across a principal switch and back", () => {
  it("A. organization A → B → A, sheet closed between: the retry sends the original key — one order, one deduction, one payment", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // committed by the server, response lost
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);
    expect((await persisted()).orders).toHaveLength(1);
    await closeSheet();

    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("A org A→B→A", p);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(confirms).toEqual([p.orders[0]!.id]);
    expect(inOrg(p.orders, ORG_B)).toHaveLength(0);

    // The replayed sale is settled once, against the one order.
    await recordCashPayment("20");
    const settled = await persisted();
    expect(settled.payments).toHaveLength(1);
    expect(settled.payments[0]).toMatchObject({
      order_id: p.orders[0]!.id,
      organization_id: ORG_A,
      amount_minor: 2000,
    });
    expect(settled.orders).toHaveLength(1);
    expect(settled.movements).toHaveLength(1);
  });

  it("A2. organization A → B → A under the OPEN, failed sheet: one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale();
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);

    await switchTo({ org: ORG_B });
    // B's session starts clean: none of A's failure.
    expect(dialog()?.textContent ?? "").not.toContain(en.pos.orderError.title);
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await ensureCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("A2 org A→B→A open sheet", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(p.payments).toHaveLength(0);
  });

  it("B. member A → B → A: the retry sends the original key — one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale();
    await closeSheet();

    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("B member A→B→A", p);
    expect(sent.map((s) => s.userId)).toEqual([USER_A, USER_A]);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
    expect(p.payments).toHaveLength(0);
  });

  it("C. close and reopen with the identity unchanged (control): one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale();
    await closeSheet();
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("C close/reopen", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expectOneConfirmedSale(p);
  });

  it("F. network timeout → retry in the same session (control): one order, cart cleared", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale();
    await retrySale();

    const p = await persisted();
    evidence("F timeout retry", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expect(cartNames()).toEqual([]);
    expectOneConfirmedSale(p);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Switches while the create is still pending
// ═══════════════════════════════════════════════════════════════════════════

describe("A pending create across a principal switch", () => {
  it("D. organization switch while pending: the late success lands nowhere in B, and A's retry is replayed — one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdNext = true;
    await confirmSale(); // committed, response held

    await switchTo({ org: ORG_B });
    await release(0); // A's late success arrives while B is live
    expect(successShown()).toBe(false);
    expect(confirms).toHaveLength(0);
    // B's till never held A's cart, and A's late response put nothing in it.
    expect(cartNames()).toEqual([]);

    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await ensureCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("D org switch while pending", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
  });

  it("E. member switch while pending: the late success lands nowhere, and A's retry is replayed — one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdNext = true;
    await confirmSale();

    await switchTo({ user: USER_B });
    await release(0);
    expect(successShown()).toBe(false);
    expect(confirms).toHaveLength(0);

    await switchTo({ user: USER_A });
    await ensureCart(["Serum"]);
    await ensureCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("E member switch while pending", p);
    expect(sent.map((s) => s.userId)).toEqual([USER_A, USER_A]);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
  });

  it("E′. the late response arrives AFTER switching back: it neither clears the cart nor takes over the fresh sheet; the retry is replayed", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdNext = true;
    await confirmSale();
    await closeSheet();

    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await openCheckout(); // a fresh checkout session in A
    await release(0); // the abandoned session's success
    expect(successShown()).toBe(false);
    expect(dialog()).not.toBeNull(); // the newer sheet stays open
    expect(buttonIn(dialog()!, en.pos.confirmSale)?.disabled).toBe(false);
    expect(cartNames()).toEqual(["Serum"]); // the newer cart is untouched
    expect(confirms).toHaveLength(0);

    await confirmSale();
    const p = await persisted();
    evidence("E′ late after return", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
  });

  it("an old attempt cannot retire the newer replay key: A held → B → A rebuilt and lost → A's late success → retry still replayed", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdNext = true;
    await confirmSale(); // 0: held

    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await ensureCheckout();
    loseNextResponse = true;
    await confirmSale(); // 1: same key, server replays, response lost
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);

    await release(0); // the first session's late success: stale, retires nothing
    expect(successShown()).toBe(false);
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);

    await retrySale(); // 2
    const p = await persisted();
    evidence("stale claim cannot retire", p);
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Refusals, completed sales, and isolation between principals
// ═══════════════════════════════════════════════════════════════════════════

describe("Refusals, completed sales and isolation", () => {
  it("G. refused before commit → retry: same key, nothing persisted until the retry, one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    refuseNext = true;
    await confirmSale();
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);
    expect((await persisted()).orders).toHaveLength(0);
    await retrySale();

    const p = await persisted();
    evidence("G refusal retry", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expectOneConfirmedSale(p);
  });

  it("G2. refused → A → B → A → retry: still retryable on its original key — one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    refuseNext = true;
    await confirmSale();
    await closeSheet();

    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("G2 refusal A→B→A retry", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expectOneConfirmedSale(p);
  });

  it("H. a completed sale retires its key: the next identical sale is a NEW order — two sales, two deductions, one payment", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    await confirmSale();
    expect(successShown()).toBe(true);
    await recordCashPayment("20");
    await click(buttonIn(dialog()!, en.pos.success.newSale), "New sale");
    expect(cartNames()).toEqual([]);

    // Even across A → B → A the retired key stays retired.
    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await setCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("H success then identical sale", p);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(p.orders.map((o) => o.lifecycle_status)).toEqual(["confirmed", "confirmed"]);
    expect(p.orders.map((o) => o.idempotency_key)).toEqual(keys());
    expect(p.movements).toHaveLength(2);
    expect(new Set(p.movements.map((m) => m.order_id)).size).toBe(2);
    expect(p.payments).toHaveLength(1);
    expect(p.payments[0]!.order_id).toBe(p.orders[0]!.id);
  });

  it("different organizations never share a key; each keeps its own unresolved key and is replayed once — no cross-tenant write", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // 0: A's Serum, committed, lost
    await closeSheet();

    await switchTo({ org: ORG_B });
    await setCart(["Toner"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // 1: B's Toner, committed, lost
    expect(sent[1]!.organizationId).toBe(ORG_B);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    await closeSheet();

    await switchTo({ org: ORG_A });
    await setCart(["Serum"]);
    await openCheckout();
    await confirmSale(); // 2: A's retry
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    await click(buttonIn(dialog()!, en.pos.success.newSale), "New sale");

    await switchTo({ org: ORG_B });
    await setCart(["Toner"]);
    await openCheckout();
    await confirmSale(); // 3: B's retry
    expect(sent[3]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(successShown()).toBe(true);

    const p = await persisted();
    evidence("org isolation", p);
    // Every request was answered under the organization it was sent as.
    for (const o of p.orders) {
      const request = sent.find((s) => s.idempotencyKey === o.idempotency_key)!;
      expect(o.organization_id).toBe(request.organizationId);
    }
    expect(inOrg(p.orders, ORG_A)).toHaveLength(1);
    expect(inOrg(p.orders, ORG_B)).toHaveLength(1);
    expect(inOrg(p.orders, ORG_B)[0]).toMatchObject({ total_minor: 1500, currency: "USD" });
    expect(inOrg(p.movements, ORG_A)).toHaveLength(1);
    expect(inOrg(p.movements, ORG_B)).toHaveLength(1);
    expect(p.payments).toHaveLength(0);
  });

  it("different members never share a key, even for the identical cart", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // 0: member A, lost
    await closeSheet();

    await switchTo({ user: USER_B });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale(); // 1: member B's identical cart — their own sale
    expect(sent[1]!.userId).toBe(USER_B);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    await click(buttonIn(dialog()!, en.pos.success.newSale), "New sale");

    await switchTo({ user: USER_A });
    await setCart(["Serum"]);
    await openCheckout();
    await confirmSale(); // 2: member A's retry — their key, never member B's
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);

    const p = await persisted();
    evidence("member isolation", p);
    expect(p.orders).toHaveLength(2);
    expect(p.orders.map((o) => o.created_by).sort()).toEqual([USER_A, USER_B].sort());
    expect(p.orders.filter((o) => o.idempotency_key === sent[0]!.idempotencyKey)).toHaveLength(1);
    expect(p.movements).toHaveLength(2);
    expect(p.payments).toHaveLength(0);
  });

  it("a different logical checkout after the switch back is a new order with a new key", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // 0: Serum × 1, committed, lost
    await closeSheet();

    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await setCart(["Serum"]);
    await addProduct("Serum"); // Serum × 2 — a different request
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("different request", p);
    expect(sent[1]!.data.items[0].quantity).toBe(2);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    // The lost one is the orphan draft the merchant can see in Orders; the
    // changed cart is its own sale. Neither is a replay of the other.
    expect(p.orders.map((o) => o.lifecycle_status)).toEqual(["draft", "confirmed"]);
    expect(p.movements).toHaveLength(1);
    expect(p.movements[0]).toMatchObject({ quantity_delta: -2, variant_id: SERUM.variant });
  });

  it("many principal switches in between never evict the unresolved key", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale();
    await closeSheet();

    // Organizations and members this till passes through without selling.
    for (let i = 0; i < 30; i++) {
      await switchTo({ org: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}` });
      if (i % 5 === 0) {
        await switchTo({ user: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}` });
      }
    }
    await switchTo({ org: ORG_A, user: USER_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("many switches", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expectOneConfirmedSale(p);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A checkout runs as the principal that started it — or not at all
// ═══════════════════════════════════════════════════════════════════════════
//
// Between the tap and the server there is a window: createRealOrder lazily
// imports the server-function module, then the request travels. The server
// derives the principal only when it HANDLES the request — the session
// cookie's member and that member's active organization at that moment. A
// switch inside the window therefore used to execute member A's checkout AS
// member B (B became the order's creator, under A's replay key), and A's
// identical retry then met a creator mismatch on that key: refused, and the
// sale left unreconciled. The request now carries the principal that started
// it, and the server refuses — before any write — when its own derivation
// differs. That assertion can only refuse; it never authorizes anything.

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

async function releaseDispatch(index = 0) {
  for (let i = 0; i < 200 && !dispatchGates[index]; i++) await settle(1);
  if (!dispatchGates[index]) throw new Error(`request ${index} was never dispatched`);
  await act(async () => dispatchGates[index]!());
  await settle(10);
}

describe("A checkout runs as the principal that started it", () => {
  it("member A → B while the checkout is still being dispatched: never executes as B; A's retry is one order, created by A", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdDispatchNext = true;
    await confirmSale(); // A's checkout has left the sheet, not reached the server
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch(); // it arrives while the session is member B's
    // Refused before anything: no order, line, movement, payment, audit row or
    // rate-limit token — exactly the database it found.
    expect(await writeSurface()).toEqual(before);

    const during = await persisted();
    evidence("member race, dispatched under B", during);
    expect(sent[0]!.userId).toBe(USER_B); // what the server derived
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(during.orders).toHaveLength(0);
    expect(during.movements).toHaveLength(0);

    await switchTo({ user: USER_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("member race, A's retry", p);
    // The same measure moves for a create that IS executed (so it is not blind).
    const after = await writeSurface();
    expect(after.orders).not.toBe(before.orders);
    expect(after.movements).not.toBe(before.movements);
    expect(after.rateLimits).not.toBe(before.rateLimits); // A's create spent a token
    expect(after.audits).toBeGreaterThan(before.audits); // and wrote its audit row
    expect(sent[1]!.userId).toBe(USER_A);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
    expect(p.payments).toHaveLength(0);
  });

  it("organization A → B while the checkout is still being dispatched: never executes in B; A's retry is one order in A", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdDispatchNext = true;
    await confirmSale();
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    expect(await writeSurface()).toEqual(before);

    const during = await persisted();
    evidence("org race, dispatched under B", during);
    expect(sent[0]!.organizationId).toBe(ORG_B);
    expect(outcomes[0]).toBe("refused:principal_changed");
    expect(during.orders).toHaveLength(0);

    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();

    const p = await persisted();
    evidence("org race, A's retry", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(outcomes[1]).toBe("ok");
    expectOneConfirmedSale(p, ORG_A);
    expect(p.orders[0]!.created_by).toBe(USER_A);
    expect(inOrg(p.orders, ORG_B)).toHaveLength(0);
  });

  it("rapid A → B → A while dispatching: the request lands as A (its own principal), is never accepted by a newer till, and A's retry is replayed — one order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdDispatchNext = true;
    await confirmSale();
    await switchTo({ user: USER_B });
    await switchTo({ user: USER_A });
    await releaseDispatch(); // late completion: the session is A's again

    expect(sent[0]!.userId).toBe(USER_A);
    expect(outcomes[0]).toBe("ok"); // A's own request, A's own session
    expect(successShown()).toBe(false); // but the till that sent it is gone
    expect(confirms).toHaveLength(0);
    expect((await persisted()).orders.map((o) => o.lifecycle_status)).toEqual(["draft"]);

    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale();
    const p = await persisted();
    evidence("rapid A→B→A, late completion then retry", p);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
  });

  it("pending dispatch refused under B, then a lost response in A, then a retry: one order, created by A", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdDispatchNext = true;
    await confirmSale();
    await switchTo({ user: USER_B });
    await releaseDispatch();
    expect(outcomes[0]).toBe("refused:principal_changed");

    await switchTo({ user: USER_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    loseNextResponse = true;
    await confirmSale(); // committed as A, response lost
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);
    await retrySale();

    const p = await persisted();
    evidence("refused, lost, retried", p);
    expect(new Set(keys()).size).toBe(1);
    expect(outcomes).toEqual(["refused:principal_changed", "ok", "ok"]);
    expect(successShown()).toBe(true);
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
  });

  it("a dispatch that completes late, after A's retry already completed the sale, is a replay — not a second order", async () => {
    await mount();
    await setCart(["Serum"]);
    await openCheckout();
    holdDispatchNext = true;
    await confirmSale(); // 0: held before the server
    await switchTo({ org: ORG_B });
    await switchTo({ org: ORG_A });
    await ensureCart(["Serum"]);
    await openCheckout();
    await confirmSale(); // 1: same key, reaches the server first, accepted
    expect(successShown()).toBe(true);

    await releaseDispatch(); // 0 finally arrives — as A, same key, same request
    const p = await persisted();
    evidence("late dispatch after completed retry", p);
    expect(sent[0]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(outcomes).toEqual(["ok", "ok"]);
    expect(successShown()).toBe(true); // the late answer changed nothing on screen
    expectOneConfirmedSale(p);
    expect(p.orders[0]!.created_by).toBe(USER_A);
  });
});
