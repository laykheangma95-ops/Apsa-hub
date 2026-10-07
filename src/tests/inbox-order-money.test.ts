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
  SHARED_IDEMPOTENCY_HOLDER_LIMIT,
  sharedIdempotencyHolder,
  sharedIdempotencyHolderCount,
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

describe("registry capacity never destroys an unresolved replay key (review P2)", () => {
  // Pressure well past the nominal capacity, using only the public API.
  const PRESSURE = 250;
  const scope = (subject: string, over: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    userId: "cap-user",
    organizationId: "cap-org",
    flow: "inbox-prepare-order",
    subject,
    ...over,
  });
  const fpX = orderRequestFingerprint({ items: [{ variantId: "x", quantity: 1 }] });

  it("A: an unresolved holder survives more idle scopes than the capacity (same key after)", () => {
    const k = sharedIdempotencyHolder(scope("cap-A")).claim().keyFor(fpX); // lost response
    for (let i = 0; i < PRESSURE; i++) sharedIdempotencyHolder(scope(`cap-idle-${i}`));
    expect(sharedIdempotencyHolder(scope("cap-A")).claim().keyFor(fpX)).toBe(k);
  });
});

describe("registry capacity policy: idle evictable, unresolved protected, compaction recovers", () => {
  const LIMIT = SHARED_IDEMPOTENCY_HOLDER_LIMIT;
  let seq = 0;
  const fresh = (tag: string) => `${tag}-${++seq}`;
  const scope = (subject: string, over: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    userId: "pol-user",
    organizationId: "pol-org",
    flow: "inbox-prepare-order",
    subject,
    ...over,
  });
  const fp = (o: object) => orderRequestFingerprint(o);
  const X = fp({ items: [{ variantId: "v1", quantity: 1 }], deliveryMinor: 0 });
  const holder = (subject: string, over?: Partial<IdempotencyScope>) =>
    sharedIdempotencyHolder(scope(subject, over));
  /** Touch enough brand-new idle scopes to push every older idle scope out. */
  const idlePressure = () => {
    for (let i = 0; i < LIMIT + 50; i++) holder(fresh("idle"));
  };
  /** An unresolved scope: a create was sent and never accepted. */
  const unresolved = (subject: string, request = X) => holder(subject).claim().keyFor(request);

  it("defines unresolved precisely: issued-and-not-accepted, cleared only by the owning retire", () => {
    const h = holder(fresh("state"));
    expect(h.hasUnresolvedKey()).toBe(false); // nothing issued
    const a = h.claim();
    a.keyFor(X);
    expect(h.hasUnresolvedKey()).toBe(true); // sent, outcome unknown
    const b = h.claim();
    b.keyFor(X); // retry of the same request takes ownership
    a.retire(); // G: stale/superseded callback
    expect(h.hasUnresolvedKey()).toBe(true);
    b.retire(); // E: the accepted owner
    expect(h.hasUnresolvedKey()).toBe(false);
  });

  it("B: the OLDEST scope is unresolved → an idle scope is evicted instead", () => {
    const oldest = fresh("oldest");
    const k = unresolved(oldest);
    const firstIdleSubject = fresh("first-idle");
    const firstIdle = holder(firstIdleSubject); // older than the pressure below
    idlePressure();
    expect(holder(oldest).claim().keyFor(X)).toBe(k);
    // The idle scope that was older than the pressure is the one that went.
    expect(holder(firstIdleSubject)).not.toBe(firstIdle);
    expect(sharedIdempotencyHolderCount()).toBeLessThanOrEqual(LIMIT + 50);
  });

  it("C: many unresolved scopes all survive idle pressure, and the registry stays bounded", () => {
    const subjects = Array.from({ length: 20 }, () => fresh("multi"));
    const keys = subjects.map((s) => unresolved(s));
    idlePressure();
    subjects.forEach((s, i) => expect(holder(s).claim().keyFor(X)).toBe(keys[i]!));
    for (const s of subjects) holder(s).claim().retire(); // no-op claims: still unresolved
    subjects.forEach((s, i) => expect(holder(s).claim().keyFor(X)).toBe(keys[i]!));
  });

  it("D/E: an accepted (retired) holder becomes evictable; the same scope then starts fresh (H)", () => {
    const subject = fresh("retire");
    const h = holder(subject);
    const claim = h.claim();
    const k = claim.keyFor(X);
    claim.retire(); // accepted
    idlePressure();
    // Evicted while idle: a new holder instance, behaving exactly like a fresh one.
    const after = holder(subject);
    expect(after).not.toBe(h);
    expect(after.hasUnresolvedKey()).toBe(false);
    // H: an identical NEW order after acceptance gets a new key (two sales).
    expect(after.claim().keyFor(X)).not.toBe(k);
  });

  it("F: a failed / uncertain attempt keeps its protection under pressure", () => {
    const subject = fresh("failed");
    const k = holder(subject).claim().keyFor(X); // request failed: never retired
    idlePressure();
    idlePressure();
    expect(holder(subject).hasUnresolvedKey()).toBe(true);
    expect(holder(subject).claim().keyFor(X)).toBe(k);
  });

  it("G: a stale retire during pressure cannot make the live holder evictable", () => {
    const subject = fresh("stale");
    const h = holder(subject);
    const stale = h.claim();
    const k = stale.keyFor(X);
    const live = holder(subject).claim();
    expect(live.keyFor(X)).toBe(k);
    stale.retire(); // late abandoned success
    idlePressure();
    expect(holder(subject)).toBe(h);
    expect(holder(subject).claim().keyFor(X)).toBe(k);
  });

  it("all-unresolved pressure: no key is destroyed to stay at the limit; retirement lets it compact", () => {
    const subjects = Array.from({ length: LIMIT + 60 }, () => fresh("all-unresolved"));
    // Each create is sent as soon as its claim is taken — exactly as
    // createRealOrder does (claim.keyFor runs synchronously in the same call).
    const keys = subjects.map((s) => holder(s).claim().keyFor(X));
    // Temporary overflow, by design: every one of these keys is still live.
    expect(sharedIdempotencyHolderCount()).toBeGreaterThanOrEqual(LIMIT + 60);
    subjects.forEach((s, i) => expect(holder(s).claim().keyFor(X)).toBe(keys[i]!));

    // Most creates are now accepted (retired by their current owners)…
    const owners = subjects.map((s) => holder(s).claim());
    owners.forEach((o, i) => {
      o.keyFor(X);
      if (i >= 10) o.retire();
    });
    // …so the next lookup compacts back to the nominal limit, and the ten
    // still-unresolved creates keep their keys.
    holder(fresh("compact-trigger"));
    expect(sharedIdempotencyHolderCount()).toBeLessThanOrEqual(LIMIT);
    subjects.slice(0, 10).forEach((s, i) => expect(holder(s).claim().keyFor(X)).toBe(keys[i]!));
  });

  it("idle-only pressure never grows the registry past max(limit, its current size)", () => {
    // Other tests in this process may legitimately leave unresolved holders,
    // so the bound is relative: idle scopes alone never push it upward.
    const before = sharedIdempotencyHolderCount();
    idlePressure();
    idlePressure();
    expect(sharedIdempotencyHolderCount()).toBeLessThanOrEqual(Math.max(LIMIT, before));
  });

  it("scope isolation holds under pressure (member / organization / flow / conversation)", () => {
    const subject = fresh("iso");
    const mine = unresolved(subject);
    const others = [
      { userId: "pol-user-2" },
      { organizationId: "pol-org-2" },
      { flow: "other-flow" },
    ].map((over) => holder(subject, over).claim().keyFor(X));
    const otherConversation = holder(fresh("iso-other")).claim().keyFor(X);
    idlePressure();
    for (const k of [...others, otherConversation]) expect(k).not.toBe(mine);
    expect(holder(subject).claim().keyFor(X)).toBe(mine);
  });

  it("fingerprints after pressure: same request replays; changed quantity / variant / fee are new requests", () => {
    const base = { items: [{ variantId: "v1", quantity: 2 }], deliveryMinor: 2000 };
    const changes = [
      { items: [{ variantId: "v1", quantity: 3 }], deliveryMinor: 2000 }, // quantity
      { items: [{ variantId: "v2", quantity: 2 }], deliveryMinor: 2000 }, // variant
      { items: [{ variantId: "v1", quantity: 2 }], deliveryMinor: 3000 }, // fee
    ];
    for (const changed of changes) {
      const subject = fresh("fp");
      const k = unresolved(subject, fp(base));
      idlePressure();
      expect(holder(subject).claim().keyFor(fp(base))).toBe(k);
      expect(holder(subject).claim().keyFor(fp(changed))).not.toBe(k);
    }
  });
});
