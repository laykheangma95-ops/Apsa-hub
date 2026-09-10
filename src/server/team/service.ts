/**
 * Team/membership service — business logic layer.
 *
 * All public functions that take an AuthorizationContext:
 *   1. Check the required permission before touching the DB.
 *   2. Delegate raw DB operations to the repository.
 *   3. Map DB rows to domain/API shapes.
 *
 * Role escalation guards (self-promotion / cross-tenant / owner protection):
 *   - An invitation or role-change can never target the OWNER role — enforced
 *     both here (assertInvitableRole) and at the database (migration 041's
 *     invitations_role_org_integrity trigger). Ownership transfer is a
 *     separate, not-yet-built secure workflow (PERMISSIONS_MATRIX.md §41) —
 *     out of scope here by design, which is what makes self-promotion via
 *     this surface structurally impossible rather than merely checked.
 *   - A non-owner actor can never modify a membership whose CURRENT role is
 *     OWNER (change its role or its active/suspended status) — closes the
 *     "manager disables/demotes the owner" escalation path.
 *   - Manager authority is capped strictly BELOW Manager (CORRECTION-001,
 *     see CORRECTIONS.md): a non-owner can never assign the Manager role,
 *     and can never modify a membership whose CURRENT role is Manager
 *     (role change, deactivate, or reactivate). Migration 042 grants
 *     `team.roles_assign` to the MANAGER system role as a coarse permission
 *     bit only — assertRoleAuthority() below is what keeps that grant from
 *     being read as "Manager may promote/demote peers or self-promote".
 *   - Every query is scoped by ctx.organizationId, which itself is derived
 *     server-side from the caller's verified membership — Org A can never
 *     reach Org B's roster, regardless of any id passed in.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { assertOwnerWouldRemain } from "@/server/auth/authorization";
import { auditLog, auditLogRequired } from "@/server/auth/audit";
import * as repo from "./repository";
import { TeamError } from "./errors";
import { generateInviteToken, hashInviteToken, inviteExpiryFromNow } from "./invite-token";
import { SYSTEM_ROLE_IDS } from "@/lib/supabase/types";
import type { MembershipWithProfileAndRole } from "./types";

export type InvitableRoleKey = "manager" | "cashier" | "sales" | "customer_service";
export type StaffRoleKey = "owner" | InvitableRoleKey;

const ROLE_ID_TO_KEY: Record<string, StaffRoleKey> = {
  [SYSTEM_ROLE_IDS.OWNER]: "owner",
  [SYSTEM_ROLE_IDS.MANAGER]: "manager",
  [SYSTEM_ROLE_IDS.CASHIER]: "cashier",
  [SYSTEM_ROLE_IDS.SALES]: "sales",
  [SYSTEM_ROLE_IDS.CUSTOMER_SERVICE]: "customer_service",
};

const ROLE_KEY_TO_ID: Record<InvitableRoleKey, string> = {
  manager: SYSTEM_ROLE_IDS.MANAGER,
  cashier: SYSTEM_ROLE_IDS.CASHIER,
  sales: SYSTEM_ROLE_IDS.SALES,
  customer_service: SYSTEM_ROLE_IDS.CUSTOMER_SERVICE,
};

/**
 * No org in this codebase can create a custom (non-system) role yet — nothing
 * builds `roles.manage`. A role_id that isn't one of the five seeded system
 * roles is therefore unreachable today; fail loudly rather than silently
 * mislabel someone's access level if that ever changes.
 */
function roleKeyFromRoleId(roleId: string): StaffRoleKey {
  const key = ROLE_ID_TO_KEY[roleId];
  if (!key) throw new Error(`unsupported_custom_role: ${roleId}`);
  return key;
}

function assertInvitableRole(role: string): asserts role is InvitableRoleKey {
  if (!(role in ROLE_KEY_TO_ID)) {
    throw new TeamError("owner_role_forbidden");
  }
}

/**
 * CORRECTION-001 (2026-09-10, owner-approved): Manager's `team.roles_assign`
 * grant (migration 042) is capped strictly BELOW Manager.
 *   - Owner may assign/change the Manager role.
 *   - Manager may assign/change only roles below Manager (Cashier, Sales,
 *     Customer Service) and may never touch a membership that is CURRENTLY
 *     Manager (another manager's, or their own — self-promotion/self-protection
 *     is denied the same way as any other manager row, which is intentional:
 *     the owner is the only actor who can grant or take away Manager).
 *   - Owner is never subject to this cap — call this only for the branches
 *     that already know the actor is not the owner.
 */
function assertRoleAuthority(ctx: AuthorizationContext, role: StaffRoleKey): void {
  if (ctx.isOwner()) return;
  if (role === "manager" || role === "owner") {
    throw new TeamError("insufficient_role_authority");
  }
}

/**
 * CORRECTION-001: the authority check every action that touches an EXISTING
 * membership/invitation must apply against that row's CURRENT (or, for an
 * invitation, its offered) role — never only against the new role being
 * requested. Owner rows get their own error code (cannot_modify_owner,
 * since "insufficient authority" reads oddly for "you can never touch the
 * owner"); Manager-and-below rows go through assertRoleAuthority(), which
 * already treats "currently Manager" as off-limits to any non-owner.
 *
 * Shared by changeRole/deactivateMember/reactivateMember (against a target
 * membership's current role) and inviteStaff/resendInvite/cancelInvite
 * (against a target membership's current role or an invitation's offered
 * role) so the same rule can't drift between the "existing person" paths
 * and the "invite/resend/cancel" paths.
 */
function assertAuthorityOverRole(ctx: AuthorizationContext, role: StaffRoleKey): void {
  if (role === "owner") {
    if (!ctx.isOwner()) throw new TeamError("cannot_modify_owner");
    return;
  }
  assertRoleAuthority(ctx, role);
}

// ── Roster ───────────────────────────────────────────────────────────────────

export interface TeamRosterEntry {
  id: string;
  name: string;
  role: StaffRoleKey;
  status: "active" | "suspended" | "invited";
  email: string | null;
  phone: string | null;
  invitedAt: string | null;
}

function toRosterEntry(m: MembershipWithProfileAndRole): TeamRosterEntry {
  return {
    id: m.id,
    name: m.profile.display_name || m.profile.email,
    role: roleKeyFromRoleId(m.role_id),
    status: m.status === "suspended" ? "suspended" : "active",
    email: m.profile.email,
    phone: m.profile.phone,
    invitedAt: null,
  };
}

export async function listTeam(ctx: AuthorizationContext): Promise<TeamRosterEntry[]> {
  ctx.require("team.read");

  const [memberships, invitations] = await Promise.all([
    repo.listMemberships(ctx.organizationId),
    repo.listPendingInvitations(ctx.organizationId),
  ]);

  const members = memberships.map(toRosterEntry);

  const now = Date.now();
  const invited: TeamRosterEntry[] = invitations
    .filter((i) => new Date(i.expires_at).getTime() > now)
    .map((i) => ({
      id: i.id,
      name: i.invited_display_name || i.email,
      role: roleKeyFromRoleId(i.role_id),
      status: "invited" as const,
      email: i.email,
      phone: null,
      invitedAt: i.created_at,
    }));

  return [...members, ...invited];
}

// ── Invite ───────────────────────────────────────────────────────────────────

export interface InviteStaffInput {
  email: string;
  displayName: string;
  role: InvitableRoleKey;
}

export interface InviteStaffResult {
  invitation: TeamRosterEntry;
  /** Raw, one-time token — never persisted. The caller builds the shareable link. */
  inviteToken: string;
}

export async function inviteStaff(
  ctx: AuthorizationContext,
  input: InviteStaffInput,
): Promise<InviteStaffResult> {
  ctx.require("team.invite");
  assertInvitableRole(input.role);
  assertRoleAuthority(ctx, input.role);

  const email = input.email.trim().toLowerCase();
  if (!email) throw new TeamError("invalid_input");

  // CORRECTION-001: authority is checked against the TARGET PERSON's current
  // role, not just the role being offered — a Manager must not be able to
  // invite an address that already belongs to an Owner/Manager-grade
  // membership (active, suspended, or removed) at a lower role, since that
  // invitation could later be accepted and reactivate that membership. This
  // is a defense-in-depth check at invite time; accept_invitation() (migration
  // 041) re-checks independently at accept time against the row's role as it
  // stands then, since it can change while the invitation is outstanding.
  const existingTarget = await repo.findMembershipByEmail(ctx.organizationId, email);
  if (existingTarget) {
    assertAuthorityOverRole(ctx, roleKeyFromRoleId(existingTarget.role_id));
  }

  const existingPending = await repo.findPendingInvitationByEmail(ctx.organizationId, email);
  if (existingPending) {
    // A pending invite whose TTL has already elapsed never got flipped to
    // `expired` by anything (nothing sweeps it) — it must not permanently
    // block re-inviting the same address. Retire the stale row first so the
    // partial unique index on (organization_id, lower(email)) WHERE
    // status='pending' has room for the new one; a genuinely still-pending
    // invite is the only case that is a real duplicate.
    if (new Date(existingPending.expires_at).getTime() <= Date.now()) {
      await repo.expireInvitation(ctx.organizationId, existingPending.id);
    } else {
      throw new TeamError("duplicate_invitation");
    }
  }

  const rawToken = generateInviteToken();
  let invitation;
  try {
    invitation = await repo.createInvitation(ctx.organizationId, {
      email,
      role_id: ROLE_KEY_TO_ID[input.role],
      token_hash: hashInviteToken(rawToken),
      invited_by: ctx.userId,
      invited_display_name: input.displayName.trim() || null,
      expires_at: inviteExpiryFromNow(),
      // Snapshot the issuer's authority now — team.invite is only ever
      // granted to OWNER or MANAGER (003_roles_permissions.sql), so this is
      // exhaustive. accept_invitation() uses this, not the invited role, to
      // gate reactivating an existing Owner/Manager-grade membership.
      issued_by_role: ctx.isOwner() ? "OWNER" : "MANAGER",
    });
  } catch (err) {
    // Two concurrent invites for the same address can both pass the
    // pre-check above and race to insert — the unique index is the real
    // guard; map its violation to the same error the pre-check would have
    // thrown, rather than surfacing a raw 500.
    if (err instanceof repo.InvitationConflictError) throw new TeamError("duplicate_invitation");
    throw err;
  }

  await auditLog(ctx, {
    action: "team.invite",
    resourceType: "invitations",
    resourceId: invitation.id,
    afterJson: { email, role: input.role },
  });

  return {
    invitation: {
      id: invitation.id,
      name: invitation.invited_display_name || invitation.email,
      role: input.role,
      status: "invited",
      email: invitation.email,
      phone: null,
      invitedAt: invitation.created_at,
    },
    inviteToken: rawToken,
  };
}

export async function resendInvite(
  ctx: AuthorizationContext,
  invitationId: string,
): Promise<InviteStaffResult> {
  ctx.require("team.invite");

  const existing = await repo.findInvitationById(ctx.organizationId, invitationId);
  if (!existing || existing.status !== "pending") throw new TeamError("invitation_not_found");
  // CORRECTION-001: a Manager cannot resend a Manager-grade invitation
  // (their own or one an Owner issued to someone else) — resending mints a
  // fresh, longer-lived credential for that grant, which is itself an act
  // of authority over it.
  assertAuthorityOverRole(ctx, roleKeyFromRoleId(existing.role_id));

  const rawToken = generateInviteToken();
  const updated = await repo.reissueInvitation(ctx.organizationId, invitationId, {
    token_hash: hashInviteToken(rawToken),
    expires_at: inviteExpiryFromNow(),
  });
  if (!updated) throw new TeamError("invitation_not_found");

  // Best-effort, same tier as team.invite (creating the original invite) —
  // resend mints a fresh credential (new token, new expiry) and is worth a
  // record, but should not block a legitimate resend if the audit write fails.
  await auditLog(ctx, {
    action: "team.invite_resend",
    resourceType: "invitations",
    resourceId: updated.id,
    afterJson: { email: updated.email },
  });

  return {
    invitation: {
      id: updated.id,
      name: updated.invited_display_name || updated.email,
      role: roleKeyFromRoleId(updated.role_id),
      status: "invited",
      email: updated.email,
      phone: null,
      invitedAt: updated.created_at,
    },
    inviteToken: rawToken,
  };
}

export async function cancelInvite(
  ctx: AuthorizationContext,
  invitationId: string,
): Promise<string> {
  ctx.require("team.invite");

  const existing = await repo.findInvitationById(ctx.organizationId, invitationId);
  if (!existing || existing.status !== "pending") throw new TeamError("invitation_not_found");
  // CORRECTION-001: a Manager cannot cancel a Manager-grade invitation —
  // same authority boundary as resend above.
  assertAuthorityOverRole(ctx, roleKeyFromRoleId(existing.role_id));

  const cancelled = await repo.cancelInvitation(ctx.organizationId, invitationId);
  if (!cancelled) throw new TeamError("invitation_not_found");

  await auditLog(ctx, {
    action: "team.invite_cancel",
    resourceType: "invitations",
    resourceId: invitationId,
    afterJson: { email: cancelled.email },
  });

  return invitationId;
}

// ── Role change ──────────────────────────────────────────────────────────────

export async function changeRole(
  ctx: AuthorizationContext,
  membershipId: string,
  role: InvitableRoleKey,
): Promise<TeamRosterEntry> {
  ctx.require("team.roles_assign");
  assertInvitableRole(role);

  const target = await repo.findMembershipById(ctx.organizationId, membershipId);
  if (!target) throw new TeamError("membership_not_found");

  const currentRole = roleKeyFromRoleId(target.role_id);
  // CORRECTION-001: a non-owner can never touch a membership that is
  // CURRENTLY Owner or Manager — this also covers a Manager targeting their
  // own membership (currentRole === "manager"), closing self-promotion/
  // self-protection through this path the same way as any other row.
  assertAuthorityOverRole(ctx, currentRole);
  if (currentRole === "owner") {
    // Demoting an owner row (possibly the caller's own) — the DB trigger
    // (memberships_last_owner_protection) is the final authority, but this
    // gives a clean application-level error first.
    await assertOwnerWouldRemain(ctx.organizationId, target.user_id);
  }
  // CORRECTION-001: a non-owner can never assign the Manager role, to
  // themselves or anyone else.
  assertRoleAuthority(ctx, role);

  const updated = await repo.updateMembershipRole(
    ctx.organizationId,
    membershipId,
    ROLE_KEY_TO_ID[role],
  );
  if (!updated) throw new TeamError("membership_not_found");

  await auditLogRequired(ctx, {
    action: "team.role_change",
    resourceType: "memberships",
    resourceId: membershipId,
    beforeJson: { role: currentRole },
    afterJson: { role },
  });

  return toRosterEntry(updated);
}

// ── Deactivate / reactivate ──────────────────────────────────────────────────
// Deactivating never deletes the membership row — history (orders, payments,
// deliveries, conversations, audit log) keeps pointing at the same user_id.
// Only `status` changes, so attribution survives untouched.

async function setMembershipStatus(
  ctx: AuthorizationContext,
  membershipId: string,
  status: "active" | "suspended",
): Promise<TeamRosterEntry> {
  ctx.require("team.remove");

  const target = await repo.findMembershipById(ctx.organizationId, membershipId);
  if (!target) throw new TeamError("membership_not_found");

  const currentRole = roleKeyFromRoleId(target.role_id);
  // CORRECTION-001: a non-owner can never deactivate/reactivate a
  // membership that is CURRENTLY Owner or Manager — including their own
  // Manager row, the same as changeRole above. `team.remove` (granted to
  // Manager since the original 003 seed) authorizes deactivating
  // below-Manager staff, not peer Managers or the Owner.
  assertAuthorityOverRole(ctx, currentRole);

  if (status === "suspended" && currentRole === "owner") {
    await assertOwnerWouldRemain(ctx.organizationId, target.user_id);
  }

  const updated = await repo.updateMembershipStatus(ctx.organizationId, membershipId, status);
  if (!updated) throw new TeamError("membership_not_found");

  await auditLogRequired(ctx, {
    action: status === "suspended" ? "team.remove" : "team.reactivate",
    resourceType: "memberships",
    resourceId: membershipId,
    beforeJson: { status: target.status },
    afterJson: { status },
  });

  return toRosterEntry(updated);
}

export async function deactivateMember(
  ctx: AuthorizationContext,
  membershipId: string,
): Promise<TeamRosterEntry> {
  return setMembershipStatus(ctx, membershipId, "suspended");
}

export async function reactivateMember(
  ctx: AuthorizationContext,
  membershipId: string,
): Promise<TeamRosterEntry> {
  return setMembershipStatus(ctx, membershipId, "active");
}

// ── Accept-invite preview (no org context yet — the invitee has none) ────────

export interface InvitationPreview {
  status: "pending" | "expired" | "already_used" | "not_found";
  organizationName?: string;
  role?: InvitableRoleKey;
  invitedEmail?: string;
  emailMatchesCaller?: boolean;
}

export async function previewInvitation(
  rawToken: string,
  callerEmail: string | null,
): Promise<InvitationPreview> {
  const invitation = await repo.findInvitationByTokenHash(hashInviteToken(rawToken));
  if (!invitation) return { status: "not_found" };
  if (invitation.status !== "pending") return { status: "already_used" };
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return { status: "expired" };

  const organizationName = await repo.findOrganizationDisplayName(invitation.organization_id);
  const role = roleKeyFromRoleId(invitation.role_id);
  assertInvitableRole(role);

  return {
    status: "pending",
    ...(organizationName ? { organizationName } : {}),
    role,
    invitedEmail: invitation.email,
    ...(callerEmail
      ? { emailMatchesCaller: callerEmail.toLowerCase() === invitation.email.toLowerCase() }
      : {}),
  };
}
