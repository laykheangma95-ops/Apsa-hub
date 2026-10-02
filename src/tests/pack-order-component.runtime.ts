/**
 * Pack Order mounted-component regressions: state isolation by identity.
 *
 * Mounts the shipped PackOrderIdentityBoundary with a real QueryClient and the
 * real CapabilityProvider. Only the server-function network edges, the router
 * primitives, the camera sheet (a DOM/camera surface) and toast feedback are
 * replaced. Proves the scan queue, progress, feedback, completed lines and the
 * Mark Packed mutation never survive an order, user or organization switch, and
 * that late async responses for an old identity are dropped.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import * as actualRouter from "@tanstack/react-router";
import type { CapabilityResult } from "@/lib/capabilities";
import type { MarkPackedResult, ServerProductScanResult } from "@/lib/pack";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const ORDER_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_2 = "22222222-2222-4222-8222-222222222222";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const BARCODE = "4006381333931";

interface FakeServer {
  userId: string;
  organizationId: string;
  scanMode: "accept" | "pending";
  pendingScans: ((result: ServerProductScanResult) => void)[];
  markMode: "packed" | "pending";
  pendingMark: ((result: MarkPackedResult) => void) | null;
}

const server: FakeServer = {
  userId: USER_A,
  organizationId: ORG_A,
  scanMode: "accept",
  pendingScans: [],
  markMode: "packed",
  pendingMark: null,
};

const navigations: unknown[] = [];
const notifications: string[] = [];

function capabilityResult(): CapabilityResult {
  return {
    status: "active",
    userId: server.userId,
    organizationId: server.organizationId,
    role: "STAFF",
    permissions: ["orders.read", "delivery.handoff"],
  };
}

/** Product name carries the identity that loaded it, so a leak is visible. */
function productName(orderId: string) {
  return `Shirt|${server.userId}|${server.organizationId}|${orderId}`;
}

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => capabilityResult(),
}));

mock.module("@/api/packing", () => ({
  getPackRequirementsFn: async ({ data }: { data: { orderId: string } }) => ({
    orderNumber: `ORD|${data.orderId}`,
    parcelCode: `PCL|${data.orderId}`,
    eligible: true,
    deliveryStatus: null,
    packed: false,
    requirements: [
      {
        orderItemId: `item|${data.orderId}`,
        productId: "prod-shirt",
        variantId: VARIANT,
        productName: productName(data.orderId),
        variantName: null,
        sku: null,
        barcode: BARCODE,
        quantityRequired: 2,
        siblingBarcodes: [],
      },
    ],
  }),
  validatePackParcelScanFn: async () => ({ kind: "wrong_parcel", scannedCode: "x" }),
  validatePackProductScanFn: async ({ data }: { data: { orderId: string } }) => {
    const accepted: ServerProductScanResult = {
      kind: "accepted",
      orderItemId: `item|${data.orderId}`,
      variantId: VARIANT,
      productName: productName(data.orderId),
    };
    if (server.scanMode === "pending") {
      return new Promise<ServerProductScanResult>((resolve) => {
        server.pendingScans.push(() => resolve(accepted));
      });
    }
    return accepted;
  },
  markOrderPackedFn: async () => {
    if (server.markMode === "pending") {
      return new Promise<MarkPackedResult>((resolve) => {
        server.pendingMark = resolve;
      });
    }
    return { kind: "packed", deliveryId: null } satisfies MarkPackedResult;
  },
}));

mock.module("@/components/barcode/CameraScanSheet", () => ({
  // The shared scan entry point (camera / typed code) — onCode is handleScan.
  CameraScanSheet: (props: { onCode: (code: string) => void }) =>
    createElement("camera-sheet", props),
}));

mock.module("@/design-system/BottomNav", () => ({
  // App navigation chrome (router + Apsi console) is outside this screen's state.
  BottomNav: () => null,
  SELLER_TABS: { left: [], right: [] },
}));

mock.module("@/lib/feedback", () => ({
  notifySuccess: (title: string) => notifications.push(`success:${title}`),
  notifyError: (title: string) => notifications.push(`error:${title}`),
}));

mock.module("@tanstack/react-router", () => ({
  ...actualRouter,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ orderId: ORDER_1 }),
    useRouteContext: () => ({ session: { userId: USER_A }, organizationId: ORG_A }),
  }),
  Link: ({ children }: { children: ReactElement }) => createElement("a", null, children),
  useNavigate: () => (to: unknown) => navigations.push(to),
  useRouterState: () => "/app/pack/x",
}));

let PackOrderIdentityBoundary: (typeof import("@/routes/app.pack.$orderId"))["PackOrderIdentityBoundary"];
let CapabilityProvider: (typeof import("@/hooks/use-capabilities"))["CapabilityProvider"];
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];

beforeAll(async () => {
  (globalThis as any).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const head = { appendChild: () => undefined };
  (globalThis as any).document = {
    visibilityState: "visible",
    head,
    getElementsByTagName: () => [head],
    createElement: () => ({ appendChild: () => undefined }),
    createTextNode: () => ({}),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  ({ PackOrderIdentityBoundary } = await import("@/routes/app.pack.$orderId"));
  CapabilityProvider = (await import("@/hooks/use-capabilities")).CapabilityProvider;
  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.assign(server, {
    userId: USER_A,
    organizationId: ORG_A,
    scanMode: "accept",
    pendingScans: [],
    markMode: "packed",
    pendingMark: null,
  });
  navigations.length = 0;
  notifications.length = 0;
});

let mounted: ReactTestRenderer | null = null;

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

interface Identity {
  userId: string;
  organizationId: string;
  orderId: string;
}

function tree(client: QueryClientType, identity: Identity) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      CapabilityProvider,
      {
        userId: identity.userId,
        organizationId: identity.organizationId,
        initialResult: capabilityResult(),
      },
      createElement(PackOrderIdentityBoundary, identity),
    ),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(client: QueryClientType, identity: Identity) {
  await act(async () => {
    mounted = create(tree(client, identity));
  });
  await settle();
}

async function update(client: QueryClientType, identity: Identity) {
  await act(async () => mounted!.update(tree(client, identity)));
  await settle();
}

function text(): string {
  return JSON.stringify(mounted!.toJSON());
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

function button(label: string) {
  return mounted!.root
    .findAllByType("button")
    .find((candidate) => renderedText(candidate).includes(label));
}

async function scan(code: string) {
  const sheet = mounted!.root.findByType("camera-sheet" as any);
  await act(async () => sheet.props["onCode"](code));
  await settle();
}

async function confirmByHand() {
  const action = button("Confirm");
  expect(action).toBeDefined();
  await act(async () => action!.props["onClick"]());
  await settle();
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Pack one unit (scan) + one (by hand): progress 2/2, feedback shown, line complete. */
async function packCompletely() {
  await scan(BARCODE);
  await confirmByHand();
  expect(text()).toContain("2 / 2 packed");
  expect(text()).toContain("Correct item packed");
  expect(text()).toContain("Every item is in the parcel");
}

function expectFreshSession(identity: Identity) {
  const current = text();
  expect(current).toContain(
    `Shirt|${identity.userId}|${identity.organizationId}|${identity.orderId}`,
  );
  expect(current).toContain("0 / 2 packed");
  expect(current).not.toContain("Correct item packed");
  expect(current).not.toContain("Item confirmed by hand");
  expect(current).not.toContain("Every item is in the parcel");
  expect(button("Mark Packed")?.props["disabled"]).toBe(true);
}

describe("PackOrderIdentityBoundary", () => {
  it("order switch: progress, feedback and completed items reset", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };
    await mount(queryClient, first);
    await packCompletely();

    const next = { ...first, orderId: ORDER_2 };
    await update(queryClient, next);
    expectFreshSession(next);
    expect(text()).not.toContain(ORDER_1);
  });

  it("user switch: nothing from the previous user's session survives", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };
    await mount(queryClient, first);
    await packCompletely();

    server.userId = USER_B;
    const next = { ...first, userId: USER_B };
    await update(queryClient, next);
    expectFreshSession(next);
    expect(text()).not.toContain(`|${USER_A}|`);
  });

  it("organization switch: nothing from the previous organization survives", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };
    await mount(queryClient, first);
    await packCompletely();

    server.organizationId = ORG_B;
    const next = { ...first, organizationId: ORG_B };
    await update(queryClient, next);
    expectFreshSession(next);
    expect(text()).not.toContain(`|${ORG_A}|`);
  });

  it("in-flight scan: a late response for the old identity is dropped", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };
    server.scanMode = "pending";
    await mount(queryClient, first);
    await scan(BARCODE);
    expect(server.pendingScans).toHaveLength(1);
    const resolveOldScan = server.pendingScans[0]!;

    server.userId = USER_B;
    server.scanMode = "accept";
    const next = { ...first, userId: USER_B };
    await update(queryClient, next);
    expectFreshSession(next);

    await act(async () => resolveOldScan({} as ServerProductScanResult));
    await settle();
    expectFreshSession(next);

    // The new identity's own scan queue is independent and still works.
    await scan(BARCODE);
    expect(text()).toContain("1 / 2 packed");
  });

  it("in-flight Mark Packed: a late success for the old identity neither notifies nor navigates", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };
    server.markMode = "pending";
    await mount(queryClient, first);
    await packCompletely();
    const mark = button("Mark Packed");
    await act(async () => mark!.props["onClick"]());
    await settle();
    const resolveOldMark = server.pendingMark;
    expect(resolveOldMark).not.toBeNull();

    server.organizationId = ORG_B;
    const next = { ...first, organizationId: ORG_B };
    await update(queryClient, next);
    expectFreshSession(next);

    await act(async () => resolveOldMark?.({ kind: "packed", deliveryId: null }));
    await settle();
    expect(navigations).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expectFreshSession(next);
  });
});
