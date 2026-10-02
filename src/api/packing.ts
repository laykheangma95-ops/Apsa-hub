/**
 * Packing domain server functions — TanStack Start API boundary.
 *
 * Security posture identical to src/api/picking.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/packing/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service: requires orders.read.
 *   - Scan validation is server-authoritative — the client displays results
 *     but never decides whether a scan is valid.
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

// ── getPackRequirementsFn ────────────────────────────────────────────────────

export const getPackRequirementsFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ orderId: z.string().uuid("Invalid order ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getPackRequirements } = await import("@/server/packing/service");
    return getPackRequirements(authCtx, data.orderId);
  });

// ── validatePackParcelScanFn ─────────────────────────────────────────────────

export const validatePackParcelScanFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        scannedCode: z.string().min(1, "Scanned code is required"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { validatePackParcelScan } = await import("@/server/packing/service");
    return validatePackParcelScan(authCtx, data.orderId, data.scannedCode);
  });

// ── validatePackProductScanFn ────────────────────────────────────────────────

export const validatePackProductScanFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        barcode: z.string().min(1, "Barcode is required"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { validatePackProductScan } = await import("@/server/packing/service");
    return validatePackProductScan(authCtx, data.orderId, data.barcode);
  });
