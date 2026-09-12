/**
 * Payments Operations UI — behavioural tests.
 *
 * These run the real functions the /app/payments screens run, against real
 * server-shaped inputs. Where a rule is MIRRORED on the client so a button can
 * be drawn (the verification transition table, its permission map, the
 * needs-review predicate), the test does not restate the mirror — it compares
 * it, exhaustively, against the server module it mirrors, so the two can never
 * drift apart without a failure here.
 *
 * The service-level half (tenant isolation, permission denial, note
 * withholding, the client boundary's no-mock-fallback rule) needs module
 * mocking, which is process-wide in bun, so it lives in the spawned
 * payments-operations-ui.runtime.ts — same split as payment-domain.test.ts.
 *
 * Run: bun test src/tests/payments-operations-ui.test.ts
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import * as fs from "fs";
import * as path from "path";

import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_VERIFICATION_STATES,
  VERIFICATION_TRANSITIONS,
  VERIFICATION_TRANSITION_PERMISSIONS,
  type PaymentStatus,
  type PaymentVerificationState,
} from "@/server/payments/state-machine";
import { paymentRowNeedsReview } from "@/server/payments/reconciliation";
import type { PaymentReconciliationRow } from "@/server/payments/types";
import type {
  PaymentDetail as ServerPaymentDetail,
  PaymentSummary as ServerPaymentSummary,
} from "@/server/payments/service";
import type { OrderSettlement } from "@/server/payments/reconciliation";

import {
  availableVerificationTargets,
  canRefundUiPayment,
  canReverseUiPayment,
  classifyPaymentError,
  findPaymentFilter,
  isFullyRefundedUiPayment,
  isPaymentId,
  isTerminalUiPaymentStatus,
  mapOrderSettlementToUi,
  mapPaymentDetailToUi,
  mapPaymentReconciliationToUi,
  mapPaymentSummaryToUi,
  paymentErrorKey,
  governingPaymentDenial,
  paymentAccessDenied,
  paymentNeedsReview,
  PAYMENT_FILTERS,
  reconciliationIsQuiet,
  refundEventsOf,
  newRefundIdempotencyKey,
  resolveRefundIntent,
  UI_VERIFICATION_TRANSITIONS,
  UI_VERIFICATION_TRANSITION_PERMISSIONS,
  visiblePaymentRecord,
  visiblePaymentRows,
  type PaymentErrorKind,
} from "@/lib/payments";
import { UI_PERMISSION_KEYS, createFixtureCapabilityView } from "@/lib/capabilities";
import {
  filterBusinessNavConfig,
  getBusinessNavConfig,
  resolveMobileNavActiveTab,
} from "@/design-system/mobile-nav-config";
import en from "../locales/en.json";
import km from "../locales/km.json";

const ROOT = process.cwd();
const readSource = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

const LIST_ROUTE = "src/routes/app.payments.tsx";
const DETAIL_ROUTE = "src/routes/app.payments.$id.tsx";
const PAYMENTS_LIB = "src/lib/payments.ts";
const API_INDEX = "src/lib/api/index.ts";

// ── Fixtures shaped exactly like the server's own return types ────────────────

const ORG_A = "a0000000-0000-0000-0000-000000000001";
const ORDER_ID = "20000000-0000-0000-0000-000000000001";
const PAYMENT_ID = "30000000-0000-0000-0000-000000000001";

function serverSummary(overrides: Partial<ServerPaymentSummary> = {}): ServerPaymentSummary {
  return {
    id: PAYMENT_ID,
    organizationId: ORG_A,
    orderId: ORDER_ID,
    method: "khqr",
    amount: { amount: 10000, currency: "USD" },
    status: "paid",
    verificationState: "staff_confirmed",
    reference: null,
    note: null,
    recordedBy: "10000000-0000-0000-0000-000000000001",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

function serverDetail(overrides: Partial<ServerPaymentDetail> = {}): ServerPaymentDetail {
  return {
    ...serverSummary(),
    events: [],
    evidence: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Drift locks — the client mirrors must equal the server rules, exhaustively
// ═══════════════════════════════════════════════════════════════════════════════

describe("the client-side mirrors cannot drift from the Payment state machine", () => {
  it("UI_VERIFICATION_TRANSITIONS is identical to the server's table, state for state", () => {
    expect(Object.keys(UI_VERIFICATION_TRANSITIONS).sort()).toEqual(
      [...PAYMENT_VERIFICATION_STATES].sort(),
    );
    for (const from of PAYMENT_VERIFICATION_STATES) {
      expect([...UI_VERIFICATION_TRANSITIONS[from]].sort()).toEqual(
        [...VERIFICATION_TRANSITIONS[from]].sort(),
      );
    }
  });

  it("UI_VERIFICATION_TRANSITION_PERMISSIONS is identical to the server's map", () => {
    for (const state of PAYMENT_VERIFICATION_STATES) {
      expect(UI_VERIFICATION_TRANSITION_PERMISSIONS[state]).toBe(
        VERIFICATION_TRANSITION_PERMISSIONS[state],
      );
    }
  });

  it("paymentNeedsReview agrees with the server's reconciliation rule on every combination", () => {
    let checked = 0;
    for (const status of PAYMENT_STATUSES) {
      for (const verificationState of PAYMENT_VERIFICATION_STATES) {
        const row: PaymentReconciliationRow = {
          organization_id: ORG_A,
          method: "cash",
          currency: "USD",
          status,
          verification_state: verificationState,
          payment_count: 1,
          amount_minor: 1000,
        } as unknown as PaymentReconciliationRow;

        expect(paymentNeedsReview({ status, verificationState })).toBe(paymentRowNeedsReview(row));
        checked += 1;
      }
    }
    // Guards the loop itself: 5 statuses x 6 verification states.
    expect(checked).toBe(PAYMENT_STATUSES.length * PAYMENT_VERIFICATION_STATES.length);
  });

  it("a reversed or refunded payment is never marked as needing review", () => {
    for (const verificationState of PAYMENT_VERIFICATION_STATES) {
      expect(paymentNeedsReview({ status: "reversed", verificationState })).toBe(false);
      expect(paymentNeedsReview({ status: "refunded", verificationState })).toBe(false);
    }
  });

  it("a pending, unchecked payment does need review — the Home attention rule", () => {
    expect(paymentNeedsReview({ status: "pending", verificationState: "unverified" })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Action gating mirrors the RPC guards
// ═══════════════════════════════════════════════════════════════════════════════

describe("which actions the screen may offer", () => {
  it("offers no verification move at all once the payment is frozen", () => {
    for (const verificationState of PAYMENT_VERIFICATION_STATES) {
      expect(availableVerificationTargets({ status: "reversed", verificationState })).toEqual([]);
      expect(availableVerificationTargets({ status: "refunded", verificationState })).toEqual([]);
    }
    expect(isTerminalUiPaymentStatus("reversed")).toBe(true);
    expect(isTerminalUiPaymentStatus("refunded")).toBe(true);
    expect(isTerminalUiPaymentStatus("paid")).toBe(false);
  });

  it("offers exactly the server's allowed targets for a live payment", () => {
    for (const verificationState of PAYMENT_VERIFICATION_STATES) {
      expect(
        [...availableVerificationTargets({ status: "pending", verificationState })].sort(),
      ).toEqual([...VERIFICATION_TRANSITIONS[verificationState]].sort());
    }
  });

  it("never offers duplicate_suspected as something a human can move a payment to", () => {
    // Only record_payment_v1 sets it, on a reference collision — nothing in the
    // transition table leads to it, so no button may.
    for (const from of PAYMENT_VERIFICATION_STATES) {
      expect(UI_VERIFICATION_TRANSITIONS[from]).not.toContain("duplicate_suspected");
    }
  });

  it("offers refund only where refund_payment_v1 could still succeed", () => {
    const refundable = PAYMENT_STATUSES.filter((status) => canRefundUiPayment({ status }));
    // 'refunded' is excluded on purpose: its cumulative refund already equals
    // the principal, so every further refund exceeds it and is rejected.
    expect(refundable).toEqual(["paid"]);
  });

  it("offers reversal only from pending or paid, matching reverse_payment_v1", () => {
    const reversible = PAYMENT_STATUSES.filter((status) => canReverseUiPayment({ status }));
    expect([...reversible].sort()).toEqual(["paid", "pending"]);
  });

  it("gates every verification target on the permission the server requires for it", () => {
    const staffOnly = createFixtureCapabilityView(["payments.read", "payments.manual_confirm"]);
    const verifier = createFixtureCapabilityView(["payments.read", "payments.verify"]);
    const readOnly = createFixtureCapabilityView(["payments.read"]);

    const offered = (view: ReturnType<typeof createFixtureCapabilityView>) =>
      availableVerificationTargets({ status: "pending", verificationState: "unverified" }).filter(
        (target) => view.can(UI_VERIFICATION_TRANSITION_PERMISSIONS[target]),
      );

    // From `unverified` the server allows staff_confirmed / bank_verified / mismatch.
    expect(offered(staffOnly)).toEqual(["staff_confirmed"]);
    expect([...offered(verifier)].sort()).toEqual(["bank_verified", "mismatch"]);
    expect(offered(readOnly)).toEqual([]);
  });

  it("offers nothing at all to a member whose capability snapshot has not resolved", () => {
    // Fail-closed by construction: can() is false in every state but "ready".
    const pending = createFixtureCapabilityView([]);
    const targets = availableVerificationTargets({
      status: "pending",
      verificationState: "unverified",
    }).filter((target) => pending.can(UI_VERIFICATION_TRANSITION_PERMISSIONS[target]));
    expect(targets).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Settlement, refunds and the three axes
// ═══════════════════════════════════════════════════════════════════════════════

describe("refund truth is displayed exactly as the backend models it", () => {
  it("a partial refund leaves the payment paid and is NOT shown as fully refunded", () => {
    // Paid $100, refunded $20 -> refund_payment_v1 leaves status 'paid'.
    const detail = mapPaymentDetailToUi(
      serverDetail({
        status: "paid",
        events: [
          {
            id: "e1",
            eventType: "created",
            amount: { amount: 10000, currency: "USD" },
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: null,
            metadata: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
          {
            id: "e2",
            eventType: "refund",
            amount: { amount: 2000, currency: "USD" },
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: "Damaged item",
            metadata: null,
            createdAt: "2026-09-06T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(detail.status).toBe("paid");
    expect(isFullyRefundedUiPayment(detail)).toBe(false);
    const refunds = refundEventsOf(detail);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount).toEqual({ amount: 2000, currency: "USD" });
  });

  it("a full refund leaves the payment refunded — never 'unpaid'", () => {
    const detail = mapPaymentDetailToUi(serverDetail({ status: "refunded" }));
    expect(detail.status).toBe("refunded");
    expect(isFullyRefundedUiPayment(detail)).toBe(true);
    expect(Object.keys(detail)).not.toContain("unpaid");
  });

  it("refundEventsOf selects refund events only and never totals them", () => {
    const detail = mapPaymentDetailToUi(
      serverDetail({
        events: [
          {
            id: "e1",
            eventType: "refund",
            amount: { amount: 1000, currency: "USD" },
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: null,
            metadata: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
          {
            id: "e2",
            eventType: "refund",
            amount: { amount: 500, currency: "USD" },
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: null,
            metadata: null,
            createdAt: "2026-09-06T00:00:00.000Z",
          },
          {
            id: "e3",
            eventType: "correction",
            amount: null,
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: null,
            metadata: null,
            createdAt: "2026-09-07T00:00:00.000Z",
          },
        ],
      }),
    );

    const refunds = refundEventsOf(detail);
    expect(refunds.map((event) => event.id)).toEqual(["e1", "e2"]);
    // The returned entries are the ledger's own rows — no synthesised total row.
    expect(refunds.every((event) => event.amount !== null)).toBe(true);
    expect(Object.keys(detail)).not.toContain("refundedTotal");
  });

  it("the order-level refund verdict is carried through from SQL, not recomputed", () => {
    const settlement: OrderSettlement = {
      orderId: ORDER_ID,
      currency: "USD",
      totalMinor: { amount: 10000, currency: "USD" },
      receivedMinor: { amount: 10000, currency: "USD" },
      refundedMinor: { amount: 2000, currency: "USD" },
      netMinor: { amount: 8000, currency: "USD" },
      paymentStatus: "paid",
      refundStatus: "partial",
      overpaid: false,
      overpaidAmount: null,
    };

    const ui = mapOrderSettlementToUi(settlement);
    // A refund never "unpays" the order.
    expect(ui.paymentStatus).toBe("paid");
    expect(ui.refundStatus).toBe("partial");
    expect(ui.refunded).toEqual({ amount: 2000, currency: "USD" });
    expect(ui.net).toEqual({ amount: 8000, currency: "USD" });
  });

  it("an overpayment is carried through as the server's own fact, with its amount", () => {
    const ui = mapOrderSettlementToUi({
      orderId: ORDER_ID,
      currency: "KHR",
      totalMinor: { amount: 40000, currency: "KHR" },
      receivedMinor: { amount: 45000, currency: "KHR" },
      refundedMinor: { amount: 0, currency: "KHR" },
      netMinor: { amount: 45000, currency: "KHR" },
      paymentStatus: "paid",
      refundStatus: "none",
      overpaid: true,
      overpaidAmount: { amount: 5000, currency: "KHR" },
    });
    expect(ui.overpaid).toBe(true);
    expect(ui.overpaidAmount).toEqual({ amount: 5000, currency: "KHR" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Money: currency is explicit, integer minor units, never blended
// ═══════════════════════════════════════════════════════════════════════════════

describe("multi-currency stays multi-currency", () => {
  it("carries each payment's own currency and integer minor amount through unchanged", () => {
    const usd = mapPaymentSummaryToUi(serverSummary({ amount: { amount: 1999, currency: "USD" } }));
    const khr = mapPaymentSummaryToUi(
      serverSummary({ amount: { amount: 41000, currency: "KHR" } }),
    );

    expect(usd.amount).toEqual({ amount: 1999, currency: "USD" });
    expect(khr.amount).toEqual({ amount: 41000, currency: "KHR" });
    expect(Number.isInteger(usd.amount.amount)).toBe(true);
    expect(Number.isInteger(khr.amount.amount)).toBe(true);
  });

  it("keeps reconciliation as one entry per currency and never merges them", () => {
    const bucket = (count: number, amount: number, currency: "USD" | "KHR") => ({
      count,
      amount: { amount, currency },
    });
    const rows = mapPaymentReconciliationToUi([
      {
        currency: "USD",
        expectedRevenue: bucket(3, 30000, "USD"),
        paid: bucket(2, 20000, "USD"),
        pending: bucket(1, 10000, "USD"),
        failed: bucket(0, 0, "USD"),
        reversed: bucket(0, 0, "USD"),
        refunded: bucket(0, 0, "USD"),
        bankVerified: bucket(0, 0, "USD"),
        managerVerified: bucket(0, 0, "USD"),
        staffConfirmedOnly: bucket(2, 20000, "USD"),
        codUnsettled: bucket(0, 0, "USD"),
        needsReview: bucket(1, 10000, "USD"),
        duplicateSuspected: bucket(0, 0, "USD"),
        mismatch: bucket(0, 0, "USD"),
      },
      {
        currency: "KHR",
        expectedRevenue: bucket(1, 41000, "KHR"),
        paid: bucket(0, 0, "KHR"),
        pending: bucket(1, 41000, "KHR"),
        failed: bucket(0, 0, "KHR"),
        reversed: bucket(0, 0, "KHR"),
        refunded: bucket(0, 0, "KHR"),
        bankVerified: bucket(0, 0, "KHR"),
        managerVerified: bucket(0, 0, "KHR"),
        staffConfirmedOnly: bucket(0, 0, "KHR"),
        codUnsettled: bucket(1, 41000, "KHR"),
        needsReview: bucket(0, 0, "KHR"),
        duplicateSuspected: bucket(0, 0, "KHR"),
        mismatch: bucket(0, 0, "KHR"),
      },
    ]);

    expect(rows.map((row) => row.currency)).toEqual(["USD", "KHR"]);
    expect(rows[0]!.needsReview.amount).toEqual({ amount: 10000, currency: "USD" });
    expect(rows[1]!.codUnsettled.amount).toEqual({ amount: 41000, currency: "KHR" });
    // No blended entry, no third row, no shared total.
    expect(rows).toHaveLength(2);
    expect(reconciliationIsQuiet(rows[0]!)).toBe(false);
    expect(reconciliationIsQuiet(rows[1]!)).toBe(false);
  });

  it("treats a currency with nothing outstanding as quiet, so no empty band is drawn", () => {
    const zero = (currency: "USD" | "KHR") => ({ count: 0, amount: { amount: 0, currency } });
    expect(
      reconciliationIsQuiet({
        currency: "USD",
        needsReview: zero("USD"),
        pending: zero("USD"),
        mismatch: zero("USD"),
        duplicateSuspected: zero("USD"),
        codUnsettled: zero("USD"),
      }),
    ).toBe(true);
  });

  it("does no floating-point money arithmetic anywhere in the payments UI layer", () => {
    for (const file of [PAYMENTS_LIB, LIST_ROUTE, DETAIL_ROUTE]) {
      const source = readSource(file);
      expect(source).not.toMatch(/parseFloat/);
      expect(source).not.toMatch(/\btoFixed\(/);
      expect(source).not.toMatch(/\*\s*100\b/);
      // No exchange-rate use: USD and KHR are never converted into each other.
      expect(source).not.toMatch(/usdToKhr|khrToUsd|KHR_PER_USD/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. COD and evidence never imply payment
// ═══════════════════════════════════════════════════════════════════════════════

describe("COD and evidence never imply that money arrived", () => {
  it("a COD payment record carries no paid-ness of its own", () => {
    const cod = mapPaymentSummaryToUi(serverSummary({ method: "cod", status: "pending" }));
    expect(cod.method).toBe("cod");
    expect(cod.status).toBe("pending");
    expect(paymentNeedsReview({ ...cod })).toBe(false); // pending + staff_confirmed
    const codUnchecked = mapPaymentSummaryToUi(
      serverSummary({ method: "cod", status: "pending", verificationState: "unverified" }),
    );
    expect(codUnchecked.status).toBe("pending");
    expect(paymentNeedsReview(codUnchecked)).toBe(true);
    // No mapper anywhere turns a method into a settlement claim.
    expect(Object.keys(cod)).not.toContain("paid");
  });

  it("attached evidence does not change the payment's status or verification state", () => {
    const detail = mapPaymentDetailToUi(
      serverDetail({
        status: "pending",
        verificationState: "unverified",
        evidence: [
          {
            id: "ev1",
            evidenceType: "screenshot",
            storageRef: null,
            extractedAmount: { amount: 999999, currency: "USD" },
            extractedReference: null,
            extractedAt: null,
            uploadedBy: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
        ],
        events: [
          {
            id: "e1",
            eventType: "evidence_attached",
            amount: null,
            fromVerification: null,
            toVerification: null,
            actorUserId: null,
            reason: null,
            metadata: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(detail.status).toBe("pending");
    expect(detail.verificationState).toBe("unverified");
    expect(detail.evidence).toHaveLength(1);
  });

  it("drops the evidence amount rather than render its hard-coded USD currency", () => {
    // src/server/payments/service.ts#mapEvidence stamps every extracted amount
    // "USD" regardless of the payment's currency. Showing that on a KHR payment
    // would name the wrong currency, so the UI shape carries no amount at all.
    const detail = mapPaymentDetailToUi(
      serverDetail({
        amount: { amount: 41000, currency: "KHR" },
        evidence: [
          {
            id: "ev1",
            evidenceType: "qr_scan",
            storageRef: null,
            extractedAmount: { amount: 41000, currency: "USD" },
            extractedReference: null,
            extractedAt: null,
            uploadedBy: null,
            createdAt: "2026-09-05T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(Object.keys(detail.evidence[0]!)).not.toContain("extractedAmount");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Withheld fields are never reconstructed client-side
// ═══════════════════════════════════════════════════════════════════════════════

describe("withheld fields stay withheld", () => {
  it("passes a withheld reference and note straight through as null", () => {
    const ui = mapPaymentSummaryToUi(serverSummary({ reference: null, note: null }));
    expect(ui.reference).toBeNull();
    expect(ui.note).toBeNull();
  });

  it("never substitutes a placeholder or derives a reference from anything else", () => {
    const source = readSource(PAYMENTS_LIB);
    expect(source).not.toMatch(/reference\s*[?][?]\s*["'`]/);
    expect(source).not.toMatch(/note\s*[?][?]\s*["'`]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Filters are real server filters
// ═══════════════════════════════════════════════════════════════════════════════

describe("list filters", () => {
  it("maps every chip to at most one server filter dimension", () => {
    for (const filter of PAYMENT_FILTERS) {
      const dimensions = [filter.status, filter.verificationState].filter(Boolean);
      expect(dimensions.length).toBeLessThanOrEqual(1);
    }
  });

  it("covers every payment status and every verification state the server defines", () => {
    const statuses = PAYMENT_FILTERS.map((filter) => filter.status).filter(Boolean);
    const verifications = PAYMENT_FILTERS.map((filter) => filter.verificationState).filter(Boolean);

    for (const status of PAYMENT_STATUSES) {
      expect(statuses).toContain(status);
    }
    // duplicate_suspected and mismatch are the review findings the merchant
    // most needs; every other verification state is offered too.
    for (const state of PAYMENT_VERIFICATION_STATES) {
      expect(verifications).toContain(state);
    }
  });

  it("keeps 'all' as an unfiltered chip and as the fallback for an unknown id", () => {
    const all = findPaymentFilter("all");
    expect(all.status).toBeUndefined();
    expect(all.verificationState).toBeUndefined();
    expect(findPaymentFilter("status:not-a-status" as never).id).toBe("all");
  });

  it("offers no single combined 'needs review' chip the server could not run", () => {
    // The rule is a union the list endpoint cannot express; a chip promising it
    // would either filter a capped page client-side or invent a status.
    expect(PAYMENT_FILTERS.map((filter) => filter.id)).not.toContain("needs-review");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Error classification
// ═══════════════════════════════════════════════════════════════════════════════

describe("payment errors are classified, never shown raw", () => {
  function withStatus(code: number, message = "boom"): Error {
    return Object.assign(new Error(message), { statusCode: code });
  }

  it("maps every status code the Payment service throws", () => {
    expect(classifyPaymentError(withStatus(401))).toBe("unauthorized");
    expect(classifyPaymentError(withStatus(403))).toBe("forbidden");
    expect(classifyPaymentError(withStatus(404))).toBe("not_found");
    expect(classifyPaymentError(withStatus(409))).toBe("conflict");
    expect(classifyPaymentError(withStatus(400))).toBe("invalid");
    expect(classifyPaymentError(new Error("something odd"))).toBe("server_error");
    expect(classifyPaymentError("not an error")).toBe("server_error");
  });

  it("falls back to the service's own message text when statusCode is lost", () => {
    expect(classifyPaymentError(new Error("Missing permission: payments.refund"))).toBe(
      "forbidden",
    );
    expect(classifyPaymentError(new Error("Payment not found"))).toBe("not_found");
    expect(
      classifyPaymentError(new Error("Payment is refunded and can no longer be modified")),
    ).toBe("conflict");
    expect(classifyPaymentError(new Error("A refund reason is required"))).toBe("invalid");
  });

  it("has a translated message for every classification, in both locales", () => {
    const kinds = [
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "invalid",
      "server_error",
    ] as const;
    for (const kind of kinds) {
      const key = paymentErrorKey(kind).replace("payments.errors.", "");
      expect((en.payments.errors as Record<string, string>)[key]).toBeString();
      expect((km.payments.errors as Record<string, string>)[key]).toBeString();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Identity
// ═══════════════════════════════════════════════════════════════════════════════

describe("payment ids", () => {
  it("accepts a UUID and rejects a mock or hand-typed id", () => {
    expect(isPaymentId(PAYMENT_ID)).toBe(true);
    expect(isPaymentId("pay-1")).toBe(false);
    expect(isPaymentId("")).toBe(false);
    expect(isPaymentId("30000000-0000-0000-0000-00000000000")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Every vocabulary the UI renders has a Khmer and an English label
// ═══════════════════════════════════════════════════════════════════════════════

describe("Khmer-first labels exist for every payment vocabulary", () => {
  const trees: Array<[string, typeof en]> = [
    ["en", en],
    ["km", km as unknown as typeof en],
  ];

  it("labels every payment status in both locales", () => {
    for (const [name, tree] of trees) {
      for (const status of PAYMENT_STATUSES) {
        expect(
          (tree.payments.status as Record<string, string>)[status],
          `${name}: payments.status.${status}`,
        ).toBeString();
      }
    }
  });

  it("labels every verification state in both locales", () => {
    for (const [name, tree] of trees) {
      for (const state of PAYMENT_VERIFICATION_STATES) {
        expect(
          (tree.payments.verification as Record<string, string>)[state],
          `${name}: payments.verification.${state}`,
        ).toBeString();
      }
    }
  });

  it("labels every payment method in both locales", () => {
    for (const [name, tree] of trees) {
      for (const method of PAYMENT_METHODS) {
        expect(
          (tree.payments.method as Record<string, string>)[method],
          `${name}: payments.method.${method}`,
        ).toBeString();
      }
    }
  });

  it("labels every verification target the screen can offer, in both locales", () => {
    const targets = new Set<PaymentVerificationState>();
    for (const from of PAYMENT_VERIFICATION_STATES) {
      for (const to of VERIFICATION_TRANSITIONS[from]) targets.add(to);
    }
    expect(targets.size).toBeGreaterThan(0);

    for (const [name, tree] of trees) {
      for (const target of targets) {
        const entry = (
          tree.payments.actions.verify as unknown as Record<
            string,
            { label: string; body: string; submit: string; done: string }
          >
        )[target];
        expect(entry, `${name}: payments.actions.verify.${target}`).toBeDefined();
        expect(entry!.label).toBeString();
        expect(entry!.submit).toBeString();
        expect(entry!.done).toBeString();
      }
    }
  });

  it("labels the order settlement's refund verdicts in both locales", () => {
    for (const [name, tree] of trees) {
      for (const verdict of ["none", "partial", "full"]) {
        expect(
          (tree.payments.settlement.refundStatusValue as Record<string, string>)[verdict],
          `${name}: payments.settlement.refundStatusValue.${verdict}`,
        ).toBeString();
      }
    }
  });

  it("has a status.reversed label so the shared StatusChip can render it", () => {
    expect((en.status as Record<string, string>)["reversed"]).toBeString();
    expect((km.status as unknown as Record<string, string>)["reversed"]).toBeString();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Capability surface and navigation
// ═══════════════════════════════════════════════════════════════════════════════

describe("capability wiring", () => {
  it("declares every payments key the screens consult", () => {
    for (const key of [
      "payments.read",
      "payments.manual_confirm",
      "payments.verify",
      "payments.refund",
      "payments.reverse",
      "payments.reconcile",
    ] as const) {
      expect(UI_PERMISSION_KEYS).toContain(key);
    }
  });

  it("does not ship payments.view_provider_reference to the browser", () => {
    // The server withholds the value itself, so the UI has nothing to decide
    // and the snapshot stays minimal.
    expect(UI_PERMISSION_KEYS as readonly string[]).not.toContain(
      "payments.view_provider_reference",
    );
  });

  it("gates both screens on payments.read, the key listPayments requires", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(readSource(file)).toContain('capabilities.can("payments.read")');
    }
    expect(readSource("src/server/payments/service.ts")).toContain('ctx.require("payments.read")');
  });

  it("draws reconciliation amounts only from a confirmed snapshot", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(readSource(file)).toContain('canSensitive("payments.reconcile")');
    }
  });
});

describe("navigation", () => {
  it("points the Payments hub at the real route and gates it on payments.read", () => {
    const config = getBusinessNavConfig("online-seller");
    const payments = config.salesGroups
      .flatMap((group) => group.actions)
      .find((action) => action.id === "payments");

    expect(payments).toBeDefined();
    expect(payments!.availability).toBe("live");
    expect(payments!.to).toBe("/app/payments");
    expect(payments!.requiresAll).toEqual(["payments.read"]);
  });

  it("hides the Payments hub from a member without payments.read", () => {
    const withoutPayments = createFixtureCapabilityView(["orders.read"]);
    const filtered = filterBusinessNavConfig(
      getBusinessNavConfig("online-seller"),
      withoutPayments,
    );
    const ids = filtered.salesGroups.flatMap((group) => group.actions).map((action) => action.id);
    expect(ids).not.toContain("payments");
  });

  it("shows it to a member who has payments.read", () => {
    const withPayments = createFixtureCapabilityView(["payments.read"]);
    const filtered = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), withPayments);
    const ids = filtered.salesGroups.flatMap((group) => group.actions).map((action) => action.id);
    expect(ids).toContain("payments");
  });

  it("keeps the Sales tab reachable for a payments-only member", () => {
    const withPayments = createFixtureCapabilityView(["payments.read"]);
    const filtered = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), withPayments);
    expect(filtered.tabs.map((tab) => tab.id)).toContain("sales");
  });

  it("marks the Sales tab active on both payment routes", () => {
    expect(resolveMobileNavActiveTab("/app/payments", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab(`/app/payments/${PAYMENT_ID}`, "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/payments", "mart")).toBe("sales");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Structural guards the behaviour above cannot express
// ═══════════════════════════════════════════════════════════════════════════════

/** Comments explain intent; only real code can violate an invariant. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The Payment section of the shared client boundary, code only.
 *
 * Anchored on the first Payment declaration rather than on the section's
 * comment header: slicing mid-comment would leave an unterminated block that
 * stripComments cannot remove, and the prose would then be scanned as if it
 * were code.
 */
function paymentsApiBlock(): string {
  const source = readSource(API_INDEX);
  expect(source).toContain("Payment UI Production Integration");
  const start = source.indexOf("export interface ListRealPaymentsOptions");
  expect(start).toBeGreaterThan(-1);
  const block = stripComments(source.slice(start));
  expect(block).not.toContain("/*");
  return block;
}

describe("production boundary", () => {
  it("reaches the Payment domain only through the server functions, with no mock fallback", () => {
    const block = paymentsApiBlock();

    // Every payment call goes through a dynamic import of the API module.
    for (const fn of [
      "listPaymentsFn",
      "getPaymentByIdFn",
      "verifyPaymentFn",
      "refundPaymentFn",
      "reversePaymentFn",
      "getOrderSettlementFn",
      "getPaymentReconciliationFn",
    ]) {
      expect(block).toContain(fn);
    }
    // No demo-mode escape hatch and no mock import in the payments block.
    expect(block).not.toMatch(/isDemoModeError/);
    expect(block).not.toMatch(/@\/lib\/mock/);
  });

  it("never puts an organizationId or a userId into a payment request payload", () => {
    // The server derives both from the validated session and the caller's own
    // DB membership, so neither may appear anywhere in what the browser builds
    // and sends to the Payment domain.
    const block = paymentsApiBlock();
    expect(block).not.toMatch(/organizationId/);
    expect(block).not.toMatch(/userId/);
  });

  it("never proposes a payment status — only a verification target", () => {
    // resultingPaymentStatus is the server's derivation; asking for a status
    // directly would be the "mark as paid" bypass the domain forbids.
    expect(paymentsApiBlock()).not.toMatch(/status:\s*["']paid["']/);
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(stripComments(readSource(file))).not.toMatch(/status:\s*["']paid["']/);
    }
  });

  it("adds no migration in this phase", () => {
    const migrations = fs.readdirSync(path.resolve(ROOT, "supabase/migrations"));
    const beyond040 = migrations.filter((file) => {
      const prefix = Number.parseInt(file.slice(0, 3), 10);
      return Number.isFinite(prefix) && prefix > 42;
    });
    expect(beyond040).toEqual([]);
  });

  it("links to the order through the router, never by mutating order state", () => {
    const detail = readSource(DETAIL_ROUTE);
    expect(detail).toContain('to: "/app/orders/$id"');
    // No Order-domain mutation is reachable from the payment screens.
    for (const forbidden of [
      "transitionOrderPaymentFn",
      "transitionOrderLifecycleFn",
      "transitionOrderFulfillmentFn",
    ]) {
      expect(detail).not.toContain(forbidden);
      expect(readSource(LIST_ROUTE)).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Refund intent identity — P1 of the post-merge review of PR #55
//
// The wire-level proof (a committed refund, a lost response, a retry, one
// ledger row) lives in the runtime file, which can stand a fake ledger up.
// This section pins the RULE that decides the key, and pins the screens to it.
// ═══════════════════════════════════════════════════════════════════════════════

describe("N. one logical refund, one idempotency key", () => {
  const request = { paymentId: PAYMENT_ID, amountMinor: 2_000, reason: "Damaged item" };

  it("a new decision gets a fresh key", () => {
    const first = resolveRefundIntent(null, request);
    const second = resolveRefundIntent(null, request);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("retrying the same decision keeps the very same intent, key included", () => {
    const intent = resolveRefundIntent(null, request);
    const retry = resolveRefundIntent(intent, request);
    expect(retry).toBe(intent);
    expect(retry.idempotencyKey).toBe(intent.idempotencyKey);
  });

  it("a different amount or reason is a different refund and mints a new key", () => {
    const intent = resolveRefundIntent(null, request);
    expect(resolveRefundIntent(intent, { ...request, amountMinor: 3_000 }).idempotencyKey).not.toBe(
      intent.idempotencyKey,
    );
    expect(
      resolveRefundIntent(intent, { ...request, reason: "Wrong size" }).idempotencyKey,
    ).not.toBe(intent.idempotencyKey);
    expect(
      resolveRefundIntent(intent, { ...request, paymentId: ORDER_ID }).idempotencyKey,
    ).not.toBe(intent.idempotencyKey);
  });

  it("whitespace around the reason is not a different refund", () => {
    const intent = resolveRefundIntent(null, request);
    const retry = resolveRefundIntent(intent, { ...request, reason: "  Damaged item  " });
    expect(retry.idempotencyKey).toBe(intent.idempotencyKey);
    // The intent carries the trimmed form — what the server compares a replay against.
    expect(intent.reason).toBe("Damaged item");
  });

  it("the key is opaque: never the payment id, the amount or the reason", () => {
    const keys = Array.from({ length: 50 }, () => newRefundIdempotencyKey());
    for (const key of keys) {
      expect(key).not.toContain(PAYMENT_ID);
      expect(key).not.toContain("2000");
      expect(key).not.toContain("Damaged");
      expect(key.trim().length).toBeGreaterThan(8);
      // Fits the server validator: z.string().trim().min(1).max(200).
      expect(key.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("two refunds identical in every field still get different keys", () => {
    // The same terms twice is two real refunds totalling twice the amount, so
    // a key derived from the terms would silently collapse them into one.
    const a = resolveRefundIntent(null, request);
    const b = resolveRefundIntent(null, request);
    expect(a.amountMinor).toBe(b.amountMinor);
    expect(a.reason).toBe(b.reason);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("the refund wrapper requires a key and the server function accepts one", () => {
    const api = readSource(API_INDEX);
    // Required parameter, not an optional one a caller can forget.
    expect(api).toContain("idempotencyKey: string,\n): Promise<UiPaymentDetail>");
    expect(api).toContain("data: { paymentId, amountMinor, reason, idempotencyKey }");
    // And the boundary it is sent to validates it.
    const serverFn = readSource("src/api/payments.ts");
    expect(serverFn).toContain("idempotencyKey: z.string().trim().min(1).max(200).nullish()");
  });

  it("the detail screen resolves an intent and never mints a key per attempt", () => {
    const detail = readSource(DETAIL_ROUTE);
    expect(detail).toContain("resolveRefundIntent(refundIntentRef.current");
    expect(detail).toContain("refundRealPayment(id, amountMinor, reason, intent.idempotencyKey)");
    // Minting inside the wrapper or the mutation body would hand every retry
    // a new key and defeat the whole mechanism.
    expect(detail).not.toContain("newRefundIdempotencyKey(");
    expect(readSource(API_INDEX)).not.toContain("newRefundIdempotencyKey");
  });

  it("a confirmed result is the ONLY thing that drops the intent", () => {
    const detail = readSource(DETAIL_ROUTE);

    // Exactly one clear site in the whole screen.
    expect(detail.split("refundIntentRef.current = null").length - 1).toBe(1);

    // And it is inside the refund mutation's success handler.
    const mutationStart = detail.indexOf("const refundMutation = useMutation({");
    const onSuccess = detail.indexOf("onSuccess: () => {", mutationStart);
    const onError = detail.indexOf("onError: handleActionError", mutationStart);
    const clear = detail.indexOf("refundIntentRef.current = null", mutationStart);
    expect(mutationStart).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(onSuccess);
    expect(clear).toBeLessThan(onError);
  });

  it("REGRESSION: opening the refund sheet does not reset the intent", () => {
    // This is the P1 defect of the second review. Clearing on open makes
    // commit -> lost response -> close -> reopen -> retry mint a new key and
    // refund the customer twice.
    const detail = readSource(DETAIL_ROUTE).replace(/\/\*[\s\S]*?\*\//g, "");
    const opensSheet = detail.indexOf("setRefundOpen(true)");
    expect(opensSheet).toBeGreaterThan(-1);
    // Nothing resets the intent anywhere near the open handler.
    const window = detail.slice(Math.max(0, opensSheet - 400), opensSheet + 200);
    expect(window).not.toContain("refundIntentRef.current = null");

    // Nor does closing it: onOpenChange is the plain setter, with no reset.
    expect(detail).toContain("<PaymentRefundSheet");
    expect(detail).toContain("onOpenChange={setRefundOpen}");
  });

  it("the intent is screen-local: a ref, never persisted or shared", () => {
    const detail = readSource(DETAIL_ROUTE);
    expect(detail).toContain("useRef<RefundIntent | null>(null)");
    for (const sink of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.cookie",
      "globalThis.",
      "window.__",
    ]) {
      expect(detail).not.toContain(sink);
    }
    // Not parked in the query cache either, where another surface could read it.
    expect(detail).not.toMatch(/setQueryData[\s\S]{0,80}[Ii]ntent/);

    /*
     * And module scope holds no intent STORE — no Map keyed by payment id, no
     * mutable module-level binding that would outlive the screen and be
     * reachable from another one. RefundIntent may appear there only as the
     * type import; the single value binding is the component's own ref.
     */
    const moduleHead = detail.slice(0, detail.indexOf("function PaymentDetailScreen"));
    const afterImports = moduleHead.slice(moduleHead.lastIndexOf('from "@/lib/payments";'));
    expect(afterImports).not.toContain("RefundIntent");
    expect(moduleHead).not.toMatch(/new (Weak)?Map/);
    expect(detail.match(/refundIntentRef/g)?.length).toBeGreaterThan(0);
    // The ref is created inside the component, once.
    expect(detail.split("useRef<RefundIntent | null>(null)").length - 1).toBe(1);
    expect(detail.indexOf("useRef<RefundIntent | null>(null)")).toBeGreaterThan(
      detail.indexOf("function PaymentDetailScreen"),
    );
  });

  it("an intent for another payment is never inherited", () => {
    const other = "40000000-0000-0000-0000-000000000009";
    const held = resolveRefundIntent(null, request);
    const moved = resolveRefundIntent(held, { ...request, paymentId: other });
    expect(moved.idempotencyKey).not.toBe(held.idempotencyKey);
    expect(moved.paymentId).toBe(other);
  });

  it("no payment screen invents a refund key from the payment's own fields", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE, PAYMENTS_LIB, API_INDEX]) {
      const source = readSource(file);
      expect(source).not.toMatch(/idempotencyKey\s*[:=]\s*`?\$?\{?\s*paymentId/);
      expect(source).not.toMatch(/idempotencyKey\s*[:=]\s*.*amountMinor/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Cached payment data after an explicit denial — P2 of the same review
//
// React Query keeps the last successful data when a refetch fails. For a blip
// that is correct. For a 403 it means a member who has just lost payments.read
// goes on reading real amounts, order ids and verification states under a
// denial panel. The gate below is the one thing standing between a cached row
// and the screen, and it must act on the render, not on the cache.
// ═══════════════════════════════════════════════════════════════════════════════

describe("O. an explicit denial withholds cached payment data immediately", () => {
  const cachedRows = [
    mapPaymentSummaryToUi(
      serverSummary({ id: PAYMENT_ID, amount: { amount: 12_500, currency: "USD" } }),
    ),
    mapPaymentSummaryToUi(
      serverSummary({ id: ORDER_ID, amount: { amount: 40_000, currency: "KHR" } }),
    ),
  ];

  const DENYING: PaymentErrorKind[] = ["forbidden", "unauthorized"];
  const NOT_DENYING: PaymentErrorKind[] = ["not_found", "conflict", "invalid", "server_error"];

  it("positive control: with no error the cached rows are exactly what renders", () => {
    expect(visiblePaymentRows(cachedRows, null)).toEqual(cachedRows);
    expect(visiblePaymentRecord(cachedRows[0], null)).toBe(cachedRows[0]!);
  });

  it("THE REPORTED DEFECT: a 403 on refresh renders no rows even though the cache still holds them", () => {
    // The cache is untouched — this is exactly the state React Query leaves
    // behind after a failed refetch — and nothing is rendered from it.
    expect(cachedRows).toHaveLength(2);
    expect(visiblePaymentRows(cachedRows, "forbidden")).toEqual([]);
    expect(visiblePaymentRecord(cachedRows[0], "forbidden")).toBeNull();
  });

  it("no amount, order id or verification state survives a denial", () => {
    const rendered = visiblePaymentRows(cachedRows, "forbidden");
    const serialized = JSON.stringify(rendered);
    for (const secret of [PAYMENT_ID, ORDER_ID, "12500", "40000", "staff_confirmed", "khqr"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(rendered).toEqual([]);
  });

  it("every definitive denial withholds, and nothing else does", () => {
    for (const kind of DENYING) {
      expect(paymentAccessDenied(kind)).toBe(true);
      expect(visiblePaymentRows(cachedRows, kind)).toEqual([]);
      expect(visiblePaymentRecord(cachedRows[0], kind)).toBeNull();
    }
    for (const kind of NOT_DENYING) {
      expect(paymentAccessDenied(kind)).toBe(false);
    }
    expect(paymentAccessDenied(null)).toBe(false);
    expect(paymentAccessDenied(undefined)).toBe(false);
  });

  it("an unknown network failure stays honest and keeps the rows the server really sent", () => {
    // classifyPaymentError puts a bare transport failure in server_error, and
    // a transient failure must not blank out valid rows.
    const transient = classifyPaymentError(new Error("network error: connection reset"));
    expect(transient).toBe("server_error");
    expect(visiblePaymentRows(cachedRows, transient)).toEqual(cachedRows);
    expect(visiblePaymentRecord(cachedRows[0], transient)).toBe(cachedRows[0]!);

    // Same for a 500 and for a conflict on some other action.
    for (const err of [
      Object.assign(new Error("boom"), { statusCode: 500 }),
      Object.assign(new Error("changed concurrently"), { statusCode: 409 }),
    ]) {
      expect(visiblePaymentRows(cachedRows, classifyPaymentError(err))).toEqual(cachedRows);
    }
  });

  it("a real 403 from the payment service classifies as a denial", () => {
    // The shape src/server/payments/service.ts actually throws.
    const err = Object.assign(new Error("Missing permission: payments.read"), { statusCode: 403 });
    expect(paymentAccessDenied(classifyPaymentError(err))).toBe(true);
    // And the fallback path, for a statusCode that did not survive the RPC boundary.
    expect(
      paymentAccessDenied(classifyPaymentError(new Error("Missing permission: payments.read"))),
    ).toBe(true);
  });

  it("withholding needs no invalidation and no refetch — it is a pure render decision", () => {
    const sources = [readSource(LIST_ROUTE), readSource(DETAIL_ROUTE)].join("\n");
    // Nothing removes or resets the query cache to achieve the denial: that
    // would only make the same query mount and fetch again.
    expect(sources).not.toContain("removeQueries");
    expect(sources).not.toContain("resetQueries");
    expect(sources).not.toContain("setQueryData");
    // And the gate itself touches nothing but its arguments.
    const lib = readSource(PAYMENTS_LIB);
    const gate = lib.slice(lib.indexOf("export function visiblePaymentRows"));
    expect(gate).not.toContain("queryClient");
    expect(gate).not.toContain("await");
  });

  it("the list renders rows and reconciliation only through the gate", () => {
    // Whitespace-normalised so a prettier reflow cannot pass or fail this.
    const list = readSource(LIST_ROUTE).replace(/\s+/g, " ");
    expect(list).toContain(
      "visiblePaymentRows( paymentsQuery.data?.pages.flatMap((page) => page.items), errorKind, )",
    );
    expect(list).toContain("visiblePaymentRows(reconciliationQuery.data, reconciliationDenial)");
    // And that denial is the LIST's as well as reconciliation's own.
    expect(list).toContain("governingPaymentDenial(errorKind, reconciliationErrorKind)");
    // Never straight off the cache.
    expect(list).not.toMatch(/= paymentsQuery\.data\?\.pages\.flatMap[^;]{0,60}\?\? \[\]/);
    expect(list).not.toContain("reconciliationQuery.data ?? []");
    // The error kind the gate consumes is recomputed every render, never held
    // in state that could lag behind the current answer.
    expect(list).toContain(
      "paymentsQuery.isError ? classifyPaymentError(paymentsQuery.error) : null",
    );
    expect(list).toContain("reconciliationQuery.isError");
  });

  it("the list offers no further pages once denied", () => {
    expect(readSource(LIST_ROUTE)).toContain("paymentsQuery.hasNextPage && !listDenied");
  });

  it("the detail surface applies the same rule to the payment and to its settlement", () => {
    const detail = readSource(DETAIL_ROUTE).replace(/\s+/g, " ");
    expect(detail).toContain("visiblePaymentRecord(paymentQuery.data, queryErrorKind)");
    expect(detail).toContain("visiblePaymentRecord( settlementQuery.data,");
    expect(detail).not.toContain("const payment = paymentQuery.data;");
    expect(detail).not.toContain("const settlement = settlementQuery.data;");
  });

  it("the detail screen's denial state is reached before anything is drawn from the payment", () => {
    const detail = readSource(DETAIL_ROUTE);
    const forbiddenBranch = detail.indexOf('queryErrorKind === "forbidden"');
    const firstRender = detail.indexOf("formatMoney(payment.amount)");
    expect(forbiddenBranch).toBeGreaterThan(-1);
    expect(firstRender).toBeGreaterThan(forbiddenBranch);
  });

  it("a denial never describes the data behind it", () => {
    const list = readSource(LIST_ROUTE);
    // The forbidden panel says only that access is refused — no count, no
    // amount, no filter summary is interpolated into it.
    expect(list).toContain('t("payments.list.forbidden.title")');
    expect(list).toContain('t("payments.list.forbidden.body")');
    expect(list).not.toMatch(/forbidden\.body",\s*\{/);
    // And a denial is not dressed up as an empty list.
    expect(list).toContain("paymentsQuery.isSuccess && items.length === 0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. One screen, several reads, one denial — P2 of the second review
//
// Gating each query on its OWN error leaves the hole Codex found: the payment
// list 403s and its rows vanish, while the reconciliation band — still holding
// a successful response fetched before the revocation — keeps real money on
// screen. A screen is only as readable as the read that carries it.
// ═══════════════════════════════════════════════════════════════════════════════

describe("P. a denial on the carrying read governs every surface on the screen", () => {
  const reconciliation: UiPaymentReconciliation[] = [
    {
      currency: "USD",
      needsReview: { count: 3, amount: { amount: 47_500, currency: "USD" } },
      pending: { count: 2, amount: { amount: 30_000, currency: "USD" } },
      mismatch: { count: 1, amount: { amount: 12_500, currency: "USD" } },
      duplicateSuspected: { count: 0, amount: { amount: 0, currency: "USD" } },
      codUnsettled: { count: 4, amount: { amount: 88_000, currency: "USD" } },
    },
  ];

  it("positive control: with both reads healthy the band renders in full", () => {
    const denial = governingPaymentDenial(null, null);
    expect(denial).toBeNull();
    expect(visiblePaymentRows(reconciliation, denial)).toEqual(reconciliation);
  });

  it("THE REPORTED DEFECT: reconciliation still cached, list 403 — no amount renders", () => {
    // Reconciliation's OWN query is perfectly healthy and holding data.
    const reconciliationOwnError = null;
    const listError = classifyPaymentError(
      Object.assign(new Error("Missing permission: payments.read"), { statusCode: 403 }),
    );

    const denial = governingPaymentDenial(listError, reconciliationOwnError);
    expect(denial).toBe("forbidden");

    const rendered = visiblePaymentRows(reconciliation, denial);
    expect(rendered).toEqual([]);

    // Not one figure from the retained aggregate survives.
    const serialized = JSON.stringify(rendered);
    for (const amount of ["47500", "30000", "12500", "88000", "USD"]) {
      expect(serialized).not.toContain(amount);
    }
    // The cache itself is untouched — this is a render decision, as designed.
    expect(reconciliation[0]!.needsReview.amount.amount).toBe(47_500);
  });

  it("a 401 on the list governs just the same", () => {
    const denial = governingPaymentDenial("unauthorized", null);
    expect(denial).toBe("unauthorized");
    expect(visiblePaymentRows(reconciliation, denial)).toEqual([]);
  });

  it("reconciliation's own denial still withholds it while the list stays readable", () => {
    const denial = governingPaymentDenial(null, "forbidden");
    expect(denial).toBe("forbidden");
    expect(visiblePaymentRows(reconciliation, denial)).toEqual([]);
  });

  it("a transient failure on either read withholds nothing", () => {
    for (const pair of [
      ["server_error", null],
      [null, "server_error"],
      ["conflict", "invalid"],
      ["not_found", "server_error"],
      ["server_error", "server_error"],
    ] as const) {
      const denial = governingPaymentDenial(pair[0], pair[1]);
      expect(denial).toBeNull();
      expect(visiblePaymentRows(reconciliation, denial)).toEqual(reconciliation);
    }
  });

  it("a real denial beats a transient failure whichever read carries it", () => {
    expect(governingPaymentDenial("server_error", "forbidden")).toBe("forbidden");
    expect(governingPaymentDenial("forbidden", "server_error")).toBe("forbidden");
    expect(governingPaymentDenial(undefined, null, "unauthorized")).toBe("unauthorized");
  });

  it("the list empties the WHOLE screen on a list denial, not just its rows", () => {
    const list = readSource(LIST_ROUTE);
    const denialReturn = list.indexOf("if (listDenied) {");
    expect(denialReturn).toBeGreaterThan(-1);

    // Everything that could disclose or act on payment data is rendered
    // after this return, so a denial reaches none of it.
    for (const surface of [
      "<AttentionBand",
      "<ChipRow",
      "items.map((payment)",
      "payments.list.loadMore",
      "payments.list.partialRefundNote",
      "payments.list.filterScope",
    ]) {
      const at = list.indexOf(surface);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(denialReturn);
    }

    // What the denial branch itself renders: the refusal, and nothing else.
    const branch = list.slice(denialReturn, list.indexOf("const showEmpty"));
    expect(branch).toContain("payments.list.forbidden.title");
    expect(branch).toContain("payments.list.forbidden.body");
    for (const leak of ["AttentionBand", "PaymentRow", "formatMoney", "loadMore", "Chip"]) {
      expect(branch).not.toContain(leak);
    }
  });

  it("the transient error panel keeps its retry and no longer speaks for denials", () => {
    const list = readSource(LIST_ROUTE).replace(/\s+/g, " ");
    // One inline error state, transient-only, with a retry.
    expect(list).toContain('title={t("payments.list.error.title")}');
    expect(list).toContain("onRetry={() => void paymentsQuery.refetch()}");
    // The old inline forbidden branch is gone — denials return above instead.
    expect(list).not.toContain('errorKind === "forbidden" ? t("payments.list.forbidden.title")');
  });

  it("the detail screen's settlement is governed by the payment read too", () => {
    const detail = readSource(DETAIL_ROUTE).replace(/\s+/g, " ");
    expect(detail).toContain("governingPaymentDenial( queryErrorKind,");
    expect(detail).toContain("visiblePaymentRecord( settlementQuery.data,");
  });

  it("every cached read on both payment screens passes a gate", () => {
    // A standing audit: any future `somethingQuery.data` that is not handed
    // to one of the two gates is a new disclosure route and fails here.
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      const source = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ");
      const reads = source.match(/\b\w*[Qq]uery\.data\b/g) ?? [];
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        const at = source.indexOf(read);
        const before = source.slice(Math.max(0, at - 140), at);
        expect(
          before.includes("visiblePaymentRows(") || before.includes("visiblePaymentRecord("),
        ).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Service-level and client-boundary behaviour (isolated subprocess)
// ═══════════════════════════════════════════════════════════════════════════════

it("Payments UI service reads, tenant isolation, permission denial and pagination", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolvePath("src/tests/payments-operations-ui.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65000);
