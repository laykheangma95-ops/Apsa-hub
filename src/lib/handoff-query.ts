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
