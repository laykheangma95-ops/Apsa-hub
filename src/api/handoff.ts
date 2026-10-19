/**
 * Courier Handoff API — TanStack Start server functions.
 *
 * Security posture identical to src/api/packing.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/handoff/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service: requires delivery.handoff.
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

// The member + organization the client STARTED a courier handoff as
// (CORRECTIONS.md, CORRECTION-004, packing and handoff addendum). A refuse-only
// precondition the service compares with the principal it derives from the
// session — never authorization, never a tenant selector, never an actor
// (src/server/auth/expected-principal.ts). REQUIRED: a request without it is
// refused here, before the handler runs.
const expectedPrincipalSchema = z
  .object({ userId: z.string().uuid(), organizationId: z.string().uuid() })
  .strict();

// ── getHandoffPreviewFn ──────────────────────────────────────────────────────

export const getHandoffPreviewFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        parcelCode: z.string().min(1, "Parcel code is required").max(100, "Parcel code too long"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getHandoffPreview } = await import("@/server/handoff/service");
    return getHandoffPreview(authCtx, data.parcelCode);
  });

// ── confirmHandoffFn ─────────────────────────────────────────────────────────

export const confirmHandoffFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        parcelCode: z.string().min(1, "Parcel code is required").max(100, "Parcel code too long"),
        // Refuse-only: the principal this handoff was started as.
        expectedPrincipal: expectedPrincipalSchema,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { confirmHandoff } = await import("@/server/handoff/service");
    return confirmHandoff(authCtx, data.parcelCode, data.expectedPrincipal);
  });
