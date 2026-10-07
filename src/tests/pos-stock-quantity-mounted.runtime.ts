/**
 * POS stock → quantity — MOUNTED behavioural regressions (V1 P2).
 *
 * The defect: every production product reaches POS with `stock: null` (the
 * catalog read carries no inventory figure — see mapServerProductToUi), and
 * the route built each cart line with `stock: Math.max(1, availableStock(p))`.
 * availableStock(null) returned a 0 "no cap" sentinel, Math.max turned it into
 * a real cap of 1, and the merchant could never sell two of anything.
 *
 * Mounts the REAL <PosScreen> (src/routes/app.pos.tsx) with its real cart,
 * variant sheet, stepper, scanner listener and checkout sheet, and drives it
 * the way a merchant does. Only the network (`@/lib/api`) and four router
 * hooks are replaced — same harness as pos-money-mounted.runtime.ts.
 *
 * Runs in its own process (pos-stock-quantity-mounted.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/pos" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

type Price = { amount: number; currency: "USD" | "KHR" };

/** A catalog row exactly as the production read maps it: stock is null. */
function product(n: string, nameEn: string, price: Price, stock: number | null = null) {
  return {
    id: id(`a${n}`),
    nameKm: nameEn,
    nameEn,
    sku: `SKU-${nameEn}`,
    price,
    stock,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: id(`e${n}`),
  };
}

const SERUM = product("1", "Serum", { amount: 2000, currency: "USD" });
const WATER = product("2", "Water", { amount: 5000, currency: "KHR" });
const RED = {
  variantId: id("e31"),
  name: "Red",
  sku: "SH-R",
  price: { amount: 1500, currency: "USD" },
};
const BLUE = {
  variantId: id("e32"),
  name: "Blue",
  sku: "SH-B",
  price: { amount: 1700, currency: "USD" },
};
const SHIRT = {
  ...product("3", "Shirt", RED.price as Price),
  variantId: RED.variantId,
  productionVariants: [RED, BLUE],
};
// Counted rows: only the /design mock catalog carries a stock number today, but
// the screen must honour one whenever it is present.
const COUNTED = product("4", "Counted", { amount: 1000, currency: "USD" }, 5);
const SINGLE = product("5", "Single", { amount: 1000, currency: "USD" }, 1);
const SOLDOUT = product("6", "Soldout", { amount: 1000, currency: "USD" }, 0);
// Every unit held for open orders: stockState says "available", none is sellable.
const HELD = { ...product("7", "Held", { amount: 1000, currency: "USD" }, 3), reserved: 3 };

const CATALOG = [SERUM, WATER, SHIRT, COUNTED, SINGLE, SOLDOUT, HELD];
const BARCODE = "885000111";

interface Pending {
  input: any;
  resolve: (value: any) => void;
}
const creates: Pending[] = [];
const confirms: Pending[] = [];

function orderFor(code: string, input: any, lifecycleStatus: "draft" | "confirmed") {
  const priceOf = (variantId: string) =>
    [...CATALOG, RED, BLUE].find((c: any) => c.variantId === variantId)!.price as Price;
  const currency = priceOf(input.items[0].variantId).currency;
  const subtotal = input.items.reduce(
    (s: number, item: any) => s + priceOf(item.variantId).amount * item.quantity,
    0,
  );
  const money = (amount: number) => ({ amount, currency });
  return {
    order: {
      id: id("f1"),
      code,
      customerId: null,
      channel: "pos",
      items: [],
      subtotal: money(subtotal),
      discount: money(0),
      deliveryFee: money(0),
      total: money(subtotal),
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
  lookupVariantByBarcode: async (code: string) =>
    code === BARCODE
      ? {
          product: SERUM,
          variant: { id: SERUM.variantId, sku: SERUM.sku, name: "", price: SERUM.price },
        }
      : null,
  createRealOrder: (input: any) => new Promise((resolve) => creates.push({ input, resolve })),
  confirmRealOrder: (orderId: string) =>
    new Promise((resolve) => confirms.push({ input: { orderId }, resolve })),
  getRealOrderDetail: async () => {
    throw new Error("not used");
  },
  recordRealPayment: async () => ({ id: "pay" }),
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
const PosScreen = (Route as any).component as () => React.ReactElement;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
          { permissions: ["orders.create", "orders.confirm", "payments.record"] },
          React.createElement(PosScreen),
        ),
      ),
    ),
  );
  await settle(8);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  creates.length = 0;
  confirms.length = 0;
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

function dialog(): HTMLElement | null {
  return document.querySelector("[role=dialog]") as HTMLElement | null;
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

async function productRow(name: string): Promise<HTMLButtonElement> {
  const label = en.pos.addToCartLabel.replace("{{name}}", name);
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = buttonIn(document.querySelector("main")!, label);
    if (row) return row;
    await settle(2);
  }
  throw new Error(`no product ${name}; page: ${text().slice(0, 300)}`);
}

async function tap(name: string) {
  await click(await productRow(name), `product ${name}`);
}

/** The cart line's <li> for a product name (and variant, when given). */
function cartLine(name: string, variant?: string): HTMLElement {
  const li = [...cartPanel().querySelectorAll("li")].find(
    (el) =>
      el.querySelector("p.text-body")?.textContent?.trim() === name &&
      (!variant || el.textContent?.includes(`${variant} · `)),
  );
  if (!li)
    throw new Error(`no cart line ${name} ${variant ?? ""}; cart: ${cartPanel().textContent}`);
  return li as HTMLElement;
}

function lineQuantity(name: string, variant?: string): number {
  return Number(cartLine(name, variant).querySelector("output")!.textContent);
}

function plus(scope: HTMLElement): HTMLButtonElement {
  return buttonIn(scope, en.common.increase)!;
}

async function increment(name: string, times: number, variant?: string) {
  for (let i = 0; i < times; i++) await click(plus(cartLine(name, variant)), "+");
}

/** Every catalog row's "N available" caption, by product name. */
function availabilityCaption(name: string): string | null {
  const label = en.pos.addToCartLabel.replace("{{name}}", name);
  const row = buttonIn(document.querySelector("main")!, label)!;
  const avail = en.pos.available.replace("{{count}}", "");
  const caption = [...row.querySelectorAll("span")].find(
    (s) => s.children.length === 0 && s.textContent?.includes(avail.trim()),
  );
  return caption?.textContent?.trim() ?? null;
}

async function checkoutAndConfirm() {
  await click(buttonIn(cartPanel(), en.pos.checkout), "cart Checkout");
  await click(buttonIn(dialog()!, en.pos.confirmSale), "Confirm sale");
}

async function scan(code: string) {
  await act(async () => {
    for (const key of [...code, "Enter"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
  });
  await settle(6);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("A. a null-stock (production) product is never capped at 1", () => {
  it("tap once, then + four times → quantity 5, + still enabled", async () => {
    await mount();
    await tap("Serum");
    expect(lineQuantity("Serum")).toBe(1);
    expect(plus(cartLine("Serum")).disabled).toBe(false);
    await increment("Serum", 4);
    expect(lineQuantity("Serum")).toBe(5);
    expect(plus(cartLine("Serum")).disabled).toBe(false);
  });

  it("tapping the same product three times (double add / repeat tap) → 3", async () => {
    await mount();
    await tap("Serum");
    await tap("Serum");
    await tap("Serum");
    expect(lineQuantity("Serum")).toBe(3);
  });

  it("scanning the same barcode twice → 2", async () => {
    await mount();
    await scan(BARCODE);
    expect(lineQuantity("Serum")).toBe(1);
    await scan(BARCODE);
    expect(lineQuantity("Serum")).toBe(2);
  });

  it("rapid + up to 20 never resets or caps", async () => {
    await mount();
    await tap("Serum");
    await increment("Serum", 19);
    expect(lineQuantity("Serum")).toBe(20);
  });

  it("remove then re-add starts at 1 and still grows", async () => {
    await mount();
    await tap("Serum");
    await increment("Serum", 3);
    await click(
      buttonIn(cartPanel(), en.pos.cart.remove.replace("{{name}}", "Serum")),
      "remove Serum",
    );
    await tap("Serum");
    expect(lineQuantity("Serum")).toBe(1);
    await increment("Serum", 1);
    expect(lineQuantity("Serum")).toBe(2);
  });

  it("the catalog row does not claim '0 available' for a product with no stock figure", async () => {
    await mount();
    await productRow("Serum");
    expect(availabilityCaption("Serum")).toBeNull();
    expect((await productRow("Serum")).disabled).toBe(false);
  });
});

describe("B/G/H. the quantity survives checkout into the order request", () => {
  it("G. USD: Serum × 5 → payload quantity 5, cart total $100.00", async () => {
    await mount();
    await tap("Serum");
    await increment("Serum", 4);
    expect(cartPanel().textContent).toContain("$100.00");
    await checkoutAndConfirm();
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input.items).toEqual([
      { variantId: SERUM.variantId, quantity: 5, productId: SERUM.id },
    ]);
    // Money is still only the server's: no price is ever sent.
    expect(JSON.stringify(creates[0]!.input)).not.toContain("2000");
    await act(async () => creates[0]!.resolve(orderFor("POS-1", creates[0]!.input, "draft")));
    await settle();
    expect(confirms).toHaveLength(1);
  });

  it("H. KHR: Water × 5 → payload quantity 5, cart total ៛25,000", async () => {
    await mount();
    await tap("Water");
    await increment("Water", 4);
    expect(cartPanel().textContent).toContain("៛25,000");
    await checkoutAndConfirm();
    expect(creates[0]!.input.items).toEqual([
      { variantId: WATER.variantId, quantity: 5, productId: WATER.id },
    ]);
  });

  it("I. a mixed-currency cart with quantities > 1 still cannot check out", async () => {
    await mount();
    await tap("Serum");
    await increment("Serum", 2);
    await tap("Water");
    await increment("Water", 1);
    expect(lineQuantity("Serum")).toBe(3);
    expect(lineQuantity("Water")).toBe(2);
    expect(buttonIn(cartPanel(), en.pos.checkout)?.disabled ?? true).toBe(true);
    expect(creates).toHaveLength(0);
  });
});

describe("F. production variants (null stock) take quantities > 1 per variant", () => {
  it("sheet stepper to 4 for Red, then Blue × 2 from the sheet; both reach the payload", async () => {
    await mount();
    await tap("Shirt");
    const sheet = () => dialog()!;
    await click(
      buttonIn(sheet(), "Red") ??
        [...sheet().querySelectorAll("button")].find((b) => b.textContent?.includes("Red")),
      "Red",
    );
    for (let i = 0; i < 3; i++) await click(plus(sheet()), "sheet +");
    expect(sheet().querySelector("output")!.textContent).toBe("4");
    await click(buttonIn(sheet(), en.pos.addToCart), "Add to cart");

    await tap("Shirt");
    await click(
      [...sheet().querySelectorAll("button")].find((b) => b.textContent?.includes("Blue")),
      "Blue",
    );
    await click(plus(sheet()), "sheet +");
    await click(buttonIn(sheet(), en.pos.addToCart), "Add to cart");

    expect(lineQuantity("Shirt", "Red")).toBe(4);
    expect(lineQuantity("Shirt", "Blue")).toBe(2);
    await increment("Shirt", 2, "Red");
    expect(lineQuantity("Shirt", "Red")).toBe(6);

    await checkoutAndConfirm();
    expect(creates[0]!.input.items).toEqual([
      { variantId: RED.variantId, quantity: 6, productId: SHIRT.id },
      { variantId: BLUE.variantId, quantity: 2, productId: SHIRT.id },
    ]);
  });
});

describe("C/D/E. a counted product keeps its real cap; zero is never unlimited", () => {
  it("E. stock 5: + reaches 5 and is then disabled; a 6th tap does not add", async () => {
    await mount();
    await tap("Counted");
    await increment("Counted", 4);
    expect(lineQuantity("Counted")).toBe(5);
    expect(plus(cartLine("Counted")).disabled).toBe(true);
    await tap("Counted");
    expect(lineQuantity("Counted")).toBe(5);
    expect(availabilityCaption("Counted")).toBe(en.pos.available.replace("{{count}}", "5"));
  });

  it("D. stock 1: the line stays at 1", async () => {
    await mount();
    await tap("Single");
    expect(lineQuantity("Single")).toBe(1);
    expect(plus(cartLine("Single")).disabled).toBe(true);
    await tap("Single");
    expect(lineQuantity("Single")).toBe(1);
  });

  it("C. stock 0: the row is disabled, shows out of stock, and never enters the cart", async () => {
    await mount();
    const row = await productRow("Soldout");
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain(en.status.out_of_stock ?? "");
    await click(row, "Soldout");
    expect(cartPanel().textContent).not.toContain("Soldout");
  });
});

describe("C. fully reserved stock is none left, never unlimited", () => {
  it("stock 3, reserved 3: the row says 0 available, is disabled, and never enters the cart", async () => {
    await mount();
    const row = await productRow("Held");
    expect(availabilityCaption("Held")).toBe(en.pos.available.replace("{{count}}", "0"));
    expect(row.disabled).toBe(true);
    await click(row, "Held");
    expect(cartPanel().textContent).not.toContain("Held");
  });
});
