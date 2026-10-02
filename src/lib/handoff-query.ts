/**
 * Handoff cache identity.
 *
 * The handoff preview carries operational data: parcel code, order number,
 * courier name, tracking number and delivery status. Partitioned by
 * authenticated user AND organization so a preview can never be served to a
 * different account or a different organization member.
 *
 * Both identifiers come from the /app route guard's server-derived context,
 * never from the URL or any client input.
 *
 * Cache identity only. The server resolves the user from the validated session
 * cookie and the organization from the active membership row, and re-checks
 * delivery.handoff on every call (src/server/handoff/service.ts). Nothing here
 * is sent to the server.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import { createQueryPartition } from "@/lib/query-principal";
import { deliveryKeys, deliveryTransitionInvalidationKeys } from "@/lib/deliveries-query";
import type { HandoffResult } from "@/lib/handoff";
import type { QueryClient } from "@tanstack/react-query";

export const HANDOFF_QUERY_ROOT = "handoff";

const partition = createQueryPartition(HANDOFF_QUERY_ROOT);

export const handoffKeys = {
  /** Every entry this principal has cached from the Handoff domain. */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /** One parcel's handoff preview. */
  preview: (userId: string, organizationId: string, parcelCode: string) =>
    [HANDOFF_QUERY_ROOT, userId, organizationId, "preview", parcelCode] as const,
};

export const HANDOFF_QUERY_PREFIX = partition.prefix;
export const clearHandoffQueries = partition.clear;
export const enforceHandoffCachePrincipal = partition.enforce;

/**
 * Apply the cache effects of one server-authoritative handoff result.
 * Failures change no domain state and therefore invalidate nothing.
 */
export async function syncHandoffResultCaches(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  parcelCode: string,
  result: HandoffResult,
): Promise<void> {
  if (result.kind !== "success") return;

  const { handoff } = result;
  const keys = [
    ...deliveryTransitionInvalidationKeys(userId, organizationId, handoff.orderId),
    deliveryKeys.detail(userId, organizationId, handoff.deliveryId),
    handoffKeys.preview(userId, organizationId, parcelCode),
  ];

  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
