/**
 * Customer Returns mounted-component regressions.
 *
 * Mounts the shipped identity boundaries (return detail, new return) with a
 * real QueryClient and the real CapabilityProvider. Only the server-function
 * network edges and router primitives are replaced, so React's keyed
 * reconciliation, the capability query, the cache and the fail-closed access
 * boundary are the production ones.
 *
 * Proves: a response that arrives after navigation, sign-out, an organization
 * switch or a permission change sets no state, writes and invalidates no
 * cache, and navigates nowhere; a denied screen never reads or shows a cached
 * order identity, and losing the grant evicts the cached payload at once.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import * as actualRouter from "@tanstack/react-router";
import { capabilityQueryKey, type CapabilityResult } from "@/lib/capabilities";
import {
  returnsKeys,
  type RequestReturnResult,
  type ReturnDetail,
  type ReturnStepResult,
} from "@/lib/returns";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const RETURN_1 = "11111111-1111-4111-8111-111111111111";

interface FakeServer {
  userId: string;
  organizationId: string;
  granted: boolean;
  pending: Array<(value: unknown) => void>;
  stepCalls: number;
}

const server: FakeServer = {
  userId: USER_A,
  organizationId: ORG_A,
  granted: true,
  pending: [],
  stepCalls: 0,
};

function capabilityResult(): CapabilityResult {
  return {
    status: "active",
    userId: server.userId,
    organizationId: server.organizationId,
    role: "MANAGER",
    permissions: server.granted ? ["orders.return", "orders.read"] : ["orders.read"],
  };
}

/** The order identity a detail screen would show — unique per principal and return. */
function orderNumberFor(userId: string, organizationId: string, returnId: string) {
  return `ORD|${userId}|${organizationId}|${returnId}`;
}

function detail(status: ReturnDetail["status"], returnId = RETURN_1): ReturnDetail {
  return {
    returnId,
    orderId: "order-1",
    orderNumber: orderNumberFor(server.userId, server.organizationId, returnId),
    status,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    lines: [
      {
        returnItemId: "22222222-2222-4222-8222-222222222222",
        orderItemId: "33333333-3333-4333-8333-333333333333",
        productName: "Shirt",
        variantName: null,
        sku: null,
        quantity: 1,
        damagedQuantity: status === "requested" || status === "received" ? null : 0,
        resellableQuantity: status === "requested" || status === "received" ? null : 1,
        returnMovementId: null,
        damageMovementId: null,
      },
    ],
    history: [{ fromStatus: null, toStatus: "requested", at: "2026-10-03T00:00:00.000Z" }],
    totals: { quantity: 1, resellable: null, damaged: null },
  };
}

/** Every step and request waits until the test releases it. */
function held<T>(): Promise<T> {
  server.stepCalls += 1;
  return new Promise<T>((resolve) => server.pending.push(resolve as (value: unknown) => void));
}

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => capabilityResult(),
}));

mock.module("@/api/returns", () => ({
  listCustomerReturnsFn: async () => {
    if (!server.granted) throw new Error("Missing permission: orders.return");
    return { returns: [], truncated: false };
  },
  getCustomerReturnFn: async ({ data }: { data: { returnId: string } }) => {
    if (!server.granted) throw new Error("Missing permission: orders.return");
    return { kind: "return", detail: detail("requested", data.returnId) };
  },
  receiveCustomerReturnFn: () => held<ReturnStepResult>(),
  inspectCustomerReturnFn: () => held<ReturnStepResult>(),
  completeCustomerReturnFn: () => held<ReturnStepResult>(),
  findReturnableOrderFn: async () => ({
    kind: "order",
    order: {
      orderId: "44444444-4444-4444-8444-444444444444",
      orderNumber: "APSA-1",
      lines: [
        {
          orderItemId: "55555555-5555-4555-8555-555555555555",
          productName: "Shirt",
          variantName: null,
          sku: null,
          orderedQuantity: 2,
          alreadyReturned: 0,
          returnableQuantity: 2,
        },
      ],
    },
  }),
  requestCustomerReturnFn: () => held<RequestReturnResult>(),
}));

const navigations: unknown[] = [];

mock.module("@tanstack/react-router", () => ({
  ...actualRouter,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ returnId: RETURN_1 }),
    useRouteContext: () => ({ session: { userId: USER_A }, organizationId: ORG_A }),
  }),
  Link: ({ children }: { children: ReactElement }) => createElement("a", null, children),
  useNavigate: () => (to: unknown) => {
    navigations.push(to);
  },
  useRouterState: () => "/app/returns",
}));

let ReturnDetailIdentityBoundary: (typeof import("@/routes/app.returns.$returnId"))["ReturnDetailIdentityBoundary"];
let NewReturnIdentityBoundary: (typeof import("@/routes/app.returns.new"))["NewReturnIdentityBoundary"];
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
  };
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  ({ ReturnDetailIdentityBoundary } = await import("@/routes/app.returns.$returnId"));
  ({ NewReturnIdentityBoundary } = await import("@/routes/app.returns.new"));
  CapabilityProvider = (await import("@/hooks/use-capabilities")).CapabilityProvider;
  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.assign(server, {
    userId: USER_A,
    organizationId: ORG_A,
    granted: true,
    pending: [],
    stepCalls: 0,
  });
  navigations.length = 0;
});

let mounted: ReactTestRenderer | null = null;

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

interface Identity {
  userId: string;
  organizationId: string;
  returnId: string;
}

/** A QueryClient that records every cache write and invalidation it receives. */
function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const writes: unknown[] = [];
  const invalidations: unknown[] = [];
  const setQueryData = queryClient.setQueryData.bind(queryClient);
  const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
  (queryClient as any).setQueryData = (key: unknown, updater: unknown) => {
    writes.push(key);
    return setQueryData(key as any, updater as any);
  };
  (queryClient as any).invalidateQueries = (filters: unknown) => {
    invalidations.push(filters);
    return invalidateQueries(filters as any);
  };
  return { queryClient, writes, invalidations };
}

function provider(
  queryClient: QueryClientType,
  identity: { userId: string; organizationId: string },
  child: ReactElement,
) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      CapabilityProvider,
      {
        userId: identity.userId,
        organizationId: identity.organizationId,
        initialResult: capabilityResult(),
      },
      child,
    ),
  );
}

function detailTree(queryClient: QueryClientType, identity: Identity) {
  return provider(
    queryClient,
    identity,
    createElement(ReturnDetailIdentityBoundary, { ...identity, onBack: () => undefined }),
  );
}

const requested: string[] = [];

function newTree(
  queryClient: QueryClientType,
  identity: { userId: string; organizationId: string },
) {
  return provider(
    queryClient,
    identity,
    createElement(NewReturnIdentityBoundary, {
      ...identity,
      onBack: () => undefined,
      onRequested: (returnId: string) => requested.push(returnId),
    }),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function render(tree: ReactElement) {
  await act(async () => {
    if (mounted) mounted.update(tree);
    else mounted = create(tree);
  });
  await settle();
}

async function unmount() {
  await act(async () => mounted?.unmount());
  mounted = null;
  await settle();
}

function text(): string {
  return mounted ? JSON.stringify(mounted.toJSON()) : "";
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

async function press(label: string) {
  const target = mounted!.root
    .findAllByType("button")
    .find((candidate) => renderedText(candidate) === label);
  expect(target).toBeDefined();
  await act(async () => target!.props["onClick"]());
  await settle();
}

/** Release every held server call with `value`. */
async function releaseAll(value: unknown) {
  const pending = server.pending.splice(0);
  await act(async () => {
    for (const resolve of pending) resolve(value);
  });
  await settle();
}

async function revoke(
  queryClient: QueryClientType,
  identity: { userId: string; organizationId: string },
) {
  server.granted = false;
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: capabilityQueryKey(identity.userId, identity.organizationId),
    });
  });
  await settle();
}

const A: Identity = { userId: USER_A, organizationId: ORG_A, returnId: RETURN_1 };
const detailKeyA = returnsKeys.detail(USER_A, ORG_A, RETURN_1);
const okReceived = (): ReturnStepResult => ({
  kind: "ok",
  detail: detail("received"),
  replayed: false,
});

describe("return detail — late responses are discarded for a retired identity", () => {
  it("control: a live response updates the screen and the cache", async () => {
    const { queryClient } = client();
    await render(detailTree(queryClient, A));
    expect(text()).toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
    await press("Receive return");
    expect(server.stepCalls).toBe(1);
    await releaseAll(okReceived());
    expect((queryClient.getQueryData(detailKeyA) as any).detail.status).toBe("received");
    expect(text()).toContain("Save inspection");
  });

  it("after navigation away (unmount)", async () => {
    const { queryClient, writes, invalidations } = client();
    await render(detailTree(queryClient, A));
    await press("Receive return");
    await unmount();
    const writesBefore = writes.length;
    const invalidationsBefore = invalidations.length;

    await releaseAll(okReceived());
    expect(writes.length).toBe(writesBefore);
    expect(invalidations.length).toBe(invalidationsBefore);
    expect((queryClient.getQueryData(detailKeyA) as any).detail.status).toBe("requested");
    expect(navigations).toEqual([]);
  });

  it("after sign-out and sign-in as another member", async () => {
    const { queryClient, writes, invalidations } = client();
    await render(detailTree(queryClient, A));
    await press("Receive return");

    server.userId = USER_B;
    await render(detailTree(queryClient, { ...A, userId: USER_B }));
    expect(text()).toContain(orderNumberFor(USER_B, ORG_A, RETURN_1));
    const writesBefore = writes.length;
    const invalidationsBefore = invalidations.length;

    await releaseAll(okReceived());
    expect(writes.length).toBe(writesBefore);
    expect(invalidations.length).toBe(invalidationsBefore);
    expect((queryClient.getQueryData(detailKeyA) as any).detail.status).toBe("requested");
    // The new member's screen is untouched by the old member's answer.
    expect(text()).toContain("Receive return");
    expect(text()).not.toContain("Save inspection");
    expect(text()).not.toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
  });

  it("after an organization switch", async () => {
    const { queryClient, writes, invalidations } = client();
    await render(detailTree(queryClient, A));
    await press("Receive return");

    server.organizationId = ORG_B;
    await render(detailTree(queryClient, { ...A, organizationId: ORG_B }));
    const writesBefore = writes.length;
    const invalidationsBefore = invalidations.length;

    await releaseAll(okReceived());
    expect(writes.length).toBe(writesBefore);
    expect(invalidations.length).toBe(invalidationsBefore);
    expect(text()).toContain(orderNumberFor(USER_A, ORG_B, RETURN_1));
    expect(text()).not.toContain("Save inspection");
  });

  it("after a permission change: evicted at once, never written back", async () => {
    const { queryClient, writes, invalidations } = client();
    await render(detailTree(queryClient, A));
    await press("Receive return");

    await revoke(queryClient, A);
    expect(text()).not.toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
    expect(text()).toContain("Return");
    expect(queryClient.getQueryData(detailKeyA)).toBeUndefined();
    const writesBefore = writes.length;
    const invalidationsBefore = invalidations.length;

    await releaseAll(okReceived());
    expect(writes.length).toBe(writesBefore);
    expect(invalidations.length).toBe(invalidationsBefore);
    expect(queryClient.getQueryData(detailKeyA)).toBeUndefined();
    expect(text()).not.toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
  });
});

describe("cached order identity", () => {
  it("a denied screen never reads or shows a cached return, and evicts it", async () => {
    const { queryClient } = client();
    queryClient.setQueryData(detailKeyA, { kind: "return", detail: detail("inspected") });
    server.granted = false;

    await render(detailTree(queryClient, A));
    expect(text()).not.toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
    expect(text()).not.toContain("Shirt");
    expect(queryClient.getQueryData(detailKeyA)).toBeUndefined();
  });

  it("losing the grant while viewing removes the order number from the header", async () => {
    const { queryClient } = client();
    await render(detailTree(queryClient, A));
    expect(text()).toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));

    await revoke(queryClient, A);
    expect(text()).not.toContain(orderNumberFor(USER_A, ORG_A, RETURN_1));
    expect(queryClient.getQueriesData({ queryKey: returnsKeys.principal(USER_A, ORG_A) })).toEqual(
      [],
    );
  });
});

describe("new return — a late request answer never navigates for a retired identity", () => {
  async function startRequest(queryClient: QueryClientType) {
    await render(newTree(queryClient, { userId: USER_A, organizationId: ORG_A }));
    const input = mounted!.root.findAll((node) => node.props?.id === "return-order")[0]!;
    await act(async () => input.props["onChange"]({ target: { value: "APSA-1" } }));
    const form = mounted!.root.findByType("form");
    await act(async () => form.props["onSubmit"]({ preventDefault: () => undefined }));
    await settle();
    const increase = mounted!.root
      .findAllByType("button")
      .find((candidate) => candidate.props["aria-label"] === "Increase");
    expect(increase).toBeDefined();
    await act(async () => increase!.props["onClick"]());
    await settle();
    await press("Request return");
  }

  it("control: a live request navigates to the new return", async () => {
    requested.length = 0;
    const { queryClient } = client();
    await startRequest(queryClient);
    await releaseAll({ kind: "requested", returnId: RETURN_1, replayed: false });
    expect(requested).toEqual([RETURN_1]);
  });

  it("after an organization switch, after sign-out, after a permission change, and after leaving", async () => {
    for (const retire of ["organization", "member", "permission", "unmount"] as const) {
      requested.length = 0;
      Object.assign(server, { userId: USER_A, organizationId: ORG_A, granted: true, pending: [] });
      if (mounted) await unmount();
      const { queryClient, invalidations } = client();
      await startRequest(queryClient);

      if (retire === "organization") {
        server.organizationId = ORG_B;
        await render(newTree(queryClient, { userId: USER_A, organizationId: ORG_B }));
      } else if (retire === "member") {
        server.userId = USER_B;
        await render(newTree(queryClient, { userId: USER_B, organizationId: ORG_A }));
      } else if (retire === "permission") {
        await revoke(queryClient, { userId: USER_A, organizationId: ORG_A });
      } else {
        await unmount();
      }
      const invalidationsBefore = invalidations.length;

      await releaseAll({ kind: "requested", returnId: RETURN_1, replayed: false });
      expect(requested).toEqual([]);
      expect(invalidations.length).toBe(invalidationsBefore);
      expect(text()).not.toContain("Requesting");
    }
  });
});
