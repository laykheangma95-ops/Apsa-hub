/**
 * Customer cache identity, and the one rule for showing customer PII.
 *
 * This is the strictest partition in the app. A cached customer payload can
 * carry a phone number, a delivery address, a social identity handle and an
 * order history — the exact fields SECURITY.md gates behind
 * `customers.view_sensitive`. Before this module those payloads lived under
 * `["customers"]`, `["customer", id]`, `["customer360", id]`,
 * `["customer-orders", id]` and `["pos-customers", query]`: no principal in
 * any of them, so Organization A's customer list was readable, unchanged, by
 * whoever mounted the Inbox next in the same browser tab.
 *
 * Partitioned by user AND organization — never organization alone. Within one
 * organization, `customers.view_sensitive` is exactly the grant that differs
 * between members, and it changes what the SERVER puts in the payload (phone
 * comes back as "" without it, address is omitted entirely). An
 * organization-only key would let a member who holds the grant fill the cache
 * and a member who does not read the populated phone straight back out of it.
 *
 * Cache identity only. src/server/customers/service.ts requires
 * `customers.read` before any row is read, decides `sensitiveVisible` itself
 * from the resolved membership, and withholds the sensitive values rather than
 * trusting the browser to hide them.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const CUSTOMERS_QUERY_ROOT = "customers";

const partition = createQueryPartition(CUSTOMERS_QUERY_ROOT);

export const customerKeys = {
  /**
   * Everything this principal has cached from the Customer domain — the list,
   * every profile, every cached order history and every search result.
   *
   * The invalidation target after a customer mutation, and the eviction target
   * the moment `customers.view_sensitive` stops holding.
   */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /** One page of the customer list (`offset` is part of the identity). */
  list: (userId: string, organizationId: string, offset: number) =>
    [CUSTOMERS_QUERY_ROOT, userId, organizationId, "list", offset] as const,
  /** One customer's profile — the Customer 360 payload and the Inbox lookup. */
  detail: (userId: string, organizationId: string, customerId: string) =>
    [CUSTOMERS_QUERY_ROOT, userId, organizationId, "detail", customerId] as const,
  /**
   * One customer's order history.
   *
   * A sub-key of that customer rather than an Order-domain key: it is a
   * customer-scoped projection, fetched by and discarded with the customer
   * surface that shows it.
   */
  orders: (userId: string, organizationId: string, customerId: string) =>
    [CUSTOMERS_QUERY_ROOT, userId, organizationId, "detail", customerId, "orders"] as const,
  /**
   * The lightweight customer-picker list (`listRealCustomers` ->
   * `OrderCustomerOption[]`), as the manual order-create sheet loads it.
   *
   * A key of its own rather than a reuse of `list` above, because the payload
   * is a different shape: `list` holds a `CustomerListPage` of mapped UI
   * `Customer` rows, this holds the raw server option rows. Two shapes under
   * one key would let whichever query ran first hand the other a payload it
   * cannot read.
   */
  options: (userId: string, organizationId: string) =>
    [CUSTOMERS_QUERY_ROOT, userId, organizationId, "options"] as const,
  /**
   * A customer-picker search term's results (POS, order create).
   *
   * `sensitive` is part of the identity, not decoration. A result set matched
   * while `customers.view_sensitive` held was matched against real phone
   * numbers; one matched without it was not. They are different answers to the
   * same term, so they must be different entries — otherwise the grant-era set
   * is served straight back after the grant is revoked, and which customers
   * come back for a typed fragment still answers "does a customer with this
   * number exist here?" even though every number on screen is blanked.
   */
  search: (userId: string, organizationId: string, term: string, sensitive: boolean) =>
    [CUSTOMERS_QUERY_ROOT, userId, organizationId, "search", sensitive, term] as const,
};

export const CUSTOMERS_QUERY_PREFIX = partition.prefix;
export const clearCustomerQueries = partition.clear;
export const enforceCustomerCachePrincipal = partition.enforce;

// ── Sensitive-field masking ──────────────────────────────────────────────────

/**
 * The phone a customer may show THIS render, gated on the CURRENT capability
 * state rather than on what the cached payload happens to carry.
 *
 * This is the same class of defect PR #59 found in the Payments reconciliation
 * band, in the Customer domain: a profile fetched while the member held
 * `customers.view_sensitive` stays in the React Query cache — keyed by
 * userId + organizationId, not by permission — until the next successful
 * refetch. If that grant is revoked mid-session, or the capability snapshot's
 * latest refresh fails, nothing purges or refetches that payload on its own:
 * capabilities and customer data are two independent queries. So every surface
 * that displays a phone MUST route it through here rather than reading
 * `customer.phone` directly, and the value disappears on the very next render
 * instead of waiting for a refetch or an invalidation.
 *
 * `canViewSensitive` must itself already be fail-closed. Pass
 * `capabilities.canSensitive("customers.view_sensitive")`, not `can(...)`: a
 * phone number's mere display is the disclosure, so it must not ride on a
 * snapshot whose latest refresh failed (see CapabilityView.stale).
 *
 * Returns "" — the same value the server sends when it withholds the field —
 * so a caller cannot tell a masked phone from an absent one, and neither can
 * the merchant. That is deliberate: the UI must not disclose which of the two
 * it is.
 */
export function visibleCustomerPhone(
  customer: { phone: string; sensitiveVisible?: boolean },
  canViewSensitive: boolean,
): string {
  if (!canViewSensitive) return "";
  // The server's own answer still wins when it said no: a payload it built
  // with the field withheld is never "unmasked" by a later capability read.
  if (customer.sensitiveVisible === false) return "";
  return customer.phone;
}

/**
 * Whether a customer surface may render its sensitive band at all (phone,
 * address, lifetime spend), combining the two independent answers:
 *
 *   1. the CURRENT capability state — fail-closed, and refusing a snapshot the
 *      server has not just confirmed; and
 *   2. what the SERVER decided when it built this payload (`sensitiveVisible`)
 *      — authoritative, and never overridden by a client-side read.
 *
 * Both must say yes. Reading (2) alone — which is what Customer 360 did — is
 * the stale-cache defect: a payload fetched under a grant that has since been
 * revoked still says `sensitiveVisible: true` forever.
 */
export function customerSensitiveVisible(
  customer: { sensitiveVisible?: boolean } | undefined,
  canViewSensitive: boolean,
): boolean {
  if (!canViewSensitive) return false;
  return customer?.sensitiveVisible !== false;
}
