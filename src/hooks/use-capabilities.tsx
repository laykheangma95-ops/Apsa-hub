/**
 * The one client-facing capability access pattern.
 *
 * `useCapabilities()` returns a fail-closed reader over the server-derived
 * snapshot for the authenticated member's active organization. Components call
 * `can("orders.refund")` to decide what to render — never to decide access.
 * The server authorizes every action again on its own.
 *
 * Outside a provider the default view is "pending", so nothing is offered.
 */
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getActiveMemberCapabilitiesFn } from "@/api/capabilities";
import {
  capabilityRequestInFlight,
  confirmationAgeMs,
  isConfirmationFresh,
  isWithinCapabilityTenure,
  markCapabilityPrincipal,
  principalConfirmation,
  readConfirmationClock,
  shareStampedCapabilityResult,
  stampedCapabilityQueryFn,
} from "@/lib/capability-confirmation";
import {
  capabilityQueryKey,
  createCapabilityView,
  createFixtureCapabilityView,
  UNRESOLVED_CAPABILITIES,
  type CapabilityResult,
  type CapabilityView,
  type UiPermissionKey,
} from "@/lib/capabilities";

const CapabilityContext = createContext<CapabilityView>(UNRESOLVED_CAPABILITIES);

/** Re-fetch rather than trust a long-lived snapshot: access can be revoked. */
const CAPABILITY_STALE_MS = 60_000;

/**
 * How often a surface that displays sensitive data re-asks the server whether
 * access still holds, while it is open. staleTime alone never triggers a
 * refetch, so without this an already-open view would learn of a server-side
 * revocation only by unrelated navigation or focus changes.
 */
export const SENSITIVE_CAPABILITY_REVALIDATE_MS = 15_000;

/**
 * How long one positive server answer may keep a sensitive value on screen,
 * counted from when its REQUEST was dispatched (src/lib/capability-confirmation.ts)
 * — never from when the answer arrived.
 *
 * Two revalidation intervals: one refresh that is slow or lost is tolerated,
 * a second is not. Revalidation only ever re-asks; it never extends this
 * window by itself — only a successful answer does, and only by as much as
 * its request is recent. A refresh that never settles (a hung request, which
 * React Query's interval then dedupes onto forever) or that answers late
 * therefore cannot keep a value up past this age.
 */
export const SENSITIVE_CAPABILITY_MAX_AGE_MS = 2 * SENSITIVE_CAPABILITY_REVALIDATE_MS;

interface CapabilityProviderProps {
  /** From the /app route context — validated server-side, never from the URL. */
  userId: string;
  /** From the /app route context — resolved from DB membership, never from the client. */
  organizationId: string;
  /** SSR seed from the /app loader, so the first paint is already role-correct. */
  initialResult?: CapabilityResult | undefined;
  children: ReactNode;
}

export function CapabilityProvider({
  userId,
  organizationId,
  initialResult,
  children,
}: CapabilityProviderProps) {
  const queryClient = useQueryClient();
  // A new principal starts a new tenure: no earlier answer confirms it.
  markCapabilityPrincipal(queryClient, userId, organizationId);
  const query = useQuery({
    // Partitioned by user AND organization: a snapshot can never be read back
    // for a different account or a different organization.
    queryKey: capabilityQueryKey(userId, organizationId),
    queryFn: capabilityQueryFn(queryClient, userId, organizationId),
    structuralSharing: shareStampedCapabilityResult,
    // The seed is unstamped: it renders the role-correct shell, but never
    // counts as a recent confirmation for a sensitive display. A seed for a
    // different member or organization (the router's cached loader snapshot
    // after an in-tab switch) is not used at all, so this principal's own
    // snapshot is fetched now instead of being refused until it goes stale.
    ...(initialResult && seedMatchesPrincipal(initialResult, userId, organizationId)
      ? { initialData: initialResult }
      : {}),
    staleTime: CAPABILITY_STALE_MS,
    retry: false,
  });

  const view = useMemo(
    () =>
      createCapabilityView({
        result: query.data,
        isPending: query.isPending,
        isError: query.isError,
        expectedUserId: userId,
        expectedOrganizationId: organizationId,
      }),
    [query.data, query.isPending, query.isError, userId, organizationId],
  );

  return <CapabilityContext.Provider value={view}>{children}</CapabilityContext.Provider>;
}

/** An active seed must name exactly this principal; a denial names no one. */
function seedMatchesPrincipal(seed: CapabilityResult, userId: string, organizationId: string) {
  return (
    seed.status !== "active" || (seed.userId === userId && seed.organizationId === organizationId)
  );
}

/**
 * The capability query's queryFn, everywhere it is registered: each answer is
 * stamped with the instant its request left (src/lib/capability-confirmation.ts).
 */
function capabilityQueryFn(queryClient: QueryClient, userId: string, organizationId: string) {
  return stampedCapabilityQueryFn(queryClient, userId, organizationId, () =>
    getActiveMemberCapabilitiesFn(),
  );
}

/**
 * Keep the ONE production capability query fresh while a sensitive surface is
 * open. Same query key and queryFn as CapabilityProvider (so there is a single
 * source of truth and one request per tick); the provider's view — and with it
 * canSensitive() — updates from the result. A failed refresh leaves the
 * snapshot `stale`, which canSensitive() refuses. Polls only while `active`.
 */
export function useSensitiveCapabilityRevalidation(
  userId: string,
  organizationId: string,
  active: boolean,
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: capabilityQueryKey(userId, organizationId),
    queryFn: capabilityQueryFn(queryClient, userId, organizationId),
    structuralSharing: shareStampedCapabilityResult,
    enabled: active,
    // Always treat the held snapshot as stale: refetch on open/mount and focus.
    staleTime: 0,
    refetchInterval: active ? SENSITIVE_CAPABILITY_REVALIDATE_MS : false,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

/**
 * Where a sensitive surface stands with the server's confirmation:
 *
 * - `fresh`      — the current snapshot is a positive answer for THIS
 *                  principal whose request left less than
 *                  SENSITIVE_CAPABILITY_MAX_AGE_MS ago, during this tab's
 *                  current tenure of that principal.
 * - `confirming` — the snapshot has not been confirmed by a request of this
 *                  tenure (an SSR/loader seed, or an answer from before a
 *                  switch away and back) and one is on its way.
 *                  Not fresh: nothing sensitive may show; the surface can
 *                  draw a placeholder instead of an error.
 * - `lapsed`     — anything else: aged out, failed, or not active.
 */
export type SensitiveConfirmation = "fresh" | "confirming" | "lapsed";

/**
 * useSensitiveCapabilityRevalidation, plus a deadline: `fresh` only while the
 * server's last positive answer for THIS principal came from a request
 * dispatched less than SENSITIVE_CAPABILITY_MAX_AGE_MS ago. For a surface
 * whose mere display is a disclosure (Home's money); combine with
 * canSensitive(), never instead of it.
 *
 * The deadline is a timer, so it lapses on time even when no request settles
 * and nothing else re-renders; returning to a hidden or restored tab
 * re-checks synchronously, before the page is seen (a throttled or frozen
 * background timer must not stretch the window). An answer whose request is
 * already older than the window when it lands is not fresh for even one
 * render. Once lapsed, it re-asks the server — abandoning a request that left
 * before the lapse, whose late answer is then discarded — immediately and
 * every SENSITIVE_CAPABILITY_MAX_AGE_MS until an answer lands: bounded, never
 * a tight loop.
 *
 * This limits how long a stale figure can stay on screen: a revocation is
 * reflected at most SENSITIVE_CAPABILITY_MAX_AGE_MS after the server last
 * granted. It cannot make the browser learn of a revocation the instant it
 * happens; the server still authorizes every read on its own.
 */
export function useSensitiveCapabilityFreshness(
  userId: string,
  organizationId: string,
  active: boolean,
): SensitiveConfirmation {
  const queryClient = useQueryClient();
  const query = useSensitiveCapabilityRevalidation(userId, organizationId, active);
  const [, recheck] = useReducer((tick: number) => tick + 1, 0);

  // Read unconditionally: React Query re-renders only for the fields a
  // component reads, and a refresh that returns an identical answer keeps
  // the same `data` reference (structural sharing) — only these two change,
  // and the new stamp must be picked up.
  const { dataUpdatedAt, fetchStatus } = query;
  void dataUpdatedAt;
  const result = query.data;
  const stamp =
    query.status === "success"
      ? principalConfirmation(queryClient, userId, organizationId, result)
      : undefined;
  const forThisPrincipal =
    result?.status === "active" &&
    result.userId === userId &&
    result.organizationId === organizationId;
  const age =
    stamp && forThisPrincipal
      ? confirmationAgeMs(stamp, readConfirmationClock())
      : Number.POSITIVE_INFINITY;
  const fresh = active && age < SENSITIVE_CAPABILITY_MAX_AGE_MS;
  const confirming =
    active && !fresh && !stamp && result !== undefined && fetchStatus === "fetching";

  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(recheck, Math.max(0, SENSITIVE_CAPABILITY_MAX_AGE_MS - age));
    // Synchronously, so a tab shown again (or restored from the back-forward
    // cache) is never painted with a figure whose window ran out meanwhile.
    const recheckNow = () => flushSync(recheck);
    document.addEventListener("visibilitychange", recheckNow);
    window.addEventListener("pageshow", recheckNow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", recheckNow);
      window.removeEventListener("pageshow", recheckNow);
    };
    // `age` is read once per deadline; `stamp` identifies the confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, stamp]);

  // Not fresh, but holding a snapshot to confirm: re-ask. (Before any
  // snapshot, the provider's own first fetch is still the request that
  // matters.) A request that left before the lapse is abandoned — it may
  // predate a revocation; one that left after it (a seed's first
  // confirmation) is waited for, until it is itself too old to vouch for
  // anything.
  const lapsed = active && !fresh && result !== undefined;
  useEffect(() => {
    if (!lapsed) return;
    const queryKey = capabilityQueryKey(userId, organizationId);
    const reask = () => {
      const pending = capabilityRequestInFlight(queryClient, userId, organizationId);
      const fetching = queryClient.getQueryState(queryKey)?.fetchStatus === "fetching";
      if (
        fetching &&
        pending &&
        isWithinCapabilityTenure(queryClient, userId, organizationId, pending)
      ) {
        const now = readConfirmationClock();
        const leftAfterLapse =
          !stamp || confirmationAgeMs(stamp, pending) >= SENSITIVE_CAPABILITY_MAX_AGE_MS;
        if (leftAfterLapse && isConfirmationFresh(pending, now, SENSITIVE_CAPABILITY_MAX_AGE_MS)) {
          return;
        }
      }
      void queryClient
        .refetchQueries({ queryKey, exact: true }, { cancelRefetch: true })
        .catch(() => undefined);
    };
    reask();
    const timer = setInterval(reask, SENSITIVE_CAPABILITY_MAX_AGE_MS);
    return () => clearInterval(timer);
  }, [lapsed, stamp, queryClient, userId, organizationId]);

  return fresh ? "fresh" : confirming ? "confirming" : "lapsed";
}

/**
 * Fresh, server-authoritative check that `key` still holds — for the moment
 * before an irreversible sensitive action (printing). Cancels any in-flight
 * capability request (which may predate a revocation), refetches, and reads the
 * outcome. Fails closed: an error, a non-active result, another principal's
 * snapshot, or a missing key all return false. Never throws.
 */
export async function reauthorizeCapability(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  key: UiPermissionKey,
): Promise<boolean> {
  try {
    const queryKey = capabilityQueryKey(userId, organizationId);
    await queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: true });
    const state = queryClient.getQueryState<CapabilityResult>(queryKey);
    const result = state?.data;
    return (
      state?.status === "success" &&
      !!result &&
      result.status === "active" &&
      result.userId === userId &&
      result.organizationId === organizationId &&
      result.permissions.includes(key)
    );
  } catch {
    return false;
  }
}

/**
 * Render children against an explicit permission list.
 *
 * Design-gallery and test scaffolding ONLY — it bypasses the server snapshot,
 * so it must never appear on an /app route. src/tests/capability-boundary.test.ts
 * enforces that.
 */
export function CapabilityFixtureProvider({
  permissions,
  role = null,
  children,
}: {
  permissions: readonly UiPermissionKey[];
  role?: string | null;
  children: ReactNode;
}) {
  const view = useMemo(() => createFixtureCapabilityView(permissions, role), [permissions, role]);
  return <CapabilityContext.Provider value={view}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityView {
  return useContext(CapabilityContext);
}
