/**
 * Inbox order-draft money — pure rules (src/lib/order-draft.ts).
 *
 * The defect: the Inbox draft seeded its line sum, discount and delivery fee
 * with usd(0), so the first riel line threw "Cannot add different currencies"
 * (PrepareOrderSheet crashed on any KHR product), and an empty draft showed a
 * "$0.00" total. These pin the replacement: every amount in the draft's own
 * currency, no combined total for mixed currencies, exact integer arithmetic,
 * and a fee that only applies to the currency it was typed in.
 *
 * The mounted behaviour is in inbox-order-money-mounted.runtime.ts and the
 * server agreement in order-money-stock-safety.runtime.ts.
 *
 * Run: bun test src/tests/inbox-order-money.test.ts
 */
import { describe, expect, it } from "bun:test";
import { createOrder, ORDER_APPROVAL_LIMIT_CENTS, PERMISSION_DENIED } from "@/lib/api";
import { parseDeliveryFee } from "@/lib/delivery-fee";
import {
  orderRequestFingerprint,
  sharedIdempotencyHolder,
  type IdempotencyScope,
} from "@/lib/idempotency";
import { khr, usd } from "@/lib/money";
import {
  calculateDraftTotals,
  draftBlock,
  draftCurrency,
  NO_DELIVERY_FEE,
  type DraftDeliveryFee,
} from "@/lib/order-draft";
import { NO_DISCOUNT, type CartDiscountInput } from "@/lib/pos-cart";
import type { Money } from "@/types";

const line = (unitPrice: Money, quantity = 1) => ({ unitPrice, quantity });
const fee = (text: string, currency: "USD" | "KHR"): DraftDeliveryFee => ({ text, currency });
const discount = (
  mode: "amount" | "percent",
  text: string,
  currency: "USD" | "KHR",
): CartDiscountInput => ({ enabled: true, mode, text, currency });

describe("KHR drafts never start from a USD zero", () => {
  it("2 × ៛5,000 = ៛10,000, and every amount (zeros included) is KHR", () => {
    const totals = calculateDraftTotals([line(khr(5000), 2)]);
    expect(totals).toEqual({
      kind: "priced",
      currency: "KHR",
      subtotal: khr(10000),
      discount: khr(0),
      deliveryFee: khr(0),
      total: khr(10000),
      itemCount: 2,
      discountProblem: null,
      deliveryFeeInvalid: false,
    });
  });

  it("a riel discount and a riel delivery fee stay riel — no ×100, no conversion", () => {
    const totals = calculateDraftTotals(
      [line(khr(5000), 2)],
      discount("amount", "1,000", "KHR"),
      fee("2,000", "KHR"),
    );
    expect(totals).toMatchObject({
      subtotal: khr(10000),
      discount: khr(1000),
      deliveryFee: khr(2000),
      total: khr(11000),
    });
    expect(
      calculateDraftTotals([line(khr(5000), 2)], discount("percent", "10", "KHR")),
    ).toMatchObject({ discount: khr(1000), total: khr(9000) });
  });

  it("a fractional riel fee is invalid and blocks, never rounded", () => {
    const totals = calculateDraftTotals([line(khr(5000))], NO_DISCOUNT, fee("1.50", "KHR"));
    expect(totals).toMatchObject({ deliveryFeeInvalid: true, deliveryFee: khr(0) });
    expect(draftBlock(totals)).toBe("delivery_fee");
  });

  it("large KHR stays exact", () => {
    expect(calculateDraftTotals([line(khr(4_000_000), 999)])).toMatchObject({
      total: khr(3_996_000_000),
    });
  });
});

describe("USD drafts are unchanged", () => {
  it("2 × $20.00 − $5.25 + $1.50 = $36.25 in cents", () => {
    expect(
      calculateDraftTotals(
        [line(usd(2000), 2)],
        discount("amount", "5.25", "USD"),
        fee("1.50", "USD"),
      ),
    ).toMatchObject({
      currency: "USD",
      subtotal: usd(4000),
      discount: usd(525),
      deliveryFee: usd(150),
      total: usd(3625),
    });
  });

  it("zero discount and zero fee are USD zeros", () => {
    expect(calculateDraftTotals([line(usd(2000))], NO_DISCOUNT, fee("0", "USD"))).toMatchObject({
      discount: usd(0),
      deliveryFee: usd(0),
      total: usd(2000),
    });
  });

  it("an oversized discount is refused, never clamped", () => {
    const totals = calculateDraftTotals([line(usd(2000))], discount("amount", "25", "USD"));
    expect(totals).toMatchObject({ discountProblem: "exceeds_subtotal", total: usd(2000) });
    expect(draftBlock(totals)).toBe("discount");
  });
});

describe("currency safety", () => {
  it("a mixed draft has no combined total at all, and is blocked", () => {
    const totals = calculateDraftTotals(
      [line(usd(2000)), line(khr(5000))],
      NO_DISCOUNT,
      fee("1", "USD"),
    );
    expect(totals).toEqual({ kind: "mixed_currency", currencies: ["USD", "KHR"], itemCount: 2 });
    expect("total" in totals).toBe(false);
    expect(draftBlock(totals)).toBe("mixed_currency");
    expect(draftCurrency([line(usd(1)), line(khr(1))])).toBeNull();
  });

  it("an empty draft has no currency and no amount — not a $0.00", () => {
    const totals = calculateDraftTotals([]);
    expect(totals).toEqual({ kind: "empty", itemCount: 0 });
    expect(draftBlock(totals)).toBe("empty");
    expect(draftCurrency([])).toBeNull();
  });

  it("a fee typed for another currency is never applied ('5' is not both $5.00 and ៛5)", () => {
    expect(calculateDraftTotals([line(khr(5000))], NO_DISCOUNT, fee("5", "USD"))).toMatchObject({
      deliveryFee: khr(0),
      total: khr(5000),
      deliveryFeeInvalid: false,
    });
    expect(calculateDraftTotals([line(khr(5000))], NO_DISCOUNT, NO_DELIVERY_FEE)).toMatchObject({
      total: khr(5000),
    });
  });

  it("a total past the exact-integer range is out_of_range, carrying no Money", () => {
    const totals = calculateDraftTotals(
      [line(usd(Number.MAX_SAFE_INTEGER))],
      NO_DISCOUNT,
      fee("1", "USD"),
    );
    expect(totals).toEqual({ kind: "out_of_range", currency: "USD", itemCount: 1 });
    expect(draftBlock(totals)).toBe("out_of_range");
  });
});

describe("delivery fee text uses the strict amount grammar", () => {
  it("refuses an ambiguous comma instead of reading '1,5' as 15", () => {
    expect(parseDeliveryFee("1,5", "USD")).toBeNull();
    expect(parseDeliveryFee("1,5", "KHR")).toBeNull();
    expect(parseDeliveryFee(",15", "USD")).toBeNull();
    expect(parseDeliveryFee("2,000", "KHR")).toBe(2000);
    expect(parseDeliveryFee("1,000", "USD")).toBe(100000);
    expect(parseDeliveryFee("1.50", "USD")).toBe(150);
  });
});

describe("prototype createOrder never reads riel as cents", () => {
  const order = (total: Money) => ({
    customerId: "cus-1",
    channel: "facebook" as const,
    items: [{ productId: "prd-1", nameKm: "x", nameEn: "x", quantity: 1, unitPrice: total }],
    subtotal: total,
    discount: { amount: 0, currency: total.currency },
    deliveryFee: { amount: 0, currency: total.currency },
    total,
  });

  it("a ៛60,000 order is not refused as 'above $500'", async () => {
    const created = await createOrder(order(khr(60_000)));
    expect(created.total).toEqual(khr(60_000));
  });

  it("the dollar limit still applies to dollars", async () => {
    await expect(createOrder(order(usd(ORDER_APPROVAL_LIMIT_CENTS + 1)))).rejects.toThrow(
      PERMISSION_DENIED,
    );
  });
});

describe("page-lifetime replay identity (sharedIdempotencyHolder)", () => {
  const scope = (over: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    userId: "user-1",
    organizationId: "org-1",
    flow: "inbox-prepare-order",
    subject: "conversation-a",
    ...over,
  });
  const fp = orderRequestFingerprint({ items: [{ variantId: "v", quantity: 1 }] });

  it("the same scope gets the same holder (a remount finds the unresolved key)", () => {
    const first = sharedIdempotencyHolder(scope()).claim().keyFor(fp);
    const afterRemount = sharedIdempotencyHolder(scope()).claim().keyFor(fp);
    expect(afterRemount).toBe(first);
  });

  it("member, organization, flow and conversation each partition the identity", () => {
    const key = sharedIdempotencyHolder(scope({ subject: "conv-iso" }))
      .claim()
      .keyFor(fp);
    for (const other of [
      scope({ subject: "conv-iso", userId: "user-2" }),
      scope({ subject: "conv-iso", organizationId: "org-2" }),
      scope({ subject: "conv-iso", flow: "other-flow" }),
      scope({ subject: "conv-other" }),
    ]) {
      expect(sharedIdempotencyHolder(other).claim().keyFor(fp)).not.toBe(key);
    }
    // …and the original scope still holds its own key.
    expect(
      sharedIdempotencyHolder(scope({ subject: "conv-iso" }))
        .claim()
        .keyFor(fp),
    ).toBe(key);
  });

  it("an accepted claim retires the key; a superseded claim cannot", () => {
    const holder = sharedIdempotencyHolder(scope({ subject: "conv-retire" }));
    const abandoned = holder.claim();
    const key = abandoned.keyFor(fp);
    const newer = holder.claim();
    expect(newer.keyFor(fp)).toBe(key);
    abandoned.retire(); // late, superseded: no effect
    expect(
      sharedIdempotencyHolder(scope({ subject: "conv-retire" }))
        .claim()
        .keyFor(fp),
    ).toBe(key);
    const owner = sharedIdempotencyHolder(scope({ subject: "conv-retire" })).claim();
    owner.keyFor(fp);
    owner.retire(); // accepted
    expect(
      sharedIdempotencyHolder(scope({ subject: "conv-retire" }))
        .claim()
        .keyFor(fp),
    ).not.toBe(key);
  });

  it("is bounded: the least recently used scopes are dropped first", () => {
    const keep = sharedIdempotencyHolder(scope({ subject: "lru-keep" }));
    const oldest = sharedIdempotencyHolder(scope({ subject: "lru-0" }));
    for (let i = 1; i < 250; i++) {
      sharedIdempotencyHolder(scope({ subject: `lru-${i}` }));
      if (i % 50 === 0) sharedIdempotencyHolder(scope({ subject: "lru-keep" })); // in use
    }
    // In use → retained; untouched for 249 newer scopes → evicted (a new holder).
    expect(sharedIdempotencyHolder(scope({ subject: "lru-keep" }))).toBe(keep);
    expect(sharedIdempotencyHolder(scope({ subject: "lru-0" }))).not.toBe(oldest);
  });
});
