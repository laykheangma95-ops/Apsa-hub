/**
 * Home — financial privacy and the New Order gate, MOUNTED.
 *
 * Mounts the real production Home screen (src/routes/app.index.tsx) inside the
 * real CapabilityProvider and the /app layout's real Home cache partition, in
 * happy-dom, and changes what the SERVER says underneath it:
 *
 *   capabilities  getActiveMemberCapabilitiesFn → answered from `server`
 *   Home          getHomeSummary (src/lib/api) → getHomeSummaryFn → the REAL
 *                 server getHomeSummary (src/server/home/service.ts) under an
 *                 authorization context derived from `server`, with fixed
 *                 repository figures — so the finance section is gated by the
 *                 real canReadFinancials, not by this file.
 *
 * Replaced, and only these: the server-function transport, the Organization
 * profile read, the bottom nav, the camera sheet, and the Create Order sheet
 * (a marker that says whether it is mounted and open — this suite is about
 * the gate in front of it, not the workflow inside it).
 *
 * Every assertion about money is also checked against EVERY frame the screen
 * drew (a MutationObserver), not just the final one, and against the query
 * cache, so a figure that flashes or survives in memory fails the suite.
 *
 * Runs in its own process (home-access-mounted.test.ts): it installs DOM
 * globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { CapabilityResult, UiPermissionKey } from "../lib/capabilities";
import type { AuthorizationContext } from "../server/auth/authorization";
import type { HomeSummary, MetricRange, Money } from "../types";

// ── The server's current answer ─────────────────────────────────────────────

const USER_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const USER_B = "aaaaaaaa-0000-4000-8000-0000000000b2";
const ORG_1 = "cccccccc-0000-4000-8000-0000000000c1";
const ORG_2 = "cccccccc-0000-4000-8000-0000000000c2";

const OWNER: UiPermissionKey[] = [
  "orders.read",
  "orders.create",
  "payments.read",
  "payments.reconcile",
  "products.read",
  "inventory.read",
  "delivery.read",
  "messages.read",
];

interface ServerState {
  /** null — the session cookie no longer resolves (expired or signed out). */
  session: { userId: string; organizationId: string } | null;
  /** Permissions per `${userId}/${organizationId}`. */
  grants: Map<string, UiPermissionKey[]>;
  /** Thrown by the next capability reads (a failed refresh). */
  capabilityFailure: Error | null;
  /** Thrown by the next Home reads (a failed refresh). */
  homeFailure: Error | null;
  /** Figures per organization, in their own currencies. */
  collected: Map<string, Money[]>;
}

const server: ServerState = {
  session: null,
  grants: new Map(),
  capabilityFailure: null,
  homeFailure: null,
  collected: new Map(),
};

function grant(userId: string, organizationId: string, permissions: UiPermissionKey[]) {
  server.grants.set(`${userId}/${organizationId}`, permissions);
}

function currentPermissions(): UiPermissionKey[] {
  if (!server.session) return [];
  return server.grants.get(`${server.session.userId}/${server.session.organizationId}`) ?? [];
}

/** Home reads held open until released — a slow network. */
let holdHome = false;
const heldHome: (() => void)[] = [];
let homeReads = 0;
let capabilityReads = 0;

// ── Server functions ────────────────────────────────────────────────────────

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validator: (data: unknown) => unknown) {
      return {
        handler(handler: (args: { data: unknown }) => unknown) {
          return async ({ data }: { data?: unknown } = {}) => handler({ data: validator(data) });
        },
      };
    },
    handler(handler: () => unknown) {
      return handler;
    },
  }),
}));

mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: {} }));

mock.module("@/api/capabilities", () => ({
  getActiveMemberCapabilitiesFn: async (): Promise<CapabilityResult> => {
    capabilityReads++;
    await Promise.resolve();
    if (server.capabilityFailure) throw server.capabilityFailure;
    if (!server.session) return { status: "unauthenticated" };
    const permissions = currentPermissions();
    if (permissions.length === 0) return { status: "no_membership" };
    return {
      status: "active",
      userId: server.session.userId,
      organizationId: server.session.organizationId,
      role: null,
      permissions,
    };
  },
}));

const { getHomeSummary: serverGetHomeSummary } = await import("@/server/home/service");
const { UnauthorizedError, ForbiddenError } = await import("@/server/auth/authorization");

mock.module("@/api/home", () => ({
  getHomeSummaryFn: async ({ data }: { data: { range: MetricRange } }) => {
    homeReads++;
    // Authorized at REQUEST time, exactly like the real boundary: a response
    // already on the wire carries what was true when it was asked.
    const session = server.session;
    if (server.homeFailure) {
      const failure = server.homeFailure;
      await Promise.resolve();
      throw failure;
    }
    if (!session) throw new UnauthorizedError("Not authenticated");
    const permissions = currentPermissions();
    if (permissions.length === 0) throw new ForbiddenError("No active organization membership");
    const ctx = {
      userId: session.userId,
      organizationId: session.organizationId,
      can: (key: string) => permissions.includes(key as UiPermissionKey),
      require: () => undefined,
    } as unknown as AuthorizationContext;
    const collected = server.collected.get(session.organizationId) ?? [];
    const summary = await serverGetHomeSummary(ctx, data.range, {
      getOrderSummary: async () => ({
        periodCount: 7,
        awaitingPaymentCount: 2,
        actionNeededCount: 1,
      }),
      getNetCollected: async () => collected,
      getOutOfStockCount: async () => 0,
      getPaymentAttention: async () => 0,
      getDeliveryAttention: async () => ({ count: 0, complete: true }),
    } as any);
    if (holdHome) await new Promise<void>((resolve) => heldHome.push(resolve));
    return summary;
  },
}));

mock.module("@/api/org", () => ({
  getOrganizationProfileFn: async () => {
    throw new Error("not under test");
  },
}));

// ── DOM and router ──────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The /app guard's route context: the principal this tab is serving. */
const route = { userId: USER_A, organizationId: ORG_1 };

const realRouter = await import("@tanstack/react-router");
const { createElement } = await import("react");

mock.module("@tanstack/react-router", () => ({
  ...realRouter,
  createFileRoute: () => (options: any) => ({
    ...options,
    options,
    useRouteContext: () => ({
      session: { userId: route.userId },
      organizationId: route.organizationId,
    }),
  }),
  Link: ({ children, to: _to, params: _params, search: _search, ...rest }: any) =>
    createElement("a", rest, children),
  useNavigate: () => () => Promise.resolve(),
  useRouterState: ({ select }: any = {}) => {
    const state = { location: { pathname: "/app" } };
    return select ? select(state) : state;
  },
  useMatch: () => undefined,
}));

const realNav = { ...(await import("@/design-system/BottomNav")) };
mock.module("@/design-system/BottomNav", () => ({ ...realNav, BottomNav: () => null }));
mock.module("@/components/barcode/CameraScanSheet", () => ({ CameraScanSheet: () => null }));
mock.module("@/components/orders/CreateRealOrderSheet", () => ({
  CreateRealOrderSheet: ({ open }: { open: boolean }) =>
    createElement("div", { "data-create-order-sheet": open ? "open" : "closed" }),
}));

const reducedMotionQuery = (query: string) => ({
  matches: query.includes("reduce"),
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = reducedMotionQuery;
(globalThis as any).matchMedia = reducedMotionQuery;
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, useQueryClient } = await import("@tanstack/react-query");
const { CapabilityProvider } = await import("@/hooks/use-capabilities");
const { capabilityQueryKey } = await import("@/lib/capabilities");
const { enforceHomeCachePrincipal, HOME_QUERY_PREFIX } = await import("@/lib/home-query");
const { formatMoney } = await import("@/lib/money");
const i18n = (await import("@/lib/i18n")).default;
const { Route } = await import("@/routes/app.index");
const BusinessHome = (Route as any).component as () => React.ReactElement;

/** The /app layout's part: partition Home's cache during render, then the provider. */
function AppLayout() {
  const queryClient = useQueryClient();
  enforceHomeCachePrincipal(queryClient, route.userId, route.organizationId);
  return createElement(
    CapabilityProvider,
    { userId: route.userId, organizationId: route.organizationId },
    createElement(BusinessHome),
  );
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;

/** Every text the screen has drawn since the last reset, frame by frame. */
let frames: string[] = [];
let observer: MutationObserver | null = null;

const text = () => document.body.textContent ?? "";

function tree() {
  return createElement(QueryClientProvider, { client }, createElement(AppLayout));
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string) {
  const started = Date.now();
  for (let round = 0; ; round++) {
    if (check()) return;
    if (round >= 80 && Date.now() - started > 5000) {
      throw new Error(`Timed out waiting: ${label}. Screen: ${text().slice(0, 500)}`);
    }
    await settle(1);
  }
}

async function readsSettled() {
  let quiet = 0;
  await waitFor(() => {
    quiet = client.isFetching() === 0 ? quiet + 1 : 0;
    return quiet >= 4;
  }, "reads settled");
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  frames = [];
  observer = new MutationObserver(() => frames.push(text()));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  root = createRoot(container);
  await act(async () => root!.render(tree()));
  await readsSettled();
}

async function rerender() {
  await act(async () => root!.render(tree()));
  await readsSettled();
}

/** What the revalidation poll (or a focus) does: re-ask the server. */
async function recheckCapabilities() {
  await act(async () => {
    await client
      .refetchQueries({ queryKey: capabilityQueryKey(route.userId, route.organizationId) })
      .catch(() => undefined);
  });
  await readsSettled();
}

async function refreshHome() {
  await act(async () => {
    await client.refetchQueries({ queryKey: HOME_QUERY_PREFIX }).catch(() => undefined);
  });
  await readsSettled();
}

async function unmount() {
  observer?.disconnect();
  observer = null;
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  client?.clear();
  server.session = null;
  server.grants.clear();
  server.capabilityFailure = null;
  server.homeFailure = null;
  server.collected.clear();
  holdHome = false;
  while (heldHome.length) heldHome.shift()!();
  homeReads = 0;
  capabilityReads = 0;
  route.userId = USER_A;
  route.organizationId = ORG_1;
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// ── Fixtures and probes ─────────────────────────────────────────────────────

const USD_A: Money = { amount: 12345, currency: "USD" };
const KHR_A: Money = { amount: 50000, currency: "KHR" };
const USD_2: Money = { amount: 98760, currency: "USD" };
const A_FIGURES = [formatMoney(USD_A), formatMoney(KHR_A)];
const ORG_2_FIGURE = formatMoney(USD_2);

const NO_PERMISSION = "You do not have permission to view financial totals.";
const UNAVAILABLE = "Financial totals are unavailable right now.";

function signIn(userId: string, organizationId: string) {
  server.session = { userId, organizationId };
  route.userId = userId;
  route.organizationId = organizationId;
}

function ownerOnOrg1() {
  signIn(USER_A, ORG_1);
  grant(USER_A, ORG_1, OWNER);
  server.collected.set(ORG_1, [USD_A, KHR_A]);
}

/** Any finance figure still readable from the query cache. */
function cachedFinance(): Money[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: HOME_QUERY_PREFIX })
    .flatMap((query) => {
      const data = query.state.data as HomeSummary | undefined;
      return data?.finance.status === "available"
        ? data.finance.data.netCollectedForCreatedOrders
        : [];
    });
}

const shows = (figure: string) => text().includes(figure);
const drewSince = (start: number, figure: string) =>
  frames.slice(start).some((frame) => frame.includes(figure));

// ── 1. Financial privacy ────────────────────────────────────────────────────

describe("Home money: authorized owner (negative control)", () => {
  it("shows each currency on its own line, formatted in its own minor units", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    expect(A_FIGURES).toEqual(["$123.45", "៛50,000"]);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
    // Never added or converted into a third figure.
    expect(shows("$623.45")).toBe(false);
    expect(shows(NO_PERMISSION)).toBe(false);
    expect(shows(UNAVAILABLE)).toBe(false);
  });
});

describe("Home money: permission revoked after a successful load", () => {
  it("hides the figures the moment the server stops confirming payments.reconcile", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");

    grant(
      USER_A,
      ORG_1,
      OWNER.filter((key) => key !== "payments.reconcile"),
    );
    const mark = frames.length;
    await recheckCapabilities();

    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    // Counts that remain authorized still show.
    expect(shows("7 orders")).toBe(true);
    // And nothing restores it: the next Home read is refused finance server-side.
    await refreshHome();
    for (const figure of A_FIGURES) expect(drewSince(frames.length - 1, figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    expect(mark).toBeGreaterThan(0);
  });

  it("hides them when membership is removed outright", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    grant(USER_A, ORG_1, []);
    await recheckCapabilities();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });
});

describe("Home money: session expiry after a successful load", () => {
  it("capability re-check reports unauthenticated → figures gone, cache emptied", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    server.session = null;
    await recheckCapabilities();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });

  it("Home's own refresh is refused with 401 first → nothing retained is drawn", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    // The capability snapshot has not been re-asked yet; only Home's read has.
    server.session = null;
    await refreshHome();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(shows("7 orders")).toBe(false);
    await waitFor(() => cachedFinance().length === 0, "cache evicted");
    await settle(8);
    // No remove → refetch → refuse loop.
    const reads = homeReads;
    await settle(20);
    expect(homeReads).toBe(reads);
  });

  it("a transport-level 401 is treated the same way", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    server.homeFailure = Object.assign(new Error("Request failed"), { status: 401 });
    await refreshHome();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    await waitFor(() => cachedFinance().length === 0, "cache evicted");
  });
});

describe("Home money: a delayed response cannot restore it", () => {
  it("a read that left before the revocation lands after it and is discarded", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");

    // A refresh leaves while the grant still holds…
    holdHome = true;
    await act(async () => {
      void client.refetchQueries({ queryKey: HOME_QUERY_PREFIX });
    });
    await waitFor(() => heldHome.length === 1, "held read");
    // …the revocation is learned while it is in flight…
    grant(
      USER_A,
      ORG_1,
      OWNER.filter((key) => key !== "payments.reconcile"),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: capabilityQueryKey(route.userId, route.organizationId),
      });
    });
    const mark = frames.length;
    // …and then the grant-era response arrives.
    holdHome = false;
    await act(async () => {
      while (heldHome.length) heldHome.shift()!();
    });
    await readsSettled();

    for (const figure of A_FIGURES) {
      expect(shows(figure)).toBe(false);
      expect(drewSince(mark, figure)).toBe(false);
    }
    expect(cachedFinance()).toEqual([]);
  });
});

describe("Home money: failed refresh and recovery", () => {
  it("an outage keeps the counts but never the money, and Retry restores it", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");

    server.homeFailure = new Error("getHome finance orders: connection reset");
    await refreshHome();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(shows(UNAVAILABLE)).toBe(true);
    expect(shows("7 orders")).toBe(true);

    server.homeFailure = null;
    await refreshHome();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
  });

  it("a failed capability refresh hides the money until the server confirms again", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");

    server.capabilityFailure = new Error("network");
    const reads0 = homeReads;
    await recheckCapabilities();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(shows(UNAVAILABLE)).toBe(true);
    // The grant-era entry was dropped and re-read: whatever the cache holds now
    // came from a request the server authorized after the failure — and it is
    // still not drawn, because the snapshot is unconfirmed.
    expect(homeReads).toBeGreaterThan(reads0);

    // Authorized recovery: the next confirmed snapshot brings it back, freshly read.
    server.capabilityFailure = null;
    const reads = homeReads;
    await recheckCapabilities();
    await refreshHome();
    await waitFor(() => shows(A_FIGURES[0]!), "recovered figures");
    expect(homeReads).toBeGreaterThan(reads);
  });

  it("a member re-granted the finance keys sees the figures again", async () => {
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    grant(
      USER_A,
      ORG_1,
      OWNER.filter((key) => key !== "payments.reconcile"),
    );
    await recheckCapabilities();
    await refreshHome();
    expect(shows(A_FIGURES[0]!)).toBe(false);
    grant(USER_A, ORG_1, OWNER);
    await recheckCapabilities();
    await refreshHome();
    await waitFor(() => shows(A_FIGURES[0]!), "re-granted figures");
  });
});

describe("Home money: identity switching", () => {
  it("organization A → B → A never draws one organization's money under another", async () => {
    ownerOnOrg1();
    grant(USER_A, ORG_2, ["orders.read", "orders.create", "products.read"]);
    server.collected.set(ORG_2, [USD_2]);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures");

    const toB = frames.length;
    signIn(USER_A, ORG_2);
    await rerender();
    for (const figure of A_FIGURES) expect(drewSince(toB, figure)).toBe(false);
    // Org 2's member has no finance keys: nothing of org 2's either.
    expect(drewSince(toB, ORG_2_FIGURE)).toBe(false);

    const backToA = frames.length;
    signIn(USER_A, ORG_1);
    await rerender();
    expect(drewSince(backToA, ORG_2_FIGURE)).toBe(false);
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures again");
  });

  it("member A → member B on one tab never shows A's money to B", async () => {
    ownerOnOrg1();
    grant(USER_B, ORG_1, ["orders.read", "orders.create"]);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "member A figures");

    const toB = frames.length;
    signIn(USER_B, ORG_1);
    await rerender();
    for (const figure of A_FIGURES) expect(drewSince(toB, figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });
});

// ── 2. New Order gate ───────────────────────────────────────────────────────

function newOrderTile(): { button: HTMLButtonElement | null; unavailable: boolean } {
  const title = [...document.querySelectorAll("*")].find(
    (el) => el.children.length === 0 && el.textContent === "New order",
  );
  if (!title) throw new Error(`No New order tile. Screen: ${text().slice(0, 400)}`);
  const button = title.closest("button") as HTMLButtonElement | null;
  const tile = title.closest("[data-unavailable]");
  return {
    button,
    unavailable: !!tile && (tile.textContent ?? "").includes("Not available for your role"),
  };
}

const sheet = () =>
  document.querySelector("[data-create-order-sheet]")?.getAttribute("data-create-order-sheet") ??
  null;

async function asMember(permissions: UiPermissionKey[]) {
  signIn(USER_A, ORG_1);
  grant(USER_A, ORG_1, permissions);
  await mount();
  await waitFor(() => capabilityReads > 0 && client.isFetching() === 0, "snapshot");
}

describe("New Order: both orders.create and products.read are required", () => {
  it("both granted → a button that opens the create-order sheet", async () => {
    await asMember(["orders.read", "orders.create", "products.read"]);
    const tile = newOrderTile();
    expect(tile.button).not.toBeNull();
    expect(tile.unavailable).toBe(false);
    expect(sheet()).toBe("closed");
    await act(async () => tile.button!.click());
    expect(sheet()).toBe("open");
  });

  for (const [label, permissions] of [
    ["only orders.create", ["orders.read", "orders.create"]],
    ["only products.read", ["orders.read", "products.read"]],
    ["neither", ["orders.read"]],
  ] as const) {
    it(`${label} → an unavailable tile with no handler, and no sheet mounted`, async () => {
      await asMember([...permissions]);
      const tile = newOrderTile();
      expect(tile.button).toBeNull();
      expect(tile.unavailable).toBe(true);
      expect(sheet()).toBeNull();
      // Activating the tile anyway does nothing.
      const div = document.querySelector("[data-unavailable]") as HTMLElement;
      await act(async () => div.click());
      expect(sheet()).toBeNull();
    });
  }

  it("products.read revoked while the sheet is open closes it, and re-granting does not reopen it", async () => {
    await asMember(["orders.read", "orders.create", "products.read"]);
    await act(async () => newOrderTile().button!.click());
    expect(sheet()).toBe("open");

    grant(USER_A, ORG_1, ["orders.read", "orders.create"]);
    await recheckCapabilities();
    expect(sheet()).toBeNull();
    expect(newOrderTile().button).toBeNull();

    grant(USER_A, ORG_1, ["orders.read", "orders.create", "products.read"]);
    await recheckCapabilities();
    expect(newOrderTile().button).not.toBeNull();
    expect(sheet()).toBe("closed");
  });

  it("follows member and organization switches", async () => {
    await asMember(["orders.read", "orders.create", "products.read"]);
    grant(USER_B, ORG_1, ["orders.read", "orders.create"]);
    grant(USER_A, ORG_2, ["orders.read", "products.read"]);
    expect(newOrderTile().button).not.toBeNull();

    signIn(USER_B, ORG_1);
    await rerender();
    await waitFor(() => newOrderTile().unavailable, "member B tile");
    expect(sheet()).toBeNull();

    signIn(USER_A, ORG_2);
    await rerender();
    await waitFor(() => newOrderTile().unavailable, "org 2 tile");

    signIn(USER_A, ORG_1);
    await rerender();
    await waitFor(() => newOrderTile().button !== null, "member A tile again");
  });
});
