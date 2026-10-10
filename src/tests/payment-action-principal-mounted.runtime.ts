/**
 * Payment detail (verify, refund, reverse), APSA Parcel recovery and the
 * shipping-destination sheet run as the principal that started them — or not
 * at all — and a refund retried after a lost response refunds once. MOUNTED,
 * through the REAL server functions and REAL SQL.
 *
 * Mounts the real screens a merchant uses:
 *
 *   - Payment detail (src/routes/app.payments.$id.tsx) under the real
 *     CapabilityProvider (the /app layout's): Confirm received, Refund, Reverse.
 *     Not keyed by principal — it stays mounted across a switch.
 *   - ParcelRecoveryBoundary (Order detail's "Create APSA Parcel"), keyed by
 *     member + organization + order.
 *   - ShippingDestinationSheet (the parcel label dialog's "Confirm shipping
 *     address"), with the principal its host passes.
 *
 * Underneath, the REAL src/api/payments.ts and src/api/orders.ts run — their
 * validators, handlers, services and repositories — against PGlite with EVERY
 * migration. Replaced: createServerFn (validator + handler, in-process), the
 * session and active organization the server derives, the membership lookup
 * (the real AuthorizationContext over per-member grants), the Supabase admin
 * client (→ PGlite; audit rows go to the real audit_logs table), the router
 * hooks and the capability snapshot (derived for the session's CURRENT member).
 *
 * Two principals are modelled, because they can disagree:
 *   route   what THIS tab's /app route context says is signed in;
 *   server  what the server derives when it HANDLES a request — shared by every
 *           tab, so another tab moves it alone.
 * A dispatch gate holds a request after it left the screen, before the server
 * derives its principal (the gate sits in the session read, the handler's
 * first step).
 *
 * Run through src/tests/payment-action-principal-mounted.test.ts (own process).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();
const db = f.db;
const ORG_A = f.org;
const ORG_B = f.orgB;
const USER_A = f.actor;
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000e4";
await db.query("insert into auth.users(id,email) values($1,'member-b@test.invalid')", [USER_B]);

const PRODUCT = crypto.randomUUID();
const VARIANT = crypto.randomUUID();
await db.query(
  `insert into products(id,organization_id,name_km,name_en) values($1,$2,'Tea-km','Tea')`,
  [PRODUCT, ORG_A],
);
await db.query(
  `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
   values($1,$2,$3,'tea-sku','',5000,'USD')`,
  [VARIANT, ORG_A, PRODUCT],
);

// ── Principals and grants ────────────────────────────────────────────────────

const route = { userId: USER_A, organizationId: ORG_A };
const server = { userId: USER_A, organizationId: ORG_A, signedIn: true };
const P_A = { userId: USER_A, organizationId: ORG_A };

const ALL_GRANTS = [
  "orders.create",
  "orders.read",
  "orders.confirm",
  "orders.update",
  "payments.read",
  "payments.record",
  "payments.manual_confirm",
  "payments.verify",
  "payments.refund",
  "payments.reverse",
  "payments.reconcile",
  "payments.view_provider_reference",
];
const grants = new Map<string, Set<string>>();
function resetGrants() {
  grants.set(USER_A, new Set(ALL_GRANTS));
  grants.set(USER_B, new Set(ALL_GRANTS));
}
resetGrants();

// ── The server-process boundary ──────────────────────────────────────────────

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
      range(from: number, to: number) {
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
        try {
          const rows = JSON.parse(JSON.stringify((await db.query(sql, values)).rows));
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
            try {
              await db.query(
                `insert into audit_logs(organization_id, actor_user_id, action, resource_type,
                   resource_id, before_json, after_json, reason)
                 values($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  row.organization_id,
                  row.actor_user_id,
                  row.action,
                  row.resource_type,
                  row.resource_id,
                  row.before_json == null ? null : JSON.stringify(row.before_json),
                  row.after_json == null ? null : JSON.stringify(row.after_json),
                  row.reason,
                ],
              );
              return { error: null };
            } catch (error) {
              return { error };
            }
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
      const params = entries.map(([, value]) =>
        value !== null && typeof value === "object" ? JSON.stringify(value) : value,
      );
      try {
        const result = await db.query<{ result: unknown }>(sql, params);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));
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

// Gates: a request waits after it left the screen, before the server derives
// its principal. The handler's first step is the session read, so the gate is there.
type Gated = "verify" | "refund" | "reverse" | "recover" | "shipping";
const GATED_FNS: Record<string, Gated> = {
  verifyPaymentFn: "verify",
  refundPaymentFn: "refund",
  reversePaymentFn: "reverse",
  recoverOrderParcelFn: "recover",
  updateOrderShippingFn: "shipping",
};
const holdDispatchNext = new Set<Gated>();
const dispatchGates: (() => void)[] = [];
let pendingGate: Gated | null = null;
mock.module("@/api/auth", () => ({
  getSessionFn: async () => {
    if (pendingGate) {
      pendingGate = null;
      await new Promise<void>((go) => dispatchGates.push(go));
    }
    return server.signedIn
      ? { userId: server.userId, email: "member@test.invalid", emailVerified: true }
      : null;
  },
}));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => server.organizationId,
}));
const realAuthorization = await import("@/server/auth/authorization");
mock.module("@/server/auth/authorization", () => ({
  ...realAuthorization,
  AuthorizationService: {
    ...realAuthorization.AuthorizationService,
    forRequest: async (userId: string, organizationId: string) =>
      new realAuthorization.AuthorizationContext({
        membership: { user_id: userId, organization_id: organizationId, role_id: "role" },
        role: { system_role: "STAFF" },
        permissions: new Set(grants.get(userId) ?? []),
      } as any),
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

interface Sent {
  fn: Gated;
  data: Json;
  /** What the server derived when it handled the request. */
  server: { userId: string; organizationId: string };
  outcome: string;
}
const sent: Sent[] = [];
/** The next request of this kind commits server-side, then its response is lost. */
const loseNextResponse = new Set<Gated>();

/** Wraps a REAL server function: gate, record what the server derived and answered, maybe lose the response. */
function wrap(name: string, real: (args: { data: unknown }) => Promise<unknown>) {
  const kind = GATED_FNS[name];
  if (!kind) return real;
  return async (args: { data: unknown }) => {
    if (holdDispatchNext.delete(kind)) pendingGate = kind;
    const lose = loseNextResponse.delete(kind);
    const entry: Sent = {
      fn: kind,
      data: JSON.parse(JSON.stringify(args.data ?? {})),
      server: { ...P_A },
      outcome: "pending",
    };
    sent.push(entry);
    try {
      const value = await real(args);
      entry.server = { userId: server.userId, organizationId: server.organizationId };
      entry.outcome = "ok";
      if (lose) throw new TypeError("Failed to fetch");
      return value;
    } catch (error) {
      if (error instanceof TypeError && lose) throw error;
      entry.server = { userId: server.userId, organizationId: server.organizationId };
      const e = error as Json;
      entry.outcome = `refused:${e.code ?? (e.name === "ZodError" ? "invalid_request" : e.statusCode)}`;
      throw error;
    }
  };
}
// Copies of the real exports, taken BEFORE mock.module (which re-points the
// imported namespace): the wrappers call these, and so does seeding — so a
// seed never passes through a gate or shows up in `sent`.
const realPayments = { ...((await import("@/api/payments")) as any) };
const realOrders = { ...((await import("@/api/orders")) as any) };
mock.module("@/api/payments", () =>
  Object.fromEntries(Object.entries(realPayments).map(([k, v]) => [k, wrap(k, v as any)])),
);
mock.module("@/api/orders", () =>
  Object.fromEntries(Object.entries(realOrders).map(([k, v]) => [k, wrap(k, v as any)])),
);
mock.module("@/api/deliveries", () => ({ listDeliveriesFn: async () => [] }));

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
const PaymentDetailScreen = ((await import("@/routes/app.payments.$id")).Route as any)
  .component as () => React.ReactElement;
const { ParcelRecoveryBoundary } = await import("@/components/fulfillment/ParcelRecoveryAction");
const { ShippingDestinationSheet } = await import("@/components/orders/ShippingDestinationSheet");

type Screen =
  | { kind: "payment" }
  | { kind: "recover"; orderId: string }
  | { kind: "shipping"; orderId: string };
let screen: Screen = { kind: "payment" };
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

function tree() {
  let body: React.ReactElement;
  if (screen.kind === "payment") body = React.createElement(PaymentDetailScreen);
  else if (screen.kind === "recover") {
    body = React.createElement(ParcelRecoveryBoundary as any, {
      userId: route.userId,
      organizationId: route.organizationId,
      orderId: screen.orderId,
      canRecover: true,
    });
  } else {
    body = React.createElement(ShippingDestinationSheet as any, {
      open: true,
      onOpenChange: () => {},
      orderId: screen.orderId,
      orderNumber: "ORD-1",
      onSaved: () => {},
      principal: { userId: route.userId, organizationId: route.organizationId },
    });
  }
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityProvider,
      { userId: route.userId, organizationId: route.organizationId } as any,
      body,
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
async function mount(next: Screen, keepClient = false) {
  screen = next;
  if (!keepClient) client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await rerender();
}
async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
}
/** THIS tab switches member and/or organization: its route and the server move together. */
async function switchTo(next: { user?: string; org?: string }) {
  if (next.user) route.userId = server.userId = next.user;
  if (next.org) route.organizationId = server.organizationId = next.org;
  await rerender();
}
/** ANOTHER tab signs in as someone else: only the server moves. */
function otherTab(next: { user?: string; org?: string }) {
  if (next.user) server.userId = next.user;
  if (next.org) server.organizationId = next.org;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(async () => {
  await db.query("delete from rate_limit_buckets");
});
afterEach(async () => {
  await unmount();
  client?.clear();
  sent.length = 0;
  holdDispatchNext.clear();
  pendingGate = null;
  for (const go of dispatchGates) go();
  dispatchGates.length = 0;
  loseNextResponse.clear();
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
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 600)}`);
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
function containing(label: string) {
  return [...document.querySelectorAll("button, [role=button], a")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLElement | undefined;
}
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!el) throw new Error(`no field; page: ${text().slice(0, 400)}`);
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function waitFor(check: () => unknown, label: string) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${label}; page: ${text().slice(0, 600)}`);
}
async function releaseDispatch(index = 0) {
  for (let i = 0; i < 200 && !dispatchGates[index]; i++) await settle(1);
  if (!dispatchGates[index]) throw new Error(`request ${index} was never dispatched`);
  await act(async () => dispatchGates[index]!());
  await settle(12);
}

// ── Seeding (member A, organization A), through the real server functions ───

const freshKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
async function seedConfirmed(): Promise<string> {
  const order = await realOrders.createOrderFn({
    data: {
      source: "MANUAL",
      items: [{ variantId: VARIANT, quantity: 2, productId: PRODUCT }],
      idempotencyKey: freshKey("order"),
      expectedPrincipal: P_A,
    },
  });
  await realOrders.transitionOrderLifecycleFn({
    data: { orderId: order.id, to: "confirmed", expectedPrincipal: P_A },
  });
  return order.id;
}
async function seedStranded(): Promise<string> {
  const order = await realOrders.createOrderFn({
    data: {
      source: "MANUAL",
      items: [{ variantId: VARIANT, quantity: 2, productId: PRODUCT }],
      idempotencyKey: freshKey("order"),
      expectedPrincipal: P_A,
    },
  });
  await db.query(
    `select transition_order_before_payment_authority_v1($1::uuid,$2::uuid,'lifecycle','draft',
       'confirmed',$3::uuid,null)`,
    [ORG_A, order.id, USER_A],
  );
  return order.id;
}
async function seedPayment(paid: boolean): Promise<{ orderId: string; paymentId: string }> {
  const orderId = await seedConfirmed();
  const payment = await realPayments.recordPaymentFn({
    data: {
      orderId,
      method: "cash",
      amountMinor: 10000,
      idempotencyKey: freshKey("pay"),
      expectedPrincipal: P_A,
    },
  });
  if (paid) {
    await realPayments.verifyPaymentFn({
      data: { paymentId: payment.id, to: "staff_confirmed", expectedPrincipal: P_A },
    });
  }
  return { orderId, paymentId: payment.id };
}

// ── Persisted state ──────────────────────────────────────────────────────────

async function writeSurface() {
  const rows = async (sql: string) =>
    (await db.query<{ r: string }>(sql)).rows.map((row) => row.r).join("|");
  return {
    orders: await rows("select md5(row_to_json(o)::text) as r from orders o order by id"),
    history: await rows("select id::text as r from order_status_history order by id"),
    parcels: await rows("select md5(row_to_json(p)::text) as r from parcels p order by id"),
    payments: await rows("select md5(row_to_json(p)::text) as r from payments p order by id"),
    paymentEvents: await rows("select id::text as r from payment_events order by id"),
    audits: await rows("select id::text as r from audit_logs order by id"),
    rateLimits: await rows(
      "select md5(row_to_json(b)::text) as r from rate_limit_buckets b order by 1",
    ),
  };
}
type Surface = Awaited<ReturnType<typeof writeSurface>>;
const wroteSince = (before: Surface, after: Surface) =>
  (Object.keys(before) as (keyof Surface)[]).filter((k) => before[k] !== after[k]);
const who = (id: string | null | undefined) =>
  id === USER_A ? "A" : id === USER_B ? "B" : String(id);
async function events(paymentId: string, type: string) {
  return (
    await db.query<Json>(
      `select actor_user_id, amount_minor, idempotency_key from payment_events
        where payment_id = $1 and event_type = $2 order by created_at, id`,
      [paymentId, type],
    )
  ).rows;
}
async function auditsFor(resourceId: string, action: string) {
  return (
    await db.query<Json>(
      "select actor_user_id from audit_logs where resource_id = $1 and action = $2 order by created_at",
      [resourceId, action],
    )
  ).rows.map((r) => who(r.actor_user_id));
}
const outcomes = () => sent.map((s) => s.outcome);

// Payment detail.

async function openPayment(paymentId: string) {
  routeParams.id = paymentId;
  await mount({ kind: "payment" });
  await waitFor(
    () =>
      containing(en.payments.actions.refund.label) ||
      containing(en.payments.actions.verify.staff_confirmed.label),
    "the payment actions",
  );
}
async function tapConfirmReceived() {
  await click(containing(en.payments.actions.verify.staff_confirmed.label), "Confirm received");
  await click(
    button(en.payments.actions.verify.staff_confirmed.submit, dialog()!),
    "Confirm (sheet)",
  );
}
async function openRefundSheet() {
  await click(containing(en.payments.actions.refund.label), "Refund");
  await waitFor(() => document.querySelector("#payment-refund-amount"), "the refund sheet");
}
async function fillRefund(amount: string, reason: string) {
  await typeInto(document.querySelector("#payment-refund-amount"), amount);
  await typeInto(document.querySelector("#payment-refund-reason"), reason);
}
async function submitRefund() {
  await click(button(en.payments.actions.refund.submit, dialog()!), "Refund (sheet)");
}
async function tapReverse(reason: string) {
  await click(containing(en.payments.actions.reverse.label), "Reverse");
  await typeInto(dialog()!.querySelector("input, textarea") as HTMLInputElement, reason);
  await click(button(en.payments.actions.reverse.submit, dialog()!), "Reverse (sheet)");
}

// ═══════════════════════════════════════════════════════════════════════════

describe("Payment detail: verify / refund / reverse run as the member who tapped", () => {
  it("V1. member A → B during Confirm received: refused, nothing written; A's retry is A's", async () => {
    const { paymentId } = await seedPayment(false);
    await openPayment(paymentId);
    holdDispatchNext.add("verify");
    await tapConfirmReceived(); // left the screen as A
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch(); // handled while the session is member B's
    const wrote = wroteSince(before, await writeSurface());
    console.log(
      `[evidence] payment detail verify, member A→B: server=[${outcomes()}] ` +
        `confirmed=[${(await events(paymentId, "staff_confirmed")).map((e) => who(e.actor_user_id))}] wrote=[${wrote}]`,
    );
    expect(sent[0]!.server.userId).toBe(USER_B);
    expect(sent[0]!.data.expectedPrincipal).toEqual(P_A);
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);

    await switchTo({ user: USER_A });
    await openPayment(paymentId);
    await tapConfirmReceived();
    expect((await events(paymentId, "staff_confirmed")).map((e) => who(e.actor_user_id))).toEqual([
      "A",
    ]);
    expect(await auditsFor(paymentId, "payments.manual_confirm")).toEqual(["A"]);
  });

  it("V2. another tab signs in as B, who lacks the grant A has: refused as principal_changed (not B's 403), nothing written", async () => {
    const { paymentId } = await seedPayment(false);
    await openPayment(paymentId);
    grants.get(USER_B)!.delete("payments.manual_confirm");
    otherTab({ user: USER_B });
    const before = await writeSurface();
    await tapConfirmReceived();
    const wrote = wroteSince(before, await writeSurface());
    expect(outcomes()).toEqual(["refused:principal_changed"]);
    expect(wrote).toEqual([]);
  });

  it("RF1. member A → B during Refund: refused, nothing written; A's retry refunds once, as A", async () => {
    const { orderId, paymentId } = await seedPayment(true);
    await openPayment(paymentId);
    await openRefundSheet();
    await fillRefund("40", "Customer returned one cup");
    holdDispatchNext.add("refund");
    await submitRefund();
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    console.log(
      `[evidence] payment detail refund, member A→B: server=[${outcomes()}] ` +
        `refunds=[${(await events(paymentId, "refund")).map((e) => `${e.amount_minor}:${who(e.actor_user_id)}`)}] wrote=[${wrote}]`,
    );
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);

    await switchTo({ user: USER_A });
    await openPayment(paymentId);
    await openRefundSheet();
    await fillRefund("40", "Customer returned one cup");
    await submitRefund();
    expect(
      (await events(paymentId, "refund")).map((e) => [e.amount_minor, who(e.actor_user_id)]),
    ).toEqual([[4000, "A"]]);
    expect(await auditsFor(paymentId, "payments.refund")).toEqual(["A"]);
    const [money] = (
      await db.query<Json>("select refund_status from orders where id = $1", [orderId])
    ).rows;
    expect(money!.refund_status).toBe("partial");
  });

  it("RV1. organization A → B during Reverse: refused, nothing written in either organization", async () => {
    const { paymentId } = await seedPayment(true);
    await openPayment(paymentId);
    holdDispatchNext.add("reverse");
    await tapReverse("Recorded against the wrong order");
    await switchTo({ org: ORG_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    console.log(
      `[evidence] payment detail reverse, organization A→B: server=[${outcomes()}] wrote=[${wrote}]`,
    );
    expect(sent[0]!.server.organizationId).toBe(ORG_B);
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    expect(await events(paymentId, "reversal")).toEqual([]);
  });

  it("RV2. member A → B during Reverse: refused; A's retry reverses once, as A", async () => {
    const { paymentId } = await seedPayment(true);
    await openPayment(paymentId);
    holdDispatchNext.add("reverse");
    await tapReverse("Recorded against the wrong order");
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);
    await switchTo({ user: USER_A });
    await openPayment(paymentId);
    await tapReverse("Recorded against the wrong order");
    expect((await events(paymentId, "reversal")).map((e) => who(e.actor_user_id))).toEqual(["A"]);
    expect(await auditsFor(paymentId, "payments.reverse")).toEqual(["A"]);
  });
});

describe("APSA Parcel recovery and the shipping-destination sheet run as the member who tapped", () => {
  it("PR1. member A → B during Create APSA Parcel: refused, no parcel; A's retry creates one, as A", async () => {
    const orderId = await seedStranded();
    await mount({ kind: "recover", orderId });
    holdDispatchNext.add("recover");
    await click(button(en.order.createParcel), "Create APSA Parcel");
    await switchTo({ user: USER_B }); // the boundary remounts; the request is already in flight
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    const parcels = (
      await db.query<Json>("select created_by from parcels where order_id = $1", [orderId])
    ).rows;
    console.log(
      `[evidence] parcel recovery, member A→B: server=[${outcomes()}] parcels=[${parcels.map((p) => who(p.created_by))}] wrote=[${wrote}]`,
    );
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);

    await switchTo({ user: USER_A });
    await click(button(en.order.createParcel), "Create APSA Parcel");
    expect(
      (
        await db.query<Json>("select created_by from parcels where order_id = $1", [orderId])
      ).rows.map((p) => who(p.created_by)),
    ).toEqual(["A"]);
  });

  it("SH1. member A → B during Save shipping destination: refused, nothing written; A's retry saves, as A", async () => {
    const orderId = await seedConfirmed();
    await mount({ kind: "shipping", orderId });
    const prefix = `#confirm-${orderId}`;
    await typeInto(document.querySelector(`${prefix}-ship-name`), "Dara");
    await typeInto(document.querySelector(`${prefix}-ship-address`), "St 271, Phnom Penh");
    holdDispatchNext.add("shipping");
    await click(button(en.shipping.save), "Save");
    await switchTo({ user: USER_B });
    const before = await writeSurface();
    await releaseDispatch();
    const wrote = wroteSince(before, await writeSurface());
    console.log(
      `[evidence] shipping destination, member A→B: server=[${outcomes()}] wrote=[${wrote}]`,
    );
    expect(outcomes()[0]).toBe("refused:principal_changed");
    expect(wrote).toEqual([]);

    await switchTo({ user: USER_A });
    await click(button(en.shipping.save), "Save");
    const [order] = (
      await db.query<Json>("select shipping_name from orders where id = $1", [orderId])
    ).rows;
    expect(order!.shipping_name).toBe("Dara");
    expect(await auditsFor(orderId, "orders.update")).toContain("A");
    expect(await auditsFor(orderId, "orders.update")).not.toContain("B");
  });
});
