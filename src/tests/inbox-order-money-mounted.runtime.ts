/**
 * Inbox → Prepare / Create Order money — MOUNTED behavioural regressions.
 *
 * Mounts the REAL production components in happy-dom and drives them the way
 * a merchant does:
 *
 *   - <PrepareOrderSheet> — the production chat→order sheet (real orders);
 *   - the real conversation route (src/routes/app.inbox.$id.tsx), for the
 *     conversation → customer → order linkage and conversation switches;
 *   - <CreateOrderSheet> — the prototype-only sheet the route mounts for
 *     fixture conversations.
 *
 * Only the network is replaced:
 *   - `@/api/orders` — the order SERVER FUNCTIONS. The real createRealOrder()
 *     (src/lib/api) runs on top, so the idempotency key each attempt sends is
 *     the one production would send. Creates return DEFERRED promises the test
 *     settles by hand, so a response can be made to arrive late.
 *   - read functions of `@/lib/api` (conversation, customer, catalog), and the
 *     prototype createOrder (to capture what the prototype sheet submits).
 *   - four TanStack Router hooks — there is no router in a unit process.
 *
 * Runs in its own process (inbox-order-money-mounted.test.ts): it installs
 * DOM globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/inbox" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const id = (suffix: string) => `3f2504e0-4f89-41d3-9a0c-${suffix.padStart(12, "0")}`;

// ── Router: only the hooks the conversation route touches ───────────────────

const routeContext = {
  session: { userId: id("a001") },
  organizationId: id("b001"),
};
const routeParams = { id: id("c001") };
let testSeq = 1;
const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => routeContext,
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

// ── Catalog ──────────────────────────────────────────────────────────────────

type Price = { amount: number; currency: "USD" | "KHR" };

function product(pid: string, nameEn: string, price: Price, extra: Record<string, unknown> = {}) {
  return {
    id: pid,
    nameKm: `${nameEn}-km`,
    nameEn,
    sku: `SKU-${nameEn}`,
    price,
    stock: null,
    lowStockThreshold: 0,
    companion: "minto",
    // A distinct variant per product: the last group "…d001" becomes "…f001".
    variantId: pid.replace(/d(\d{3})$/, "f$1"),
    ...extra,
  };
}

const SERUM = product(id("d001"), "Serum", { amount: 2000, currency: "USD" });
const TONER = product(id("d002"), "Toner", { amount: 3000, currency: "USD" });
const WATER = product(id("d003"), "Water", { amount: 5000, currency: "KHR" });
const RICE = product(id("d004"), "Rice", { amount: 4_000_000, currency: "KHR" });
const CATALOG = [SERUM, TONER, WATER, RICE];

// Prototype fixtures (non-UUID ids) for the prototype-only CreateOrderSheet.
const P_USD = product("prd-usd", "Lipstick", { amount: 2000, currency: "USD" }, { stock: 50 });
const P_KHR = product("prd-khr", "Noodles", { amount: 50_000, currency: "KHR" }, { stock: 50 });

// ── Server functions (the network boundary) ──────────────────────────────────

interface Pending {
  data: any;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
const creates: Pending[] = [];
const transitions: Pending[] = [];

/** What create_order_v2 would persist for a request: priced from the catalog. */
function serverDetail(data: any, orderNumber: string) {
  const lines = data.items.map((item: any) => {
    const p = CATALOG.find((c) => c.variantId === item.variantId)!;
    return { p, quantity: item.quantity };
  });
  const currency = lines[0].p.price.currency;
  const subtotal = lines.reduce((s: number, l: any) => s + l.p.price.amount * l.quantity, 0);
  const discount = data.discountMinor ?? 0;
  const delivery = data.deliveryMinor ?? 0;
  const money = (amount: number) => ({ amount, currency });
  return {
    id: id(String(1000 + creates.length)),
    organizationId: routeContext.organizationId,
    orderNumber,
    customerId: data.customerId ?? null,
    locationId: null,
    source: data.source,
    currency,
    subtotal: money(subtotal),
    discount: money(discount),
    delivery: money(delivery),
    total: money(subtotal - discount + delivery),
    lifecycleStatus: "draft",
    paymentStatus: "unpaid",
    refundStatus: "none",
    fulfillmentStatus: "unfulfilled",
    createdBy: routeContext.session.userId,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sourceConversationRef: data.sourceConversationRef ?? null,
    items: lines.map((l: any, i: number) => ({
      id: id(String(2000 + i)),
      productId: l.p.id,
      variantId: l.p.variantId,
      productName: l.p.nameEn,
      variantName: "Default",
      sku: l.p.sku,
      quantity: l.quantity,
      unitPrice: l.p.price,
      lineTotal: money(l.p.price.amount * l.quantity),
    })),
    statusHistory: [],
  };
}

mock.module("@/api/orders", () => ({
  createOrderFn: ({ data }: { data: any }) =>
    new Promise((resolve, reject) => creates.push({ data, resolve, reject })),
  transitionOrderLifecycleFn: ({ data }: { data: any }) =>
    new Promise((resolve, reject) => transitions.push({ data, resolve, reject })),
}));

const prototypeCreates: any[] = [];
const conversations: Record<string, any> = {};
const customers: Record<string, any> = {};

function conversation(cid: string, customerId: string) {
  return {
    id: cid,
    customerId,
    customerName: `Customer ${cid.slice(-2)}`,
    channel: "facebook",
    status: "needs_reply",
    messages: [],
    nextBeforeId: null,
    readThroughMessageId: null,
  };
}
function customer(cid: string, name: string) {
  return {
    id: cid,
    nameKm: name,
    nameEn: name,
    phone: "012345678",
    identities: [],
    tags: [],
    orderCount: 0,
    lifetimeSpend: { amount: 0, currency: "USD" },
    companion: "minto",
  };
}

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getConversation: async (cid: string) => conversations[cid],
  getCustomer: async (cid: string) => customers[cid],
  getProducts: async () => CATALOG,
  getRecentProducts: async () => [P_USD, P_KHR],
  markRealConversationRead: async () => {},
  getOlderConversationMessages: async () => ({ messages: [], nextBeforeId: null }),
  getMostRecentRealOrderForCustomer: async () => null,
  createOrder: async (input: any) => {
    prototypeCreates.push(input);
    return { ...input, id: "ord-APSA-9001", code: "APSA-9001", createdAt: "2026-01-01" };
  },
}));

// ── Mount ────────────────────────────────────────────────────────────────────

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
const km = (await import("@/locales/km.json")).default as any;
const { PrepareOrderSheet } = await import("@/components/inbox/PrepareOrderSheet");
const { CreateOrderSheet } = await import("@/components/inbox/CreateOrderSheet");
const { Route } = await import("@/routes/app.inbox.$id");
const ConversationScreen = (Route as any).component as () => React.ReactElement;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;
let currentTree: () => React.ReactElement = () => React.createElement("div");

const PERMISSIONS = [
  "orders.create",
  "orders.confirm",
  "customers.read",
  "messages.reply",
] as const;

function wrap(child: React.ReactElement) {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(CapabilityFixtureProvider, { permissions: PERMISSIONS }, child),
  );
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(tree: () => React.ReactElement) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  currentTree = tree;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(wrap(currentTree())));
  await settle(8);
}

async function rerender() {
  await act(async () => root!.render(wrap(currentTree())));
  await settle(8);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  creates.length = 0;
  committedByKey.clear();
  committedOrders = 0;
  transitions.length = 0;
  prototypeCreates.length = 0;
  // A fresh member per test: the replay-key registry is page-lifetime (by
  // design), so tests must not share one principal's replay identities.
  testSeq += 1;
  routeContext.session.userId = id(`a${String(testSeq).padStart(3, "0")}`);
  routeContext.organizationId = id("b001");
  routeParams.id = id("c001");
});

// ── Prepare sheet harness ────────────────────────────────────────────────────

const CUSTOMER_A = customer(id("e001"), "Sokha");
const CONVERSATION_REF = id("c001");

interface SheetHarness {
  open: boolean;
  initialItems: any[];
  created: any[];
  confirmed: any[];
}

function sheetHarness(initialItems: any[]): SheetHarness {
  return { open: true, initialItems, created: [], confirmed: [] };
}

async function mountSheet(h: SheetHarness) {
  await mount(() =>
    React.createElement(PrepareOrderSheet, {
      open: h.open,
      onOpenChange: (next: boolean) => {
        h.open = next;
        // Re-rendered by the caller (closeSheet) — never a nested act() here.
      },
      customer: CUSTOMER_A as any,
      displayName: "Sokha",
      channel: "facebook",
      products: CATALOG as any,
      initialItems: h.initialItems,
      sourceConversationRef: CONVERSATION_REF,
      replayScope: {
        userId: routeContext.session.userId,
        organizationId: routeContext.organizationId,
        conversationId: CONVERSATION_REF,
      },
      onCreated: (order: any) => h.created.push(order),
      onConfirmed: (order: any) => h.confirmed.push(order),
    }),
  );
}

async function setOpen(h: SheetHarness, open: boolean) {
  h.open = open;
  await rerender();
}

/** Close the sheet the way a merchant does: its own close control. */
async function closeSheet(h: SheetHarness) {
  // The scrim behind the panel — BottomSheet's pointer close affordance.
  await click(button(en.common.close), "sheet close");
  await rerender();
  expect(h.open).toBe(false);
}

/** True when the control cannot be used — its own flag or a disabled fieldset around it. */
function inert(el: Element | null | undefined): boolean {
  if (!el) throw new Error("no control");
  return (
    (el as HTMLButtonElement).disabled === true ||
    (el.closest("fieldset") as HTMLFieldSetElement | null)?.disabled === true
  );
}

const text = () => document.body.textContent ?? "";

function dialog(): HTMLElement {
  const el = document.querySelector("[role=dialog]");
  if (!el) throw new Error(`no dialog open; page: ${text().slice(0, 300)}`);
  return el as HTMLElement;
}

async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

function buttonContaining(fragment: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(fragment)) as
    HTMLButtonElement | undefined;
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input to type into");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const feeInput = () =>
  document.getElementById("prepare-order-delivery-fee") as HTMLInputElement | null;

function submitButton(): HTMLButtonElement | undefined {
  return (
    button(en.conversation.prepareOrder.createDraft) ??
    button(en.conversation.prepareOrder.creating)
  );
}

/** The estimated-total row's own figure (the big number), or null when none is shown. */
function estimatedTotal(): string | null {
  const label = [...dialog().querySelectorAll("span")].find(
    (s) => s.textContent?.trim() === en.conversation.prepareOrder.estimatedTotal,
  );
  return label?.parentElement?.querySelector(".text-financial-lg")?.textContent?.trim() ?? null;
}

/*
 * The fake server keeps create_order_v3's replay rule: once a key has COMMITTED
 * an order, the same key returns that same order again (the real-SQL proof of
 * the rule itself is in order-money-stock-safety.runtime.ts). Every distinct
 * committed order is counted, so a duplicate is visible.
 */
const committedByKey = new Map<string, any>();
let committedOrders = 0;
let orderNumberSeq = 0;

function commit(pending: Pending, orderNumber?: string) {
  const key = pending.data.idempotencyKey as string;
  let detail = committedByKey.get(key);
  if (!detail) {
    orderNumberSeq += 1;
    detail = serverDetail(
      pending.data,
      orderNumber ?? `APSA-2026-${String(900000 + orderNumberSeq).padStart(6, "0")}`,
    );
    committedByKey.set(key, detail);
    committedOrders += 1;
  }
  return detail;
}

async function resolveCreate(index = creates.length - 1, orderNumber = "APSA-2026-000101") {
  const pending = creates[index]!;
  await act(async () => pending.resolve(commit(pending, orderNumber)));
  await settle(6);
}

/** The server commits the order, but the browser never receives the response. */
async function commitButLoseResponse(index = creates.length - 1) {
  const pending = creates[index]!;
  commit(pending);
  await act(async () => pending.reject(new TypeError("Failed to fetch")));
  await settle(6);
}

async function rejectCreate(error: unknown, index = creates.length - 1) {
  const pending = creates[index]!;
  await act(async () => pending.reject(error));
  await settle(6);
}

function serverError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Prepare Order — money in the order's own currency
// ═══════════════════════════════════════════════════════════════════════════

describe("Prepare Order money (production sheet, mounted)", () => {
  it("KHR: 2 × ៛5,000 = ៛10,000, shown in riel with no dollar figure anywhere", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 2 }]));
    const body = dialog().textContent ?? "";
    expect(body).toContain("៛5,000 × 2");
    expect(body).toContain("៛10,000");
    expect(estimatedTotal()).toBe("៛10,000");
    expect(body).not.toContain("$");
    expect(body).toContain(en.deliveryFee.label.replace("{{currency}}", "KHR"));
    expect(submitButton()?.disabled).toBe(false);
  });

  it("KHR: a riel delivery fee stays riel in the preview and in the request", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 2 }]);
    await mountSheet(h);
    await type(feeInput(), "2,000");
    expect(estimatedTotal()).toBe("៛12,000");
    expect(dialog().textContent).toContain("+៛2,000");

    await click(submitButton(), "Create draft");
    expect(creates).toHaveLength(1);
    const sent = creates[0]!.data;
    expect(sent.deliveryMinor).toBe(2000);
    expect(sent.items).toEqual([{ variantId: WATER.variantId, quantity: 2, productId: WATER.id }]);
    expect(sent.customerId).toBe(CUSTOMER_A.id);
    expect(sent.sourceConversationRef).toBe(CONVERSATION_REF);
    expect(sent.source).toBe("FACEBOOK");
    // The browser sends no price, subtotal, total or currency — only inputs to
    // the server's own calculation.
    for (const forbidden of ["price", "unitPrice", "subtotal", "total", "currency", "discount"]) {
      expect(Object.keys(sent)).not.toContain(forbidden);
    }

    await resolveCreate();
    expect(h.created).toHaveLength(1);
    // Preview and persisted (server-priced) order agree to the riel.
    expect(h.created[0].total).toEqual({ amount: 12000, currency: "KHR" });
    expect(h.created[0].subtotal).toEqual({ amount: 10000, currency: "KHR" });
    expect(h.created[0].deliveryFee).toEqual({ amount: 2000, currency: "KHR" });
  });

  it("KHR: a fractional riel fee is refused and blocks submit", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 1 }]));
    await type(feeInput(), "1.50");
    expect(feeInput()?.getAttribute("aria-invalid")).toBe("true");
    expect(submitButton()?.disabled).toBe(true);
    await click(submitButton());
    expect(creates).toHaveLength(0);
  });

  it("USD: 2 × $20.00 + $1.50 delivery = $41.50, fee sent as 150 cents", async () => {
    await mountSheet(sheetHarness([{ product: SERUM, quantity: 2 }]));
    expect(estimatedTotal()).toBe("$40.00");
    await type(feeInput(), "1.50");
    expect(estimatedTotal()).toBe("$41.50");
    await click(submitButton());
    expect(creates[0]!.data.deliveryMinor).toBe(150);
  });

  it("USD: an ambiguous comma ('1,5') is refused, never read as $15.00", async () => {
    await mountSheet(sheetHarness([{ product: SERUM, quantity: 1 }]));
    await type(feeInput(), "1,5");
    expect(feeInput()?.getAttribute("aria-invalid")).toBe("true");
    expect(estimatedTotal()).toBe("$20.00");
    expect(submitButton()?.disabled).toBe(true);
  });

  it("zero delivery fee: nothing is added and no fee is sent", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 1 }]));
    await type(feeInput(), "0");
    expect(estimatedTotal()).toBe("៛5,000");
    await click(submitButton());
    expect(creates[0]!.data.deliveryMinor).toBeUndefined();
  });

  it("mixed USD + KHR: no combined total, an explanation, submit blocked, draft preserved", async () => {
    await mountSheet(
      sheetHarness([
        { product: SERUM, quantity: 1 },
        { product: WATER, quantity: 2 },
      ]),
    );
    const body = dialog().textContent ?? "";
    expect(estimatedTotal()).toBeNull();
    expect(body).toContain(en.conversation.prepareOrder.currency.mixedTitle);
    expect(body).toContain(en.conversation.prepareOrder.currency.mixedBody);
    // Each line still shows its own price in its own currency.
    expect(body).toContain("$20.00");
    expect(body).toContain("៛10,000");
    // No fee field: a fee has no currency to be typed in.
    expect(feeInput()).toBeNull();
    expect(submitButton()?.disabled).toBe(true);
    await click(submitButton());
    expect(creates).toHaveLength(0);

    // Removing the riel line restores an honest USD total.
    const removes = [...dialog().querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-label") === en.conversation.prepareOrder.remove,
    );
    await click(removes[1], "remove line 2");
    expect(estimatedTotal()).toBe("$20.00");
    expect(submitButton()?.disabled).toBe(false);
  });

  it("a delivery fee belongs to the currency it was typed in: switching the item to riel clears it", async () => {
    await mountSheet(sheetHarness([{ product: SERUM, quantity: 1 }]));
    await type(feeInput(), "5");
    expect(estimatedTotal()).toBe("$25.00");

    await click(button(en.conversation.prepareOrder.changeProduct, dialog()), "Change");
    await click(buttonContaining("Water", dialog()), "pick Water");
    expect(feeInput()?.value).toBe("");
    expect(estimatedTotal()).toBe("៛5,000");

    // …and does not silently come back when the item returns to dollars.
    await click(button(en.conversation.prepareOrder.changeProduct, dialog()), "Change");
    await click(buttonContaining("Serum", dialog()), "pick Serum");
    expect(feeInput()?.value).toBe("");
    expect(estimatedTotal()).toBe("$20.00");
  });

  it("an empty draft shows no fabricated $0.00 total", async () => {
    await mountSheet(sheetHarness([]));
    expect(dialog().textContent).not.toContain("$0.00");
    expect(estimatedTotal()).toBeNull();
    expect(submitButton()?.disabled).toBe(true);
  });

  it("large KHR: ៛4,000,000 × 999 is exact (៛3,996,000,000)", async () => {
    await mountSheet(sheetHarness([{ product: RICE, quantity: 999 }]));
    expect(estimatedTotal()).toBe("៛3,996,000,000");
    expect(dialog().textContent).not.toContain("$");
  });

  it("Khmer: riel figures and the mixed-currency explanation render in Khmer", async () => {
    await i18n.changeLanguage("km");
    await mountSheet(sheetHarness([{ product: WATER, quantity: 2 }]));
    expect(dialog().textContent).toContain("៛10,000");
    expect(dialog().textContent).not.toContain("$");
    expect(dialog().textContent).toContain(km.conversation.prepareOrder.estimatedTotal);
    await act(async () => root?.unmount());
    root = null;
    await mountSheet(
      sheetHarness([
        { product: SERUM, quantity: 1 },
        { product: WATER, quantity: 1 },
      ]),
    );
    expect(dialog().textContent).toContain(km.conversation.prepareOrder.currency.mixedTitle);
  });

  it("the server's currency_mismatch is explained, not shown as a generic failure", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 1 }]));
    await click(submitButton());
    await rejectCreate(serverError("All items must be priced in the organization's currency", 409));
    expect(dialog().textContent).toContain(
      en.conversation.prepareOrder.currency.serverMismatch.title,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Prepare Order — double submit, retry, late responses
// ═══════════════════════════════════════════════════════════════════════════

describe("Prepare Order races (production sheet, mounted)", () => {
  it("a double tap sends one create", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 1 }]));
    const submit = submitButton()!;
    await act(async () => {
      submit.click();
      submit.click();
    });
    await settle();
    expect(creates).toHaveLength(1);
  });

  it("the draft cannot be edited while a create is in flight", async () => {
    await mountSheet(sheetHarness([{ product: WATER, quantity: 1 }]));
    await click(submitButton());
    expect(inert(button(en.common.increase, dialog()))).toBe(true);
    expect(inert(feeInput())).toBe(true);
    expect(inert(button(en.conversation.prepareOrder.changeProduct, dialog()))).toBe(true);
    // …and editable again once the attempt settles.
    await rejectCreate(new Error("network"));
    expect(inert(button(en.common.increase, dialog()))).toBe(false);
    expect(inert(feeInput())).toBe(false);
  });

  it("same-payload retry re-sends the key; a changed payload gets a new key; the next order a new key", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await click(submitButton());
    await rejectCreate(new Error("network"));
    expect(dialog().textContent).toContain(en.conversation.prepareOrder.error.title);

    await click(submitButton());
    expect(creates[1]!.data.idempotencyKey).toBe(creates[0]!.data.idempotencyKey);
    await rejectCreate(new Error("network"));

    await type(feeInput(), "500");
    await click(submitButton());
    expect(creates[2]!.data.idempotencyKey).not.toBe(creates[0]!.data.idempotencyKey);
    await resolveCreate();
    expect(h.created).toHaveLength(1);

    // Discard and rebuild the identical order: a genuinely new order, new key.
    await click(button(en.conversation.prepareOrder.discardDraft, dialog()));
    const cancel = transitions[0]!;
    await act(async () => cancel.resolve(serverDetail(creates[2]!.data, "APSA-2026-000101")));
    await settle(6);
    await type(feeInput(), "500");
    await click(submitButton());
    expect(creates[3]!.data.idempotencyKey).not.toBe(creates[2]!.data.idempotencyKey);
  });

  it("close while pending → reopen → late success never paints over the new draft", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await click(submitButton());
    await closeSheet(h);
    await setOpen(h, true);
    expect(estimatedTotal()).toBe("៛5,000");

    await resolveCreate(0);
    expect(dialog().textContent).not.toContain(
      en.conversation.prepareOrder.draftCreated.replace("{{code}}", "APSA-2026-000101"),
    );
    expect(estimatedTotal()).toBe("៛5,000");
    expect(h.created).toHaveLength(0);

    // The abandoned attempt's key was not retired: an identical resubmission
    // is answered by the server with the order it already made.
    await click(submitButton());
    expect(creates[1]!.data.idempotencyKey).toBe(creates[0]!.data.idempotencyKey);
  });

  it("closed by the parent while pending → reopen → a late failure shows nothing on the new draft", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await click(submitButton());
    await setOpen(h, false);
    await setOpen(h, true);
    await rejectCreate(new Error("network"), 0);
    expect(dialog().textContent).not.toContain(en.conversation.prepareOrder.error.title);
    expect(submitButton()?.disabled).toBe(false);
  });

  it("a late success after the sheet is unmounted reports nothing", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await click(submitButton());
    await act(async () => root?.unmount());
    root = null;
    await act(async () => creates[0]!.resolve(serverDetail(creates[0]!.data, "APSA-2026-000101")));
    await settle();
    expect(h.created).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Conversation route — conversation → customer → order linkage
// ═══════════════════════════════════════════════════════════════════════════

describe("Conversation → order linkage (real route, mounted)", () => {
  const CONV_A = id("c001");
  const CONV_B = id("c002");
  const CUST_A = customer(id("e001"), "Sokha");
  const CUST_B = customer(id("e002"), "Dara");

  beforeEach(() => {
    conversations[CONV_A] = conversation(CONV_A, CUST_A.id);
    conversations[CONV_B] = conversation(CONV_B, CUST_B.id);
    customers[CUST_A.id] = CUST_A;
    customers[CUST_B.id] = CUST_B;
  });

  async function startOrder() {
    await click(button(en.conversation.actions.title), "actions");
    await click(buttonContaining(en.conversation.createOrder), "Create order row");
    await click(buttonContaining("Water", dialog()), "pick Water");
  }

  async function switchConversation(cid: string) {
    routeParams.id = cid;
    await rerender();
  }

  it("the order is created for THIS conversation's customer, with this conversation as provenance", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await startOrder();
    await click(submitButton());
    expect(creates).toHaveLength(1);
    expect(creates[0]!.data.customerId).toBe(CUST_A.id);
    expect(creates[0]!.data.sourceConversationRef).toBe(CONV_A);
    await resolveCreate(0, "APSA-2026-000201");
    expect(text()).toContain(en.createOrder.created.replace("{{code}}", "APSA-2026-000201"));
  });

  it("switching conversation discards the open draft: no stale lines reach the next customer", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await startOrder();
    expect(estimatedTotal()).toBe("៛5,000");
    await switchConversation(CONV_B);
    expect(document.querySelector("[role=dialog]")).toBeNull();

    await click(button(en.conversation.actions.title), "actions");
    await click(buttonContaining(en.conversation.createOrder), "Create order row");
    // A fresh, empty draft — not conversation A's Water line.
    expect(estimatedTotal()).toBeNull();
    await click(buttonContaining("Serum", dialog()), "pick Serum");
    await click(submitButton());
    expect(creates[0]!.data.customerId).toBe(CUST_B.id);
    expect(creates[0]!.data.sourceConversationRef).toBe(CONV_B);
  });

  it("a create still pending when the merchant switches conversation never lands on the new thread", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await startOrder();
    await click(submitButton());
    await switchConversation(CONV_B);
    await resolveCreate(0, "APSA-2026-000301");
    expect(text()).not.toContain(en.createOrder.created.replace("{{code}}", "APSA-2026-000301"));
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("a member/organization switch discards the draft too", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await startOrder();
    await click(submitButton());
    routeContext.organizationId = id("b002");
    await rerender();
    await resolveCreate(0, "APSA-2026-000401");
    expect(text()).not.toContain(en.createOrder.created.replace("{{code}}", "APSA-2026-000401"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Prototype CreateOrderSheet — the shared draft arithmetic
// ═══════════════════════════════════════════════════════════════════════════

describe("Create Order (prototype sheet, mounted) — shared draft arithmetic", () => {
  const PROTO_CUSTOMER = customer("cus-1", "Proto");

  async function mountCreate() {
    let open = true;
    await mount(() =>
      React.createElement(CreateOrderSheet, {
        open,
        onOpenChange: (next: boolean) => {
          open = next;
        },
        customer: PROTO_CUSTOMER as any,
        displayName: "Proto",
        channel: "facebook",
        onCreated: () => {},
      }),
    );
  }

  const discountInput = () =>
    [...dialog().querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === en.createOrder.discount,
    ) as HTMLInputElement | null;
  const deliveryInput = () =>
    [...dialog().querySelectorAll("input")].find(
      (i) => i.getAttribute("aria-label") === en.createOrder.delivery,
    ) as HTMLInputElement | null;

  /** The Total row's big figure. */
  function total(): string | undefined {
    const label = [...dialog().querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === en.createOrder.total,
    );
    return label?.parentElement?.querySelector(".text-financial-lg")?.textContent?.trim();
  }

  async function pick(name: string, quantity: number) {
    await click(buttonContaining(name, dialog()), `product ${name}`);
    for (let q = 1; q < quantity; q++) await click(button(en.common.increase, dialog()));
  }

  async function enableDiscount(mode: "amount" | "percent") {
    const sw = dialog().querySelector("button[role=switch]") as HTMLButtonElement;
    await click(sw, "discount switch");
    await click(
      button(
        mode === "amount" ? en.createOrder.discountAmount : en.createOrder.discountPercent,
        dialog(),
      ),
    );
  }

  it("KHR: 2 × ៛50,000 renders ៛100,000 with a dollar hint, never a riel-as-cents figure", async () => {
    await mountCreate();
    await pick("Noodles", 2);
    expect(total()).toBe("៛100,000");
    expect(dialog().textContent).toContain("≈ $24.39");
  });

  it("KHR: a fixed riel discount and a riel delivery fee stay riel end to end", async () => {
    await mountCreate();
    await pick("Noodles", 2);
    await enableDiscount("amount");
    await type(discountInput(), "1,000");
    await type(deliveryInput(), "2,000");
    expect(total()).toBe("៛101,000");

    await click(button(en.createOrder.submit, dialog()));
    expect(prototypeCreates).toHaveLength(1);
    const sent = prototypeCreates[0];
    expect(sent.subtotal).toEqual({ amount: 100000, currency: "KHR" });
    expect(sent.discount).toEqual({ amount: 1000, currency: "KHR" });
    expect(sent.deliveryFee).toEqual({ amount: 2000, currency: "KHR" });
    expect(sent.total).toEqual({ amount: 101000, currency: "KHR" });
    expect(sent.items[0].unitPrice).toEqual({ amount: 50000, currency: "KHR" });
  });

  it("KHR: a percentage discount is a percentage of riel", async () => {
    await mountCreate();
    await pick("Noodles", 2);
    await enableDiscount("percent");
    await type(discountInput(), "10");
    expect(total()).toBe("៛90,000");
  });

  it("USD unchanged: 2 × $20.00 − $5.25 + $1.50 = $36.25, all cents", async () => {
    await mountCreate();
    await pick("Lipstick", 2);
    await enableDiscount("amount");
    await type(discountInput(), "5.25");
    await type(deliveryInput(), "1.50");
    expect(total()).toBe("$36.25");
    await click(button(en.createOrder.submit, dialog()));
    expect(prototypeCreates[0].total).toEqual({ amount: 3625, currency: "USD" });
    expect(prototypeCreates[0].discount).toEqual({ amount: 525, currency: "USD" });
    expect(prototypeCreates[0].deliveryFee).toEqual({ amount: 150, currency: "USD" });
  });

  it("malformed or oversized discounts are refused, never clamped, and block submit", async () => {
    await mountCreate();
    await pick("Lipstick", 1);
    await enableDiscount("amount");
    await type(discountInput(), "1,5");
    expect(total()).toBe("$20.00");
    expect(button(en.createOrder.submit, dialog())?.disabled).toBe(true);
    await type(discountInput(), "25");
    expect(dialog().textContent).toContain(en.pos.discount.exceedsSubtotal);
    expect(button(en.createOrder.submit, dialog())?.disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Replay identity outlives the sheet (PR #118 review P2 #1)
// ═══════════════════════════════════════════════════════════════════════════
//
// The conversation route remounts the Prepare Order sheet whenever the
// conversation, member or organization changes. A create whose outcome is
// still unknown must keep its idempotency key across that remount — otherwise
// "navigate away, come back, retry the same order" mints a second key and the
// server, correctly, creates a SECOND order.

describe("Replay identity across conversation navigation (real route, mounted)", () => {
  const CONV_A = id("c001");
  const CONV_B = id("c002");
  const CUST_A = customer(id("e001"), "Sokha");
  const CUST_B = customer(id("e002"), "Dara");

  beforeEach(() => {
    conversations[CONV_A] = conversation(CONV_A, CUST_A.id);
    conversations[CONV_B] = conversation(CONV_B, CUST_B.id);
    customers[CUST_A.id] = CUST_A;
    customers[CUST_B.id] = CUST_B;
  });

  async function openOrder(productName = "Water") {
    await click(button(en.conversation.actions.title), "actions");
    await click(buttonContaining(en.conversation.createOrder), "Create order row");
    await click(buttonContaining(productName, dialog()), `pick ${productName}`);
  }

  async function goTo(cid: string) {
    routeParams.id = cid;
    await rerender();
  }

  const keyOf = (i: number) => creates[i]!.data.idempotencyKey as string;

  it("A: pending in A → B → back to A → identical retry re-sends the SAME key", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    await goTo(CONV_B);
    await goTo(CONV_A);
    await openOrder();
    await click(submitButton());
    expect(creates).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(creates[1]!.data.items).toEqual(creates[0]!.data.items);
  });

  it("B: committed server-side, response lost → away and back → retry is REPLAYED, not duplicated", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    await goTo(CONV_B);
    // A's request reaches the server and commits; the browser never hears.
    await commitButLoseResponse(0);
    expect(committedOrders).toBe(1);

    await goTo(CONV_A);
    await openOrder();
    await click(submitButton());
    expect(keyOf(1)).toBe(keyOf(0));
    await resolveCreate(1);
    // One order on the server, and the merchant is shown THAT order.
    expect(committedOrders).toBe(1);
    const shown = committedByKey.get(keyOf(0)).orderNumber;
    expect(text()).toContain(en.createOrder.created.replace("{{code}}", shown));
  });

  it("C: pending in A → B → back to A → a CHANGED request gets a new key (no stale replay)", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    await goTo(CONV_B);
    await goTo(CONV_A);
    await openOrder();
    await click(button(en.common.increase, dialog()));
    await click(submitButton());
    expect(creates[1]!.data.items[0].quantity).toBe(2);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("D: a member switch makes the old member's replay identity unreachable", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    const original = routeContext.session.userId;
    routeContext.session.userId = id("a999");
    await rerender();
    await openOrder();
    await click(submitButton());
    expect(keyOf(1)).not.toBe(keyOf(0));
    // …and it is still the ORIGINAL member's, intact, when they return.
    routeContext.session.userId = original;
    await rerender();
    await openOrder();
    await click(submitButton());
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it("E: an organization switch makes the old organization's replay identity unreachable", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    routeContext.organizationId = id("b002");
    await rerender();
    await openOrder();
    await click(submitButton());
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("F: conversation A's replay identity is never used for conversation B", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    await goTo(CONV_B);
    await openOrder();
    await click(submitButton());
    expect(creates[1]!.data.customerId).toBe(CUST_B.id);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("G: an ACCEPTED order retires its key — the next identical order is a new order, even after a remount", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton());
    await resolveCreate(0, "APSA-2026-000501");
    await goTo(CONV_B);
    await goTo(CONV_A);
    await openOrder();
    await click(submitButton());
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("H: an abandoned attempt's late success cannot retire the key a newer identical attempt owns", async () => {
    await mount(() => React.createElement(ConversationScreen));
    await openOrder();
    await click(submitButton()); // attempt 1 (abandoned below)
    await goTo(CONV_B);
    await goTo(CONV_A);
    await openOrder();
    await click(submitButton()); // attempt 2 — same key, now its owner
    expect(keyOf(1)).toBe(keyOf(0));
    await resolveCreate(0, "APSA-2026-000601"); // attempt 1 lands late, unmounted
    await rejectCreate(new TypeError("Failed to fetch"), 1); // attempt 2 lost
    await click(submitButton()); // retry of attempt 2
    expect(keyOf(2)).toBe(keyOf(0));
    await resolveCreate(2);
    expect(committedOrders).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Confirm / discard never corrupt each other's busy state (review P2 #2)
// ═══════════════════════════════════════════════════════════════════════════

describe("Confirm and discard on a created draft (production sheet, mounted)", () => {
  const confirmLabel = en.conversation.prepareOrder.confirmOrder;
  const confirmingLabel = en.conversation.prepareOrder.confirming;
  const discardLabel = en.conversation.prepareOrder.discardDraft;
  const discardingLabel = en.conversation.prepareOrder.discardingDraft;

  async function createDraft(h: SheetHarness) {
    await click(submitButton(), "Create draft");
    await resolveCreate(
      creates.length - 1,
      `APSA-2026-0007${String(creates.length).padStart(2, "0")}`,
    );
    expect(button(confirmLabel, dialog())?.disabled).toBe(false);
    void h;
  }

  async function settleTransition(index: number, to: "confirmed" | "cancelled", ok = true) {
    const pending = transitions[index]!;
    await act(async () => {
      if (!ok) {
        pending.reject(new Error("network"));
        return;
      }
      const base = committedByKey.values().next().value ?? serverDetail(creates[0]!.data, "X");
      pending.resolve({ ...base, lifecycleStatus: to === "confirmed" ? "confirmed" : "cancelled" });
    });
    await settle(6);
  }

  /** The legitimate next draft can be confirmed: a live "Confirm order" button, nothing busy. */
  async function nextDraftConfirmable(h: SheetHarness) {
    expect(submitButton()?.disabled).toBe(false);
    await createDraft(h);
    const confirm = button(confirmLabel, dialog());
    expect(confirm?.disabled).toBe(false);
    expect(button(confirmingLabel, dialog())).toBeUndefined();
    expect(button(discardingLabel, dialog())).toBeUndefined();
    const before = transitions.length;
    await click(confirm, "Confirm");
    expect(transitions.length).toBe(before + 1);
    expect(transitions[before]!.data.to).toBe("confirmed");
  }

  it("Codex repro: confirm pending → discard attempt → confirm rejects → next draft is NOT stuck 'Confirming…'", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()), "Confirm");
    expect(button(confirmingLabel, dialog())).toBeDefined();
    // Discard is unavailable while the confirm is in flight.
    const discard = button(discardLabel, dialog());
    expect(discard?.disabled).toBe(true);
    await click(discard);
    expect(transitions.map((t) => t.data.to)).toEqual(["confirmed"]);
    await settleTransition(0, "confirmed", false);
    expect(dialog().textContent).toContain(en.conversation.prepareOrder.error.title);
    // Now discard is available, succeeds, and the next draft confirms.
    await click(button(discardLabel, dialog()), "Discard");
    expect(transitions[1]!.data.to).toBe("cancelled");
    await settleTransition(1, "cancelled");
    await nextDraftConfirmable(h);
  });

  it("Codex sequence verbatim: tap Discard during a pending confirm, cancel OK, confirm fails → next draft is not stuck", async () => {
    // Drives exactly the reported sequence and asserts only the outcome, so
    // it holds whether the overlapping Discard tap is refused (this design)
    // or accepted (the old one, where it left "Confirming…" stuck forever).
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()), "Confirm");
    const discard = button(discardLabel, dialog());
    if (discard && !discard.disabled) await click(discard);
    const cancelIndex = transitions.findIndex((t) => t.data.to === "cancelled");
    if (cancelIndex >= 0) await settleTransition(cancelIndex, "cancelled");
    await settleTransition(0, "confirmed", false);
    if (!submitButton()) {
      // The overlapping tap was refused: discard now, as the merchant would.
      await click(button(discardLabel, dialog()), "Discard");
      await settleTransition(transitions.length - 1, "cancelled");
    }
    await nextDraftConfirmable(h);
  });

  it("A: confirm pending → discard is refused, and nothing is cancelled", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()));
    expect(button(discardLabel, dialog())?.disabled).toBe(true);
    await settleTransition(0, "confirmed");
    expect(dialog().textContent).toContain(en.conversation.prepareOrder.confirmed);
    expect(transitions).toHaveLength(1);
  });

  it("B: discard pending → confirm is refused, and nothing is confirmed", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(discardLabel, dialog()));
    expect(button(discardingLabel, dialog())).toBeDefined();
    const confirm = button(confirmLabel, dialog());
    expect(confirm?.disabled).toBe(true);
    await click(confirm);
    expect(transitions.map((t) => t.data.to)).toEqual(["cancelled"]);
    await settleTransition(0, "cancelled");
    await nextDraftConfirmable(h);
  });

  it("C: confirm failure → retry the confirm on the same draft", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()));
    await settleTransition(0, "confirmed", false);
    expect(button(confirmLabel, dialog())?.disabled).toBe(false);
    expect(button(discardLabel, dialog())?.disabled).toBe(false);
    await click(button(confirmLabel, dialog()));
    await settleTransition(1, "confirmed");
    expect(dialog().textContent).toContain(en.conversation.prepareOrder.confirmed);
  });

  it("D: discard failure (best-effort) → back to review, next draft confirms", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(discardLabel, dialog()));
    await settleTransition(0, "cancelled", false);
    await nextDraftConfirmable(h);
  });

  it("E/F: confirm success, and discard success then a confirmable next draft", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(discardLabel, dialog()));
    await settleTransition(0, "cancelled");
    await nextDraftConfirmable(h);
    await settleTransition(1, "confirmed");
    expect(h.confirmed).toHaveLength(1);
    expect(dialog().textContent).toContain(en.conversation.prepareOrder.confirmed);
  });

  it("G/I: confirm pending → close → reopen → new draft; the stale confirm's failure cannot leave it busy", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()));
    await closeSheet(h);
    await setOpen(h, true);
    await createDraft(h);
    await settleTransition(0, "confirmed", false); // the OLD confirm, late
    expect(dialog().textContent).not.toContain(en.conversation.prepareOrder.error.title);
    expect(button(confirmLabel, dialog())?.disabled).toBe(false);
    expect(h.confirmed).toHaveLength(0);
  });

  it("G/I: discard pending → close → reopen → new draft; the stale discard cannot reset the new draft", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(discardLabel, dialog()));
    await closeSheet(h);
    await setOpen(h, true);
    await createDraft(h);
    await settleTransition(0, "cancelled"); // the OLD discard, late
    // Still on the new draft's created step, confirmable.
    expect(button(confirmLabel, dialog())?.disabled).toBe(false);
  });

  it("G: a stale confirm SUCCESS after reopen does not mark the new draft confirmed", async () => {
    const h = sheetHarness([{ product: WATER, quantity: 1 }]);
    await mountSheet(h);
    await createDraft(h);
    await click(button(confirmLabel, dialog()));
    await closeSheet(h);
    await setOpen(h, true);
    await createDraft(h);
    await settleTransition(0, "confirmed");
    expect(dialog().textContent).not.toContain(en.conversation.prepareOrder.confirmed);
    expect(h.confirmed).toHaveLength(0);
  });
});

describe("Confirm / discard across a conversation or member switch (real route, mounted)", () => {
  const CONV_A = id("c001");
  const CONV_B = id("c002");
  const CUST_A = customer(id("e001"), "Sokha");
  const CUST_B = customer(id("e002"), "Dara");

  beforeEach(() => {
    conversations[CONV_A] = conversation(CONV_A, CUST_A.id);
    conversations[CONV_B] = conversation(CONV_B, CUST_B.id);
    customers[CUST_A.id] = CUST_A;
    customers[CUST_B.id] = CUST_B;
  });

  async function draftIn() {
    await click(button(en.conversation.actions.title), "actions");
    await click(buttonContaining(en.conversation.createOrder), "Create order row");
    await click(buttonContaining("Water", dialog()), "pick Water");
    await click(submitButton());
    await resolveCreate(
      creates.length - 1,
      `APSA-2026-0008${String(creates.length).padStart(2, "0")}`,
    );
  }

  for (const sw of ["conversation", "member"] as const) {
    it(`J: confirm pending → ${sw} switch → back → the next draft confirms (no stuck busy state)`, async () => {
      await mount(() => React.createElement(ConversationScreen));
      const original = { id: routeParams.id, user: routeContext.session.userId };
      // Visit the other side first so it is CACHED (Codex's reproduction):
      // the switch then renders it immediately, with no loading gap that
      // would unmount the sheet for us.
      const goOther = async () => {
        if (sw === "conversation") routeParams.id = CONV_B;
        else routeContext.session.userId = id("a998");
        await rerender();
      };
      const goBack = async () => {
        routeParams.id = original.id;
        routeContext.session.userId = original.user;
        await rerender();
      };
      await goOther();
      await goBack();
      await draftIn();
      await click(button(en.conversation.prepareOrder.confirmOrder, dialog()), "Confirm");
      await goOther();
      // On the other side: nothing from A's draft is showing.
      expect(text()).not.toContain(en.conversation.prepareOrder.confirming);
      routeParams.id = original.id;
      routeContext.session.userId = original.user;
      await rerender();
      await act(async () => transitions[0]!.reject(new Error("network")));
      await settle(6);
      await draftIn();
      expect(button(en.conversation.prepareOrder.confirmOrder, dialog())?.disabled).toBe(false);
      expect(button(en.conversation.prepareOrder.confirming, dialog())).toBeUndefined();
    });
  }
});
