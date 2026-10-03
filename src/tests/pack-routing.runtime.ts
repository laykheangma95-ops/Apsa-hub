/**
 * Pack routing regressions — through the REAL TanStack Router.
 *
 * Staging found that Order Detail → "Pack Order" changed the URL to
 * /app/pack/$orderId but the Ready-to-Pack queue stayed on screen: the parent
 * /app/pack route never rendered its nested-route Outlet, so the per-order Pack
 * screen could not render at all.
 *
 * These tests mount the shipped route modules (src/routes/app.pack.tsx and
 * src/routes/app.pack.$orderId.tsx) in a real router with memory history, wired
 * under /app exactly as routeTree.gen.ts wires them. Nothing in the router is
 * mocked. Only the network edges (server functions), the camera sheet, app
 * navigation chrome, the label dialog and toasts are replaced. The fake packing
 * server is stateful and org-scoped, so packed state, refresh and tenant
 * isolation are observed through the routed UI.
 *
 * /app/pack/ (trailing slash) once rendered blank: the parent route decided
 * "child open" from a pathname prefix, so the trailing slash disabled the queue
 * and rendered an Outlet with no matching child. The parent now reads the
 * router's own match for /app/pack/$orderId (tests I/J).
 *
 * The fake server proves ROUTING, not server authority. The real service and
 * SQL layers are covered elsewhere: tenant isolation and packed persistence in
 * pack-order-v1.test.ts and scan-to-pack-security.test.ts (real services),
 * parcel-tenant-isolation.test.ts, and pack-order-readiness-sql (PGlite, every
 * migration); current-shipment selection after a replacement shipment in
 * parcel-shipment-split.test.ts (real services on one shared world).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as actualApi from "@/lib/api";
import type { CapabilityResult } from "@/lib/capabilities";
import type { MarkPackedResult } from "@/lib/pack";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const ORG_A = "org-A";
const ORG_B = "org-B";
const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "33333333-3333-4333-8333-333333333333";
const VARIANT_A = "44444444-4444-4444-8444-444444444444";

interface FakeOrder {
  organizationId: string;
  orderNumber: string;
  parcelCode: string;
  productName: string;
  variantName: string;
  quantity: number;
  packed: boolean;
}

interface FakeServer {
  /** The organization the server resolves from the caller's session. */
  organizationId: string;
  orders: Map<string, FakeOrder>;
  /** Parcels the server holds per order — Pack must never create one. */
  parcelsByOrder: Map<string, number>;
  /** Deliveries that exist — Pack must never require (or create) one. */
  deliveries: number;
  /** State-changing Mark Packed calls (stock-moving side effects). */
  packMutations: number;
  markCalls: { orderId: string; packedLines: unknown }[];
  /** Ready-to-Pack queue fetches — the queue must not load behind Pack Order. */
  queueLoads: number;
}

const server: FakeServer = {
  organizationId: ORG_A,
  orders: new Map(),
  parcelsByOrder: new Map(),
  deliveries: 0,
  packMutations: 0,
  markCalls: [],
  queueLoads: 0,
};

function resetServer() {
  server.organizationId = ORG_A;
  server.orders = new Map([
    [
      ORDER_A,
      {
        organizationId: ORG_A,
        orderNumber: "APSA-1001",
        parcelCode: "APSA-PCL-AAAA",
        productName: "Silk Scarf",
        variantName: "Indigo",
        quantity: 2,
        packed: false,
      },
    ],
    [
      ORDER_B,
      {
        organizationId: ORG_B,
        orderNumber: "OTHER-ORG-2002",
        parcelCode: "APSA-PCL-BBBB",
        productName: "Secret Product Of Org B",
        variantName: "Hidden",
        quantity: 1,
        packed: false,
      },
    ],
  ]);
  server.parcelsByOrder = new Map([
    [ORDER_A, 1],
    [ORDER_B, 1],
  ]);
  server.deliveries = 0;
  server.packMutations = 0;
  server.markCalls = [];
  server.queueLoads = 0;
}

/** Org-scoped lookup: another organization's order is indistinguishable from none. */
function ownOrder(orderId: string): FakeOrder {
  const order = server.orders.get(orderId);
  if (!order || order.organizationId !== server.organizationId) {
    throw new Error("Order not found");
  }
  return order;
}

function capabilityResult(): CapabilityResult {
  return {
    status: "active",
    userId: USER_A,
    organizationId: server.organizationId,
    role: "STAFF",
    permissions: ["orders.read", "delivery.handoff", "fulfillment.print_label"],
  };
}

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => capabilityResult(),
}));

mock.module("@/api/packing", () => ({
  getPackRequirementsFn: async ({ data }: { data: { orderId: string } }) => {
    const order = ownOrder(data.orderId);
    return {
      orderNumber: order.orderNumber,
      parcelCode: order.parcelCode,
      eligible: true,
      deliveryStatus: null,
      packed: order.packed,
      requirements: [
        {
          orderItemId: ITEM_A,
          productId: "prod-scarf",
          variantId: VARIANT_A,
          productName: order.productName,
          variantName: order.variantName,
          sku: "SCARF-IND",
          barcode: null,
          quantityRequired: order.quantity,
          siblingBarcodes: [],
        },
      ],
    };
  },
  validatePackParcelScanFn: async () => ({ kind: "wrong_parcel", scannedCode: "x" }),
  validatePackProductScanFn: async () => ({ kind: "wrong_product", scannedBarcode: "x" }),
  markOrderPackedFn: async ({ data }: { data: { orderId: string; packedLines: unknown } }) => {
    server.markCalls.push(data);
    const order = ownOrder(data.orderId);
    if (order.packed) return { kind: "already_packed", deliveryId: null } as MarkPackedResult;
    order.packed = true;
    server.packMutations += 1;
    return { kind: "packed", deliveryId: null } as MarkPackedResult;
  },
}));

mock.module("@/lib/api", () => ({
  ...actualApi,
  listReadyToPack: async (): Promise<actualApi.ReadyToPackRow[]> => {
    server.queueLoads += 1;
    return [...server.orders.entries()]
      .filter(([, o]) => o.organizationId === server.organizationId && !o.packed)
      .map(([orderId, o]) => ({
        orderId,
        orderNumber: o.orderNumber,
        createdAt: "2026-10-01T03:00:00.000Z",
        source: "MANUAL",
        customerName: "Queue Customer",
        itemCount: o.quantity,
        currency: "USD",
        total: { amount: 1500, currency: "USD" },
        paid: true,
        collect: { amount: 0, currency: "USD" },
        deliveryStatus: null,
      }));
  },
}));

mock.module("@/components/barcode/CameraScanSheet", () => ({
  CameraScanSheet: () => null,
}));

mock.module("@/components/labels/InternalParcelLabelDialog", () => ({
  InternalParcelLabelDialog: () => null,
}));

mock.module("@/design-system/BottomNav", () => ({
  BottomNav: () => null,
  SELLER_TABS: { left: [], right: [] },
}));

const notifications: string[] = [];
mock.module("@/lib/feedback", () => ({
  notifySuccess: (title: string) => notifications.push(`success:${title}`),
  notifyError: (title: string) => notifications.push(`error:${title}`),
}));

let Router: typeof import("@tanstack/react-router");
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];
let CapabilityProvider: (typeof import("@/hooks/use-capabilities"))["CapabilityProvider"];
let routeTree: any;

beforeAll(async () => {
  const noop = () => undefined;
  (globalThis as any).scrollTo = noop;
  (globalThis as any).window = {
    addEventListener: noop,
    removeEventListener: noop,
    scrollTo: noop,
    location: { href: "http://localhost/" },
  };
  const head = { appendChild: noop };
  (globalThis as any).document = {
    visibilityState: "visible",
    head,
    getElementsByTagName: () => [head],
    createElement: () => ({ appendChild: noop }),
    createTextNode: () => ({}),
    addEventListener: noop,
    removeEventListener: noop,
    querySelectorAll: () => [],
    getElementById: () => null,
  };

  Router = await import("@tanstack/react-router");
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  CapabilityProvider = (await import("@/hooks/use-capabilities")).CapabilityProvider;
  const { Route: PackRoute } = await import("@/routes/app.pack");
  const { Route: PackOrderRoute } = await import("@/routes/app.pack.$orderId");

  const { createRootRoute, createRoute, Outlet } = Router;
  const rootRoute = createRootRoute({ component: () => createElement(Outlet) });
  // Stand-in for the authenticated /app layout: it supplies the same route
  // context (session + organizationId) the real /app route resolves.
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    beforeLoad: () => ({ session: { userId: USER_A }, organizationId: server.organizationId }),
    component: () => createElement(Outlet),
  });
  const orderDetailStub = createRoute({
    getParentRoute: () => appRoute,
    path: "/orders/$id",
    component: function OrderDetailStub() {
      const { id } = orderDetailStub.useParams();
      return createElement("order-detail", { orderId: id });
    },
  });
  // Wired exactly as routeTree.gen.ts wires the file routes.
  const packRoute = (PackRoute as any).update({
    id: "/pack",
    path: "/pack",
    getParentRoute: () => appRoute,
  });
  const packOrderRoute = (PackOrderRoute as any).update({
    id: "/$orderId",
    path: "/$orderId",
    getParentRoute: () => packRoute,
  });
  routeTree = rootRoute.addChildren([
    appRoute.addChildren([packRoute.addChildren([packOrderRoute]), orderDetailStub]),
  ]);

  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetServer();
  notifications.length = 0;
});

let mounted: ReactTestRenderer | null = null;
let router: any = null;

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
  router = null;
});

async function settle(ms = 15) {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

/** Mount a fresh app (fresh QueryClient + router) — also how a reload is modelled. */
async function open(path: string) {
  if (mounted) await act(async () => mounted?.unmount());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = Router.createRouter({
    routeTree,
    history: Router.createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    mounted = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          CapabilityProvider,
          {
            userId: USER_A,
            organizationId: server.organizationId,
            initialResult: capabilityResult(),
          },
          createElement(Router.RouterProvider, { router }),
        ),
      ) as ReactElement,
    );
  });
  await settle();
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((child) => renderedText(child as any)).join("");
}

function text(): string {
  return renderedText(mounted!.root);
}

function buttons(label: string) {
  return mounted!.root
    .findAllByType("button")
    .filter((candidate) => renderedText(candidate).includes(label));
}

async function click(node: ReactTestInstance) {
  await act(async () => node.props["onClick"]());
  await settle();
}

function pathname(): string {
  return router.state.location.pathname;
}

const QUEUE_TITLE = "pack.title";
const PACK_ORDER_TITLE = "packSession.title";

describe("/app/pack — parent route", () => {
  it("A. /app/pack renders the Ready-to-Pack queue", async () => {
    await open("/app/pack");
    expect(pathname()).toBe("/app/pack");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).toContain("APSA-1001");
    expect(text()).not.toContain(i18n.t(PACK_ORDER_TITLE));
    // Never another organization's queue rows.
    expect(text()).not.toContain("OTHER-ORG-2002");
  });
});

describe("/app/pack/$orderId — nested Pack Order route", () => {
  it("B/C. the child Pack workflow renders through the parent's Outlet, not the queue", async () => {
    await open(`/app/pack/${ORDER_A}`);
    expect(pathname()).toBe(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    // The queue steps aside entirely while Pack Order is open.
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));
    expect(text()).not.toContain(i18n.t("pack.subtitle"));
  });

  it("B/C. navigating from the queue URL to Pack Order swaps the screen in the same router", async () => {
    await open("/app/pack");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    await act(async () => {
      await router.navigate({ to: "/app/pack/$orderId", params: { orderId: ORDER_A } });
    });
    await settle();
    expect(pathname()).toBe(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));
  });

  it("D. shows the correct order, product, variant and quantity for this order's APSA Parcel", async () => {
    await open(`/app/pack/${ORDER_A}`);
    const t = text();
    expect(t).toContain("APSA-1001");
    expect(t).toContain("Silk Scarf");
    expect(t).toContain("Indigo");
    expect(t).toContain("SCARF-IND");
    expect(t).toContain("0 / 2");
  });

  it("E/G. Mark Packed works from the routed UI with no Shipment, and creates no Parcel", async () => {
    await open(`/app/pack/${ORDER_A}`);
    expect(server.deliveries).toBe(0);

    // Mark Packed is not available until every unit is accounted for.
    expect(buttons(i18n.t("packSession.markPacked.action"))[0]?.props["disabled"]).toBe(true);

    for (let unit = 0; unit < 2; unit++) {
      const confirm = buttons(i18n.t("packSession.manual.confirm"));
      expect(confirm.length).toBe(1);
      await click(confirm[0]!);
    }
    expect(text()).toContain("2 / 2");

    const mark = buttons(i18n.t("packSession.markPacked.action"))[0]!;
    expect(mark.props["disabled"]).toBe(false);
    await click(mark);

    expect(server.markCalls).toHaveLength(1);
    expect(server.markCalls[0]!.orderId).toBe(ORDER_A);
    expect(server.markCalls[0]!.packedLines).toEqual([{ orderItemId: ITEM_A, quantity: 2 }]);
    expect(server.orders.get(ORDER_A)!.packed).toBe(true);
    expect(server.packMutations).toBe(1);
    // Packing never needed, nor created, a Shipment or a second Parcel.
    expect(server.deliveries).toBe(0);
    expect(server.parcelsByOrder.get(ORDER_A)).toBe(1);
    expect(notifications).toContain(`success:${i18n.t("packSession.markPacked.success")}`);

    // Back to Order Detail for the same order.
    expect(pathname()).toBe(`/app/orders/${ORDER_A}`);
    expect(mounted!.root.findByType("order-detail" as any).props["orderId"]).toBe(ORDER_A);
  });

  it("F. packed state comes from the server and survives a reload; no second mutation", async () => {
    await open(`/app/pack/${ORDER_A}`);
    for (let unit = 0; unit < 2; unit++) {
      await click(buttons(i18n.t("packSession.manual.confirm"))[0]!);
    }
    await click(buttons(i18n.t("packSession.markPacked.action"))[0]!);
    expect(server.packMutations).toBe(1);

    // Reload: a brand-new router and query cache, nothing carried over.
    await open(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).toContain(i18n.t("packSession.markPacked.alreadyPacked"));
    // No Mark Packed or manual confirm controls on a packed order.
    expect(buttons(i18n.t("packSession.markPacked.action"))).toHaveLength(0);
    expect(buttons(i18n.t("packSession.manual.confirm"))).toHaveLength(0);
    expect(server.markCalls).toHaveLength(1);
    expect(server.packMutations).toBe(1);
    expect(server.parcelsByOrder.get(ORDER_A)).toBe(1);

    // And the packed order has left the Ready-to-Pack queue.
    await open("/app/pack");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).not.toContain("APSA-1001");
  });

  it("H. another organization's order cannot be opened in Pack Order — no data leaks", async () => {
    await open(`/app/pack/${ORDER_B}`);
    const t = text();
    expect(t).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(t).toContain(i18n.t("packSession.error.title"));
    expect(t).not.toContain("OTHER-ORG-2002");
    expect(t).not.toContain("Secret Product Of Org B");
    expect(t).not.toContain("APSA-PCL-BBBB");
    expect(buttons(i18n.t("packSession.markPacked.action"))).toHaveLength(0);
    expect(server.markCalls).toHaveLength(0);
    expect(server.orders.get(ORDER_B)!.packed).toBe(false);
  });
});

describe("/app/pack/ — trailing slash", () => {
  it("I. /app/pack/ (trailing slash) renders the Ready-to-Pack queue, never a blank screen", async () => {
    await open("/app/pack/");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).toContain("APSA-1001");
    expect(text()).not.toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain("OTHER-ORG-2002");
  });

  it("I. a reload of /app/pack/ still renders the queue", async () => {
    await open("/app/pack/");
    await open("/app/pack/");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).toContain("APSA-1001");
  });

  it("I. /app/pack/ → Pack Order → back → forward keeps each screen intact", async () => {
    await open("/app/pack/");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));

    await act(async () => {
      await router.navigate({ to: "/app/pack/$orderId", params: { orderId: ORDER_A } });
    });
    await settle();
    expect(pathname()).toBe(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));

    await act(async () => router.history.back());
    await settle();
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).toContain("APSA-1001");
    expect(text()).not.toContain(i18n.t(PACK_ORDER_TITLE));

    await act(async () => router.history.forward());
    await settle();
    expect(pathname()).toBe(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));
  });
});

describe("/app/pack ⇄ /app/pack/$orderId — history", () => {
  it("J. queue → Pack Order → back → forward through browser history", async () => {
    await open("/app/pack");
    await act(async () => {
      await router.navigate({ to: "/app/pack/$orderId", params: { orderId: ORDER_A } });
    });
    await settle();
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));

    await act(async () => router.history.back());
    await settle();
    expect(pathname()).toBe("/app/pack");
    expect(text()).toContain(i18n.t(QUEUE_TITLE));
    expect(text()).toContain("APSA-1001");
    expect(text()).not.toContain(i18n.t(PACK_ORDER_TITLE));

    await act(async () => router.history.forward());
    await settle();
    expect(pathname()).toBe(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));
  });

  it("J. a reload of Pack Order renders Pack Order, and never loads the queue behind it", async () => {
    await open(`/app/pack/${ORDER_A}`);
    await open(`/app/pack/${ORDER_A}`);
    expect(text()).toContain(i18n.t(PACK_ORDER_TITLE));
    expect(text()).not.toContain(i18n.t(QUEUE_TITLE));
    expect(server.queueLoads).toBe(0);
  });
});
