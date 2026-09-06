/**
 * Raw DB row types for the Payment domain.
 * These match the columns in migrations 034–035 exactly.
 * Never used in UI — mapped to domain types by the service layer.
 *
 * Money fields are `number` holding an INTEGER MINOR UNIT. They are BIGINT in
 * Postgres, which PostgREST serialises as a JSON number; every realistic
 * payment amount is far inside Number.MAX_SAFE_INTEGER, so no bigint handling
 * is needed here. There is no float money.
 */

import type {
  PaymentStatus,
  PaymentVerificationState,
  PaymentMethod,
  PaymentEvidenceType,
} from "./state-machine";

export type { PaymentStatus, PaymentVerificationState, PaymentMethod, PaymentEvidenceType };

export type PaymentCurrency = "USD" | "KHR";

export type PaymentEventType =
  | "created"
  | "evidence_attached"
  | "staff_confirmed"
  | "manager_verified"
  | "bank_verified"
  | "verification_failed"
  | "correction"
  | "reversal"
  | "refund"
  | "duplicate_flagged";

export interface PaymentRow {
  id: string;
  organization_id: string;
  order_id: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  amount_minor: number;
  status: PaymentStatus;
  verification_state: PaymentVerificationState;
  reference: string | null;
  idempotency_key: string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentEventRow {
  id: string;
  organization_id: string;
  payment_id: string;
  event_type: PaymentEventType;
  amount_minor: number | null;
  currency: PaymentCurrency | null;
  from_verification: PaymentVerificationState | null;
  to_verification: PaymentVerificationState | null;
  actor_user_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface PaymentEvidenceRow {
  id: string;
  organization_id: string;
  payment_id: string;
  evidence_type: PaymentEvidenceType;
  storage_ref: string;
  extracted_amount_minor: number | null;
  extracted_reference: string | null;
  extracted_at: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/** Input as it reaches the repository. organization_id is a separate, server-supplied argument. */
export interface RecordPaymentInput {
  order_id: string;
  method: PaymentMethod;
  amount_minor: number;
  reference?: string | null | undefined;
  idempotency_key?: string | null | undefined;
  note?: string | null | undefined;
}

export interface AttachEvidenceInput {
  payment_id: string;
  evidence_type: PaymentEvidenceType;
  storage_ref: string;
  extracted_amount_minor?: number | null | undefined;
  extracted_reference?: string | null | undefined;
}

/** Result envelope returned by record_payment_v1. */
export interface RecordPaymentRpcResult {
  status: string;
  payment_id?: string;
  duplicate_suspected?: boolean;
  replayed?: boolean;
}

/** Result envelope returned by attach_payment_evidence_v1. */
export interface AttachEvidenceRpcResult {
  status: string;
  evidence_id?: string;
}

/** Result envelope returned by verify_payment_v1. */
export interface VerifyPaymentRpcResult {
  status: string;
  current?: string;
  from?: string;
  to?: string;
  payment_status?: string;
}

/** Result envelope returned by reverse_payment_v1. */
export interface ReversePaymentRpcResult {
  status: string;
  current?: string;
}

/** Result envelope returned by refund_payment_v1. */
export interface RefundPaymentRpcResult {
  status: string;
  current?: string;
  reason?: string;
  already_refunded?: number;
  payment_amount?: number;
  refunded_total?: number;
  fully_refunded?: boolean;
}

/** Result envelope returned by correct_payment_v1. */
export interface CorrectPaymentRpcResult {
  status: string;
}

/** Filter/pagination options for listing payments. All optional; all org-scoped by the repository. */
export interface ListPaymentsOptions {
  order_id?: string | undefined;
  status?: PaymentStatus | undefined;
  verification_state?: PaymentVerificationState | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** One row of the payment_reconciliation_summary view (migration 034). */
export interface PaymentReconciliationRow {
  organization_id: string;
  method: PaymentMethod;
  currency: PaymentCurrency;
  status: PaymentStatus;
  verification_state: PaymentVerificationState;
  payment_count: number;
  amount_minor_total: number;
}
