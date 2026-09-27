/**
 * A successful delivery transition must refresh the ORDERS list.
 *
 * Delivery status and order fulfillment are the same axis seen from two
 * screens. The Orders list renders `order.fulfillmentStatus` on every row
 * (src/routes/app.orders.tsx) and the bottom nav derives its order count from
 * the same cache entry (src/design-system/BottomNav.tsx). A transition used to
 * refresh this delivery's detail, the delivery lists, the order's own detail and
 * Home — but not the Orders list, so a merchant who marked a parcel delivered
 * and went back to Orders was shown the previous fulfillment state.
 *
 * These tests assert the real invalidation contract:
 *
 *   A. the key SET, compared by value against the keys the Orders, Deliveries
 *      and Home screens actually read — not a substring of the call site;
 *   B. the EFFECT, by invalidating a real QueryClient and reading back which
 *      entries were marked stale;
 *   C. tenant scope, by proving a second principal's entries are untouched;
 *   D. that the Delivery screen delegates to this one contract.
 *
 * Run: bun test src/tests/delivery-orders-invalidation.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { QueryClient } from "@tanstack/react-query";

import { deliveryKeys, deliveryTransitionInvalidationKeys } from "@/lib/deliveries-query";
import { HOME_QUERY_PREFIX, homeQueryKey } from "@/lib/home-query";
import { ordersKeys } from "@/lib/orders-query";

const repoRoot = path.resolve(import.meta.dir, "../..");
const code = (relative: string) =>
  fs
    .readFileSync(path.join(repoRoot, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const USER_A = "11111111-1111-1111-1111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "22222222-2222-2222-2222-222222222222";
const ORG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORDER_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const keysFor = (user: string, org: string, orderId: string | null = ORDER_ID) =>
  deliveryTransitionInvalidationKeys(user, org, orderId) as readonly unknown[][];

/** Invalidate exactly what the contract names, as the route's loop does. */
async function applyContract(client: QueryClient, user: string, org: string, orderId = ORDER_ID) {
  for (const queryKey of keysFor(user, org, orderId)) {
    await client.invalidateQueries({ queryKey: queryKey as unknown[] });
  }
}

const isStale = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key as unknown[])?.isInvalidated ?? null;

// ── A. The key set, by value ───────────────────────────────────────────────────

describe("A. the contract names every screen a transition makes stale", () => {
  it("includes the Orders list key the Orders screen and bottom nav read", () => {
    // The regression this file exists for. Compared by value against
    // ordersKeys.list, so renaming or re-shaping that key cannot silently
    // decouple the two.
    expect(keysFor(USER_A, ORG_A)).toContainEqual([...ordersKeys.list(USER_A, ORG_A)]);
  });

  it("includes the order's own detail, the delivery lists and Home", () => {
    const keys = keysFor(USER_A, ORG_A);
    expect(keys).toContainEqual([...ordersKeys.detail(USER_A, ORG_A, ORDER_ID)]);
    expect(keys).toContainEqual([...deliveryKeys.lists(USER_A, ORG_A)]);
    expect(keys).toContainEqual([...HOME_QUERY_PREFIX]);
  });

  it("names nothing else — no blanket root, no bare legacy shapes", () => {
    const keys = keysFor(USER_A, ORG_A);
    expect(keys).toHaveLength(4);
    // The pre-partition shapes no screen reads any more, and the roots that
    // would reach other principals' entries in the same tab.
    for (const forbidden of [
      ["orders"],
      ["orders", "real"],
      ["deliveries"],
      ["deliveries", "real"],
      ["delivery", "real", ORDER_ID],
    ]) {
      expect(keys).not.toContainEqual(forbidden);
    }
  });

  it("falls back to the screen's own sentinel before the order id is known", () => {
    // The Delivery screen reads ordersKeys.detail(..., "none") while its own
    // detail is still loading; invalidating the same sentinel is consistent and
    // can never name a real order belonging to someone else.
    const keys = keysFor(USER_A, ORG_A, null);
    expect(keys).toContainEqual([...ordersKeys.detail(USER_A, ORG_A, "none")]);
    expect(keys).toContainEqual([...ordersKeys.list(USER_A, ORG_A)]);
  });
});

// ── B. The effect on a real cache ─────────────────────────────────────────────

describe("B. applying the contract actually refreshes the Orders list", () => {
  it("marks the Orders list stale, not only the order's detail", async () => {
    const client = new QueryClient();
    const listKey = ordersKeys.list(USER_A, ORG_A);
    const detailKey = ordersKeys.detail(USER_A, ORG_A, ORDER_ID);

    client.setQueryData(listKey as unknown[], [{ id: ORDER_ID, fulfillmentStatus: "in_transit" }]);
    client.setQueryData(detailKey as unknown[], { id: ORDER_ID });
    expect(isStale(client, listKey)).toBe(false);

    await applyContract(client, USER_A, ORG_A);

    expect(isStale(client, listKey)).toBe(true);
    expect(isStale(client, detailKey)).toBe(true);
  });

  it("marks the delivery lists and Home stale too", async () => {
    const client = new QueryClient();
    const deliveryList = deliveryKeys.list(USER_A, ORG_A, "active", null, null);
    const home = homeQueryKey(USER_A, ORG_A, "today");

    client.setQueryData(deliveryList as unknown[], []);
    client.setQueryData(home as unknown[], { range: "today" });

    await applyContract(client, USER_A, ORG_A);

    // deliveryKeys.lists is the prefix of every filtered list, so a filtered
    // entry is reached without the contract naming its filters.
    expect(isStale(client, deliveryList)).toBe(true);
    expect(isStale(client, home)).toBe(true);
  });
});

// ── C. Tenant scope ──────────────────────────────────────────────────────────

describe("C. invalidation stays inside the acting principal", () => {
  it("leaves another user's and another organization's Orders list alone", async () => {
    const client = new QueryClient();
    const mine = ordersKeys.list(USER_A, ORG_A);
    const otherUserSameOrg = ordersKeys.list(USER_B, ORG_A);
    const sameUserOtherOrg = ordersKeys.list(USER_A, ORG_B);
    const otherEntirely = ordersKeys.list(USER_B, ORG_B);

    for (const key of [mine, otherUserSameOrg, sameUserOtherOrg, otherEntirely]) {
      client.setQueryData(key as unknown[], []);
    }

    await applyContract(client, USER_A, ORG_A);

    expect(isStale(client, mine)).toBe(true);
    expect(isStale(client, otherUserSameOrg)).toBe(false);
    expect(isStale(client, sameUserOtherOrg)).toBe(false);
    expect(isStale(client, otherEntirely)).toBe(false);
  });

  it("leaves another principal's delivery lists alone", async () => {
    const client = new QueryClient();
    const mine = deliveryKeys.lists(USER_A, ORG_A);
    const theirs = deliveryKeys.lists(USER_B, ORG_B);
    client.setQueryData(mine as unknown[], []);
    client.setQueryData(theirs as unknown[], []);

    await applyContract(client, USER_A, ORG_A);

    expect(isStale(client, mine)).toBe(true);
    expect(isStale(client, theirs)).toBe(false);
  });

  it("every key but Home carries the principal", () => {
    for (const key of keysFor(USER_A, ORG_A)) {
      if (JSON.stringify(key) === JSON.stringify([...HOME_QUERY_PREFIX])) continue;
      expect(key).toContain(USER_A);
      expect(key).toContain(ORG_A);
    }
    /*
     * Home is the one unpartitioned entry, and that is pre-existing reviewed
     * behaviour: its own partition is enforced at the /app layout by
     * enforceHomeCachePrincipal, which DROPS the root when the principal
     * changes rather than leaving it to be invalidated.
     */
    expect([...HOME_QUERY_PREFIX]).not.toContain(USER_A);
  });
});

// ── D. The call site uses this contract ──────────────────────────────────────

describe("D. the Delivery screen delegates to the audited contract", () => {
  const detail = code("src/routes/app.deliveries.$id.tsx");

  it("calls deliveryTransitionInvalidationKeys on a successful transition", () => {
    const body = detail.slice(detail.indexOf("function onTransitionSuccess("));
    const fn = body.slice(0, body.indexOf("\n  }\n"));
    expect(fn).toContain("deliveryTransitionInvalidationKeys(");
    // A blanket clear would drop other principals' entries and is reserved for
    // sign-out.
    expect(fn).not.toContain("queryClient.clear()");
  });

  it("keeps the fresh detail written straight into the cache", () => {
    // Preserved from PR #75: the transition response is the newest truth for
    // this delivery, so it is written rather than refetched.
    expect(detail).toContain("queryClient.setQueryData(queryKey, detail)");
  });

  it("does not re-derive its own invalidation list beside the contract", () => {
    const body = detail.slice(detail.indexOf("function onTransitionSuccess("));
    const fn = body.slice(0, body.indexOf("\n  }\n"));
    // One source of truth: a second hand-written invalidate here is how the
    // Orders-list entry went missing in the first place.
    expect(fn).not.toContain("HOME_QUERY_PREFIX");
    expect(fn).not.toContain("deliveryKeys.lists(");
  });
});
