/**
 * Server resolver for the caller's canonical active organization.
 *
 * Every principal-scoped API (src/api/*) resolves its organization through
 * here, so capabilities, Home, Analytics, Customers, Orders, Payments,
 * Inventory, Delivery, Settings and Team all act on the same organization the
 * /app guard selected. The choice itself is pickCanonicalActiveMembership in
 * src/lib/active-organization.ts.
 *
 * `userId` must come from the validated cookie session — never client input.
 * supabaseAdmin is imported dynamically so this module stays out of any
 * browser chunk that might reference it.
 */
import {
  CANONICAL_MEMBERSHIP_ORDER,
  pickCanonicalActiveMembership,
  type MembershipCandidate,
} from "@/lib/active-organization";

/**
 * The organization id of the caller's canonical active membership, or null
 * when they have none. Throws when the membership read itself fails, so a
 * database error can never be mistaken for "no membership" or for a
 * different organization.
 */
export async function resolveActiveOrganizationId(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id, status, joined_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order(CANONICAL_MEMBERSHIP_ORDER.column, {
      ascending: CANONICAL_MEMBERSHIP_ORDER.ascending,
    });

  if (error) throw new Error("Unable to resolve active organization membership");
  const picked = pickCanonicalActiveMembership((data ?? []) as MembershipCandidate[]);
  return picked ? picked.organization_id : null;
}
