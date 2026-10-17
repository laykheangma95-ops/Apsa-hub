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
import { afterEach, beforeAll, describe, expect, it, jest, mock } from "bun:test";
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
/** Date.now() at which each capability request was dispatched, in order. */
const capabilityDispatches: number[] = [];
/**
 * Capability reads held open until released — a refresh that never answers.
 * The answer is decided when the request is MADE (like the real boundary), so
 * a held response carries whatever the server said at that moment.
 */
let holdCapabilities = false;
const heldCapabilities: (() => void)[] = [];

function capabilityAnswer(): CapabilityResult | Error {
  if (server.capabilityFailure) return server.capabilityFailure;
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
}

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
    capabilityDispatches.push(Date.now());
    const answer = capabilityAnswer();
    await Promise.resolve();
    if (holdCapabilities) await new Promise<void>((resolve) => heldCapabilities.push(resolve));
    if (answer instanceof Error) throw answer;
    return answer;
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
const { capabilityConfirmation } = await import("@/lib/capability-confirmation");
const { enforceHomeCachePrincipal, HOME_QUERY_PREFIX } = await import("@/lib/home-query");
const { formatMoney } = await import("@/lib/money");
const i18n = (await import("@/lib/i18n")).default;
const { Route } = await import("@/routes/app.index");
const BusinessHome = (Route as any).component as () => React.ReactElement;

/** The /app loader's SSR seed, when a test supplies one (as app.tsx does). */
let seed: CapabilityResult | undefined;

/** The /app layout's part: partition Home's cache during render, then the provider. */
function AppLayout() {
  const queryClient = useQueryClient();
  enforceHomeCachePrincipal(queryClient, route.userId, route.organizationId);
  return createElement(
    CapabilityProvider,
    { userId: route.userId, organizationId: route.organizationId, initialResult: seed },
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

/**
 * True while a test runs on fake timers (the freshness-deadline suites). Every
 * wait below then moves the clock itself, 1ms per round, so nothing depends
 * on wall time and a deadline is crossed only when a test says so.
 */
let fakeClock = false;

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      if (fakeClock) {
        jest.advanceTimersByTime(1);
        for (let m = 0; m < 4; m++) await Promise.resolve();
      } else {
        await new Promise((r) => setTimeout(r, 0));
      }
    });
  }
}

async function waitFor(check: () => boolean, label: string) {
  const started = Date.now();
  for (let round = 0; ; round++) {
    if (check()) return;
    if (fakeClock ? round >= 3000 : round >= 80 && Date.now() - started > 5000) {
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

/** mount() for a test whose first capability answer is held: no wait for reads. */
async function mountUnsettled() {
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
  await settle(10);
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
  holdCapabilities = false;
  while (heldCapabilities.length) heldCapabilities.shift()!();
  if (fakeClock) {
    jest.useRealTimers();
    fakeClock = false;
  }
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
  capabilityDispatches.length = 0;
  seed = undefined;
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

// ── Financial privacy: the freshness deadline ───────────────────────────────
//
// A capability refresh that never answers must not keep money on screen. The
// last server confirmation is good for SENSITIVE_CAPABILITY_MAX_AGE_MS (30s,
// two revalidation intervals) and no longer — enforced by a timer, so it holds
// even when no promise settles and nothing else re-renders. These suites run
// on fake timers: the clock moves only when a test moves it.

/** Mirrors SENSITIVE_CAPABILITY_MAX_AGE_MS / SENSITIVE_CAPABILITY_REVALIDATE_MS. */
const MAX_AGE_MS = 30_000;
const POLL_MS = 15_000;

function useFakeClock() {
  jest.useFakeTimers();
  fakeClock = true;
}

/** Move the clock forward in one jump (every timer due inside it fires), then settle. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(Math.max(0, ms));
    for (let m = 0; m < 4; m++) await Promise.resolve();
  });
  await settle(30);
}

/** Move the clock forward 1s at a time, letting every answer land as it arrives. */
async function advanceInSteps(ms: number, step = 1_000) {
  for (let moved = 0; moved < ms; moved += step) await advance(Math.min(step, ms - moved));
}

/** When the server last positively answered this tab's principal. */
const confirmedAt = () =>
  client.getQueryState(capabilityQueryKey(route.userId, route.organizationId))?.dataUpdatedAt ?? 0;

/** Let held capability responses land: the oldest first, unless `newestFirst`. */
async function releaseCapabilities(newestFirst = false) {
  holdCapabilities = false;
  await act(async () => {
    while (heldCapabilities.length) {
      (newestFirst ? heldCapabilities.pop() : heldCapabilities.shift())!();
      for (let m = 0; m < 4; m++) await Promise.resolve();
    }
  });
  await settle(30);
}

const withoutReconcile = () => OWNER.filter((key) => key !== "payments.reconcile");

describe("Home money: a capability refresh that never answers", () => {
  it("hides the figures at the deadline, evicts them, and a late grant-era answer cannot restore them", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const confirmed = confirmedAt();
    expect(confirmed).toBeGreaterThan(0);

    // The next revalidation leaves while the grant still holds, and hangs…
    holdCapabilities = true;
    const reads = capabilityReads;
    await advance(confirmed + POLL_MS - Date.now());
    expect(capabilityReads).toBe(reads + 1);
    expect(heldCapabilities.length).toBe(1);
    // …and the server revokes payments.reconcile while it hangs.
    grant(USER_A, ORG_1, withoutReconcile());

    // Up to the deadline the last confirmation stands: the bounded window.
    await advance(confirmed + MAX_AGE_MS - 1_000 - Date.now());
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);

    // Past it the figures are gone — no promise settled, no input, no navigation.
    const mark = frames.length;
    await advance(confirmed + MAX_AGE_MS + 1 - Date.now());
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(shows(UNAVAILABLE) || shows(NO_PERMISSION)).toBe(true);
    // Not reusable from memory either.
    expect(cachedFinance()).toEqual([]);

    // The grant-era response finally lands, then everything else held.
    const late = frames.length;
    await releaseCapabilities();
    for (const figure of A_FIGURES) {
      expect(shows(figure)).toBe(false);
      expect(drewSince(late, figure)).toBe(false);
    }
    expect(cachedFinance()).toEqual([]);

    // Revalidation carries on and the server keeps saying "revoked".
    await advance(POLL_MS);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    for (const figure of A_FIGURES) expect(drewSince(mark, figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });

  it("Codex's order: revoke first, then a revalidation that is held indefinitely", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const confirmed = confirmedAt();

    grant(USER_A, ORG_1, withoutReconcile());
    holdCapabilities = true;
    await advance(confirmed + POLL_MS - Date.now());
    expect(heldCapabilities.length).toBeGreaterThan(0);

    const mark = frames.length;
    // Well beyond the 15s interval, and beyond the 30s deadline.
    await advance(confirmed + MAX_AGE_MS + 5_000 - Date.now());
    for (const figure of A_FIGURES) {
      expect(shows(figure)).toBe(false);
      expect(drewSince(mark + 1, figure)).toBe(false);
    }
    expect(cachedFinance()).toEqual([]);
    // Still hung a minute later: still hidden, and not re-asked in a tight loop.
    const reads = capabilityReads;
    await advance(60_000);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(capabilityReads - reads).toBeLessThanOrEqual(3);
  });

  it("a hang with the grant intact still evicts, and recovers only through a fresh confirmation and a fresh read", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const confirmed = confirmedAt();

    holdCapabilities = true;
    await advance(confirmed + MAX_AGE_MS + 1 - Date.now());
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    // Home was re-read after the eviction (counts stay), and the server still
    // grants finance — yet nothing read while unconfirmed is kept as money.
    expect(shows("7 orders")).toBe(true);
    expect(cachedFinance()).toEqual([]);
    await advance(10_000);
    expect(cachedFinance()).toEqual([]);

    // Authorized recovery: the server answers again, Home is read again.
    const homeBefore = homeReads;
    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "recovered figures");
    expect(confirmedAt()).toBeGreaterThan(confirmed + MAX_AGE_MS);
    expect(homeReads).toBeGreaterThan(homeBefore);
  });
});

describe("Home money: the deadline does not disturb normal operation", () => {
  it("successful revalidation keeps the figures up, with one request per interval and no Home re-reads", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const mark = frames.length;
    const caps = capabilityReads;
    const homes = homeReads;
    for (let i = 0; i < 8; i++) {
      await advance(POLL_MS);
      for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
    }
    // Two minutes: eight polls, never a flicker, never a loop.
    expect(capabilityReads - caps).toBeGreaterThanOrEqual(7);
    expect(capabilityReads - caps).toBeLessThanOrEqual(9);
    expect(homeReads).toBe(homes);
    expect(frames.slice(mark).every((frame) => frame.includes(A_FIGURES[0]!))).toBe(true);
  });

  it("revocation picked up by the poll hides the figures", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    grant(USER_A, ORG_1, withoutReconcile());
    await advance(POLL_MS);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });

  it("session expiry picked up by the poll hides the figures and stops polling", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    server.session = null;
    await advance(POLL_MS);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    const reads = capabilityReads;
    await advance(120_000);
    expect(capabilityReads - reads).toBeLessThanOrEqual(1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
  });

  it("failed capability refreshes keep the figures hidden at a bounded retry rate, then recover", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    server.capabilityFailure = new Error("network");
    await advance(POLL_MS);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    const reads = capabilityReads;
    await advance(120_000);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    // Polls every 15s plus at most one deadline re-ask every 30s.
    expect(capabilityReads - reads).toBeLessThanOrEqual(13);

    server.capabilityFailure = null;
    await advance(POLL_MS);
    await waitFor(() => shows(A_FIGURES[0]!), "recovered figures");
  });

  it("a failed Home refresh keeps the money hidden while capabilities stay fresh", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    server.homeFailure = new Error("getHome finance orders: connection reset");
    await refreshHome();
    // In steps, so each poll's answer is handled as it arrives — "capabilities
    // stay fresh". (One 60s jump would deliver all of them at the end, aged by
    // up to 45s since they left, and correctly count as lapsed.)
    await advanceInSteps(MAX_AGE_MS * 2);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(shows("7 orders")).toBe(true);
    server.homeFailure = null;
    await refreshHome();
    await waitFor(() => shows(A_FIGURES[0]!), "recovered figures");
  });
});

describe("Home money: freshness is per principal", () => {
  it("member A → member B: A's confirmation never stands in for B's", async () => {
    useFakeClock();
    ownerOnOrg1();
    grant(USER_B, ORG_1, OWNER);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "member A figures");

    // B's capability answer never arrives; B's Home read does (same org's figures).
    holdCapabilities = true;
    const toB = frames.length;
    signIn(USER_B, ORG_1);
    await act(async () => root!.render(tree()));
    await advance(MAX_AGE_MS + 1);
    for (const figure of A_FIGURES) expect(drewSince(toB, figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    // B confirmed by the server: B may see its own organization's money.
    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "member B figures");
  });

  it("organization A → B → A: A's expired confirmation is not reused on return", async () => {
    useFakeClock();
    ownerOnOrg1();
    grant(USER_A, ORG_2, OWNER);
    server.collected.set(ORG_2, [USD_2]);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures");

    signIn(USER_A, ORG_2);
    await act(async () => root!.render(tree()));
    await waitFor(() => shows(ORG_2_FIGURE), "org 2 figures");
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    // Long enough on B for A's last confirmation to lapse.
    await advance(MAX_AGE_MS * 2);

    // Back to A, whose re-confirmation hangs: A's old snapshot is not enough.
    holdCapabilities = true;
    const backToA = frames.length;
    signIn(USER_A, ORG_1);
    await act(async () => root!.render(tree()));
    await advance(5_000);
    expect(drewSince(backToA, ORG_2_FIGURE)).toBe(false);
    for (const figure of A_FIGURES) expect(drewSince(backToA, figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures again");
    expect(drewSince(backToA, ORG_2_FIGURE)).toBe(false);
  });
});

describe("Home money: concurrency and lifecycle", () => {
  it("several requests in flight across the deadline, released newest-first, restore nothing", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const confirmed = confirmedAt();

    // Grant-era requests leave and hang: two Home reads, the poll, a focus re-ask.
    holdCapabilities = true;
    holdHome = true;
    await act(async () => {
      void client.refetchQueries({ queryKey: HOME_QUERY_PREFIX });
    });
    await settle(10);
    await act(async () => {
      void client.refetchQueries({ queryKey: HOME_QUERY_PREFIX }, { cancelRefetch: false });
    });
    await advance(confirmed + POLL_MS - Date.now());
    await act(async () => {
      void client.refetchQueries(
        { queryKey: capabilityQueryKey(route.userId, route.organizationId) },
        { cancelRefetch: false },
      );
    });
    await settle(10);
    expect(heldHome.length).toBeGreaterThanOrEqual(1);
    expect(heldCapabilities.length).toBeGreaterThanOrEqual(1);
    grant(USER_A, ORG_1, withoutReconcile());

    const mark = frames.length;
    await advance(confirmed + MAX_AGE_MS + 1 - Date.now());
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    // Everything lands, newest first, then the rest.
    holdHome = false;
    await act(async () => {
      while (heldHome.length) {
        heldHome.pop()!();
        for (let m = 0; m < 4; m++) await Promise.resolve();
      }
    });
    await releaseCapabilities(true);
    await advance(POLL_MS);
    for (const figure of A_FIGURES) {
      expect(shows(figure)).toBe(false);
      expect(drewSince(mark + 1, figure)).toBe(false);
    }
    expect(cachedFinance()).toEqual([]);
  });

  it("unmounting clears the deadline and the polling; late answers land harmlessly", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    holdCapabilities = true;
    await advance(POLL_MS);
    expect(heldCapabilities.length).toBe(1);

    await unmount();
    const caps = capabilityReads;
    const homes = homeReads;
    await advance(5 * 60_000);
    expect(capabilityReads).toBe(caps);
    expect(homeReads).toBe(homes);
    await releaseCapabilities();
    await advance(MAX_AGE_MS);
    expect(capabilityReads).toBe(caps);
    expect(text()).toBe("");
  });
});

// ── Financial privacy: confirmation age is measured from DISPATCH ──────────
//
// The server checks permission while handling a request — after the browser
// sent it. So a successful answer proves access only as of (at latest) the
// moment the request left, never as of the moment the answer arrived. A slow
// grant-era answer must not buy the figures a fresh 30s from its arrival.

/** Let the OLDEST held capability response land; later ones stay held. */
async function releaseOldestCapability() {
  const releasedAt = Date.now();
  await act(async () => {
    heldCapabilities.shift()!();
    for (let m = 0; m < 4; m++) await Promise.resolve();
  });
  // Landed — and was rendered — at the instant it was released.
  expect(Date.now()).toBe(releasedAt);
  await settle(30);
}

/**
 * Advance until Date.now() === `at` EXACTLY, firing every timer due on the
 * way and flushing React — but without advance()'s settling rounds, which
 * move the clock on by a few more ms. For assertions on a boundary.
 */
async function jumpTo(at: number) {
  await act(async () => {
    jest.advanceTimersByTime(Math.max(0, at - Date.now()));
    for (let m = 0; m < 4; m++) await Promise.resolve();
  });
  expect(Date.now()).toBe(at);
}

/**
 * A test that ends on jumpTo() must let the work its last jump queued (on
 * fake timers) run while the test still owns the clock; otherwise
 * useRealTimers() in afterEach drops it and the next test wedges.
 */
async function settleAfterJump() {
  await settle(5);
}

/** Advance until Date.now() === `at` (never backwards). */
async function advanceTo(at: number) {
  await advance(at - Date.now());
}

describe("Home money: a delayed successful capability answer (Codex P2)", () => {
  it("15s request, revoked, answer at 29s: visible at 30s, gone at 45s and 46s, nothing cached", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;

    // Every request from here on is held until a test releases it.
    holdCapabilities = true;
    await advanceTo(start + POLL_MS);
    expect(heldCapabilities.length).toBe(1);
    const dispatched = capabilityDispatches.at(-1)!;
    expect(dispatched - start).toBeGreaterThanOrEqual(POLL_MS);
    expect(dispatched - start).toBeLessThan(POLL_MS + 100);

    // The server granted at dispatch; the revocation comes right after.
    grant(USER_A, ORG_1, withoutReconcile());

    // The grant-era answer is slow: it arrives 14s after it left (≈29s).
    await advanceTo(dispatched + 14_000);
    await releaseOldestCapability();

    // ≈30s: inside the window that answer can vouch for (dispatch + 30s).
    await advanceTo(dispatched + 15_000);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);

    // ≈45s: dispatch + 30s — no longer vouched for.
    const mark = frames.length;
    await advanceTo(dispatched + MAX_AGE_MS);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    // ≈46s: still gone, from the screen and from memory.
    await advanceTo(dispatched + MAX_AGE_MS + 1_000);
    for (const figure of A_FIGURES) {
      expect(shows(figure)).toBe(false);
      expect(drewSince(mark + 1, figure)).toBe(false);
    }
    expect(cachedFinance()).toEqual([]);
  });
});

const capabilityKey = () => capabilityQueryKey(route.userId, route.organizationId);
const anyFigureSince = (start: number) => A_FIGURES.some((figure) => drewSince(start, figure));

describe("Home money: an answer near the freshness boundary (measured from dispatch)", () => {
  it("lands 29.9s after it left → shown, then gone at dispatch + 30,000ms, nothing cached", async () => {
    useFakeClock();
    ownerOnOrg1();
    holdCapabilities = true;
    await mountUnsettled();
    expect(heldCapabilities.length).toBe(1);
    const dispatched = capabilityDispatches[0]!;
    expect(anyFigureSince(0)).toBe(false);

    await advanceTo(dispatched + 29_900);
    await releaseOldestCapability();
    await waitFor(() => shows(A_FIGURES[0]!), "figures under a 29.9s-old confirmation");
    expect(Date.now() - dispatched).toBeLessThan(MAX_AGE_MS);

    await jumpTo(dispatched + MAX_AGE_MS - 1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
    await jumpTo(dispatched + MAX_AGE_MS);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await jumpTo(dispatched + MAX_AGE_MS + 1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await settleAfterJump();
  });

  for (const lateBy of [0, 1, 5_000]) {
    it(`lands ${MAX_AGE_MS + lateBy}ms after it left → never shown for a single frame, nothing cached`, async () => {
      useFakeClock();
      ownerOnOrg1();
      holdCapabilities = true;
      await mountUnsettled();
      const dispatched = capabilityDispatches[0]!;
      await advanceTo(dispatched + MAX_AGE_MS - 1_000);
      await jumpTo(dispatched + MAX_AGE_MS + lateBy);
      const mark = frames.length;
      await releaseOldestCapability();
      await advance(1_000);
      expect(anyFigureSince(0)).toBe(false);
      expect(anyFigureSince(mark)).toBe(false);
      expect(cachedFinance()).toEqual([]);
      // Re-asked (bounded), never a loop.
      expect(capabilityReads).toBeLessThanOrEqual(3);
    });
  }
});

describe("Home money: slow answers, cancellations and overlapping refreshes", () => {
  it("a slow grant-era answer does not mask the revocation the next answer reports", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    holdCapabilities = true;
    await advanceTo(start + POLL_MS);
    grant(USER_A, ORG_1, withoutReconcile());
    await advance(10_000);
    // The slow grant lands at ≈25s; the next poll (15s after an answer
    // settles) answers at once, and says "revoked".
    holdCapabilities = false;
    const slowDispatch = capabilityDispatches.at(-1)!;
    await releaseOldestCapability();
    await advance(POLL_MS);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    // …and it was reported inside the slow answer's own window.
    expect(Date.now() - slowDispatch).toBeLessThan(MAX_AGE_MS);
  });

  it("a cancelled request's late answer is discarded: it neither shows money nor counts as a confirmation", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    holdCapabilities = true;
    await advanceTo(start + POLL_MS);
    expect(heldCapabilities.length).toBe(1);
    // The grant-era request is cancelled (navigation, a reauthorization…).
    await act(async () => {
      await client.cancelQueries({ queryKey: capabilityKey() });
    });
    // The confirmation lapses; the re-ask is held too.
    await advanceTo(start + MAX_AGE_MS + 1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(heldCapabilities.length).toBe(2);

    // The cancelled answer (granted at 15s, so "fresh" until 45s by its own
    // dispatch) finally arrives at 35s: discarded.
    await advanceTo(start + 35_000);
    const mark = frames.length;
    await releaseOldestCapability();
    await advance(1_000);
    expect(anyFigureSince(mark)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    // The re-ask that is still current then answers: authorized recovery.
    const homes = homeReads;
    await releaseOldestCapability();
    await waitFor(() => shows(A_FIGURES[0]!), "recovered figures");
    expect(homeReads).toBeGreaterThan(homes);
  });

  it("two overlapping refreshes, newest answers first (revoked), oldest last (grant) → stays hidden", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    holdCapabilities = true;
    await advanceTo(start + POLL_MS);
    grant(USER_A, ORG_1, withoutReconcile());
    await advance(2_000);
    await act(async () => {
      void client.refetchQueries({ queryKey: capabilityKey() }, { cancelRefetch: true });
    });
    await settle(5);
    expect(heldCapabilities.length).toBe(2);

    // Newest first: "revoked".
    holdCapabilities = false;
    await act(async () => {
      heldCapabilities.pop()!();
      for (let m = 0; m < 4; m++) await Promise.resolve();
    });
    await settle(30);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    const mark = frames.length;
    // Then the superseded grant-era answer.
    await releaseOldestCapability();
    await advance(POLL_MS);
    expect(anyFigureSince(mark)).toBe(false);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
  });

  it("two overlapping refreshes, both granted, out of order → the window follows the newer request only", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    holdCapabilities = true;
    await advanceTo(start + POLL_MS);
    await advance(2_000);
    await act(async () => {
      void client.refetchQueries({ queryKey: capabilityKey() }, { cancelRefetch: true });
    });
    await settle(5);
    const newer = capabilityDispatches.at(-1)!;
    expect(heldCapabilities.length).toBe(2);
    // Newest first, then the superseded older one; everything after stays held.
    await act(async () => {
      heldCapabilities.pop()!();
      for (let m = 0; m < 4; m++) await Promise.resolve();
    });
    await settle(30);
    await releaseOldestCapability();
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
    // The superseded answer did not overwrite the newer request's provenance.
    expect(capabilityConfirmation(client.getQueryData(capabilityKey()))?.wall).toBe(newer);
    // Fresh until the newer request's dispatch + 30s — not one arrival-based ms more.
    await jumpTo(newer + MAX_AGE_MS - 1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);
    await jumpTo(newer + MAX_AGE_MS);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await settleAfterJump();
  });
});

describe("Home money: confirmation provenance is per principal and per tenure", () => {
  it("member A → member B: B's held confirmation never borrows A's recent stamp", async () => {
    useFakeClock();
    ownerOnOrg1();
    grant(USER_B, ORG_1, OWNER);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "member A figures");
    holdCapabilities = true;
    const toB = frames.length;
    signIn(USER_B, ORG_1);
    await act(async () => root!.render(tree()));
    // Well inside A's own window.
    await advance(5_000);
    expect(anyFigureSince(toB)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "member B figures, confirmed for B");
  });

  it("organization A → B → A within 30s: A's still-recent stamp is from an earlier tenure and not reused", async () => {
    useFakeClock();
    ownerOnOrg1();
    grant(USER_A, ORG_2, OWNER);
    server.collected.set(ORG_2, [USD_2]);
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures");

    signIn(USER_A, ORG_2);
    await act(async () => root!.render(tree()));
    await waitFor(() => shows(ORG_2_FIGURE), "org 2 figures");
    await advance(2_000);

    // Back to A within A's old 30s window; A's re-confirmation is held.
    holdCapabilities = true;
    const backToA = frames.length;
    signIn(USER_A, ORG_1);
    await act(async () => root!.render(tree()));
    await advance(5_000);
    expect(anyFigureSince(backToA)).toBe(false);
    expect(drewSince(backToA, ORG_2_FIGURE)).toBe(false);
    expect(cachedFinance()).toEqual([]);

    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "org 1 figures, re-confirmed");
    expect(drewSince(backToA, ORG_2_FIGURE)).toBe(false);
  });
});

/** Make the tab hidden or visible, and tell the page — as a browser does. */
async function setTabVisible(visible: boolean, check?: () => void) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    // Synchronously, before React's own scheduling gets a turn.
    check?.();
  });
}

describe("Home money: the deadline while the tab is hidden", () => {
  afterEach(() => {
    delete (document as any).visibilityState;
    delete (document as any).hidden;
  });

  it("lapses on its timer while hidden, and stays gone when shown again", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    await setTabVisible(false);
    holdCapabilities = true;
    await advanceTo(start + MAX_AGE_MS + 1);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    const mark = frames.length;
    await setTabVisible(true);
    await advance(1_000);
    expect(anyFigureSince(mark)).toBe(false);
  });

  it("timers frozen while hidden (device asleep): shown again past the deadline → gone before anything else runs", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const start = capabilityDispatches.at(-1)!;
    holdCapabilities = true;
    await setTabVisible(false);
    // The wall clock moves 31s; no timer fires and the monotonic clock stands
    // still — what a sleeping laptop or a frozen background tab looks like.
    jest.setSystemTime(start + MAX_AGE_MS + 1_000);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(true);

    let shownOnReturn: boolean[] = [];
    let cachedOnReturn: Money[] = [];
    await setTabVisible(true, () => {
      shownOnReturn = A_FIGURES.map(shows);
      cachedOnReturn = cachedFinance();
    });
    expect(shownOnReturn).toEqual([false, false]);
    expect(cachedOnReturn).toEqual([]);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    // Nothing further is asserted on this clock: the next
    // advanceTimersByTime() would (on Bun 1.3) rewind Date to the timer clock,
    // i.e. wind BOTH clocks back 31s — something no real device does. It still
    // runs, only so that work queued on fake timers is not left for the next
    // test (settleAfterJump).
    await settleAfterJump();
  });
});

describe("Home money: recovery needs a new confirmation AND a new Home read", () => {
  it("revoked → re-granted: money returns only after a fresh answer and a re-read landing under it", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    grant(USER_A, ORG_1, withoutReconcile());
    await advance(POLL_MS);
    await waitFor(() => shows(NO_PERMISSION), "denied copy");
    expect(cachedFinance()).toEqual([]);

    // Home stops polling once the finance keys are gone (its revalidation is
    // keyed on can()); the next check — a focus, a navigation — re-asks.
    grant(USER_A, ORG_1, OWNER);
    const homes = homeReads;
    const caps = capabilityDispatches.length;
    await advance(POLL_MS);
    expect(shows(A_FIGURES[0]!)).toBe(false);
    await act(async () => {
      void client.refetchQueries({ queryKey: capabilityKey() });
    });
    await settle(30);
    await waitFor(() => shows(A_FIGURES[0]!), "re-granted figures");
    expect(capabilityDispatches.length).toBeGreaterThan(caps);
    expect(homeReads).toBeGreaterThan(homes);
  });
});

describe("Home money: an SSR/loader-seeded capability snapshot", () => {
  const ownerSnapshot = (): CapabilityResult => ({
    status: "active",
    userId: USER_A,
    organizationId: ORG_1,
    role: null,
    permissions: OWNER,
  });

  it("is never treated as a confirmation: no money until this tab's own request answers, one request, a placeholder meanwhile", async () => {
    useFakeClock();
    ownerOnOrg1();
    seed = ownerSnapshot();
    holdCapabilities = true;
    await mountUnsettled();
    await waitFor(() => homeReads > 0 && client.isFetching() <= 1, "home read");
    await advance(10_000);
    // The seed renders the role-correct shell (tiles are available)…
    expect(shows("New order")).toBe(true);
    // …but never money, and not an error either: it is being confirmed.
    expect(anyFigureSince(0)).toBe(false);
    expect(shows(UNAVAILABLE)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    // Exactly one capability request — the seed's confirmation — no churn.
    expect(capabilityReads).toBe(1);

    await releaseOldestCapability();
    await waitFor(() => shows(A_FIGURES[0]!), "confirmed figures");
  });

  it("whose confirmation hangs: still no money, re-asked at a bounded rate", async () => {
    useFakeClock();
    ownerOnOrg1();
    seed = ownerSnapshot();
    holdCapabilities = true;
    await mountUnsettled();
    await advance(3 * 60_000);
    expect(anyFigureSince(0)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    // One re-ask per 30s once a request is too old to vouch for anything.
    expect(capabilityReads).toBeGreaterThanOrEqual(2);
    expect(capabilityReads).toBeLessThanOrEqual(8);
  });

  it("seeded with another principal's snapshot: nothing shown, nothing borrowed", async () => {
    useFakeClock();
    ownerOnOrg1();
    seed = { ...ownerSnapshot(), userId: USER_B };
    holdCapabilities = true;
    await mountUnsettled();
    await advance(10_000);
    expect(anyFigureSince(0)).toBe(false);
    expect(cachedFinance()).toEqual([]);
    await releaseCapabilities();
    await waitFor(() => shows(A_FIGURES[0]!), "own confirmed figures");
  });
});

describe("Home money: no excess polling or Home reads under the new provenance", () => {
  it("three healthy minutes: one capability request per 15s, zero Home re-reads, figures never flicker", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    const mark = frames.length;
    const caps = capabilityReads;
    const homes = homeReads;
    await advanceInSteps(3 * 60_000);
    expect(capabilityReads - caps).toBeGreaterThanOrEqual(11);
    expect(capabilityReads - caps).toBeLessThanOrEqual(13);
    expect(homeReads).toBe(homes);
    expect(frames.slice(mark).every((frame) => frame.includes(A_FIGURES[0]!))).toBe(true);
  });

  it("lapsed and hung for three minutes: bounded capability re-asks and bounded Home reads", async () => {
    useFakeClock();
    ownerOnOrg1();
    await mount();
    await waitFor(() => shows(A_FIGURES[0]!), "owner figures");
    holdCapabilities = true;
    const caps = capabilityReads;
    const homes = homeReads;
    await advanceInSteps(3 * 60_000);
    for (const figure of A_FIGURES) expect(shows(figure)).toBe(false);
    expect(capabilityReads - caps).toBeLessThanOrEqual(8);
    expect(homeReads - homes).toBeLessThanOrEqual(2);
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
