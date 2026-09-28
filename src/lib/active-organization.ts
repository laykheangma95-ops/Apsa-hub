/**
 * The ONE rule for which organization a multi-membership user is acting in.
 *
 * The schema allows a user to hold memberships in several organizations, and
 * V1 has no workspace switcher, so every principal-scoped surface must derive
 * the same default organization from the same membership rows. Before this
 * module the /app guard, Home and Analytics took the OLDEST active membership
 * (joined_at ASC) while capabilities, Customers, Orders, Payments and every
 * other domain API took the NEWEST (joined_at DESC): a member of two
 * organizations saw Home for one, acted in Customers on the other, and cached
 * both under the guard's organization id.
 *
 * Canonical rule (V1): among ACTIVE memberships, the most recently joined
 * wins — `joined_at DESC`, then `organization_id DESC` as a deterministic
 * tie-breaker for equal timestamps. DESC is the rule the majority of trusted
 * domain APIs (and resolveAuthContext's documented contract in
 * src/api/capabilities.ts) already applied.
 *
 * Pure and safe to bundle for the browser. The server resolver in
 * src/server/auth/active-organization.ts and the /app guard both pick through
 * this function; nothing else may choose among membership rows.
 */

export interface MembershipCandidate {
  organization_id: string;
  status: string;
  joined_at: string;
}

/** The ordering the database query should use; the picker below is authoritative. */
export const CANONICAL_MEMBERSHIP_ORDER = { column: "joined_at", ascending: false } as const;

function compareCanonical(a: MembershipCandidate, b: MembershipCandidate): number {
  const at = Date.parse(a.joined_at);
  const bt = Date.parse(b.joined_at);
  const aTime = Number.isNaN(at) ? -Infinity : at;
  const bTime = Number.isNaN(bt) ? -Infinity : bt;
  if (aTime !== bTime) return bTime - aTime; // newest first
  if (a.organization_id === b.organization_id) return 0;
  return a.organization_id < b.organization_id ? 1 : -1; // organization_id DESC
}

/**
 * The canonical active membership among `rows`, or null when none is active.
 * Row order is irrelevant: the result depends only on the row values.
 */
export function pickCanonicalActiveMembership<T extends MembershipCandidate>(
  rows: readonly T[],
): T | null {
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 0) return null;
  return [...active].sort(compareCanonical)[0] ?? null;
}
