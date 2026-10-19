/**
 * Parcel identity API — TanStack Start server functions.
 *
 * Security posture identical to src/api/fulfillment.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/parcels/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service.
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

// The member + organization the client STARTED this request as (CORRECTIONS.md,
// CORRECTION-004). A required precondition the service compares with the
// principal it derives from the session — it can only refuse, never authorize
// or attribute (src/server/auth/expected-principal.ts). The one identity field
// this file's validators accept.
const expectedPrincipalSchema = z
  .object({ userId: z.string().uuid(), organizationId: z.string().uuid() })
  .strict();

// ── createParcelFn ────────────────────────────────────────────────────────────

export const createParcelFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        // Refuse-only: the principal this request was started as.
        expectedPrincipal: expectedPrincipalSchema,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createParcelForOrder } = await import("@/server/parcels/service");
    return createParcelForOrder(authCtx, data.orderId, data.expectedPrincipal);
  });

// ── resolveParcelCodeFn ───────────────────────────────────────────────────────

export const resolveParcelCodeFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        code: z.string().min(1, "Code is required").max(100, "Code too long"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resolveParcelCode } = await import("@/server/parcels/service");
    return resolveParcelCode(authCtx, data.code);
  });
