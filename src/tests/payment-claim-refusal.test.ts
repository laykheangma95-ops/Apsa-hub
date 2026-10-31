/**
 * Client mapping for the payment claim refusals of migration 068
 * (provisional): order_not_payable and payment_exceeds_outstanding are 409s
 * whose generic "reload and try again" advice would be wrong. Both locales
 * carry a message for each.
 */
import { describe, expect, it } from "bun:test";
import en from "@/locales/en.json";
import km from "@/locales/km.json";
import {
  excessAbove,
  excessReturnRefundIds,
  paymentClaimRefusalOf,
  paymentErrorMessageKey,
  recordedExcessOf,
  unreturnedExcessOf,
} from "@/lib/payments";

function serverError(message: string, statusCode: number, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

describe("payment claim refusals (068)", () => {
  it("is recognised by its public code", () => {
    expect(paymentClaimRefusalOf(serverError("x", 409, "order_not_payable"))).toBe(
      "order_not_payable",
    );
    expect(paymentClaimRefusalOf(serverError("x", 409, "payment_exceeds_outstanding"))).toBe(
      "exceeds_outstanding",
    );
    expect(paymentClaimRefusalOf(serverError("x", 409, "payment_claim_exceeds_total"))).toBe(
      "claim_exceeds_total",
    );
  });

  it("falls back to service.ts's own message on a 409 only", () => {
    expect(
      paymentClaimRefusalOf(
        serverError("This order cannot take a payment in its current state", 409),
      ),
    ).toBe("order_not_payable");
    expect(
      paymentClaimRefusalOf(
        serverError("The payment is more than the order's outstanding balance", 409),
      ),
    ).toBe("exceeds_outstanding");
    expect(
      paymentClaimRefusalOf(
        serverError("The payment is more than the order's outstanding balance", 500),
      ),
    ).toBeNull();
    expect(
      paymentClaimRefusalOf(serverError("Payment verification changed concurrently", 409)),
    ).toBeNull();
  });

  it("picks the specific message, else the classified one", () => {
    expect(paymentErrorMessageKey(serverError("x", 409, "order_not_payable"))).toBe(
      "payments.errors.order_not_payable",
    );
    expect(paymentErrorMessageKey(serverError("x", 409, "payment_exceeds_outstanding"))).toBe(
      "payments.errors.exceeds_outstanding",
    );
    expect(paymentErrorMessageKey(serverError("changed concurrently", 409))).toBe(
      "payments.errors.conflict",
    );
    expect(paymentErrorMessageKey(serverError("Missing permission", 403))).toBe(
      "payments.errors.forbidden",
    );
  });

  it("has an English and a Khmer message for each refusal", () => {
    for (const key of [
      "order_not_payable",
      "exceeds_outstanding",
      "claim_exceeds_total",
    ] as const) {
      expect((en.payments.errors as Record<string, string>)[key]).toBeString();
      expect((km.payments.errors as Record<string, string>)[key]).toBeString();
    }
  });
});

describe("Record payment copy asks for the amount kept, not the cash tendered", () => {
  it("never tells the cashier to record what was handed over", () => {
    const sheets = [en.order.recordPaymentSheet, km.order.recordPaymentSheet];
    expect(en.order.recordPaymentSheet.amountHint).toContain("amount kept for this order");
    expect(en.order.recordPaymentSheet.amountHint).toContain("change");
    expect(en.order.recordPaymentSheet.body).not.toMatch(/handed over/i);
    for (const sheet of sheets) expect(sheet.amountHint).toContain("{{amount}}");
  });
});

describe("Order detail offers Record payment only where the server accepts it", () => {
  it("is gated on a confirmed order — not draft, cancelled or completed", async () => {
    const source = await Bun.file("src/routes/app.orders.$id.tsx").text();
    expect(source).toContain('const orderAcceptsPayment = order.lifecycleStatus === "confirmed";');
    expect(source).toContain("t(paymentErrorMessageKey(recordPaymentMutation.error))");
  });
});

describe("recorded excess and the 'excess returned' label (068, DRAFT)", () => {
  type Detail = Parameters<typeof recordedExcessOf>[0];
  const event = (id: string, eventType: string, amount: number | null, metadata: unknown) => ({
    id,
    eventType,
    amount: amount === null ? null : { amount, currency: "USD" },
    fromVerification: null,
    toVerification: null,
    actorUserId: null,
    idempotencyKey: null,
    reason: null,
    metadata,
    createdAt: "2026-10-31T00:00:00Z",
  });
  const detail = (events: unknown[]) =>
    ({ amount: { amount: 10500, currency: "USD" }, events, evidence: [] }) as unknown as Detail;

  it("reads the excess only from the created event, and labels only refunds named by evidence", () => {
    const d = detail([
      event("c", "created", 10500, { excess_minor: 500, request_digest_version: 1 }),
      event("r1", "refund", 500, { status: "success" }), // ordinary, same amount: not labelled
      event("r2", "refund", 300, { status: "success" }),
      event("x2", "excess_returned", 300, {
        refund_event_id: "r2",
        excess_returned_total_minor: 300,
      }),
    ]);
    expect(recordedExcessOf(d)).toEqual({ amount: 500, currency: "USD" });
    expect([...excessReturnRefundIds(d)]).toEqual(["r2"]);
    expect(unreturnedExcessOf(d)).toEqual({ amount: 200, currency: "USD" });
  });

  it("an ordinary payment has no recorded excess and no labelled refund", () => {
    const d = detail([
      event("c", "created", 10000, { request_digest_version: 1 }),
      event("r", "refund", 500, {}),
    ]);
    expect(recordedExcessOf(d)).toBeNull();
    expect(unreturnedExcessOf(d)).toBeNull();
    expect(excessReturnRefundIds(d).size).toBe(0);
  });

  it("excessAbove is display-only integer arithmetic, null when not above", () => {
    expect(excessAbove(10500, { amount: 10000, currency: "USD" })).toEqual({
      amount: 500,
      currency: "USD",
    });
    expect(excessAbove(10000, { amount: 10000, currency: "USD" })).toBeNull();
  });

  it("maps every new refusal to its own message in both locales", () => {
    for (const [code, key] of [
      ["payment_outstanding_changed", "outstanding_changed"],
      ["payment_no_excess", "no_excess"],
      ["payment_no_recorded_excess", "no_recorded_excess"],
      ["payment_exceeds_returnable_excess", "exceeds_returnable_excess"],
    ] as const) {
      expect(paymentErrorMessageKey(serverError("x", 409, code))).toBe(`payments.errors.${key}`);
      expect((en.payments.errors as Record<string, string>)[key]).toBeString();
      expect((km.payments.errors as Record<string, string>)[key]).toBeString();
    }
  });
});
