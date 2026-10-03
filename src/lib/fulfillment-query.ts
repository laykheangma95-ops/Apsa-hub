/**
 * Fulfillment cache identity, and the fail-closed rule for parcel-label PII.
 *
 * A parcel label carries the SAME sensitive fields the Customer domain gates
 * behind `customers.view_sensitive`: the customer's name, phone and delivery
 * address. Before this module the label payload lived under a bare
 * `["parcel-labels", ids]` key — no principal in it, and nothing evicted it
 * when the grant was revoked — so Organization A's shipping PII survived an
 * account switch or a permission loss in the same browser tab, readable by
 * anything that inspects the QueryClient.
 *
 * This gives the Fulfillment domain the exact same treatment
 * src/lib/customers-query.ts already gives the Customer domain:
 *
 *   - partitioned by user AND organization (never organization alone), so one
 *     principal's label payload can never be served to another; and
 *   - evicted the moment `fulfillment.print_label` — the capability the server
 *     requires for the label — stops holding for the principal
 *     (enforceFulfillmentSensitiveCache), fail-closed on a first "denied"
 *     observation and on a snapshot whose refresh failed.
 *
 * Cache identity only. src/server/fulfillment/service.ts still requires
 * fulfillment.print_label server-side and builds the label from its own
 * resolution of the grant — the browser never decides access.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import type { QueryClient } from "@tanstack/react-query";
import { createQueryPartition, principalTag } from "@/lib/query-principal";

export const FULFILLMENT_QUERY_ROOT = "fulfillment";

const partition = createQueryPartition(FULFILLMENT_QUERY_ROOT);

export const fulfillmentKeys = {
  /** Everything this principal has cached from the Fulfillment domain. */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /**
   * The Ready-to-Pack queue. Carries a customer DISPLAY NAME only (not gated),
   * but partitioned by principal like every other domain cache.
   */
  readyToPack: (userId: string, organizationId: string) =>
    [FULFILLMENT_QUERY_ROOT, userId, organizationId, "ready-to-pack"] as const,
  /**
   * Parcel-label data for a set of orders — the entry that holds name, phone
   * and address. The id list is sorted so the same set of orders is one stable
   * entry regardless of selection order.
   */
  parcelLabels: (userId: string, organizationId: string, orderIds: readonly string[]) =>
    [
      FULFILLMENT_QUERY_ROOT,
      userId,
      organizationId,
      "parcel-labels",
      [...orderIds].sort(),
    ] as const,
  /** The prefix covering every parcel-label entry for a principal (eviction target). */
  parcelLabelsPrefix: (userId: string, organizationId: string) =>
    [FULFILLMENT_QUERY_ROOT, userId, organizationId, "parcel-labels"] as const,
  /**
   * Internal APSA Parcel label data (parcel code, order number, item count — no
   * PII). Partitioned by principal like every other fulfillment entry.
   */
  internalLabels: (userId: string, organizationId: string, orderIds: readonly string[]) =>
    [
      FULFILLMENT_QUERY_ROOT,
      userId,
      organizationId,
      "internal-parcel-labels",
      [...orderIds].sort(),
    ] as const,
};

export const FULFILLMENT_QUERY_PREFIX = partition.prefix;
export const clearFulfillmentQueries = partition.clear;
export const enforceFulfillmentCachePrincipal = partition.enforce;

// ── Sensitive-grant eviction ─────────────────────────────────────────────────

/**
 * The last `fulfillment.print_label` answer each principal's parcel-label
 * cache was filled under, per QueryClient (survives remounts, like
 * query-principal's own record).
 */
const LAST_SENSITIVE_GRANT = new WeakMap<QueryClient, Map<string, boolean>>();

/**
 * Evict raw parcel-label PII from the React Query cache the moment
 * `fulfillment.print_label` stops holding for this principal.
 *
 * The identical mechanism as enforceCustomerSensitiveCache: on every
 * allowed -> not-allowed transition — including a first observation of "not
 * allowed", and a retained snapshot whose refresh failed (pass `canSensitive`,
 * never `can`) — the parcel-label entries are cancelled (so a late in-flight
 * response cannot write the raw values back) and removed synchronously. The
 * next read refetches, and the server builds that response from its own
 * resolution of the grant, so a revoked member gets a refusal, not a label.
 *
 * `removeQueries`, not `invalidateQueries`: invalidation would keep the old
 * PII readable until a refetch lands. A no-op while the answer is unchanged.
 * Call during render (before any label surface renders), never in an effect.
 * Never throws.
 */
export function enforceFulfillmentSensitiveCache(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  canViewSensitive: boolean,
): void {
  try {
    let record = LAST_SENSITIVE_GRANT.get(queryClient);
    if (!record) {
      record = new Map();
      LAST_SENSITIVE_GRANT.set(queryClient, record);
    }
    const tag = principalTag(userId, organizationId);
    const previous = record.get(tag);
    record.set(tag, canViewSensitive);
    if (canViewSensitive || previous === false) return;

    const queryKey = fulfillmentKeys.parcelLabelsPrefix(userId, organizationId);
    void queryClient.cancelQueries({ queryKey }).catch(() => undefined);
    queryClient.removeQueries({ queryKey });
  } catch {
    // Never block a render. The dialog's own canSensitive gate still refuses.
  }
}
