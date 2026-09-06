/**
 * Payment repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id, so the application layer and RLS
 *     both scope the tenant rather than either one being the single point of failure.
 *   - Use supabaseAdmin (service-role). RLS blocks JWT clients from writing to
 *     payments/payment_events/payment_evidence entirely (migration 034), so the
 *     server domain is the only write path in existence.
 *
 * WRITES GO THROUGH RPCs, NOT TABLE INSERTS
 *   Recording a payment writes payments + payment_events (and possibly a
 *   duplicate_flagged event) in one transaction; verifying, reversing,
 *   refunding and correcting each write payments + payment_events together.
 *   supabase-js has no client-side transaction, so the transaction has to
 *   live in the database — the RPC IS that transaction.
 *
 *   There is deliberately NO generic update function here, and NO function
 *   anywhere in this file that writes to the `orders` table. The Payment
 *   domain never mutates orders.payment_status in this phase — that
 *   integration is explicit, future work (see src/server/payments/service.ts
 *   header).
 *
 * `supabaseAdmin as any` is used because payments / payment_events /
 * payment_evidence are not yet in the generated Supabase types (migrations
 * 034–036 not yet applied to the live project). After
 * `supabase gen types typescript` is run, remove the cast.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  PaymentRow,
  PaymentEventRow,
  PaymentEvidenceRow,
  RecordPaymentInput,
  AttachEvidenceInput,
  RecordPaymentRpcResult,
  AttachEvidenceRpcResult,
  VerifyPaymentRpcResult,
  ReversePaymentRpcResult,
  RefundPaymentRpcResult,
  CorrectPaymentRpcResult,
  ListPaymentsOptions,
  PaymentReconciliationRow,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

/** Test-only override for exercising repository functions against a mocked query chain. */
export function setPaymentRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

/** PostgREST "The result contains 0 rows" — returned by .single() on a genuine no-row. */
const PGRST_NO_ROW = "PGRST116";

function errMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

// ── Writes (RPC only) ─────────────────────────────────────────────────────────

export async function recordPayment(
  organizationId: string,
  recordedBy: string | null,
  input: RecordPaymentInput,
): Promise<RecordPaymentRpcResult> {
  const { data, error } = await db.rpc("record_payment_v1", {
    p_organization_id: organizationId,
    p_order_id: input.order_id,
    p_recorded_by: recordedBy,
    p_method: input.method,
    p_amount_minor: input.amount_minor,
    p_reference: input.reference ?? null,
    p_idempotency_key: input.idempotency_key ?? null,
    p_note: input.note ?? null,
  });

  if (error) throw new Error(`recordPayment: ${errMessage(error)}`);
  return data as RecordPaymentRpcResult;
}

export async function attachEvidence(
  organizationId: string,
  uploadedBy: string | null,
  input: AttachEvidenceInput,
): Promise<AttachEvidenceRpcResult> {
  const { data, error } = await db.rpc("attach_payment_evidence_v1", {
    p_organization_id: organizationId,
    p_payment_id: input.payment_id,
    p_uploaded_by: uploadedBy,
    p_evidence_type: input.evidence_type,
    p_storage_ref: input.storage_ref,
    p_extracted_amount_minor: input.extracted_amount_minor ?? null,
    p_extracted_reference: input.extracted_reference ?? null,
  });

  if (error) throw new Error(`attachEvidence: ${errMessage(error)}`);
  return data as AttachEvidenceRpcResult;
}

export async function verifyPayment(
  organizationId: string,
  paymentId: string,
  actor: string | null,
  expectedFrom: string,
  to: string,
  reason: string | null,
  metadata: Record<string, unknown> | null,
): Promise<VerifyPaymentRpcResult> {
  const { data, error } = await db.rpc("verify_payment_v1", {
    p_organization_id: organizationId,
    p_payment_id: paymentId,
    p_actor: actor,
    p_expected_from: expectedFrom,
    p_to: to,
    p_reason: reason,
    p_metadata: metadata,
  });

  if (error) throw new Error(`verifyPayment: ${errMessage(error)}`);
  return data as VerifyPaymentRpcResult;
}

export async function reversePayment(
  organizationId: string,
  paymentId: string,
  actor: string | null,
  reason: string,
): Promise<ReversePaymentRpcResult> {
  const { data, error } = await db.rpc("reverse_payment_v1", {
    p_organization_id: organizationId,
    p_payment_id: paymentId,
    p_actor: actor,
    p_reason: reason,
  });

  if (error) throw new Error(`reversePayment: ${errMessage(error)}`);
  return data as ReversePaymentRpcResult;
}

export async function refundPayment(
  organizationId: string,
  paymentId: string,
  actor: string | null,
  amountMinor: number,
  reason: string,
): Promise<RefundPaymentRpcResult> {
  const { data, error } = await db.rpc("refund_payment_v1", {
    p_organization_id: organizationId,
    p_payment_id: paymentId,
    p_actor: actor,
    p_amount_minor: amountMinor,
    p_reason: reason,
  });

  if (error) throw new Error(`refundPayment: ${errMessage(error)}`);
  return data as RefundPaymentRpcResult;
}

export async function correctPayment(
  organizationId: string,
  paymentId: string,
  actor: string | null,
  reason: string,
  newReference: string | null,
  newNote: string | null,
): Promise<CorrectPaymentRpcResult> {
  const { data, error } = await db.rpc("correct_payment_v1", {
    p_organization_id: organizationId,
    p_payment_id: paymentId,
    p_actor: actor,
    p_reason: reason,
    p_new_reference: newReference,
    p_new_note: newNote,
  });

  if (error) throw new Error(`correctPayment: ${errMessage(error)}`);
  return data as CorrectPaymentRpcResult;
}

// ── Reads (all org-scoped) ────────────────────────────────────────────────────

/**
 * Returns null both for a payment that does not exist and for one belonging
 * to another organization. The caller cannot tell those apart, which is the
 * point: a guessed UUID must not confirm that it named something real.
 */
export async function findPaymentById(
  organizationId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const { data, error } = await db
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findPaymentById: ${errMessage(error)}`);
  }
  return (data ?? null) as PaymentRow | null;
}

export async function listPayments(
  organizationId: string,
  opts: ListPaymentsOptions = {},
): Promise<PaymentRow[]> {
  let query = db
    .from("payments")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (opts.order_id) query = query.eq("order_id", opts.order_id);
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.verification_state) query = query.eq("verification_state", opts.verification_state);
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset && opts.limit) {
    query = query.range(opts.offset, opts.offset + opts.limit - 1);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listPayments: ${errMessage(error)}`);
  return (data ?? []) as PaymentRow[];
}

export async function listPaymentEvents(
  organizationId: string,
  paymentId: string,
): Promise<PaymentEventRow[]> {
  const { data, error } = await db
    .from("payment_events")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("payment_id", paymentId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`listPaymentEvents: ${errMessage(error)}`);
  return (data ?? []) as PaymentEventRow[];
}

export async function listPaymentEvidence(
  organizationId: string,
  paymentId: string,
): Promise<PaymentEvidenceRow[]> {
  const { data, error } = await db
    .from("payment_evidence")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("payment_id", paymentId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`listPaymentEvidence: ${errMessage(error)}`);
  return (data ?? []) as PaymentEvidenceRow[];
}

export async function getReconciliationSummary(
  organizationId: string,
): Promise<PaymentReconciliationRow[]> {
  const { data, error } = await db
    .from("payment_reconciliation_summary")
    .select("*")
    .eq("organization_id", organizationId);

  if (error) throw new Error(`getReconciliationSummary: ${errMessage(error)}`);
  return (data ?? []) as PaymentReconciliationRow[];
}

// ── Cross-domain ownership checks (read-only, org-scoped) ─────────────────────
// Minimal local lookup rather than importing the Order repository, so the
// Payment domain does not take a hard module dependency on its internals —
// same approach as the Delivery repository.

export async function findOrderForOrg(
  organizationId: string,
  orderId: string,
): Promise<{ id: string; organization_id: string; currency: string } | null> {
  const { data, error } = await db
    .from("orders")
    .select("id, organization_id, currency")
    .eq("id", orderId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findOrderForOrg: ${errMessage(error)}`);
  }
  return data ?? null;
}
