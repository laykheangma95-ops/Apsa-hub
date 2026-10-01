/**
 * Parcel Resolution API — TanStack Start server function.
 *
 * Resolves a parcel code to its full operational context: Parcel → Order →
 * Customer → Delivery → Shipping Snapshot. Returns identifiers only, never PII.
 *
 * Security:
 *   - Session from HttpOnly cookies; organization resolved from active membership.
 *   - No organizationId parameter — never trust the client for tenant scope.
 *   - Server-only modules dynamically imported so they never enter the client bundle.
 *   - Permission enforced: fulfillment.scan_parcel.
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

export const resolveParcelIdentityFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        parcelCode: z.string().min(1, "Parcel code is required").max(100, "Parcel code too long"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resolveParcelIdentity } = await import("@/server/parcels/resolution");
    return resolveParcelIdentity(authCtx, data.parcelCode);
  });
