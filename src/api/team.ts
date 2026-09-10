/**
 * Team/membership/invitation domain server functions — TanStack Start API boundary.
 *
 * Security model — same as src/api/customers.ts and src/api/products.ts:
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - All server-only modules (@/lib/supabase/server, @/server/team/*)
 *     are dynamically imported inside handler bodies so they never enter the client bundle.
 *   - Every roster-mutating handler requires an active session AND a team.* permission
 *     before touching data.
 *   - Invitation preview/accept handlers require an active session (so we never do an
 *     anonymous DB read) but deliberately do NOT go through resolveAuthContext(), because
 *     an invitee has no org membership yet — that is exactly the gap invitations close.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

// ── Internal helper: resolve session + organization ────────────────────────────
// organizationId is NEVER accepted from the caller — always derived from DB membership.
// Identical pattern to src/api/customers.ts#resolveAuthContext.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService } = await import("@/server/auth/authorization");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMembership } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();

  if (!rawMembership) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  const membership = rawMembership as { organization_id: string };
  return AuthorizationService.forRequest(session.userId, membership.organization_id);
}

// ── listTeamFn ───────────────────────────────────────────────────────────────

export const listTeamFn = createServerFn().handler(async () => {
  const authCtx = await resolveAuthContext();
  const { listTeam } = await import("@/server/team/service");
  return listTeam(authCtx);
});

// ── inviteStaffFn ────────────────────────────────────────────────────────────

const InvitableRole = z.enum(["manager", "cashier", "sales", "customer_service"]);

export const inviteStaffFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        email: z.string().email("Invalid email"),
        displayName: z.string().min(1).max(200),
        role: InvitableRole,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { inviteStaff } = await import("@/server/team/service");
    return inviteStaff(authCtx, data);
  });

// ── resendInviteFn ───────────────────────────────────────────────────────────

export const resendInviteFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ invitationId: z.string().uuid("Invalid invitation ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resendInvite } = await import("@/server/team/service");
    return resendInvite(authCtx, data.invitationId);
  });

// ── cancelInviteFn ───────────────────────────────────────────────────────────

export const cancelInviteFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ invitationId: z.string().uuid("Invalid invitation ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { cancelInvite } = await import("@/server/team/service");
    return cancelInvite(authCtx, data.invitationId);
  });

// ── changeRoleFn ─────────────────────────────────────────────────────────────

export const changeRoleFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        membershipId: z.string().uuid("Invalid membership ID"),
        role: InvitableRole,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { changeRole } = await import("@/server/team/service");
    return changeRole(authCtx, data.membershipId, data.role);
  });

// ── deactivateMemberFn / reactivateMemberFn ─────────────────────────────────

export const deactivateMemberFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ membershipId: z.string().uuid("Invalid membership ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { deactivateMember } = await import("@/server/team/service");
    return deactivateMember(authCtx, data.membershipId);
  });

export const reactivateMemberFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ membershipId: z.string().uuid("Invalid membership ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { reactivateMember } = await import("@/server/team/service");
    return reactivateMember(authCtx, data.membershipId);
  });

// ── getInvitationPreviewFn ───────────────────────────────────────────────────
// Requires a session (never an anonymous DB read) but intentionally does not
// require org membership — the invitee has none yet.

export const getInvitationPreviewFn = createServerFn()
  .validator((data: unknown) => z.object({ token: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const session = await getSessionFn();
    if (!session || !session.emailVerified) {
      return { status: "unauthenticated" as const };
    }
    const { previewInvitation } = await import("@/server/team/service");
    const preview = await previewInvitation(data.token, session.email);
    return { ...preview, callerEmail: session.email };
  });

// ── acceptInvitationFn ───────────────────────────────────────────────────────

export const acceptInvitationFn = createServerFn()
  .validator((data: unknown) => z.object({ token: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const session = await getSessionFn();
    if (!session || !session.emailVerified) {
      return { ok: false as const, code: "unauthenticated" as const };
    }
    const { acceptInvitationForCaller } = await import("@/server/team/accept-invitation");
    return acceptInvitationForCaller(session.accessToken, data.token);
  });
