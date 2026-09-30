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
import type { MembershipWithAuthority } from "./membership";

/**
 * The organization id of the caller's canonical active membership, or null
 * when they have none. Throws when the membership read itself fails, so a
 * database error can never be mistaken for "no membership" or for a
 * different organization.
 */
export async function resolveActiveOrganizationId(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  // Timing only (staging/development, APSA_PERF_INSTRUMENTATION); a
  // pass-through when off.
  const { timePhase } = await import("@/server/observability/perf");
  const { MEMBERSHIP_CONTEXT_SELECT, toMembershipContext } = await import("./membership");
  const { parkPrefetchedMembership } = await import("./membership-prefetch");
  // The same active-membership read as before, with each row's role and
  // permission keys embedded (one round trip), so the verifyActiveMembership
  // that follows in this server-function call need not read it again.
  const { data, error } = await timePhase("authz.activeOrganization", async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("memberships")
      .select(MEMBERSHIP_CONTEXT_SELECT)
      .eq("user_id", userId)
      .eq("status", "active")
      .order(CANONICAL_MEMBERSHIP_ORDER.column, {
        ascending: CANONICAL_MEMBERSHIP_ORDER.ascending,
      }),
  );

  if (error) {
    parkPrefetchedMembership(userId, null, null);
    throw new Error("Unable to resolve active organization membership");
  }
  const rows = (data ?? []) as Array<MembershipCandidate & MembershipWithAuthority>;
  const picked = pickCanonicalActiveMembership(rows);
  if (!picked) {
    parkPrefetchedMembership(userId, null, null);
    return null;
  }
  // Hand the picked row's authority to the verify step of this same call. A
  // row whose role or permissions could not be shaped is not parked, so the
  // verify step reads the database itself and fails closed as before.
  parkPrefetchedMembership(userId, picked.organization_id, toMembershipContext(picked));
  return picked.organization_id;
}
