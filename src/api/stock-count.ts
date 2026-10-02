/**
 * Stock Count API — TanStack Start server functions.
 *
 * Security posture identical to src/api/receiving.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/inventory/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service (inventory.adjust + inventory.read,
 *     plus products.read to identify a product).
 *
 * There is no movement type, delta, product id or new balance on the wire: a
 * count names a variant, a location, what was counted and which system
 * quantity the merchant was shown; the server derives everything else.
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

const locationIdSchema = z.string().uuid("Invalid location ID").nullable();
const countedQuantitySchema = z
  .number()
  .int("counted_quantity must be a whole number")
  .min(0)
  .max(1_000_000);

// ── resolveStockCountScanFn ──────────────────────────────────────────────────

export const resolveStockCountScanFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        raw: z.string().min(1, "Scan value is required").max(200, "Scan value too long"),
        locationId: locationIdSchema,
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { resolveStockCountScan } = await import("@/server/inventory/stock-count");
    return resolveStockCountScan(authCtx, data.raw, data.locationId);
  });

// ── searchStockCountProductsFn ───────────────────────────────────────────────

export const searchStockCountProductsFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({ query: z.string().max(200, "Search too long") })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { searchStockCountProducts } = await import("@/server/inventory/stock-count");
    return searchStockCountProducts(authCtx, data.query);
  });

// ── getStockCountItemFn ──────────────────────────────────────────────────────

export const getStockCountItemFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        variantId: z.string().uuid("Invalid variant ID"),
        locationId: locationIdSchema,
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getStockCountItem } = await import("@/server/inventory/stock-count");
    return getStockCountItem(authCtx, data.variantId, data.locationId);
  });

// ── previewStockCountFn ──────────────────────────────────────────────────────

export const previewStockCountFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        variantId: z.string().uuid("Invalid variant ID"),
        locationId: locationIdSchema,
        countedQuantity: countedQuantitySchema,
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { previewStockCount } = await import("@/server/inventory/stock-count");
    return previewStockCount(authCtx, data);
  });

// ── recordStockCountFn ───────────────────────────────────────────────────────

export const recordStockCountFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        countKey: z.string().uuid("Invalid count key"),
        variantId: z.string().uuid("Invalid variant ID"),
        locationId: locationIdSchema,
        countedQuantity: countedQuantitySchema,
        expectedSystemQuantity: z
          .number()
          .int("expected_system_quantity must be a whole number")
          .min(-2_147_483_647)
          .max(2_147_483_647),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { recordStockCount } = await import("@/server/inventory/stock-count");
    return recordStockCount(authCtx, data);
  });
