import type { QueryClient } from "@tanstack/react-query";
import type { MetricRange } from "@/types";

/**
 * Every authenticated Home cache entry lives under this prefix, so one
 * `removeQueries` call can drop all of it without knowing which principals,
 * organizations or ranges happen to be cached in this tab.
 */
export const HOME_QUERY_PREFIX = ["home", "authenticated"] as const;

/**
 * Home data is sensitive tenant data. Principal and organization are part of
 * its cache identity so a sign-out/sign-in or organization change cannot reuse
 * another scope's result. Neither value is trusted by the server for access.
 */
export function homeQueryKey(userId: string, organizationId: string, range: MetricRange) {
  return [...HOME_QUERY_PREFIX, userId, organizationId, range] as const;
}

/**
 * The principal whose Home data this tab's cache is currently allowed to hold.
 * Keyed by QueryClient rather than held in component state so it survives the
 * unmount/remount cycle of a client-side sign-out then sign-in, which is the
 * case where one tab serves two different users.
 */
const LAST_PRINCIPAL = new WeakMap<QueryClient, string>();

/**
 * The single place Home's cached tenant data is destroyed.
 *
 * `removeQueries` (not `invalidateQueries`) is deliberate: invalidation leaves
 * the previous principal's payload readable in the cache until a refetch
 * resolves, which is exactly the window a signed-out user's data must not
 * survive into.
 *
 * Never throws. Sign-out must complete — and the session must stay revoked —
 * even if the query cache is in a bad state.
 */
export function clearHomeQueries(queryClient: QueryClient): void {
  try {
    queryClient.removeQueries({ queryKey: HOME_QUERY_PREFIX });
  } catch {
    // A cache that cannot be pruned must never keep the user signed in.
  } finally {
    // The recorded principal goes with the data, so the next principal to
    // mount is always treated as a change and purges again.
    try {
      LAST_PRINCIPAL.delete(queryClient);
    } catch {
      // Ignore — nothing here may block sign-out.
    }
  }
}

/**
 * Drop Home's cache whenever the authenticated principal or active
 * organization differs from the one the cache was filled for, and leave it
 * alone otherwise so normal caching still works for the same principal.
 *
 * `userId` and `organizationId` must come from the server-derived route
 * context (the /app guard resolves both from the validated session and the
 * active membership row). They are a cache partition only — never an
 * authorization claim, and never read from client input.
 */
export function enforceHomeCachePrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  // "/" cannot appear in a UUID, so no two principals can produce one string.
  const principal = `${userId}/${organizationId}`;
  if (LAST_PRINCIPAL.get(queryClient) === principal) return;
  clearHomeQueries(queryClient);
  LAST_PRINCIPAL.set(queryClient, principal);
}
