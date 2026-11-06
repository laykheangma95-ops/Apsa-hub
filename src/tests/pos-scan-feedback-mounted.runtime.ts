/**
 * POS scan feedback — MOUNTED. The real <PosScreen> (src/routes/app.pos.tsx)
 * with its real cart, scanner listener and notice, driven by wedge scans. Only
 * the network (`@/lib/api`), four router hooks and the sound module are
 * replaced; the sound mock counts calls instead of touching an audio device.
 *
 * Runs in its own process (pos-scan-feedback-mounted.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/pos" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ORG_A = "3f2504e0-4f89-41d3-9a0c-00000000b001";
const ORG_B = "3f2504e0-4f89-41d3-9a0c-00000000b002";
const routeContext = {
  session: { userId: "3f2504e0-4f89-41d3-9a0c-00000000a001" },
  organizationId: ORG_A,
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

const sound = { accepted: 0, prepared: 0 };
mock.module("@/lib/barcode/scan-sound", () => ({
  playAcceptedScanSound: () => {
    sound.accepted += 1;
  },
  prepareScanSound: () => {
    sound.prepared += 1;
  },
  resetScanSoundForTests: () => {},
}));

// ── Network boundary ─────────────────────────────────────────────────────────

const id = (suffix: string) => `3f2504e0-4f89-41d3-9a0c-${suffix.padStart(12, "0")}`;

function product(n: string, nameEn: string, stock: number | null) {
  return {
    id: id(`a${n}`),
    nameKm: nameEn,
    nameEn,
    sku: `SKU-${nameEn}`,
    price: { amount: 1000, currency: "USD" as const },
    stock,
    lowStockThreshold: 0,
    companion: "minto",
    variantId: id(`e${n}`),
  };
}

const SERUM = product("1", "Serum", null);
const PAIR = product("2", "Pair", 2);
const SOLDOUT = product("3", "Soldout", 0);
const CATALOG = [SERUM, PAIR, SOLDOUT];
const CODES: Record<string, (typeof CATALOG)[number]> = {
  "885000111": SERUM,
  "885000222": PAIR,
  "885000333": SOLDOUT,
};
const ERROR_CODE = "885000500";
const MISSING_CODE = "885000999";

/**
 * While `holdLookups` is set, each lookup waits in `heldLookups` until the test
 * releases it — a slow network. `productReads` counts every read of a result's
 * product: a lookup dropped as stale must never be read at all.
 */
let holdLookups = false;
const heldLookups: Array<{ code: string; release: () => void }> = [];
let productReads = 0;

function lookupResultFor(code: string) {
  if (code === ERROR_CODE) throw new Error("network down");
  const p = CODES[code];
  if (!p) return null;
  return {
    get product() {
      productReads += 1;
      return p;
    },
    variant: { id: p.variantId, sku: p.sku, name: "", price: p.price },
  };
}

function orderFor(input: any, lifecycleStatus: "draft" | "confirmed") {
  const money = (amount: number) => ({ amount, currency: "USD" });
  return {
    order: {
      id: id("f1"),
      code: "POS-1",
      customerId: null,
      channel: "pos",
      items: [],
      subtotal: money(1000),
      discount: money(0),
      deliveryFee: money(0),
      total: money(1000),
      paymentStatus: "unpaid",
      fulfillmentStatus: "unfulfilled",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: "pos",
      lifecycleStatus,
    },
    items: [],
    input,
  };
}

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getPosProducts: async () => CATALOG,
  lookupVariantByBarcode: (code: string) =>
    holdLookups
      ? new Promise((resolve, reject) => {
          heldLookups.push({
            code,
            release: () => {
              try {
                resolve(lookupResultFor(code));
              } catch (err) {
                reject(err);
              }
            },
          });
        })
      : Promise.resolve().then(() => lookupResultFor(code)),
  createRealOrder: async (input: any) => orderFor(input, "draft"),
  confirmRealOrder: async () => orderFor(null, "confirmed"),
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

let client: InstanceType<typeof QueryClient> | null = null;

function tree() {
  return React.createElement(
    QueryClientProvider,
    { client: client! },
    React.createElement(
      CapabilityFixtureProvider,
      { permissions: ["orders.create", "orders.confirm", "payments.record"] },
      React.createElement(PosScreen),
    ),
  );
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await settle(8);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  sound.accepted = 0;
  sound.prepared = 0;
  holdLookups = false;
  heldLookups.length = 0;
  productReads = 0;
  routeContext.organizationId = ORG_A;
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Page helpers ─────────────────────────────────────────────────────────────

function cartPanel(): HTMLElement {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("cart panel not mounted");
  return aside as HTMLElement;
}

function lineQuantity(name: string): number | null {
  const li = [...cartPanel().querySelectorAll("li")].find(
    (el) => el.querySelector("p.text-body")?.textContent?.trim() === name,
  );
  return li ? Number(li.querySelector("output")!.textContent) : null;
}

function notice(): string {
  return document.querySelector("[role=status][aria-live=polite]")?.textContent?.trim() ?? "";
}

function keys(code: string) {
  for (const key of [...code, "Enter"]) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }
}

async function scan(code: string, times = 1) {
  await act(async () => {
    for (let i = 0; i < times; i++) keys(code);
  });
  await settle(10);
}

async function tap(name: string) {
  const label = en.pos.addToCartLabel.replace("{{name}}", name);
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = [...document.querySelector("main")!.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
    );
    if (row) {
      await act(async () => (row as HTMLElement).click());
      await settle();
      return;
    }
    await settle(2);
  }
  throw new Error(`no product row ${name}`);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("POS scan feedback (mounted)", () => {
  it("a normal scan adds one unit, says Added and requests one sound", async () => {
    await mount();
    await scan("885000111");
    expect(lineQuantity("Serum")).toBe(1);
    expect(notice()).toBe(en.pos.scanAdded);
    expect(sound.accepted).toBe(1);
  });

  it("a second scan increments the same line and requests one more sound", async () => {
    await mount();
    await scan("885000111");
    await scan("885000111");
    expect(lineQuantity("Serum")).toBe(2);
    expect(sound.accepted).toBe(2);
  });

  it("a zero-stock scan adds nothing, says it was not added, and stays silent", async () => {
    await mount();
    await scan("885000333");
    expect(lineQuantity("Soldout")).toBeNull();
    expect(notice()).toBe(en.pos.scanLimitReached);
    expect(notice()).not.toBe(en.pos.scanAdded);
    expect(sound.accepted).toBe(0);
  });

  it("a scan at the stock limit changes nothing and stays silent", async () => {
    await mount();
    await scan("885000222");
    await scan("885000222");
    expect(lineQuantity("Pair")).toBe(2);
    expect(sound.accepted).toBe(2);
    await scan("885000222");
    expect(lineQuantity("Pair")).toBe(2);
    expect(notice()).toBe(en.pos.scanLimitReached);
    expect(sound.accepted).toBe(2);
  });

  it("five fast scans in one batch stop at stock 2 with exactly two sounds", async () => {
    await mount();
    await scan("885000222", 5);
    expect(lineQuantity("Pair")).toBe(2);
    expect(sound.accepted).toBe(2);
    expect(notice()).toBe(en.pos.scanLimitReached);
  });

  it("a lookup miss and a lookup error stay silent", async () => {
    await mount();
    await scan(MISSING_CODE);
    expect(notice()).toBe(en.pos.scanNotFound);
    await scan(ERROR_CODE);
    expect(notice()).toBe(en.pos.scanError);
    expect(sound.accepted).toBe(0);
  });

  it("tap-to-add still adds and caps as before, silently, and shares the cart with scans", async () => {
    await mount();
    await tap("Pair");
    expect(lineQuantity("Pair")).toBe(1);
    // The scan path sees the tapped unit: one more fits, the next does not.
    await scan("885000222");
    expect(lineQuantity("Pair")).toBe(2);
    await tap("Pair");
    expect(lineQuantity("Pair")).toBe(2);
    await scan("885000222");
    expect(lineQuantity("Pair")).toBe(2);
    expect(sound.accepted).toBe(1);
  });

  it("synthetic (untrusted) key events never prepare audio", async () => {
    await mount();
    await scan("885000111");
    expect(sound.prepared).toBe(0);
  });
});

// ── Sale boundaries vs. a lookup still in flight ─────────────────────────────

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

async function click(el: Element | null | undefined, label: string) {
  if (!el) throw new Error(`no ${label} to click`);
  await act(async () => (el as HTMLElement).click());
  await settle();
}

/** Start a wedge scan whose lookup is held until `release` is called. */
async function startHeldScan(code: string) {
  holdLookups = true;
  const before = heldLookups.length;
  await act(async () => keys(code));
  await settle(2);
  if (heldLookups.length !== before + 1) throw new Error("scan lookup did not start");
  const entry = heldLookups[heldLookups.length - 1]!;
  return async () => {
    await act(async () => entry.release());
    await settle(10);
  };
}

const cartLines = () => document.querySelector("aside")?.querySelectorAll("li").length ?? 0;

describe("POS scan vs. sale boundaries (mounted)", () => {
  it("a scan finishing within the same sale still adds and beeps", async () => {
    await mount();
    const release = await startHeldScan("885000111");
    await release();
    expect(lineQuantity("Serum")).toBe(1);
    expect(notice()).toBe(en.pos.scanAdded);
    expect(sound.accepted).toBe(1);
  });

  it("start a lookup, Clear cart (reset), release: cart empty, no notice, no beep", async () => {
    await mount();
    await tap("Pair");
    const release = await startHeldScan("885000111");
    await click(buttonIn(cartPanel(), en.pos.cart.clear), "Clear cart");
    expect(cartLines()).toBe(0);
    await release();
    expect(cartLines()).toBe(0);
    expect(lineQuantity("Serum")).toBeNull();
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
    expect(productReads).toBe(0);
  });

  it("start a lookup, complete checkout, release: the result never enters the next sale", async () => {
    await mount();
    await tap("Pair");
    const release = await startHeldScan("885000111");
    await click(buttonIn(cartPanel(), en.pos.checkout), "cart Checkout");
    const sheet = document.querySelector("[role=dialog]") as HTMLElement;
    await click(buttonIn(sheet, en.pos.confirmSale), "Confirm sale");
    await settle(10);
    // The order exists, so the sale is cleared (PosCheckoutSheet → onCompleted).
    expect(lineQuantity("Pair")).toBeNull();
    await release();
    expect(lineQuantity("Serum")).toBeNull();
    expect(cartLines()).toBe(0);
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
    expect(productReads).toBe(0);
  });

  it("start a lookup, change organization, release: no mutation, no feedback", async () => {
    await mount();
    const release = await startHeldScan("885000111");
    routeContext.organizationId = ORG_B;
    await act(async () => root!.render(tree()));
    await settle(8);
    await release();
    expect(cartLines()).toBe(0);
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
    expect(productReads).toBe(0);
  });

  it("start a lookup, unmount POS, release: nothing is read, committed or played", async () => {
    await mount();
    const release = await startHeldScan("885000111");
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await act(async () => root!.unmount());
      root = null;
      await release();
    } finally {
      console.error = originalError;
    }
    // The resolver stopped before touching the result: no cart line was built,
    // no commit, no notice, and the sound (so no AudioContext) was never asked for.
    expect(productReads).toBe(0);
    expect(sound.accepted).toBe(0);
    expect(sound.prepared).toBe(0);
    expect(errors).toEqual([]);
  });

  it("two held scans in one sale share the latest cart and respect the final unit", async () => {
    await mount();
    await tap("Pair"); // 1 of 2 taken by a tap
    const first = await startHeldScan("885000222");
    const second = await startHeldScan("885000222");
    await second();
    await first();
    expect(lineQuantity("Pair")).toBe(2);
    expect(sound.accepted).toBe(1);
    expect(notice()).toBe(en.pos.scanLimitReached);
  });

  it("an obsolete lookup and a new-sale lookup resolving out of order do not interfere", async () => {
    await mount();
    await tap("Serum");
    const obsolete = await startHeldScan("885000222");
    await click(buttonIn(cartPanel(), en.pos.cart.clear), "Clear cart");
    const current = await startHeldScan("885000222");
    await current();
    expect(lineQuantity("Pair")).toBe(1);
    await obsolete();
    expect(lineQuantity("Pair")).toBe(1);
    expect(lineQuantity("Serum")).toBeNull();
    expect(sound.accepted).toBe(1);
    expect(notice()).toBe(en.pos.scanAdded);
  });
});

// ── Opening checkout is a sale-operation boundary ────────────────────────────

const checkoutDialog = () => document.querySelector("[role=dialog]") as HTMLElement | null;

async function openCheckout() {
  await click(buttonIn(cartPanel(), en.pos.checkout), "cart Checkout");
  if (!checkoutDialog()) throw new Error("checkout sheet did not open");
}

async function cancelCheckout() {
  // The sheet's own tap-outside close: onOpenChange(false), no sale completed.
  const scrim = checkoutDialog()?.parentElement?.querySelector(":scope > button[aria-label]");
  await click(scrim, "checkout close");
  if (checkoutDialog()) throw new Error("checkout sheet did not close");
}

describe("POS scan vs. opening checkout (mounted)", () => {
  it("hold a lookup, open checkout, release: cart and total unchanged, no notice, no beep", async () => {
    await mount();
    await tap("Pair");
    const release = await startHeldScan("885000111");
    await openCheckout();
    const cartBefore = cartPanel().textContent;
    const sheetBefore = checkoutDialog()!.textContent;
    await release();
    expect(lineQuantity("Serum")).toBeNull();
    expect(lineQuantity("Pair")).toBe(1);
    expect(cartPanel().textContent).toBe(cartBefore);
    expect(checkoutDialog()!.textContent).toBe(sheetBefore);
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
    expect(productReads).toBe(0);
  });

  it("a lookup that fails after checkout opened shows no error notice either", async () => {
    await mount();
    await tap("Pair");
    const release = await startHeldScan(ERROR_CODE);
    await openCheckout();
    await release();
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
  });

  it("the scanner stays off while checkout is open: no lookup starts", async () => {
    await mount();
    await tap("Pair");
    await openCheckout();
    holdLookups = true;
    await act(async () => keys("885000111"));
    await settle(4);
    expect(heldLookups).toHaveLength(0);
  });

  it("cancel checkout: the cart is kept, new scans work, the pre-checkout lookup stays stale", async () => {
    await mount();
    await tap("Pair");
    const old = await startHeldScan("885000111");
    await openCheckout();
    await cancelCheckout();
    expect(lineQuantity("Pair")).toBe(1);
    // A new scan after cancelling belongs to the current generation.
    holdLookups = false;
    await scan("885000222");
    expect(lineQuantity("Pair")).toBe(2);
    expect(sound.accepted).toBe(1);
    expect(notice()).toBe(en.pos.scanAdded);
    // The pre-checkout lookup arrives late: still stale.
    await old();
    expect(lineQuantity("Serum")).toBeNull();
    expect(sound.accepted).toBe(1);
  });

  it("opening and closing checkout repeatedly never revives an older lookup", async () => {
    await mount();
    await tap("Pair");
    const old = await startHeldScan("885000111");
    for (let i = 0; i < 3; i++) {
      await openCheckout();
      await cancelCheckout();
    }
    await old();
    expect(lineQuantity("Serum")).toBeNull();
    expect(lineQuantity("Pair")).toBe(1);
    expect(notice()).toBe("");
    expect(sound.accepted).toBe(0);
    expect(productReads).toBe(0);
  });

  it("a successful checkout still resets the sale", async () => {
    await mount();
    await tap("Pair");
    await openCheckout();
    await click(buttonIn(checkoutDialog()!, en.pos.confirmSale), "Confirm sale");
    await settle(10);
    expect(lineQuantity("Pair")).toBeNull();
    expect(cartLines()).toBe(0);
  });
});
