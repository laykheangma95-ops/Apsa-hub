/**
 * Order cache identity.
 *
 * Before this module the production Order screens keyed on `["orders","real"]`
 * and `["order","real",id]` — no principal in the key at all. On a shared
 * phone that is a concrete leak: User A opens Orders for Organization A, signs
 * out, User B signs in through client-side navigation (same tab, same
 * QueryClient object), opens Orders, and React Query serves A's cached list
 * for the whole window before B's refetch resolves. Order rows carry customer
 * names, order codes and money.
 *
 * Every key below is partitioned by BOTH the authenticated user AND the
 * organization the server resolved for them — never by organization alone.
 * Two members of the same organization can hold different grants (a member
 * without payments.read sees an order detail the server built differently), so
 * an organization-only key would let one member's payload be read back for
 * another member of the same organization signing in after them.
 *
 * Cache identity only. The server derives the user from the validated session
 * cookie and the organization from the active membership row, and re-checks
 * orders.read / orders.create / the lifecycle transition permission on every
 * call (src/server/orders/service.ts). Nothing here is sent to the server.
 *
 * Safe to bundle for the browser.
 */
import type { OrderListFilter } from "@/lib/order-list-filters";
import { createQueryPartition } from "@/lib/query-principal";

export const ORDERS_QUERY_ROOT = "orders";

const partition = createQueryPartition(ORDERS_QUERY_ROOT);

export const ordersKeys = {
  /**
   * Everything this principal has cached from the Order domain.
   *
   * This is the invalidation target after an order mutation: it covers the
   * list, every order detail and each detail's deliveries sub-entry in one
   * call, and — because the principal is part of the key — it cannot reach
   * into another user's or another organization's entries.
   */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /**
   * The production Order list for one principal — the prefix every list
   * invalidation targets. Its own entry holds the bottom nav's recent orders.
   */
  list: (userId: string, organizationId: string) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "list"] as const,
  /**
   * The Orders screen's paged list (an infinite query: pages plus the cursor
   * that continues them). A SUB-KEY of `list`, so every invalidation of the
   * list reaches it, while the bottom nav's plain array never shares an entry
   * with this differently shaped one. Partitioning the key partitions the
   * cursor with it: a position walked through one principal's orders can never
   * continue a request made for another.
   *
   * This is the PREFIX of every filter's entry (listPagesFor); invalidate it
   * without `exact` to reach all of them.
   */
  listPages: (userId: string, organizationId: string) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "list", "pages"] as const,
  /**
   * One filter's paged list. Each filter is its own entry with its own pages
   * and cursor, so a page read for one filter can never be shown, or
   * continued, under another.
   */
  listPagesFor: (userId: string, organizationId: string, filter: OrderListFilter) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "list", "pages", filter] as const,
  /** One production Order's detail. */
  detail: (userId: string, organizationId: string, orderId: string) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "detail", orderId] as const,
  /**
   * The deliveries attached to one order, as Order detail shows them.
   *
   * Deliberately a SUB-KEY of that order's detail rather than a key in the
   * Delivery domain: it is fetched by, invalidated with, and discarded
   * alongside the order screen that owns it.
   */
  detailDeliveries: (userId: string, organizationId: string, orderId: string) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "detail", orderId, "deliveries"] as const,
};

export const ORDERS_QUERY_PREFIX = partition.prefix;
export const clearOrderQueries = partition.clear;
export const enforceOrderCachePrincipal = partition.enforce;
