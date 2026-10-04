/**
 * Customer Intelligence — capability revocation on the MOUNTED Customer Detail
 * screen (src/routes/app.customers.$id.tsx → Customer360Screen).
 *
 * Real QueryClient, real CapabilityProvider, real screen, real section. Only
 * the server-function network edges and router primitives are replaced. The
 * fake server answers like the real one: it decides which insight sections to
 * include from the grants the member holds AT THE MOMENT OF THE REQUEST, and a
 * request can be held open so a "late" response can be released after the
 * grants changed.
 *
 * Every revocation below happens AFTER insights are cached and rendered, and
 * every assertion that a value is gone is made while the replacement request
 * is still held — so the value disappears because the screen stopped showing
 * it, not because a newer response replaced it.
 *
 * Spawned by customer-insights-revocation.test.ts (mock.module is process-wide).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import * as actualRouter from "@tanstack/react-router";
import { capabilityQueryKey, type CapabilityResult } from "@/lib/capabilities";
import i18n from "@/lib/i18n";

const USER_A = "user-A";
const USER_B = "user-B";
const ORG_A = "org-A";
const ORG_B = "org-B";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";

const FULL = [
  "customers.read",
  "orders.read",
  "customers.view_sensitive",
  "payments.reconcile",
  "payments.read",
  "delivery.read",
  "orders.return",
];

interface Pending {
  resolve: (value: unknown) => void;
  build: () => unknown;
}

const server = {
  /** Grants per principal, read live by both the capability and insights endpoints. */
  grants: new Map<string, string[]>(),
  /** When true, insights requests wait until released. */
  hold: false,
  pending: [] as Pending[],
  insightCalls: 0,
  /** Bumped to prove a refetch returned NEW authoritative data. */
  delivered: 7,
};

const identity = { userId: USER_A, organizationId: ORG_A };
const principal = (userId: string, organizationId: string) => `${userId}|${organizationId}`;
const grantsOf = (userId = identity.userId, organizationId = identity.organizationId) =>
  server.grants.get(principal(userId, organizationId)) ?? [];

function capabilityResult(): CapabilityResult {
  return {
    status: "active",
    userId: identity.userId,
    organizationId: identity.organizationId,
    role: "MANAGER",
    permissions: grantsOf() as any,
  };
}

/** What the real server would answer for this principal with these grants. */
function insightsFor(organizationId: string, grants: string[]) {
  const can = (k: string) => grants.includes(k);
  if (!can("customers.read") || !can("orders.read")) throw new Error("Missing permission");
  const tag = organizationId === ORG_A ? "ORGA" : "ORGB";
  return {
    status: "available",
    data: {
      customerId: CUSTOMER,
      hasPurchases: true,
      activity: {
        orderCount: organizationId === ORG_A ? 41 : 52,
        openOrderCount: 3,
        completedOrderCount: 38,
        cancelledOrderCount: 0,
        refundedOrderCount: 0,
        firstOrderAt: "2026-01-01T00:00:00.000Z",
        lastOrderAt: "2026-09-10T00:00:00.000Z",
        lastOrderId: "o",
        lastOrderSource: "POS",
        lastOrderProducts: [`${tag}-LAST-PRODUCT`],
        distinctProductCount: 1,
        unitsPurchased: 9,
        conversationLinkedOrderCount: 0,
        sourceCounts: { POS: 41 },
      },
      topProducts: [
        {
          productId: "p",
          label: `${tag}-TOP-PRODUCT`,
          topVariantLabel: null,
          variantCount: 1,
          units: 9,
          orderCount: 9,
          lastPurchasedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
      money:
        can("payments.reconcile") && can("customers.view_sensitive")
          ? {
              status: "available",
              data: [
                {
                  currency: "USD",
                  orderCount: 41,
                  ordered: { amount: 100000, currency: "USD" },
                  received: { amount: 98765, currency: "USD" },
                  refunded: { amount: 0, currency: "USD" },
                  netPaid: { amount: 98765, currency: "USD" },
                  outstanding: { amount: 1235, currency: "USD" },
                  averageOrder: { amount: 2439, currency: "USD" },
                },
              ],
            }
          : { status: "permission_denied" },
      payments: can("payments.read")
        ? { status: "available", data: { methodOrderCounts: { khqr: 5 } } }
        : { status: "permission_denied" },
      delivery: can("delivery.read")
        ? {
            status: "available",
            data: {
              ordersWithDelivery: server.delivered,
              failedAttemptCount: 0,
              currentStatusCounts: { delivered: server.delivered },
            },
          }
        : { status: "permission_denied" },
      returns: can("orders.return")
        ? {
            status: "available",
            data: {
              returnCount: 3,
              returnedOrderCount: 3,
              completedReturnCount: 2,
              completedReturnedUnits: 2,
            },
          }
        : { status: "permission_denied" },
    },
  };
}

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async () => capabilityResult(),
}));

mock.module("@/api/customers", () => ({
  getCustomer360Fn: async () => ({
    customer: {
      id: CUSTOMER,
      nameKm: "Sophea",
      nameEn: "Sophea",
      phone: "012 345 678",
      identities: [],
      tags: [],
      orderCount: 0,
      lifetimeSpend: { amount: 0, currency: "USD" },
      companion: "nilo",
      sensitiveVisible: true,
    },
    notes: [],
    orders: [],
    events: [],
    activeConversationId: null,
  }),
  getCustomerInsightsFn: () => {
    server.insightCalls += 1;
    // Grants and organization as of THIS request — like the real server.
    const organizationId = identity.organizationId;
    const grants = [...grantsOf()];
    const build = () => insightsFor(organizationId, grants);
    if (!server.hold) return Promise.resolve().then(build);
    return new Promise((resolve, reject) =>
      server.pending.push({
        resolve: (value) => (value instanceof Error ? reject(value) : resolve(value)),
        build: () => {
          try {
            return build();
          } catch (error) {
            return error;
          }
        },
      }),
    );
  },
  addCustomerNoteFn: async () => ({}),
}));

mock.module("@/api/orders", () => ({
  listOrdersFn: async () => [],
}));

mock.module("@tanstack/react-router", () => ({
  ...actualRouter,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ id: CUSTOMER }),
    useRouteContext: () => ({
      session: { userId: identity.userId },
      organizationId: identity.organizationId,
    }),
  }),
  Link: ({ children }: { children: ReactElement }) => createElement("a", null, children),
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined } }),
  useCanGoBack: () => false,
  useRouterState: () => "/app/customers",
}));

let Customer360Screen: (typeof import("@/routes/app.customers.$id"))["Customer360Screen"];
let CapabilityProvider: (typeof import("@/hooks/use-capabilities"))["CapabilityProvider"];
let QueryClient: (typeof import("@tanstack/react-query"))["QueryClient"];
let QueryClientProvider: (typeof import("@tanstack/react-query"))["QueryClientProvider"];
let customerKeys: (typeof import("@/lib/customers-query"))["customerKeys"];

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
    // Framer Motion (the screen's segmented tabs) measures page scroll.
    documentElement: { scrollLeft: 0, scrollTop: 0 },
    body: { scrollLeft: 0, scrollTop: 0 },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const queryModule = await import("@tanstack/react-query");
  QueryClient = queryModule.QueryClient;
  QueryClientProvider = queryModule.QueryClientProvider;
  ({ Customer360Screen } = await import("@/routes/app.customers.$id"));
  CapabilityProvider = (await import("@/hooks/use-capabilities")).CapabilityProvider;
  ({ customerKeys } = await import("@/lib/customers-query"));
  await i18n.changeLanguage("en");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  identity.userId = USER_A;
  identity.organizationId = ORG_A;
  server.grants = new Map([
    [principal(USER_A, ORG_A), [...FULL]],
    [principal(USER_B, ORG_B), [...FULL]],
  ]);
  server.hold = false;
  server.pending = [];
  server.insightCalls = 0;
  server.delivered = 7;
});

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function tree(queryClient: QueryClientType) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      CapabilityProvider,
      {
        key: principal(identity.userId, identity.organizationId),
        userId: identity.userId,
        organizationId: identity.organizationId,
        initialResult: capabilityResult(),
      },
      createElement(Customer360Screen),
    ),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function render(queryClient: QueryClientType) {
  await act(async () => {
    if (mounted) mounted.update(tree(queryClient));
    else mounted = create(tree(queryClient));
  });
  await settle();
}

function text(): string {
  return mounted ? JSON.stringify(mounted.toJSON()) : "";
}

/** Change this principal's grants and let the REAL capability query observe it. */
async function setGrants(queryClient: QueryClientType, grants: string[]) {
  server.grants.set(principal(identity.userId, identity.organizationId), grants);
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: capabilityQueryKey(identity.userId, identity.organizationId),
    });
  });
  await settle();
}

/** Answer every held insights request, as the server would have at request time. */
async function releaseHeld() {
  const pending = server.pending.splice(0);
  await act(async () => {
    for (const p of pending) p.resolve(p.build());
  });
  await settle();
}

const without = (...keys: string[]) => FULL.filter((k) => !keys.includes(k));

/** Every protected value the fully-granted screen shows, by what gates it. */
const SHOWN = {
  base: ["Customer insights", "ORGA-TOP-PRODUCT", "ORGA-LAST-PRODUCT", '"41"'],
  money: ["$987.65", "$24.39", "$12.35", "Still to collect"],
  payments: ["Payment methods", "KHQR 5"],
  delivery: ["Deliveries", "Delivered 7"],
  returns: ["Returns", "3 · 2 completed"],
};

function expectShown(...groups: (keyof typeof SHOWN)[]) {
  const t = text();
  for (const g of groups)
    for (const v of SHOWN[g]) expect({ g, v, shown: t.includes(v) }).toEqual({ g, v, shown: true });
}
function expectGone(...groups: (keyof typeof SHOWN)[]) {
  const t = text();
  for (const g of groups)
    for (const v of SHOWN[g])
      expect({ g, v, shown: t.includes(v) }).toEqual({ g, v, shown: false });
}

async function cachedFullyGranted() {
  const queryClient = client();
  await render(queryClient);
  expectShown("base", "money", "payments", "delivery", "returns");
  return queryClient;
}

function insightEntries(queryClient: QueryClientType) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: customerKeys.principal(identity.userId, identity.organizationId) })
    .filter((q) => q.queryKey[5] === "insights" && q.state.data !== undefined);
}

describe("revocation AFTER insights are cached — protected values disappear at once", () => {
  it("control: fully granted, every section renders from one request", async () => {
    await cachedFullyGranted();
    expect(server.insightCalls).toBe(1);
  });

  for (const revoked of ["customers.read", "orders.read"]) {
    it(`revoking ${revoked} hides ALL insights, hero figures included, and evicts the cache`, async () => {
      const queryClient = await cachedFullyGranted();
      server.hold = true;
      await setGrants(queryClient, without(revoked));
      expectGone("base", "money", "payments", "delivery", "returns");
      // No request may even be issued without the base grants.
      expect(server.pending).toHaveLength(0);
      expect(insightEntries(queryClient)).toHaveLength(0);
    });
  }

  for (const revoked of ["customers.view_sensitive", "payments.reconcile"]) {
    it(`revoking ${revoked} hides every amount immediately; non-money facts stay`, async () => {
      const queryClient = await cachedFullyGranted();
      server.hold = true;
      await setGrants(queryClient, without(revoked));
      // Asserted while the replacement request is still held: the amounts
      // are gone because the screen stopped showing them, not because a
      // newer response replaced them. (The entry fetched under the old grants
      // is evicted whole, so the rest waits for the server's fresh answer.)
      expect(server.pending.length).toBeGreaterThan(0);
      expectGone("money");
      expect(insightEntries(queryClient)).toHaveLength(0);

      await releaseHeld();
      expectShown("base", "payments", "delivery", "returns");
      expectGone("money");
    });
  }

  const sectionCases: Array<[string, keyof typeof SHOWN]> = [
    ["payments.read", "payments"],
    ["delivery.read", "delivery"],
    ["orders.return", "returns"],
  ];
  for (const [revoked, group] of sectionCases) {
    it(`revoking ${revoked} hides the ${group} section immediately`, async () => {
      const queryClient = await cachedFullyGranted();
      server.hold = true;
      await setGrants(queryClient, without(revoked));
      expect(server.pending.length).toBeGreaterThan(0);
      expectGone(group);
      expect(insightEntries(queryClient)).toHaveLength(0);

      await releaseHeld();
      expectShown("base", "money");
      expectGone(group);
    });
  }
});

describe("late in-flight responses created under the old grants", () => {
  it("a response requested with delivery.read that lands after its revocation never renders", async () => {
    const queryClient = client();
    server.hold = true;
    await render(queryClient);
    expect(server.pending).toHaveLength(1); // requested under FULL grants
    const old = server.pending.shift()!;

    await setGrants(queryClient, without("delivery.read"));
    expect(server.pending).toHaveLength(1); // the replacement, under new grants

    // The old answer (it carries delivery figures) arrives late.
    await act(async () => old.resolve(old.build()));
    await settle();
    expectGone("delivery");

    // The authoritative answer for the new grants arrives.
    const fresh = server.pending.shift()!;
    await act(async () => fresh.resolve(fresh.build()));
    await settle();
    expectShown("base", "money");
    expectGone("delivery");
    // Nothing readable is cached with delivery data.
    for (const q of insightEntries(queryClient)) {
      expect((q.state.data as any).data.delivery.status).toBe("permission_denied");
    }
  });

  it("a response requested with money grants that lands after payments.reconcile is revoked shows no amount", async () => {
    const queryClient = client();
    server.hold = true;
    await render(queryClient);
    const old = server.pending.shift()!;
    await setGrants(queryClient, without("payments.reconcile"));
    await act(async () => old.resolve(old.build()));
    await settle();
    expectGone("money");
  });

  it("a response that lands after orders.read is revoked renders nothing at all", async () => {
    const queryClient = client();
    server.hold = true;
    await render(queryClient);
    const old = server.pending.shift()!;
    await setGrants(queryClient, without("orders.read"));
    await act(async () => old.resolve(old.build()));
    await settle();
    expectGone("base", "money", "payments", "delivery", "returns");
  });
});

describe("identity switches never expose the previous identity's cache", () => {
  it("switching organization (and user) on the same QueryClient shows none of Org A's insights", async () => {
    const queryClient = await cachedFullyGranted();
    server.hold = true;
    identity.userId = USER_B;
    identity.organizationId = ORG_B;
    await render(queryClient);
    // Org B's request is still held: whatever is on screen is not Org A's.
    expect(text()).not.toContain("ORGA-");
    expect(text()).not.toContain('"41"');
    expectGone("money", "payments", "delivery", "returns");

    const b = server.pending.shift()!;
    await act(async () => b.resolve(b.build()));
    await settle();
    expect(text()).toContain("ORGB-TOP-PRODUCT");
    expect(text()).not.toContain("ORGA-");
  });
});

describe("restoring a grant refetches authoritative data", () => {
  it("delivery.read revoked then restored: a NEW request, and the new figure — never the stale one", async () => {
    const queryClient = await cachedFullyGranted();
    await setGrants(queryClient, without("delivery.read"));
    expectGone("delivery");
    const callsBefore = server.insightCalls;

    server.delivered = 8; // the authoritative figure has moved meanwhile
    server.hold = true;
    await setGrants(queryClient, [...FULL]);
    expect(server.insightCalls).toBe(callsBefore + 1);
    // Until the restored request answers, the old delivery figure is not reused.
    expect(text()).not.toContain("Delivered 7");

    const fresh = server.pending.shift()!;
    await act(async () => fresh.resolve(fresh.build()));
    await settle();
    expect(text()).toContain("Delivered 8");
    expect(text()).not.toContain("Delivered 7");
  });

  it("money restored after payments.reconcile was revoked comes from a fresh request", async () => {
    const queryClient = await cachedFullyGranted();
    await setGrants(queryClient, without("payments.reconcile"));
    expectGone("money");
    const callsBefore = server.insightCalls;
    await setGrants(queryClient, [...FULL]);
    expect(server.insightCalls).toBe(callsBefore + 1);
    expectShown("money");
  });
});
