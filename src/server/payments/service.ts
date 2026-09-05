/**
 * Payment service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Validate that the referenced order belongs to the caller's org.
 *   4. Delegate raw DB operations to the repository (which uses transactional RPCs).
 *   5. Map DB rows to domain API shapes.
 *
 * ── ARCHITECTURE INVARIANTS ──────────────────────────────────────────────────
 *
 * PAYMENT ↔ ORDER SEPARATION (FOUNDATION PHASE — READ BEFORE CHANGING THIS FILE)
 *   This file NEVER imports @/server/orders and NEVER writes to the `orders`
 *   table, directly or through any RPC. orders.payment_status (migration 023)
 *   remains exactly as it is today: a manually-driven axis, moved only by
 *   src/server/orders/service.ts#transitionPaymentStatus behind
 *   `payments.confirm`, completely unmodified by this phase.
 *
 *   Making this Payment domain the authoritative driver of
 *   orders.payment_status is EXPLICITLY OUT OF SCOPE for this phase (see the
 *   task brief's "Payment / Order separation" section) — that transactional
 *   integration is the next phase's work, and it must be done the same way
 *   migration 026 wired Inventory into Order: as ONE atomic RPC-level change,
 *   never as two sequential service calls that could crash between them. Nothing
 *   here should be "helpfully" wired to call transitionPaymentStatus — doing so
 *   would let a screenshot-derived evidence attachment or a lone staff click
 *   silently become Order truth, which is the exact failure mode SECURITY.md
 *   §41 and this domain's evidence model exist to prevent.
 *
 * EVIDENCE IS NEVER FINANCIAL AUTHORITY
 *   attachEvidence() cannot move `status` or `verification_state` — it calls
 *   attach_payment_evidence_v1 (migration 035), which touches only
 *   payment_evidence and appends an 'evidence_attached' event. See
 *   SECURITY.md §41: "Never determine actual payment success based only on:
 *   screenshot."
 *
 * NO ARBITRARY UPDATES. There is no updatePayment(patch) here. Verification
 * moves through verifyPayment(), which validates the current state against
 * the authoritative state machine (./state-machine), checks the permission
 * for that specific target state, and records an immutable event in the same
 * transaction as the change — the same discipline as Order's transition
 * functions.
 *
 * MONEY. Integer minor units everywhere. No floating-point arithmetic occurs
 * on any monetary value in this file — the only arithmetic (refund totals) is
 * in SQL, on BIGINTs.
 *
 * SENSITIVE FIELDS. `reference` and evidence `storageRef` are withheld from
 * the returned shape unless the caller holds payments.view_provider_reference
 * — the same withholding pattern the Product domain uses for cost fields.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLog, auditLogRequired } from "@/server/auth/audit";
import type { Money, Currency } from "@/types";
import * as repo from "./repository";
import {
  isValidVerificationTransition,
  isTerminalPaymentStatus,
  resultingPaymentStatus,
  VERIFICATION_TRANSITION_PERMISSIONS,
  PAYMENT_METHODS,
  PAYMENT_EVIDENCE_TYPES,
  type PaymentStatus,
  type PaymentVerificationState,
  type PaymentMethod,
  type PaymentEvidenceType,
} from "./state-machine";
import type { PaymentRow, PaymentEventRow, PaymentEvidenceRow, ListPaymentsOptions } from "./types";

// ── Exported domain types ─────────────────────────────────────────────────────

/**
 * JSON-safe value. `Record<string, unknown>` is rejected by TanStack Start's
 * server-function return-type serializability check (an `unknown` value
 * position can't be proven JSON-safe) — this recursive type can.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PaymentEventDetail {
  id: string;
  eventType: PaymentEventRow["event_type"];
  amount: Money | null;
  fromVerification: PaymentVerificationState | null;
  toVerification: PaymentVerificationState | null;
  actorUserId: string | null;
  /**
   * Free text. Withheld only where it literally contains a reference value
   * already known to belong to this payment, unless the caller holds
   * payments.view_provider_reference — see redactKnownReferencesFromText.
   */
  reason: string | null;
  metadata: JsonValue | null;
  createdAt: string;
}

export interface PaymentEvidenceDetail {
  id: string;
  evidenceType: PaymentEvidenceType;
  /** Withheld (null) unless the caller holds payments.view_provider_reference. */
  storageRef: string | null;
  extractedAmount: Money | null;
  extractedReference: string | null;
  extractedAt: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface PaymentSummary {
  id: string;
  organizationId: string;
  orderId: string;
  method: PaymentMethod;
  amount: Money;
  status: PaymentStatus;
  verificationState: PaymentVerificationState;
  /** Withheld (null) unless the caller holds payments.view_provider_reference. */
  reference: string | null;
  /**
   * Free text. Withheld only where it literally contains a reference value
   * already known to belong to this payment, unless the caller holds
   * payments.view_provider_reference — see redactKnownReferencesFromText.
   */
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentDetail extends PaymentSummary {
  events: PaymentEventDetail[];
  evidence: PaymentEvidenceDetail[];
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function toMoney(amount: number, currency: string): Money {
  return { amount, currency: currency as Currency };
}

/**
 * Minimum length before an already-known reference value is eligible for
 * redaction out of free text. APSA's real bank/KHQR references are never
 * this short; the floor exists only so a pathologically short reference
 * value could never turn into a broad substring match against ordinary
 * words/numbers in an unrelated note.
 */
const MIN_REDACTABLE_KNOWN_REFERENCE_LENGTH = 4;

/**
 * Collects the raw reference value(s) already known to exist on THIS
 * specific payment — its own `reference` column, plus any of its evidence
 * rows' OCR-extracted reference. Never a scan of arbitrary text; this is
 * exactly the same withheld value `reference`/`extractedReference` already
 * refuse to return directly.
 */
function collectKnownReferences(
  primary: string | null,
  extras: ReadonlyArray<string | null> = [],
): ReadonlySet<string> {
  const known = new Set<string>();
  if (primary) known.add(primary);
  for (const extra of extras) {
    if (extra) known.add(extra);
  }
  return known;
}

/**
 * Removes exact, literal occurrences of already-known reference values from
 * free text, replacing each with "[withheld]". Deliberately NOT a regex over
 * arbitrary numbers/patterns — it only ever removes a string this payment's
 * OWN structured data already told us is a sensitive reference (via
 * `String.prototype.split`/`join`, so no regex special-character handling is
 * even needed), so ordinary notes/reasons ("2nd installment", "table 4",
 * "typo fix") are completely unaffected unless they happen to literally
 * contain this specific payment's own reference value.
 */
function redactKnownReferencesFromText(
  text: string | null,
  knownReferences: ReadonlySet<string>,
): string | null {
  if (text === null) return null;
  let redacted = text;
  for (const reference of knownReferences) {
    if (reference.length < MIN_REDACTABLE_KNOWN_REFERENCE_LENGTH) continue;
    if (redacted.includes(reference)) {
      redacted = redacted.split(reference).join("[withheld]");
    }
  }
  return redacted;
}

function mapPayment(
  row: PaymentRow,
  canViewReference: boolean,
  extraKnownReferences: ReadonlyArray<string | null> = [],
): PaymentSummary {
  const knownReferences = canViewReference
    ? collectKnownReferences(null)
    : collectKnownReferences(row.reference, extraKnownReferences);

  return {
    id: row.id,
    organizationId: row.organization_id,
    orderId: row.order_id,
    method: row.method,
    amount: toMoney(row.amount_minor, row.currency),
    status: row.status,
    verificationState: row.verification_state,
    reference: canViewReference ? row.reference : null,
    note: redactKnownReferencesFromText(row.note, knownReferences),
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Any object key whose name contains "reference" (case-insensitive) is
 * treated as capable of carrying a raw bank/KHQR reference value and is
 * redacted. This is deliberately name-pattern-based rather than an allowlist
 * of today's known event shapes: `payment_events.metadata` is a free-form
 * JSONB column that different event types (and future ones — e.g. a bank
 * adapter's `providerReference`/`conflictingReference`, migration 035's
 * `duplicate_flagged` and `correction` events' `reference`/`before.reference`/
 * `after.reference`) can populate with different key names, and the
 * withholding guarantee must hold for shapes this file's author did not
 * anticipate, not just the ones that exist today.
 */
const REFERENCE_KEY_PATTERN = /reference/i;

function redactReferenceValues(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redactReferenceValues);
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = REFERENCE_KEY_PATTERN.test(key) ? null : redactReferenceValues(child);
    }
    return redacted;
  }
  return value;
}

function mapEvent(
  row: PaymentEventRow,
  canViewReference: boolean,
  knownReferences: ReadonlySet<string>,
): PaymentEventDetail {
  // PostgREST already deserialized this from JSONB — it is JSON-safe by
  // construction; the DB row type just isn't narrowed that precisely.
  const rawMetadata = row.metadata as JsonValue | null;

  return {
    id: row.id,
    eventType: row.event_type,
    amount:
      row.amount_minor !== null && row.currency !== null
        ? toMoney(row.amount_minor, row.currency)
        : null,
    fromVerification: row.from_verification,
    toVerification: row.to_verification,
    actorUserId: row.actor_user_id,
    // A manager/owner can freely type this payment's own raw reference into
    // a free-text reason ("confirmed via bank, ref ABA123...") — that must
    // not become a side door around the SAME field's own withholding.
    reason: canViewReference
      ? row.reason
      : redactKnownReferencesFromText(row.reason, knownReferences),
    // The top-level `reference` field on PaymentSummary is withheld unless
    // the caller holds payments.view_provider_reference — event metadata
    // must never be a side door around that same restriction (a
    // 'duplicate_flagged' event's metadata carries the raw reference, and a
    // 'correction' event's metadata carries both the old and new reference).
    metadata:
      canViewReference || rawMetadata === null ? rawMetadata : redactReferenceValues(rawMetadata),
    createdAt: row.created_at,
  };
}

function mapEvidence(row: PaymentEvidenceRow, canViewReference: boolean): PaymentEvidenceDetail {
  return {
    id: row.id,
    evidenceType: row.evidence_type,
    storageRef: canViewReference ? row.storage_ref : null,
    extractedAmount:
      row.extracted_amount_minor !== null
        ? { amount: row.extracted_amount_minor, currency: "USD" as Currency }
        : null,
    extractedReference: canViewReference ? row.extracted_reference : null,
    extractedAt: row.extracted_at,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

// ── Errors ────────────────────────────────────────────────────────────────────

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/**
 * Best-effort audit write that genuinely cannot fail the operation it
 * describes — same rationale as src/server/orders/service.ts#bestEffortAudit.
 * Reserved for routine actions (record, evidence, staff confirm, manager
 * verify). Reversal, refund and override use auditLogRequired instead.
 */
async function bestEffortAudit(
  ctx: AuthorizationContext,
  payload: Parameters<typeof auditLog>[1],
): Promise<void> {
  try {
    await auditLog(ctx, payload);
  } catch (err) {
    console.error(
      "[APSA] payment audit_log write failed (best-effort):",
      err instanceof Error ? err.message : String(err),
      { action: payload.action, organizationId: ctx.organizationId },
    );
  }
}

function recordFailureToError(result: { status: string }): Error {
  switch (result.status) {
    case "invalid_amount":
      return badRequest("Amount must be a positive integer minor amount");
    case "invalid_method":
      return badRequest("Invalid payment method");
    case "order_not_found":
      return notFound("Order not found");
    default:
      return new Error(`Payment record failed: ${result.status}`);
  }
}

function evidenceFailureToError(result: { status: string }): Error {
  switch (result.status) {
    case "invalid_evidence_type":
      return badRequest("Invalid evidence type");
    case "invalid_storage_ref":
      return badRequest("Evidence storage reference is required");
    case "invalid_amount":
      return badRequest("Extracted amount must be a non-negative integer minor amount");
    case "payment_not_found":
      return notFound("Payment not found");
    default:
      return new Error(`Evidence attachment failed: ${result.status}`);
  }
}

function verifyFailureToError(result: { status: string; current?: string }): Error {
  switch (result.status) {
    case "not_found":
      return notFound("Payment not found");
    case "stale":
      return conflict(
        `Payment verification changed concurrently (now ${result.current ?? "unknown"}) — re-read and retry`,
      );
    case "terminal":
      return conflict(`Payment is ${result.current ?? "terminal"} and can no longer be modified`);
    default:
      return new Error(`Payment verification failed: ${result.status}`);
  }
}

function reverseFailureToError(result: { status: string; current?: string }): Error {
  switch (result.status) {
    case "not_found":
      return notFound("Payment not found");
    case "reason_required":
      return badRequest("A reversal reason is required");
    case "invalid_state":
      return conflict(`Cannot reverse a payment in status '${result.current ?? "unknown"}'`);
    default:
      return new Error(`Payment reversal failed: ${result.status}`);
  }
}

function refundFailureToError(result: {
  status: string;
  current?: string;
  reason?: string;
}): Error {
  switch (result.status) {
    case "not_found":
      return notFound("Payment not found");
    case "reason_required":
      return badRequest("A refund reason is required");
    case "invalid_state":
      return conflict(`Cannot refund a payment in status '${result.current ?? "unknown"}'`);
    case "invalid_amount":
      return result.reason === "exceeds_paid_amount"
        ? conflict("Refund amount exceeds what remains to be refunded")
        : badRequest("Refund amount must be a positive integer minor amount");
    default:
      return new Error(`Payment refund failed: ${result.status}`);
  }
}

function correctFailureToError(result: { status: string }): Error {
  switch (result.status) {
    case "not_found":
      return notFound("Payment not found");
    case "reason_required":
      return badRequest("A correction reason is required");
    case "no_changes":
      return badRequest("Provide at least one field to correct");
    default:
      return new Error(`Payment correction failed: ${result.status}`);
  }
}

// ── Record ────────────────────────────────────────────────────────────────────

export interface RecordPaymentServiceInput {
  orderId: string;
  method: PaymentMethod;
  amountMinor: number;
  reference?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Record a payment against an order.
 *
 * This is "Confirm payment received" made server-durable, but it does NOT by
 * itself mean the payment is trusted at any particular level: it starts
 * status='pending', verification_state='unverified' (or 'duplicate_suspected'
 * — see migration 035). Moving to 'paid' happens through verifyPayment().
 *
 * COD is a distinct authority (payments.mark_cod) from counter payments
 * (payments.record) — field/sales staff who collect COD money should not
 * automatically be able to record arbitrary cash/KHQR/bank-transfer payments.
 */
export async function recordPayment(
  ctx: AuthorizationContext,
  input: RecordPaymentServiceInput,
): Promise<PaymentDetail> {
  ctx.require(input.method === "cod" ? "payments.mark_cod" : "payments.record");

  if (!PAYMENT_METHODS.includes(input.method)) {
    throw badRequest(`Invalid payment method: ${String(input.method)}`);
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw badRequest("Amount must be a positive integer minor amount");
  }

  const order = await repo.findOrderForOrg(ctx.organizationId, input.orderId);
  if (!order) throw notFound("Order not found");

  const result = await repo.recordPayment(ctx.organizationId, ctx.userId, {
    order_id: input.orderId,
    method: input.method,
    amount_minor: input.amountMinor,
    reference: input.reference ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    note: input.note ?? null,
  });

  if (result.status !== "success" || !result.payment_id) {
    throw recordFailureToError(result);
  }

  const detail = await requireDetail(ctx, result.payment_id);

  if (!result.replayed) {
    await bestEffortAudit(ctx, {
      action: input.method === "cod" ? "payments.mark_cod" : "payments.record",
      resourceType: "payments",
      resourceId: detail.id,
      afterJson: {
        order_id: input.orderId,
        method: detail.method,
        amount_minor: detail.amount.amount,
        currency: detail.amount.currency,
        duplicate_suspected: result.duplicate_suspected ?? false,
      },
    });
  }

  return detail;
}

// ── Evidence ──────────────────────────────────────────────────────────────────

export interface AttachEvidenceServiceInput {
  paymentId: string;
  evidenceType: PaymentEvidenceType;
  storageRef: string;
  extractedAmountMinor?: number | null | undefined;
  extractedReference?: string | null | undefined;
}

/**
 * Attach supporting evidence (screenshot, QR scan, receipt) to a payment.
 *
 * *** NEVER MOVES status OR verification_state — see file header. ***
 */
export async function attachEvidence(
  ctx: AuthorizationContext,
  input: AttachEvidenceServiceInput,
): Promise<PaymentDetail> {
  ctx.require("payments.record");

  if (!PAYMENT_EVIDENCE_TYPES.includes(input.evidenceType)) {
    throw badRequest(`Invalid evidence type: ${String(input.evidenceType)}`);
  }
  if (!input.storageRef?.trim()) {
    throw badRequest("Evidence storage reference is required");
  }
  if (
    input.extractedAmountMinor != null &&
    (!Number.isInteger(input.extractedAmountMinor) || input.extractedAmountMinor < 0)
  ) {
    throw badRequest("Extracted amount must be a non-negative integer minor amount");
  }

  await loadTargetForEvidence(ctx, input.paymentId);

  const result = await repo.attachEvidence(ctx.organizationId, ctx.userId, {
    payment_id: input.paymentId,
    evidence_type: input.evidenceType,
    storage_ref: input.storageRef.trim(),
    extracted_amount_minor: input.extractedAmountMinor ?? null,
    extracted_reference: input.extractedReference ?? null,
  });

  if (result.status !== "success") throw evidenceFailureToError(result);

  await bestEffortAudit(ctx, {
    action: "payments.record",
    resourceType: "payments",
    resourceId: input.paymentId,
    afterJson: { evidence_id: result.evidence_id, evidence_type: input.evidenceType },
  });

  return requireDetail(ctx, input.paymentId);
}

async function loadTargetForEvidence(
  ctx: AuthorizationContext,
  paymentId: string,
): Promise<PaymentRow> {
  const payment = await repo.findPaymentById(ctx.organizationId, paymentId);
  if (!payment) throw notFound("Payment not found");
  return payment;
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Shared prelude: load the payment org-scoped, and refuse anything at all
 * once it is reversed or refunded.
 */
async function loadTransitionTarget(
  ctx: AuthorizationContext,
  paymentId: string,
): Promise<PaymentRow> {
  const payment = await repo.findPaymentById(ctx.organizationId, paymentId);
  if (!payment) throw notFound("Payment not found");
  if (isTerminalPaymentStatus(payment.status)) {
    throw conflict(`Payment is ${payment.status} and can no longer be modified`);
  }
  return payment;
}

/**
 * Move the payment's verification_state, and — as the DERIVED consequence —
 * its status (see ./state-machine#resultingPaymentStatus). This is the "staff
 * confirms payment received" action (to='staff_confirmed'), a manager
 * escalation (to='manager_verified'), a future bank-adapter result
 * (to='bank_verified'), a mismatch finding (to='mismatch'), or clearing a
 * flagged duplicate (to='unverified').
 *
 * Every target requires its own permission via VERIFICATION_TRANSITION_PERMISSIONS
 * — staff_confirmed only needs payments.manual_confirm (the no-bank-required
 * "Confirm payment received" action), everything else needs payments.verify.
 */
export async function verifyPayment(
  ctx: AuthorizationContext,
  paymentId: string,
  to: PaymentVerificationState,
  reason?: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<PaymentDetail> {
  const permission = VERIFICATION_TRANSITION_PERMISSIONS[to];
  // Permission is checked before the payment is loaded, so an unauthorized
  // caller cannot use timing or error shape to learn whether a payment id is real.
  ctx.require(permission);

  const payment = await loadTransitionTarget(ctx, paymentId);
  const from = payment.verification_state;

  if (!isValidVerificationTransition(from, to)) {
    throw conflict(`Cannot move payment verification from '${from}' to '${to}'`);
  }

  const result = await repo.verifyPayment(
    ctx.organizationId,
    paymentId,
    ctx.userId,
    from,
    to,
    reason ?? null,
    metadata ?? null,
  );

  if (result.status !== "success") throw verifyFailureToError(result);

  await bestEffortAudit(ctx, {
    action: to === "staff_confirmed" ? "payments.manual_confirm" : "payments.verify",
    resourceType: "payments",
    resourceId: paymentId,
    beforeJson: { verification_state: from },
    afterJson: { verification_state: to, payment_status: resultingPaymentStatus(to) },
    ...(reason ? { reason } : {}),
  });

  return requireDetail(ctx, paymentId);
}

/** Reverse a claimed or settled payment. Never deletes the original record. */
export async function reversePayment(
  ctx: AuthorizationContext,
  paymentId: string,
  reason: string,
): Promise<PaymentDetail> {
  ctx.require("payments.reverse");

  if (!reason?.trim()) throw badRequest("A reversal reason is required");
  await loadTransitionTarget(ctx, paymentId);

  const result = await repo.reversePayment(
    ctx.organizationId,
    paymentId,
    ctx.userId,
    reason.trim(),
  );
  if (result.status !== "success") throw reverseFailureToError(result);

  // Reversal is a fail-closed, mandatory-audit action (same tier as
  // orders.refund / payments.override) — the operation must not silently
  // succeed with no audit trail.
  await auditLogRequired(ctx, {
    action: "payments.reverse",
    resourceType: "payments",
    resourceId: paymentId,
    reason,
  });

  return requireDetail(ctx, paymentId);
}

/**
 * Refund a payment, in full or in part. Refunded totals are DERIVED by
 * summing prior refund events (migration 035) — payments.amount_minor is
 * never mutated.
 */
export async function refundPayment(
  ctx: AuthorizationContext,
  paymentId: string,
  amountMinor: number,
  reason: string,
): Promise<PaymentDetail> {
  ctx.require("payments.refund");

  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw badRequest("Refund amount must be a positive integer minor amount");
  }
  if (!reason?.trim()) throw badRequest("A refund reason is required");

  const payment = await repo.findPaymentById(ctx.organizationId, paymentId);
  if (!payment) throw notFound("Payment not found");

  const result = await repo.refundPayment(
    ctx.organizationId,
    paymentId,
    ctx.userId,
    amountMinor,
    reason.trim(),
  );
  if (result.status !== "success") throw refundFailureToError(result);

  await auditLogRequired(ctx, {
    action: "payments.refund",
    resourceType: "payments",
    resourceId: paymentId,
    afterJson: {
      refunded_amount_minor: amountMinor,
      refunded_total: result.refunded_total,
      fully_refunded: result.fully_refunded ?? false,
    },
    reason,
  });

  return requireDetail(ctx, paymentId);
}

/**
 * Owner-level correction of a payment's `reference` or `note`. Never touches
 * amount/method/currency — see migration 035's correct_payment_v1 header.
 */
export async function correctPayment(
  ctx: AuthorizationContext,
  paymentId: string,
  reason: string,
  updates: { reference?: string | null; note?: string | null },
): Promise<PaymentDetail> {
  ctx.require("payments.override_status");

  if (!reason?.trim()) throw badRequest("A correction reason is required");
  if (updates.reference == null && updates.note == null) {
    throw badRequest("Provide at least one field to correct");
  }

  const payment = await repo.findPaymentById(ctx.organizationId, paymentId);
  if (!payment) throw notFound("Payment not found");

  const result = await repo.correctPayment(
    ctx.organizationId,
    paymentId,
    ctx.userId,
    reason.trim(),
    updates.reference ?? null,
    updates.note ?? null,
  );
  if (result.status !== "success") throw correctFailureToError(result);

  await auditLogRequired(ctx, {
    action: "payments.override",
    resourceType: "payments",
    resourceId: paymentId,
    beforeJson: { reference: payment.reference, note: payment.note },
    afterJson: { reference: updates.reference ?? undefined, note: updates.note ?? undefined },
    reason,
  });

  return requireDetail(ctx, paymentId);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

async function loadDetail(
  ctx: AuthorizationContext,
  paymentId: string,
): Promise<PaymentDetail | null> {
  const payment = await repo.findPaymentById(ctx.organizationId, paymentId);
  if (!payment) return null;

  const canViewReference = ctx.can("payments.view_provider_reference");
  const [events, evidence] = await Promise.all([
    repo.listPaymentEvents(ctx.organizationId, paymentId),
    repo.listPaymentEvidence(ctx.organizationId, paymentId),
  ]);

  const extractedReferences = evidence.map((row) => row.extracted_reference);
  const knownReferences = canViewReference
    ? collectKnownReferences(null)
    : collectKnownReferences(payment.reference, extractedReferences);

  return {
    ...mapPayment(payment, canViewReference, extractedReferences),
    events: events.map((row) => mapEvent(row, canViewReference, knownReferences)),
    evidence: evidence.map((row) => mapEvidence(row, canViewReference)),
  };
}

async function requireDetail(ctx: AuthorizationContext, paymentId: string): Promise<PaymentDetail> {
  const detail = await loadDetail(ctx, paymentId);
  if (!detail) throw notFound("Payment not found");
  return detail;
}

/**
 * Fetch one payment with its event ledger and evidence.
 *
 * Org-scoped: a payment belonging to another organization produces exactly
 * the same 404 as one that does not exist, so a guessed UUID reveals nothing.
 */
export async function getPaymentById(
  ctx: AuthorizationContext,
  paymentId: string,
): Promise<PaymentDetail> {
  ctx.require("payments.read");
  return requireDetail(ctx, paymentId);
}

/** Payments newest first, org-scoped, optionally filtered. */
export async function listPayments(
  ctx: AuthorizationContext,
  opts: ListPaymentsOptions = {},
): Promise<PaymentSummary[]> {
  ctx.require("payments.read");
  const canViewReference = ctx.can("payments.view_provider_reference");
  const rows = await repo.listPayments(ctx.organizationId, opts);
  return rows.map((row) => mapPayment(row, canViewReference));
}
