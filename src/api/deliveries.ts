/** Browser-safe TanStack Start boundary for the production Delivery domain. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

const deliveryStatusSchema = z.enum([
  "pending",
  "preparing",
  "ready",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
]);

const deliveryIdSchema = z.object({
  deliveryId: z.string().uuid("Invalid delivery ID"),
  reason: z.string().trim().max(1000).nullish(),
});

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
  return AuthorizationService.forRequest(
    session.userId,
    (rawMembership as { organization_id: string }).organization_id,
  );
}

export const createDeliveryFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        locationId: z.string().uuid("Invalid location ID").nullish(),
        providerId: z.string().uuid("Invalid provider ID").nullish(),
        providerKey: z.string().trim().min(1).max(100).nullish(),
        providerName: z.string().trim().min(1).max(200).nullish(),
        externalTrackingNumber: z.string().trim().min(1).max(200).nullish(),
        codAmountMinor: z.number().int().min(0).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createDelivery } = await import("@/server/deliveries/service");
    return createDelivery(authCtx, {
      orderId: data.orderId,
      locationId: data.locationId ?? null,
      providerId: data.providerId ?? null,
      providerKey: data.providerKey ?? null,
      providerName: data.providerName ?? null,
      externalTrackingNumber: data.externalTrackingNumber ?? null,
      codAmountMinor: data.codAmountMinor ?? null,
    });
  });

export const startPreparingDeliveryFn = createServerFn()
  .validator((data: unknown) => deliveryIdSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { startPreparingDelivery } = await import("@/server/deliveries/service");
    return startPreparingDelivery(authCtx, data.deliveryId, data.reason ?? null);
  });

export const markDeliveryReadyFn = createServerFn()
  .validator((data: unknown) => deliveryIdSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { markDeliveryReady } = await import("@/server/deliveries/service");
    return markDeliveryReady(authCtx, data.deliveryId, data.reason ?? null);
  });

export const markDeliveryInTransitFn = createServerFn()
  .validator((data: unknown) => deliveryIdSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { markDeliveryInTransit } = await import("@/server/deliveries/service");
    return markDeliveryInTransit(authCtx, data.deliveryId, data.reason ?? null);
  });

export const markDeliveryDeliveredFn = createServerFn()
  .validator((data: unknown) => deliveryIdSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { markDeliveryDelivered } = await import("@/server/deliveries/service");
    return markDeliveryDelivered(authCtx, data.deliveryId, data.reason ?? null);
  });

const reasonRequiredSchema = z.object({
  deliveryId: z.string().uuid("Invalid delivery ID"),
  reason: z.string().trim().min(1, "A reason is required").max(1000),
});

export const markDeliveryFailedFn = createServerFn()
  .validator((data: unknown) => reasonRequiredSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { markDeliveryFailed } = await import("@/server/deliveries/service");
    return markDeliveryFailed(authCtx, data.deliveryId, data.reason);
  });

export const cancelDeliveryFn = createServerFn()
  .validator((data: unknown) => reasonRequiredSchema.parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { cancelDelivery } = await import("@/server/deliveries/service");
    return cancelDelivery(authCtx, data.deliveryId, data.reason);
  });

export const getDeliveryByIdFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ deliveryId: z.string().uuid("Invalid delivery ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getDeliveryById } = await import("@/server/deliveries/service");
    return getDeliveryById(authCtx, data.deliveryId);
  });

export const listDeliveriesFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid().optional(),
        status: deliveryStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listDeliveries } = await import("@/server/deliveries/service");
    return listDeliveries(authCtx, {
      order_id: data?.orderId,
      status: data?.status,
      limit: data?.limit ?? 50,
      offset: data?.offset,
    });
  });
