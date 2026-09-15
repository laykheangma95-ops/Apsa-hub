/**
 * The one mechanism behind every principal-partitioned React Query cache.
 *
 * APSA already had this shape three times — Home (src/lib/home-query.ts),
 * Catalog (src/lib/catalog.ts) and Inventory (src/lib/inventory.ts) each hold
 * their own `LAST_*_PRINCIPAL` WeakMap plus a `clear*`/`enforce*` pair. This
 * module is that same convention written once, so the domains migrated in the
 * launch-safety phase (Orders, Conversations, Customers, Team) reuse it rather
 * than adding a fourth, fifth, sixth hand-rolled copy that could drift.
 *
 * It is NOT a second convention: the key shape, the `removeQueries`-not-
 * `invalidateQueries` rule, the "never throw" rule and the WeakMap-keyed
 * principal record are exactly the ones those three modules established. The
 * three existing modules are deliberately left as they are — this phase does
 * not rewrite reviewed, merged code to adopt a helper.
 *
 * What a partition is, and what it is not:
 *
 *   - It is CACHE IDENTITY. `userId` and `organizationId` decide which cache
 *     entry a screen reads and writes, so one principal's payload can never be
 *     served to another in a tab both of them used.
 *   - It is NOT AUTHORIZATION. The server resolves the user from the validated
 *     session cookie and the organization from the active membership row, and
 *     re-authorizes every single request. Nothing here is ever sent to the
 *     server as a claim, and a caller who forged both values would still get
 *     back only their own organization's data.
 *
 * Both identifiers must come from the /app route guard's server-derived
 * context (src/routes/app.tsx `Route.useRouteContext()`), never from the
 * capability snapshot (presentation data, fetched separately) and never from
 * the URL or any other client input.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import type { QueryClient } from "@tanstack/react-query";

/**
 * A principal's cache identity as one string.
 *
 * "/" cannot appear in a UUID, so no two (userId, organizationId) pairs can
 * collide into the same tag.
 */
export function principalTag(userId: string, organizationId: string): string {
  return `${userId}/${organizationId}`;
}

export interface QueryPartition {
  /** The first element of every key in this partition. */
  readonly root: string;
  /** Every entry in this partition, for every principal, in any tab. */
  readonly prefix: readonly [string];
  /** Every entry belonging to exactly one principal. */
  principal(userId: string, organizationId: string): readonly [string, string, string];
  /**
   * Drop every entry in this partition, for every principal, in this tab.
   *
   * `removeQueries` (not `invalidateQueries`) is deliberate: invalidation
   * leaves the previous principal's payload readable in the cache until a
   * refetch resolves, which is exactly the window a departed member's data
   * must not survive into.
   *
   * Never throws. Nothing here may block navigation or sign-out — a cache
   * that cannot be pruned must not also break the thing that asked for it.
   */
  clear(queryClient: QueryClient): void;
  /**
   * Drop this partition whenever the authenticated principal differs from the
   * one it was filled for, and leave it alone otherwise so ordinary caching
   * still works within one member's session.
   *
   * Independent, defense-in-depth isolation. It does not replace
   * `queryClient.clear()` on an explicit sign-out (src/routes/app.settings.tsx)
   * — it covers the same cases Home's enforceHomeCachePrincipal covers: that
   * global clear failing partway, or a client-side account/organization switch
   * that never goes through Settings' sign-out path at all.
   *
   * Call it during render, not from an effect: an effect fires after children
   * have already rendered, which is one frame of the previous principal's data
   * on screen.
   */
  enforce(queryClient: QueryClient, userId: string, organizationId: string): void;
}

/**
 * Build the clear/enforce pair for one cache root.
 *
 * The WeakMap is keyed by QueryClient rather than held in component state so
 * the recorded principal survives the unmount/remount cycle of a client-side
 * sign-out then sign-in — the case where one tab serves two different members,
 * including two members of the SAME organization who hold different
 * permissions.
 */
export function createQueryPartition(root: string): QueryPartition {
  const prefix = [root] as const;
  const lastPrincipal = new WeakMap<QueryClient, string>();

  function clear(queryClient: QueryClient): void {
    try {
      queryClient.removeQueries({ queryKey: prefix });
    } catch {
      // Never pretend the clear succeeded by staying silent AND never throw:
      // whatever asked for this (a render, a navigation, a sign-out) must
      // still complete.
    } finally {
      try {
        // The recorded principal goes with the data, so the next principal to
        // mount is always treated as a change and purges again.
        lastPrincipal.delete(queryClient);
      } catch {
        // Ignore — nothing here may block the caller.
      }
    }
  }

  return {
    root,
    prefix,
    principal: (userId, organizationId) => [root, userId, organizationId] as const,
    clear,
    enforce(queryClient, userId, organizationId) {
      const tag = principalTag(userId, organizationId);
      if (lastPrincipal.get(queryClient) === tag) return;
      clear(queryClient);
      lastPrincipal.set(queryClient, tag);
    },
  };
}
