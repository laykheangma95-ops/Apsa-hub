/**
 * Typed scan forms — MOUNTED. Receiving, Stock Count and Packing each have an
 * inline "type the code" form that submits straight to an asynchronous
 * resolver. The submit is the last user gesture before that await, so a valid
 * code must prepare scan audio synchronously inside it (inaudibly), and the
 * accepted beep must still follow only the route's business result.
 *
 * Mounts the real routes (and the real CameraScanSheet and wedge hook) under
 * happy-dom. Replaced: the resolvers/server functions, router primitives, app
 * navigation chrome, toasts, and the sound module — whose mock records every
 * call in one ordered log next to the resolver calls, so "prepared before the
 * resolver started" is observed, not assumed. One test routes preparation
 * through the REAL sound module with a throwing AudioContext.
 *
 * Runs in its own process (typed-scan-audio-mounted.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";

GlobalRegistrator.register({ url: "http://localhost/app/inventory/receive" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ORDER = "11111111-1111-4111-8111-111111111111";
const routeContext = { session: { userId: "user-1" }, organizationId: "fixture" };

const realRouter = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => routeContext,
    useParams: () => ({ orderId: ORDER }),
  }),
  Link: ({ children, to: _to, ...rest }: any) => createElement("a", rest, children),
  useNavigate: () => () => {},
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

// ── One ordered log for sound + resolver calls ───────────────────────────────

const log: string[] = [];
const count = (entry: string) => log.filter((e) => e === entry).length;
const resolves = () => log.filter((e) => e.startsWith("resolve:"));
/** When set, preparation goes through the REAL sound module. */
let realPrepare = false;
const realSound = await import("@/lib/barcode/scan-sound");
// Captured before mocking: mock.module rebinds the namespace's exports live.
const realPrepareScanSound = realSound.prepareScanSound;
const resetRealScanSound = realSound.resetScanSoundForTests;
mock.module("@/lib/barcode/scan-sound", () => ({
  ...realSound,
  prepareScanSound: () => {
    log.push("prepare");
    if (realPrepare) realPrepareScanSound();
  },
  playAcceptedScanSound: () => {
    log.push("beep");
  },
}));

mock.module("@/lib/feedback", () => ({
  notifySuccess: () => {},
  notifyError: () => {},
  notifyInfo: () => {},
}));
mock.module("@/design-system/BottomNav", () => ({
  BottomNav: () => null,
  SELLER_TABS: { left: [], right: [] },
}));

// ── Resolvers ────────────────────────────────────────────────────────────────

type Outcome = "hit" | "miss" | "error" | "hold";
let outcome: Outcome = "hit";
let releaseHeld: (() => void) | null = null;

function settleWith<T>(code: string, hit: T, miss: T): Promise<T> {
  log.push(`resolve:${code}`);
  if (outcome === "error") return Promise.reject(new Error("network"));
  if (outcome === "miss") return Promise.resolve(miss);
  if (outcome === "hold")
    return new Promise((resolve) => {
      releaseHeld = () => resolve(hit);
    });
  return Promise.resolve(hit);
}

const PRODUCT = {
  variantId: "v-1",
  productId: "p-1",
  productNameKm: "សាប៊ូ",
  productNameEn: "Soap",
  variantName: "",
  sku: "SOAP",
  barcode: "885000111",
  quantityOnHand: 4,
};

const realReceiving = await import("@/lib/receiving");
mock.module("@/lib/receiving", () => ({
  ...realReceiving,
  resolveReceivingScan: (code: string) =>
    settleWith(code, { kind: "product", product: PRODUCT }, { kind: "not_found" }),
}));

const ITEM = { ...PRODUCT, locationId: null, systemQuantity: 4 };
const realStockCount = await import("@/lib/stock-count");
mock.module("@/lib/stock-count", () => ({
  ...realStockCount,
  resolveStockCountScan: (code: string) =>
    settleWith(code, { kind: "item", item: ITEM }, { kind: "not_found" }),
  searchStockCountProducts: async () => {
    log.push("search");
    return [{ ...PRODUCT }];
  },
  getStockCountItem: async () => {
    log.push("getItem");
    return { kind: "item", item: ITEM };
  },
}));

const realInventory = await import("@/lib/inventory");
mock.module("@/lib/inventory", () => ({
  ...realInventory,
  listInventoryLocations: async () => [],
}));

// Packing: two one-unit lines, so a repeat of line A is a duplicate (not "complete").
const BARCODE_A = "4006381333931";
const BARCODE_B = "4006381333948";
const PARCEL = `APSA:PCL:v1:${"A".repeat(22)}`;
let productVerdict: "accept" | "wrong_product" = "accept";
let parcelVerdict: "accept" | "wrong_parcel" = "accept";
/** When set, each packing server check waits until `releasePack()` is called. */
let packHold = false;
const packHeld: Array<() => void> = [];
function packAnswer<T>(value: T): Promise<T> {
  if (!packHold) return Promise.resolve(value);
  return new Promise((resolve) => packHeld.push(() => resolve(value)));
}

const line = (n: string, barcode: string) => ({
  orderItemId: `item-${n}`,
  productId: `prod-${n}`,
  variantId: `var-${n}`,
  productName: `Shirt ${n}`,
  variantName: null,
  sku: null,
  barcode,
  quantityRequired: 1,
  siblingBarcodes: [],
});

mock.module("@/api/packing", () => ({
  getPackRequirementsFn: async () => ({
    orderNumber: "ORD-1",
    parcelCode: PARCEL,
    eligible: true,
    deliveryStatus: null,
    packed: false,
    requirements: [line("A", BARCODE_A), line("B", BARCODE_B)],
  }),
  validatePackProductScanFn: async ({ data }: any) => {
    log.push(`resolve:${data.barcode}`);
    if (productVerdict === "wrong_product")
      return packAnswer({ kind: "wrong_product", scannedBarcode: data.barcode });
    const n = data.barcode === BARCODE_A ? "A" : "B";
    return packAnswer({
      kind: "accepted",
      orderItemId: `item-${n}`,
      variantId: `var-${n}`,
      productName: `Shirt ${n}`,
    });
  },
  validatePackParcelScanFn: async ({ data }: any) => {
    log.push(`resolve:${data.scannedCode}`);
    return packAnswer(
      parcelVerdict === "accept"
        ? { kind: "parcel_accepted", parcelCode: data.scannedCode }
        : { kind: "wrong_parcel", scannedCode: data.scannedCode },
    );
  },
  markOrderPackedFn: async () => ({ kind: "packed", deliveryId: null }),
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
const ReceiveRoute = ((await import("@/routes/app.inventory.receive")).Route as any).component;
const CountRoute = ((await import("@/routes/app.inventory.count")).Route as any).component;
const { PackOrderIdentityBoundary } = await import("@/routes/app.pack.$orderId");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(screen: "receive" | "count" | "pack") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const element =
    screen === "receive"
      ? createElement(ReceiveRoute)
      : screen === "count"
        ? createElement(CountRoute)
        : createElement(PackOrderIdentityBoundary, {
            userId: "user-1",
            organizationId: "fixture",
            orderId: ORDER,
          });
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          CapabilityFixtureProvider,
          {
            permissions: [
              "inventory.receive_stock",
              "inventory.adjust",
              "inventory.read",
              "products.read",
              "orders.read",
              "delivery.handoff",
            ],
          },
          element,
        ),
      ),
    ),
  );
  await settle(10);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  log.length = 0;
  outcome = "hit";
  releaseHeld = null;
  realPrepare = false;
  productVerdict = "accept";
  parcelVerdict = "accept";
  packHold = false;
  packHeld.length = 0;
  delete (window as any).AudioContext;
  resetRealScanSound();
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── DOM helpers ──────────────────────────────────────────────────────────────

function byId(id: string): HTMLInputElement {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`no #${id}; page: ${document.body.textContent?.slice(0, 200)}`);
  return el;
}

function byLabel(label: string): HTMLInputElement {
  const el = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no input labelled ${label}`);
  return el;
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Press Enter in the field the way a person does: the keydown reaches the
 * wedge listener (a lone Enter, no burst — not a scan), then the form submits.
 * Returns the log as it stood synchronously after the submit event.
 */
async function pressEnter(input: HTMLInputElement): Promise<string[]> {
  let snapshot: string[] = [];
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    snapshot = [...log];
  });
  await settle();
  return snapshot;
}

async function submitTyped(input: HTMLInputElement, value: string) {
  await typeInto(input, value);
  return pressEnter(input);
}

async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what}`);
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );

/** Wedge burst (synthetic keys: untrusted, so the hook prepares nothing). */
async function wedge(code: string, trusted = false) {
  await act(async () => {
    for (const key of [...code, "Enter"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true });
      if (trusted) Object.defineProperty(event, "isTrusted", { value: true });
      window.dispatchEvent(event);
    }
  });
  await settle();
}

// ═══════════════════════════════════════════════════════════════════════════

describe("Receiving typed form", () => {
  it("a valid code prepares synchronously, before the resolver, then one beep for the product", async () => {
    await mount("receive");
    const atSubmit = await submitTyped(byId("receive-code"), " 885000111 ");
    expect(atSubmit).toEqual(["prepare", "resolve:885000111"]);
    expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
  });

  it("one Enter is one request", async () => {
    await mount("receive");
    await submitTyped(byId("receive-code"), "885000111");
    expect(resolves()).toHaveLength(1);
  });

  it("miss and error stay silent", async () => {
    await mount("receive");
    outcome = "miss";
    await submitTyped(byId("receive-code"), "885000999");
    outcome = "error";
    await submitTyped(byId("receive-code"), "885000500");
    expect(resolves()).toHaveLength(2);
    expect(count("beep")).toBe(0);
  });

  it("blank input: no preparation, no request, no sound", async () => {
    await mount("receive");
    await submitTyped(byId("receive-code"), "   ");
    expect(log).toEqual([]);
  });

  it("a submit while busy: no second preparation, no second request, no sound", async () => {
    await mount("receive");
    outcome = "hold";
    await submitTyped(byId("receive-code"), "885000111");
    await pressEnter(byId("receive-code")); // still resolving
    expect(log).toEqual(["prepare", "resolve:885000111"]);
    await act(async () => releaseHeld!());
    await settle();
    expect(count("beep")).toBe(1);
  });

  it("camera sheet manual entry prepares once (the sheet's own), resolves once, beeps once", async () => {
    await mount("receive");
    await click(button(en.barcodeScanner.open), "camera button");
    log.length = 0; // the camera-open tap's own preparation is not under test here
    const atSubmit = await submitTyped(byId("camera-scan-manual"), "885000111");
    expect(atSubmit).toEqual(["prepare", "resolve:885000111"]);
    await settle();
    expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
  });

  it("a synthetic (untrusted) wedge scan resolves once and beeps once, preparing nothing", async () => {
    await mount("receive");
    await wedge("885000111");
    expect(log).toEqual(["resolve:885000111", "beep"]);
  });

  it("a trusted wedge scan prepares exactly once, before the resolver", async () => {
    await mount("receive");
    await wedge("885000111", true);
    expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
  });

  it("audio that fails to prepare (real module, throwing AudioContext) never blocks the lookup", async () => {
    realPrepare = true;
    (window as any).AudioContext = class {
      constructor() {
        throw new Error("audio blocked");
      }
    };
    await mount("receive");
    await submitTyped(byId("receive-code"), "885000111");
    expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
    expect(document.body.textContent).toContain("Soap");
  });
});

describe("Stock Count typed form", () => {
  it("a valid code prepares synchronously, before the resolver, then one beep for the item", async () => {
    await mount("count");
    const atSubmit = await submitTyped(byId("count-code"), "885000111");
    expect(atSubmit).toEqual(["prepare", "resolve:885000111"]);
    expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
  });

  it("miss and error stay silent", async () => {
    await mount("count");
    outcome = "miss";
    await submitTyped(byId("count-code"), "885000999");
    outcome = "error";
    await submitTyped(byId("count-code"), "885000500");
    expect(resolves()).toHaveLength(2);
    expect(count("beep")).toBe(0);
  });

  it("blank input: no preparation, no request", async () => {
    await mount("count");
    await submitTyped(byId("count-code"), "");
    expect(log).toEqual([]);
  });

  it("a submit while busy: no second preparation or request", async () => {
    await mount("count");
    outcome = "hold";
    await submitTyped(byId("count-code"), "885000111");
    await pressEnter(byId("count-code"));
    expect(log).toEqual(["prepare", "resolve:885000111"]);
    await act(async () => releaseHeld!());
    await settle();
    expect(count("beep")).toBe(1);
  });

  it("choosing a text-search result neither prepares nor beeps", async () => {
    await mount("count");
    await submitTyped(byId("count-search"), "soap");
    const hit = [...document.querySelectorAll("ul button")][0];
    await click(hit, "search result");
    expect(log).toEqual(["search", "getItem"]);
  });
});

describe("Packing typed form", () => {
  const field = () => byLabel(en.packSession.product.placeholder);

  it("a valid product code prepares synchronously, before the server check; accepted → one beep", async () => {
    await mount("pack");
    const atSubmit = await submitTyped(field(), BARCODE_A);
    // The pack queue starts the server call on a microtask: preparation is
    // already recorded when the submit event returns.
    expect(atSubmit[0]).toBe("prepare");
    expect(log).toEqual(["prepare", `resolve:${BARCODE_A}`, "beep"]);
  });

  it("a duplicate product (line already complete) stays silent", async () => {
    await mount("pack");
    await submitTyped(field(), BARCODE_A);
    await submitTyped(field(), BARCODE_A);
    expect(resolves()).toHaveLength(2);
    expect(count("beep")).toBe(1);
  });

  it("a refused product stays silent", async () => {
    await mount("pack");
    productVerdict = "wrong_product";
    await submitTyped(field(), BARCODE_A);
    expect(count("beep")).toBe(0);
  });

  it("an already-complete pack stays silent and asks the server nothing", async () => {
    await mount("pack");
    await submitTyped(field(), BARCODE_A);
    await submitTyped(field(), BARCODE_B);
    expect(count("beep")).toBe(2);
    // A complete pack hides the typed field; the wedge scanner is still live.
    expect(
      document.querySelector(`input[aria-label="${en.packSession.product.placeholder}"]`),
    ).toBeNull();
    await wedge(BARCODE_A);
    expect(resolves()).toHaveLength(2);
    expect(count("beep")).toBe(2);
  });

  it("a valid parcel code prepares synchronously; accepted → one beep; again → silent", async () => {
    await mount("pack");
    const atSubmit = await submitTyped(field(), PARCEL);
    expect(atSubmit[0]).toBe("prepare");
    expect(log).toEqual(["prepare", `resolve:${PARCEL}`, "beep"]);
    await submitTyped(field(), PARCEL); // already verified: no server call
    expect(resolves()).toHaveLength(1);
    expect(count("beep")).toBe(1);
  });

  it("a refused parcel stays silent", async () => {
    await mount("pack");
    parcelVerdict = "wrong_parcel";
    await submitTyped(field(), PARCEL);
    expect(resolves()).toHaveLength(1);
    expect(count("beep")).toBe(0);
  });

  it("blank input: no preparation, no request", async () => {
    await mount("pack");
    await submitTyped(field(), "   ");
    expect(log).toEqual([]);
  });

  it("a wedge burst into the scan field is ONE scan: the form does not also submit it", async () => {
    await mount("pack");
    const input = field();
    input.focus();
    await act(async () => {
      for (const key of [...BARCODE_A, "Enter"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        // A browser submits the form on an Enter nobody prevented.
        if (key === "Enter" && !event.defaultPrevented) {
          input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      }
    });
    await settle();
    expect(resolves()).toHaveLength(1);
    expect(count("beep")).toBe(1);
  });
});

// ── Finding A: the Packing typed form while a check is pending ───────────────

describe("Packing typed form while a scan is pending", () => {
  const field = () => byLabel(en.packSession.product.placeholder);
  const submitButton = () =>
    field().form!.querySelector("button[type=submit]") as HTMLButtonElement;

  async function busyCase(first: string, second: string, beepsAfterRelease: number) {
    await mount("pack");
    packHold = true;
    await submitTyped(field(), first);
    // One preparation, one server check, nothing confirmed yet.
    expect(log).toEqual(["prepare", `resolve:${first}`]);
    expect(packHeld).toHaveLength(1);
    expect(field().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute("aria-busy")).toBe("true");

    const pageBefore = document.body.textContent;
    // A second direct submission while busy (the event still reaches the form).
    await submitTyped(field(), second);
    expect(log).toEqual(["prepare", `resolve:${first}`]);
    expect(packHeld).toHaveLength(1);
    expect(count("beep")).toBe(0);
    expect(document.body.textContent).toBe(pageBefore);

    await act(async () => packHeld[0]!());
    await settle();
    expect(count("prepare")).toBe(1);
    expect(resolves()).toEqual([`resolve:${first}`]);
    expect(count("beep")).toBe(beepsAfterRelease);
    // Usable again.
    expect(field().disabled).toBe(false);
    expect(submitButton().disabled).toBe(false);
  }

  it("product: a second typed submit while busy prepares nothing and starts nothing", async () => {
    await busyCase(BARCODE_A, BARCODE_B, 1);
    // ...and the form works again afterwards.
    packHold = false;
    await submitTyped(field(), BARCODE_B);
    expect(count("prepare")).toBe(2);
    expect(count("beep")).toBe(2);
  });

  it("parcel: a second typed submit while busy prepares nothing and starts nothing", async () => {
    await busyCase(PARCEL, BARCODE_A, 1);
  });

  it("a refused first check: still one preparation, one check, and no beep", async () => {
    productVerdict = "wrong_product";
    await busyCase(BARCODE_A, BARCODE_B, 0);
  });

  it("the hardware scanner keeps its ordered queue while a typed check is pending", async () => {
    await mount("pack");
    packHold = true;
    await submitTyped(field(), BARCODE_A);
    await wedge(BARCODE_B); // queued behind the typed check, not refused
    expect(resolves()).toEqual([`resolve:${BARCODE_A}`]);
    await act(async () => packHeld[0]!());
    await settle();
    expect(resolves()).toEqual([`resolve:${BARCODE_A}`, `resolve:${BARCODE_B}`]);
    await act(async () => packHeld[1]!());
    await settle();
    expect(count("beep")).toBe(2);
    expect(count("prepare")).toBe(1); // the typed submit only (synthetic keys are untrusted)
  });
});

// ── Finding B: Receiving / Stock Count refuse what the shared normalizer refuses

const INVALID: Array<[string, string]> = [
  ["101 printable characters", "8".repeat(101)],
  ["control-only input", "\u0001\u0002\u001f"],
  ["whitespace-only input", " \t "],
  ["blank input", ""],
];

for (const [screen, fieldId] of [
  ["receive", "receive-code"],
  ["count", "count-code"],
] as const) {
  describe(`${screen === "receive" ? "Receiving" : "Stock Count"}: invalid typed input`, () => {
    for (const [name, value] of INVALID) {
      it(`${name}: no preparation, no request, no sound`, async () => {
        await mount(screen);
        await submitTyped(byId(fieldId), value);
        expect(log).toEqual([]);
      });
    }

    it("100 characters (the shared maximum) is still a valid code", async () => {
      await mount(screen);
      const code = "8".repeat(100);
      const atSubmit = await submitTyped(byId(fieldId), code);
      expect(atSubmit).toEqual(["prepare", `resolve:${code}`]);
      expect(log).toEqual(["prepare", `resolve:${code}`, "beep"]);
    });

    it("control characters around a valid code are stripped before the resolver", async () => {
      await mount(screen);
      await submitTyped(byId(fieldId), "\u0002885000111\u0003");
      expect(log).toEqual(["prepare", "resolve:885000111", "beep"]);
    });
  });
}
