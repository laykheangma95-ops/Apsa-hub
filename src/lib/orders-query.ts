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
  /** The production Order list for one principal. */
  list: (userId: string, organizationId: string) =>
    [ORDERS_QUERY_ROOT, userId, organizationId, "list"] as const,
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
