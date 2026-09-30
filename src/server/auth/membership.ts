/**
 * Server-side membership verification.
 *
 * Every protected server action must call verifyActiveMembership before proceeding.
 * The application layer — not RLS alone — is the authoritative authorization boundary.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { MembershipRow, RoleRow } from "@/lib/supabase/types";
import { timePhase } from "@/server/observability/perf";
import { takePrefetchedMembership } from "./membership-prefetch";

export interface MembershipContext {
  membership: MembershipRow;
  role: RoleRow;
  permissions: Set<string>;
}

/**
 * One PostgREST select that returns a membership row together with its role
 * and that role's permission keys, embedded through the real foreign keys
 * (memberships.role_id → roles.id, role_permissions.role_id → roles.id,
 * role_permissions.permission_id → permissions.id). It replaces the former
 * four sequential reads (memberships → roles → role_permissions → permissions)
 * with one round trip; every value still comes from the database.
 */
export const MEMBERSHIP_CONTEXT_SELECT =
  "*, role:roles(*, role_permissions(permission:permissions(key)))";

type EmbeddedRole = RoleRow & {
  role_permissions?: Array<{ permission: { key: unknown } | null }> | null;
};

/** A memberships row as returned by MEMBERSHIP_CONTEXT_SELECT. */
export type MembershipWithAuthority = MembershipRow & { role?: EmbeddedRole | null };

/**
 * Shape one embedded row into a MembershipContext, or null (fail closed) when
 * any part of the authority chain is missing or inconsistent.
 */
export function toMembershipContext(row: MembershipWithAuthority): MembershipContext | null {
  const { role: embeddedRole, ...membership } = row;
  if (!embeddedRole) return null;
  const { role_permissions: rolePermissions, ...role } = embeddedRole;
  // The embedded role must be exactly the membership's role.
  if (role.id !== membership.role_id) return null;
  if (!Array.isArray(rolePermissions)) return null;

  const permissions = new Set<string>();
  for (const rp of rolePermissions) {
    const key = rp?.permission?.key;
    if (typeof key === "string") permissions.add(key);
  }
  return { membership: membership as MembershipRow, role: role as RoleRow, permissions };
}

/**
 * Verify that userId has an ACTIVE membership in organizationId.
 *
 * CRITICAL: organizationId must come from a trusted server-side source
 * (URL param validated by slug lookup, or stored session), NOT from
 * a client-provided request body. The caller is responsible for this.
 *
 * Returns the membership context (role + permissions) or null if the
 * user has no active membership.
 */
export async function verifyActiveMembership(
  userId: string,
  organizationId: string,
): Promise<MembershipContext | null> {
  // Timing only (staging/development, APSA_PERF_INSTRUMENTATION): a
  // pass-through when off; results and errors are never altered.
  return timePhase("authz.verifyMembership", () => loadMembershipContext(userId, organizationId));
}

async function loadMembershipContext(
  userId: string,
  organizationId: string,
): Promise<MembershipContext | null> {
  // Same server-function call, same user AND organization, read moments ago by
  // resolveActiveOrganizationId with the identical embedded select: reuse it
  // once instead of reading it again (see ./membership-prefetch.ts).
  const prefetched = takePrefetchedMembership(userId, organizationId);
  if (prefetched) return prefetched;

  const { data: rawMembership, error } = await timePhase("authz.membershipContext", async () =>
    supabaseAdmin
      .from("memberships")
      .select(MEMBERSHIP_CONTEXT_SELECT)
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .single(),
  );

  if (error || !rawMembership) return null;
  const row = rawMembership as unknown as MembershipWithAuthority;
  // Defense in depth: the row must be exactly what was asked for.
  if (row.user_id !== userId || row.organization_id !== organizationId) return null;
  if (row.status !== "active") return null;
  return toMembershipContext(row);
}

/**
 * Resolve an organization's UUID from its slug.
 * Slug is safe to accept from the URL; ID must be verified via this lookup.
 */
export async function resolveOrganizationId(slug: string): Promise<string | null> {
  const { data: rawData, error } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .single();

  if (error || !rawData) return null;
  const data = rawData as unknown as { id: string };
  return data.id;
}
