/**
 * Picking cache identity.
 *
 * Partitioned by user + organization like every other domain cache so one
 * principal's pick data can never be served to another.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const PICKING_QUERY_ROOT = "picking";

const partition = createQueryPartition(PICKING_QUERY_ROOT);

export const pickingKeys = {
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  requirements: (userId: string, organizationId: string, orderId: string) =>
    [PICKING_QUERY_ROOT, userId, organizationId, "requirements", orderId] as const,
};

export const PICKING_QUERY_PREFIX = partition.prefix;
export const clearPickingQueries = partition.clear;
export const enforcePickingCachePrincipal = partition.enforce;
