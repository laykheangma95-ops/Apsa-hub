/**
 * POS — payment-entry session and order-replay-key OWNERSHIP, mounted
 * (PR #117 final review, two P2 merge-gate findings).
 *
 * Mounts the REAL production <PosScreen> (src/routes/app.pos.tsx) with its real
 * <PosCheckoutSheet> and real <RecordOrderPaymentSheet>, in happy-dom.
 *
 * Unlike pos-money-mounted.runtime.ts, `createRealOrder` is NOT replaced: the
 * real adapter (src/lib/api/index.ts) and the real key holder
 * (src/lib/idempotency.ts) run, and only the server function below them
 * (`@/api/orders` createOrderFn) is simulated. The simulation keeps
 * migration 044's replay contract — a request COMMITS when it arrives (one
 * order per key, same key + same request replays that order, same key + a
 * different request is a conflict) and its RESPONSE is delivered, lost or
 * held back by the test. So a duplicate order is counted exactly where the
 * real server would create one.
 *
 *   P2 #1  a stale payment response never mutates a newer payment session
 *   P2 #2  a stale checkout attempt never releases replay protection that a
 *          newer identical attempt owns
 *
 * Runs in its own process (pos-payment-idempotency-mounted.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/pos" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Router: only the hooks POS's tree touches ────────────────────────────────

const USER_A = "3f2504e0-4f89-41d3-9a0c-00000000a001";
const ORG_A = "3f2504e0-4f89-41d3-9a0c-00000000b001";
const routeContext = { session: { userId: USER_A }, organizationId: ORG_A };
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

// ── Catalog ──────────────────────────────────────────────────────────────────

const id = (suffix: string) => `3f2504e0-4f89-41d3-9a0c-${suffix.padStart(12, "0")}`;

function product(pid: string, nameEn: string, price: { amount: number; currency: "USD" | "KHR" }) {
  return {
    id: pid,
    nameKm: nameEn,
    nameEn,
    sku: `SKU-${nameEn}`,
    price,
    stock: 50,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: pid.replace("-0000000000", "-0000000001"),
  };
}

const CATALOG = [
  product(id("a1"), "Serum", { amount: 2000, currency: "USD" }),
  product(id("b1"), "Water", { amount: 5000, currency: "KHR" }),
];

// ── Server simulation BELOW the real createRealOrder adapter ─────────────────

interface ServerOrder {
  detail: any;
  fingerprint: string;
}
/** Orders that exist server-side, by id. */
const serverOrders = new Map<string, ServerOrder>();
/** Migration 044's key table: idempotency key → order id. */
const serverKeys = new Map<string, string>();
let orderSeq = 0;

interface CreateCall {
  data: any;
  /** The commit outcome, decided when the request ARRIVED. */
  outcome: { orderId: string } | { conflict: true } | { notCommitted: true };
  deliver: () => Promise<void>;
  lose: () => Promise<void>;
}
const createCalls: CreateCall[] = [];
/** Next create request never reaches the server (connection refused before commit). */
let refuseNextCreate = false;

function serverDetail(
  orderId: string,
  data: any,
  lifecycleStatus: string,
  paymentStatus = "unpaid",
) {
  const lines = data.items.map((item: any) => {
    const p = CATALOG.find((c) => c.variantId === item.variantId)!;
    return { price: p.price, quantity: item.quantity };
  });
  const currency = lines[0].price.currency;
  const subtotal = lines.reduce((s: number, l: any) => s + l.price.amount * l.quantity, 0);
  const discount = data.discountMinor ?? 0;
  const money = (amount: number) => ({ amount, currency });
  return {
    id: orderId,
    organizationId: ORG_A,
    orderNumber: `APSA-ORD-${String(orderSeq).padStart(6, "0")}`,
    customerId: null,
    locationId: null,
    source: "POS",
    currency,
    subtotal: money(subtotal),
    discount: money(discount),
    delivery: money(0),
    total: money(subtotal - discount),
    lifecycleStatus,
    paymentStatus,
    refundStatus: "none",
    fulfillmentStatus: "unfulfilled",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sourceConversationRef: null,
    items: [],
    statusHistory: [],
  };
}

function requestFingerprint(data: any): string {
  const { idempotencyKey: _key, ...rest } = data;
  return JSON.stringify(rest);
}

mock.module("../api/orders", () => ({
  createOrderFn: ({ data }: { data: any }) =>
    new Promise((resolve, reject) => {
      let outcome: CreateCall["outcome"];
      if (refuseNextCreate) {
        refuseNextCreate = false;
        outcome = { notCommitted: true };
      } else {
        const existing = serverKeys.get(data.idempotencyKey);
        const fingerprint = requestFingerprint(data);
        if (existing) {
          outcome =
            serverOrders.get(existing)!.fingerprint === fingerprint
              ? { orderId: existing } // replay: the order the key already made
              : { conflict: true };
        } else {
          orderSeq += 1;
          const orderId = id(`c${orderSeq}`);
          serverOrders.set(orderId, {
            detail: serverDetail(orderId, data, "draft"),
            fingerprint,
          });
          serverKeys.set(data.idempotencyKey, orderId);
          outcome = { orderId };
        }
      }
      createCalls.push({
        data,
        outcome,
        deliver: async () => {
          await act(async () => {
            if ("orderId" in outcome) resolve(serverOrders.get(outcome.orderId)!.detail);
            else if ("conflict" in outcome)
              reject(Object.assign(new Error("idempotency conflict"), { statusCode: 409 }));
            else reject(new Error("network failure"));
          });
          await settle();
        },
        lose: async () => {
          await act(async () => reject(new Error("network failure")));
          await settle();
        },
      });
    }),
}));

// ── Payment / reread boundary ────────────────────────────────────────────────

interface Pending<T> {
  input: any;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
const payments: Pending<any>[] = [];
const rereads: Pending<any>[] = [];
function deferred<T>(queue: Pending<T>[], input: any): Promise<T> {
  return new Promise<T>((resolve, reject) => queue.push({ input, resolve, reject }));
}

const realApi = await import("@/lib/api");
const { mapOrderDetailToUi } = await import("@/lib/orders");

function confirmedUi(orderId: string, paymentStatus = "unpaid") {
  const order = serverOrders.get(orderId)!;
  return mapOrderDetailToUi({
    ...order.detail,
    lifecycleStatus: "confirmed",
    paymentStatus,
  });
}

mock.module("@/lib/api", () => ({
  ...realApi,
  // createRealOrder is the REAL adapter (spread from realApi) — not replaced.
  getPosProducts: async () => CATALOG,
  lookupVariantByBarcode: async () => null,
  confirmRealOrder: async (orderId: string) => confirmedUi(orderId),
  getRealOrderDetail: (orderId: string) => deferred(rereads, { orderId }),
  recordRealPayment: (input: any) => deferred(payments, input),
  createSale: async () => {
    throw new Error("a production cart must never reach createSale");
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
const { createIdempotencyKeyHolder } = await import("@/lib/idempotency");
const PosScreen = (Route as any).component as () => React.ReactElement;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;
/** Cache invalidations issued from the payment path onwards (see markPaymentStart). */
let invalidations: unknown[][] = [];

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
      },
      React.createElement(PosScreen),
    ),
  );
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters: any, ...rest: any[]) => {
    invalidations.push(filters?.queryKey ?? []);
    return original(filters, ...rest);
  }) as typeof client.invalidateQueries;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await settle(8);
}

async function rerender() {
  await act(async () => root!.render(tree()));
  await settle();
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  createCalls.length = 0;
  payments.length = 0;
  rereads.length = 0;
  serverOrders.clear();
  serverKeys.clear();
  refuseNextCreate = false;
  invalidations = [];
  routeContext.session.userId = USER_A;
  routeContext.organizationId = ORG_A;
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";

function cartPanel(): HTMLElement {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("cart panel not mounted");
  return aside as HTMLElement;
}

async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

async function addProduct(name: string) {
  let row: Element | undefined;
  for (let attempt = 0; attempt < 40 && !row; attempt++) {
    row = [...document.querySelectorAll("main button, main [role=button]")].find((el) =>
      el.textContent?.includes(name),
    );
    if (!row) await settle(2);
  }
  if (!row) throw new Error(`no product ${name}; page: ${text().slice(0, 300)}`);
  await click(row, `product ${name}`);
}

function dialog(): HTMLElement | null {
  return document.querySelector("[role=dialog]") as HTMLElement | null;
}

function cartNames(): string[] {
  return [...cartPanel().querySelectorAll("li p.text-body")].map((p) => p.textContent!.trim());
}

async function openCheckout() {
  await click(buttonIn(cartPanel(), en.pos.checkout), "cart Checkout");
}

async function confirmSale() {
  await click(buttonIn(dialog()!, en.pos.confirmSale), "Confirm sale");
}

async function closeSheet() {
  const scrim = dialog()?.parentElement?.querySelector(":scope > button[aria-label]");
  await click(scrim, "sheet close");
}

/** Ring up one Serum and get to the confirmed-but-unpaid success screen. */
async function confirmedUnpaidSale() {
  await mount();
  await addProduct("Serum");
  await openCheckout();
  await confirmSale();
  await createCalls[0]!.deliver();
  expect(dialog()?.textContent).toContain(en.pos.success.title);
}

function paymentForm(): HTMLElement | null {
  const d = dialog();
  return d && d.querySelector("#order-payment-amount") ? d : null;
}

function amountInput(): HTMLInputElement | null {
  return document.querySelector("#order-payment-amount") as HTMLInputElement | null;
}

async function openPaymentForm() {
  await click(buttonIn(dialog()!, en.pos.success.recordPayment), "Record payment");
  expect(paymentForm()).not.toBeNull();
}

async function typeAmount(value: string) {
  const input = amountInput();
  if (!input) throw new Error("no payment amount field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function paymentSubmit(): HTMLButtonElement | undefined {
  const form = paymentForm();
  if (!form) return undefined;
  return (
    buttonIn(form, en.order.recordPaymentSheet.submit) ??
    buttonIn(form, en.order.recordPaymentSheet.working)
  );
}

async function submitPayment() {
  await click(
    buttonIn(paymentForm()!, en.order.recordPaymentSheet.submit),
    "Record payment submit",
  );
}

async function settlePayment(index: number, ok = true) {
  const pending = payments[index]!;
  await act(async () =>
    ok ? pending.resolve({ id: `pay-${index}` }) : pending.reject(new Error("network")),
  );
  await settle();
}

async function settleReread(index: number, paymentStatus = "pending_verification") {
  const pending = rereads[index]!;
  await act(async () => pending.resolve(confirmedUi(pending.input.orderId, paymentStatus)));
  await settle();
}

function markPaymentStart() {
  invalidations = [];
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 — a stale payment response never mutates a newer payment session
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #1: payment entry owns its own session", () => {
  it("J. a current payment still completes: form closes, caches refresh, order re-read and shown", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    markPaymentStart();
    await submitPayment();
    expect(payments).toHaveLength(1);
    expect(payments[0]!.input).toMatchObject({ amountMinor: 2000, method: "cash" });
    await settlePayment(0);
    expect(paymentForm()).toBeNull();
    expect(invalidations.length).toBeGreaterThan(0);
    expect(rereads).toHaveLength(1);
    await settleReread(0);
    // The server's re-read is shown: the order is no longer "unpaid", so the
    // record-payment step is no longer offered.
    expect(buttonIn(dialog()!, en.pos.success.recordPayment)).toBeUndefined();
  });

  it("A/E. pending → close → reopen → new input → OLD success: the new form and its input survive", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await closeSheet(); // close the payment form while the request is pending
    expect(paymentForm()).toBeNull();
    await openPaymentForm();
    await typeAmount("7.50");
    markPaymentStart();
    await settlePayment(0); // the OLD response arrives
    expect(paymentForm()).not.toBeNull();
    expect(amountInput()?.value).toBe("7.50");
    expect(paymentSubmit()?.disabled).toBe(false);
    expect(rereads).toHaveLength(0);
    expect(invalidations).toEqual([]);
  });

  it("D. pending → close → reopen (nothing typed) → old success: the reopened form stays open", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await closeSheet();
    await openPaymentForm();
    await settlePayment(0);
    expect(paymentForm()).not.toBeNull();
    expect(amountInput()?.value).toBe("");
    expect(rereads).toHaveLength(0);
  });

  it("B. pending → close → reopen → new input → OLD failure: no error, input kept, submit available", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await closeSheet();
    await openPaymentForm();
    await typeAmount("5");
    await settlePayment(0, false);
    expect(paymentForm()?.querySelector("[role=alert]")).toBeNull();
    expect(amountInput()?.value).toBe("5");
    expect(paymentSubmit()?.disabled).toBe(false);
  });

  it("C. a payment's re-read that resolves after the form was reopened is not applied", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await settlePayment(0); // current: form closes, re-read starts
    expect(paymentForm()).toBeNull();
    expect(rereads).toHaveLength(1);
    await openPaymentForm(); // a new payment session
    await typeAmount("3");
    await settleReread(0);
    expect(paymentForm()).not.toBeNull();
    expect(amountInput()?.value).toBe("3");
    await closeSheet();
    // The stale re-read never replaced the order shown.
    expect(buttonIn(dialog()!, en.pos.success.recordPayment)).toBeDefined();
  });

  it("F. old response after a NEW payment attempt: only the new attempt closes the form and re-reads", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment(); // attempt A
    await closeSheet();
    await openPaymentForm();
    await typeAmount("15");
    await submitPayment(); // attempt B
    expect(payments).toHaveLength(2);
    expect(payments[1]!.input.amountMinor).toBe(1500);
    markPaymentStart();
    await settlePayment(0); // late A
    expect(paymentForm()).not.toBeNull();
    expect(paymentSubmit()?.textContent).toBe(en.order.recordPaymentSheet.working);
    expect(rereads).toHaveLength(0);
    expect(invalidations).toEqual([]);
    await settlePayment(1); // current B
    expect(paymentForm()).toBeNull();
    expect(rereads).toHaveLength(1);
    expect(invalidations.length).toBeGreaterThan(0);
  });

  it("F'. old FAILURE after a new attempt: the new attempt is not shown an error", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await closeSheet();
    await openPaymentForm();
    await typeAmount("15");
    await submitPayment();
    await settlePayment(0, false);
    expect(paymentForm()?.querySelector("[role=alert]")).toBeNull();
    expect(paymentSubmit()?.textContent).toBe(en.order.recordPaymentSheet.working);
  });

  for (const [label, change] of [
    [
      "G. user switch",
      () => {
        routeContext.session.userId = "3f2504e0-4f89-41d3-9a0c-00000000a002";
      },
    ],
    [
      "H. organization switch",
      () => {
        routeContext.organizationId = "3f2504e0-4f89-41d3-9a0c-00000000b002";
      },
    ],
  ] as const) {
    it(`${label} while a payment is pending: its response touches nothing`, async () => {
      await confirmedUnpaidSale();
      await openPaymentForm();
      await typeAmount("20");
      await submitPayment();
      change();
      await rerender();
      markPaymentStart();
      await settlePayment(0);
      expect(rereads).toHaveLength(0);
      expect(invalidations).toEqual([]);
      expect(paymentForm()).toBeNull();
      expect(text()).not.toContain(en.pos.success.title);
    });
  }

  it("I. unmount while pending, then remount: the late response touches nothing", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await act(async () => root!.unmount());
    root = createRoot(container!);
    await act(async () => root!.render(tree()));
    await settle(8);
    markPaymentStart();
    await settlePayment(0);
    expect(rereads).toHaveLength(0);
    expect(invalidations).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it("closing CHECKOUT while a payment is pending also discards it", async () => {
    await confirmedUnpaidSale();
    await openPaymentForm();
    await typeAmount("20");
    await submitPayment();
    await closeSheet(); // payment form
    await closeSheet(); // checkout → sale finished
    markPaymentStart();
    await settlePayment(0);
    expect(rereads).toHaveLength(0);
    expect(dialog()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #2 — replay-key ownership through the REAL adapter and holder
// ═══════════════════════════════════════════════════════════════════════════

const keys = () => createCalls.map((c) => c.data.idempotencyKey as string);

describe("P2 #2: a stale checkout attempt never releases the current attempt's replay key", () => {
  it("A/G. same-cart retry after a refused request re-sends the same key", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    refuseNextCreate = true;
    await confirmSale();
    await createCalls[0]!.deliver(); // network failure, nothing committed
    expect(dialog()?.textContent).toContain(en.pos.orderError.title);
    await confirmSale();
    expect(keys()[1]).toBe(keys()[0]!);
    await createCalls[1]!.deliver();
    expect(serverOrders.size).toBe(1);
    expect(dialog()?.textContent).toContain(en.pos.success.title);
  });

  it("B/G. lost response (committed server-side) → retry: same key, the server replays the same order", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await createCalls[0]!.lose();
    await confirmSale();
    expect(keys()[1]).toBe(keys()[0]!);
    expect(createCalls[1]!.outcome).toEqual(createCalls[0]!.outcome);
    await createCalls[1]!.deliver();
    expect(serverOrders.size).toBe(1);
    expect(dialog()?.textContent).toContain(en.pos.success.title);
  });

  it("D/E/G/K. A pending → close → identical B → A succeeds late → B's response lost → retry: ONE order", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale(); // A takes key-1
    await closeSheet();
    await openCheckout();
    await confirmSale(); // identical B reuses key-1
    expect(keys()[1]).toBe(keys()[0]!);
    await createCalls[0]!.deliver(); // A resolves late — stale, ignored
    expect(cartNames()).toEqual(["Serum"]);
    await createCalls[1]!.lose(); // B reached the server; its response did not
    await confirmSale(); // B's retry
    expect(keys()[2]).toBe(keys()[0]!); // still key-1: A did not release it
    await createCalls[2]!.deliver();
    expect(serverOrders.size).toBe(1);
    expect(dialog()?.textContent).toContain(en.pos.success.title);
    expect(cartNames()).toEqual([]);
  });

  it("E'. A succeeds late while the reopened sheet is idle → identical B is answered with A's order", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await closeSheet();
    await createCalls[0]!.deliver(); // stale: not accepted, key stays protected
    await openCheckout();
    await confirmSale();
    expect(keys()[1]).toBe(keys()[0]!);
    await createCalls[1]!.deliver();
    expect(serverOrders.size).toBe(1);
    expect(dialog()?.textContent).toContain(en.pos.success.title);
  });

  it("F. A fails late while identical B is active → B's lost response → retry: ONE order", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await closeSheet();
    await openCheckout();
    await confirmSale();
    await createCalls[0]!.lose(); // A's late failure
    expect(buttonIn(dialog()!, en.pos.confirming)?.disabled).toBe(true); // B still pending
    await createCalls[1]!.lose();
    await confirmSale();
    expect(new Set(keys()).size).toBe(1);
    await createCalls[2]!.deliver();
    expect(serverOrders.size).toBe(1);
  });

  it("H. double tap sends one request", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    const confirm = buttonIn(dialog()!, en.pos.confirmSale)!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(createCalls).toHaveLength(1);
  });

  it("I/L. an accepted sale retires its key: an identical next sale is a NEW order", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await createCalls[0]!.deliver();
    await click(buttonIn(dialog()!, en.pos.success.newSale), "New sale");
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    expect(keys()[1]).not.toBe(keys()[0]!);
    await createCalls[1]!.deliver();
    expect(serverOrders.size).toBe(2);
  });

  for (const [label, change] of [
    [
      "J. user switch",
      () => {
        routeContext.session.userId = "3f2504e0-4f89-41d3-9a0c-00000000a002";
      },
    ],
    [
      "J. organization switch",
      () => {
        routeContext.organizationId = "3f2504e0-4f89-41d3-9a0c-00000000b002";
      },
    ],
  ] as const) {
    it(`${label}: the old principal's key never crosses, and its late response releases nothing`, async () => {
      await mount();
      await addProduct("Serum");
      await openCheckout();
      await confirmSale(); // old principal, key-1
      change();
      await rerender();
      await confirmSale(); // new principal: a new key
      expect(keys()[1]).not.toBe(keys()[0]!);
      await createCalls[0]!.deliver(); // old principal's late response
      await createCalls[1]!.lose();
      await confirmSale();
      expect(keys()[2]).toBe(keys()[1]!);
    });
  }
});

describe("P2 #2: holder ownership (the real src/lib/idempotency.ts)", () => {
  const fp = '{"items":[1]}';

  it("K. a superseded claim cannot retire the key its identical successor owns", () => {
    const holder = createIdempotencyKeyHolder();
    const a = holder.claim();
    const key1 = a.keyFor(fp);
    const b = holder.claim();
    expect(b.keyFor(fp)).toBe(key1);
    a.retire(); // stale
    expect(holder.claim().keyFor(fp)).toBe(key1);
  });

  it("L. the owning claim retires it; the next identical request gets a new key", () => {
    const holder = createIdempotencyKeyHolder();
    const a = holder.claim();
    const key1 = a.keyFor(fp);
    a.retire();
    expect(holder.claim().keyFor(fp)).not.toBe(key1);
  });

  it("C. a changed request under a new claim gets a new key; the old claim then retires nothing", () => {
    const holder = createIdempotencyKeyHolder();
    const a = holder.claim();
    const key1 = a.keyFor(fp);
    const b = holder.claim();
    const key2 = b.keyFor('{"items":[2]}');
    expect(key2).not.toBe(key1);
    a.retire();
    expect(holder.claim().keyFor('{"items":[2]}')).toBe(key2);
  });

  it("holder mode (other entry points): a late arrival cannot retire a newer identical call's key", async () => {
    const holder = createIdempotencyKeyHolder();
    const request = {
      source: "POS" as const,
      items: [{ variantId: CATALOG[0]!.variantId, quantity: 1 }],
      customerId: null,
    };
    const first = realApi.createRealOrder({ ...request, idempotency: holder });
    await settle(1);
    const second = realApi.createRealOrder({ ...request, idempotency: holder });
    const secondOutcome = second.then(
      () => "ok",
      (error: Error) => error.message,
    );
    await settle(1);
    expect(keys()[1]).toBe(keys()[0]!);
    await createCalls[0]!.deliver(); // late first arrival
    await first;
    await createCalls[1]!.lose();
    expect(await secondOutcome).toBe("network failure");
    const third = realApi.createRealOrder({ ...request, idempotency: holder });
    await settle(1);
    expect(keys()[2]).toBe(keys()[0]!);
    await createCalls[2]!.deliver();
    await third;
    expect(serverOrders.size).toBe(1);
  });
});
