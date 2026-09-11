/**
 * Database row types for the team/membership/invitation domain.
 *
 * Membership/Role/Profile row shapes already exist in the generated
 * src/lib/supabase/types.ts (migrations 001, 003, 006). InvitationRow is
 * hand-authored here — same temporary-cast convention as
 * src/server/customers/types.ts — because migration 041 predates the last
 * `supabase gen types typescript` run. After migrations are applied to the
 * live project and types are regenerated, this can be replaced with
 * Database["public"]["Tables"]["invitations"]["Row"].
 */
export type {
  Membership as MembershipRow,
  Role as RoleRow,
  Profile as ProfileRow,
} from "@/lib/supabase/types";

export type InvitationStatus = "pending" | "accepted" | "cancelled" | "expired";

/**
 * Snapshot of the issuer's system role at the moment the invitation was
 * created — 'OWNER' or 'MANAGER' (the only two roles 003_roles_permissions.sql
 * grants `team.invite` to). accept_invitation() (migration 041) uses this,
 * not the invitation's own role_id, to decide whether reactivating an
 * existing Owner/Manager-grade membership is allowed (CORRECTION-001).
 */
export type InvitationIssuerRole = "OWNER" | "MANAGER";

export interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role_id: string;
  status: InvitationStatus;
  token_hash: string;
  invited_by: string;
  invited_display_name: string | null;
  issued_by_role: InvitationIssuerRole;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  cancelled_at: string | null;
}

/** A membership row joined with its profile and role — the shape list/detail views need. */
export interface MembershipWithProfileAndRole {
  id: string;
  user_id: string;
  organization_id: string;
  role_id: string;
  status: "active" | "invited" | "suspended" | "removed";
  joined_at: string;
  invited_by: string | null;
  profile: {
    display_name: string | null;
    email: string;
    phone: string | null;
  };
  role: {
    name: string;
    system_role: string | null;
  };
}
