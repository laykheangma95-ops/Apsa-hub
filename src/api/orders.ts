/**
 * Order domain server functions — TanStack Start API boundary.
 *
 * Security model (identical posture to src/api/inventory.ts):
 *   - Session is read from HttpOnly cookies, never trusted from a request body.
 *   - Organization is resolved from the user's active DB membership. There is
 *     no organizationId parameter on any function here, so a caller has no way
 *     to name a tenant — the closest thing to an IDOR primitive simply does not
 *     exist in the API surface.
 *   - user_id comes from the validated session, never from input.
 *   - All server-only modules (@/lib/supabase/server, @/server/orders/*) are
 *     dynamically imported inside handler bodies so they never enter the client
 *     bundle.
 *   - Every handler requires an active session AND an orders.* or payments.*
 *     permission (checked in the service) before touching data.
 *
 * MONEY: no handler accepts a price, a line total, a subtotal or a total. The
 * only monetary input in this file is `discountMinor` — an integer minor-unit
 * input to the server's own calculation, bounded server-side and gated on
 * orders.apply_discount. Everything else is priced from the catalog inside the
 * create RPC (migration 024).
 *
 * STATE: there is no "update order" function. Status moves only through the
 * three transition handlers, each of which runs the authoritative state machine
 * server-side. A client cannot PATCH a status.
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

const orderSourceSchema = z.enum(["POS", "FACEBOOK", "INSTAGRAM", "TELEGRAM", "MANUAL"]);
const lifecycleStatusSchema = z.enum(["draft", "confirmed", "completed", "cancelled"]);
const paymentStatusSchema = z.enum(["unpaid", "pending", "paid", "failed"]);
const fulfillmentStatusSchema = z.enum(["unfulfilled", "processing", "fulfilled", "cancelled"]);

/**
 * A requested line. Note the absence of any price field — adding one here would
 * be the single most dangerous change possible to this file.
 */
const orderLineSchema = z.object({
  variantId: z.string().uuid("Invalid variant ID"),
  quantity: z
    .number()
    .int("quantity must be an integer")
    .positive("quantity must be greater than zero"),
  /** Optional cross-check only; the server derives the product from the variant. */
  productId: z.string().uuid("Invalid product ID").optional(),
});

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

// ── createOrderFn ─────────────────────────────────────────────────────────────

export const createOrderFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        source: orderSourceSchema,
        items: z.array(orderLineSchema).min(1, "An order must contain at least one item"),
        customerId: z.string().uuid("Invalid customer ID").nullish(),
        locationId: z.string().uuid("Invalid location ID").nullish(),
        // Integer minor units. An input to the server's calculation, never a total.
        discountMinor: z.number().int().min(0).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { createOrder } = await import("@/server/orders/service");
    return createOrder(authCtx, {
      source: data.source,
      items: data.items.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        productId: line.productId,
      })),
      customerId: data.customerId ?? null,
      locationId: data.locationId ?? null,
      discountMinor: data.discountMinor,
    });
  });

// ── Transitions ───────────────────────────────────────────────────────────────
//
// Three narrow functions rather than one generic setStatus(axis, value): the
// axis is part of the contract, so a caller cannot aim a fulfillment value at
// the payment column and rely on validation to catch it.

export const transitionOrderLifecycleFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        to: lifecycleStatusSchema,
        reason: z.string().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { transitionLifecycleStatus } = await import("@/server/orders/service");
    return transitionLifecycleStatus(authCtx, data.orderId, data.to, data.reason ?? null);
  });

export const transitionOrderPaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        to: paymentStatusSchema,
        reason: z.string().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { transitionPaymentStatus } = await import("@/server/orders/service");
    return transitionPaymentStatus(authCtx, data.orderId, data.to, data.reason ?? null);
  });

export const transitionOrderFulfillmentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        to: fulfillmentStatusSchema,
        reason: z.string().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { transitionFulfillmentStatus } = await import("@/server/orders/service");
    return transitionFulfillmentStatus(authCtx, data.orderId, data.to, data.reason ?? null);
  });

// ── Reads ─────────────────────────────────────────────────────────────────────

export const getOrderByIdFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ orderId: z.string().uuid("Invalid order ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getOrderById } = await import("@/server/orders/service");
    return getOrderById(authCtx, data.orderId);
  });

export const listOrdersFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        customerId: z.string().uuid().optional(),
        lifecycleStatus: lifecycleStatusSchema.optional(),
        paymentStatus: paymentStatusSchema.optional(),
        fulfillmentStatus: fulfillmentStatusSchema.optional(),
        // Capped so a caller cannot ask for the whole tenant in one request.
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listOrders } = await import("@/server/orders/service");
    return listOrders(authCtx, {
      customer_id: data?.customerId,
      lifecycle_status: data?.lifecycleStatus,
      payment_status: data?.paymentStatus,
      fulfillment_status: data?.fulfillmentStatus,
      limit: data?.limit ?? 50,
      offset: data?.offset,
    });
  });
