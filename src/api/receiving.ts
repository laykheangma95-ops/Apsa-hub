/**
 * Receiving Inventory API — TanStack Start server functions.
 *
 * Security posture identical to src/api/inventory.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/inventory/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service (inventory.receive_stock, plus
 *     products.read to identify a scanned product).
 *
 * There is no quantity-on-hand, movement type or product id on the wire: the
 * receipt names a variant, a positive quantity and a receipt key, and the
 * server derives everything else.
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

// ── resolveReceivingScanFn ───────────────────────────────────────────────────

export const resolveReceivingScanFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        raw: z.string().min(1, "Scan value is required").max(200, "Scan value too long"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resolveReceivingScan } = await import("@/server/inventory/receiving");
    return resolveReceivingScan(authCtx, data.raw);
  });

// ── receiveInventoryFn ───────────────────────────────────────────────────────

export const receiveInventoryFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        receiptKey: z.string().uuid("Invalid receipt key"),
        variantId: z.string().uuid("Invalid variant ID"),
        quantity: z.number().int("quantity must be a whole number").min(1).max(100_000),
        locationId: z.string().uuid("Invalid location ID").nullish(),
        supplierName: z.string().max(200).nullish(),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { receiveInventory } = await import("@/server/inventory/receiving");
    return receiveInventory(authCtx, {
      receiptKey: data.receiptKey,
      variantId: data.variantId,
      quantity: data.quantity,
      locationId: data.locationId ?? null,
      supplierName: data.supplierName ?? null,
    });
  });
