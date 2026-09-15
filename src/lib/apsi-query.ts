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
  /**
   * One console search.
   *
   * Three things are part of the identity, and the third is the launch-critical
   * one.
   *
   * The NORMALIZED query, never the raw input, so trailing whitespace and
   * letter case do not fragment one lookup into several entries.
   *
   * `sensitive` — whether `customers.view_sensitive` held when this answer was
   * produced. It is NOT decoration on an already-partitioned key:
   *
   *   Apsi withholds the customer phone probe entirely from a member without
   *   that grant, so a phone-shaped query returns a real result set for a
   *   member who holds it and an un-issued, empty one for a member who does
   *   not. Those are different answers to the same string. Without this
   *   discriminator, a member who searched a phone number while the grant held
   *   would have that result served straight back out of the cache after the
   *   grant was revoked — same tab, same principal, same typed number — and
   *   WHICH CUSTOMERS COME BACK is precisely the disclosure the grant gates.
   *   Blanking the digits on the card would not close it.
   *
   *   The grant can be revoked mid-session, and nothing purges this cache when
   *   it is: capabilities and lookups are two independent queries. So the
   *   answer produced under the grant must live at an address the
   *   post-revocation render never reads from. It is the same rule
   *   customerKeys.search follows, for the same reason.
   *
   * Pass `capabilities.canSensitive("customers.view_sensitive")`, never
   * `can(...)` — a snapshot whose latest refresh failed must not keep a
   * grant-era entry addressable.
   */
  lookup: (userId: string, organizationId: string, normalizedQuery: string, sensitive: boolean) =>
    [APSI_QUERY_ROOT, userId, organizationId, "lookup", sensitive, normalizedQuery] as const,
};

export const APSI_QUERY_PREFIX = partition.prefix;
export const clearApsiQueries = partition.clear;
export const enforceApsiCachePrincipal = partition.enforce;
