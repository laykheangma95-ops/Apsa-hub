/**
 * Team/membership/invitation repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id so RLS + application code are both layered.
 *   - Use supabaseAdmin (service-role) so writes can bypass RLS where the application
 *     layer has already performed authorization; RLS remains as defense-in-depth.
 *
 * supabaseAdmin is cast to `any` for the new `invitations` table (migration 041,
 * not yet in the generated schema types) — same convention as
 * src/server/customers/repository.ts.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { InvitationRow, MembershipWithProfileAndRole } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

const MEMBERSHIP_SELECT = "*, profiles(display_name, email, phone), roles(name, system_role)";

interface RawMembershipJoin {
  id: string;
  user_id: string;
  organization_id: string;
  role_id: string;
  status: "active" | "invited" | "suspended" | "removed";
  joined_at: string;
  invited_by: string | null;
  profiles: { display_name: string | null; email: string; phone: string | null } | null;
  roles: { name: string; system_role: string | null } | null;
}

function toMembershipWithProfileAndRole(row: RawMembershipJoin): MembershipWithProfileAndRole {
  return {
    id: row.id,
    user_id: row.user_id,
    organization_id: row.organization_id,
    role_id: row.role_id,
    status: row.status,
    joined_at: row.joined_at,
    invited_by: row.invited_by,
    profile: {
      display_name: row.profiles?.display_name ?? null,
      email: row.profiles?.email ?? "",
      phone: row.profiles?.phone ?? null,
    },
    role: {
      name: row.roles?.name ?? "",
      system_role: row.roles?.system_role ?? null,
    },
  };
}

// ── Memberships ──────────────────────────────────────────────────────────────

/** Every membership in the org except hard-removed ones (active + suspended, newest first). */
export async function listMemberships(
  organizationId: string,
): Promise<MembershipWithProfileAndRole[]> {
  const { data, error } = await db
    .from("memberships")
    .select(MEMBERSHIP_SELECT)
    .eq("organization_id", organizationId)
    .in("status", ["active", "suspended"])
    .order("joined_at", { ascending: true });

  if (error) throw new Error(`listMemberships: ${(error as { message: string }).message}`);
  return ((data ?? []) as RawMembershipJoin[]).map(toMembershipWithProfileAndRole);
}

export async function findMembershipById(
  organizationId: string,
  membershipId: string,
): Promise<MembershipWithProfileAndRole | null> {
  const { data, error } = await db
    .from("memberships")
    .select(MEMBERSHIP_SELECT)
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`findMembershipById: ${(error as { message: string }).message}`);
  return data ? toMembershipWithProfileAndRole(data as RawMembershipJoin) : null;
}

export async function countActiveMembers(organizationId: string): Promise<number> {
  const { count, error } = await db
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (error) throw new Error(`countActiveMembers: ${(error as { message: string }).message}`);
  return count ?? 0;
}

export async function updateMembershipRole(
  organizationId: string,
  membershipId: string,
  roleId: string,
): Promise<MembershipWithProfileAndRole | null> {
  const { data, error } = await db
    .from("memberships")
    .update({ role_id: roleId })
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .select(MEMBERSHIP_SELECT)
    .maybeSingle();

  if (error) throw new Error(`updateMembershipRole: ${(error as { message: string }).message}`);
  return data ? toMembershipWithProfileAndRole(data as RawMembershipJoin) : null;
}

export async function updateMembershipStatus(
  organizationId: string,
  membershipId: string,
  status: "active" | "suspended",
): Promise<MembershipWithProfileAndRole | null> {
  const { data, error } = await db
    .from("memberships")
    .update({ status })
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .select(MEMBERSHIP_SELECT)
    .maybeSingle();

  if (error) throw new Error(`updateMembershipStatus: ${(error as { message: string }).message}`);
  return data ? toMembershipWithProfileAndRole(data as RawMembershipJoin) : null;
}

// ── Invitations ──────────────────────────────────────────────────────────────

export async function listPendingInvitations(organizationId: string): Promise<InvitationRow[]> {
  const { data, error } = await db
    .from("invitations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`listPendingInvitations: ${(error as { message: string }).message}`);
  return (data ?? []) as InvitationRow[];
}

export async function findInvitationById(
  organizationId: string,
  invitationId: string,
): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("invitations")
    .select("*")
    .eq("id", invitationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`findInvitationById: ${(error as { message: string }).message}`);
  return data ? (data as InvitationRow) : null;
}

export async function findPendingInvitationByEmail(
  organizationId: string,
  email: string,
): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("invitations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .ilike("email", email.trim())
    .maybeSingle();

  if (error) {
    throw new Error(`findPendingInvitationByEmail: ${(error as { message: string }).message}`);
  }
  return data ? (data as InvitationRow) : null;
}

export async function createInvitation(
  organizationId: string,
  input: {
    email: string;
    role_id: string;
    token_hash: string;
    invited_by: string;
    invited_display_name?: string | null;
    expires_at: string;
  },
): Promise<InvitationRow> {
  const { data, error } = await db
    .from("invitations")
    .insert({
      organization_id: organizationId,
      email: input.email.trim().toLowerCase(),
      role_id: input.role_id,
      token_hash: input.token_hash,
      invited_by: input.invited_by,
      invited_display_name: input.invited_display_name ?? null,
      expires_at: input.expires_at,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`createInvitation: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as InvitationRow;
}

/** Resend: rotates the token and expiry on the existing pending row (never a new row). */
export async function reissueInvitation(
  organizationId: string,
  invitationId: string,
  input: { token_hash: string; expires_at: string },
): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("invitations")
    .update({ token_hash: input.token_hash, expires_at: input.expires_at })
    .eq("id", invitationId)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`reissueInvitation: ${(error as { message: string }).message}`);
  return data ? (data as InvitationRow) : null;
}

export async function cancelInvitation(
  organizationId: string,
  invitationId: string,
): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("invitations")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`cancelInvitation: ${(error as { message: string }).message}`);
  return data ? (data as InvitationRow) : null;
}

/**
 * Lookup by token only — used for the accept-invite preview, which runs
 * before the caller has any org membership to scope the query by. Safe
 * because the raw token itself (proven only by its hash matching) is the
 * credential here, not organization membership.
 */
export async function findInvitationByTokenHash(tokenHash: string): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("invitations")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`findInvitationByTokenHash: ${(error as { message: string }).message}`);
  }
  return data ? (data as InvitationRow) : null;
}

export async function findOrganizationDisplayName(organizationId: string): Promise<string | null> {
  const { data, error } = await db
    .from("organizations")
    .select("display_name")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`findOrganizationDisplayName: ${(error as { message: string }).message}`);
  }
  return (data as { display_name: string } | null)?.display_name ?? null;
}

export async function findRoleById(
  roleId: string,
): Promise<{ id: string; name: string; system_role: string | null } | null> {
  const { data, error } = await db
    .from("roles")
    .select("id, name, system_role")
    .eq("id", roleId)
    .maybeSingle();
  if (error) throw new Error(`findRoleById: ${(error as { message: string }).message}`);
  return data as { id: string; name: string; system_role: string | null } | null;
}
