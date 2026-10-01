/**
 * Scan identity router API — TanStack Start server function.
 *
 * The single entry point for every barcode/QR scan resolution in APSA.
 * The raw scanned value is sent to the server, which normalizes it, classifies
 * it, and resolves it against the caller's org-scoped data. The result tells
 * the client what was scanned and where to navigate.
 *
 * Security:
 *   - Session from HttpOnly cookies; organization resolved from active membership.
 *   - No organizationId parameter — never trust the client for tenant scope.
 *   - Server-only modules dynamically imported so they never enter the client bundle.
 *   - Permissions enforced per identity type in the scan service.
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

// ── resolveScanFn ────────────────────────────────────────────────────────────

export const resolveScanFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        raw: z.string().min(1, "Scan value is required").max(200, "Scan value too long"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resolveScan } = await import("@/server/scan/service");
    return resolveScan(authCtx, data.raw);
  });
