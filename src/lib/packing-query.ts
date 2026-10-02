/**
 * Packing cache identity.
 *
 * Partitioned by user + organization like every other domain cache so one
 * principal's pack data can never be served to another.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const PACKING_QUERY_ROOT = "packing";

const partition = createQueryPartition(PACKING_QUERY_ROOT);

export const packingKeys = {
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  requirements: (userId: string, organizationId: string, orderId: string) =>
    [PACKING_QUERY_ROOT, userId, organizationId, "requirements", orderId] as const,
};

export const PACKING_QUERY_PREFIX = partition.prefix;
export const clearPackingQueries = partition.clear;
export const enforcePackingCachePrincipal = partition.enforce;
