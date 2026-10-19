/**
 * The public refusal for a mandatory-audit action whose audit row could not be
 * written: 503 `audit_unavailable`, the same whether the row was a separate
 * insert (auditLogRequired) or part of the action's own database transaction
 * (refund / reverse / correct, migration 062 — the money rolled back with it).
 *
 * Its own module, so a repository can raise it without importing the audit
 * writer itself. Server-only.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuditAction } from "./audit";

export function auditUnavailableError(action: AuditAction): Error {
  return publicError(
    `Audit record could not be persisted for action '${action}'. The operation was blocked to preserve the audit trail.`,
    503,
    "audit_unavailable",
  );
}
