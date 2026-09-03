/**
 * Central authorization service.
 *
 * All permission checks in server code must go through this service.
 * No permission check may live in a React component or client-side code.
 *
 * Usage:
 *   const authCtx = await AuthorizationService.forRequest(userId, organizationId);
 *   authCtx.require("orders.refund");
 *   // ... proceed with the action
 */
import {
  verifyActiveMembership,
  resolveOrganizationId,
  type MembershipContext,
} from "./membership";
import { supabaseAdmin } from "@/lib/supabase/server";

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Authorization context for a specific user + organization pair.
 * All permission checks are performed against this context.
 */
export class AuthorizationContext {
  private readonly ctx: MembershipContext;

  constructor(ctx: MembershipContext) {
    this.ctx = ctx;
  }

  get userId(): string {
    return this.ctx.membership.user_id;
  }

  get organizationId(): string {
    return this.ctx.membership.organization_id;
  }

  get roleId(): string {
    return this.ctx.membership.role_id;
  }

  get systemRole(): string | null {
    return this.ctx.role.system_role;
  }

  get permissions(): Set<string> {
    return this.ctx.permissions;
  }

  /** Check if the user has a specific permission key (e.g. "orders.refund"). */
  can(permissionKey: string): boolean {
    return this.ctx.permissions.has(permissionKey);
  }

  /** Throw ForbiddenError if the user lacks the permission. */
  require(permissionKey: string): void {
    if (!this.can(permissionKey)) {
      throw new ForbiddenError(`Missing permission: ${permissionKey}`);
    }
  }

  /** Check if the user is an owner (system_role OWNER). */
  isOwner(): boolean {
    return this.ctx.role.system_role === "OWNER";
  }

  /** Throw ForbiddenError if the user is not an owner. */
  requireOwner(): void {
    if (!this.isOwner()) {
      throw new ForbiddenError("Owner access required");
    }
  }
}

/**
 * The central authorization service.
 */
export const AuthorizationService = {
  /**
   * Build authorization context for a user + organization.
   * Throws UnauthorizedError if no active membership exists.
   *
   * organizationId must come from a trusted server-side source — never
   * pass in a value that came directly from a client request body.
   */
  async forRequest(
    userId: string,
    organizationId: string,
  ): Promise<AuthorizationContext> {
    const ctx = await verifyActiveMembership(userId, organizationId);
    if (!ctx) {
      throw new UnauthorizedError("No active membership in this organization");
    }
    return new AuthorizationContext(ctx);
  },

  /**
   * Build context by resolving an organization from its slug.
   * Slug is safe to accept from the URL — ID is derived server-side.
   */
  async forSlug(userId: string, orgSlug: string): Promise<AuthorizationContext> {
    const orgId = await resolveOrganizationId(orgSlug);
    if (!orgId) {
      throw new ForbiddenError("Organization not found");
    }
    return this.forRequest(userId, orgId);
  },

  /**
   * Check a permission without throwing — useful for conditional UI data.
   * Prefer authCtx.require() in server actions where access should be hard-denied.
   */
  async can(
    userId: string,
    organizationId: string,
    permissionKey: string,
  ): Promise<boolean> {
    const ctx = await verifyActiveMembership(userId, organizationId);
    if (!ctx) return false;
    return ctx.permissions.has(permissionKey);
  },
};

/**
 * Owner protection: verify that removing/demoting a membership would not
 * leave the organization with zero active owners.
 *
 * Must be called before any operation that changes a membership role or status.
 */
export async function assertOwnerWouldRemain(
  organizationId: string,
  affectedUserId: string,
): Promise<void> {
  // Find the system OWNER role (organization_id IS NULL = template role)
  const { data: rawOwnerRole } = await supabaseAdmin
    .from("roles")
    .select("id")
    .eq("system_role", "OWNER")
    .is("organization_id", null)
    .single();

  if (!rawOwnerRole) return;
  const ownerRole = rawOwnerRole as unknown as { id: string };

  const { count } = await supabaseAdmin
    .from("memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role_id", ownerRole.id)
    .eq("status", "active")
    .neq("user_id", affectedUserId);

  if ((count ?? 0) === 0) {
    throw new ForbiddenError(
      "Cannot remove or demote: organization must retain at least one active owner",
    );
  }
}
