/**
 * Fulfillment (packing) domain server functions — TanStack Start API boundary.
 *
 * Security posture identical to src/api/orders.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/fulfillment/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service: the queue requires orders.read;
 *     the parcel label additionally requires customers.view_sensitive because it
 *     exposes fulfillment PII.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { AuthorizationService } = await import("@/server/auth/authorization");
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);

  if (!organizationId) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  return AuthorizationService.forRequest(session.userId, organizationId);
}

// ── listReadyToPackFn ──────────────────────────────────────────────────────────

export const listReadyToPackFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listReadyToPack } = await import("@/server/fulfillment/service");
    const opts: { limit?: number; offset?: number } = {};
    if (data?.limit !== undefined) opts.limit = data.limit;
    if (data?.offset !== undefined) opts.offset = data.offset;
    return listReadyToPack(authCtx, opts);
  });

// ── getParcelLabelDataFn ───────────────────────────────────────────────────────

export const getParcelLabelDataFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ orderId: z.string().uuid("Invalid order ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getParcelLabelData } = await import("@/server/fulfillment/service");
    return getParcelLabelData(authCtx, data.orderId);
  });

// ── getInternalParcelLabelDataFn ───────────────────────────────────────────────

export const getInternalParcelLabelDataFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ orderId: z.string().uuid("Invalid order ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getInternalParcelLabelData } = await import("@/server/fulfillment/service");
    return getInternalParcelLabelData(authCtx, data.orderId);
  });
