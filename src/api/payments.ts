/**
 * Payment domain server functions — TanStack Start API boundary.
 *
 * Security model (identical posture to src/api/orders.ts / src/api/deliveries.ts):
 *   - Session is read from HttpOnly cookies, never trusted from a request body.
 *   - Organization is resolved from the user's active DB membership. There is
 *     no organizationId parameter on any function here, so a caller has no way
 *     to name a tenant.
 *   - user_id comes from the validated session, never from input.
 *   - All server-only modules (@/lib/supabase/server, @/server/payments/*) are
 *     dynamically imported inside handler bodies so they never enter the client
 *     bundle.
 *   - Every handler requires an active session AND a payments.* permission
 *     (checked in the service) before touching data.
 *
 * MONEY: the only monetary inputs are amountMinor (recording a payment) and
 * refund amountMinor — both integer minor units, both validated server-side.
 *
 * STATE: there is no "update payment" function. Verification moves only
 * through verifyPaymentFn, which runs the authoritative state machine
 * server-side. Reversal, refund and correction are separate, narrow handlers.
 *
 * ORDER BOUNDARY: no handler here ever touches orders.payment_status — see
 * src/server/payments/service.ts's file header. This domain is foundation-
 * only in this phase.
 *
 * Usage from components: import these functions and call them directly —
 * TanStack Start routes them to the server automatically.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";
import type { AuthorizationContext } from "@/server/auth/authorization";

const paymentMethodSchema = z.enum(["cash", "khqr", "bank_transfer", "cod"]);
const evidenceTypeSchema = z.enum(["screenshot", "qr_scan", "receipt", "other"]);
const verificationStateSchema = z.enum([
  "unverified",
  "staff_confirmed",
  "manager_verified",
  "bank_verified",
  "mismatch",
  "duplicate_suspected",
]);
const paymentStatusSchema = z.enum(["pending", "paid", "failed", "reversed", "refunded"]);

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

// ── recordPaymentFn ───────────────────────────────────────────────────────────

export const recordPaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid("Invalid order ID"),
        method: paymentMethodSchema,
        amountMinor: z.number().int().positive("amountMinor must be a positive integer"),
        reference: z.string().trim().min(1).max(200).nullish(),
        idempotencyKey: z.string().trim().min(1).max(200).nullish(),
        note: z.string().trim().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { recordPayment } = await import("@/server/payments/service");
    return recordPayment(authCtx, {
      orderId: data.orderId,
      method: data.method,
      amountMinor: data.amountMinor,
      reference: data.reference ?? null,
      idempotencyKey: data.idempotencyKey ?? null,
      note: data.note ?? null,
    });
  });

// ── attachPaymentEvidenceFn ───────────────────────────────────────────────────

export const attachPaymentEvidenceFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment ID"),
        evidenceType: evidenceTypeSchema,
        storageRef: z.string().trim().min(1).max(2000),
        extractedAmountMinor: z.number().int().min(0).nullish(),
        extractedReference: z.string().trim().min(1).max(200).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { attachEvidence } = await import("@/server/payments/service");
    return attachEvidence(authCtx, {
      paymentId: data.paymentId,
      evidenceType: data.evidenceType,
      storageRef: data.storageRef,
      extractedAmountMinor: data.extractedAmountMinor ?? null,
      extractedReference: data.extractedReference ?? null,
    });
  });

// ── verifyPaymentFn ───────────────────────────────────────────────────────────
//
// One narrow function, one authoritative state machine — the target is part
// of the contract (a zod enum), so a caller cannot request an unknown state.

export const verifyPaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment ID"),
        to: verificationStateSchema,
        reason: z.string().trim().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { verifyPayment } = await import("@/server/payments/service");
    return verifyPayment(authCtx, data.paymentId, data.to, data.reason ?? null, null);
  });

// ── reversePaymentFn ──────────────────────────────────────────────────────────

export const reversePaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment ID"),
        reason: z.string().trim().min(1, "A reversal reason is required").max(1000),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { reversePayment } = await import("@/server/payments/service");
    return reversePayment(authCtx, data.paymentId, data.reason);
  });

// ── refundPaymentFn ───────────────────────────────────────────────────────────

export const refundPaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment ID"),
        amountMinor: z.number().int().positive("amountMinor must be a positive integer"),
        reason: z.string().trim().min(1, "A refund reason is required").max(1000),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { refundPayment } = await import("@/server/payments/service");
    return refundPayment(authCtx, data.paymentId, data.amountMinor, data.reason);
  });

// ── correctPaymentFn ──────────────────────────────────────────────────────────

export const correctPaymentFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment ID"),
        reason: z.string().trim().min(1, "A correction reason is required").max(1000),
        reference: z.string().trim().min(1).max(200).nullish(),
        note: z.string().trim().max(1000).nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { correctPayment } = await import("@/server/payments/service");
    return correctPayment(authCtx, data.paymentId, data.reason, {
      reference: data.reference ?? null,
      note: data.note ?? null,
    });
  });

// ── Reads ─────────────────────────────────────────────────────────────────────

export const getPaymentByIdFn = createServerFn()
  .validator((data: unknown) =>
    z.object({ paymentId: z.string().uuid("Invalid payment ID") }).parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { getPaymentById } = await import("@/server/payments/service");
    return getPaymentById(authCtx, data.paymentId);
  });

export const listPaymentsFn = createServerFn()
  .validator((data: unknown) =>
    z
      .object({
        orderId: z.string().uuid().optional(),
        status: paymentStatusSchema.optional(),
        verificationState: verificationStateSchema.optional(),
        // Capped so a caller cannot ask for the whole tenant in one request.
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(async ({ data }) => {
    const authCtx = await resolveAuthContext();
    const { listPayments } = await import("@/server/payments/service");
    return listPayments(authCtx, {
      order_id: data?.orderId,
      status: data?.status,
      verification_state: data?.verificationState,
      limit: data?.limit ?? 50,
      offset: data?.offset,
    });
  });

// ── getPaymentReconciliationFn ────────────────────────────────────────────────
//
// Reconciliation FOUNDATION only — no dashboard UI is built on this yet. See
// src/server/payments/reconciliation.ts.

export const getPaymentReconciliationFn = createServerFn().handler(async () => {
  const authCtx = await resolveAuthContext();
  const { getReconciliationSummary } = await import("@/server/payments/reconciliation");
  return getReconciliationSummary(authCtx);
});
