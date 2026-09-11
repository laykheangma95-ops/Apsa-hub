/**
 * Home cache and session purge.
 *
 * The failure this guards against is concrete: User A opens Home on a shared
 * phone, signs out, and User B signs in through client-side navigation — no
 * page reload, so the tab's QueryClient is the same object throughout. User
 * A's Home payload (orders, payments, stock, delivery for A's organization)
 * must not survive that transition, and B must never read it.
 *
 * These tests drive the real production helpers against a real QueryClient
 * and a stand-in server that derives identity from its own session, never
 * from what the caller passes in.
 *
 * Run: bun test src/tests/home-cache-isolation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import * as fs from "fs";
import * as path from "path";
import {
  clearHomeQueries,
  enforceHomeCachePrincipal,
  homeQueryKey,
  HOME_QUERY_PREFIX,
} from "@/lib/home-query";
import type { HomeSummary, MetricRange } from "@/types";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

const USER_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ORG_A = "aaaaaaaa-1111-0000-0000-0000000000aa";
const USER_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const ORG_B = "bbbbbbbb-1111-0000-0000-0000000000bb";

/** A distinguishable Home payload, so a leak is visible in the numbers. */
function summaryFor(organizationId: string, awaitingPaymentCount: number): HomeSummary {
  return {
    range: "today",
    orders: {
      status: "available",
      data: { periodCount: awaitingPaymentCount, awaitingPaymentCount, actionNeededCount: 0 },
    },
    payments: { status: "available", data: { needsReviewCount: 0 } },
    finance: {
      status: "available",
      data: {
        netCollectedForCreatedOrders: [
          { amountMinor: awaitingPaymentCount * 1000, currency: "USD" },
        ],
      },
    },
    inventory: { status: "available", data: { outOfStockVariantCount: 0 } },
    delivery: { status: "available", data: { actionCount: 0 } },
    // Carried for assertions only; never sent by the client.
    ...({ __org: organizationId } as unknown as Record<string, never>),
  };
}

/**
 * Stands in for the authenticated Home boundary. Identity comes from the
 * session it holds — exactly like the real server function, which resolves the
 * user from the validated session cookie and the organization from the active
 * membership row. Nothing the caller passes can change whose data comes back.
 */
function createFakeServer() {
  const DATA: Record<string, HomeSummary> = {
    [ORG_A]: summaryFor(ORG_A, 42),
    [ORG_B]: summaryFor(ORG_B, 7),
  };
  let session: { userId: string; organizationId: string } | null = null;
  const calls: Array<{ userId: string; organizationId: string }> = [];

  return {
    signIn(userId: string, organizationId: string) {
      session = { userId, organizationId };
    },
    signOut() {
      session = null;
    },
    get calls() {
      return calls;
    },
    async getHomeSummary(): Promise<HomeSummary> {
      if (!session) throw new Error("Not authenticated");
      calls.push({ ...session });
      return DATA[session.organizationId]!;
    },
  };
}

function orgOf(summary: HomeSummary | undefined): string | undefined {
  return (summary as unknown as { __org?: string } | undefined)?.__org;
}

/** Home's cached entries in this tab, whoever they belong to. */
function cachedHomeKeys(client: QueryClient) {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter(
      (key) =>
        Array.isArray(key) && key[0] === HOME_QUERY_PREFIX[0] && key[1] === HOME_QUERY_PREFIX[1],
    );
}

// ── The lifecycle, as the routes actually run it ─────────────────────────────

/** What /app's layout does on every render for the signed-in principal. */
function mountAppLayout(client: QueryClient, userId: string, organizationId: string) {
  enforceHomeCachePrincipal(client, userId, organizationId);
}

/** What the Home route does: read/fill its own partitioned entry. */
async function renderHome(
  client: QueryClient,
  server: ReturnType<typeof createFakeServer>,
  userId: string,
  organizationId: string,
  range: MetricRange = "today",
): Promise<HomeSummary> {
  return client.fetchQuery({
    queryKey: homeQueryKey(userId, organizationId, range),
    queryFn: () => server.getHomeSummary(),
  });
}

/** What Home would read out of the cache with no fetch at all. */
function homeFromCacheOnly(
  client: QueryClient,
  userId: string,
  organizationId: string,
  range: MetricRange = "today",
): HomeSummary | undefined {
  return client.getQueryData(homeQueryKey(userId, organizationId, range));
}

// ═══════════════════════════════════════════════════════════════════════════════
// A → sign out → B, in one tab
// ═══════════════════════════════════════════════════════════════════════════════

describe("User A's Home data does not survive sign-out into User B's session", () => {
  it("removes A's cached Home entry and gives B only its own organization's data", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    // 1. User A signs in and loads Home.
    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    const aSummary = await renderHome(client, server, USER_A, ORG_A);
    expect(orgOf(aSummary)).toBe(ORG_A);
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeDefined();

    // 2. User A signs out. Same tab, same QueryClient.
    server.signOut();
    clearHomeQueries(client);

    // A's entry is gone — removed, not merely marked stale and still readable.
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
    expect(cachedHomeKeys(client)).toHaveLength(0);

    // 3. User B signs in through client-side navigation: /app mounts again.
    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    // Before any fetch resolves, B can render nothing of A's.
    expect(homeFromCacheOnly(client, USER_B, ORG_B)).toBeUndefined();
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
    expect(cachedHomeKeys(client)).toHaveLength(0);

    // 4. B's own load returns B's organization, and only B's.
    const bSummary = await renderHome(client, server, USER_B, ORG_B);
    expect(orgOf(bSummary)).toBe(ORG_B);
    expect(bSummary.orders.status).toBe("available");
    if (bSummary.orders.status === "available") {
      expect(bSummary.orders.data.awaitingPaymentCount).toBe(7); // A's was 42.
    }

    // The only identity the server ever acted on was its own session's.
    expect(server.calls).toEqual([
      { userId: USER_A, organizationId: ORG_A },
      { userId: USER_B, organizationId: ORG_B },
    ]);

    // A's entry never came back.
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
    expect(cachedHomeKeys(client)).toHaveLength(1);
  });

  it("purges A's data even when the sign-out cache clear never ran", async () => {
    // signOutFn() can reject in transit, or clear() can throw, while the
    // server has already revoked the session. The principal change on B's
    // mount is the second, independent barrier.
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A);
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeDefined();

    // No clearHomeQueries() at all — straight to B mounting /app.
    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
    expect(cachedHomeKeys(client)).toHaveLength(0);
  });

  it("purges when the same user switches to another organization", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A);

    // Same person, different active organization — still a different tenant.
    server.signIn(USER_A, ORG_B);
    mountAppLayout(client, USER_A, ORG_B);

    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
    expect(cachedHomeKeys(client)).toHaveLength(0);
  });
});

describe("normal caching still works for the same principal", () => {
  it("keeps the cached entry across re-renders and range switches", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A, "today");

    // Re-render, range change, re-render again — all the same principal.
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A, "week");
    mountAppLayout(client, USER_A, ORG_A);

    expect(homeFromCacheOnly(client, USER_A, ORG_A, "today")).toBeDefined();
    expect(homeFromCacheOnly(client, USER_A, ORG_A, "week")).toBeDefined();
    expect(cachedHomeKeys(client)).toHaveLength(2);
  });

  it("re-mounting /app for the same principal does not drop the cache", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A);

    // Navigate away to another /app screen and back: layout mounts again.
    mountAppLayout(client, USER_A, ORG_A);

    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeDefined();
  });
});

describe("the purge is resilient and self-contained", () => {
  it("never throws, even when the cache cannot be pruned", () => {
    const client = new QueryClient();
    // A QueryClient whose removeQueries fails — sign-out must still complete.
    (client as unknown as { removeQueries: () => void }).removeQueries = () => {
      throw new Error("cache unavailable");
    };
    expect(() => clearHomeQueries(client)).not.toThrow();
  });

  it("forgets the recorded principal, so the next mount purges again", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A);

    clearHomeQueries(client);

    // A signs back in and re-loads, then B arrives without a sign-out purge.
    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await renderHome(client, server, USER_A, ORG_A);
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeDefined();

    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);
    expect(homeFromCacheOnly(client, USER_A, ORG_A)).toBeUndefined();
  });

  it("leaves other domains' caches to their own owners", async () => {
    const client = new QueryClient();
    client.setQueryData(["orders", "real"], ["an order"]);

    clearHomeQueries(client);

    // clearHomeQueries is Home's purge, not a blanket wipe. Sign-out still
    // runs queryClient.clear() for everything else.
    expect(client.getQueryData(["orders", "real"])).toEqual(["an order"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Wiring — the helpers above are the ones the app actually calls
// ═══════════════════════════════════════════════════════════════════════════════

describe("the purge is wired into the real routes", () => {
  it("/app enforces the cache principal from server-derived route context", () => {
    const source = readSource("src/routes/app.tsx");
    expect(source).toContain(
      "enforceHomeCachePrincipal(queryClient, session.userId, organizationId)",
    );
    // Both values come from beforeLoad's guard result, never from client input.
    expect(source).toContain("const { session, organizationId } = Route.useRouteContext()");
  });

  it("sign-out purges Home before the blanket clear, and after revocation", () => {
    const source = readSource("src/routes/app.settings.tsx");
    const revokeIdx = source.indexOf("await signOutFn()");
    const homeIdx = source.indexOf("clearHomeQueries(queryClient)");
    const clearIdx = source.indexOf("queryClient.clear()");

    expect(revokeIdx).toBeGreaterThan(-1);
    expect(homeIdx).toBeGreaterThan(revokeIdx);
    // Home's targeted purge cannot throw, so it runs first.
    expect(homeIdx).toBeLessThan(clearIdx);
  });

  it("Home's query key still carries the purge prefix", () => {
    const key = homeQueryKey(USER_A, ORG_A, "today");
    expect(key[0]).toBe(HOME_QUERY_PREFIX[0]);
    expect(key[1]).toBe(HOME_QUERY_PREFIX[1]);
    expect(key).toEqual(["home", "authenticated", USER_A, ORG_A, "today"]);
  });
});
