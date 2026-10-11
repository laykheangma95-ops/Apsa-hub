/**
 * src/lib/refund-intent.ts — the durable identity of ONE logical refund
 * (CORRECTIONS.md, CORRECTION-005). Behaviour against a real Storage contract:
 * scope isolation (member, organization, payment), same-request reuse, what is
 * and is not stored (never the reason text), success / acknowledgement /
 * abandonment, expiry, the record cap, and the page-lifetime fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  abandonPendingRefund,
  acknowledgeRefunds,
  beginRefund,
  readRefundIntent,
  refundFingerprint,
  refundSucceeded,
  REFUND_INTENT_MAX_RECORDS,
  REFUND_INTENT_TTL_MS,
  type RefundIntentScope,
} from "@/lib/refund-intent";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.has(key) ? this.items.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
  dump() {
    return [...this.items.values()].join("");
  }
}

const holder = globalThis as unknown as { sessionStorage?: unknown };
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  holder.sessionStorage = storage;
});
afterEach(() => {
  delete holder.sessionStorage;
});

const A: RefundIntentScope = { userId: "member-a", organizationId: "org-1", paymentId: "pay-1" };
let keys = 0;
const nextKey = () => `key-${++keys}`;

describe("one logical refund, one durable key", () => {
  it("the same amount and reason reuse the pending key; anything else is a new refund with a new key", () => {
    const first = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    const retry = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    expect(retry.key).toBe(first.key);
    const changed = beginRefund(A, 4000, "Second cup returned", nextKey);
    expect(changed.key).not.toBe(first.key);
    expect(beginRefund(A, 3000, "Second cup returned", nextKey).key).not.toBe(changed.key);
  });

  it("survives a reload: the record lives in this tab's storage, not in memory", () => {
    const first = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    // A reload starts with empty memory; only sessionStorage carries over.
    const persisted = JSON.parse(storage.getItem("apsa.refund-intent.v1")!);
    expect(Object.values(persisted)).toHaveLength(1);
    expect(readRefundIntent(A).pending?.key).toBe(first.key);
  });

  it("never stores the reason text — only a fingerprint of the request", () => {
    beginRefund(A, 4000, "Customer Sokha returned a cracked cup", nextKey);
    expect(storage.dump()).not.toContain("Sokha");
    expect(storage.dump()).not.toContain("cracked");
    expect(readRefundIntent(A).pending?.fingerprint).toBe(
      refundFingerprint(4000, "Customer Sokha returned a cracked cup"),
    );
  });

  it("is scoped to member, organization AND payment — nobody else sees or reuses it", () => {
    const mine = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    for (const other of [
      { ...A, userId: "member-b" },
      { ...A, organizationId: "org-2" },
      { ...A, paymentId: "pay-2" },
    ]) {
      expect(readRefundIntent(other).pending).toBeNull();
      expect(beginRefund(other, 4000, "Customer returned one cup", nextKey).key).not.toBe(mine.key);
    }
    expect(readRefundIntent(A).pending?.key).toBe(mine.key); // A→B→A finds it again
  });

  it("success clears the pending refund and records it as SEEN; the next refund gets a new key", () => {
    const first = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    refundSucceeded(A, "refund-event-1");
    expect(readRefundIntent(A)).toMatchObject({ pending: null, acknowledged: ["refund-event-1"] });
    expect(beginRefund(A, 4000, "Customer returned one cup", nextKey).key).not.toBe(first.key);
  });

  it("an explicit review acknowledges refunds; declining abandons the pending one", () => {
    beginRefund(A, 4000, "Customer returned one cup", nextKey);
    acknowledgeRefunds(A, ["refund-event-1", "refund-event-2", "refund-event-1"]);
    expect(readRefundIntent(A).acknowledged).toEqual(["refund-event-1", "refund-event-2"]);
    abandonPendingRefund(A);
    expect(readRefundIntent(A).pending).toBeNull();
    expect(readRefundIntent(A).acknowledged).toEqual(["refund-event-1", "refund-event-2"]);
  });

  it("expires after 24 hours and keeps at most 50 records per tab", () => {
    const t0 = 1_000_000;
    beginRefund(A, 4000, "Customer returned one cup", nextKey, t0);
    expect(readRefundIntent(A, t0 + REFUND_INTENT_TTL_MS - 1).pending).not.toBeNull();
    expect(readRefundIntent(A, t0 + REFUND_INTENT_TTL_MS).pending).toBeNull();
    for (let i = 0; i < REFUND_INTENT_MAX_RECORDS + 10; i++) {
      beginRefund({ ...A, paymentId: `pay-${i}` }, 100, "r", nextKey, t0 + i);
    }
    const persisted = JSON.parse(storage.getItem("apsa.refund-intent.v1")!);
    expect(Object.keys(persisted)).toHaveLength(REFUND_INTENT_MAX_RECORDS);
    // The newest are the ones kept.
    expect(
      readRefundIntent({ ...A, paymentId: `pay-${REFUND_INTENT_MAX_RECORDS + 9}` }, t0 + 100)
        .pending,
    ).not.toBeNull();
    expect(readRefundIntent({ ...A, paymentId: "pay-0" }, t0 + 100).pending).toBeNull();
  });

  it("without usable sessionStorage it still works for the page's lifetime (private mode, blocked storage)", () => {
    holder.sessionStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    const first = beginRefund(A, 4000, "Customer returned one cup", nextKey);
    expect(beginRefund(A, 4000, "Customer returned one cup", nextKey).key).toBe(first.key);
  });
});
