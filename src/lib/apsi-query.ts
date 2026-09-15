/**
 * Apsi console cache identity.
 *
 * The console answers with customer names, order codes, payment states and
 * money — the same class of data the Orders and Customers screens hold — and
 * it lives in the nav, so it is mounted on every signed-in screen including
 * the one a second member signs in to on a shared shop phone.
 *
 * So it follows the convention the launch-safety phase established for every
 * other sensitive cache (src/lib/query-principal.ts): every key is partitioned
 * by BOTH the authenticated user AND the organization the server resolved for
 * them. Never by organization alone — two members of the same organization
 * hold different grants, and Apsi's answer is shaped by those grants (a member
 * without customers.view_sensitive gets a payload with the phone withheld), so
 * an organization-only key would let one member's answer be read back for
 * another.
 *
 * Cache identity only. Nothing here is sent to the server, and every lookup
 * behind these keys re-authorizes independently.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const APSI_QUERY_ROOT = "apsi";

const partition = createQueryPartition(APSI_QUERY_ROOT);

export const apsiKeys = {
  /** Everything this principal has cached from the Apsi console. */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /** One console search. The normalized query is part of the key, never the raw input. */
  lookup: (userId: string, organizationId: string, normalizedQuery: string) =>
    [APSI_QUERY_ROOT, userId, organizationId, "lookup", normalizedQuery] as const,
};

export const APSI_QUERY_PREFIX = partition.prefix;
export const clearApsiQueries = partition.clear;
export const enforceApsiCachePrincipal = partition.enforce;
