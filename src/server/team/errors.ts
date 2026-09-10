export type TeamErrorCode =
  | "membership_not_found"
  | "invitation_not_found"
  | "duplicate_invitation"
  | "invitation_expired"
  | "invitation_already_used"
  | "invitation_email_mismatch"
  | "owner_role_forbidden"
  | "cannot_modify_owner"
  | "last_owner_protected"
  | "invalid_input";

export class TeamError extends Error {
  readonly statusCode: number;
  constructor(readonly code: TeamErrorCode) {
    super(code);
    this.name = "TeamError";
    this.statusCode = code.endsWith("not_found")
      ? 404
      : code === "duplicate_invitation"
        ? 409
        : code === "owner_role_forbidden" ||
            code === "cannot_modify_owner" ||
            code === "last_owner_protected"
          ? 403
          : code === "invitation_expired" ||
              code === "invitation_already_used" ||
              code === "invitation_email_mismatch"
            ? 410
            : 400;
  }
}
