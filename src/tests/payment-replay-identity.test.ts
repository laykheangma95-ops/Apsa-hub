/**
 * src/lib/payment-replay.ts: an unresolved payment's retry identity, kept on
 * the QueryClient so it outlives the Order detail screen. The mounted, SQL
 * backed cases live in order-mutation-principal-mounted.runtime.ts; these pin
 * the store's partition, payload binding and lifecycle directly.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import {
  openPaymentReplay,
  paymentReplayKeyFor,
  resolvePaymentReplay,
  type PaymentReplayPayload,
  type PaymentReplayScope,
} from "@/lib/payment-replay";

const A: PaymentReplayScope = { userId: "user-a", organizationId: "org-1", orderId: "order-1" };
const PAY: PaymentReplayPayload = {
  method: "bank_transfer",
  amountMinor: 12345,
  currency: "KHR",
  reference: "REF-1",
};
let seq = 0;
const fresh = () => `fresh-${++seq}`;

describe("payment replay identity", () => {
  it("the same logical payment reuses its unresolved key; the sheet's fresh key is ignored", () => {
    const qc = new QueryClient();
    const first = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    expect(paymentReplayKeyFor(qc, A, { ...PAY }, fresh(), null)).toBe(first);
    // Reference whitespace is not a different payment (the sheet trims it too).
    expect(paymentReplayKeyFor(qc, A, { ...PAY, reference: " REF-1 " }, fresh(), null)).toBe(first);
  });

  it("each financially relevant field change gets its own key", () => {
    const qc = new QueryClient();
    const first = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    const changed: PaymentReplayPayload[] = [
      { ...PAY, amountMinor: 12346 },
      { ...PAY, currency: "USD" },
      { ...PAY, method: "khqr" },
      { ...PAY, reference: "REF-2" },
      { ...PAY, reference: undefined },
    ];
    const keys = changed.map((p) => paymentReplayKeyFor(qc, A, p, fresh(), null));
    expect(new Set([first, ...keys]).size).toBe(changed.length + 1);
  });

  it("is partitioned by user, organization and order", () => {
    const qc = new QueryClient();
    const own = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    for (const other of [
      { ...A, userId: "user-b" },
      { ...A, organizationId: "org-2" },
      { ...A, orderId: "order-2" },
    ]) {
      expect(paymentReplayKeyFor(qc, other, PAY, fresh(), null)).not.toBe(own);
      expect(openPaymentReplay(qc, other).candidates.size).toBe(1); // only its own
    }
    expect(paymentReplayKeyFor(qc, A, PAY, fresh(), null)).toBe(own);
  });

  it("an opening from another scope is never used", () => {
    const qc = new QueryClient();
    paymentReplayKeyFor(qc, A, PAY, "k-a", null);
    const openingOfA = openPaymentReplay(qc, A);
    const b = { ...A, userId: "user-b" };
    expect(paymentReplayKeyFor(qc, b, PAY, "k-b", openingOfA)).toBe("k-b");
  });

  it("a success retires the identity: a later identical payment is a new one", () => {
    const qc = new QueryClient();
    const first = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    resolvePaymentReplay(qc, A, first);
    expect(paymentReplayKeyFor(qc, A, PAY, fresh(), null)).not.toBe(first);
  });

  it("a sheet opened while unresolved still replays when the original's success lands first", () => {
    const qc = new QueryClient();
    const first = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    const opening = openPaymentReplay(qc, A);
    resolvePaymentReplay(qc, A, first); // the original's answer arrives
    expect(paymentReplayKeyFor(qc, A, PAY, fresh(), opening)).toBe(first);
    // A changed payment from that same opening is still a new one.
    expect(paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: 1 }, fresh(), opening)).not.toBe(
      first,
    );
    // A sheet opened after the success knows nothing of it.
    expect(paymentReplayKeyFor(qc, A, PAY, fresh(), openPaymentReplay(qc, A))).not.toBe(first);
  });

  it("resolving one key leaves other unresolved payments in place", () => {
    const qc = new QueryClient();
    const one = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    const two = paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: 700 }, fresh(), null);
    resolvePaymentReplay(qc, A, one);
    resolvePaymentReplay(qc, { ...A, userId: "user-b" }, two); // another principal's: no effect
    expect(paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: 700 }, fresh(), null)).toBe(two);
  });

  it("no eviction: many unresolved identities are all kept", () => {
    const qc = new QueryClient();
    const keys = Array.from({ length: 1000 }, (_, i) =>
      paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: i + 1 }, fresh(), null),
    );
    keys.forEach((key, i) =>
      expect(paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: i + 1 }, fresh(), null)).toBe(key),
    );
  });

  it("a fresh key already bound to another payload is never bound twice", () => {
    const qc = new QueryClient();
    const sheetKey = "sheet-key";
    expect(paymentReplayKeyFor(qc, A, PAY, sheetKey, null)).toBe(sheetKey);
    const changed = paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: 1 }, sheetKey, null);
    expect(changed).not.toBe(sheetKey);
    resolvePaymentReplay(qc, A, sheetKey);
    // Still bound once: a resolved key is not handed to a new payload either.
    expect(paymentReplayKeyFor(qc, A, { ...PAY, amountMinor: 2 }, sheetKey, null)).not.toBe(
      sheetKey,
    );
  });

  it("lives on the QueryClient: a remount reuses it, a new client (page reload) does not", () => {
    const qc = new QueryClient();
    const first = paymentReplayKeyFor(qc, A, PAY, fresh(), null);
    qc.clear(); // Settings' sign-out empties the cache, not the replay identities
    expect(paymentReplayKeyFor(qc, A, PAY, fresh(), null)).toBe(first);
    expect(paymentReplayKeyFor(new QueryClient(), A, PAY, fresh(), null)).not.toBe(first);
  });
});
