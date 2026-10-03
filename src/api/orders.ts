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
 * only monetary inputs in this file are `discountMinor` (gated on
 * orders.apply_discount) and `deliveryMinor` — integer minor-unit inputs to the
 * server's own calculation, both bounded server-side. Everything else is priced from the catalog inside the
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
import { ORDER_CODE_MAX_LENGTH } from "@/lib/order-code";
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

/**
 * Optional order shipping destination snapshot (migration 047). These are
 * loosely bounded here; the authoritative validation/normalization (non-blank
 * when supplied, phone shape, no markup) is the service's — never the client's.
 */
const shippingSnapshotSchema = z.object({
  name: z.string().max(500).nullish(),
  phone: z.string().max(100).nullish(),
  address: z.string().max(2000).nullish(),
});

// ── Internal helper: resolve session + organization ────────────────────────────
// organizationId is NEVER accepted from the caller — always derived from DB membership.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { AuthorizationService } = await import("@/server/auth/authorization");

  // organization_id is derived from the canonical active membership
  // (src/lib/active-organization.ts), never client input.
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);

  if (!organizationId) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  return AuthorizationService.forRequest(session.userId, organizationId);
}

// ── createOrderFn ─────────────────────────────────────────────────────────────

export const createOrderFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        source: orderSourceSchema,
        items: z.array(orderLineSchema).min(1, "An order must contain at least one item"),
        customerId: z.string().uuid("Invalid customer ID").nullish(),
        locationId: z.string().uuid("Invalid location ID").nullish(),
        // Integer minor units. An input to the server's calculation, never a total.
        discountMinor: z.number().int().min(0).optional(),
        // Opaque provenance only (Conversation -> Order linkage). Never a FK,
        // never conversation content — see migration 030.
        sourceConversationRef: z.string().trim().min(1).max(200).nullish(),
        // Integer minor units the merchant charges for delivery. An input to
        // the server's calculation (bounded per currency by create_order_v2),
        // never a total and never the courier's cost.
        deliveryMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        // One logical creation attempt; reused verbatim on every retry of it.
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9_-]{16,128}$/, "A valid idempotency key is required"),
        // Optional order shipping destination — snapshotted onto the order and
        // folded into the idempotency fingerprint server-side (migration 047).
        shipping: shippingSnapshotSchema.optional(),
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
      sourceConversationRef: data.sourceConversationRef ?? null,
      deliveryMinor: data.deliveryMinor,
      idempotencyKey: data.idempotencyKey,
      ...(data.shipping ? { shipping: data.shipping } : {}),
    });
  });

// ── updateOrderShippingFn ───────────────────────────────────────────────────────
//
// The "Confirm / edit shipping destination" write. Narrow by construction:
// orderId + the three shipping fields, nothing else. The service requires
// orders.update and the RPC refuses once fulfillment is terminal, so a shipped
// parcel's destination is never casually rewritten.

export const updateOrderShippingFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        shipping: shippingSnapshotSchema,
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { updateOrderShippingSnapshot } = await import("@/server/orders/service");
    return updateOrderShippingSnapshot(authCtx, data.orderId, data.shipping);
  });

// ── Transitions ───────────────────────────────────────────────────────────────
//
// Three narrow functions rather than one generic setStatus(axis, value): the
// axis is part of the contract, so a caller cannot aim a fulfillment value at
// the payment column and rely on validation to catch it.

export const transitionOrderLifecycleFn = createServerFn({ method: "POST" })
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

/**
 * Recover a confirmed order left without its APSA Parcel (Order detail "Create
 * APSA Parcel"). Same authority as confirmation, enforced in the service; the
 * lifecycle check and the parcel write are one locked database decision.
 */
export const recoverOrderParcelFn = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ orderId: z.string().uuid("Invalid order ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { recoverOrderParcel } = await import("@/server/orders/service");
    return recoverOrderParcel(authCtx, data.orderId);
  });

/** @deprecated Always rejects; callers must use Payment recording/verification. */
export const transitionOrderPaymentFn = createServerFn({ method: "POST" })
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

export const transitionOrderFulfillmentFn = createServerFn({ method: "POST" })
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

/**
 * Find one order by the merchant-facing code ("APSA-2026-000123").
 *
 * No organizationId parameter, exactly like every other function here: the
 * organization comes from the caller's active membership, so a code cannot be
 * aimed at another tenant. Order numbers are unique per tenant, which makes
 * that scoping load-bearing rather than incidental — the same string is a real
 * order in many organizations at once.
 *
 * Returns null for "no order carries this code", which is an ordinary search
 * answer and NOT an error. A cross-tenant code and an unissued one produce the
 * identical null.
 */
export const findOrderByCodeFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        // Bounded at the same length the domain accepts; the normalization
        // itself is the domain's (src/lib/order-code.ts), not this validator's.
        code: z.string().trim().min(1, "Order code is required").max(ORDER_CODE_MAX_LENGTH),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { findOrderByCode } = await import("@/server/orders/service");
    const order = await findOrderByCode(authCtx, data.code);
    // Wrapped rather than returned bare: a top-level null is indistinguishable
    // from a handler that returned nothing at all on the client side.
    return { order };
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
