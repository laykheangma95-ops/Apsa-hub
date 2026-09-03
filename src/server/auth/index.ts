/**
 * Server-side auth module public API.
 * Import from here rather than individual files.
 */
export { validateSession, extractBearerToken } from "./session";
export type { AuthSession } from "./session";

export { verifyActiveMembership, resolveOrganizationId } from "./membership";
export type { MembershipContext } from "./membership";

export {
  AuthorizationService,
  AuthorizationContext,
  ForbiddenError,
  UnauthorizedError,
  assertOwnerWouldRemain,
} from "./authorization";

export { auditLog, auditLogRequired, MANDATORY_AUDIT_ACTIONS } from "./audit";
export type { AuditAction, AuditPayload } from "./audit";
