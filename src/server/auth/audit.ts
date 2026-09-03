/**
 * Audit logging service — server-side only.
 *
 * All sensitive actions must call auditLog() after execution.
 * Audit records are append-only and must never be modified.
 * Uses the service-role key to bypass RLS for writes.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

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
  | "org.update"
  | "org.ownership_transfer";

export interface AuditContext {
  organizationId: string;
  actorUserId: string;
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
 * Write an audit log entry.
 * For critical actions, await before returning.
 * Never throws — audit failure must not cascade to block the main operation.
 */
export async function auditLog(ctx: AuditContext): Promise<void> {
  const payload = {
    organization_id: ctx.organizationId,
    actor_user_id: ctx.actorUserId,
    action: ctx.action,
    resource_type: ctx.resourceType,
    resource_id: ctx.resourceId ?? null,
    before_json: ctx.beforeJson ?? null,
    after_json: ctx.afterJson ?? null,
    reason: ctx.reason ?? null,
    ip_address: ctx.ipAddress ?? null,
    user_agent: ctx.userAgent ?? null,
  };

  // Explicit cast required: supabase-js type inference needs a connected project.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any).from("audit_logs").insert(payload);

  if (error) {
    // Audit failure is logged but never rethrown — main operation must not be blocked.
    console.error("[APSA] audit_log write failed:", (error as { message?: string }).message, {
      action: ctx.action,
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId,
    });
  }
}
