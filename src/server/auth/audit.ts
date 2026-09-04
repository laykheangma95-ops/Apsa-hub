/**
 * Audit logging service — server-side only.
 *
 * Two paths:
 *
 * 1. auditLog()         — best-effort. Logs and continues even if the write fails.
 *                         Use for informational, lower-risk activity (sign-in, read exports, etc.).
 *                         MUST NOT be called for mandatory high-risk actions — throws at runtime.
 *
 * 2. auditLogRequired() — fail-closed. Throws if the audit record cannot be persisted.
 *                         Use for mandatory high-risk actions:
 *                           - refunds, payment overrides
 *                           - role/permission changes
 *                           - stock adjustments
 *                           - staff removal
 *                           - sensitive data exports
 *                         The protected mutation and this call should share the same
 *                         service-role transaction where the DB supports it.
 *
 * SECURITY: Never pass organizationId or actorUserId from client-supplied request body.
 * Always derive them from the validated AuthorizationContext (ctx.organizationId, ctx.userId).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { AuthorizationContext } from "./authorization";

export type AuditAction =
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.password_reset"
  | "orders.cancel"
  | "orders.refund"
  | "orders.create"
  | "orders.update"
  | "payments.confirm"
  | "payments.override"
  | "inventory.adjust"
  | "products.price_change"
  | "products.delete"
  | "customers.export"
  | "team.invite"
  | "team.remove"
  | "team.role_change"
  | "org.create"
  | "org.update"
  | "org.ownership_transfer";

/** High-risk actions that MUST use auditLogRequired() — not auditLog(). */
export const MANDATORY_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set([
  "orders.refund",
  "payments.override",
  "inventory.adjust",
  "customers.export",
  "team.remove",
  "team.role_change",
  "org.ownership_transfer",
]);

export interface AuditPayload {
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Build the DB row from a validated AuthorizationContext + payload.
 * Org and actor are always taken from the server-verified context.
 */
function buildAuditRow(ctx: AuthorizationContext, payload: AuditPayload) {
  return {
    organization_id: ctx.organizationId,
    actor_user_id: ctx.userId,
    action: payload.action,
    resource_type: payload.resourceType,
    resource_id: payload.resourceId ?? null,
    before_json: payload.beforeJson ?? null,
    after_json: payload.afterJson ?? null,
    reason: payload.reason ?? null,
    ip_address: payload.ipAddress ?? null,
    user_agent: payload.userAgent ?? null,
  };
}

/**
 * Best-effort audit log write.
 * Never throws on DB failures — audit failure does NOT block the main operation.
 * Suitable for informational, lower-risk activity.
 *
 * FIX (Blocker 4): Throws immediately (programming error guard) when called with
 * a mandatory high-risk action. Mandatory actions MUST use auditLogRequired() so
 * that the operation is blocked when the audit write fails. Calling auditLog() for
 * a mandatory action would silently drop the audit trail on DB errors, which is
 * a security-correctness violation. This guard converts that silent failure into a
 * visible programming error caught at development time.
 */
export async function auditLog(
  ctx: AuthorizationContext,
  payload: AuditPayload,
): Promise<void> {
  if (MANDATORY_AUDIT_ACTIONS.has(payload.action)) {
    throw new Error(
      `[APSA] Programming error: action '${payload.action}' is a mandatory-audit action ` +
        `and must use auditLogRequired() — not auditLog(). ` +
        `auditLog() is best-effort and would silently drop the audit trail on write failures.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("audit_logs")
    .insert(buildAuditRow(ctx, payload));

  if (error) {
    console.error("[APSA] audit_log write failed (best-effort):", (error as { message?: string }).message, {
      action: payload.action,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
    });
  }
}

/**
 * Mandatory audit log write — fail-closed.
 * Throws if the audit record cannot be persisted.
 * MUST be used for all high-risk actions listed in MANDATORY_AUDIT_ACTIONS.
 *
 * Usage pattern:
 *   await auditLogRequired(ctx, { action: "orders.refund", ... });
 *   // audit confirmed — proceed with the mutation
 *   // OR: wrap mutation + audit in the same DB transaction via service role
 */
export async function auditLogRequired(
  ctx: AuthorizationContext,
  payload: AuditPayload,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("audit_logs")
    .insert(buildAuditRow(ctx, payload));

  if (error) {
    const msg = (error as { message?: string }).message ?? "unknown error";
    console.error("[APSA] CRITICAL: mandatory audit_log write failed — blocking action:", msg, {
      action: payload.action,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
    });
    throw new Error(
      `Audit record could not be persisted for action '${payload.action}'. The operation was blocked to preserve the audit trail. (${msg})`,
    );
  }
}
