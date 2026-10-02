/**
 * Courier Handoff mounted-component regressions.
 *
 * These tests mount the shipped identity boundary and stateful screen with a
 * real QueryClient and the real CapabilityProvider. Only the server-function
 * network edges and router primitives are replaced. This exercises React's
 * actual keyed reconciliation, mutation observers, capability query, cache,
 * and fail-closed render boundary rather than a parallel state model.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import * as actualRouter from "@tanstack/react-router";
import type { CapabilityResult, UiPermissionKey } from "@/lib/capabilities";
import type { HandoffPreview, HandoffResult } from "@/lib/handoff";
import { handoffKeys } from "@/lib/handoff-query";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const PARCEL_A = "PARCEL-A";
const PARCEL_B = "PARCEL-B";

type ConfirmMode = "success" | "domain-failure" | "reject" | "pending";

interface FakeServer {
  userId: string;
  organizationId: string;
  granted: boolean;
  confirmMode: ConfirmMode;
  previewFetches: number;
  capabilityFetches: number;
  pendingResolve: ((result: HandoffResult) => void) | null;
}

const server: FakeServer = {
  userId: USER_A,
  organizationId: ORG_A,
  granted: true,
  confirmMode: "success",
  previewFetches: 0,
  capabilityFetches: 0,
  pendingResolve: null,
};

function permissions(): UiPermissionKey[] {
  return server.granted ? ["delivery.handoff"] : [];
}

function capabilityResult(): CapabilityResult {
  return {
    status: "active",
    userId: server.userId,
    organizationId: server.organizationId,
    role: "STAFF",
    permissions: permissions(),
  };
}

function preview(parcelCode: string): HandoffPreview {
  return {
    parcelId: `parcel:${parcelCode}`,
    parcelCode,
    orderId: `order:${server.userId}:${server.organizationId}:${parcelCode}`,
    orderNumber: `${server.userId}|${server.organizationId}|${parcelCode}`,
    deliveryId: `delivery:${parcelCode}`,
    deliveryStatus: "ready",
    providerName: "Flash Express",
    externalTrackingNumber: `TRACK:${server.userId}:${server.organizationId}:${parcelCode}`,
    eligible: true,
    reason: null,
  };
}

function success(parcelCode: string): HandoffResult {
  const current = preview(parcelCode);
  return {
    kind: "success",
    handoff: {
      parcelId: current.parcelId,
      parcelCode,
      orderId: current.orderId,
      orderNumber: current.orderNumber,
      deliveryId: current.deliveryId!,
      providerName: current.providerName,
      externalTrackingNumber: current.externalTrackingNumber,
      handedOffAt: "2026-10-02T00:00:00.000Z",
    },
  };
}

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => {
    server.capabilityFetches += 1;
    return capabilityResult();
  },
}));

mock.module("@/api/handoff", () => ({
  getHandoffPreviewFn: async ({ data }: { data: { parcelCode: string } }) => {
    server.previewFetches += 1;
    if (!server.granted) throw new Error("Forbidden");
    return preview(data.parcelCode);
  },
  confirmHandoffFn: async ({ data }: { data: { parcelCode: string } }) => {
    if (server.confirmMode === "reject") throw new Error("network failure");
    if (server.confirmMode === "domain-failure") {
      return { kind: "delivery_not_ready", currentStatus: "preparing" } satisfies HandoffResult;
    }
    if (server.confirmMode === "pending") {
      return new Promise<HandoffResult>((resolve) => {
        server.pendingResolve = resolve;
      });
    }
    return success(data.parcelCode);
  },
}));

mock.module("@tanstack/react-router", () => ({
  ...actualRouter,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ parcelCode: PARCEL_A }),
    useRouteContext: () => ({ session: { userId: USER_A }, organizationId: ORG_A }),
  }),
  Link: ({ children }: { children: ReactElement }) => createElement("a", null, children),
  useNavigate: () => () => undefined,
}));

let CourierHandoffIdentityBoundary: (typeof import("@/routes/app.handoff.$parcelCode"))["CourierHandoffIdentityBoundary"];
let CapabilityProvider: (typeof import("@/hooks/use-capabilities"))["CapabilityProvider"];
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];
let sensitiveRevalidateMs: number;

beforeAll(async () => {
  // React Query enables refetch intervals only in a client environment. Supply
  // the browser signals before importing it; react-test-renderer itself needs
  // no DOM, while these no-op listeners model an open mounted tab.
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
  };
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  ({ CourierHandoffIdentityBoundary } = await import("@/routes/app.handoff.$parcelCode"));
  const capabilityModule = await import("@/hooks/use-capabilities");
  CapabilityProvider = capabilityModule.CapabilityProvider;
  sensitiveRevalidateMs = capabilityModule.SENSITIVE_CAPABILITY_REVALIDATE_MS;
  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.assign(server, {
    userId: USER_A,
    organizationId: ORG_A,
    granted: true,
    confirmMode: "success" as ConfirmMode,
    previewFetches: 0,
    capabilityFetches: 0,
    pendingResolve: null,
  });
});

let mounted: ReactTestRenderer | null = null;

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

interface Identity {
  userId: string;
  organizationId: string;
  parcelCode: string;
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
      createElement(CourierHandoffIdentityBoundary, {
        ...identity,
        onBack: () => undefined,
      }),
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
    .find((candidate) => renderedText(candidate) === label);
}

async function confirm() {
  const action = button("Confirm Handoff");
  expect(action).toBeDefined();
  await act(async () => action!.props["onClick"]());
  await settle();
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("CourierHandoffIdentityBoundary", () => {
  it("resets a successful handoff before rendering a different parcel", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, parcelCode: PARCEL_A };
    await mount(queryClient, first);
    await confirm();
    expect(text()).toContain("Handoff confirmed");

    await update(queryClient, { ...first, parcelCode: PARCEL_B });
    expect(text()).toContain(`${USER_A}|${ORG_A}|${PARCEL_B}`);
    expect(text()).not.toContain("Handoff confirmed");
    expect(button("Confirm Handoff")).toBeDefined();
  });

  it("resets a server failure and a rejected mutation across organization changes", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, parcelCode: PARCEL_A };
    server.confirmMode = "domain-failure";
    await mount(queryClient, first);
    await confirm();
    expect(text()).toContain("The delivery must be in 'ready' status before handoff.");

    server.organizationId = ORG_B;
    await update(queryClient, { ...first, organizationId: ORG_B });
    expect(text()).toContain(`${USER_A}|${ORG_B}|${PARCEL_A}`);
    expect(text()).not.toContain("The delivery must be in 'ready' status before handoff.");

    server.confirmMode = "reject";
    await confirm();
    expect(text()).toContain("Something went wrong while confirming the handoff.");
  });

  it("drops an in-flight mutation across a principal switch and ignores its late success", async () => {
    const queryClient = client();
    const first = { userId: USER_A, organizationId: ORG_A, parcelCode: PARCEL_A };
    server.confirmMode = "pending";
    await mount(queryClient, first);
    await confirm();
    expect(text()).toContain("Confirming...");
    const resolveOldMutation = server.pendingResolve;

    server.userId = USER_B;
    server.confirmMode = "success";
    await update(queryClient, { ...first, userId: USER_B });
    expect(text()).toContain(`${USER_B}|${ORG_A}|${PARCEL_A}`);
    expect(text()).not.toContain("Confirming...");
    expect(text()).not.toContain("Handoff confirmed");

    await act(async () => resolveOldMutation?.(success(PARCEL_A)));
    await settle();
    expect(text()).toContain(`${USER_B}|${ORG_A}|${PARCEL_A}`);
    expect(text()).not.toContain("Handoff confirmed");
  });
});

describe("mounted capability revocation", () => {
  it("granted -> visible -> server-revoked is polled, evicted, disabled, and failed closed", async () => {
    const queryClient = client();
    const identity = { userId: USER_A, organizationId: ORG_A, parcelCode: PARCEL_A };
    await mount(queryClient, identity);
    expect(text()).toContain(`${USER_A}|${ORG_A}|${PARCEL_A}`);
    expect(queryClient.getQueryData(handoffKeys.preview(USER_A, ORG_A, PARCEL_A))).toBeDefined();

    const capabilityFetchesBeforeRevoke = server.capabilityFetches;
    server.granted = false;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, sensitiveRevalidateMs + 100));
    });
    await settle();

    expect(server.capabilityFetches).toBeGreaterThan(capabilityFetchesBeforeRevoke);
    expect(text()).toContain("Permission denied");
    expect(text()).not.toContain(`${USER_A}|${ORG_A}|${PARCEL_A}`);
    expect(text()).not.toContain(`TRACK:${USER_A}:${ORG_A}:${PARCEL_A}`);
    expect(queryClient.getQueryData(handoffKeys.preview(USER_A, ORG_A, PARCEL_A))).toBeUndefined();

    const fetchesAfterRevoke = server.previewFetches;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: handoffKeys.preview(USER_A, ORG_A, PARCEL_A),
      });
    });
    await settle();
    expect(server.previewFetches).toBe(fetchesAfterRevoke);
    const retainedOperationalData = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === "handoff")
      .map((query) => query.state.data)
      .filter((data) => data !== undefined);
    expect(retainedOperationalData).toHaveLength(0);
  }, 20_000);
});
