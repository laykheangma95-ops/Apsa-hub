/**
 * Server-side membership verification.
 *
 * Every protected server action must call verifyActiveMembership before proceeding.
 * The application layer — not RLS alone — is the authoritative authorization boundary.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { MembershipRow, RoleRow, PermissionRow } from "@/lib/supabase/types";

export interface MembershipContext {
  membership: MembershipRow;
  role: RoleRow;
  permissions: Set<string>;
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
  const { data: rawMembership, error } = await supabaseAdmin
    .from("memberships")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .single();

  if (error || !rawMembership) return null;
  const membership = rawMembership as unknown as MembershipRow;

  const { data: rawRole, error: roleError } = await supabaseAdmin
    .from("roles")
    .select("*")
    .eq("id", membership.role_id)
    .single();

  if (roleError || !rawRole) return null;
  const role = rawRole as unknown as RoleRow;

  const { data: rolePermissions, error: rpError } = await supabaseAdmin
    .from("role_permissions")
    .select("permission_id")
    .eq("role_id", role.id);

  if (rpError) return null;

  const permissionIds = ((rolePermissions ?? []) as unknown as Array<{ permission_id: string }>).map(
    (rp) => rp.permission_id,
  );

  let permissions = new Set<string>();
  if (permissionIds.length > 0) {
    const { data: permRows } = await supabaseAdmin
      .from("permissions")
      .select("key")
      .in("id", permissionIds);

    permissions = new Set(
      ((permRows ?? []) as unknown as Array<Pick<PermissionRow, "key">>).map((p) => p.key),
    );
  }

  return { membership, role, permissions };
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
