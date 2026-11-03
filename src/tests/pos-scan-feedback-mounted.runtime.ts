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

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  getPosProducts: async () => CATALOG,
  lookupVariantByBarcode: async (code: string) => {
    if (code === ERROR_CODE) throw new Error("network down");
    const p = CODES[code];
    return p
      ? { product: p, variant: { id: p.variantId, sku: p.sku, name: "", price: p.price } }
      : null;
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
  sound.accepted = 0;
  sound.prepared = 0;
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
