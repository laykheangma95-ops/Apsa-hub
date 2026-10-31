/**
 * Client mapping for the payment claim refusals of migration 068
 * (provisional): order_not_payable and payment_exceeds_outstanding are 409s
 * whose generic "reload and try again" advice would be wrong. Both locales
 * carry a message for each.
 */
import { describe, expect, it } from "bun:test";
import en from "@/locales/en.json";
import km from "@/locales/km.json";
import { paymentClaimRefusalOf, paymentErrorMessageKey } from "@/lib/payments";

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
    for (const key of ["order_not_payable", "exceeds_outstanding"] as const) {
      expect((en.payments.errors as Record<string, string>)[key]).toBeString();
      expect((km.payments.errors as Record<string, string>)[key]).toBeString();
    }
  });
});

describe("Order detail offers Record payment only where the server accepts it", () => {
  it("is gated on a confirmed order — not draft, cancelled or completed", async () => {
    const source = await Bun.file("src/routes/app.orders.$id.tsx").text();
    expect(source).toContain('const orderAcceptsPayment = order.lifecycleStatus === "confirmed";');
    expect(source).toContain("t(paymentErrorMessageKey(recordPaymentMutation.error))");
  });
});
