/**
 * POS money — MOUNTED behavioural regressions (PR #117 independent review).
 *
 * Mounts the REAL production <PosScreen> (src/routes/app.pos.tsx), with its
 * real <PosCart>, real <PosCheckoutSheet> and real React state, in happy-dom,
 * and drives it the way a merchant does: tap a product, toggle the discount,
 * type into the field, press Checkout / Confirm sale, close the sheet.
 *
 * Only two boundaries are replaced:
 *   - `@/lib/api` — the network. Product reads resolve immediately;
 *     createRealOrder / confirmRealOrder return DEFERRED promises the test
 *     settles by hand, so a response can be made to arrive late.
 *   - four TanStack Router hooks — there is no router in a unit process. The
 *     route's own component and route context are used as-is.
 *
 * Covers:
 *   P2 #1  a discount never survives a change of cart currency
 *   P2 #2  malformed discount text is refused in the mounted UI
 *   P2 #3  a late checkout response never mutates newer browser state
 *
 * Runs in its own process (pos-money-mounted.test.ts): it installs DOM
 * globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/pos" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Router: only the hooks POS's tree touches ────────────────────────────────

const routeContext = {
  session: { userId: "3f2504e0-4f89-41d3-9a0c-00000000a001" },
  organizationId: "3f2504e0-4f89-41d3-9a0c-00000000b001",
};
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

// ── Network boundary ─────────────────────────────────────────────────────────

const id = (suffix: string) => `3f2504e0-4f89-41d3-9a0c-${suffix.padStart(12, "0")}`;

function product(pid: string, nameEn: string, price: { amount: number; currency: "USD" | "KHR" }) {
  return {
    id: pid,
    nameKm: nameEn,
    nameEn,
    sku: `SKU-${nameEn}`,
    price,
    // A counted stock, high enough never to bound these tests. (null — the
    // production shape — no longer caps a line at 1; see
    // pos-stock-quantity-mounted.runtime.ts.)
    stock: 50,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: pid.replace("-0000000000", "-0000000001"),
  };
}

const CATALOG = [
  product(id("a1"), "Serum", { amount: 2000, currency: "USD" }),
  product(id("a2"), "Toner", { amount: 3000, currency: "USD" }),
  product(id("b1"), "Water", { amount: 5000, currency: "KHR" }),
  product(id("b2"), "Rice", { amount: 100000, currency: "KHR" }),
];

interface Pending<T> {
  input: any;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
const creates: Pending<any>[] = [];
const confirms: Pending<any>[] = [];

function deferred<T>(queue: Pending<T>[], input: any): Promise<T> {
  return new Promise<T>((resolve, reject) => queue.push({ input, resolve, reject }));
}

/** What the server would answer for a create: priced from the request lines. */
function orderFor(code: string, input: any, lifecycleStatus: "draft" | "confirmed") {
  const lines = input.items.map((item: any) => {
    const p = CATALOG.find((c) => c.variantId === item.variantId)!;
    return { price: p.price, quantity: item.quantity };
  });
  const currency = lines[0].price.currency;
  const subtotal = lines.reduce((s: number, l: any) => s + l.price.amount * l.quantity, 0);
  const discount = input.discountMinor ?? 0;
  const money = (amount: number) => ({ amount, currency });
  return {
    order: {
      id: id(code.replace(/\D/g, "").slice(-6) || "1"),
      code,
      customerId: null,
      channel: "pos",
      items: [],
      subtotal: money(subtotal),
      discount: money(discount),
      deliveryFee: money(0),
      total: money(subtotal - discount),
      paymentStatus: "unpaid",
      fulfillmentStatus: "unfulfilled",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: "pos",
      lifecycleStatus,
    },
    items: [],
  };
}

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getPosProducts: async () => CATALOG,
  lookupVariantByBarcode: async () => null,
  createRealOrder: (input: any) => deferred(creates, input),
  confirmRealOrder: (orderId: string) => deferred(confirms, { orderId }),
  getRealOrderDetail: async () => {
    throw new Error("not used");
  },
  recordRealPayment: async () => ({ id: "pay" }),
  createSale: async () => {
    throw new Error("a production cart must never reach createSale");
  },
}));

// ── Mount ────────────────────────────────────────────────────────────────────

/*
 * happy-dom's Web Animations cancel with an unhandled AbortError when motion
 * tears an exit animation down, which wedges React for every later mount. The
 * device is told it prefers reduced motion — the path POS already supports
 * (duration 0) — and motion is told to skip animating altogether.
 */
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
const sheetModule = await import("@/components/pos/PosCheckoutSheet");
const idempotencyModule = await import("@/lib/idempotency");
const posCartModule = await import("@/lib/pos-cart");
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await settle(8);
}

/** Re-render the same tree (no state reset) — a parent re-render / refresh tick. */
async function rerender() {
  await act(async () => root!.render(tree()));
  await settle();
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  creates.length = 0;
  confirms.length = 0;
  routeContext.session.userId = "3f2504e0-4f89-41d3-9a0c-00000000a001";
  routeContext.organizationId = "3f2504e0-4f89-41d3-9a0c-00000000b001";
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";

/** The desktop cart panel (always mounted; the phone sheet is the same <PosCart>). */
function cartPanel(): HTMLElement {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("cart panel not mounted");
  return aside as HTMLElement;
}

async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click`);
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

async function removeLine(name: string) {
  await click(
    buttonIn(cartPanel(), en.pos.cart.remove.replace("{{name}}", name)),
    `remove ${name}`,
  );
}

function discountSwitch(): HTMLButtonElement | undefined {
  return cartPanel().querySelector("button[role=switch]") as HTMLButtonElement | undefined;
}

async function enableDiscount(mode: "amount" | "percent") {
  const sw = discountSwitch();
  if (!sw) throw new Error("discount control not offered");
  if (sw.getAttribute("aria-checked") !== "true") await click(sw, "discount switch");
  await click(buttonIn(cartPanel(), en.pos.discount[mode]), `${mode} mode`);
}

function discountInput(): HTMLInputElement | null {
  return cartPanel().querySelector("input[aria-label]") as HTMLInputElement | null;
}

async function typeDiscount(value: string) {
  const input = discountInput();
  if (!input) throw new Error("no discount input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** The cart's footer rows: { Subtotal, Discount?, Total } as rendered text. */
function cartRows(): Record<string, string> {
  const rows: Record<string, string> = {};
  const footer = cartPanel().querySelector(".sticky.bottom-0");
  for (const row of footer?.querySelectorAll(":scope > div") ?? []) {
    const label = row.querySelector(".text-label")?.textContent?.trim();
    const value = row.querySelector(".text-body, .text-financial-lg")?.textContent?.trim();
    if (label && value) rows[label] = value;
  }
  return rows;
}

function cartCheckout(): HTMLButtonElement | undefined {
  return buttonIn(cartPanel(), en.pos.checkout);
}

function dialog(): HTMLElement | null {
  return document.querySelector("[role=dialog]") as HTMLElement | null;
}

async function openCheckout() {
  await click(cartCheckout(), "cart Checkout");
}

async function confirmSale() {
  await click(buttonIn(dialog()!, en.pos.confirmSale), "Confirm sale");
}

async function closeSheet() {
  // The scrim behind the panel — the sheet's own tap-outside close (Escape is
  // the keyboard path; both call the same onOpenChange(false)).
  const scrim = dialog()?.parentElement?.querySelector(":scope > button[aria-label]");
  await click(scrim, "sheet close");
}

function cartNames(): string[] {
  return [...cartPanel().querySelectorAll("li p.text-body")].map((p) => p.textContent!.trim());
}

async function resolveCreate(index: number, code: string) {
  const pending = creates[index]!;
  await act(async () => pending.resolve(orderFor(code, pending.input, "draft")));
  await settle();
}

async function resolveConfirm(index: number, code: string) {
  const pending = confirms[index]!;
  const create = creates.find((c) => c.input)!;
  await act(async () => pending.resolve(orderFor(code, create.input, "confirmed")));
  await settle();
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 #1 — a discount never survives a change of cart currency
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #1: a discount belongs to the currency it was entered for", () => {
  it("harness sanity: a USD fixed discount applies to its own USD cart", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    expect(cartRows()).toMatchObject({ Subtotal: "$20.00", Discount: "-$5.00", Total: "$15.00" });
  });

  it("A. USD fixed → KHR → back to USD: the old $5 never reactivates", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    await addProduct("Water"); // mixed
    await removeLine("Serum"); // KHR only
    expect(cartRows()).toEqual({ Subtotal: "៛5,000", Total: "៛5,000" });
    expect(discountSwitch()?.getAttribute("aria-checked")).toBe("false");
    await addProduct("Toner"); // mixed again
    await removeLine("Water"); // USD only again
    expect(cartRows()).toEqual({ Subtotal: "$30.00", Total: "$30.00" });
    expect(discountSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(discountInput()).toBeNull();
  });

  it("B. KHR fixed → USD: the old riel discount is cleared", async () => {
    await mount();
    await addProduct("Rice");
    await enableDiscount("amount");
    await typeDiscount("2,000");
    expect(cartRows()).toMatchObject({ Discount: "-៛2,000", Total: "៛98,000" });
    await addProduct("Serum");
    await removeLine("Rice");
    expect(cartRows()).toEqual({ Subtotal: "$20.00", Total: "$20.00" });
    await addProduct("Water");
    await removeLine("Serum");
    expect(cartRows()).toEqual({ Subtotal: "៛5,000", Total: "៛5,000" });
  });

  it("C. USD percent → replacement KHR basket: the percentage does not carry over", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("percent");
    await typeDiscount("50");
    expect(cartRows()).toMatchObject({ Discount: "-$10.00", Total: "$10.00" });
    await addProduct("Water");
    await removeLine("Serum");
    expect(cartRows()).toEqual({ Subtotal: "៛5,000", Total: "៛5,000" });
  });

  it("D. KHR percent → USD: the percentage does not carry over", async () => {
    await mount();
    await addProduct("Water");
    await enableDiscount("percent");
    await typeDiscount("10");
    expect(cartRows()).toMatchObject({ Discount: "-៛500" });
    await addProduct("Serum");
    await removeLine("Water");
    expect(cartRows()).toEqual({ Subtotal: "$20.00", Total: "$20.00" });
  });

  it("E/F. single → mixed clears it, and mixed → single does not bring it back", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    await addProduct("Water");
    expect(text()).toContain(en.pos.currency.mixedTitle);
    expect(cartCheckout()?.disabled).toBe(true);
    await removeLine("Water"); // back to the SAME currency it was entered for
    expect(cartRows()).toEqual({ Subtotal: "$20.00", Total: "$20.00" });
    expect(discountSwitch()?.getAttribute("aria-checked")).toBe("false");
  });

  it("G. clearing the cart, then a new-currency cart, starts with no discount", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    await removeLine("Serum");
    await addProduct("Water");
    expect(cartRows()).toEqual({ Subtotal: "៛5,000", Total: "៛5,000" });
    await removeLine("Water");
    await addProduct("Serum");
    expect(cartRows()).toEqual({ Subtotal: "$20.00", Total: "$20.00" });
  });

  it("H. quantity changes in one currency keep it; the removal that changes currency clears it", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    await addProduct("Serum"); // quantity 2, same currency
    expect(cartRows()).toMatchObject({ Subtotal: "$40.00", Discount: "-$5.00", Total: "$35.00" });
    await addProduct("Toner"); // still USD
    expect(cartRows()).toMatchObject({ Discount: "-$5.00", Total: "$65.00" });
    await addProduct("Water"); // mixed
    await removeLine("Water");
    expect(cartRows()).toEqual({ Subtotal: "$70.00", Total: "$70.00" });
  });

  it("I. re-rendering never resurrects a cleared discount", async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("5");
    await addProduct("Water");
    await removeLine("Water");
    await rerender();
    await rerender();
    expect(cartRows()).toEqual({ Subtotal: "$20.00", Total: "$20.00" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #2 — the text the merchant sees is the amount that is applied, or refused
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #2: malformed discount text is refused in the mounted cart", () => {
  for (const bad of [
    "1,5",
    "1,,5",
    ",15",
    "15,",
    "1,00",
    "2,00,0",
    "2,000,00",
    "1.2.3",
    "-5",
    "5$",
  ]) {
    it(`USD "${bad}" is refused: no discount, an explanation, checkout blocked`, async () => {
      await mount();
      await addProduct("Rice"); // ៛100,000 — keep a big subtotal so nothing is 'exceeds'
      await removeLine("Rice");
      await addProduct("Serum");
      await addProduct("Serum");
      await addProduct("Serum"); // $60.00
      await enableDiscount("amount");
      await typeDiscount(bad);
      expect(cartRows()).toEqual({ Subtotal: "$60.00", Total: "$60.00" });
      expect(cartPanel().querySelector("[role=alert]")?.textContent).toBe(
        en.pos.discount.invalidUsd,
      );
      expect(cartCheckout()?.disabled).toBe(true);
      // The field still shows exactly what was typed — nothing reinterpreted.
      expect(discountInput()?.value).toBe(bad);
    });
  }

  it('USD "2,000.50" is accepted as $2,000.50 only where it fits; "15.50" applies exactly', async () => {
    await mount();
    await addProduct("Serum");
    await enableDiscount("amount");
    await typeDiscount("15.50");
    expect(cartRows()).toMatchObject({ Discount: "-$15.50", Total: "$4.50" });
    await typeDiscount("2,000.50");
    expect(cartPanel().querySelector("[role=alert]")?.textContent).toBe(
      en.pos.discount.exceedsSubtotal,
    );
  });

  for (const bad of ["1,5", "15,", "1,000.5", "10.50", "2,00,0"]) {
    it(`KHR "${bad}" is refused`, async () => {
      await mount();
      await addProduct("Rice");
      await enableDiscount("amount");
      await typeDiscount(bad);
      expect(cartRows()).toEqual({ Subtotal: "៛100,000", Total: "៛100,000" });
      expect(cartPanel().querySelector("[role=alert]")?.textContent).toBe(
        en.pos.discount.invalidKhr,
      );
      expect(cartCheckout()?.disabled).toBe(true);
    });
  }

  it('KHR "15,000" and "2,000" apply as whole riel', async () => {
    await mount();
    await addProduct("Rice");
    await enableDiscount("amount");
    await typeDiscount("15,000");
    expect(cartRows()).toMatchObject({ Discount: "-៛15,000", Total: "៛85,000" });
    await typeDiscount("2,000");
    expect(cartRows()).toMatchObject({ Discount: "-៛2,000", Total: "៛98,000" });
    expect(cartCheckout()?.disabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #3 — a late checkout response never mutates newer browser state
// ═══════════════════════════════════════════════════════════════════════════

describe("P2 #3: late checkout responses", () => {
  it("I. a current attempt still completes normally: order shown, cart cleared", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    expect(creates).toHaveLength(1);
    await resolveCreate(0, "APSA-ORD-000101");
    expect(confirms).toHaveLength(1);
    await resolveConfirm(0, "APSA-ORD-000101");
    expect(dialog()?.textContent).toContain("APSA-ORD-000101");
    expect(dialog()?.textContent).toContain(en.pos.success.title);
    expect(cartNames()).toEqual([]);
  });

  it("A. closing while the create is pending: the late response leaves the cart alone", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await closeSheet();
    await resolveCreate(0, "APSA-ORD-000201");
    expect(cartNames()).toEqual(["Serum"]);
    expect(text()).not.toContain("APSA-ORD-000201");
    expect(dialog()).toBeNull();
    expect(confirms).toHaveLength(0); // no confirm is fired for an abandoned attempt
  });

  it("B/C. USD cart replaced by KHR while pending: the late USD order never clears or replaces it", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await closeSheet();
    await addProduct("Water");
    await removeLine("Serum");
    await resolveCreate(0, "APSA-ORD-000301");
    expect(cartNames()).toEqual(["Water"]);
    expect(cartRows()).toEqual({ Subtotal: "៛5,000", Total: "៛5,000" });
    expect(text()).not.toContain("APSA-ORD-000301");
    expect(cartPanel().textContent).not.toContain("$20.00");
  });

  it("F. reopening checkout: the old response does not take over the fresh sheet", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await closeSheet();
    await openCheckout();
    await resolveCreate(0, "APSA-ORD-000401");
    expect(dialog()?.textContent).not.toContain("APSA-ORD-000401");
    expect(buttonIn(dialog()!, en.pos.confirmSale)?.disabled).toBe(false);
    expect(cartNames()).toEqual(["Serum"]);
  });

  it("G/H. old response after a new attempt began: only the new attempt completes the sale", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale(); // attempt 1
    await closeSheet();
    await addProduct("Water");
    await removeLine("Serum");
    await openCheckout();
    await confirmSale(); // attempt 2 (KHR)
    expect(creates).toHaveLength(2);
    expect(creates[1]!.input.items[0].variantId).toBe(CATALOG[2]!.variantId);

    await resolveCreate(0, "APSA-ORD-000501"); // late attempt 1
    expect(text()).not.toContain("APSA-ORD-000501");
    expect(confirms).toHaveLength(0);
    expect(cartNames()).toEqual(["Water"]);

    await resolveCreate(1, "APSA-ORD-000502"); // current attempt 2
    expect(confirms).toHaveLength(1);
    await act(async () =>
      confirms[0]!.resolve(orderFor("APSA-ORD-000502", creates[1]!.input, "confirmed")),
    );
    await settle();
    expect(dialog()?.textContent).toContain("APSA-ORD-000502");
    expect(dialog()?.textContent).toContain("៛5,000");
    expect(cartNames()).toEqual([]);
  });

  it("H. two sequential successful sales each complete normally", async () => {
    await mount();
    for (const [index, code] of [
      [0, "APSA-ORD-000601"],
      [1, "APSA-ORD-000602"],
    ] as const) {
      await addProduct(index === 0 ? "Serum" : "Water");
      await openCheckout();
      await confirmSale();
      await resolveCreate(index, code);
      await act(async () =>
        confirms[index]!.resolve(orderFor(code, creates[index]!.input, "confirmed")),
      );
      await settle();
      expect(dialog()?.textContent).toContain(code);
      await click(buttonIn(dialog()!, en.pos.success.newSale), "New sale");
      expect(cartNames()).toEqual([]);
    }
  });

  it("a late CONFIRM after closing never repaints the sheet", async () => {
    await mount();
    await addProduct("Serum");
    await openCheckout();
    await confirmSale();
    await resolveCreate(0, "APSA-ORD-000701"); // current: cart cleared, draft shown
    await closeSheet();
    await addProduct("Water");
    await act(async () =>
      confirms[0]!.resolve(orderFor("APSA-ORD-000701", creates[0]!.input, "confirmed")),
    );
    await settle();
    expect(dialog()).toBeNull();
    expect(cartNames()).toEqual(["Water"]);
    // Reopening shows THIS cart's checkout — not the abandoned order's success.
    await openCheckout();
    expect(dialog()?.textContent).not.toContain("APSA-ORD-000701");
    expect(buttonIn(dialog()!, en.pos.confirmSale)?.disabled).toBe(false);
  });

  for (const [label, change] of [
    [
      "D. user switch",
      () => {
        routeContext.session.userId = "3f2504e0-4f89-41d3-9a0c-00000000a002";
      },
    ],
    [
      "E. organization switch",
      () => {
        routeContext.organizationId = "3f2504e0-4f89-41d3-9a0c-00000000b002";
      },
    ],
  ] as const) {
    it(`${label} while pending: the old principal's response never lands in the new session`, async () => {
      await mount();
      await addProduct("Serum");
      await openCheckout();
      await confirmSale();
      change();
      await rerender();
      await resolveCreate(0, "APSA-ORD-000801");
      expect(text()).not.toContain("APSA-ORD-000801");
      expect(confirms).toHaveLength(0);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 #3 — the real <PosCheckoutSheet> mounted directly, props changed under it
// ═══════════════════════════════════════════════════════════════════════════
//
// POS's own UI cannot change the cart while the (modal) sheet is open, so the
// sheet's cart binding is exercised by changing its props directly.

describe("P2 #3: <PosCheckoutSheet> bound to the cart it was submitted for", () => {
  const { PosCheckoutSheet } = sheetModule;
  const { calculateCartTotals, NO_DISCOUNT } = posCartModule;

  function cartLine(index: number, quantity = 1) {
    const p = CATALOG[index]!;
    return {
      key: p.id,
      productId: p.id,
      variantId: p.variantId,
      nameKm: p.nameKm,
      nameEn: p.nameEn,
      sku: p.sku,
      quantity,
      unitPrice: p.price,
      stock: 50,
    };
  }

  let setProps: (next: { lines: ReturnType<typeof cartLine>[]; userId: string }) => void;
  let completed = 0;

  function Harness() {
    const [replayHolders] = React.useState(() =>
      idempotencyModule.createScopedIdempotencyHolders(),
    );
    const [props, set] = React.useState({
      lines: [cartLine(0)],
      userId: "3f2504e0-4f89-41d3-9a0c-00000000a001",
    });
    setProps = set;
    return React.createElement(PosCheckoutSheet, {
      open: true,
      onOpenChange: () => {},
      lines: props.lines,
      totals: calculateCartTotals(props.lines, NO_DISCOUNT),
      customer: null,
      offline: false,
      onCompleted: () => {
        completed += 1;
      },
      userId: props.userId,
      organizationId: "3f2504e0-4f89-41d3-9a0c-00000000b001",
      // Owned above the sheet, as the POS screen owns it (src/routes/app.pos.tsx).
      replayHolders,
    });
  }

  async function mountSheet() {
    completed = 0;
    client = new QueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            CapabilityFixtureProvider,
            { permissions: ["orders.create", "orders.confirm"] },
            React.createElement(Harness),
          ),
        ),
      ),
    );
    await settle();
  }

  it("B. the cart changes while the create is pending: the response is discarded, the new cart can be sold", async () => {
    await mountSheet();
    await confirmSale();
    expect(buttonIn(dialog()!, en.pos.confirming)?.disabled).toBe(true);
    await act(async () =>
      setProps({ lines: [cartLine(2)], userId: "3f2504e0-4f89-41d3-9a0c-00000000a001" }),
    );
    await settle();
    await resolveCreate(0, "APSA-ORD-000901");
    expect(completed).toBe(0); // the newer cart was NOT cleared
    expect(confirms).toHaveLength(0);
    expect(dialog()?.textContent).not.toContain("APSA-ORD-000901");
    // The guard was released for the latest attempt, so the new cart can go.
    const confirm = buttonIn(dialog()!, en.pos.confirmSale);
    expect(confirm?.disabled).toBe(false);
    await click(confirm, "Confirm sale (new cart)");
    expect(creates).toHaveLength(2);
    expect(creates[1]!.input.items[0].variantId).toBe(CATALOG[2]!.variantId);
  });

  it("D. the member changes while pending: the old member's order never lands", async () => {
    await mountSheet();
    await confirmSale();
    await act(async () =>
      setProps({ lines: [cartLine(0)], userId: "3f2504e0-4f89-41d3-9a0c-00000000a009" }),
    );
    await settle();
    await resolveCreate(0, "APSA-ORD-000902");
    expect(completed).toBe(0);
    expect(dialog()?.textContent).not.toContain("APSA-ORD-000902");
    expect(confirms).toHaveLength(0);
  });

  it("I. unchanged props: the attempt completes and the cart is cleared exactly once", async () => {
    await mountSheet();
    await confirmSale();
    await resolveCreate(0, "APSA-ORD-000903");
    expect(completed).toBe(1);
    await resolveConfirm(0, "APSA-ORD-000903");
    expect(dialog()?.textContent).toContain("APSA-ORD-000903");
    expect(completed).toBe(1);
  });
});
