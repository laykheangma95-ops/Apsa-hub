/**
 * Retry delivery ready — mounted-component regressions: state isolation by
 * identity.
 *
 * Mounts the shipped RetryDeliveryReadyBoundary (the action Order detail
 * renders) with a real QueryClient. Only the server-function network edge and
 * toast feedback are replaced. Proves the retry mutation, its pending state and
 * its notice never survive an order, user or organization switch, and that a
 * late response for an old identity neither notifies, shows a notice, nor
 * touches caches.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import type { RetryDeliveryReadyResult } from "@/server/packing/types";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const ORDER_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_2 = "22222222-2222-4222-8222-222222222222";

interface FakeServer {
  mode: "pending" | "ready" | "not_packed";
  pending: ((result: RetryDeliveryReadyResult) => void)[];
  calls: string[];
}

const server: FakeServer = { mode: "pending", pending: [], calls: [] };
const notifications: string[] = [];

mock.module("@/api/packing", () => ({
  retryPackedDeliveryReadyFn: async ({ data }: { data: { orderId: string } }) => {
    server.calls.push(data.orderId);
    if (server.mode === "pending") {
      return new Promise<RetryDeliveryReadyResult>((resolve) => server.pending.push(resolve));
    }
    if (server.mode === "not_packed") return { kind: "not_packed" };
    return { kind: "ready", deliveryId: `delivery|${data.orderId}` };
  },
}));

mock.module("@/lib/feedback", () => ({
  notifySuccess: (title: string) => notifications.push(`success:${title}`),
  notifyError: (title: string) => notifications.push(`error:${title}`),
}));

let RetryDeliveryReadyBoundary: (typeof import("@/components/fulfillment/RetryDeliveryReadyAction"))["RetryDeliveryReadyBoundary"];
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];

beforeAll(async () => {
  (globalThis as any).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as any).document = {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  ({ RetryDeliveryReadyBoundary } =
    await import("@/components/fulfillment/RetryDeliveryReadyAction"));
  await i18n.changeLanguage("en");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.assign(server, { mode: "pending", pending: [], calls: [] });
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

const NOT_PACKED_TEXT = "The order is no longer packed";
const DONE_TEXT = "Delivery is ready for courier handoff.";

function tree(client: QueryClientType, identity: Identity) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(RetryDeliveryReadyBoundary, identity),
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

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

function text(): string {
  return renderedText(mounted!.root);
}

function retryButton() {
  const found = mounted!.root
    .findAllByType("button")
    .find((candidate) => renderedText(candidate).includes("Retry delivery ready"));
  expect(found).toBeDefined();
  return found!;
}

async function clickRetry() {
  await act(async () => retryButton().props["onClick"]());
  await settle();
}

/** Counts cache invalidations, so a late callback touching caches is visible. */
function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: any) => {
    invalidated.push(filters?.queryKey);
    return original(filters);
  }) as typeof queryClient.invalidateQueries;
  return { queryClient, invalidated };
}

function expectFresh() {
  expect(retryButton().props["disabled"]).toBe(false);
  expect(retryButton().props["aria-busy"]).toBe(false);
  expect(text()).not.toContain(NOT_PACKED_TEXT);
  expect(text()).not.toContain("Could not make the delivery ready");
}

const FIRST: Identity = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1 };

describe("RetryDeliveryReadyBoundary", () => {
  it("same identity: success notifies and refreshes this order's caches; a refusal shows a notice", async () => {
    const { queryClient, invalidated } = client();
    server.mode = "ready";
    await mount(queryClient, FIRST);
    await clickRetry();
    expect(notifications).toEqual([`success:${DONE_TEXT}`]);
    expect(invalidated.length).toBe(3);
    expect(JSON.stringify(invalidated)).toContain(ORDER_1);

    server.mode = "not_packed";
    await clickRetry();
    expect(text()).toContain(NOT_PACKED_TEXT);
  });

  it("order switch: the pending retry and its loading state do not carry over", async () => {
    const { queryClient } = client();
    await mount(queryClient, FIRST);
    await clickRetry();
    expect(retryButton().props["disabled"]).toBe(true);
    expect(retryButton().props["aria-busy"]).toBe(true);

    await update(queryClient, { ...FIRST, orderId: ORDER_2 });
    expectFresh();
  });

  it("organization switch: a notice from the previous organization is gone", async () => {
    const { queryClient } = client();
    server.mode = "not_packed";
    await mount(queryClient, FIRST);
    await clickRetry();
    expect(text()).toContain(NOT_PACKED_TEXT);

    await update(queryClient, { ...FIRST, organizationId: ORG_B });
    expectFresh();
  });

  it("user switch: the pending retry and any notice reset", async () => {
    const { queryClient } = client();
    server.mode = "not_packed";
    await mount(queryClient, FIRST);
    await clickRetry();
    expect(text()).toContain(NOT_PACKED_TEXT);
    server.mode = "pending";
    await clickRetry();
    expect(retryButton().props["disabled"]).toBe(true);

    await update(queryClient, { ...FIRST, userId: USER_B });
    expectFresh();
  });

  it("late retry response: dropped for the old identity — no toast, notice or cache writes", async () => {
    const { queryClient, invalidated } = client();
    await mount(queryClient, FIRST);
    await clickRetry();
    expect(server.pending).toHaveLength(1);
    const resolveOld = server.pending[0]!;

    const next = { userId: USER_B, organizationId: ORG_B, orderId: ORDER_2 };
    await update(queryClient, next);
    expectFresh();

    await act(async () => resolveOld({ kind: "ready", deliveryId: "delivery-old" }));
    await settle();
    expect(notifications).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
    expectFresh();

    // A late refusal for the old identity is dropped the same way.
    await update(queryClient, FIRST);
    await clickRetry();
    const resolveOldRefusal = server.pending[1]!;
    await update(queryClient, next);
    await act(async () => resolveOldRefusal({ kind: "not_packed" }));
    await settle();
    expectFresh();

    // The new identity's own retry is independent and still works.
    server.mode = "ready";
    await clickRetry();
    expect(server.calls.at(-1)).toBe(ORDER_2);
    expect(notifications).toEqual([`success:${DONE_TEXT}`]);
  });
});
