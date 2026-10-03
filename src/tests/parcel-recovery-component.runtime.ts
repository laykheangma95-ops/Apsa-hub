/**
 * Create APSA Parcel — mounted-component regressions for the Order detail
 * recovery action (ParcelRecoveryBoundary).
 *
 * Mounts the shipped component with a real QueryClient. Only the network edge
 * (recoverRealOrderParcel) and toast feedback are replaced. Proves:
 *   - authorized members get the action; others see the state, never a button
 *   - success writes the server's detail (parcel present) and refreshes this
 *     order's pack state / deliveries — so the action disappears
 *   - a refusal because the order moved (e.g. cancelled) says so and re-reads
 *   - the mutation, its pending state and notice never survive an order, user
 *     or organization switch; a late response for an old identity is dropped
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const ORDER_1 = "11111111-1111-4111-8111-111111111111";
const ORDER_2 = "22222222-2222-4222-8222-222222222222";

type Outcome = { ok: true; detail: unknown } | { ok: false; error: Error };

interface FakeServer {
  mode: "pending" | "created" | "cancelled" | "failed";
  pending: ((outcome: Outcome) => void)[];
  calls: string[];
}

const server: FakeServer = { mode: "pending", pending: [], calls: [] };
const notifications: string[] = [];

const recoveredDetail = (orderId: string) => ({
  order: { id: orderId, lifecycleStatus: "confirmed" },
  items: [],
  parcelMissing: false,
});

function stale(): Error {
  return Object.assign(
    new Error("Order status changed concurrently (now cancelled) — re-read and retry"),
    { statusCode: 409 },
  );
}

mock.module("@/lib/api", () => ({
  recoverRealOrderParcel: async (orderId: string) => {
    server.calls.push(orderId);
    if (server.mode === "pending") {
      const outcome = await new Promise<Outcome>((resolve) => server.pending.push(resolve));
      if (!outcome.ok) throw outcome.error;
      return outcome.detail;
    }
    if (server.mode === "cancelled") throw stale();
    if (server.mode === "failed") throw new Error("boom");
    return recoveredDetail(orderId);
  },
}));

mock.module("@/lib/feedback", () => ({
  notifySuccess: (title: string) => notifications.push(`success:${title}`),
  notifyError: (title: string) => notifications.push(`error:${title}`),
}));

let ParcelRecoveryBoundary: (typeof import("@/components/fulfillment/ParcelRecoveryAction"))["ParcelRecoveryBoundary"];
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];
let ordersKeys: (typeof import("@/lib/orders-query"))["ordersKeys"];

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
  ({ ordersKeys } = await import("@/lib/orders-query"));
  ({ ParcelRecoveryBoundary } = await import("@/components/fulfillment/ParcelRecoveryAction"));
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

interface Props {
  userId: string;
  organizationId: string;
  orderId: string;
  canRecover: boolean;
}

const CREATE = "Create APSA Parcel";
const DONE = "APSA Parcel created.";
const NOT_CONFIRMED = "This order is no longer confirmed";
const FAILED = "Could not create the APSA Parcel";
const NO_PERMISSION = "Ask a member who can confirm orders";

function tree(client: QueryClientType, props: Props) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(ParcelRecoveryBoundary, props),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(client: QueryClientType, props: Props) {
  await act(async () => {
    mounted = create(tree(client, props));
  });
  await settle();
}

async function update(client: QueryClientType, props: Props) {
  await act(async () => mounted!.update(tree(client, props)));
  await settle();
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

const text = () => renderedText(mounted!.root);

function createButton() {
  const found = mounted!.root
    .findAllByType("button")
    .find((candidate) => renderedText(candidate).includes(CREATE));
  expect(found).toBeDefined();
  return found!;
}

async function clickCreate() {
  await act(async () => createButton().props["onClick"]());
  await settle();
}

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
  expect(createButton().props["disabled"]).toBe(false);
  expect(createButton().props["aria-busy"]).toBe(false);
  expect(text()).not.toContain(NOT_CONFIRMED);
  expect(text()).not.toContain(FAILED);
}

const FIRST: Props = { userId: USER_A, organizationId: ORG_A, orderId: ORDER_1, canRecover: true };

describe("ParcelRecoveryBoundary", () => {
  it("explains the stranded state; a member without orders.confirm gets no button", async () => {
    const { queryClient } = client();
    await mount(queryClient, { ...FIRST, canRecover: false });
    expect(text()).toContain("APSA Parcel not created yet");
    expect(text()).toContain(NO_PERMISSION);
    expect(
      mounted!.root.findAllByType("button").filter((b) => renderedText(b).includes(CREATE)),
    ).toHaveLength(0);
    expect(server.calls).toHaveLength(0);
  });

  it("success writes the server's detail (parcel present) and refreshes this order's caches", async () => {
    const { queryClient, invalidated } = client();
    server.mode = "created";
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(server.calls).toEqual([ORDER_1]);
    expect(notifications).toEqual([`success:${DONE}`]);
    const cached = queryClient.getQueryData(ordersKeys.detail(USER_A, ORG_A, ORDER_1)) as any;
    expect(cached.parcelMissing).toBe(false);
    // Pack state, deliveries and the list — this principal's, this order's.
    expect(invalidated).toHaveLength(3);
    for (const key of invalidated) expect(JSON.stringify(key)).toContain(USER_A);
    expect(JSON.stringify(invalidated)).toContain(ORDER_1);
  });

  it("a refusal because the order was cancelled says so and re-reads the order", async () => {
    const { queryClient, invalidated } = client();
    server.mode = "cancelled";
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(text()).toContain(NOT_CONFIRMED);
    expect(notifications).toHaveLength(0);
    expect(JSON.stringify(invalidated)).toBe(
      JSON.stringify([ordersKeys.detail(USER_A, ORG_A, ORDER_1)]),
    );

    server.mode = "failed";
    await clickCreate();
    expect(text()).toContain(FAILED);
  });

  it("order switch: the pending recovery and its loading state do not carry over", async () => {
    const { queryClient } = client();
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(createButton().props["disabled"]).toBe(true);
    expect(createButton().props["aria-busy"]).toBe(true);

    await update(queryClient, { ...FIRST, orderId: ORDER_2 });
    expectFresh();
  });

  it("organization switch: a notice from the previous organization is gone", async () => {
    const { queryClient } = client();
    server.mode = "failed";
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(text()).toContain(FAILED);

    await update(queryClient, { ...FIRST, organizationId: ORG_B });
    expectFresh();
  });

  it("user switch: the pending recovery and any notice reset", async () => {
    const { queryClient } = client();
    server.mode = "failed";
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(text()).toContain(FAILED);
    server.mode = "pending";
    await clickCreate();
    expect(createButton().props["disabled"]).toBe(true);

    await update(queryClient, { ...FIRST, userId: USER_B });
    expectFresh();
  });

  it("late response: dropped for the old identity — no toast, notice or cache writes", async () => {
    const { queryClient, invalidated } = client();
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(server.pending).toHaveLength(1);
    const resolveOld = server.pending[0]!;

    const next: Props = {
      userId: USER_B,
      organizationId: ORG_B,
      orderId: ORDER_2,
      canRecover: true,
    };
    await update(queryClient, next);
    expectFresh();

    await act(async () => resolveOld({ ok: true, detail: recoveredDetail(ORDER_1) }));
    await settle();
    expect(notifications).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
    expect(queryClient.getQueryData(ordersKeys.detail(USER_A, ORG_A, ORDER_1))).toBeUndefined();
    expect(queryClient.getQueryData(ordersKeys.detail(USER_B, ORG_B, ORDER_2))).toBeUndefined();
    expectFresh();

    // A late refusal for the old identity is dropped the same way.
    await update(queryClient, FIRST);
    await clickCreate();
    const resolveOldRefusal = server.pending[1]!;
    await update(queryClient, next);
    await act(async () => resolveOldRefusal({ ok: false, error: stale() }));
    await settle();
    expect(invalidated).toHaveLength(0);
    expectFresh();

    // The new identity's own recovery is independent and still works.
    server.mode = "created";
    await clickCreate();
    expect(server.calls.at(-1)).toBe(ORDER_2);
    expect(notifications).toEqual([`success:${DONE}`]);
  });
});

// ── Permission generation ─────────────────────────────────────────────────────
//
// The recovery permission is part of the operation's identity. A request
// started while the member could recover belongs to THAT permission
// generation: once canRecover changes, its late success or error must do
// nothing — and restoring the permission must never make it eligible again.

describe("ParcelRecoveryBoundary — permission generation", () => {
  const REVOKED: Props = { ...FIRST, canRecover: false };
  const detailKey = () => ordersKeys.detail(USER_A, ORG_A, ORDER_1);

  /** Nothing from an old generation reached the UI, the toasts or the caches. */
  function expectUntouched(invalidated: unknown[], queryClient: QueryClientType) {
    expect(notifications).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(queryClient.getQueryData(detailKey())).toBeUndefined();
    expect(text()).not.toContain(NOT_CONFIRMED);
    expect(text()).not.toContain(FAILED);
  }

  function expectNoControl() {
    expect(
      mounted!.root.findAllByType("button").filter((b) => renderedText(b).includes(CREATE)),
    ).toHaveLength(0);
    expect(text()).toContain(NO_PERMISSION);
  }

  async function startPendingThenRevoke(queryClient: QueryClientType) {
    await mount(queryClient, FIRST);
    await clickCreate();
    expect(createButton().props["disabled"]).toBe(true);
    expect(server.pending).toHaveLength(1);
    await update(queryClient, REVOKED);
    expectNoControl();
    return server.pending[0]!;
  }

  it("1. revoked during a pending success: the late success does nothing", async () => {
    const { queryClient, invalidated } = client();
    const resolveOld = await startPendingThenRevoke(queryClient);

    await act(async () => resolveOld({ ok: true, detail: recoveredDetail(ORDER_1) }));
    await settle();
    expectUntouched(invalidated, queryClient);
    expectNoControl();
  });

  it("2. revoked during a pending error: the late refusal or failure does nothing", async () => {
    for (const error of [stale(), new Error("boom")]) {
      const { queryClient, invalidated } = client();
      const rejectOld = await startPendingThenRevoke(queryClient);

      await act(async () => rejectOld({ ok: false, error }));
      await settle();
      expectUntouched(invalidated, queryClient);
      expectNoControl();
      await act(async () => mounted?.unmount());
      mounted = null;
      server.pending.length = 0;
    }
  });

  it("3. revoked then restored before an old success returns: old discarded, new accepted", async () => {
    const { queryClient, invalidated } = client();
    const resolveA = await startPendingThenRevoke(queryClient);

    // Restored: a fresh control, nothing pending from the old generation.
    await update(queryClient, FIRST);
    expectFresh();

    // Request B under the restored permission.
    await clickCreate();
    expect(server.pending).toHaveLength(2);
    const resolveB = server.pending[1]!;
    expect(createButton().props["disabled"]).toBe(true);

    // A returns late: discarded completely, B is still the pending one.
    await act(async () =>
      resolveA({ ok: true, detail: { ...recoveredDetail(ORDER_1), tag: "A" } }),
    );
    await settle();
    expectUntouched(invalidated, queryClient);
    expect(createButton().props["disabled"]).toBe(true);

    // B returns: accepted normally, and the cached detail is B's.
    await act(async () =>
      resolveB({ ok: true, detail: { ...recoveredDetail(ORDER_1), tag: "B" } }),
    );
    await settle();
    expect(notifications).toEqual([`success:${DONE}`]);
    expect((queryClient.getQueryData(detailKey()) as any).tag).toBe("B");
    expect(JSON.stringify(invalidated)).toBe(
      JSON.stringify([
        ordersKeys.detailDeliveries(USER_A, ORG_A, ORDER_1),
        (await import("@/lib/packing-query")).packingKeys.orderState(USER_A, ORG_A, ORDER_1),
        ordersKeys.list(USER_A, ORG_A),
      ]),
    );
  });

  it("4. revoked then restored before an old error returns: no stale notice, B still works", async () => {
    const { queryClient, invalidated } = client();
    const rejectA = await startPendingThenRevoke(queryClient);
    await update(queryClient, FIRST);
    expectFresh();
    await clickCreate();
    const resolveB = server.pending[1]!;

    await act(async () => rejectA({ ok: false, error: stale() }));
    await settle();
    expectUntouched(invalidated, queryClient);
    expect(createButton().props["disabled"]).toBe(true); // still B's own pending

    await act(async () => resolveB({ ok: true, detail: recoveredDetail(ORDER_1) }));
    await settle();
    expect(notifications).toEqual([`success:${DONE}`]);
    expect((queryClient.getQueryData(detailKey()) as any).parcelMissing).toBe(false);
    expect(invalidated).toHaveLength(3);
  });

  it("5. after a revoke/restore cycle with nothing in flight, a new recovery succeeds normally", async () => {
    const { queryClient, invalidated } = client();
    await mount(queryClient, FIRST);
    await update(queryClient, REVOKED);
    await update(queryClient, FIRST);
    server.mode = "created";
    await clickCreate();
    expect(notifications).toEqual([`success:${DONE}`]);
    expect((queryClient.getQueryData(detailKey()) as any).parcelMissing).toBe(false);
    expect(invalidated).toHaveLength(3);
  });

  it("6. an old error after restore cannot overwrite the new request's own notice", async () => {
    const { queryClient, invalidated } = client();
    const rejectA = await startPendingThenRevoke(queryClient);
    await update(queryClient, FIRST);
    server.mode = "failed";
    await clickCreate(); // B fails immediately with its own notice
    expect(text()).toContain(FAILED);
    expect(text()).not.toContain(NOT_CONFIRMED);

    await act(async () => rejectA({ ok: false, error: stale() }));
    await settle();
    // A's "no longer confirmed" notice and its detail re-read never appear.
    expect(text()).toContain(FAILED);
    expect(text()).not.toContain(NOT_CONFIRMED);
    expect(invalidated).toEqual([]);
    expect(notifications).toEqual([]);
  });
});
