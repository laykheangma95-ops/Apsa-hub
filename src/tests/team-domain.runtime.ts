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
 * calls (bun:test mock.module) so nothing here requires a live Supabase project.
 *
 * ── Why this file is *.runtime.ts and not *.test.ts ──────────────────────────
 * bun's mock.module() merges its factory into the LIVE module namespace, and
 * mock.restore() does not undo it. The audit passthrough below rebinds
 * auditLog()/auditLogRequired() to no-op doubles, which therefore stay in place
 * for every file bun evaluates afterwards in the same process. That silently
 * disarmed src/tests/tenant-isolation.test.ts's U2 mandatory-audit guard
 * assertions whenever bun happened to order this file first.
 *
 * So this file runs in its own spawned process, the same isolation the audit
 * mocks in payment-domain.runtime.ts and payments-operations-ui.runtime.ts
 * already use. src/tests/team-domain.test.ts is the thin wrapper that spawns it.
 *
 * Run: bun test src/tests/team-domain.test.ts
 *  or: bun test src/tests/team-domain.runtime.ts
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
import { InvitationConflictError } from "../server/team/repository";

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
    issued_by_role: "OWNER",
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
    findMembershipByEmail: mock(async () => null as MembershipWithProfileAndRole | null),
    countActiveMembers: mock(async () => 1),
    updateMembershipRole: mock(async () => null as MembershipWithProfileAndRole | null),
    updateMembershipStatus: mock(async () => null as MembershipWithProfileAndRole | null),
    listPendingInvitationsByOrg: mock(async () => [] as InvitationRow[]),
    findInvitationById: mock(async () => null as InvitationRow | null),
    findPendingInvitationByEmail: mock(async () => null as InvitationRow | null),
    createInvitation: mock(async () => {
      throw new Error("createInvitation not stubbed");
    }),
    expireInvitation: mock(async () => {}),
    reissueInvitation: mock(async () => null as InvitationRow | null),
    cancelInvitation: mock(async () => null as InvitationRow | null),
    findInvitationByTokenHash: mock(async () => null as InvitationRow | null),
    findOrganizationDisplayName: mock(async () => "Angkor Coffee"),
    findRoleById: mock(async () => null),
    // Real class, not a mock — service.ts does `err instanceof repo.InvitationConflictError`
    // to detect a 23505 unique-violation from createInvitation(), so the mocked
    // module must export the real class for that check to work.
    InvitationConflictError,
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

  it("an EXPIRED pending invite is retired (not left blocking) so the same email can be re-invited", async () => {
    installPassthroughAuthMocks();
    const staleInvite = invitationRow({
      id: "inv-stale",
      organization_id: ORG_A,
      email: "ghost@example.com",
      expires_at: "2000-01-01T00:00:00.000Z", // long past
    });
    const fresh = invitationRow({
      id: "inv-fresh",
      organization_id: ORG_A,
      email: "ghost@example.com",
    });
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () => staleInvite),
      expireInvitation: mock(async () => {}),
      createInvitation: mock(async () => fresh),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    const result = await inviteStaff(ctx, {
      email: "ghost@example.com",
      displayName: "Ghost",
      role: "sales",
    });

    // The stale row is flipped to expired (freeing the partial unique index)
    // BEFORE the new row is inserted — never the reverse, and never skipped.
    expect(repo["expireInvitation"]).toHaveBeenCalledWith(ORG_A, "inv-stale");
    expect(repo["createInvitation"]).toHaveBeenCalledTimes(1);
    expect(result.invitation.id).toBe("inv-fresh");
  });

  it("re-inviting the same address twice in quick succession maps a 23505 unique-violation race to duplicate_invitation", async () => {
    installPassthroughAuthMocks();
    // Both callers pass the pre-check (findPendingInvitationByEmail returns
    // null for both, as it would for two concurrent requests) — the DB's
    // unique index is the real guard for the loser of the race.
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => {
        throw new InvitationConflictError();
      }),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(
      inviteStaff(ctx, { email: "race@example.com", displayName: "Race", role: "sales" }),
    ).rejects.toThrow(/duplicate_invitation/);
    expect(repo["createInvitation"]).toHaveBeenCalledTimes(1);
  });

  it("a non-conflict createInvitation failure propagates as-is, not as duplicate_invitation", async () => {
    installPassthroughAuthMocks();
    installRepoMock({
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => {
        throw new Error("createInvitation: connection reset");
      }),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(
      inviteStaff(ctx, { email: "db-down@example.com", displayName: "X", role: "sales" }),
    ).rejects.toThrow(/connection reset/);
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

// ── 13. Manager role authority cap (CORRECTION-001) ─────────────────────────────
// PERMISSIONS_MATRIX.md §7 marks `team.update_role` ⚠️ for MANAGER; migration
// 042 grants `team.roles_assign` to MANAGER as a coarse DB permission bit.
// CORRECTION-001 (CORRECTIONS.md, owner-approved) resolves the ⚠️ to: Owner
// may assign/change Manager; Manager may assign/change only roles strictly
// BELOW Manager, and may never touch a membership that is currently Manager
// (including their own) or assign the Manager role to anyone.

describe("13. Manager role authority cap (CORRECTION-001)", () => {
  it("a Manager CANNOT invite someone as Manager", async () => {
    installPassthroughAuthMocks();
    const repo = installRepoMock({ findPendingInvitationByEmail: mock(async () => null) });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(
      inviteStaff(ctx, { email: "peer@example.com", displayName: "Peer", role: "manager" }),
    ).rejects.toThrow(/insufficient_role_authority/);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });

  it("a Manager CAN invite someone as Cashier/Sales/Customer Service", async () => {
    installPassthroughAuthMocks();
    const created = invitationRow({ id: "inv-below", organization_id: ORG_A });
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => created),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    const result = await inviteStaff(ctx, {
      email: "junior@example.com",
      displayName: "Junior",
      role: "cashier",
    });

    expect(result.invitation.id).toBe("inv-below");
    expect(repo["createInvitation"]).toHaveBeenCalledTimes(1);
    const [, input] = repo["createInvitation"].mock.calls[0] as [
      unknown,
      { issued_by_role: string },
    ];
    expect(input.issued_by_role).toBe("MANAGER");
  });

  it("the Owner CAN invite someone as Manager", async () => {
    installPassthroughAuthMocks();
    const created = invitationRow({ id: "inv-mgr", organization_id: ORG_A });
    const repo = installRepoMock({
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => created),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    const result = await inviteStaff(ctx, {
      email: "newmgr@example.com",
      displayName: "New Manager",
      role: "manager",
    });
    const [, input] = repo["createInvitation"].mock.calls[0] as [
      unknown,
      { issued_by_role: string },
    ];
    expect(input.issued_by_role).toBe("OWNER");

    expect(result.invitation.id).toBe("inv-mgr");
  });

  it("a Manager CANNOT change the role of another Manager's membership", async () => {
    installPassthroughAuthMocks();
    const otherManager = membershipRow({
      id: "m-peer-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => otherManager) });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: false,
    });

    await expect(changeRole(ctx, "m-peer-manager", "cashier")).rejects.toThrow(
      /insufficient_role_authority/,
    );
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("a Manager CANNOT promote a Cashier to Manager", async () => {
    installPassthroughAuthMocks();
    const cashier = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => cashier) });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: false,
    });

    await expect(changeRole(ctx, "m-cashier", "manager")).rejects.toThrow(
      /insufficient_role_authority/,
    );
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("a Manager CANNOT change their OWN membership's role (self-promotion/self-protection, same as any other Manager row)", async () => {
    installPassthroughAuthMocks();
    const selfMembership = membershipRow({
      id: "m-self",
      organization_id: ORG_A,
      user_id: "u-manager",
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => selfMembership) });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: false,
    });

    await expect(changeRole(ctx, "m-self", "cashier")).rejects.toThrow(
      /insufficient_role_authority/,
    );
    expect(repo["updateMembershipRole"]).not.toHaveBeenCalled();
  });

  it("a Manager CAN change a Cashier's role to Sales (a role change strictly below Manager, both ends)", async () => {
    installPassthroughAuthMocks();
    const cashier = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
    });
    const updated = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
      role: { name: "Sales", system_role: "SALES" },
    });
    const repo = installRepoMock({
      findMembershipById: mock(async () => cashier),
      updateMembershipRole: mock(async () => updated),
    });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: false,
    });

    const result = await changeRole(ctx, "m-cashier", "sales");

    expect(result.role).toBe("sales");
    expect(repo["updateMembershipRole"]).toHaveBeenCalledTimes(1);
  });

  it("the Owner CAN demote a Manager to Cashier", async () => {
    const { auditLogRequired } = installPassthroughAuthMocks();
    const manager = membershipRow({
      id: "m-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
    });
    const updated = membershipRow({
      id: "m-manager",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
    });
    installRepoMock({
      findMembershipById: mock(async () => manager),
      updateMembershipRole: mock(async () => updated),
    });
    const { changeRole } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.roles_assign"],
      isOwner: true,
    });

    const result = await changeRole(ctx, "m-manager", "cashier");

    expect(result.role).toBe("cashier");
    expect(auditLogRequired).toHaveBeenCalledTimes(1);
  });

  it("a Manager CANNOT deactivate another Manager", async () => {
    installPassthroughAuthMocks();
    const otherManager = membershipRow({
      id: "m-peer-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => otherManager) });
    const { deactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: false,
    });

    await expect(deactivateMember(ctx, "m-peer-manager")).rejects.toThrow(
      /insufficient_role_authority/,
    );
    expect(repo["updateMembershipStatus"]).not.toHaveBeenCalled();
  });

  it("a Manager CANNOT reactivate another (suspended) Manager", async () => {
    installPassthroughAuthMocks();
    const suspendedManager = membershipRow({
      id: "m-peer-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
      status: "suspended",
    });
    const repo = installRepoMock({ findMembershipById: mock(async () => suspendedManager) });
    const { reactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: false,
    });

    await expect(reactivateMember(ctx, "m-peer-manager")).rejects.toThrow(
      /insufficient_role_authority/,
    );
    expect(repo["updateMembershipStatus"]).not.toHaveBeenCalled();
  });

  it("a Manager CAN deactivate a Cashier (a below-Manager staff member)", async () => {
    const { auditLogRequired } = installPassthroughAuthMocks();
    const cashier = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
      status: "active",
    });
    const suspended = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
      status: "suspended",
    });
    installRepoMock({
      findMembershipById: mock(async () => cashier),
      updateMembershipStatus: mock(async () => suspended),
    });
    const { deactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: false,
    });

    const result = await deactivateMember(ctx, "m-cashier");

    expect(result.status).toBe("suspended");
    expect(auditLogRequired).toHaveBeenCalledTimes(1);
  });

  it("the Owner CAN deactivate a Manager", async () => {
    const { auditLogRequired } = installPassthroughAuthMocks();
    const manager = membershipRow({
      id: "m-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
      status: "active",
    });
    const suspended = membershipRow({
      id: "m-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
      status: "suspended",
    });
    installRepoMock({
      findMembershipById: mock(async () => manager),
      updateMembershipStatus: mock(async () => suspended),
    });
    const { deactivateMember } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.remove"],
      isOwner: true,
    });

    const result = await deactivateMember(ctx, "m-manager");

    expect(result.status).toBe("suspended");
    expect(auditLogRequired).toHaveBeenCalledTimes(1);
  });
});

// ── 15. CORRECTION-001 round 2: invite/accept authority bypass closed ──────────
// Independent review found a Manager could invite a suspended Owner's or
// peer Manager's email at a lower role; accept_invitation() would then
// reactivate that membership at the invited (lower) role with no authority
// check at all. inviteStaff() now resolves the target email to any existing
// membership in the org (any status) and applies the same authority rule
// changeRole/deactivateMember/reactivateMember already enforce, BEFORE the
// invitation is ever created. The DB-side re-check at accept time is
// exercised structurally in "12. Migration safety — 041_team_invitations.sql"
// above, since it runs inside a real Postgres transaction this suite cannot
// invoke.

describe("15a. Invite-time authority check against the target's CURRENT membership (CORRECTION-001)", () => {
  it("a Manager CANNOT invite a suspended OWNER's email, even at a lower role", async () => {
    installPassthroughAuthMocks();
    const suspendedOwner = membershipRow({
      id: "m-owner",
      organization_id: ORG_A,
      role_id: OWNER_ROLE_ID,
      role: { name: "Owner", system_role: "OWNER" },
      status: "suspended",
    });
    const repo = installRepoMock({
      findMembershipByEmail: mock(async () => suspendedOwner),
      findPendingInvitationByEmail: mock(async () => null),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(
      inviteStaff(ctx, { email: "owner@example.com", displayName: "Owner", role: "cashier" }),
    ).rejects.toThrow(/cannot_modify_owner/);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });

  it("a Manager CANNOT invite a suspended peer MANAGER's email, even at a lower role", async () => {
    installPassthroughAuthMocks();
    const suspendedManager = membershipRow({
      id: "m-peer-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
      status: "suspended",
    });
    const repo = installRepoMock({
      findMembershipByEmail: mock(async () => suspendedManager),
      findPendingInvitationByEmail: mock(async () => null),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(
      inviteStaff(ctx, { email: "peer@example.com", displayName: "Peer", role: "cashier" }),
    ).rejects.toThrow(/insufficient_role_authority/);
    expect(repo["createInvitation"]).not.toHaveBeenCalled();
  });

  it("a Manager CAN invite a suspended Cashier/Sales/Customer Service email at a (different) lower role", async () => {
    installPassthroughAuthMocks();
    const suspendedCashier = membershipRow({
      id: "m-cashier",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      role: { name: "Cashier", system_role: "CASHIER" },
      status: "suspended",
    });
    const created = invitationRow({
      id: "inv-re",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
      issued_by_role: "MANAGER",
    });
    const repo = installRepoMock({
      findMembershipByEmail: mock(async () => suspendedCashier),
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => created),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    const result = await inviteStaff(ctx, {
      email: "cashier@example.com",
      displayName: "Cashier",
      role: "sales",
    });

    expect(result.invitation.id).toBe("inv-re");
    expect(repo["createInvitation"]).toHaveBeenCalledTimes(1);
  });

  it("the Owner CAN invite a suspended MANAGER's email at a lower role", async () => {
    installPassthroughAuthMocks();
    const suspendedManager = membershipRow({
      id: "m-manager",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      role: { name: "Manager", system_role: "MANAGER" },
      status: "suspended",
    });
    const created = invitationRow({
      id: "inv-demote",
      organization_id: ORG_A,
      role_id: CASHIER_ROLE_ID,
      issued_by_role: "OWNER",
    });
    const repo = installRepoMock({
      findMembershipByEmail: mock(async () => suspendedManager),
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => created),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    const result = await inviteStaff(ctx, {
      email: "manager@example.com",
      displayName: "Manager",
      role: "cashier",
    });

    expect(result.invitation.id).toBe("inv-demote");
    const [, input] = repo["createInvitation"].mock.calls[0] as [
      unknown,
      { issued_by_role: string },
    ];
    expect(input.issued_by_role).toBe("OWNER");
  });

  it("inviting an address with no existing membership skips the target-authority check entirely", async () => {
    installPassthroughAuthMocks();
    const created = invitationRow({
      id: "inv-fresh",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
    });
    const repo = installRepoMock({
      findMembershipByEmail: mock(async () => null),
      findPendingInvitationByEmail: mock(async () => null),
      createInvitation: mock(async () => created),
    });
    const { inviteStaff } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    const result = await inviteStaff(ctx, {
      email: "brandnew@example.com",
      displayName: "Brand New",
      role: "sales",
    });

    expect(result.invitation.id).toBe("inv-fresh");
  });
});

describe("15b. Resend/cancel authority against the invitation's own role (CORRECTION-001)", () => {
  it("a Manager CANNOT resend a Manager-grade invitation", async () => {
    installPassthroughAuthMocks();
    const managerInvite = invitationRow({
      id: "inv-mgr",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
    });
    const repo = installRepoMock({ findInvitationById: mock(async () => managerInvite) });
    const { resendInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(resendInvite(ctx, "inv-mgr")).rejects.toThrow(/insufficient_role_authority/);
    expect(repo["reissueInvitation"]).not.toHaveBeenCalled();
  });

  it("a Manager CANNOT cancel a Manager-grade invitation", async () => {
    installPassthroughAuthMocks();
    const managerInvite = invitationRow({
      id: "inv-mgr",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
    });
    const repo = installRepoMock({ findInvitationById: mock(async () => managerInvite) });
    const { cancelInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(cancelInvite(ctx, "inv-mgr")).rejects.toThrow(/insufficient_role_authority/);
    expect(repo["cancelInvitation"]).not.toHaveBeenCalled();
  });

  it("a Manager CAN resend/cancel a below-Manager invitation", async () => {
    installPassthroughAuthMocks();
    const salesInvite = invitationRow({
      id: "inv-sales",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
    });
    const reissued = invitationRow({
      id: "inv-sales",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
    });
    const cancelled = invitationRow({
      id: "inv-sales",
      organization_id: ORG_A,
      role_id: SALES_ROLE_ID,
      status: "cancelled",
    });
    installRepoMock({
      findInvitationById: mock(async () => salesInvite),
      reissueInvitation: mock(async () => reissued),
      cancelInvitation: mock(async () => cancelled),
    });
    const { resendInvite, cancelInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-manager",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: false,
    });

    await expect(resendInvite(ctx, "inv-sales")).resolves.toBeTruthy();
    await expect(cancelInvite(ctx, "inv-sales")).resolves.toBe("inv-sales");
  });

  it("the Owner CAN resend/cancel a Manager-grade invitation", async () => {
    installPassthroughAuthMocks();
    const managerInvite = invitationRow({
      id: "inv-mgr",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
    });
    const reissued = invitationRow({
      id: "inv-mgr",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
    });
    const cancelled = invitationRow({
      id: "inv-mgr",
      organization_id: ORG_A,
      role_id: MANAGER_ROLE_ID,
      status: "cancelled",
    });
    installRepoMock({
      findInvitationById: mock(async () => managerInvite),
      reissueInvitation: mock(async () => reissued),
      cancelInvitation: mock(async () => cancelled),
    });
    const { resendInvite, cancelInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(resendInvite(ctx, "inv-mgr")).resolves.toBeTruthy();
    await expect(cancelInvite(ctx, "inv-mgr")).resolves.toBe("inv-mgr");
  });
});

// ── 14. Resend/cancel invitation are audit logged ───────────────────────────────

describe("14. Resend/cancel invitation are audit logged", () => {
  it("resendInvite audit-logs team.invite_resend with the invitation's email", async () => {
    const { auditLog } = installPassthroughAuthMocks();
    const existing = invitationRow({
      id: "inv-1",
      organization_id: ORG_A,
      email: "staff@example.com",
    });
    const reissued = invitationRow({
      id: "inv-1",
      organization_id: ORG_A,
      email: "staff@example.com",
    });
    installRepoMock({
      findInvitationById: mock(async () => existing),
      reissueInvitation: mock(async () => reissued),
    });
    const { resendInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await resendInvite(ctx, "inv-1");

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [, entry] = auditLog.mock.calls[0] as [unknown, { action: string; resourceId: string }];
    expect(entry.action).toBe("team.invite_resend");
    expect(entry.resourceId).toBe("inv-1");
  });

  it("cancelInvite audit-logs team.invite_cancel", async () => {
    const { auditLog } = installPassthroughAuthMocks();
    const pending = invitationRow({
      id: "inv-2",
      organization_id: ORG_A,
      email: "gone@example.com",
      role_id: SALES_ROLE_ID,
    });
    const cancelled = invitationRow({
      id: "inv-2",
      organization_id: ORG_A,
      email: "gone@example.com",
      status: "cancelled",
    });
    installRepoMock({
      findInvitationById: mock(async () => pending),
      cancelInvitation: mock(async () => cancelled),
    });
    const { cancelInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await cancelInvite(ctx, "inv-2");

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [, entry] = auditLog.mock.calls[0] as [unknown, { action: string; resourceId: string }];
    expect(entry.action).toBe("team.invite_cancel");
    expect(entry.resourceId).toBe("inv-2");
  });

  it("a not-found resend/cancel never reaches the audit log", async () => {
    const { auditLog } = installPassthroughAuthMocks();
    installRepoMock({
      findInvitationById: mock(async () => null),
      cancelInvitation: mock(async () => null),
    });
    const { resendInvite, cancelInvite } = await import("../server/team/service");
    const ctx = makeCtx({
      userId: "u-owner",
      organizationId: ORG_A,
      permissions: ["team.invite"],
      isOwner: true,
    });

    await expect(resendInvite(ctx, "inv-missing")).rejects.toThrow(/invitation_not_found/);
    await expect(cancelInvite(ctx, "inv-missing")).rejects.toThrow(/invitation_not_found/);
    expect(auditLog).not.toHaveBeenCalled();
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

  // Independent review (round 3): the identity feeding that email-match check
  // must come from auth.users — the record Supabase Auth itself manages —
  // never from public.profiles.email, which is writable by the authenticated
  // user themselves via the "profiles_update_own" RLS policy
  // (001_auth_profiles.sql) with no server-side revalidation against
  // auth.users. Reading profiles.email for this check would let any
  // authenticated caller rewrite their own profile row to the invited
  // address and satisfy email-match with no inbox/account proof at all.
  it("the email used for that match comes from auth.users, never the client-writable public.profiles table", () => {
    expect(sql).toMatch(/SELECT email INTO v_user_email FROM auth\.users WHERE id = v_user_id/);
    // The old profiles-sourced identity line must be gone, not just
    // superseded — public.profiles still appears elsewhere in this file
    // (legitimate FK references on invited_by/accepted_user_id), so this
    // targets exactly the removed identity-lookup shape.
    expect(sql).not.toMatch(/SELECT email INTO v_user_email FROM public\.profiles/);
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

  // No live Supabase project is configured in this environment (see the PR's
  // own "Known risks" / "Live-Supabase end-to-end verification" note), so
  // this is a structural check on the PL/pgSQL text, same limitation as the
  // rest of this describe block — not a substitute for exercising
  // accept_invitation() against a real Postgres instance.
  it("accepting an invite REACTIVATES an existing suspended/removed membership in place, never a second INSERT", () => {
    // The existing-membership lookup is no longer restricted to active/invited
    // — it must see a suspended/removed row too, or reactivation can't happen.
    expect(sql).toMatch(
      /SELECT \* INTO v_existing\s+FROM public\.memberships\s+WHERE user_id = v_user_id\s+AND organization_id = v_invitation\.organization_id\s+ORDER BY \(status IN \('active', 'invited'\)\) DESC, joined_at DESC/,
    );
    // A prior non-active/invited row is reactivated via UPDATE ... status = 'active' ...
    expect(sql).toMatch(/UPDATE public\.memberships\s+SET status = 'active'/);
    // Exactly one INSERT into memberships in the whole function, reached only
    // when no prior row exists at all (the ELSE branch).
    const insertCount = (sql.match(/INSERT INTO public\.memberships/g) ?? []).length;
    expect(insertCount).toBe(1);
    expect(sql).toMatch(/ELSE\s+INSERT INTO public\.memberships/);
  });

  // Independent review (round 3): the advisory lock above is keyed on the
  // INVITATION id, so it only serializes two accepts of the SAME invitation.
  // Two DIFFERENT invitations targeting the same membership — or a
  // concurrent changeRole/deactivateMember/reactivateMember service-layer
  // call on that row — were not serialized against each other at all, which
  // could let the authority check below read a row a concurrent writer was
  // mid-mutation on (a TOCTOU). FOR UPDATE closes that: this transaction
  // blocks until any such concurrent writer of the row commits, then
  // re-reads it, so the authority check and the reactivation UPDATE always
  // act on the same, current row.
  it("the existing-membership lookup row-locks with FOR UPDATE, serializing concurrent accepts/role-changes on the same membership", () => {
    expect(sql).toMatch(
      /ORDER BY \(status IN \('active', 'invited'\)\) DESC, joined_at DESC\s+LIMIT 1\s+FOR UPDATE;/,
    );
    // The lock must be acquired (i.e. the SELECT must run) before the
    // authority check and the UPDATE that overwrites role_id — a lock taken
    // after either would not prevent the race it exists to close.
    const lockIndex = sql.indexOf("LIMIT 1\n  FOR UPDATE;");
    const authorityCheckIndex = sql.indexOf(
      "IF v_existing_is_guarded AND v_invitation.issued_by_role != 'OWNER' THEN",
    );
    const updateIndex = sql.indexOf("SET status = 'active', role_id = v_invitation.role_id");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(authorityCheckIndex).toBeGreaterThan(lockIndex);
    expect(updateIndex).toBeGreaterThan(authorityCheckIndex);
  });

  // CORRECTION-001 round 2: the accept-path authority re-check. Independent
  // review found that a Manager could invite a suspended Owner/Manager's
  // address at a lower role, and accept_invitation()'s reactivation branch
  // would overwrite that membership's role_id with no authority check at
  // all — bypassing the exact cap enforced on changeRole/deactivateMember/
  // reactivateMember. These checks are structural (same limitation as the
  // rest of this describe block) but pin down the specific mechanism.

  it("invitations persist the issuer's authority (issued_by_role) at invite time", () => {
    expect(sql).toMatch(
      /issued_by_role\s+TEXT NOT NULL CHECK \(issued_by_role IN \('OWNER', 'MANAGER'\)\)/,
    );
  });

  it("reactivation independently re-checks authority against the EXISTING row's current role before overwriting it", () => {
    // The guard is computed from v_existing.role_id (the row's role as it
    // stands NOW, re-read fresh under the advisory lock) — not from
    // v_invitation.role_id (the role being offered).
    expect(sql).toMatch(
      /SELECT EXISTS \(\s*SELECT 1 FROM public\.roles r\s*WHERE r\.id = v_existing\.role_id AND r\.system_role IN \('OWNER', 'MANAGER'\)\s*\) INTO v_existing_is_guarded/,
    );
    // A Manager-issued invitation (issued_by_role != 'OWNER') is refused
    // when the existing row is currently Owner/Manager-grade.
    expect(sql).toMatch(
      /IF v_existing_is_guarded AND v_invitation\.issued_by_role != 'OWNER' THEN\s*[\s\S]*?RETURN jsonb_build_object\('status', 'authority_denied'\)/,
    );
    // The guard runs BEFORE the UPDATE that would overwrite role_id — i.e.
    // it can actually prevent the overwrite, not just log after the fact.
    const guardIndex = sql.indexOf("v_existing_is_guarded AND v_invitation.issued_by_role");
    const updateIndex = sql.indexOf("SET status = 'active', role_id = v_invitation.role_id");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(guardIndex);
  });

  it("reactivation does NOT overwrite the original invited_by (historical inviter is preserved)", () => {
    const updateBlock = sql.slice(
      sql.indexOf("SET status = 'active', role_id = v_invitation.role_id"),
      sql.indexOf("WHERE id = v_existing.id;") + "WHERE id = v_existing.id;".length,
    );
    expect(updateBlock).not.toMatch(/invited_by/);
  });

  it("a successful acceptance writes a team.invite_accept row directly into audit_logs, atomically with the membership mutation", () => {
    expect(sql).toMatch(/INSERT INTO public\.audit_logs/);
    expect(sql).toMatch(/'team\.invite_accept'/);
    // Records whether this accept created a new membership or reactivated
    // an existing one, and which role it resulted in — the minimum the
    // audit trail needs to answer "what changed and for whom".
    expect(sql).toMatch(/'reactivated', v_reactivated/);
    expect(sql).toMatch(/'role_id', v_invitation\.role_id/);
    // The audit INSERT happens before the final RETURN, inside the same
    // function invocation/transaction as the membership INSERT/UPDATE above
    // — SECURITY DEFINER + no intermediate COMMIT means this is atomic with
    // the mutation by construction.
    const auditIndex = sql.indexOf("INSERT INTO public.audit_logs");
    const returnSuccessIndex = sql.indexOf("'status', 'success'");
    expect(auditIndex).toBeGreaterThan(-1);
    expect(returnSuccessIndex).toBeGreaterThan(auditIndex);
  });

  // Independent review (round 3, folding in a related finding): reactivation
  // is the one path through this function that can silently change a role —
  // before_json previously only recorded {invitation_id, reactivated}, which
  // can't answer "changed from what". It now also carries the membership's
  // PRIOR role_id/status, read (and row-locked, per the FOR UPDATE test
  // above) before the UPDATE that overwrites them — matching the
  // {before, after} shape src/server/auth/audit.ts#auditLogRequired already
  // uses for team.role_change/team.reactivate. A fresh INSERT has no prior
  // state, so that branch keeps the narrower shape.
  it("reactivation's audit row carries the membership's PRIOR role_id/status in before_json, not just a reactivated flag", () => {
    const caseStart = sql.indexOf("WHEN v_reactivated THEN jsonb_build_object(");
    const caseEnd = sql.indexOf(
      "ELSE jsonb_build_object('invitation_id', v_invitation.id, 'reactivated', v_reactivated)",
    );
    expect(caseStart).toBeGreaterThan(-1);
    expect(caseEnd).toBeGreaterThan(caseStart);
    const reactivatedBranch = sql.slice(caseStart, caseEnd);
    expect(reactivatedBranch).toMatch(/'role_id', v_existing\.role_id/);
    expect(reactivatedBranch).toMatch(/'status', v_existing\.status/);
    // The fresh-membership (non-reactivation) branch stays minimal — there
    // is no prior row to describe.
    expect(sql).toMatch(
      /ELSE jsonb_build_object\('invitation_id', v_invitation\.id, 'reactivated', v_reactivated\)/,
    );
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

  it("documents that the grant is capped by CORRECTION-001, not unrestricted", () => {
    expect(sql).toMatch(/CORRECTION-001/);
  });
});

// ── 16. Client-side team error classification (src/lib/team-errors.ts) ─────────
// Pure functions shared by src/routes/app.team.tsx, StaffDetailSheet.tsx and
// InviteStaffSheet.tsx to decide which empty/error state to show. Exercised
// directly (no component rendering — this test suite has no such harness;
// see route-guard.test.ts for the established structural-only alternative
// this replaces for anything that can instead be plain, testable logic).

describe("16. Client-side team error classification (src/lib/team-errors.ts)", () => {
  it("isPermissionDeniedError matches only the exact access-denied messages the server throws", async () => {
    const { isPermissionDeniedError } = await import("../lib/team-errors");

    expect(isPermissionDeniedError(new Error("Missing permission: team.read"))).toBe(true);
    expect(isPermissionDeniedError(new Error("No active organization membership"))).toBe(true);
    expect(isPermissionDeniedError(new Error("Not authenticated"))).toBe(true);
  });

  it("isPermissionDeniedError does NOT misclassify a DB/repository failure as permission denied", async () => {
    const { isPermissionDeniedError } = await import("../lib/team-errors");

    // This exact message shape is what repo.listMemberships()'s catch throws
    // (src/server/team/repository.ts) — it contains "Membership" and would
    // have matched the old /permission|membership/i regex.
    expect(isPermissionDeniedError(new Error("listMemberships: connection reset"))).toBe(false);
    expect(isPermissionDeniedError(new Error("Internal server error"))).toBe(false);
    expect(isPermissionDeniedError("not even an Error")).toBe(false);
  });

  it("classifyTeamActionError distinguishes owner-protection, authority-cap, and generic failures", async () => {
    const { classifyTeamActionError } = await import("../lib/team-errors");

    expect(classifyTeamActionError(new Error("cannot_modify_owner"))).toBe("owner_protected");
    expect(classifyTeamActionError(new Error("last_owner_protected"))).toBe("owner_protected");
    expect(classifyTeamActionError(new Error("insufficient_role_authority"))).toBe(
      "insufficient_authority",
    );
    // A reactivate-specific regression: a network/DB failure must not be
    // reported as "ownership is protected".
    expect(classifyTeamActionError(new Error("fetch failed"))).toBe("generic");
    expect(classifyTeamActionError(new Error("membership_not_found"))).toBe("generic");
  });

  it("classifyInviteError distinguishes duplicate, authority-cap, and generic failures", async () => {
    const { classifyInviteError } = await import("../lib/team-errors");

    expect(classifyInviteError(new Error("duplicate_invitation"))).toBe("duplicate");
    expect(classifyInviteError(new Error("insufficient_role_authority"))).toBe(
      "insufficient_authority",
    );
    // cannot_modify_owner is now also reachable from inviteStaff() (CORRECTION-001
    // round 2: inviting a suspended Owner's address at a lower role) and reads
    // the same to the inviter as any other authority-cap denial.
    expect(classifyInviteError(new Error("cannot_modify_owner"))).toBe("insufficient_authority");
    expect(classifyInviteError(new Error("invalid_input"))).toBe("generic");
  });
});
