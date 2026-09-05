/**
 * Inventory domain server functions — TanStack Start API boundary.
 *
 * Security model:
 *   - Session is read from HttpOnly cookies (never trusted from request body).
 *   - Organization is resolved from the user's active DB membership (never from client input).
 *   - All server-only modules (@/lib/supabase/server, @/server/inventory/*)
 *     are dynamically imported inside handler bodies so they never enter the client bundle.
 *   - Every handler requires an active session AND an inventory.* permission before touching data.
 *
 * Quantities are always integers. There is no endpoint here that sets/overwrites
 * stock directly — recordMovementFn is the only mutation, and it always appends
 * to the ledger (see src/server/inventory/service.ts).
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

const movementTypeSchema = z.enum(["initial", "sale", "return", "manual_adjustment", "restock"]);

// ── Internal helper: resolve session + organization ────────────────────────────
// organizationId is NEVER accepted from the caller — always derived from DB membership.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService } = await import("@/server/auth/authorization");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMembership } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();

  if (!rawMembership) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  const membership = rawMembership as { organization_id: string };
  return AuthorizationService.forRequest(session.userId, membership.organization_id);
}

// ── recordMovementFn ─────────────────────────────────────────────────────────

export const recordMovementFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        productId: z.string().uuid("Invalid product ID"),
        variantId: z.string().uuid("Invalid variant ID"),
        locationId: z.string().uuid("Invalid location ID").nullish(),
        quantityDelta: z
          .number()
          .int("quantity_delta must be an integer")
          .refine((n) => n !== 0, "quantity_delta must not be zero"),
        movementType: movementTypeSchema,
        referenceType: z.string().max(100).nullish(),
        referenceId: z.string().uuid().nullish(),
        reason: z.string().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { recordMovement } = await import("@/server/inventory/service");
    return recordMovement(authCtx, {
      productId: data.productId,
      variantId: data.variantId,
      locationId: data.locationId ?? null,
      quantityDelta: data.quantityDelta,
      movementType: data.movementType,
      referenceType: data.referenceType ?? null,
      referenceId: data.referenceId ?? null,
      reason: data.reason ?? null,
    });
  });

// ── getVariantStockFn ────────────────────────────────────────────────────────

export const getVariantStockFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ variantId: z.string().uuid("Invalid variant ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getVariantStock } = await import("@/server/inventory/service");
    return getVariantStock(authCtx, data.variantId);
  });

// ── listMovementHistoryFn ────────────────────────────────────────────────────

export const listMovementHistoryFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        variantId: z.string().uuid().optional(),
        productId: z.string().uuid().optional(),
        locationId: z.string().uuid().nullish(),
        movementType: movementTypeSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listMovementHistory } = await import("@/server/inventory/service");
    return listMovementHistory(authCtx, {
      variant_id: data?.variantId,
      product_id: data?.productId,
      location_id: data?.locationId ?? undefined,
      movement_type: data?.movementType,
      limit: data?.limit,
      offset: data?.offset,
    });
  });
