/**
 * Customer Returns API — TanStack Start server functions.
 *
 * Security posture identical to src/api/stock-count.ts:
 *   - Session from HttpOnly cookies; organization resolved from the caller's
 *     active membership. No organizationId parameter exists on any handler.
 *   - Server-only modules (@/server/returns/*) are dynamically imported in
 *     handler bodies so they never enter the client bundle.
 *   - Permissions are enforced in the service (orders.return + orders.read).
 *
 * There is no organization, product, variant, location, movement type, delta
 * or balance on the wire: a request names an order and per-line quantities;
 * inspection and completion name per-line damaged counts. The server derives —
 * and re-checks — the rest.
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

const returnIdSchema = z.string().uuid("Invalid return ID");

const inspectionLinesSchema = z
  .array(
    z
      .object({
        returnItemId: z.string().uuid("Invalid return line"),
        damagedQuantity: z
          .number()
          .int("damaged quantity must be a whole number")
          .min(0)
          .max(100_000),
      })
      .strict(),
  )
  .min(1, "Inspect at least one line")
  .max(100, "Too many lines");

// ── listCustomerReturnsFn ────────────────────────────────────────────────────

export const listCustomerReturnsFn = createServerFn().handler(async () => {
  const authCtx = await resolveAuthContext();
  const { listCustomerReturns } = await import("@/server/returns/service");
  return listCustomerReturns(authCtx);
});

// ── getCustomerReturnFn ──────────────────────────────────────────────────────

export const getCustomerReturnFn = createServerFn()
  .validator((data: unknown) => z.object({ returnId: returnIdSchema }).strict().parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getCustomerReturn } = await import("@/server/returns/service");
    return getCustomerReturn(authCtx, data.returnId);
  });

// ── findReturnableOrderFn ────────────────────────────────────────────────────

export const findReturnableOrderFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderNumber: z.string().min(1, "Order number is required").max(64, "Order number too long"),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { findReturnableOrder } = await import("@/server/returns/service");
    return findReturnableOrder(authCtx, data.orderNumber);
  });

// ── findReturnableOrderByParcelFn ────────────────────────────────────────────

export const findReturnableOrderByParcelFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        parcelCode: z.string().min(1, "Parcel code is required").max(100, "Parcel code too long"),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { findReturnableOrderByParcel } = await import("@/server/returns/service");
    return findReturnableOrderByParcel(authCtx, data.parcelCode);
  });

// ── requestCustomerReturnFn ──────────────────────────────────────────────────

export const requestCustomerReturnFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        requestKey: z.string().uuid("Invalid request key"),
        orderId: z.string().uuid("Invalid order ID"),
        lines: z
          .array(
            z
              .object({
                orderItemId: z.string().uuid("Invalid order line"),
                quantity: z.number().int("quantity must be a whole number").min(1).max(100_000),
              })
              .strict(),
          )
          .min(1, "Select at least one item")
          .max(100, "Too many lines"),
      })
      .strict()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { requestCustomerReturn } = await import("@/server/returns/service");
    return requestCustomerReturn(authCtx, data);
  });

// ── receiveCustomerReturnFn ──────────────────────────────────────────────────

export const receiveCustomerReturnFn = createServerFn()
  .validator((data: unknown) => z.object({ returnId: returnIdSchema }).strict().parse(data))
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { receiveCustomerReturn } = await import("@/server/returns/service");
    return receiveCustomerReturn(authCtx, data.returnId);
  });

// ── inspectCustomerReturnFn ──────────────────────────────────────────────────

export const inspectCustomerReturnFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ returnId: returnIdSchema, lines: inspectionLinesSchema }).strict().parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { inspectCustomerReturn } = await import("@/server/returns/service");
    return inspectCustomerReturn(authCtx, data);
  });

// ── completeCustomerReturnFn ─────────────────────────────────────────────────

export const completeCustomerReturnFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ returnId: returnIdSchema, expected: inspectionLinesSchema }).strict().parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { completeCustomerReturn } = await import("@/server/returns/service");
    return completeCustomerReturn(authCtx, data);
  });
