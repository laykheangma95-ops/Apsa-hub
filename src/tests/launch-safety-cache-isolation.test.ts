/**
 * Launch-safety: principal partitioning across the six remaining sensitive
 * React Query caches — Orders, Conversations, Customers, POS products, Team
 * and Deliveries.
 *
 * The failure these guard against is one concrete scene, not an abstraction:
 * a shared phone in a Cambodian shop. User A opens Orders (or the Inbox, or
 * Customer 360) for Organization A, signs out, and User B signs in through
 * client-side navigation. No page reload happens, so the tab's QueryClient is
 * the same JavaScript object throughout, and every cache entry A filled is
 * still sitting in it. Before this phase each of these domains keyed on a bare
 * string — ["orders","real"], ["conversations",...], ["customers"],
 * ["pos-products"], ["team"] — so the key B mounted was character-for-character
 * the key A had filled, and React Query served A's payload while B's refetch
 * was still in flight.
 *
 * Each domain is exercised against a REAL QueryClient and a stand-in server
 * that derives identity from its own session, exactly as the real server
 * functions do (validated session cookie -> user, active membership row ->
 * organization). Nothing the caller passes can change whose data comes back,
 * so a test that "passes" by handing the server the right organization id
 * cannot happen here.
 *
 * `queryClient.clear()` is deliberately NOT the mechanism under test. It stays
 * defense-in-depth on the sign-out path; these tests prove isolation holds
 * without it, which is what a client-side account switch that never reaches
 * Settings depends on.
 *
 * Run: bun test src/tests/launch-safety-cache-isolation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import * as fs from "fs";
import * as path from "path";

import { catalogKeys, clearCatalogQueries, enforceCatalogCachePrincipal } from "@/lib/catalog";
import {
  clearCustomerQueries,
  customerKeys,
  customerSensitiveVisible,
  enforceCustomerCachePrincipal,
  visibleCustomerPhone,
  CUSTOMERS_QUERY_ROOT,
} from "@/lib/customers-query";
import {
  clearConversationQueries,
  conversationKeys,
  enforceConversationCachePrincipal,
  CONVERSATIONS_QUERY_ROOT,
} from "@/lib/inbox-query";
import {
  clearDeliveryQueries,
  deliveryKeys,
  enforceDeliveryCachePrincipal,
  DELIVERIES_QUERY_ROOT,
} from "@/lib/deliveries-query";
import {
  clearOrderQueries,
  enforceOrderCachePrincipal,
  ordersKeys,
  ORDERS_QUERY_ROOT,
} from "@/lib/orders-query";
import {
  clearTeamQueries,
  enforceTeamCachePrincipal,
  teamKeys,
  TEAM_QUERY_ROOT,
} from "@/lib/team-query";
import { createQueryPartition, principalTag } from "@/lib/query-principal";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

/**
 * Source with comments removed, for the "this key shape is gone" scans below.
 *
 * The migration comments deliberately quote the old, leaky key literals so a
 * future reader can see what was replaced and why. Scanning raw text would
 * therefore fail on the very documentation that explains the fix — so the
 * scans run against code only. Same helper, same reason, as
 * src/tests/core-workflow-handoffs.test.ts.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const USER_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ORG_A = "aaaaaaaa-1111-0000-0000-0000000000aa";
const USER_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const ORG_B = "bbbbbbbb-1111-0000-0000-0000000000bb";

/**
 * Every domain's data, tagged with the organization it belongs to so a leak is
 * visible as a value rather than inferred from an absence.
 */
interface TenantPayload {
  org: string;
  rows: string[];
}

/**
 * Stands in for the authenticated server boundary shared by all five domains.
 *
 * Identity comes from the session it holds. The `organizationId` a caller
 * might pass is not a parameter at all — exactly like the real server
 * functions, which resolve the organization from the membership row and would
 * ignore (indeed, never receive) a client-supplied one.
 */
function createFakeServer() {
  const DATA: Record<string, Record<string, TenantPayload>> = {
    orders: {
      [ORG_A]: { org: ORG_A, rows: ["APSA-0001 $42.00", "APSA-0002 $7.50"] },
      [ORG_B]: { org: ORG_B, rows: ["APSA-9001 $3.00"] },
    },
    conversations: {
      [ORG_A]: { org: ORG_A, rows: ["con-a1 យក ២", "con-a2 តម្លៃ?"] },
      [ORG_B]: { org: ORG_B, rows: ["con-b1 hello"] },
    },
    customers: {
      [ORG_A]: { org: ORG_A, rows: ["Sok Dara 012345678"] },
      [ORG_B]: { org: ORG_B, rows: ["Chan Nita 098765432"] },
    },
    posProducts: {
      [ORG_A]: { org: ORG_A, rows: ["Serum $19.80"] },
      [ORG_B]: { org: ORG_B, rows: ["T-shirt $8.00"] },
    },
    team: {
      [ORG_A]: { org: ORG_A, rows: ["Owner A owner@a.test"] },
      [ORG_B]: { org: ORG_B, rows: ["Owner B owner@b.test"] },
    },
    // A delivery row is customer name + order code + COD money + the courier's
    // external tracking number — real tenant data, exactly like the five above.
    deliveries: {
      [ORG_A]: { org: ORG_A, rows: ["Sok Dara APSA-0001 COD $42.00 VET-A-77123"] },
      [ORG_B]: { org: ORG_B, rows: ["Chan Nita APSA-9001 COD $3.00 VET-B-90881"] },
    },
  };

  let session: { userId: string; organizationId: string } | null = null;
  const calls: Array<{ domain: string; userId: string; organizationId: string }> = [];

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
    async read(domain: keyof typeof DATA): Promise<TenantPayload> {
      if (!session) throw new Error("Not authenticated");
      calls.push({ domain, ...session });
      return DATA[domain]![session.organizationId]!;
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

function orgOf(payload: TenantPayload | undefined): string | undefined {
  return payload?.org;
}

/** What /app's layout does on every render, for whoever is signed in. */
function mountAppLayout(client: QueryClient, userId: string, organizationId: string) {
  enforceOrderCachePrincipal(client, userId, organizationId);
  enforceConversationCachePrincipal(client, userId, organizationId);
  enforceCustomerCachePrincipal(client, userId, organizationId);
  enforceDeliveryCachePrincipal(client, userId, organizationId);
  enforceTeamCachePrincipal(client, userId, organizationId);
  enforceCatalogCachePrincipal(client, userId, organizationId);
}

/**
 * One table of what each migrated domain looks like, so every assertion below
 * runs against all six rather than whichever one a future edit remembers.
 */
const DOMAINS = [
  {
    name: "Orders list",
    root: ORDERS_QUERY_ROOT,
    domain: "orders" as const,
    key: (u: string, o: string) => ordersKeys.list(u, o) as readonly unknown[],
    clear: clearOrderQueries,
  },
  {
    name: "Conversations list",
    root: CONVERSATIONS_QUERY_ROOT,
    domain: "conversations" as const,
    key: (u: string, o: string) =>
      conversationKeys.list(u, o, "all", "all", "") as readonly unknown[],
    clear: clearConversationQueries,
  },
  {
    name: "Customer list",
    root: CUSTOMERS_QUERY_ROOT,
    domain: "customers" as const,
    key: (u: string, o: string) => customerKeys.list(u, o, 0) as readonly unknown[],
    clear: clearCustomerQueries,
  },
  {
    name: "POS products",
    root: "catalog",
    domain: "posProducts" as const,
    key: (u: string, o: string) => catalogKeys.uiProducts(u, o, "pos") as readonly unknown[],
    clear: clearCatalogQueries,
  },
  {
    name: "Team roster",
    root: TEAM_QUERY_ROOT,
    domain: "team" as const,
    key: (u: string, o: string) => teamKeys.roster(u, o) as readonly unknown[],
    clear: clearTeamQueries,
  },
  {
    name: "Deliveries list",
    root: DELIVERIES_QUERY_ROOT,
    domain: "deliveries" as const,
    key: (u: string, o: string) => deliveryKeys.list(u, o, null, null, null) as readonly unknown[],
    clear: clearDeliveryQueries,
  },
] as const;

async function fill(
  client: QueryClient,
  server: FakeServer,
  spec: (typeof DOMAINS)[number],
  userId: string,
  organizationId: string,
): Promise<TenantPayload> {
  return client.fetchQuery({
    queryKey: spec.key(userId, organizationId) as unknown[],
    queryFn: () => server.read(spec.domain),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Query-key partitioning
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. every migrated key carries the principal", () => {
  for (const spec of DOMAINS) {
    it(`${spec.name}: the key starts with root, userId, organizationId`, () => {
      const key = spec.key(USER_A, ORG_A);
      expect(key[0]).toBe(spec.root);
      expect(key[1]).toBe(USER_A);
      expect(key[2]).toBe(ORG_A);
    });

    it(`${spec.name}: a different user in the SAME organization gets a different key`, () => {
      // The case an organization-only partition would miss entirely: two
      // members of one shop with different permissions.
      expect(spec.key(USER_A, ORG_A)).not.toEqual(spec.key(USER_B, ORG_A));
    });

    it(`${spec.name}: the same user in a different organization gets a different key`, () => {
      expect(spec.key(USER_A, ORG_A)).not.toEqual(spec.key(USER_A, ORG_B));
    });
  }

  it("no migrated key is one of the pre-phase shapes every principal shared", () => {
    /*
     * The exact keys that leaked. Sharing a ROOT with one of them is fine and
     * expected — "customers" is still the customer root — what must never come
     * back is a key whose identity stops at that root, with no principal in
     * it. So these are compared whole, and then every migrated key is required
     * to carry the principal in positions 1 and 2.
     */
    const leaky = [
      ["orders", "real"],
      ["conversations"],
      ["conversation-counts"],
      ["customers"],
      ["customer360"],
      ["customer-orders"],
      ["pos-products"],
      ["pos-customers"],
      ["team"],
      ["deliveries", "real"],
      ["delivery", "real"],
    ];
    const migrated = DOMAINS.map((spec) => spec.key(USER_A, ORG_A));
    for (const key of migrated) {
      for (const bad of leaky) {
        expect([...key]).not.toEqual(bad);
      }
      // The load-bearing part: identity, not just length.
      expect(key[1]).toBe(USER_A);
      expect(key[2]).toBe(ORG_A);
    }
  });

  it("sub-keys stay inside their own principal's partition", () => {
    // A detail, its deliveries, an order history and a search term must all be
    // reachable from the principal prefix — that is what makes one targeted
    // invalidation possible without a blanket clear.
    const principal = ordersKeys.principal(USER_A, ORG_A);
    for (const key of [
      ordersKeys.list(USER_A, ORG_A),
      ordersKeys.detail(USER_A, ORG_A, "ord-1"),
      ordersKeys.detailDeliveries(USER_A, ORG_A, "ord-1"),
    ]) {
      expect(key.slice(0, principal.length)).toEqual(principal as unknown as typeof key);
    }

    const custPrincipal = customerKeys.principal(USER_A, ORG_A);
    for (const key of [
      customerKeys.list(USER_A, ORG_A, 0),
      customerKeys.detail(USER_A, ORG_A, "cus-1"),
      customerKeys.orders(USER_A, ORG_A, "cus-1"),
      customerKeys.options(USER_A, ORG_A),
      customerKeys.search(USER_A, ORG_A, "dara"),
    ]) {
      expect(key.slice(0, custPrincipal.length)).toEqual(custPrincipal as unknown as typeof key);
    }

    const convPrincipal = conversationKeys.principal(USER_A, ORG_A);
    for (const key of [
      conversationKeys.list(USER_A, ORG_A, "all", "all", ""),
      conversationKeys.counts(USER_A, ORG_A),
      conversationKeys.detail(USER_A, ORG_A, "con-1"),
    ]) {
      expect(key.slice(0, convPrincipal.length)).toEqual(convPrincipal as unknown as typeof key);
    }
  });

  it("two payload shapes never share one customer key", () => {
    // `list` holds a CustomerListPage, `options` holds raw picker rows. One key
    // for both would let whichever query ran first hand the other a payload it
    // cannot read.
    expect(customerKeys.list(USER_A, ORG_A, 0)).not.toEqual(customerKeys.options(USER_A, ORG_A));
  });

  it("customer list pages are distinct entries, so page 2 never overwrites page 1", () => {
    expect(customerKeys.list(USER_A, ORG_A, 0)).not.toEqual(customerKeys.list(USER_A, ORG_A, 100));
  });

  it("conversation filters stay in the key, behind the principal", () => {
    const base = conversationKeys.list(USER_A, ORG_A, "all", "all", "");
    expect(conversationKeys.list(USER_A, ORG_A, "unread", "all", "")).not.toEqual(base);
    expect(conversationKeys.list(USER_A, ORG_A, "all", "telegram", "")).not.toEqual(base);
    expect(conversationKeys.list(USER_A, ORG_A, "all", "all", "dara")).not.toEqual(base);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Principal switch — A fills the cache, B mounts, B must see nothing of A's
// ═══════════════════════════════════════════════════════════════════════════════

describe("B. principal switch on one QueryClient", () => {
  for (const spec of DOMAINS) {
    it(`${spec.name}: B cannot read A's cached payload, and none of it renders`, async () => {
      const client = new QueryClient();
      const server = createFakeServer();

      // ── User A, Organization A ────────────────────────────────────────────
      server.signIn(USER_A, ORG_A);
      mountAppLayout(client, USER_A, ORG_A);
      const aData = await fill(client, server, spec, USER_A, ORG_A);
      expect(orgOf(aData)).toBe(ORG_A);

      // ── Sign out, sign in as B. No page reload: same QueryClient. ─────────
      server.signOut();
      server.signIn(USER_B, ORG_B);
      mountAppLayout(client, USER_B, ORG_B);

      // What B's screen would render from cache alone, before any fetch:
      // nothing at all. This is the frame the leak used to live in.
      const fromCacheOnly = client.getQueryData(spec.key(USER_B, ORG_B) as unknown[]);
      expect(fromCacheOnly).toBeUndefined();

      // A's entry is not merely unreachable under B's key — it is gone.
      expect(client.getQueryData(spec.key(USER_A, ORG_A) as unknown[])).toBeUndefined();

      // And when B does fetch, the server answers from B's own session.
      const bData = await fill(client, server, spec, USER_B, ORG_B);
      expect(orgOf(bData)).toBe(ORG_B);
      expect(bData.rows).not.toEqual(aData.rows);
    });

    it(`${spec.name}: isolation holds WITHOUT queryClient.clear()`, async () => {
      // The account switch that never goes through Settings' sign-out path.
      const client = new QueryClient();
      const server = createFakeServer();

      server.signIn(USER_A, ORG_A);
      mountAppLayout(client, USER_A, ORG_A);
      await fill(client, server, spec, USER_A, ORG_A);

      server.signIn(USER_B, ORG_B);
      mountAppLayout(client, USER_B, ORG_B); // no clear() anywhere

      expect(client.getQueryData(spec.key(USER_B, ORG_B) as unknown[])).toBeUndefined();
      expect(client.getQueryData(spec.key(USER_A, ORG_A) as unknown[])).toBeUndefined();
    });

    it(`${spec.name}: two members of the SAME organization do not share an entry`, async () => {
      // The case an organization-only key would get wrong. A holds the grant
      // that fills this payload; B, in the same shop, does not.
      const client = new QueryClient();
      const server = createFakeServer();

      server.signIn(USER_A, ORG_A);
      mountAppLayout(client, USER_A, ORG_A);
      await fill(client, server, spec, USER_A, ORG_A);

      server.signIn(USER_B, ORG_A);
      mountAppLayout(client, USER_B, ORG_A);

      expect(client.getQueryData(spec.key(USER_B, ORG_A) as unknown[])).toBeUndefined();
    });

    it(`${spec.name}: the same principal keeps its cache (caching still works)`, async () => {
      const client = new QueryClient();
      const server = createFakeServer();

      server.signIn(USER_A, ORG_A);
      mountAppLayout(client, USER_A, ORG_A);
      await fill(client, server, spec, USER_A, ORG_A);

      // A re-render, a navigation — the guard runs again and must be a no-op.
      mountAppLayout(client, USER_A, ORG_A);
      mountAppLayout(client, USER_A, ORG_A);

      expect(client.getQueryData(spec.key(USER_A, ORG_A) as unknown[])).toBeDefined();
    });
  }

  it("the same user switching organization is treated as a new principal", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await fill(client, server, DOMAINS[0], USER_A, ORG_A);

    server.signIn(USER_A, ORG_B);
    mountAppLayout(client, USER_A, ORG_B);

    expect(client.getQueryData(ordersKeys.list(USER_A, ORG_A) as unknown[])).toBeUndefined();
    expect(client.getQueryData(ordersKeys.list(USER_A, ORG_B) as unknown[])).toBeUndefined();
  });

  it("a fetch already in flight for A cannot resolve into B's key", async () => {
    // React Query resolves a request into the key it was started under. B's
    // key differs, so an A request still in the air lands in an entry the
    // enforcement has already dropped — never in front of B.
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    const inFlight = fill(client, server, DOMAINS[0], USER_A, ORG_A);

    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    await inFlight.catch(() => undefined);

    expect(client.getQueryData(ordersKeys.list(USER_B, ORG_B) as unknown[])).toBeUndefined();
  });

  it("every server read was made under the session that asked for it", async () => {
    // Proves the fake server is actually session-driven: no call was ever
    // served for an organization other than the one signed in at the time.
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    for (const spec of DOMAINS) await fill(client, server, spec, USER_A, ORG_A);

    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);
    for (const spec of DOMAINS) await fill(client, server, spec, USER_B, ORG_B);

    expect(server.calls.length).toBe(DOMAINS.length * 2);
    expect(server.calls.slice(0, DOMAINS.length).every((c) => c.organizationId === ORG_A)).toBe(
      true,
    );
    expect(server.calls.slice(DOMAINS.length).every((c) => c.organizationId === ORG_B)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Targeted invalidation — a mutation must never reach another principal
// ═══════════════════════════════════════════════════════════════════════════════

describe("C. invalidation stays inside the acting principal", () => {
  it("invalidating this principal's Orders root leaves another principal's entry untouched", async () => {
    // Two principals coexisting in one cache is not the normal case — the
    // enforcement above prevents it — but invalidation must be correct even so,
    // because that is what proves the key, not the purge, is doing the work.
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    await fill(client, server, DOMAINS[0], USER_A, ORG_A);
    server.signIn(USER_B, ORG_B);
    await fill(client, server, DOMAINS[0], USER_B, ORG_B);

    await client.invalidateQueries({ queryKey: ordersKeys.principal(USER_A, ORG_A) as unknown[] });

    const aState = client.getQueryState(ordersKeys.list(USER_A, ORG_A) as unknown[]);
    const bState = client.getQueryState(ordersKeys.list(USER_B, ORG_B) as unknown[]);
    expect(aState?.isInvalidated).toBe(true);
    expect(bState?.isInvalidated).toBe(false);
  });

  it("an Orders invalidation covers the list, the detail and the detail's deliveries", async () => {
    const client = new QueryClient();
    client.setQueryData(ordersKeys.list(USER_A, ORG_A) as unknown[], { org: ORG_A, rows: [] });
    client.setQueryData(ordersKeys.detail(USER_A, ORG_A, "ord-1") as unknown[], { id: "ord-1" });
    client.setQueryData(ordersKeys.detailDeliveries(USER_A, ORG_A, "ord-1") as unknown[], []);

    await client.invalidateQueries({ queryKey: ordersKeys.principal(USER_A, ORG_A) as unknown[] });

    for (const key of [
      ordersKeys.list(USER_A, ORG_A),
      ordersKeys.detail(USER_A, ORG_A, "ord-1"),
      ordersKeys.detailDeliveries(USER_A, ORG_A, "ord-1"),
    ]) {
      expect(client.getQueryState(key as unknown[])?.isInvalidated).toBe(true);
    }
  });

  it("a Conversation invalidation covers every filtered list and the counts in one call", async () => {
    const client = new QueryClient();
    const keys = [
      conversationKeys.list(USER_A, ORG_A, "all", "all", ""),
      conversationKeys.list(USER_A, ORG_A, "unread", "facebook", "dara"),
      conversationKeys.counts(USER_A, ORG_A),
      conversationKeys.detail(USER_A, ORG_A, "con-1"),
    ];
    for (const key of keys) client.setQueryData(key as unknown[], { ok: true });

    await client.invalidateQueries({
      queryKey: conversationKeys.principal(USER_A, ORG_A) as unknown[],
    });

    for (const key of keys) {
      expect(client.getQueryState(key as unknown[])?.isInvalidated).toBe(true);
    }
  });

  it("a Customer invalidation covers the profile and its order history together", async () => {
    const client = new QueryClient();
    client.setQueryData(customerKeys.detail(USER_A, ORG_A, "cus-1") as unknown[], { id: "cus-1" });
    client.setQueryData(customerKeys.orders(USER_A, ORG_A, "cus-1") as unknown[], []);

    await client.invalidateQueries({
      queryKey: customerKeys.detail(USER_A, ORG_A, "cus-1") as unknown[],
    });

    expect(
      client.getQueryState(customerKeys.detail(USER_A, ORG_A, "cus-1") as unknown[])?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(customerKeys.orders(USER_A, ORG_A, "cus-1") as unknown[])?.isInvalidated,
    ).toBe(true);
  });

  it("a Team invalidation does not reach another principal's roster", async () => {
    const client = new QueryClient();
    client.setQueryData(teamKeys.roster(USER_A, ORG_A) as unknown[], { org: ORG_A });
    client.setQueryData(teamKeys.roster(USER_B, ORG_B) as unknown[], { org: ORG_B });

    await client.invalidateQueries({ queryKey: teamKeys.roster(USER_A, ORG_A) as unknown[] });

    expect(client.getQueryState(teamKeys.roster(USER_B, ORG_B) as unknown[])?.isInvalidated).toBe(
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. The purge primitive itself
// ═══════════════════════════════════════════════════════════════════════════════

describe("D. the partition primitive", () => {
  it("clear removes, rather than invalidates — nothing stays readable", () => {
    const client = new QueryClient();
    client.setQueryData(ordersKeys.list(USER_A, ORG_A) as unknown[], { org: ORG_A, rows: ["x"] });

    clearOrderQueries(client);

    // An invalidated entry would still return data here. A removed one cannot.
    expect(client.getQueryData(ordersKeys.list(USER_A, ORG_A) as unknown[])).toBeUndefined();
    expect(client.getQueryCache().findAll({ queryKey: [ORDERS_QUERY_ROOT] })).toHaveLength(0);
  });

  it("each clear touches only its own domain", () => {
    const client = new QueryClient();
    client.setQueryData(ordersKeys.list(USER_A, ORG_A) as unknown[], { org: ORG_A, rows: [] });
    client.setQueryData(customerKeys.list(USER_A, ORG_A, 0) as unknown[], { org: ORG_A });
    client.setQueryData(teamKeys.roster(USER_A, ORG_A) as unknown[], { org: ORG_A });

    clearOrderQueries(client);

    expect(client.getQueryData(customerKeys.list(USER_A, ORG_A, 0) as unknown[])).toBeDefined();
    expect(client.getQueryData(teamKeys.roster(USER_A, ORG_A) as unknown[])).toBeDefined();
  });

  it("clear never throws, even when the cache itself is broken", () => {
    const broken = new QueryClient();
    (broken as unknown as { removeQueries: () => void }).removeQueries = () => {
      throw new Error("cache exploded");
    };
    // Sign-out and navigation must complete regardless.
    expect(() => clearOrderQueries(broken)).not.toThrow();
    expect(() => clearCustomerQueries(broken)).not.toThrow();
    expect(() => clearConversationQueries(broken)).not.toThrow();
    expect(() => clearTeamQueries(broken)).not.toThrow();
  });

  it("a failed clear still forces the NEXT principal to purge again", async () => {
    // The recorded principal is dropped in a `finally`, so a clear that threw
    // cannot leave the guard believing the cache is already clean.
    const partition = createQueryPartition("test-root");
    const client = new QueryClient();
    let explode = true;
    const realRemove = client.removeQueries.bind(client);
    (client as unknown as { removeQueries: (a?: unknown) => void }).removeQueries = (a) => {
      if (explode) throw new Error("boom");
      realRemove(a as never);
    };

    partition.enforce(client, USER_A, ORG_A); // throws internally, swallowed
    explode = false;
    client.setQueryData(["test-root", USER_A, ORG_A, "x"], { org: ORG_A });

    partition.enforce(client, USER_B, ORG_B);
    expect(client.getQueryData(["test-root", USER_A, ORG_A, "x"])).toBeUndefined();
  });

  it("principalTag cannot collide between two different principals", () => {
    expect(principalTag(USER_A, ORG_A)).not.toBe(principalTag(USER_B, ORG_A));
    expect(principalTag(USER_A, ORG_A)).not.toBe(principalTag(USER_A, ORG_B));
    // "/" cannot appear in a UUID, so the two halves can never run together.
    expect(principalTag(USER_A, ORG_A)).toBe(`${USER_A}/${ORG_A}`);
  });

  it("each QueryClient tracks its own principal (one tab cannot speak for another)", () => {
    const tabOne = new QueryClient();
    const tabTwo = new QueryClient();
    const partition = createQueryPartition("per-tab");

    partition.enforce(tabOne, USER_A, ORG_A);
    tabTwo.setQueryData(["per-tab", USER_A, ORG_A], { org: ORG_A });

    // tabTwo has never been enforced, so this is a change for IT regardless of
    // what tabOne recorded.
    partition.enforce(tabTwo, USER_A, ORG_A);
    expect(tabTwo.getQueryData(["per-tab", USER_A, ORG_A])).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. Permission-sensitive rendering fails closed
// ═══════════════════════════════════════════════════════════════════════════════

describe("E. cached customer PII fails closed when the capability goes", () => {
  const cachedWithPhone = { phone: "012 345 678", sensitiveVisible: true };

  it("a phone cached under the grant is masked the moment the grant is gone", () => {
    // Nothing refetched, nothing was invalidated — the payload still says
    // sensitiveVisible. The current capability answer is what decides.
    expect(visibleCustomerPhone(cachedWithPhone, true)).toBe("012 345 678");
    expect(visibleCustomerPhone(cachedWithPhone, false)).toBe("");
  });

  it("the server's own withholding is never overridden by a client-side yes", () => {
    const withheld = { phone: "", sensitiveVisible: false };
    expect(visibleCustomerPhone(withheld, true)).toBe("");
  });

  it("a masked phone is indistinguishable from an absent one", () => {
    // The UI must not disclose WHICH of the two it is.
    expect(visibleCustomerPhone(cachedWithPhone, false)).toBe(
      visibleCustomerPhone({ phone: "", sensitiveVisible: true }, true),
    );
  });

  it("the sensitive band needs both the current grant and the server's answer", () => {
    expect(customerSensitiveVisible({ sensitiveVisible: true }, true)).toBe(true);
    // Grant revoked mid-session: the cached `true` is not enough.
    expect(customerSensitiveVisible({ sensitiveVisible: true }, false)).toBe(false);
    // Server said no: a client-side `true` is not enough either.
    expect(customerSensitiveVisible({ sensitiveVisible: false }, true)).toBe(false);
    // Nothing loaded yet: nothing is shown.
    expect(customerSensitiveVisible(undefined, false)).toBe(false);
  });

  it("a pending or errored capability state masks, because canSensitive is false there", () => {
    // canSensitive() is already fail-closed for pending/denied/stale (see
    // src/lib/capabilities.ts). This records what that means here: false in,
    // masked out — no separate code path to get wrong.
    expect(visibleCustomerPhone(cachedWithPhone, false)).toBe("");
    expect(customerSensitiveVisible(cachedWithPhone, false)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. Wiring — the helpers above are the ones the app actually calls
// ═══════════════════════════════════════════════════════════════════════════════

describe("F. the partitions are wired into the real routes", () => {
  it("/app enforces all five new principals from server-derived route context", () => {
    const source = readSource("src/routes/app.tsx");
    for (const call of [
      "enforceOrderCachePrincipal(queryClient, session.userId, organizationId)",
      "enforceConversationCachePrincipal(queryClient, session.userId, organizationId)",
      "enforceCustomerCachePrincipal(queryClient, session.userId, organizationId)",
      "enforceDeliveryCachePrincipal(queryClient, session.userId, organizationId)",
      "enforceTeamCachePrincipal(queryClient, session.userId, organizationId)",
    ]) {
      expect(source).toContain(call);
    }
    // Identity comes from beforeLoad's guard result, never from client input.
    expect(source).toContain("const { session, organizationId } = Route.useRouteContext()");
  });

  it("POS enforces the catalog principal and keys its products under it", () => {
    const source = stripComments(readSource("src/routes/app.pos.tsx"));
    expect(source).toContain(
      "enforceCatalogCachePrincipal(queryClient, userId, routeOrganizationId)",
    );
    expect(source).toContain('catalogKeys.uiProducts(userId, routeOrganizationId, "pos")');
    expect(source).not.toContain('["pos-products"]');
  });

  it("no /app route still uses a pre-phase bare key", () => {
    const leaky = [
      '["orders", "real"]',
      'queryKey: ["conversations"]',
      '["conversation-counts"]',
      'queryKey: ["customers"]',
      '["customer360"',
      '["customer-orders"',
      '["pos-products"]',
      '["pos-customers"',
      'queryKey: ["team"]',
      '["order-create"',
      '["conversation-smart-action-products"]',
      '["deliveries", "real"',
      '["delivery", "real"',
    ];
    const files = fs
      .readdirSync(path.resolve(ROOT, "src/routes"))
      .filter((f) => f.startsWith("app.") && f.endsWith(".tsx"))
      .map((f) => `src/routes/${f}`)
      .concat([
        "src/components/inbox/CustomerDetailSheet.tsx",
        "src/components/orders/CreateRealOrderSheet.tsx",
        "src/components/pos/PosCustomerSheet.tsx",
      ]);

    for (const file of files) {
      const source = stripComments(readSource(file));
      for (const bad of leaky) {
        expect({ file, contains: source.includes(bad) }).toEqual({ file, contains: false });
      }
    }
  });

  it("sign-out purges every tenant domain through its own helper before the blanket clear", () => {
    const source = readSource("src/routes/app.settings.tsx");
    const clearIdx = source.indexOf("queryClient.clear()");
    expect(clearIdx).toBeGreaterThan(-1);

    for (const call of [
      "clearHomeQueries(queryClient)",
      "clearCustomerQueries(queryClient)",
      "clearConversationQueries(queryClient)",
      "clearOrderQueries(queryClient)",
      "clearTeamQueries(queryClient)",
      "clearCatalogQueries(queryClient)",
    ]) {
      const idx = source.indexOf(call);
      expect({ call, found: idx > -1 }).toEqual({ call, found: true });
      // Each targeted purge cannot throw, so each runs before the backstop.
      expect({ call, beforeClear: idx < clearIdx }).toEqual({ call, beforeClear: true });
    }
  });

  it("Customer 360 gates its sensitive band on the CURRENT capability, not the cached payload", () => {
    const source = stripComments(readSource("src/routes/app.customers.$id.tsx"));
    expect(source).toContain("customerSensitiveVisible(");
    expect(source).toContain('capabilities.canSensitive("customers.view_sensitive")');
    // The pre-phase read: the cached flag alone.
    expect(source).not.toContain("query.data?.customer.sensitiveVisible !== false");
  });

  it("every migrated surface that shows a cached phone masks it on the current grant", () => {
    /*
     * The stale-capability class, everywhere it exists in the screens this
     * phase touched. Each of these renders a phone that came out of the React
     * Query cache, and each must route it through visibleCustomerPhone rather
     * than reading `customer.phone` directly — otherwise a grant revoked
     * mid-session keeps showing the number until something happens to refetch.
     */
    for (const file of [
      "src/components/inbox/CustomerDetailSheet.tsx",
      "src/components/pos/PosCustomerSheet.tsx",
      "src/components/orders/CreateRealOrderSheet.tsx",
    ]) {
      const source = stripComments(readSource(file));
      expect({ file, masks: source.includes("visibleCustomerPhone(") }).toEqual({
        file,
        masks: true,
      });
      expect({
        file,
        sensitive: source.includes('canSensitive("customers.view_sensitive")'),
      }).toEqual({ file, sensitive: true });
    }
  });

  it("the POS picker hands downstream screens an already-masked customer", () => {
    // The cart and checkout render the customer the merchant picked. Masking
    // at selection means they inherit it instead of each needing its own check.
    const source = stripComments(readSource("src/components/pos/PosCustomerSheet.tsx"));
    const resultsIdx = source.indexOf("visibleCustomerPhone(");
    const selectIdx = source.indexOf("onSelect(customer)");
    expect(resultsIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(resultsIdx);
  });

  it("the order-create picker masks BEFORE filtering, so search cannot probe a hidden number", () => {
    const source = stripComments(readSource("src/components/orders/CreateRealOrderSheet.tsx"));
    const maskIdx = source.indexOf("visibleCustomerPhone(");
    const filterIdx = source.indexOf("c.phone.replace(");
    expect(maskIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(maskIdx);
    // A blanked value is skipped rather than matched against an empty needle.
    expect(source).toContain('c.phone !== ""');
  });

  it("the Inbox thread and Customer 360 share one Customer partition", () => {
    // Two differently-keyed copies of the same profile would mean one purge
    // leaves the other readable.
    expect(readSource("src/routes/app.inbox.$id.tsx")).toContain("customerKeys.detail(");
    expect(readSource("src/routes/app.customers.$id.tsx")).toContain("customerKeys.detail(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G. Deliveries — the domain the first review round left unpartitioned
// ═══════════════════════════════════════════════════════════════════════════════

describe("G. the Delivery domain fails closed across principals", () => {
  /**
   * The sign-out that purges NOTHING.
   *
   * Settings' sign-out clears every root and then calls queryClient.clear(),
   * so it was never the interesting path. This one is: when a session expires
   * or is revoked, /app's `beforeLoad` throws a redirect (src/routes/app.tsx)
   * and no purge runs anywhere on that path. The router navigates client-side,
   * so the tab keeps the same QueryClient object — and the next member to sign
   * in mounts keys that, before this change, were character-for-character the
   * departed member's.
   *
   * Deliberately no clear() of any kind here. If isolation depends on one,
   * this test fails.
   */
  function guardRedirectSignOut(server: FakeServer) {
    server.signOut();
    // …and that is all. No clearDeliveryQueries, no queryClient.clear().
  }

  it("A's delivery list is unreadable to B after a guard-redirect sign-out", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    const aList = await client.fetchQuery({
      queryKey: deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[],
      queryFn: () => server.read("deliveries"),
    });
    expect(orgOf(aList)).toBe(ORG_A);
    expect(aList.rows[0]).toContain("VET-A-77123");

    guardRedirectSignOut(server);

    // B signs in through the same tab and the same QueryClient.
    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    const bKey = deliveryKeys.list(USER_B, ORG_B, null, null, null) as unknown[];
    // Nothing readable for B before any fetch: no COD amount, no tracking
    // number, no customer name from A.
    expect(client.getQueryData(bKey)).toBeUndefined();
    // And A's own entry is gone from the tab entirely, not merely unreachable.
    expect(
      client.getQueryData(deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[]),
    ).toBeUndefined();

    const bList = await client.fetchQuery({
      queryKey: bKey,
      queryFn: () => server.read("deliveries"),
    });
    expect(orgOf(bList)).toBe(ORG_B);
    expect(JSON.stringify(bList)).not.toContain("VET-A-77123");
    expect(JSON.stringify(bList)).not.toContain("Sok Dara");
  });

  it("a delivery DETAIL does not survive a guard-redirect sign-out either", async () => {
    // A UUID in the URL is not an identity: B opening the same delivery URL
    // must not be handed A's cached detail.
    const DELIVERY_ID = "dddddddd-0000-0000-0000-00000000000d";
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await client.fetchQuery({
      queryKey: deliveryKeys.detail(USER_A, ORG_A, DELIVERY_ID) as unknown[],
      queryFn: () => server.read("deliveries"),
    });

    guardRedirectSignOut(server);
    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    expect(
      client.getQueryData(deliveryKeys.detail(USER_B, ORG_B, DELIVERY_ID) as unknown[]),
    ).toBeUndefined();
    expect(
      client.getQueryData(deliveryKeys.detail(USER_A, ORG_A, DELIVERY_ID) as unknown[]),
    ).toBeUndefined();
  });

  it("two members of the SAME organization do not share a delivery entry", async () => {
    // delivery.read and the transition grants are per-member, so one member's
    // payload must never be read back for another in the same shop.
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await client.fetchQuery({
      queryKey: deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[],
      queryFn: () => server.read("deliveries"),
    });

    expect(deliveryKeys.list(USER_A, ORG_A, null, null, null)).not.toEqual(
      deliveryKeys.list(USER_B, ORG_A, null, null, null),
    );
    // The second member of the same org starts empty rather than inheriting.
    server.signIn(USER_B, ORG_A);
    mountAppLayout(client, USER_B, ORG_A);
    expect(
      client.getQueryData(deliveryKeys.list(USER_B, ORG_A, null, null, null) as unknown[]),
    ).toBeUndefined();
  });

  it("the same user switching organization is treated as a new delivery principal", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    await client.fetchQuery({
      queryKey: deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[],
      queryFn: () => server.read("deliveries"),
    });

    server.signIn(USER_A, ORG_B);
    mountAppLayout(client, USER_A, ORG_B);

    expect(
      client.getQueryData(deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[]),
    ).toBeUndefined();
    const after = await client.fetchQuery({
      queryKey: deliveryKeys.list(USER_A, ORG_B, null, null, null) as unknown[],
      queryFn: () => server.read("deliveries"),
    });
    expect(orgOf(after)).toBe(ORG_B);
  });

  it("a delivery fetch already in flight for A cannot resolve into B's key", async () => {
    const client = new QueryClient();
    const server = createFakeServer();
    let release!: (value: TenantPayload) => void;
    const pending = new Promise<TenantPayload>((resolve) => {
      release = resolve;
    });

    server.signIn(USER_A, ORG_A);
    mountAppLayout(client, USER_A, ORG_A);
    const inFlight = client.fetchQuery({
      queryKey: deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[],
      queryFn: () => pending,
    });

    // The principal changes while A's request is still open.
    server.signIn(USER_B, ORG_B);
    mountAppLayout(client, USER_B, ORG_B);

    release({ org: ORG_A, rows: ["Sok Dara APSA-0001 COD $42.00 VET-A-77123"] });
    await inFlight.catch(() => undefined);

    // Whatever became of A's entry, B's key is untouched by it.
    expect(
      client.getQueryData(deliveryKeys.list(USER_B, ORG_B, null, null, null) as unknown[]),
    ).toBeUndefined();
  });

  it("a delivery transition invalidates only the acting principal's lists", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, ORG_A);
    const aKey = deliveryKeys.list(USER_A, ORG_A, null, null, null) as unknown[];
    await client.fetchQuery({ queryKey: aKey, queryFn: () => server.read("deliveries") });

    server.signIn(USER_B, ORG_B);
    const bKey = deliveryKeys.list(USER_B, ORG_B, null, null, null) as unknown[];
    await client.fetchQuery({ queryKey: bKey, queryFn: () => server.read("deliveries") });

    // What app.deliveries.$id.tsx does after a successful transition.
    await client.invalidateQueries({ queryKey: deliveryKeys.lists(USER_A, ORG_A) as unknown[] });

    expect(client.getQueryState(aKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(bKey)?.isInvalidated).toBe(false);
  });

  it("every filtered delivery list sits under the principal, so one call covers them all", () => {
    const principal = deliveryKeys.principal(USER_A, ORG_A);
    for (const key of [
      deliveryKeys.list(USER_A, ORG_A, "active", null, null),
      deliveryKeys.list(USER_A, ORG_A, null, "pending", "APSA-0001"),
      deliveryKeys.lists(USER_A, ORG_A),
      deliveryKeys.detail(USER_A, ORG_A, "dddddddd-0000-0000-0000-00000000000d"),
    ]) {
      expect(key.slice(0, principal.length)).toEqual([...principal]);
    }
    // The filters still discriminate, behind the principal.
    expect(deliveryKeys.list(USER_A, ORG_A, "active", null, null)).not.toEqual(
      deliveryKeys.list(USER_A, ORG_A, "completed", null, null),
    );
  });

  it("the Delivery screens are wired to the partition, and to the Orders one for cross-reference", () => {
    const list = stripComments(readSource("src/routes/app.deliveries.tsx"));
    expect(list).toContain("deliveryKeys.list(");
    expect(list).toContain("const { session, organizationId: routeOrganizationId }");

    const detail = stripComments(readSource("src/routes/app.deliveries.$id.tsx"));
    expect(detail).toContain("deliveryKeys.detail(userId, routeOrganizationId, id)");
    expect(detail).toContain("deliveryKeys.lists(userId, routeOrganizationId)");
    // The Orders cross-reference fixed earlier in this PR must stay partitioned.
    expect(detail).toContain("ordersKeys.detail(userId, routeOrganizationId");

    // And sign-out purges the new root like the others.
    expect(readSource("src/routes/app.settings.tsx")).toContain(
      "clearDeliveryQueries(queryClient)",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H. Customer 360 must not claim a customer has no orders
// ═══════════════════════════════════════════════════════════════════════════════

describe("H. Customer 360 order history is honest", () => {
  const source = () => stripComments(readSource("src/routes/app.customers.$id.tsx"));

  it("reads the real Order domain instead of the server's structural empty array", () => {
    const src = source();
    // The same production read CustomerDetailSheet uses — no parallel backend.
    expect(src).toContain("getCustomerOrders(id)");
    expect(src).toContain("customerKeys.orders(userId, routeOrganizationId, id)");
    // getCustomer360()'s own `orders` may still feed the mock branch, but it is
    // no longer what a real customer's tab renders.
    expect(src).toContain("isRealCustomer ? (ordersQuery.data ?? []) : query.data!.orders");
  });

  it("gates the history on the capability listOrders already requires", () => {
    const src = source();
    expect(src).toContain('capabilities.can("orders.read")');
    expect(src).toContain("enabled: isRealCustomer && canReadOrders");
  });

  it('"No orders yet" is unreachable until the real query has actually succeeded', () => {
    /*
     * Branch ORDER is the property under test, not merely branch presence.
     * "No orders yet" is an affirmative claim about this customer, so every
     * state in which the screen does not KNOW — never asked, still loading,
     * failed — has to be handled before it.
     */
    const src = source();
    const unavailable = src.indexOf("ordersUnavailable ? (");
    const pending = src.indexOf("isRealCustomer && ordersQuery.isPending");
    const errored = src.indexOf("isRealCustomer && ordersQuery.isError");
    const empty = src.indexOf('t("customer360.noOrders")');

    for (const idx of [unavailable, pending, errored, empty]) expect(idx).toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(empty);
    expect(pending).toBeLessThan(empty);
    expect(errored).toBeLessThan(empty);
  });

  it("an unauthorized or failed history says so, in both languages", () => {
    const src = source();
    expect(src).toContain('t("customer360.ordersUnavailable")');
    expect(src).toContain('t("customer360.ordersError")');

    for (const locale of ["src/locales/en.json", "src/locales/km.json"]) {
      const json = JSON.parse(readSource(locale)) as {
        customer360: Record<string, string>;
      };
      for (const key of [
        "ordersUnavailable",
        "ordersUnavailableBody",
        "ordersError",
        "ordersErrorBody",
      ]) {
        expect({ locale, key, present: typeof json.customer360[key] === "string" }).toEqual({
          locale,
          key,
          present: true,
        });
        expect(json.customer360[key]!.length).toBeGreaterThan(0);
      }
    }
  });

  it("placeholder lifetime metrics are withheld rather than printed as zero", () => {
    /*
     * getCustomer360() hardcodes orderCount: 0 and lifetimeSpend: 0 for every
     * production customer. "Orders 0" and "Spend $0.00" above a non-empty
     * order list is the same false claim in a different place — and the values
     * are not derivable here either, because the history is capped at one
     * page. So they are withheld, not guessed.
     */
    const src = source();
    expect(src).toContain("const metricsAuthoritative = !isRealCustomer");
    expect(src).toContain("metricsAuthoritative ? customer.orderCount");
    expect(src).toContain("!metricsAuthoritative");
    // No client-side reconstruction of a lifetime total from the loaded page.
    expect(src).not.toContain("orders.reduce(");
  });

  it("the history rides under this customer's own partition, so one purge takes it", () => {
    const principal = customerKeys.principal(USER_A, ORG_A);
    const detail = customerKeys.detail(USER_A, ORG_A, "cus-uuid");
    const history = customerKeys.orders(USER_A, ORG_A, "cus-uuid");
    expect(history.slice(0, principal.length)).toEqual([...principal]);
    expect(history.slice(0, detail.length)).toEqual([...detail]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I. POS phone search must fail closed, not just mask
// ═══════════════════════════════════════════════════════════════════════════════

describe("I. a hidden phone is not searchable", () => {
  /**
   * A stand-in for the POS picker's read, built from the same two rules the
   * real searchCustomers() now follows: mask every phone through
   * visibleCustomerPhone FIRST, then never run the phone predicate on a
   * blanked value.
   */
  interface Row {
    id: string;
    nameEn: string;
    nameKm: string;
    phone: string;
    sensitiveVisible: boolean;
  }
  const ROWS: Row[] = [
    {
      id: "c1",
      nameEn: "Sok Dara",
      nameKm: "សុខ ដារា",
      phone: "012345678",
      sensitiveVisible: true,
    },
    {
      id: "c2",
      nameEn: "Chan Nita",
      nameKm: "ចាន់ នីតា",
      phone: "098765432",
      sensitiveVisible: true,
    },
  ];

  function search(term: string, canViewSensitive: boolean): Row[] {
    const q = term.trim().toLowerCase();
    const digits = q.replace(/\s/g, "");
    const masked = ROWS.map((r) => ({ ...r, phone: visibleCustomerPhone(r, canViewSensitive) }));
    if (!q) return masked.slice(0, 4);
    return masked.filter(
      (c) =>
        c.nameKm.toLowerCase().includes(q) ||
        c.nameEn.toLowerCase().includes(q) ||
        (c.phone !== "" && c.phone.replace(/\s/g, "").includes(digits)),
    );
  }

  it("an authorized member finds a customer by phone, and sees the number", () => {
    const found = search("012345678", true);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("c1");
    expect(found[0]!.phone).toBe("012345678");
  });

  it("once the grant is gone the same phone query matches nothing at all", () => {
    /*
     * Not "matches but hides the number" — MATCHES NOTHING. Result membership
     * is itself the disclosure: a set that still came back for a typed
     * fragment answers "does a customer with this number exist here?" however
     * thoroughly the digits are blanked on screen.
     */
    const found = search("012345678", false);
    expect(found).toHaveLength(0);
    expect(JSON.stringify(found)).not.toContain("Sok Dara");
  });

  it("a stale capability snapshot behaves exactly like a revoked one", () => {
    // canSensitive is `confirmed && can`, so an unconfirmed snapshot is false.
    expect(search("012345678", false)).toHaveLength(0);
  });

  it("name search still works without the grant, and never exposes a number", () => {
    const found = search("Sok", false);
    expect(found).toHaveLength(1);
    expect(found[0]!.phone).toBe("");
  });

  it("a blanked phone is not matched against an empty needle", () => {
    // Without the `phone !== ""` guard, "".includes("") is true and every row
    // would match every query.
    const found = search("zzz", false);
    expect(found).toHaveLength(0);
  });

  it("the real searchCustomers masks before it filters, on both its paths", () => {
    const src = stripComments(readSource("src/lib/api/index.ts"));
    const fnIdx = src.indexOf("export async function searchCustomers");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = src.slice(fnIdx, fnIdx + 1600);
    // The grant is a required parameter, so a new caller must state an answer.
    expect(body).toContain("canViewSensitive: boolean");
    const maskIdx = body.indexOf("visibleCustomerPhone(c, canViewSensitive)");
    const predicateIdx = body.indexOf("c.phone.replace(");
    expect(maskIdx).toBeGreaterThan(-1);
    expect(predicateIdx).toBeGreaterThan(maskIdx);
    expect(body).toContain('c.phone !== ""');
    // The demo-mode fallback path is masked too, not just the production one.
    expect(body).toContain("customers.map(mask)");
  });

  it("the POS picker passes the current grant to the read AND into the cache key", () => {
    const src = stripComments(readSource("src/components/pos/PosCustomerSheet.tsx"));
    expect(src).toContain('capabilities.canSensitive("customers.view_sensitive")');
    expect(src).toContain("searchCustomers(query, canSensitive)");
    // Without the grant in the key, the grant-era result set is served straight
    // back for the same term after revocation.
    expect(src).toContain("customerKeys.search(userId, organizationId, query, canSensitive)");
  });

  it("an authorized and an unauthorized search of the same term are different cache entries", () => {
    expect(customerKeys.search(USER_A, ORG_A, "012345678", true)).not.toEqual(
      customerKeys.search(USER_A, ORG_A, "012345678", false),
    );
  });
});
