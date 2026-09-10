/**
 * Team/Staff domain tests — backend reconnect (migrations 041-042,
 * src/server/team/*, src/api/team.ts, src/lib/api/index.ts wiring).
 *
 * Covers the required scenarios from the reconnect task:
 *   1.  Owner sees team (listTeam maps memberships + pending invitations)
 *   2.  Owner invites (inviteStaff creates a real invitation row + one-time token)
 *   3.  Unauthorized staff denied (every mutating call requires its team.* permission)
 *   4.  Duplicate invite handling (a second invite to a pending email is rejected)
 *   5.  Role change (changeRole updates role_id, mandatory-audits team.role_change)
 *   6.  Self-promotion blocked (no path can ever target the OWNER role)
 *   7.  Deactivate/reactivate (status flips between active/suspended, row never deleted)
 *   8.  Inactive staff access denied (conversation assignment compatibility)
 *   9.  Tenant isolation (a membership/invitation id from another org is invisible)
 *  10.  Historical attribution preserved (deactivation never deletes the row)
 *  11.  Bundle boundary — covered generically by src/tests/bundle-boundary.test.ts,
 *       which scans every file under src/api/ and src/routes/ including the new
 *       src/api/team.ts and src/routes/invite.$token.tsx.
 *  12.  Migration safety (041/042 SQL structural checks)
 *
 * All service-layer tests mock the repository and cross-domain audit/authorization
 * calls (bun:test mock.module) so nothing here requires a live Supabase project —
 * consistent with product-domain.test.ts / inventory-domain.test.ts.
 *
 * Run: bun test src/tests/team-domain.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  ForbiddenError,
  UnauthorizedError,
  type AuthorizationContext,
} from "../server/auth/authorization";
import * as RealAuthorization from "../server/auth/authorization";
import * as RealAudit from "../server/auth/audit";
import type { InvitationRow, MembershipWithProfileAndRole } from "../server/team/types";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";

const OWNER_ROLE_ID = "00000000-0000-0000-0000-000000000001";
const MANAGER_ROLE_ID = "00000000-0000-0000-0000-000000000002";
const CASHIER_ROLE_ID = "00000000-0000-0000-0000-000000000003";
const SALES_ROLE_ID = "00000000-0000-0000-0000-000000000004";

function makeCtx(opts: {
  userId: string;
  organizationId: string;
  permissions: string[];
  isOwner?: boolean;
}): AuthorizationContext {
  const perms = new Set(opts.permissions);
  return {
    userId: opts.userId,
    organizationId: opts.organizationId,
    roleId: opts.isOwner ? OWNER_ROLE_ID : MANAGER_ROLE_ID,
    systemRole: opts.isOwner ? "OWNER" : "MANAGER",
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => Boolean(opts.isOwner),
    requireOwner: () => {
      if (!opts.isOwner) throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

function membershipRow(
  overrides: Partial<MembershipWithProfileAndRole> & { id: string; organization_id: string },
): MembershipWithProfileAndRole {
  return {
    user_id: `user-${overrides.id}`,
    role_id: MANAGER_ROLE_ID,
    status: "active",
    joined_at: "2026-01-01T00:00:00.000Z",
    invited_by: null,
    profile: { display_name: "Staff Member", email: "staff@example.com", phone: null },
    role: { name: "Manager", system_role: "MANAGER" },
    ...overrides,
  };
}

function invitationRow(
  overrides: Partial<InvitationRow> & { id: string; organization_id: string },
): InvitationRow {
  return {
    email: "invitee@example.com",
    role_id: SALES_ROLE_ID,
    status: "pending",
    token_hash: "deadbeef",
    invited_by: "owner-user",
    invited_display_name: null,
    created_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    accepted_at: null,
    accepted_user_id: null,
    cancelled_at: null,
    ...overrides,
  };
}

// ── Repository mock scaffolding ────────────────────────────────────────────────

type RepoMock = Record<string, ReturnType<typeof mock>>;

function installRepoMock(overrides: Partial<Record<string, unknown>> = {}): RepoMock {
  const calls: RepoMock = {
    listMemberships: mock(async () => [] as MembershipWithProfileAndRole[]),
    listPendingInvitations: mock(async () => [] as InvitationRow[]),
    findMembershipById: mock(async () => null as MembershipWithProfileAndRole | null),
    countActiveMembers: mock(async () => 1),
    updateMembershipRole: mock(async () => null as MembershipWithProfileAndRole | null),
    updateMembershipStatus: mock(async () => null as MembershipWithProfileAndRole | null),
    listPendingInvitationsByOrg: mock(async () => [] as InvitationRow[]),
    findInvitationById: mock(async () => null as InvitationRow | null),
    findPendingInvitationByEmail: mock(async () => null as InvitationRow | null),
    createInvitation: mock(async () => {
      throw new Error("createInvitation not stubbed");
    }),
    reissueInvitation: mock(async () => null as InvitationRow | null),
    cancelInvitation: mock(async () => null as InvitationRow | null),
    findInvitationByTokenHash: mock(async () => null as InvitationRow | null),
    findOrganizationDisplayName: mock(async () => "Angkor Coffee"),
    findRoleById: mock(async () => null),
    ...overrides,
  };

  mock.module("@/server/team/repository", () => calls);
  return calls;
}

function installPassthroughAuthMocks(): {
  auditLog: ReturnType<typeof mock>;
  auditLogRequired: ReturnType<typeof mock>;
} {
  const auditLog = mock(async () => {});
  const auditLogRequired = mock(async () => {});
  mock.module("@/server/auth/audit", () => ({
    ...RealAudit,
    auditLog,
    auditLogRequired,
  }));
  mock.module("@/server/auth/authorization", () => ({
    ...RealAuthorization,
    assertOwnerWouldRemain: mock(async () => {}),
  }));
  return { auditLog, auditLogRequired };
}

afterEach(() => {
  mock.restore();
});

// ── 1. Owner sees team ──────────────────────────────────────────────────────────

describe("1. Owner sees team", () => {
  it("listTeam maps active/suspended memberships and unexpired pending invitations", async () => {
    installPassthroughAuthMocks();
    installRepoMock({
      listMemberships: mock(async () => [
        membershipRow({
          id: "m-owner",
          organization_id: ORG_A,
          role_id: OWNER_ROLE_ID,
          role: { name: "Owner", system_role: "OWNER" },
        }),
        membershipRow({ id: "m-suspended", organization_id: ORG_A, status: "suspended" }),
      ]),
      listPendingInvitations: mock(async () => [
        invitationRow({ id: "inv-1", organization_id: ORG_A }),
        invitationRow({
          id: "inv-expired",
          organization_id: ORG_A,
          expires_at: "2000-01-01T00:00:00.000Z",
        }),
      ]),
    });

    const { listTeam } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.read"],
      isOwner: true,
    });

    const roster = await listTeam(ctx);

    expect(roster.map((r) => r.id)).toEqual(["m-owner", "m-suspended", "inv-1"]);
    expect(roster.find((r) => r.id === "m-owner")?.role).toBe("owner");
    expect(roster.find((r) => r.id === "m-suspended")?.status).toBe("suspended");
    expect(roster.find((r) => r.id === "inv-1")?.status).toBe("invited");
    // Expired invitations never appear — they are not a live pending invite.
    expect(roster.find((r) => r.id === "inv-expired")).toBeUndefined();
  });
});

// ── 3. Unauthorized staff denied ─────────────────────────────────────────────────

describe("3. Unauthorized staff denied", () => {
  it("listTeam without team.read throws ForbiddenError and never touches the repository", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock();
    const { listTeam } = await import("../server/team/service");
    const ctx = makeCtx({ userId: "u-cashier", organizationId: ORG_A, permissions: [] });

    await expect(listTeam(ctx)).rejects.toThrow(ForbiddenError);
    expect(repo["listMemberships"]).not.toHaveBeenCalled();
  });

  it("inviteStaff without team.invite throws ForbiddenError before any write", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock();
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({ userId: "u-sales", organizationId: ORG_A, permissions: ["team.read"] });

    await expect(
      inviteStaff(ctx, { email: "new@example.com", displayName: "New Person", role: "sales" }),
    ).rejects.toThrow(ForbiddenError);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });

  it("changeRole without team.roles_assign throws ForbiddenError", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock();
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({ userId: "u-cashier", organizationId: ORG_A, permissions: ["team.read"] });

    await expect(changeRole(ctx, "m-1", "manager")).rejects.toThrow(ForbiddenError);
    expect(repo["findMembershipById"]).not.toHaveBeenCalled();
  });

  it("deactivateMember/reactivateMember without team.remove throw ForbiddenError", async () => {
    installPassthroughAuthMocks();
    installRepoMock();
    const { deactivateMember, reactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({ userId: "u-cashier", organizationId: ORG_A, permissions: [] });

    await expect(deactivateMember(ctx, "m-1")).rejects.toThrow(ForbiddenError);
    await expect(reactivateMember(ctx, "m-1")).rejects.toThrow(ForbiddenError);
  });
});

// ── 2. Owner invites / 4. Duplicate invite handling ─────────────────────────────

describe("2. Owner invites, 4. Duplicate invite handling", () => {
  it("inviteStaff creates an invitation and returns a one-time raw token (not the hash)", async () => {
    installPassthroughAuthMocks();
    const created = invitationRow({
      id: "inv-new",
      organization_id: ORG_A,
      email: "new@example.com",
    });
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async (_orgId: string, input: { token_hash: string }) => {
        expect(input.token_hash).not.toBe(""); // a hash was computed
        return created;
      }),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    const result = await inviteStaff(ctx, {
      email: "new@example.com",
      displayName: "New Person",
      role: "sales",
    });

    expect(result.invitation.id).toBe("inv-new");
    expect(result.inviteToken.length).toBeGreaterThanOrEqual(32);
    expect(repo["createInvitation"]).toHaveBeenCalledTimes(1);
  });

  it("inviting an email with an existing pending invite is rejected as a duplicate", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () =>
        invitationRow({ id: "inv-existing", organization_id: ORG_A, email: "dup@example.com" }),
      ),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(
      inviteStaff(ctx, { email: "dup@example.com", displayName: "Dup", role: "sales" }),
    ).rejects.toThrow(/duplicate_invitation/);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });
});

// ── 5. Role change ────────────────────────────────────────────────────────────

describe("5. Role change", () => {
  it("changeRole updates the membership's role_id and mandatory-audits team.role_change", async () => {
    const { auditLogRequired } = installPassthroughAuthMocks();
    const target = membershipRow({
      id: "m-1",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
    });
    const updated = membershipRow({
      id: "m-1",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
    });
    installRepoMock({
      findMembershipById: mock(async () => target),
      updateMembershipRole: mock(async () => updated),
    });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: true,
    });

    const result = await changeRole(ctx, "m-1", "manager");

    expect(result.role).toBe("manager");
    expect(auditLogRequired).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Self-promotion blocked ────────────────────────────────────────────────────

describe("6. Self-promotion / privilege escalation blocked", () => {
  it("inviteStaff can never target the OWNER role", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock();
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(
      inviteStaff(ctx, {
        email: "wannabe@example.com",
        displayName: "Wannabe Owner",
        // Runtime bypass of the compile-time InvitableRoleKey union — this is
        // exactly the input an attacker who edits the request body would send.
        role: "owner" as unknown as "sales",
      }),
    ).rejects.toThrow(/owner_role_forbidden/);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });

  it("changeRole can never promote a target to OWNER, even when the caller is the owner", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock({
      findMembershipById: mock(async () => membershipRow({ id: "m-1", organization_id: ORG_A })),
    });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: true,
    });

    await expect(changeRole(ctx, "m-1", "owner" as unknown as "manager")).rejects.toThrow(
      /owner_role_forbidden/,
    );
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("a non-owner manager cannot change the role of the owner's own membership", async () => {
    installPassthroughAuthMocks();
    const ownerMembership = membershipRow({
      id: "m-owner",
      organization_id: ORG_A,
      role_id: OWNER_ROLE_ID,
      role: { name: "Owner", system_role: "OWNER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => ownerMembership) });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: false,
    });

    await expect(changeRole(ctx, "m-owner", "cashier")).rejects.toThrow(/cannot_modify_owner/);
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("a non-owner manager cannot deactivate the owner", async () => {
    installPassthroughAuthMocks();
    const ownerMembership = membershipRow({
      id: "m-owner",
      organization_id: ORG_A,
      role_id: OWNER_ROLE_ID,
      role: { name: "Owner", system_role: "OWNER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => ownerMembership) });
    const { deactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: false,
    });

    await expect(deactivateMember(ctx, "m-owner")).rejects.toThrow(/cannot_modify_owner/);
    expect(repo["updateMembershipStatus"]).not.toHaveBeenCalled();
  });
});

// ── 7. Deactivate / reactivate, 10. Historical attribution preserved ───────────

describe("7. Deactivate/reactivate, 10. Historical attribution preserved", () => {
  it("deactivateMember sets status to suspended via UPDATE — never deletes the row", async () => {
    const { auditLogRequired } = installPassthroughAuthMocks();
    const target = membershipRow({ id: "m-1", organization_id: ORG_A, status: "active" });
    const suspended = membershipRow({ id: "m-1", organization_id: ORG_A, status: "suspended" });
    const repo = installRepoMock({
      findMembershipById: mock(async () => target),
      updateMembershipStatus: mock(async (_org: string, _id: string, status: string) => {
        expect(status).toBe("suspended");
        return suspended;
      }),
    });
    const { deactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: true,
    });

    const result = await deactivateMember(ctx, "m-1");

    expect(result.status).toBe("suspended");
    expect(repo["updateMembershipStatus"]).toHaveBeenCalledTimes(1);
    expect(auditLogRequired).toHaveBeenCalledTimes(1);
    // No repository function that would delete history/attribution exists to call —
    // the mock object above has no "delete"/"remove" member at all, so any such
    // call would have thrown "is not a function" rather than silently succeeding.
  });

  it("reactivateMember sets status back to active, preserving the same membership id (and user_id)", async () => {
    installPassthroughAuthMocks();
    const target = membershipRow({
      id: "m-1",
      organization_id: ORG_A,
      status: "suspended",
      user_id: "u-staff-1",
    });
    const active = membershipRow({
      id: "m-1",
      organization_id: ORG_A,
      status: "active",
      user_id: "u-staff-1",
    });
    installRepoMock({
      findMembershipById: mock(async () => target),
      updateMembershipStatus: mock(async () => active),
    });
    const { reactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: true,
    });

    const result = await reactivateMember(ctx, "m-1");
    expect(result.id).toBe("m-1");
    expect(result.status).toBe("active");
  });
});

// ── 9. Tenant isolation ─────────────────────────────────────────────────────────

describe("9. Tenant isolation", () => {
  it("a membership id from Org B is invisible to an Org A caller (repository is org-scoped)", async () => {
    installPassthroughAuthMocks();
    // Simulates the real repository: the row exists, but org_a's query filters
    // by organization_id, so a cross-org id lookup returns null exactly like
    // a real `.eq("organization_id", orgId)` query would for someone else's row.
    const repo = installRepoMock({
      findMembershipById: mock(async (orgId: string) =>
        orgId === ORG_A ? null : membershipRow({ id: "m-b-1", organization_id: ORG_B }),
      ),
    });
    const { changeRole } = await import("../server/team/service");
    const ctxA = makeCtx({
      userId: "u-owner-a",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: true,
    });

    await expect(changeRole(ctxA, "m-b-1", "manager")).rejects.toThrow(/membership_not_found/);
    expect(repo["findMembershipById"]).toHaveBeenCalledWith(ORG_A, "m-b-1");
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("every repository call the service makes is scoped by ctx.organizationId, not a caller-supplied org", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock();
    const { listTeam } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner-a",
      organizationId: ORG_A,
      permissions: ["team.read"],
      isOwner: true,
    });

    await listTeam(ctx);

    expect(repo["listMemberships"]).toHaveBeenCalledWith(ORG_A);
    expect(repo["listPendingInvitations"]).toHaveBeenCalledWith(ORG_A);
  });
});

// ── 8. Inactive staff access denied — conversation assignment compatibility ─────

describe("8. Inactive staff cannot receive new conversation assignments", () => {
  it("assignConversation rejects a target whose membership is not active", async () => {
    const auditLog = mock(async () => {});
    const auditLogRequired = mock(async () => {});
    mock.module("@/server/auth/audit", () => ({ ...RealAudit, auditLog, auditLogRequired }));

    const conversationRow = {
      id: "conv-1",
      organization_id: ORG_A,
      assigned_user_id: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    mock.module("@/server/conversations/repository", () => ({
      // isActiveAssignee mirrors the real query: false for a suspended/removed
      // membership — this is exactly what deactivateMember flips it to.
      isActiveAssignee: mock(async () => false),
      findConversationById: mock(async () => conversationRow),
      assignConversation: mock(async () => {
        throw new Error("assignConversation must not be called for an invalid assignee");
      }),
    }));

    const { assignConversation } = await import("../server/conversations/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["messages.assign", "messages.reassign_self", "messages.read"],
      isOwner: true,
    });

    await expect(assignConversation(ctx, "conv-1", "u-deactivated-staff")).rejects.toThrow(
      /invalid_assignment/,
    );
  });
});

// ── 12. Migration safety (structural SQL checks, mirrors rpc-security.test.ts) ──

describe("12. Migration safety — 041_team_invitations.sql", () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/041_team_invitations.sql"),
    "utf-8",
  );

  it("accept_invitation derives identity from auth.uid(), never a parameter", () => {
    expect(sql).toMatch(/v_user_id\s*:=\s*auth\.uid\(\)/);
    expect(sql).not.toMatch(/p_user_id/i);
  });

  it("accept_invitation is SECURITY DEFINER with search_path pinned", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path\s*=\s*public,\s*auth/i);
  });

  it("accept_invitation privileges are revoked from PUBLIC/anon and granted to authenticated only", () => {
    expect(sql).toMatch(/REVOKE EXECUTE.*FROM PUBLIC/i);
    expect(sql).toMatch(/REVOKE EXECUTE.*FROM anon/i);
    expect(sql).toMatch(/GRANT EXECUTE.*TO authenticated/i);
  });

  it("accept_invitation uses an advisory lock keyed on the invitation id", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/v_invitation\.id/);
  });

  it("email match is re-verified against the authenticated caller's own profile", () => {
    expect(sql).toMatch(/lower\(v_invitation\.email\)\s*!=\s*lower\(v_user_email\)/);
  });

  it("invitations table has no client-facing RLS policy at all (service-role/RPC only)", () => {
    expect(sql).toMatch(/invitations_select_blocked.*USING \(false\)/s);
    expect(sql).toMatch(/invitations_insert_blocked.*WITH CHECK \(false\)/s);
    expect(sql).toMatch(/invitations_update_blocked.*USING \(false\)/s);
    expect(sql).toMatch(/invitations_delete_blocked.*USING \(false\)/s);
  });

  it("duplicate-invite guard: one pending invitation per (org, email)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX idx_invitations_org_email_pending[\s\S]*WHERE status = 'pending'/,
    );
  });

  it("an invitation can never carry the OWNER role (trigger-enforced)", () => {
    expect(sql).toMatch(/r\.system_role = 'OWNER'/);
    expect(sql).toMatch(/invalid_invitation_role/);
  });
});

describe("12. Migration safety — 042_team_permissions.sql", () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/042_team_permissions.sql"),
    "utf-8",
  );

  it("grants team.roles_assign to the MANAGER system role, matching PERMISSIONS_MATRIX.md §7", () => {
    expect(sql).toMatch(/00000000-0000-0000-0000-000000000002/);
    expect(sql).toMatch(/team\.roles_assign/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it("does not introduce a new permission key or a second role/permission table", () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/INSERT INTO public\.permissions/);
  });
});
