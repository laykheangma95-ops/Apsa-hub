/**
 * Parcel Investigation regressions — through the REAL TanStack Router.
 *
 * Staging found that opening the merchant's OWN valid APSA Parcel crashed the
 * page ("This page didn't load"): the route passed parcel.status straight into
 * StatusChip, whose map has no entry for the parcel domain's `created`, so the
 * chip threw on an undefined lookup. `void` crashed the same way.
 *
 * The authoritative parcel status domain is the CHECK constraint in
 * supabase/migrations/050_parcels.sql — ('created', 'void'), never altered by a
 * later migration. The other chips on the page render the order and delivery
 * enums (023_orders.sql, 027_delivery_fulfillment_domain.sql), listed below.
 *
 * Mounts the shipped route module (src/routes/app.parcels.$code.tsx) in a real
 * router with memory history. Only the server functions are replaced — by an
 * org-scoped fake resolver that mirrors resolveParcelIdentity's contract
 * (null for unknown or another organization's parcel; latest delivery only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { PARCEL_STATUSES } from "@/lib/parcel-status";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";
import i18n from "@/lib/i18n";

// Authoritative enums (migrations 023 / 027 / 050).
const ORDER_LIFECYCLE = ["draft", "confirmed", "completed", "cancelled"] as const;
const ORDER_PAYMENT = ["unpaid", "pending", "paid", "failed"] as const;
const ORDER_FULFILLMENT = ["unfulfilled", "processing", "fulfilled", "cancelled"] as const;
const DELIVERY = [
  "pending",
  "preparing",
  "ready",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
] as const;

const ORG_A = "org-A";
const ORG_B = "org-B";
const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_A = "33333333-3333-4333-8333-333333333333";

const CODE_A = "APSA:PCL:v1:AAAAAAAAAAAAAAAAAAAAAA";
const CODE_B = "APSA:PCL:v1:BBBBBBBBBBBBBBBBBBBBBB";

interface FakeParcel {
  organizationId: string;
  orderId: string;
  status: string;
}
interface FakeOrder {
  organizationId: string;
  orderNumber: string;
  lifecycleStatus: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  customerId: string | null;
}
interface FakeDelivery {
  id: string;
  orderId: string;
  status: string;
  providerName: string;
  externalTrackingNumber: string | null;
  createdAt: string;
}

const server = {
  organizationId: ORG_A,
  parcels: new Map<string, FakeParcel>(),
  orders: new Map<string, FakeOrder>(),
  deliveries: [] as FakeDelivery[],
};

function resetServer() {
  server.organizationId = ORG_A;
  server.parcels = new Map([
    [CODE_A, { organizationId: ORG_A, orderId: ORDER_A, status: "created" }],
    [CODE_B, { organizationId: ORG_B, orderId: ORDER_B, status: "created" }],
  ]);
  server.orders = new Map([
    [
      ORDER_A,
      {
        organizationId: ORG_A,
        orderNumber: "APSA-1001",
        lifecycleStatus: "confirmed",
        fulfillmentStatus: "unfulfilled",
        paymentStatus: "paid",
        customerId: CUSTOMER_A,
      },
    ],
    [
      ORDER_B,
      {
        organizationId: ORG_B,
        orderNumber: "OTHER-ORG-2002",
        lifecycleStatus: "confirmed",
        fulfillmentStatus: "processing",
        paymentStatus: "paid",
        customerId: null,
      },
    ],
  ]);
  server.deliveries = [];
}

/** Mirrors src/server/parcels/resolution.ts — opaque null across tenants. */
async function resolveParcelIdentity(parcelCode: string) {
  if (!isValidParcelCode(parcelCode)) return null;
  const parcel = server.parcels.get(parcelCode);
  if (!parcel || parcel.organizationId !== server.organizationId) return null;
  const order = server.orders.get(parcel.orderId);
  if (!order || order.organizationId !== server.organizationId) return null;
  const latest =
    server.deliveries
      .filter((d) => d.orderId === parcel.orderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return {
    parcel: {
      id: `parcel|${parcelCode}`,
      parcelCode,
      status: parcel.status,
      createdAt: "2026-10-01T03:00:00.000Z",
    },
    order: {
      id: parcel.orderId,
      orderNumber: order.orderNumber,
      lifecycleStatus: order.lifecycleStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentStatus: order.paymentStatus,
    },
    customer: order.customerId ? { id: order.customerId } : null,
    delivery: latest
      ? {
          id: latest.id,
          status: latest.status,
          providerName: latest.providerName,
          externalTrackingNumber: latest.externalTrackingNumber,
        }
      : null,
    shippingSnapshot: { hasName: true, hasPhone: true, hasAddress: false },
  };
}

mock.module("@/api/parcel-resolution", () => ({
  resolveParcelIdentityFn: ({ data }: { data: { parcelCode: string } }) =>
    resolveParcelIdentity(data.parcelCode),
}));

mock.module("@/api/customer-conversation", () => ({
  findCustomerConversationFn: async () => ({ conversationId: null }),
}));

let Router: typeof import("@tanstack/react-router");
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];
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
  const { Route: ParcelRoute } = await import("@/routes/app.parcels.$code");

  const { createRootRoute, createRoute, Outlet } = Router;
  const rootRoute = createRootRoute({ component: () => createElement(Outlet) });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    component: () => createElement(Outlet),
  });
  // Quick-action destinations, so the page's Links resolve inside this tree.
  const stubs = ["/orders/$id", "/customers/$id", "/deliveries/$id", "/inbox/$id"].map((path) =>
    createRoute({ getParentRoute: () => appRoute, path, component: () => null }),
  );
  const parcelRoute = (ParcelRoute as any).update({
    id: "/parcels/$code",
    path: "/parcels/$code",
    getParentRoute: () => appRoute,
  });
  routeTree = rootRoute.addChildren([appRoute.addChildren([parcelRoute, ...stubs])]);

  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetServer();
});

let mounted: ReactTestRenderer | null = null;
let router: any = null;

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
  router = null;
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

/**
 * Open the investigation page for a code. A render-time throw would surface
 * here (react-test-renderer has no error boundary), so a crash fails the test.
 */
async function openParcel(code: string) {
  if (mounted) await act(async () => mounted?.unmount());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  router = Router.createRouter({
    routeTree,
    history: Router.createMemoryHistory({
      initialEntries: [`/app/parcels/${encodeURIComponent(code)}`],
    }),
  });
  await act(async () => {
    mounted = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Router.RouterProvider, { router }),
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

/** The label rendered by every StatusChip on the page, in document order. */
function chipLabels(): string[] {
  return mounted!.root
    .findAll((n) => n.type === "span" && n.props["className"] === "chip-text")
    .map((n) => renderedText(n));
}

function setParcel(status: string) {
  server.parcels.get(CODE_A)!.status = status;
}

describe("Parcel Investigation — authoritative parcel status", () => {
  it("A/D. an active own-organization parcel (status `created`) renders in full", async () => {
    await openParcel(CODE_A);
    const t = text();
    expect(t).toContain(i18n.t("parcelInvestigation.title"));
    expect(t).toContain(CODE_A);
    expect(t).toContain("APSA-1001");
    expect(t).not.toContain(i18n.t("parcelInvestigation.error.title"));
    expect(t).not.toContain(i18n.t("parcelInvestigation.notFound.title"));
    // The parcel chip is an explicit, translated label — not a raw key.
    expect(chipLabels()[0]).toBe(i18n.t("status.active"));
    expect(t).not.toContain(i18n.t("parcelInvestigation.void.title"));
    expect(t).not.toContain(i18n.t("status.unknown"));
    expect(t).not.toContain("status.");
    expect(t).toContain(i18n.t("parcelInvestigation.noDelivery"));
  });

  it("B. every status in the parcel domain renders safely with a translated label", async () => {
    const expected: Record<(typeof PARCEL_STATUSES)[number], string> = {
      created: i18n.t("status.active"),
      void: i18n.t("status.cancelled"),
    };
    for (const status of PARCEL_STATUSES) {
      setParcel(status);
      await openParcel(CODE_A);
      expect(text()).toContain(CODE_A);
      expect(chipLabels()[0]).toBe(expected[status]);
      expect(text()).not.toContain(i18n.t("status.unknown"));
    }
  });

  it("B. a voided parcel keeps its identity and shows the voided banner", async () => {
    setParcel("void");
    await openParcel(CODE_A);
    expect(text()).toContain(CODE_A);
    expect(text()).toContain(i18n.t("parcelInvestigation.void.title"));
    expect(text()).toContain("APSA-1001");
  });

  it("B. every order lifecycle / fulfillment / payment and delivery status renders", async () => {
    const rows = Math.max(
      ORDER_LIFECYCLE.length,
      ORDER_FULFILLMENT.length,
      ORDER_PAYMENT.length,
      DELIVERY.length,
    );
    for (let i = 0; i < rows; i++) {
      const order = server.orders.get(ORDER_A)!;
      order.lifecycleStatus = ORDER_LIFECYCLE[i % ORDER_LIFECYCLE.length]!;
      order.fulfillmentStatus = ORDER_FULFILLMENT[i % ORDER_FULFILLMENT.length]!;
      order.paymentStatus = ORDER_PAYMENT[i % ORDER_PAYMENT.length]!;
      server.deliveries = [
        {
          id: "del-1",
          orderId: ORDER_A,
          status: DELIVERY[i % DELIVERY.length]!,
          providerName: "Manual courier",
          externalTrackingNumber: null,
          createdAt: "2026-10-02T00:00:00.000Z",
        },
      ];
      await openParcel(CODE_A);
      const labels = chipLabels();
      // parcel + lifecycle + fulfillment + payment + delivery
      expect(labels).toHaveLength(5);
      expect(labels).toEqual([
        i18n.t("status.active"),
        i18n.t(`status.${order.lifecycleStatus}`),
        i18n.t(`status.${order.fulfillmentStatus}`),
        i18n.t(`status.${order.paymentStatus}`),
        i18n.t(`status.${server.deliveries[0]!.status}`),
      ]);
      expect(labels).not.toContain(i18n.t("status.unknown"));
    }
  });

  it("C. an unknown parcel status fails safe: neutral 'unknown status', page still renders", async () => {
    setParcel("quarantined");
    server.orders.get(ORDER_A)!.fulfillmentStatus = "teleported";
    server.deliveries = [
      {
        id: "del-1",
        orderId: ORDER_A,
        status: "lost_in_space",
        providerName: "Manual courier",
        externalTrackingNumber: "TRK-1",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    ];
    await openParcel(CODE_A);
    const t = text();
    expect(t).toContain(CODE_A);
    expect(t).toContain("APSA-1001");
    expect(t).toContain("TRK-1");
    const labels = chipLabels();
    expect(labels[0]).toBe(i18n.t("status.unknown"));
    expect(labels[2]).toBe(i18n.t("status.unknown"));
    expect(labels[4]).toBe(i18n.t("status.unknown"));
    // Never a raw i18n key or raw server value as the label.
    expect(t).not.toContain("status.quarantined");
    expect(t).not.toContain("quarantined");
    // Not mistaken for a voided parcel either.
    expect(t).not.toContain(i18n.t("parcelInvestigation.void.title"));
  });

  it("C. an out-of-domain parcel status that is another domain's StatusKey is still unknown", async () => {
    setParcel("paid");
    await openParcel(CODE_A);
    expect(chipLabels()[0]).toBe(i18n.t("status.unknown"));
    expect(text()).toContain(CODE_A);
  });

  it("C. a prototype-chain status name cannot reach a non-entry", async () => {
    setParcel("constructor");
    await openParcel(CODE_A);
    expect(chipLabels()[0]).toBe(i18n.t("status.unknown"));
    expect(text()).toContain(CODE_A);
  });
});

describe("Parcel Investigation — tenant isolation", () => {
  it("E. another organization's parcel is 'not found' and leaks nothing", async () => {
    await openParcel(CODE_B);
    const t = text();
    expect(t).toContain(i18n.t("parcelInvestigation.notFound.title"));
    expect(t).not.toContain("OTHER-ORG-2002");
    expect(t).not.toContain(ORDER_B);
    expect(chipLabels()).toHaveLength(0);
  });

  it("E. the same parcel is visible to its own organization", async () => {
    server.organizationId = ORG_B;
    await openParcel(CODE_B);
    expect(text()).toContain("OTHER-ORG-2002");
    expect(text()).not.toContain(i18n.t("parcelInvestigation.notFound.title"));
  });
});

describe("Parcel Investigation — shipment association", () => {
  it("F. the current Shipment renders with its provider and tracking number", async () => {
    server.orders.get(ORDER_A)!.fulfillmentStatus = "processing";
    server.deliveries = [
      {
        id: "del-current",
        orderId: ORDER_A,
        status: "ready",
        providerName: "Grab Express",
        externalTrackingNumber: "GRAB-777",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
    ];
    await openParcel(CODE_A);
    const t = text();
    expect(t).toContain("Grab Express");
    expect(t).toContain("GRAB-777");
    expect(t).toContain(i18n.t("parcelInvestigation.viewDelivery"));
    expect(chipLabels()[4]).toBe(i18n.t("status.ready"));
  });

  it("G. a cancelled-then-replaced Shipment never replaces the permanent Parcel identity", async () => {
    server.deliveries = [
      {
        id: "del-old",
        orderId: ORDER_A,
        status: "cancelled",
        providerName: "Old Courier",
        externalTrackingNumber: "OLD-111",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "del-new",
        orderId: ORDER_A,
        status: "pending",
        providerName: "New Courier",
        externalTrackingNumber: "NEW-222",
        createdAt: "2026-10-03T00:00:00.000Z",
      },
    ];
    await openParcel(CODE_A);
    const t = text();
    // Same APSA Parcel, same status, same order.
    expect(t).toContain(CODE_A);
    expect(chipLabels()[0]).toBe(i18n.t("status.active"));
    expect(t).toContain("APSA-1001");
    // Only the current Shipment is shown as the delivery.
    expect(t).toContain("New Courier");
    expect(t).toContain("NEW-222");
    expect(t).not.toContain("OLD-111");
  });
});
