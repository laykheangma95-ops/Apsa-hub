/**
 * Capability cache and tenant isolation.
 *
 * The failure this guards against is concrete: user A signs out on a shared
 * phone, user B signs in, and for one frame B sees A's actions — or A's org.
 * Two things prevent it, and both are tested here against a real QueryClient:
 *
 *   1. the cache key is partitioned by user AND organization, so B's read can
 *      never hit A's entry;
 *   2. the view refuses any snapshot that does not describe the identity it
 *      was asked about, so even a snapshot that somehow survived grants nothing.
 *
 * Run: bun test src/tests/capability-cache-isolation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  capabilityQueryKey,
  CAPABILITY_QUERY_ROOT,
  createCapabilityView,
  type CapabilityResult,
} from "@/lib/capabilities";

const OWNER_A: CapabilityResult = {
  status: "active",
  userId: "user-a",
  organizationId: "org-a",
  role: "OWNER",
  permissions: [
    "orders.read",
    "payments.refund",
    "team.read",
    "team.invite",
    "customers.view_sensitive",
  ],
};

const CASHIER_B: CapabilityResult = {
  status: "active",
  userId: "user-b",
  organizationId: "org-b",
  role: "CASHIER",
  permissions: ["orders.read", "orders.create"],
};

function viewOf(result: CapabilityResult | undefined, userId: string, organizationId: string) {
  return createCapabilityView({
    result,
    isPending: false,
    isError: false,
    expectedUserId: userId,
    expectedOrganizationId: organizationId,
  });
}

describe("capability cache is partitioned per user and organization", () => {
  it("user B's key never reads user A's cached snapshot", () => {
    const client = new QueryClient();
    client.setQueryData(capabilityQueryKey("user-a", "org-a"), OWNER_A);

    const leaked = client.getQueryData(capabilityQueryKey("user-b", "org-b"));
    expect(leaked).toBeUndefined();

    // With no data of its own, B's view grants nothing rather than inheriting.
    const view = viewOf(leaked as CapabilityResult | undefined, "user-b", "org-b");
    expect(view.state).toBe("denied");
    expect(view.can("payments.refund")).toBe(false);
    expect(view.can("team.invite")).toBe(false);
  });

  it("the same user in a different organization gets a separate cache entry", () => {
    const client = new QueryClient();
    client.setQueryData(capabilityQueryKey("user-a", "org-a"), OWNER_A);
    expect(client.getQueryData(capabilityQueryKey("user-a", "org-b"))).toBeUndefined();
  });

  it("queryClient.clear() — the sign-out path — drops the capability snapshot", () => {
    const client = new QueryClient();
    client.setQueryData(capabilityQueryKey("user-a", "org-a"), OWNER_A);
    expect(client.getQueryData(capabilityQueryKey("user-a", "org-a"))).toEqual(OWNER_A);

    client.clear();

    expect(client.getQueryData(capabilityQueryKey("user-a", "org-a"))).toBeUndefined();
    expect(client.getQueryCache().findAll({ queryKey: [CAPABILITY_QUERY_ROOT] })).toHaveLength(0);
  });

  it("a snapshot that outlived its session still grants nothing to the next member", () => {
    // Worst case: the cache clear failed and A's snapshot is somehow still there
    // when B renders. The identity check in the view is the second lock.
    const stale = viewOf(OWNER_A, "user-b", "org-b");
    expect(stale.state).toBe("denied");
    expect(stale.organizationId).toBeNull();
    expect(stale.role).toBeNull();
    expect(stale.can("orders.read")).toBe(false);
  });

  it("switching organization on the same account does not carry the old org's access over", () => {
    const inOrgA = viewOf(OWNER_A, "user-a", "org-a");
    expect(inOrgA.can("team.invite")).toBe(true);

    // Same user, now resolved into a different organization: the org-a snapshot
    // is not honoured for org-b.
    const inOrgB = viewOf(OWNER_A, "user-a", "org-b");
    expect(inOrgB.can("team.invite")).toBe(false);
    expect(inOrgB.state).toBe("denied");
  });

  it("a member downgraded between sessions loses the removed actions immediately", () => {
    const asOwner = viewOf(OWNER_A, "user-a", "org-a");
    expect(asOwner.can("payments.refund")).toBe(true);

    const downgraded: CapabilityResult = {
      ...OWNER_A,
      role: "CASHIER",
      permissions: ["orders.read"],
    };
    const afterRefetch = viewOf(downgraded, "user-a", "org-a");
    expect(afterRefetch.can("payments.refund")).toBe(false);
    expect(afterRefetch.can("orders.read")).toBe(true);
  });

  it("a revoked membership fails closed rather than keeping the last good snapshot", () => {
    const revoked = viewOf({ status: "no_membership" }, "user-b", "org-b");
    expect(revoked.state).toBe("denied");
    expect(revoked.can("orders.read")).toBe(false);
    expect(CASHIER_B.status).toBe("active"); // sanity: fixture unchanged
  });
});
