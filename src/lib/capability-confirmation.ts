import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import type { CapabilityResult } from "@/lib/capabilities";

/**
 * When the server last confirmed a member's capabilities — measured from the
 * request, not the response.
 *
 * The server checks permission while it handles a request, which is after the
 * browser sent it and before the answer arrives. So a successful answer
 * proves access only as of (at the latest) the moment its request left. Using
 * the arrival time instead (React Query's dataUpdatedAt) would let a slow
 * answer that the server granted before a revocation buy the full freshness
 * window again from whenever it happens to land.
 *
 * Server-issued timestamps are deliberately not used: nothing makes the
 * server's clock and this browser's comparable, and a skewed server clock
 * would silently stretch or shrink the window. The dispatch instant needs no
 * synchronization and is never later than the server's check.
 *
 * Every successful answer is stamped with the instant its request was
 * dispatched. The stamp lives on the exact result object that became the
 * query's data (structural sharing carries it over when a refresh returns an
 * identical answer), so:
 *
 * - a cancelled, superseded or failed request never stamps the cached data —
 *   React Query never makes its result the data;
 * - a snapshot that did not come from a stamped request (an SSR / loader seed,
 *   setQueryData) has no stamp, and is never "fresh";
 * - a stamp cannot outlive its data or move to another principal's query.
 *
 * The bound this gives a sensitive display (SENSITIVE_CAPABILITY_MAX_AGE_MS,
 * 30s): let R be the moment the server starts refusing (a revocation, an
 * expired session). Every positive answer came from a server check at S < R,
 * for a request dispatched at D ≤ S. A value is drawn only while D is less
 * than 30s old, so no frame drawn at or after D + 30s — and so none from
 * R + 30s on — shows it, and the same render evicts it from the cache.
 * Assumptions: the page's main thread is free to run the deadline timer (a
 * long task delays every render, so the last frame stays up until it ends);
 * background timers may be throttled, but a page shown again re-checks
 * synchronously first; and the device's two clocks are not both wound back —
 * which only the device's own user could do, and that user can read the page
 * anyway: the browser is not a trust boundary. The server authorizes every
 * read itself, so nothing new is ever served after R. This is a bound on how
 * long an answer already received stays usable, not instant detection: the
 * browser learns of a revocation only when the server reports it.
 */
export interface ConfirmationInstant {
  /** Date.now() — keeps advancing while the device sleeps. */
  readonly wall: number;
  /** performance.now() — monotonic: immune to clock changes. */
  readonly mono: number;
}

export function readConfirmationClock(): ConfirmationInstant {
  const wall = Date.now();
  let mono = wall;
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      mono = performance.now();
    }
  } catch {
    // No monotonic clock: the wall clock alone decides.
  }
  return { wall, mono };
}

/**
 * Time elapsed from `at` to `now`, read conservatively: the LARGER of the two
 * clocks. The monotonic clock catches a wall clock set backwards; the wall
 * clock catches a monotonic clock that some browsers pause while the device
 * sleeps. A clock that reads earlier than `at` is not trusted at all (∞).
 */
export function confirmationAgeMs(at: ConfirmationInstant, now: ConfirmationInstant): number {
  const wall = now.wall - at.wall;
  const mono = now.mono - at.mono;
  if (!(wall >= 0) || !(mono >= 0)) return Number.POSITIVE_INFINITY;
  return Math.max(wall, mono);
}

/** Whether a confirmation at `at` still backs a sensitive display at `now`. */
export function isConfirmationFresh(
  at: ConfirmationInstant,
  now: ConfirmationInstant,
  maxAgeMs: number,
): boolean {
  return confirmationAgeMs(at, now) < maxAgeMs;
}

/** Dispatch instant of the request that produced each cached snapshot. */
const STAMPS = new WeakMap<object, ConfirmationInstant>();

/** Requests in flight, per client and principal, by dispatch instant. */
const IN_FLIGHT = new WeakMap<QueryClient, Map<string, ConfirmationInstant>>();

const principalTag = (userId: string, organizationId: string) => `${userId}/${organizationId}`;

/**
 * When this tab's current principal became its principal. A confirmation
 * counts only if its request left during that tenure: after member A → B → A
 * (or organization A → B → A), A's earlier answers — however recent — never
 * stand in for A's return. Set during the provider's render, like the Home
 * cache partition (enforceHomeCachePrincipal), so no frame of the new tenure
 * can see an old one's stamp.
 */
const TENURE = new WeakMap<QueryClient, { tag: string; since: ConfirmationInstant }>();

export function markCapabilityPrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  try {
    const tag = principalTag(userId, organizationId);
    if (TENURE.get(queryClient)?.tag === tag) return;
    TENURE.set(queryClient, { tag, since: readConfirmationClock() });
  } catch {
    // Never block a render; without a tenure nothing counts as confirmed.
  }
}

/** Whether `instant` falls inside this principal's current tenure in this tab. */
export function isWithinCapabilityTenure(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  instant: ConfirmationInstant,
): boolean {
  const tenure = TENURE.get(queryClient);
  if (!tenure || tenure.tag !== principalTag(userId, organizationId)) return false;
  return instant.wall >= tenure.since.wall && instant.mono >= tenure.since.mono;
}

/**
 * The confirmation behind this principal's current snapshot: its request's
 * dispatch instant, if it was stamped and left during the current tenure.
 */
export function principalConfirmation(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  data: unknown,
): ConfirmationInstant | undefined {
  const stamp = capabilityConfirmation(data);
  return stamp && isWithinCapabilityTenure(queryClient, userId, organizationId, stamp)
    ? stamp
    : undefined;
}

/** The dispatch instant behind this exact snapshot, if it came from a stamped request. */
export function capabilityConfirmation(data: unknown): ConfirmationInstant | undefined {
  return typeof data === "object" && data !== null ? STAMPS.get(data) : undefined;
}

/** Dispatch instant of this principal's capability request still in flight, if any. */
export function capabilityRequestInFlight(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): ConfirmationInstant | undefined {
  return IN_FLIGHT.get(queryClient)?.get(principalTag(userId, organizationId));
}

/**
 * The capability queryFn: `fetch` with the dispatch instant recorded before
 * the request leaves and stamped onto a fresh copy of its answer (a fresh
 * object, so no two requests can ever share — and overwrite — one stamp).
 */
export function stampedCapabilityQueryFn(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  fetch: () => Promise<CapabilityResult>,
): () => Promise<CapabilityResult> {
  return async () => {
    const tag = principalTag(userId, organizationId);
    const dispatchedAt = readConfirmationClock();
    let inFlight = IN_FLIGHT.get(queryClient);
    if (!inFlight) {
      inFlight = new Map();
      IN_FLIGHT.set(queryClient, inFlight);
    }
    inFlight.set(tag, dispatchedAt);
    try {
      const result = { ...(await fetch()) } as CapabilityResult;
      STAMPS.set(result, dispatchedAt);
      return result;
    } finally {
      if (inFlight.get(tag) === dispatchedAt) inFlight.delete(tag);
    }
  };
}

/**
 * structuralSharing for the capability query: React Query's own deep sharing
 * (an unchanged answer keeps its reference, so nothing re-renders for it),
 * with the stamp following whichever object becomes the data. An unstamped
 * write clears it: the data then no longer comes from a stamped request.
 */
export function shareStampedCapabilityResult(previous: unknown, next: unknown): unknown {
  const shared = replaceEqualDeep(previous, next);
  if (shared !== next && typeof shared === "object" && shared !== null) {
    const stamp = capabilityConfirmation(next);
    if (stamp) STAMPS.set(shared, stamp);
    else STAMPS.delete(shared);
  }
  return shared;
}
