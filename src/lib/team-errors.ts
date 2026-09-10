/**
 * Client-side classification of team/membership server errors into UI copy
 * keys. Best-effort only — real authorization and validation always happen
 * server-side (src/server/team/service.ts, src/server/team/errors.ts, and
 * src/api/team.ts#resolveAuthContext for auth). Getting a classification
 * wrong here never weakens enforcement — it only picks the wrong
 * empty/error state to show.
 *
 * Pulled out of the route/component files that use it (src/routes/app.team.tsx,
 * src/components/team/StaffDetailSheet.tsx, src/components/team/InviteStaffSheet.tsx)
 * so it is plain, dependency-free TypeScript: directly unit-testable without
 * rendering a component, and shared instead of duplicated per call site.
 */

/**
 * True only for the exact messages ForbiddenError/UnauthorizedError throw
 * for an access-denied outcome (src/server/auth/authorization.ts's
 * `require()`/`forRequest()`, and src/api/team.ts#resolveAuthContext) —
 * never a loose substring match. A repository failure like
 * `listMemberships: <db error>` contains the word "Membership" and must
 * not be misread as access denied (that previously showed "you cannot
 * manage the team", with no retry, for what was really a DB outage).
 */
export function isPermissionDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("Missing permission:") ||
    error.message === "No active organization membership" ||
    error.message === "Not authenticated"
  );
}

export type TeamActionErrorKind = "owner_protected" | "insufficient_authority" | "generic";

/**
 * Classifies a thrown team-domain server error (src/server/team/errors.ts
 * TeamError, whose `message` is exactly its `code`) from a role-change,
 * remove, reactivate, resend, or cancel action into a UI copy kind. Used so
 * a Manager-authority-cap denial (CORRECTION-001) or an unrelated failure
 * is never shown as "ownership is protected" when it isn't.
 */
export function classifyTeamActionError(err: unknown): TeamActionErrorKind {
  const message = err instanceof Error ? err.message : "";
  if (message === "cannot_modify_owner" || message === "last_owner_protected") {
    return "owner_protected";
  }
  if (message === "insufficient_role_authority") {
    return "insufficient_authority";
  }
  return "generic";
}

export type InviteFormErrorKind = "duplicate" | "insufficient_authority" | "generic";

/**
 * Classifies a thrown inviteStaff() server error into a UI copy kind.
 * CORRECTION-001 (round 2): inviteStaff() now also checks the invited
 * email's EXISTING membership (if any) before creating the invitation, so
 * it can throw either authority error changeRole/deactivateMember do —
 * `insufficient_role_authority` (target is currently Manager) or
 * `cannot_modify_owner` (target is currently Owner) — not just the
 * "assigning a too-high role" check that predates it. Both read the same to
 * an inviter: "you don't have authority over this person."
 */
export function classifyInviteError(err: unknown): InviteFormErrorKind {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("duplicate_invitation")) return "duplicate";
  if (message.includes("insufficient_role_authority") || message.includes("cannot_modify_owner")) {
    return "insufficient_authority";
  }
  return "generic";
}
