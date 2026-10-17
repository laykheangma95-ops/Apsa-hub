/**
 * Capability confirmation provenance (src/lib/capability-confirmation.ts):
 * a positive answer is dated by when its REQUEST left, on two clocks, and the
 * date lives on the exact snapshot it produced.
 *
 * The mounted behaviour on Home is in home-access-mounted.runtime.ts.
 */
import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  capabilityConfirmation,
  capabilityRequestInFlight,
  confirmationAgeMs,
  isConfirmationFresh,
  isWithinCapabilityTenure,
  markCapabilityPrincipal,
  principalConfirmation,
  shareStampedCapabilityResult,
  stampedCapabilityQueryFn,
  type ConfirmationInstant,
} from "@/lib/capability-confirmation";
import type { CapabilityResult } from "@/lib/capabilities";
import { SENSITIVE_CAPABILITY_MAX_AGE_MS } from "@/hooks/use-capabilities";

const at = (wall: number, mono = wall): ConfirmationInstant => ({ wall, mono });

const active = (userId = "u1", organizationId = "o1"): CapabilityResult => ({
  status: "active",
  userId,
  organizationId,
  role: null,
  permissions: ["orders.read", "payments.reconcile"],
});

describe("confirmation age", () => {
  const fresh = (from: ConfirmationInstant, now: ConfirmationInstant) =>
    isConfirmationFresh(from, now, SENSITIVE_CAPABILITY_MAX_AGE_MS);

  it("is fresh up to 29,999ms after dispatch and never from 30,000ms", () => {
    const t = 1_000_000;
    expect(fresh(at(t), at(t))).toBe(true);
    expect(fresh(at(t), at(t + 29_999))).toBe(true);
    expect(fresh(at(t), at(t + 30_000))).toBe(false);
    expect(fresh(at(t), at(t + 30_001))).toBe(false);
  });

  it("takes the larger of the two clocks", () => {
    // Wall clock set back 20s: the monotonic clock still says 29.999s.
    expect(confirmationAgeMs(at(100_000, 0), at(109_999, 29_999))).toBe(29_999);
    expect(fresh(at(100_000, 0), at(110_000, 30_000))).toBe(false);
    // Monotonic clock paused while the device slept: the wall clock says 31s.
    expect(confirmationAgeMs(at(100_000, 500), at(131_000, 600))).toBe(31_000);
    expect(fresh(at(100_000, 500), at(131_000, 600))).toBe(false);
  });

  it("does not trust a clock that reads earlier than the confirmation", () => {
    expect(confirmationAgeMs(at(100_000, 50), at(99_999, 60))).toBe(Number.POSITIVE_INFINITY);
    expect(confirmationAgeMs(at(100_000, 50), at(100_010, 49))).toBe(Number.POSITIVE_INFINITY);
    expect(fresh(at(100_000), at(99_999))).toBe(false);
    expect(confirmationAgeMs(at(Number.NaN), at(100))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("stamped capability queryFn", () => {
  it("stamps the answer with the instant its request LEFT, not when it arrived", async () => {
    const client = new QueryClient();
    let release!: () => void;
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return active();
    });
    const before = Date.now();
    const pending = fn();
    const inFlight = capabilityRequestInFlight(client, "u1", "o1");
    expect(inFlight).toBeDefined();
    expect(inFlight!.wall).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const result = await pending;
    expect(capabilityConfirmation(result)).toBe(inFlight!);
    expect(capabilityConfirmation(result)!.wall).toBeLessThan(Date.now() - 20);
    // Settled: nothing in flight any more.
    expect(capabilityRequestInFlight(client, "u1", "o1")).toBeUndefined();
  });

  it("gives every request its own object, so one stamp can never be overwritten by another", async () => {
    const client = new QueryClient();
    const shared = active();
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => shared);
    const first = await fn();
    const second = await fn();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(capabilityConfirmation(shared)).toBeUndefined();
    expect(capabilityConfirmation(first)).not.toBe(capabilityConfirmation(second));
  });

  it("a failed request stamps nothing and leaves nothing in flight", async () => {
    const client = new QueryClient();
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => {
      throw new Error("network");
    });
    await expect(fn()).rejects.toThrow("network");
    expect(capabilityRequestInFlight(client, "u1", "o1")).toBeUndefined();
  });

  it("an unstamped value (a seed, setQueryData) has no confirmation", () => {
    expect(capabilityConfirmation(active())).toBeUndefined();
    expect(capabilityConfirmation(undefined)).toBeUndefined();
    expect(capabilityConfirmation("active")).toBeUndefined();
  });
});

describe("structural sharing keeps the stamp with the data", () => {
  it("an identical answer keeps the old reference and takes the NEW stamp", async () => {
    const client = new QueryClient();
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => active());
    const previous = await fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await fn();
    const shared = shareStampedCapabilityResult(previous, next);
    expect(shared).toBe(previous);
    expect(capabilityConfirmation(shared)).toBe(capabilityConfirmation(next));
  });

  it("an unstamped write over stamped data clears the stamp", async () => {
    const client = new QueryClient();
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => active());
    const previous = await fn();
    const shared = shareStampedCapabilityResult(previous, active());
    expect(shared).toBe(previous);
    expect(capabilityConfirmation(shared)).toBeUndefined();
  });

  it("only the request React Query accepts dates the cache; a cancelled one never does", async () => {
    const client = new QueryClient();
    const key = ["capabilities", "u1", "o1"];
    const releases: (() => void)[] = [];
    const queryFn = stampedCapabilityQueryFn(client, "u1", "o1", async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return active();
    });
    const options = { queryKey: key, queryFn, structuralSharing: shareStampedCapabilityResult };
    // Held data (a seed): React Query only cancels a refetch over existing data.
    client.setQueryData(key, active());
    const older = client.fetchQuery(options).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const olderDispatch = capabilityRequestInFlight(client, "u1", "o1")!;
    // Superseded: cancelled and replaced by a newer request.
    const newer = client.refetchQueries({ queryKey: key }, { cancelRefetch: true });
    const newerDispatch = capabilityRequestInFlight(client, "u1", "o1")!;
    expect(newerDispatch).not.toBe(olderDispatch);
    // Newest answers first, then the cancelled one.
    releases[1]!();
    await newer;
    releases[0]!();
    await older;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(capabilityConfirmation(client.getQueryData(key))).toBe(newerDispatch);
  });
});

describe("tenure", () => {
  it("a stamp counts only for the principal whose tenure it left in", async () => {
    const client = new QueryClient();
    markCapabilityPrincipal(client, "u1", "o1");
    const fn = stampedCapabilityQueryFn(client, "u1", "o1", async () => active());
    const a = await fn();
    expect(principalConfirmation(client, "u1", "o1", a)).toBe(capabilityConfirmation(a));
    // Another principal never sees it.
    expect(principalConfirmation(client, "u2", "o1", a)).toBeUndefined();

    // A → B → A: the earlier stamp belongs to A's previous tenure.
    await new Promise((resolve) => setTimeout(resolve, 2));
    markCapabilityPrincipal(client, "u1", "o2");
    await new Promise((resolve) => setTimeout(resolve, 2));
    markCapabilityPrincipal(client, "u1", "o1");
    expect(principalConfirmation(client, "u1", "o1", a)).toBeUndefined();
    expect(isWithinCapabilityTenure(client, "u1", "o1", capabilityConfirmation(a)!)).toBe(false);

    // A request made during the new tenure counts again.
    const again = await fn();
    expect(principalConfirmation(client, "u1", "o1", again)).toBe(capabilityConfirmation(again));
  });

  it("re-marking the same principal does not restart its tenure", async () => {
    const client = new QueryClient();
    markCapabilityPrincipal(client, "u1", "o1");
    const a = await stampedCapabilityQueryFn(client, "u1", "o1", async () => active())();
    await new Promise((resolve) => setTimeout(resolve, 2));
    markCapabilityPrincipal(client, "u1", "o1");
    expect(principalConfirmation(client, "u1", "o1", a)).toBeDefined();
  });

  it("without a tenure nothing counts", async () => {
    const client = new QueryClient();
    const a = await stampedCapabilityQueryFn(client, "u1", "o1", async () => active())();
    expect(principalConfirmation(client, "u1", "o1", a)).toBeUndefined();
  });
});
