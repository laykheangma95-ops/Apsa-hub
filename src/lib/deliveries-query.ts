/**
 * Delivery cache identity.
 *
 * The Delivery screens keyed on `["deliveries","real", scope, status, search]`
 * and `["delivery","real", id]` — the filters were in the key, but no
 * principal was. Those payloads are real production tenant data: a delivery
 * row carries the customer's name, the order code, the COD amount, the
 * courier's external tracking number and the provider it went out with
 * (src/lib/deliveries.ts → RealDeliveryListItem / RealDeliveryDetail).
 *
 * The leak is the same one the launch-safety phase closed for Orders,
 * Conversations, Customers, POS products and Team, and it survives in a way
 * the explicit sign-out does not cover. Settings' sign-out purges every root
 * and then calls `queryClient.clear()`, but that is not the only way one tab
 * stops belonging to one member: when a session expires or is revoked, the
 * /app guard throws a redirect (src/routes/app.tsx `beforeLoad`) and NOTHING
 * on that path purges anything. The router navigates client-side, so the tab
 * keeps the same QueryClient object, and the next member to sign in mounts a
 * Delivery key character-for-character identical to the departed member's.
 * React Query then serves the previous principal's list and detail for the
 * whole window before the refetch resolves.
 *
 * `enforceDeliveryCachePrincipal` at the /app layout is what closes that path:
 * it runs during render, before any child route, and drops the partition
 * whenever the authenticated principal differs from the one it was filled for.
 *
 * Partitioned by user AND organization, never organization alone — the same
 * rule the other five domains follow. `delivery.read` and the transition
 * grants are per-member, so two members of one organization must not share an
 * entry.
 *
 * Cache identity only. src/server/deliveries/service.ts resolves the
 * organization from the caller's active membership row and re-checks
 * `delivery.read` and the transition permission on every call. Nothing here is
 * ever sent to the server.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const DELIVERIES_QUERY_ROOT = "deliveries";

const partition = createQueryPartition(DELIVERIES_QUERY_ROOT);

export const deliveryKeys = {
  /**
   * Everything this principal has cached from the Delivery domain — every
   * filtered list and every delivery detail.
   *
   * The invalidation target after a delivery transition: one call, scoped to
   * the acting principal, never reaching another member's entries.
   */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /**
   * One filtered delivery list (an infinite query — its pages and its offset
   * cursor live under this single entry, so partitioning the key partitions
   * the cursor with it).
   */
  list: (
    userId: string,
    organizationId: string,
    scope: string | null,
    status: string | null,
    search: string | null,
  ) => [DELIVERIES_QUERY_ROOT, userId, organizationId, "list", scope, status, search] as const,
  /** Every filtered list this principal holds, without naming the filters. */
  lists: (userId: string, organizationId: string) =>
    [DELIVERIES_QUERY_ROOT, userId, organizationId, "list"] as const,
  /** One delivery's detail, with its transition history. */
  detail: (userId: string, organizationId: string, deliveryId: string) =>
    [DELIVERIES_QUERY_ROOT, userId, organizationId, "detail", deliveryId] as const,
};

export const DELIVERIES_QUERY_PREFIX = partition.prefix;
export const clearDeliveryQueries = partition.clear;
export const enforceDeliveryCachePrincipal = partition.enforce;
