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
  excessRefundNoteKeyOf,
  excessReturnRefundIds,
  excessReturnStateOf,
  paymentClaimRefusalOf,
  paymentErrorMessageKey,
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

  it("recognises the refusal by its message alone — all that survives the real wire", () => {
    const wire = (message: string) => new Error(message); // no statusCode, no code
    expect(
      paymentClaimRefusalOf(
        wire("Nothing is outstanding on this order — this transfer cannot be recorded against it"),
      ),
    ).toBe("nothing_outstanding");
    expect(
      paymentClaimRefusalOf(wire("This transfer reference is already recorded on another payment")),
    ).toBe("duplicate_transfer_reference");
    expect(
      paymentClaimRefusalOf(wire("The payment is more than the order's outstanding balance")),
    ).toBe("exceeds_outstanding");
    expect(paymentClaimRefusalOf(wire("Failed to fetch"))).toBeNull();
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
  type Detail = Parameters<typeof excessReturnStateOf>[0];
  const usd = (amount: number) => ({ amount, currency: "USD" as const });
  const event = (id: string, eventType: string, amount: number | null, metadata: unknown) => ({
    id,
    eventType,
    amount: amount === null ? null : usd(amount),
    fromVerification: null,
    toVerification: null,
    actorUserId: null,
    idempotencyKey: null,
    reason: null,
    metadata,
    createdAt: "2026-10-31T00:00:00Z",
  });
  const detail = (
    events: unknown[],
    status = "paid",
    excess: {
      recorded: number;
      returned: number;
      returnable: number;
      saleFullyPaid?: boolean;
    } | null = null,
  ) =>
    ({
      amount: usd(10500),
      status,
      events,
      evidence: [],
      excess: excess
        ? {
            recorded: usd(excess.recorded),
            returned: usd(excess.returned),
            returnable: usd(excess.returnable),
            saleFullyPaid: excess.saleFullyPaid ?? true,
          }
        : null,
    }) as unknown as Detail;

  it("labels only refunds named by excess_returned evidence", () => {
    const d = detail(
      [
        event("c", "created", 10500, { excess_minor: 500, request_digest_version: 1 }),
        event("r1", "refund", 500, { status: "success" }), // ordinary, same amount: not labelled
        event("r2", "refund", 300, { status: "success" }),
        event("x2", "excess_returned", 300, {
          refund_event_id: "r2",
          excess_returned_total_minor: 300,
        }),
      ],
      "paid",
      { recorded: 500, returned: 300, returnable: 0 },
    );
    expect([...excessReturnRefundIds(d)]).toEqual(["r2"]);
  });

  it("negative control (M1): 'still to return' is the server's figure, never recorded − returned", () => {
    // Recorded 500, nothing returned as excess, but an ordinary refund already
    // brought net to the total: the server says 0 — no "still to return 500".
    const d = detail([event("c", "created", 10500, { excess_minor: 500 })], "paid", {
      recorded: 500,
      returned: 0,
      returnable: 0,
    });
    expect(excessReturnStateOf(d)).toBe("nothing_to_return");
    expect(
      excessReturnStateOf(detail([], "paid", { recorded: 500, returned: 0, returnable: 500 })),
    ).toBe("returnable");
    expect(
      excessReturnStateOf(detail([], "paid", { recorded: 500, returned: 500, returnable: 0 })),
    ).toBe("all_returned");
  });

  it("nothing is returnable before confirmation, nor once rejected or reversed", () => {
    const excess = { recorded: 500, returned: 0, returnable: 0 };
    expect(excessReturnStateOf(detail([], "pending", excess))).toBe("awaiting_confirmation");
    expect(excessReturnStateOf(detail([], "failed", excess))).toBe("not_a_claim");
    expect(excessReturnStateOf(detail([], "reversed", excess))).toBe("not_a_claim");
  });

  it("the refund explanation follows the server's current accounting (105 → return 5 → refund 20 / refund all)", () => {
    // Excess returned, sale untouched: "still paid in full".
    expect(
      excessRefundNoteKeyOf(
        detail([], "paid", { recorded: 500, returned: 500, returnable: 0, saleFullyPaid: true }),
      ),
    ).toBe("payments.excess.refundStatusNote");
    // Then an ordinary 20 refund (net 80 < 100), or a full refund (net 0): never
    // "still paid in full" again.
    for (const status of ["paid", "refunded"]) {
      expect(
        excessRefundNoteKeyOf(
          detail([], status, { recorded: 500, returned: 500, returnable: 0, saleFullyPaid: false }),
        ),
      ).toBe("payments.excess.refundStatusNoteSaleRefunded");
    }
    // Nothing returned as excess: no explanation.
    expect(
      excessRefundNoteKeyOf(detail([], "paid", { recorded: 500, returned: 0, returnable: 500 })),
    ).toBeNull();
    for (const locale of [en, km]) {
      const excess = (locale.payments as unknown as Record<string, Record<string, string>>)[
        "excess"
      ]!;
      expect(excess["refundStatusNote"]).toBeString();
      expect(excess["refundStatusNoteSaleRefunded"]).toBeString();
    }
    expect(en.payments.excess.refundStatusNoteSaleRefunded).not.toMatch(/paid in full/i);
  });

  it("an ordinary payment has no excess state and no labelled refund", () => {
    const d = detail([
      event("c", "created", 10000, { request_digest_version: 1 }),
      event("r", "refund", 500, {}),
    ]);
    expect(excessReturnStateOf(d)).toBeNull();
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
      ["payment_nothing_outstanding", "nothing_outstanding"],
      ["payment_duplicate_transfer_reference", "duplicate_transfer_reference"],
      ["payment_excess_reinstatement_required", "excess_reinstatement_required"],
      ["payment_excess_changed", "excess_changed"],
    ] as const) {
      expect(paymentErrorMessageKey(serverError("x", 409, code))).toBe(`payments.errors.${key}`);
      expect((en.payments.errors as Record<string, string>)[key]).toBeString();
      expect((km.payments.errors as Record<string, string>)[key]).toBeString();
    }
  });
});

describe("068 repair — the excess sheet's key is durable and scoped (B2)", () => {
  it("the same request after a reload reuses its key; another request, order, member or organization does not", async () => {
    const {
      beginExcessRecording,
      excessRecordingFingerprint,
      excessRecordingSettled,
      hasPendingExcessRecording,
      readExcessIntent,
      resetExcessRecording,
    } = await import("@/lib/excess-intent");
    const scope = { userId: "u1", organizationId: "o1", orderId: "order-1" };
    const request = { method: "khqr", amountMinor: 10500, reference: "TRF-1", reason: "More" };
    let n = 0;
    const key = () => `k${++n}`;
    const first = beginExcessRecording(scope, excessRecordingFingerprint(request), key);
    // "Reload": nothing in the component survives; the store does.
    expect(readExcessIntent(scope)?.key).toBe(first.key);
    expect(hasPendingExcessRecording(scope)).toBe(true);
    expect(
      beginExcessRecording(
        scope,
        excessRecordingFingerprint({ ...request, reference: " TRF-1 " }),
        key,
      ).key,
    ).toBe(first.key);
    // Scoped: another order / member / organization never sees it.
    for (const other of [
      { ...scope, orderId: "order-2" },
      { ...scope, userId: "u2" },
      { ...scope, organizationId: "o2" },
    ]) {
      expect(readExcessIntent(other)).toBeNull();
    }
    // A different (mistyped) request gets its own key and never displaces the
    // unknown one: the original request still replays under its key.
    const typo = beginExcessRecording(
      scope,
      excessRecordingFingerprint({ ...request, amountMinor: 10600 }),
      key,
    );
    expect(typo.key).not.toBe(first.key);
    excessRecordingSettled(scope, typo.key); // the server refused it: settled
    expect(beginExcessRecording(scope, excessRecordingFingerprint(request), key).key).toBe(
      first.key,
    );
    excessRecordingSettled(scope, first.key); // accepted (replayed)
    expect(readExcessIntent(scope)).toBeNull();
    expect(hasPendingExcessRecording(scope)).toBe(false);
    beginExcessRecording(scope, excessRecordingFingerprint(request), key);
    resetExcessRecording(scope);
    expect(readExcessIntent(scope)).toBeNull();
  });

  it("the sheet no longer mints a per-open key; Order detail persists it and offers the sheet only while something is owed", async () => {
    const sheet = await Bun.file("src/components/orders/RecordExcessPaymentSheet.tsx").text();
    expect(sheet).not.toContain("randomUUID");
    expect(sheet).not.toContain("idempotencyKey");
    const order = await Bun.file("src/routes/app.orders.$id.tsx").text();
    expect(order).toContain("settlement.outstanding.amount > 0");
    expect(order).toContain("beginExcessRecording(");
    expect(order).toContain("hasPendingExcessRecording(excessIntentScope)");
    expect(order).toContain("excessRecordingSettled(");
  });
});

describe("068 repair — ordinary refund and excess return keys are domain-separated", () => {
  it("a lost ordinary refund is never re-sent as an excess return under its key", async () => {
    const { beginRefund, refundFingerprint } = await import("@/lib/refund-intent");
    expect(refundFingerprint(500, "Excess")).not.toBe(
      refundFingerprint(500, "Excess", "excess_return"),
    );
    // The ordinary fingerprint is unchanged by the purpose parameter.
    expect(refundFingerprint(500, "Excess", "refund")).toBe(refundFingerprint(500, "Excess"));
    const scope = { userId: "u1", organizationId: "o1", paymentId: "p-sep" };
    let n = 0;
    const key = () => `r${++n}`;
    const ordinary = beginRefund(scope, 500, "Excess", key);
    const excess = beginRefund(scope, 500, "Excess", key, Date.now(), "excess_return");
    expect(excess.key).not.toBe(ordinary.key);
    // The same excess return again reuses its own key.
    expect(beginRefund(scope, 500, "Excess", key, Date.now(), "excess_return").key).toBe(
      excess.key,
    );
  });
});

describe("068 repair — Payment detail and Payments use the server's figures", () => {
  it("no client-side 'still to return'; the excess view is gated by payments.reconcile", async () => {
    const detail = await Bun.file("src/routes/app.payments.$id.tsx").text();
    expect(detail).not.toContain("unreturnedExcessOf");
    expect(detail).toContain('excessState === "returnable"');
    expect(detail).toContain("formatMoney(excess.returnable)");
    const payments = await Bun.file("src/routes/app.payments.tsx").text();
    expect(payments).toContain("const excessView = excessSelected && canReconcile;");
    expect(payments).toContain("{canReconcile ? (");
  });

  it("both locales carry the new copy, and the Khmer keys match the English ones", () => {
    const flat = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, `${prefix}${k}.`),
          )
        : [prefix.slice(0, -1)];
    const enKeys = flat(en).filter((k) => /excess|Excess/.test(k));
    const kmKeys = flat(km).filter((k) => /excess|Excess/.test(k));
    expect(kmKeys.sort()).toEqual(enKeys.sort());
    expect(enKeys).toContain("payments.excessToReturn.filter");
    expect(enKeys).toContain("payments.actions.reinstateExcess.submit");
    expect(enKeys).toContain("payments.excess.state.nothing_to_return");
  });
});
