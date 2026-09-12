/**
 * Payments Operations — the browser-side pure layer for /app/payments.
 *
 * No React, no fetching, no server imports at runtime — only `import type`
 * (erased at compile time, never bundled), exactly like src/lib/deliveries.ts
 * and src/lib/orders.ts. Every value here is either a mapping of a shape the
 * server already produced, or a pure READ of "what may be offered" that the
 * server re-decides on its own.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────────
 *
 * It never computes a financial fact. There is no refund arithmetic, no
 * settlement total, no "is this actually paid" inference, no currency
 * conversion and no cross-currency sum anywhere in this module. Every number
 * the Payments UI renders arrives already computed by the Payment domain
 * (src/server/payments/**) or by SQL (order_payment_totals, migration 040).
 *
 * The three axes stay separate, as the Payment domain models them:
 *
 *   status              settlement outcome of ONE payment record
 *                        pending -> paid -> (reversed | refunded), or failed
 *   verificationState   how much the claim "this money arrived" can be trusted
 *                        unverified -> staff_confirmed -> manager_verified ->
 *                        bank_verified, with mismatch / duplicate_suspected
 *   refund              a SEPARATE axis. A partial refund leaves the payment
 *                        `paid` (refund_payment_v1, migration 035/040); only a
 *                        cumulative refund equal to the principal moves it to
 *                        `refunded`. The order-level none/partial/full verdict
 *                        comes from order_payment_totals, never from here.
 *
 * ── THE TWO MIRRORED TABLES BELOW ────────────────────────────────────────────
 *
 * UI_VERIFICATION_TRANSITIONS and UI_VERIFICATION_TRANSITION_PERMISSIONS are
 * client-side copies of src/server/payments/state-machine.ts, kept here only
 * so the screen knows which buttons to draw — the same deliberate pattern as
 * DELIVERY_TRANSITIONS in src/lib/deliveries.ts, and never a substitute for
 * server authorization. Drift is not left to review: src/tests/
 * payments-operations-ui.test.ts asserts both tables are exhaustively
 * identical to the server's, and that paymentNeedsReview() agrees with
 * src/server/payments/reconciliation.ts#paymentRowNeedsReview on all
 * status x verification_state combinations.
 */
import type {
  PaymentDetail as ServerPaymentDetail,
  PaymentEventDetail as ServerPaymentEventDetail,
  PaymentEvidenceDetail as ServerPaymentEvidenceDetail,
  PaymentSummary as ServerPaymentSummary,
  JsonValue,
} from "@/server/payments/service";
import type {
  OrderSettlement as ServerOrderSettlement,
  ReconciliationSummary as ServerReconciliationSummary,
} from "@/server/payments/reconciliation";
import type {
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationState,
} from "@/server/payments/state-machine";
import type { PaymentEvidenceType, PaymentEventType } from "@/server/payments/types";
import type { Currency, Money } from "@/types";

// Re-exported so screens never need their own import of the server-only
// modules — this file's `import type` is the only place that touches them.
export type {
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationState,
  PaymentEvidenceType,
  PaymentEventType,
};

// ── Server → UI mapping ───────────────────────────────────────────────────────

export interface UiPayment {
  id: string;
  orderId: string;
  method: PaymentMethod;
  /** Integer minor units with an explicit currency, exactly as the server sent it. */
  amount: Money;
  status: PaymentStatus;
  verificationState: PaymentVerificationState;
  /** null whenever the server withheld it (no payments.view_provider_reference). */
  reference: string | null;
  /** Withheld entirely on list reads; redacted against known references on detail reads. */
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UiPaymentEvent {
  id: string;
  eventType: PaymentEventType;
  /** Present on refund events (the refunded amount) and on 'created'. Never summed here. */
  amount: Money | null;
  fromVerification: PaymentVerificationState | null;
  toVerification: PaymentVerificationState | null;
  actorUserId: string | null;
  reason: string | null;
  metadata: JsonValue | null;
  createdAt: string;
}

export interface UiPaymentEvidence {
  id: string;
  evidenceType: PaymentEvidenceType;
  /** null unless the caller holds payments.view_provider_reference. */
  storageRef: string | null;
  extractedReference: string | null;
  extractedAt: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface UiPaymentDetail extends UiPayment {
  events: UiPaymentEvent[];
  evidence: UiPaymentEvidence[];
}

export function mapPaymentSummaryToUi(row: ServerPaymentSummary): UiPayment {
  return {
    id: row.id,
    orderId: row.orderId,
    method: row.method,
    amount: row.amount,
    status: row.status,
    verificationState: row.verificationState,
    reference: row.reference,
    note: row.note,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPaymentEventToUi(row: ServerPaymentEventDetail): UiPaymentEvent {
  return {
    id: row.id,
    eventType: row.eventType,
    amount: row.amount,
    fromVerification: row.fromVerification,
    toVerification: row.toVerification,
    actorUserId: row.actorUserId,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

/**
 * `extractedAmount` is deliberately NOT carried into the UI shape.
 *
 * src/server/payments/service.ts#mapEvidence stamps every OCR-extracted
 * evidence amount with a hard-coded `currency: "USD"` regardless of the
 * payment's own currency, so on a KHR payment that field names the wrong
 * currency. Rendering it would put an untrue currency in front of a merchant,
 * which ARCHITECTURE.md's money rules forbid; the fix belongs to the Payment
 * domain, not to this UI phase. Reported as a known gap rather than papered
 * over here — the rest of the evidence metadata is unaffected and is carried
 * through unchanged.
 */
function mapPaymentEvidenceToUi(row: ServerPaymentEvidenceDetail): UiPaymentEvidence {
  return {
    id: row.id,
    evidenceType: row.evidenceType,
    storageRef: row.storageRef,
    extractedReference: row.extractedReference,
    extractedAt: row.extractedAt,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

export function mapPaymentDetailToUi(detail: ServerPaymentDetail): UiPaymentDetail {
  return {
    ...mapPaymentSummaryToUi(detail),
    events: detail.events.map(mapPaymentEventToUi),
    evidence: detail.evidence.map(mapPaymentEvidenceToUi),
  };
}

// ── Order settlement (order_payment_totals, migration 040) ───────────────────

export interface UiOrderSettlement {
  orderId: string;
  total: Money;
  received: Money;
  refunded: Money;
  net: Money;
  /** The Order's own payment axis, derived in SQL. A refund never "unpays" it. */
  paymentStatus: string;
  /** The Order's own refund axis, derived in SQL: none | partial | full. */
  refundStatus: string;
  overpaid: boolean;
  overpaidAmount: Money | null;
}

export function mapOrderSettlementToUi(row: ServerOrderSettlement): UiOrderSettlement {
  return {
    orderId: row.orderId,
    total: row.totalMinor,
    received: row.receivedMinor,
    refunded: row.refundedMinor,
    net: row.netMinor,
    paymentStatus: row.paymentStatus,
    refundStatus: row.refundStatus,
    overpaid: row.overpaid,
    overpaidAmount: row.overpaidAmount,
  };
}

// ── Reconciliation aggregates (payment_reconciliation_summary, migration 034) ─

export interface UiReconciliationBucket {
  count: number;
  amount: Money;
}

/**
 * One currency's attention picture, exactly as the server bucketed it.
 *
 * The server returns ONE ENTRY PER CURRENCY and never blends them, because
 * there is no implicit exchange rate in APSA. This UI shape keeps that shape:
 * there is no combined total anywhere, and the screen renders one band per
 * currency rather than one number.
 *
 * Only the buckets the attention band actually shows are carried over —
 * expectedRevenue, trust tiers and the rest of ReconciliationSummary stay
 * server-side until a screen has an honest use for them.
 */
export interface UiPaymentReconciliation {
  currency: Currency;
  /** The server's own count of currently-unresolved review items. */
  needsReview: UiReconciliationBucket;
  pending: UiReconciliationBucket;
  mismatch: UiReconciliationBucket;
  duplicateSuspected: UiReconciliationBucket;
  /** method = 'cod' and status = 'pending' — collected in the field, not yet settled. */
  codUnsettled: UiReconciliationBucket;
}

export function mapPaymentReconciliationToUi(
  rows: readonly ServerReconciliationSummary[],
): UiPaymentReconciliation[] {
  return rows.map((row) => ({
    currency: row.currency,
    needsReview: row.needsReview,
    pending: row.pending,
    mismatch: row.mismatch,
    duplicateSuspected: row.duplicateSuspected,
    codUnsettled: row.codUnsettled,
  }));
}

/** True when this currency has nothing waiting on the merchant. */
export function reconciliationIsQuiet(summary: UiPaymentReconciliation): boolean {
  return summary.needsReview.count === 0 && summary.codUnsettled.count === 0;
}

// ── Identity ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for the id shape the payment server functions accept.
 *
 * Not a security check: an id that passes here is still only ever resolved
 * inside the caller's own organization, server-side. A payment belonging to
 * another organization looks exactly like this one and comes back not-found.
 */
export function isPaymentId(id: string): boolean {
  return UUID_RE.test(id);
}

// ── Review / attention (mirrors reconciliation.ts#paymentRowNeedsReview) ──────

/**
 * The Payment domain's own definition of a currently-unresolved review item,
 * applied to a single payment record instead of a reconciliation bucket.
 *
 * A reversed or refunded payment is never "needs review": voiding or
 * returning it already resolved whatever needed reviewing. This is a
 * presentation marker over two authoritative server fields — the count a
 * merchant is held to is the server's own (getPaymentAttentionCount, already
 * surfaced on Home), never this.
 */
export function paymentNeedsReview(payment: {
  status: PaymentStatus;
  verificationState: PaymentVerificationState;
}): boolean {
  if (payment.status === "reversed" || payment.status === "refunded") return false;
  return (
    payment.verificationState === "duplicate_suspected" ||
    payment.verificationState === "mismatch" ||
    (payment.status === "pending" && payment.verificationState === "unverified")
  );
}

// ── Filters (every one of them a filter the SERVER runs) ─────────────────────
//
// listPaymentsFn accepts exactly two filter dimensions — `status` and
// `verificationState` — and applies both in SQL (src/server/payments/
// repository.ts#listPayments). Each chip below therefore maps to a real
// server query, never to a narrowing of the rows that happen to be on screen.
//
// There is deliberately no single "needs review" chip: that rule is a UNION
// (mismatch OR duplicate_suspected OR pending+unverified) and the list
// endpoint cannot express a union, so offering one chip would mean either
// filtering client-side over a capped page (dishonest) or inventing a
// simplified status model (forbidden). The three constituent filters are
// offered separately instead, and each row still carries its own review
// marker.

export type PaymentFilterId =
  "all" | `status:${PaymentStatus}` | `verification:${PaymentVerificationState}`;

export interface PaymentFilterDef {
  id: PaymentFilterId;
  labelKey: string;
  /** Sent to listPaymentsFn as `status`. Applied in SQL. */
  status?: PaymentStatus;
  /** Sent to listPaymentsFn as `verificationState`. Applied in SQL. */
  verificationState?: PaymentVerificationState;
}

export const PAYMENT_FILTERS: readonly PaymentFilterDef[] = [
  { id: "all", labelKey: "payments.filters.all" },
  {
    id: "verification:mismatch",
    labelKey: "payments.verification.mismatch",
    verificationState: "mismatch",
  },
  {
    id: "verification:duplicate_suspected",
    labelKey: "payments.verification.duplicate_suspected",
    verificationState: "duplicate_suspected",
  },
  {
    id: "verification:unverified",
    labelKey: "payments.verification.unverified",
    verificationState: "unverified",
  },
  { id: "status:pending", labelKey: "payments.status.pending", status: "pending" },
  { id: "status:paid", labelKey: "payments.status.paid", status: "paid" },
  { id: "status:failed", labelKey: "payments.status.failed", status: "failed" },
  { id: "status:refunded", labelKey: "payments.status.refunded", status: "refunded" },
  { id: "status:reversed", labelKey: "payments.status.reversed", status: "reversed" },
  {
    id: "verification:staff_confirmed",
    labelKey: "payments.verification.staff_confirmed",
    verificationState: "staff_confirmed",
  },
  {
    id: "verification:manager_verified",
    labelKey: "payments.verification.manager_verified",
    verificationState: "manager_verified",
  },
  {
    id: "verification:bank_verified",
    labelKey: "payments.verification.bank_verified",
    verificationState: "bank_verified",
  },
];

export function findPaymentFilter(id: PaymentFilterId): PaymentFilterDef {
  return PAYMENT_FILTERS.find((filter) => filter.id === id) ?? PAYMENT_FILTERS[0]!;
}

// ── Action-visibility rules (mirrors src/server/payments/state-machine.ts) ────

/** Reversed and refunded freeze the record — see service.ts#loadTransitionTarget. */
const TERMINAL_UI_PAYMENT_STATUSES: readonly PaymentStatus[] = ["reversed", "refunded"];

export function isTerminalUiPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_UI_PAYMENT_STATUSES.includes(status);
}

export const UI_VERIFICATION_TRANSITIONS: Readonly<
  Record<PaymentVerificationState, readonly PaymentVerificationState[]>
> = {
  unverified: ["staff_confirmed", "bank_verified", "mismatch"],
  staff_confirmed: ["manager_verified", "bank_verified", "mismatch"],
  manager_verified: ["bank_verified", "mismatch"],
  bank_verified: ["mismatch"],
  mismatch: ["unverified"],
  duplicate_suspected: ["unverified", "staff_confirmed", "manager_verified", "mismatch"],
};

/**
 * The permission each verification target needs. Copied from the server's
 * VERIFICATION_TRANSITION_PERMISSIONS so the screen can hide a control the
 * member could not use; verifyPayment() requires the very same key again,
 * server-side, before anything moves.
 */
export const UI_VERIFICATION_TRANSITION_PERMISSIONS: Readonly<
  Record<PaymentVerificationState, "payments.verify" | "payments.manual_confirm">
> = {
  unverified: "payments.verify",
  staff_confirmed: "payments.manual_confirm",
  manager_verified: "payments.verify",
  bank_verified: "payments.verify",
  mismatch: "payments.verify",
  duplicate_suspected: "payments.verify",
};

/**
 * Which verification moves this payment could accept right now, before
 * permissions are considered. Empty once the record is frozen.
 */
export function availableVerificationTargets(payment: {
  status: PaymentStatus;
  verificationState: PaymentVerificationState;
}): readonly PaymentVerificationState[] {
  if (isTerminalUiPaymentStatus(payment.status)) return [];
  return UI_VERIFICATION_TRANSITIONS[payment.verificationState];
}

/**
 * reverse_payment_v1 accepts 'pending' or 'paid' only (migration 035): a
 * reversal undoes a claimed or settled payment, never one that already
 * failed, was already reversed, or was refunded.
 */
export function canReverseUiPayment(payment: { status: PaymentStatus }): boolean {
  return payment.status === "pending" || payment.status === "paid";
}

/**
 * refund_payment_v1 accepts 'paid' or 'refunded' (migration 040), but a
 * payment already at 'refunded' has, by definition, a cumulative refund equal
 * to its principal, so every further refund is rejected as exceeding it. The
 * only state where a refund can still succeed is therefore 'paid' — which is
 * also where a PARTIAL refund leaves the record, so this stays true for the
 * second and third partial refund of the same payment.
 */
export function canRefundUiPayment(payment: { status: PaymentStatus }): boolean {
  return payment.status === "paid";
}

/**
 * The one refund fact a LIST row can state truthfully.
 *
 * `refunded` is the status refund_payment_v1 sets once the cumulative refund
 * equals the principal, so it means fully refunded and nothing else. A `paid`
 * payment may carry partial refunds, and the list endpoint returns no refund
 * total, so the list must not claim either way — the payment's own detail
 * screen shows the refund events, and the order settlement panel shows the
 * authoritative none/partial/full verdict from SQL.
 */
export function isFullyRefundedUiPayment(payment: { status: PaymentStatus }): boolean {
  return payment.status === "refunded";
}

/** Refund entries from the immutable event ledger, newest first. Never summed. */
export function refundEventsOf(detail: UiPaymentDetail): UiPaymentEvent[] {
  return detail.events.filter((event) => event.eventType === "refund");
}

// ── Refund intent identity (idempotency) ─────────────────────────────────────
//
// refund_payment_v1 (migration 040) is idempotent ON A KEY and only on a key:
// the refund event carries `idempotency_key`, the partial unique index
// payment_refund_idempotency makes (organization_id, payment_id,
// idempotency_key) unique, and a second call carrying a key that already
// named a refund returns THAT refund's own result stamped `replayed: true`
// instead of writing a second refund event. A call reusing a key with a
// different amount or reason is rejected outright rather than quietly
// treated as either one.
//
// None of that protects anything unless the browser actually sends a key, and
// it only protects a retry if the SAME key comes back. A refund whose response
// is lost — the RPC committed inside PostgreSQL, the connection died before
// the answer reached the tab — is, from the browser, indistinguishable from
// one that never ran. Without a key the obvious "try again" records a second
// refund event and returns a customer's money twice.
//
// A RefundIntent is therefore ONE logical refund decision: minted once when
// the merchant opens the refund sheet, reused for every retry of that same
// decision, and discarded the moment the refund is known to have landed.
//
// The key is OPAQUE — crypto.randomUUID() — and is deliberately NOT derived
// from the payment id, the amount or the reason. Deriving it from those would
// be the same defect pointing the other way: two deliberate $20 "Damaged item"
// refunds on one payment are two real refunds totalling $40, and a derived key
// would silently collapse the second into a replay of the first.

/** One logical refund decision, and the key every attempt at it must carry. */
export interface RefundIntent {
  /** Opaque. Never derived from paymentId, amountMinor or reason. */
  readonly idempotencyKey: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  /** Trimmed, because that is the form the server compares a replay against. */
  readonly reason: string;
}

/**
 * A fresh opaque refund key.
 *
 * Fails closed: without a real random source there is no safe key, and a
 * refund with no safe key is exactly the unprotected retry this exists to
 * prevent — so no refund is attempted at all.
 */
export function newRefundIdempotencyKey(): string {
  const source = globalThis.crypto;
  if (!source || typeof source.randomUUID !== "function") {
    throw new Error("A refund cannot be started without a secure random source");
  }
  return `refund-${source.randomUUID()}`;
}

/**
 * The intent this confirm press belongs to.
 *
 * `held` is the intent the screen is already carrying for the open refund
 * sheet. If this press asks for the very same refund (same payment, same
 * integer minor amount, same trimmed reason) it is a RETRY of that decision
 * and keeps its key, so a lost response cannot become a second refund. If any
 * of the three differs the merchant is asking for a different refund, which
 * must not inherit a key the server may already have bound to other terms.
 *
 * A NEW deliberate refund starts with `held` null — the screen drops the
 * intent when the refund sheet opens and again once a refund has landed — so
 * it always mints a new key even when its amount and reason repeat an earlier
 * refund exactly.
 */
export function resolveRefundIntent(
  held: RefundIntent | null | undefined,
  request: { paymentId: string; amountMinor: number; reason: string },
  mintKey: () => string = newRefundIdempotencyKey,
): RefundIntent {
  const reason = request.reason.trim();
  if (
    held &&
    held.paymentId === request.paymentId &&
    held.amountMinor === request.amountMinor &&
    held.reason === reason
  ) {
    return held;
  }
  return {
    idempotencyKey: mintKey(),
    paymentId: request.paymentId,
    amountMinor: request.amountMinor,
    reason,
  };
}

// ── Error classification ──────────────────────────────────────────────────────
//
// src/server/payments/service.ts throws Error instances carrying a
// `statusCode` own property (400/401/403/404/409) with a clean, human-authored
// message. Mirrors classifyDeliveryError in src/lib/deliveries.ts. Never
// surfaces err.message directly to the merchant — a payment error message can
// quote a reference value.

export type PaymentErrorKind =
  "unauthorized" | "forbidden" | "not_found" | "conflict" | "invalid" | "server_error";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

function statusCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

export function classifyPaymentError(err: unknown): PaymentErrorKind {
  const code = statusCodeOf(err);
  const message = messageOf(err);

  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 404) return "not_found";
  if (code === 409) return "conflict";
  if (code === 400) return "invalid";

  // Fallback for the rare case a statusCode does not survive the RPC
  // boundary: pattern-match service.ts's own crafted message text.
  if (/not authenticated|no active organization membership/i.test(message)) return "unauthorized";
  if (/missing permission/i.test(message)) return "forbidden";
  if (/not found/i.test(message)) return "not_found";
  if (
    /can no longer be modified|changed concurrently|cannot move payment verification|already/i.test(
      message,
    )
  ) {
    return "conflict";
  }
  if (/required|must be a positive integer|exceeds|invalid/i.test(message)) return "invalid";
  return "server_error";
}

/** i18n key for a classified payment error. Mirrors catalogErrorKey. */
export function paymentErrorKey(kind: PaymentErrorKind): string {
  return `payments.errors.${kind}`;
}

// ── Withholding cached data on an explicit denial ────────────────────────────
//
// TanStack Query keeps the last successful `data` when a refetch fails. For
// an ordinary blip that is the right behaviour and this module keeps it: a
// timed-out poll on a patchy connection must not blank out payment rows the
// server really did send.
//
// A 403/401 is not a blip. It is the server's current, definitive answer that
// this principal may not read these payments — a revoked payments.read, a
// membership ended, a session no longer good. The cached rows were true when
// they were fetched and are not true now, and the screen must stop showing
// them on the very next render: not after an invalidation, not after a
// successful refetch, not after a navigation. So the denial is applied to the
// RENDER rather than to the cache — a synchronous mask needs no round trip
// and cannot race a refetch, and removing the entry instead would only make
// the same query mount and fetch again.
//
// Only forbidden and unauthorized mask. not_found has its own honest screen;
// conflict, invalid and server_error are transient or request-specific and
// leave real rows alone.

/** True when the server has definitively refused this read for this principal. */
export function paymentAccessDenied(kind: PaymentErrorKind | null | undefined): boolean {
  return kind === "forbidden" || kind === "unauthorized";
}

/**
 * The rows a payments surface may render right now — the single required gate
 * between a cached page of payments and anything drawn from it.
 */
export function visiblePaymentRows<T>(
  rows: readonly T[] | null | undefined,
  kind: PaymentErrorKind | null | undefined,
): T[] {
  if (paymentAccessDenied(kind)) return [];
  return rows ? [...rows] : [];
}

/** The same gate for a single cached record (a payment detail, a settlement). */
export function visiblePaymentRecord<T>(
  record: T | null | undefined,
  kind: PaymentErrorKind | null | undefined,
): T | null {
  if (paymentAccessDenied(kind)) return null;
  return record ?? null;
}
