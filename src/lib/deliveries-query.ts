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
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { ordersKeys } from "@/lib/orders-query";

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

/**
 * Every cache entry a successful delivery transition makes stale.
 *
 * A delivery transition is not confined to the Delivery domain. Moving a parcel
 * to `in_transit`, `delivered`, `failed` or `cancelled` moves the ORDER's
 * fulfillment axis with it, and the Orders list renders that axis on every row
 * (`order.fulfillmentStatus`, src/routes/app.orders.tsx). The transition used
 * to refresh this delivery's detail, this principal's delivery lists, the
 * order's OWN detail and Home — but not the Orders list, so a merchant who
 * marked a parcel delivered and went back to Orders was shown the previous
 * fulfillment state until that list happened to refetch. Same for the bottom
 * nav's order count, which reads `ordersKeys.list` (src/design-system/BottomNav.tsx).
 *
 * Returned as data, rather than invalidated here, so the set is a contract that
 * can be asserted by value instead of by reading the call site's source
 * (src/tests/delivery-orders-invalidation.test.ts). The caller is
 * src/routes/app.deliveries.$id.tsx.
 *
 * Every key is scoped to the acting principal — the user id and organization id
 * the /app guard resolved server-side — so invalidation cannot reach another
 * member's or another organization's entries. `HOME_QUERY_PREFIX` is the one
 * unpartitioned entry, and it is pre-existing reviewed behaviour: Home is
 * partitioned instead at the /app layout by `enforceHomeCachePrincipal`, which
 * drops the whole root the moment the principal changes.
 *
 * `orderId` is null only before this delivery's detail has loaded, in which
 * case the order keys fall back to the same `"none"` sentinel the screen reads
 * with — never a real order belonging to someone else.
 */
export function deliveryTransitionInvalidationKeys(
  userId: string,
  organizationId: string,
  orderId: string | null,
): readonly (readonly unknown[])[] {
  const order = orderId ?? "none";
  return [
    // This order's own detail — its fulfillment status and delivery sub-entry.
    ordersKeys.detail(userId, organizationId, order),
    // The Orders list and the bottom nav's order count both read this key.
    ordersKeys.list(userId, organizationId),
    // Every filtered delivery list this principal holds, and nothing else.
    deliveryKeys.lists(userId, organizationId),
    // Home's delivery-attention count is derived from delivery status.
    HOME_QUERY_PREFIX,
  ];
}
