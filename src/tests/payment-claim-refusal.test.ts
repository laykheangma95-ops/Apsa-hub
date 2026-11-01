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
    const ask = (r: typeof request) => ({
      fingerprint: excessRecordingFingerprint(r),
      method: r.method,
      amountMinor: r.amountMinor,
    });
    const keyOf = (result: { status: string; entry?: { key: string } }) => {
      expect(result.status).toBe("ready");
      return result.entry!.key;
    };
    let n = 0;
    const key = () => `k${++n}`;
    const first = keyOf(beginExcessRecording(scope, ask(request), key));
    expect(readExcessIntent(scope)?.key).toBe(first);
    expect(hasPendingExcessRecording(scope)).toBe(true);
    expect(keyOf(beginExcessRecording(scope, ask({ ...request, reference: " TRF-1 " }), key))).toBe(
      first,
    );
    for (const other of [
      { ...scope, orderId: "order-2" },
      { ...scope, userId: "u2" },
      { ...scope, organizationId: "o2" },
    ]) {
      expect(readExcessIntent(other)).toBeNull();
    }
    const typo = keyOf(beginExcessRecording(scope, ask({ ...request, amountMinor: 10600 }), key));
    expect(typo).not.toBe(first);
    excessRecordingSettled(scope, typo);
    expect(keyOf(beginExcessRecording(scope, ask(request), key))).toBe(first);
    excessRecordingSettled(scope, first);
    expect(hasPendingExcessRecording(scope)).toBe(false);
    beginExcessRecording(scope, ask(request), key);
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

// ═════════════════════════════════════════════════════════════════════════════
// Replay safety: which errors settle a key, and capacity without eviction.
// Behavioral negative controls against 8db32ba.
// ═════════════════════════════════════════════════════════════════════════════

describe("replay safety — only a write-free refusal settles a key", () => {
  it("negative control: 'Failed to load outstanding balance' and 'Upstream request already timed out' are uncertain, not refusals", async () => {
    const { excessRecordingOutcomeOf } = await import("@/lib/excess-intent");
    for (const message of [
      "Failed to load outstanding balance",
      "Upstream request already timed out",
    ]) {
      const err = new Error(message); // what the wire delivers: a message only
      expect(excessRecordingOutcomeOf(err)).toBe("uncertain");
      expect(paymentClaimRefusalOf(err)).toBeNull();
    }
  });

  it("a structured write-free refusal, or its EXACT message, settles; a near miss does not", async () => {
    const { excessRecordingOutcomeOf } = await import("@/lib/excess-intent");
    const { PAYMENT_REFUSALS } = await import("@/lib/payment-refusals");
    for (const kind of [
      "nothing_outstanding",
      "duplicate_transfer_reference",
      "outstanding_changed",
      "no_excess",
      "order_not_payable",
    ] as const) {
      const { code, message } = PAYMENT_REFUSALS[kind];
      expect(excessRecordingOutcomeOf(serverError("x", 409, code))).toBe("write_free");
      expect(excessRecordingOutcomeOf(new Error(message))).toBe("write_free");
      expect(excessRecordingOutcomeOf(new Error(`${message}.`))).toBe("uncertain");
      expect(excessRecordingOutcomeOf(new Error(message.toUpperCase()))).toBe("uncertain");
      expect(excessRecordingOutcomeOf(serverError(message, 500))).toBe("uncertain");
    }
  });

  it("network errors, unknown server errors and pre-database refusals keep the key", async () => {
    const { excessRecordingOutcomeOf } = await import("@/lib/excess-intent");
    for (const err of [
      new TypeError("Failed to fetch"),
      new Error("Something went wrong. Reference: req_aaaaaaaaaaaaaaaaaaaa"),
      new Error("Missing permission: payments.record_excess"),
      new Error("Payment not found"),
      serverError("x", 409, "idempotency_conflict"),
      serverError("x", 409, "principal_changed"),
      serverError("x", 429, "rate_limited"),
      { notAnError: true },
      null,
    ]) {
      expect(excessRecordingOutcomeOf(err)).toBe("uncertain");
    }
  });
});

describe("replay safety — capacity refuses new attempts, never evicts", () => {
  const ask = (amountMinor: number) => ({
    fingerprint: `fp-${amountMinor}`,
    method: "khqr",
    amountMinor,
  });

  it("negative control: an original attempt followed by more than five different ones still replays under its original key", async () => {
    const { beginExcessRecording, readExcessIntents, EXCESS_INTENT_MAX_PENDING } =
      await import("@/lib/excess-intent");
    const scope = { userId: "cap-u", organizationId: "cap-o", orderId: "cap-order" };
    const original = beginExcessRecording(scope, ask(10000), () => "original-key");
    expect(original).toMatchObject({ status: "ready", entry: { key: "original-key" } });
    let n = 0;
    const statuses = [];
    for (let i = 1; i <= 7; i++) {
      statuses.push(beginExcessRecording(scope, ask(10000 + i), () => `other-${++n}`).status);
    }
    // Four more fit beside the original; the rest are refused, nothing evicted.
    expect(EXCESS_INTENT_MAX_PENDING).toBe(5);
    expect(statuses).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "capacity",
      "capacity",
      "capacity",
    ]);
    expect(readExcessIntents(scope).map((e) => e.key)).toEqual([
      "original-key",
      "other-1",
      "other-2",
      "other-3",
      "other-4",
    ]);
    // The original request again: its original key, even at capacity.
    expect(beginExcessRecording(scope, ask(10000), () => "never")).toMatchObject({
      status: "ready",
      entry: { key: "original-key" },
    });
  });

  it("activity on many other orders and members never evicts an unresolved key; the tab limit refuses instead", async () => {
    const {
      beginExcessRecording,
      readExcessIntent,
      resetExcessRecording,
      EXCESS_INTENT_MAX_SCOPES,
    } = await import("@/lib/excess-intent");
    const keep = { userId: "tab-u0", organizationId: "tab-o", orderId: "tab-order-0" };
    expect(beginExcessRecording(keep, ask(1), () => "keep-key").status).toBe("ready");
    const others = [];
    for (let i = 1; i < EXCESS_INTENT_MAX_SCOPES + 10; i++) {
      const scope = { userId: `tab-u${i % 3}`, organizationId: "tab-o", orderId: `tab-order-${i}` };
      others.push({ scope, status: beginExcessRecording(scope, ask(1), () => `k-${i}`).status });
    }
    expect(others.filter((o) => o.status === "tab_capacity").length).toBeGreaterThan(0);
    expect(readExcessIntent(keep)?.key).toBe("keep-key");
    // Explicit reset frees room without touching anyone else's key.
    for (const o of others) if (o.status === "ready") resetExcessRecording(o.scope);
    expect(readExcessIntent(keep)?.key).toBe("keep-key");
    resetExcessRecording(keep);
    expect(readExcessIntent(keep)).toBeNull();
  });

  it("survives a reload through sessionStorage, with no expiry; storage refusing the write refuses the attempt", async () => {
    const backing = new Map<string, string>();
    let refuseWrites = false;
    const fake = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuseWrites) throw new Error("QuotaExceededError");
        backing.set(k, v);
      },
      removeItem: (k: string) => backing.delete(k),
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { value: fake, configurable: true });
    try {
      const intent = await import("@/lib/excess-intent");
      const scope = { userId: "s-u", organizationId: "s-o", orderId: "s-order" };
      const old = Date.now() - 30 * 24 * 60 * 60 * 1000; // a month ago
      expect(intent.beginExcessRecording(scope, ask(500), () => "stored-key", old).status).toBe(
        "ready",
      );
      // A "reload": nothing in memory, only the tab's storage.
      expect(JSON.stringify([...backing.values()])).toContain("stored-key");
      expect(intent.readExcessIntent(scope)?.key).toBe("stored-key");
      refuseWrites = true;
      expect(intent.beginExcessRecording(scope, ask(600), () => "lost").status).toBe(
        "not_remembered",
      );
      refuseWrites = false;
      expect(intent.readExcessIntents(scope).map((e) => e.key)).toEqual(["stored-key"]);
      intent.forgetExcessRecording(scope, "stored-key");
      expect(intent.readExcessIntent(scope)).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});
