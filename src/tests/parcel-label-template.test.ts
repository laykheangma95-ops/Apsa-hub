/**
 * Parcel label template redesign — customer / shop / carrier / items / COD /
 * QR + Code 128.
 *
 * Three layers, each against the real code:
 *   1. deriveLabelPayment — the exact PAID / COD / CHECK PAYMENT rule over the
 *      authoritative Payment ledger (pure).
 *   2. getParcelLabelData — assembly against a mocked db: shipping snapshot,
 *      shop phone, carrier, payment rows, tenant scoping, permissions.
 *   3. buildParcelLabel + <ParcelLabel> — what is actually printed, rendered to
 *      static markup (default Khmer locale), plus print-geometry checks for the
 *      QR and Code 128.
 *
 * Run: bun test src/tests/parcel-label-template.test.ts
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "@/lib/i18n";
import km from "@/locales/km.json";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import { deriveLabelPayment, type LabelPaymentRow } from "../server/fulfillment/label-payment";
import {
  buildParcelLabel,
  safeLogoUrl,
  PARCEL_LABEL_SIZE_MM,
  type ParcelLabelInput,
} from "../lib/labels/parcel-label";
import { ParcelLabel } from "../components/labels/ParcelLabel";
import { isValidParcelCode } from "../lib/barcode/parcel-code";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";
const CUSTOMER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOCATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PARCEL_CODE = "APSA:PCL:v1:Zk3_q9-LmN0pQrStUvWxYz";
const FIXED_NOW = new Date("2026-10-01T10:30:00.000Z");
const T = km.labels.parcel;

// ── 1. Payment rule (pure) ────────────────────────────────────────────────────

function totals(total: number, received = 0, refunded = 0) {
  return {
    total_minor: total,
    received_minor: received,
    refunded_minor: refunded,
    net_minor: received - refunded,
  };
}
const row = (method: string, status: string, verification_state: string): LabelPaymentRow => ({
  method,
  status,
  verification_state,
});

describe("deriveLabelPayment — COD / PAID / CHECK rule", () => {
  it("no payment recorded → COD for the full outstanding amount (USD exact minor units)", () => {
    expect(deriveLabelPayment({ currency: "USD", totals: totals(3500), payments: [] })).toEqual({
      state: "cod",
      collect: { amount: 3500, currency: "USD" },
      partial: false,
      checkReason: null,
    });
  });

  it("the POS/Record-payment COD expectation (cod · pending · unverified) → COD", () => {
    const p = deriveLabelPayment({
      currency: "KHR",
      totals: totals(140000),
      payments: [row("cod", "pending", "unverified")],
    });
    expect(p.state).toBe("cod");
    expect(p.collect).toEqual({ amount: 140000, currency: "KHR" });
  });

  it("verified deposit → COD of the remaining balance only, marked partial", () => {
    const p = deriveLabelPayment({
      currency: "USD",
      totals: totals(3500, 1000),
      payments: [row("khqr", "paid", "staff_confirmed")],
    });
    expect(p).toEqual({
      state: "cod",
      collect: { amount: 2500, currency: "USD" },
      partial: true,
      checkReason: null,
    });
  });

  it("fully paid (staff / manager / bank verified) → PAID, no amount", () => {
    for (const v of ["staff_confirmed", "manager_verified", "bank_verified"]) {
      expect(
        deriveLabelPayment({
          currency: "USD",
          totals: totals(3500, 3500),
          payments: [row("bank_transfer", "paid", v)],
        }),
      ).toEqual({ state: "paid", collect: null, partial: false, checkReason: null });
    }
  });

  it("over-settled → PAID, never a negative amount", () => {
    expect(
      deriveLabelPayment({ currency: "USD", totals: totals(2000, 2500), payments: [] }).state,
    ).toBe("paid");
  });

  it("an unverified KHQR/bank/cash claim (screenshot only) → CHECK, never PAID, never COD", () => {
    for (const method of ["khqr", "bank_transfer", "cash"]) {
      const p = deriveLabelPayment({
        currency: "USD",
        totals: totals(3500),
        payments: [row(method, "pending", "unverified")],
      });
      expect(p).toEqual({
        state: "check",
        collect: null,
        partial: false,
        checkReason: "payment_review",
      });
    }
  });

  it("a duplicate-suspected payment (even COD) → CHECK", () => {
    const p = deriveLabelPayment({
      currency: "USD",
      totals: totals(3500),
      payments: [row("cod", "pending", "duplicate_suspected")],
    });
    expect(p.state).toBe("check");
    expect(p.checkReason).toBe("payment_review");
  });

  it("a mismatched (failed) payment → CHECK", () => {
    const p = deriveLabelPayment({
      currency: "USD",
      totals: totals(3500),
      payments: [row("khqr", "failed", "mismatch")],
    });
    expect(p.state).toBe("check");
    expect(p.checkReason).toBe("payment_failed");
  });

  it("a reversed payment with no live COD expectation → CHECK", () => {
    const p = deriveLabelPayment({
      currency: "USD",
      totals: totals(3500),
      payments: [row("khqr", "reversed", "staff_confirmed")],
    });
    expect(p.state).toBe("check");
    expect(p.checkReason).toBe("payment_reversed");
  });

  it("a reversed payment replaced by an explicit COD expectation → COD", () => {
    const p = deriveLabelPayment({
      currency: "USD",
      totals: totals(3500),
      payments: [row("cash", "reversed", "unverified"), row("cod", "pending", "unverified")],
    });
    expect(p.state).toBe("cod");
    expect(p.collect).toEqual({ amount: 3500, currency: "USD" });
  });

  it("partly or fully refunded with a balance outstanding → CHECK, never COD of refunded money", () => {
    for (const refunded of [1000, 3500]) {
      const p = deriveLabelPayment({
        currency: "USD",
        totals: totals(3500, 3500, refunded),
        payments: [row("khqr", refunded === 3500 ? "refunded" : "paid", "bank_verified")],
      });
      expect(p.state).toBe("check");
      expect(p.checkReason).toBe("refunded");
      expect(p.collect).toBeNull();
    }
  });

  it("no settlement row at all → CHECK (never an assumed COD)", () => {
    const p = deriveLabelPayment({ currency: "KHR", totals: null, payments: [] });
    expect(p.state).toBe("check");
    expect(p.checkReason).toBe("settlement_unavailable");
  });

  it("KHR amount stays exact integer riel", () => {
    const p = deriveLabelPayment({ currency: "KHR", totals: totals(140100, 40000), payments: [] });
    expect(p.collect).toEqual({ amount: 100100, currency: "KHR" });
    expect(Number.isInteger(p.collect!.amount)).toBe(true);
  });
});

// ── 2. Service assembly (mocked db) ───────────────────────────────────────────

function makeCtx(permissions: string[], organizationId = ORG_A): AuthorizationContext {
  const perms = new Set(permissions);
  return {
    userId: "user-1",
    organizationId,
    roleId: "role",
    systemRole: "CASHIER",
    permissions: perms,
    can: (k: string) => perms.has(k),
    require: (k: string) => {
      if (!perms.has(k)) throw new ForbiddenError(`Missing permission: ${k}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("owner");
    },
  } as unknown as AuthorizationContext;
}

const PRINT_PERMS = ["orders.read", "fulfillment.print_label", "delivery.read"];

type Tables = Record<string, unknown>;

/** Fake supabase: records every filter so tenant scoping can be asserted. */
function makeDb(tables: Tables, calls: Array<{ table: string; filters: string[] }>) {
  const result = (table: string) => {
    const data = tables[table] ?? null;
    return { data, error: data === null ? { code: "PGRST116", message: "no rows" } : null };
  };
  return {
    from(table: string) {
      const call = { table, filters: [] as string[] };
      calls.push(call);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          call.filters.push(`${col}=${String(val)}`);
          return q;
        },
        neq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        single: async () => result(table),
        maybeSingle: async () => result(table),
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve(result(table)).then(resolve, reject),
      };
      return q;
    },
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    organization_id: ORG_A,
    order_number: "APSA-2026-001048",
    customer_id: CUSTOMER_ID,
    location_id: null,
    source: "FACEBOOK",
    currency: "USD",
    subtotal_minor: 3500,
    discount_minor: 0,
    delivery_minor: 0,
    total_minor: 3500,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    refund_status: "none",
    fulfillment_status: "unfulfilled",
    created_by: "user-1",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    source_conversation_ref: null,
    shipping_name: "សុខា ចាន់",
    shipping_phone: "012 345 678",
    shipping_address: "ផ្ទះ 12 ផ្លូវ 240, សង្កាត់បឹងកេងកង, ភ្នំពេញ",
    ...overrides,
  };
}

function baseTables(overrides: Tables = {}): Tables {
  return {
    orders: orderRow(),
    order_items: [
      {
        quantity: 2,
        product_name_snapshot: "Iced Coffee",
        variant_name_snapshot: "Large",
      },
      { quantity: 1, product_name_snapshot: "Croissant", variant_name_snapshot: null },
    ],
    organizations: { display_name: "Dara Coffee" },
    locations: [{ phone: "023 999 888" }],
    deliveries: [],
    order_payment_totals: {
      order_id: ORDER_ID,
      total_minor: 3500,
      received_minor: 0,
      refunded_minor: 0,
      net_minor: 0,
      currency: "USD",
      payment_status: "unpaid",
      refund_status: "none",
    },
    payments: [],
    parcels: [],
    // A customer profile that DIFFERS from the order snapshot — must never leak.
    customers: { display_name: "Profile Name", primary_phone: "099 000 000" },
    customer_addresses: [{ house_no: "99", street: "Profile Street", is_default: true }],
    ...overrides,
  };
}

async function label(tables: Tables, perms = PRINT_PERMS, orgId = ORG_A) {
  const calls: Array<{ table: string; filters: string[] }> = [];
  const db = makeDb(tables, calls);
  const orders = await import("../server/orders/repository");
  const fulfil = await import("../server/fulfillment/repository");
  const parcels = await import("../server/parcels/repository");
  const restore = [
    orders.setOrderRepositoryDbForTests(db),
    fulfil.setFulfillmentRepositoryDbForTests(db),
    parcels.setParcelRepositoryDbForTests(db),
  ];
  try {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await getParcelLabelData(makeCtx(perms, orgId), ORDER_ID);
    return { data, calls };
  } finally {
    for (const r of restore.reverse()) r();
  }
}

describe("getParcelLabelData — customer comes from the order shipping snapshot", () => {
  it("prints the snapshot name, phone and address", async () => {
    const { data } = await label(baseTables());
    expect(data.customer).toEqual({
      name: "សុខា ចាន់",
      phone: "012 345 678",
      address: "ផ្ទះ 12 ផ្លូវ 240, សង្កាត់បឹងកេងកង, ភ្នំពេញ",
      addressConfirmed: true,
    });
  });

  it("a later customer-profile edit cannot change a historical label", async () => {
    const before = await label(baseTables());
    const after = await label(
      baseTables({
        customers: { display_name: "Renamed Later", primary_phone: "011 111 111" },
        customer_addresses: [{ house_no: "1", street: "New Street", is_default: true }],
      }),
    );
    expect(after.data.customer).toEqual(before.data.customer);
    // The label path never even reads the customer profile tables.
    expect(after.calls.some((c) => c.table === "customers")).toBe(false);
    expect(after.calls.some((c) => c.table === "customer_addresses")).toBe(false);
  });
});

describe("getParcelLabelData — shop", () => {
  it("uses the active organization's name and the order location's phone", async () => {
    const { data, calls } = await label(
      baseTables({ orders: orderRow({ location_id: LOCATION_ID }) }),
    );
    expect(data.merchant).toEqual({
      businessName: "Dara Coffee",
      phone: "023 999 888",
      logoUrl: null,
    });
    const loc = calls.find((c) => c.table === "locations")!;
    expect(loc.filters).toContain(`organization_id=${ORG_A}`);
    expect(loc.filters).toContain(`id=${LOCATION_ID}`);
    const org = calls.find((c) => c.table === "organizations")!;
    expect(org.filters).toContain(`id=${ORG_A}`);
  });

  it("falls back to the single active location when the order has none", async () => {
    const { data } = await label(baseTables());
    expect(data.merchant.phone).toBe("023 999 888");
  });

  it("never guesses between several branches", async () => {
    const { data } = await label(
      baseTables({ locations: [{ phone: "023 111 111" }, { phone: "023 222 222" }] }),
    );
    expect(data.merchant.phone).toBeNull();
  });

  it("logo is null — APSA has no organization logo storage yet", async () => {
    const { data } = await label(baseTables());
    expect(data.merchant.logoUrl).toBeNull();
  });
});

describe("getParcelLabelData — carrier", () => {
  it("prints the active delivery's carrier and tracking", async () => {
    const { data } = await label(
      baseTables({
        deliveries: [
          { provider_name: "VET Express", external_tracking_number: "VET-123", status: "ready" },
        ],
      }),
    );
    expect(data.delivery).toEqual({
      providerName: "VET Express",
      trackingNumber: "VET-123",
      status: "ready",
      serviceName: null,
    });
  });

  it("a failed or cancelled attempt is NOT printed as the carrier", async () => {
    for (const status of ["failed", "cancelled"]) {
      const { data } = await label(
        baseTables({
          deliveries: [{ provider_name: "VET Express", external_tracking_number: "X", status }],
        }),
      );
      expect(data.delivery).toBeNull();
    }
  });

  it("no delivery.read → no carrier data at all", async () => {
    const { data, calls } = await label(
      baseTables({
        deliveries: [{ provider_name: "VET", external_tracking_number: "X", status: "ready" }],
      }),
      ["orders.read", "fulfillment.print_label"],
    );
    expect(data.delivery).toBeNull();
    expect(calls.some((c) => c.table === "deliveries")).toBe(false);
  });

  it("delivery reads are scoped to this org AND this order", async () => {
    const { calls } = await label(baseTables());
    const d = calls.find((c) => c.table === "deliveries")!;
    expect(d.filters).toContain(`organization_id=${ORG_A}`);
    expect(d.filters).toContain(`order_id=${ORDER_ID}`);
  });
});

describe("getParcelLabelData — payment state from the ledger", () => {
  it("an unverified KHQR claim prints CHECK PAYMENT, not COD", async () => {
    const { data } = await label(
      baseTables({
        payments: [{ method: "khqr", status: "pending", verification_state: "unverified" }],
      }),
    );
    expect(data.payment.state).toBe("check");
    expect(data.payment.paid).toBe(false);
    expect(data.payment.collect).toBeNull();
  });

  it("payment reads are org- and order-scoped", async () => {
    const { calls } = await label(baseTables());
    const p = calls.find((c) => c.table === "payments")!;
    expect(p.filters).toContain(`organization_id=${ORG_A}`);
    expect(p.filters).toContain(`order_id=${ORDER_ID}`);
  });
});

describe("getParcelLabelData — security", () => {
  it("an order outside the caller's organization is an opaque 404", async () => {
    // The order repository filters by the caller's org; another org's order id
    // therefore resolves to no row.
    const { orders: _o, ...rest } = baseTables();
    await expect(label({ ...rest, orders: null }, PRINT_PERMS, ORG_A)).rejects.toThrow(
      /not found/i,
    );
  });

  it("the order lookup is filtered by the server-resolved organization id", async () => {
    const { calls } = await label(baseTables());
    const o = calls.find((c) => c.table === "orders")!;
    expect(o.filters).toContain(`organization_id=${ORG_A}`);
    expect(o.filters).toContain(`id=${ORDER_ID}`);
  });

  it("without fulfillment.print_label → Forbidden, before any read", async () => {
    await expect(label(baseTables(), ["orders.read", "delivery.read"])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("without orders.read → Forbidden", async () => {
    await expect(
      label(baseTables(), ["fulfillment.print_label", "delivery.read"]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ── 3. Builder + rendered label ───────────────────────────────────────────────

function input(overrides: Partial<ParcelLabelInput> = {}): ParcelLabelInput {
  return {
    merchant: { businessName: "Dara Coffee", phone: "023 999 888", logoUrl: null },
    customer: {
      name: "Sokha Chan",
      phone: "012 345 678",
      address: "12 St 240, BKK1, Phnom Penh",
      addressConfirmed: true,
    },
    order: {
      id: ORDER_ID,
      orderNumber: "APSA-2026-001048",
      itemCount: 3,
      items: [
        { quantity: 2, productName: "Iced Coffee", variantName: "Large" },
        { quantity: 1, productName: "Croissant", variantName: null },
      ],
    },
    reprint: false,
    payment: { state: "cod", collect: { amount: 3500, currency: "USD" } },
    delivery: { providerName: "VET Express", trackingNumber: "VET-123", status: "ready" },
    parcelCode: PARCEL_CODE,
    ...overrides,
  };
}

// Other suites share the i18n singleton and may switch it; the label is
// asserted in the default (Khmer) locale.
beforeEach(async () => {
  await i18n.changeLanguage("km");
});

function render(i: ParcelLabelInput): string {
  return renderToStaticMarkup(
    createElement(ParcelLabel, { vm: buildParcelLabel(i, { now: FIXED_NOW }) }),
  );
}

describe("label — products", () => {
  it("single product", () => {
    const vm = buildParcelLabel(
      input({
        order: {
          id: ORDER_ID,
          orderNumber: "A-1",
          itemCount: 1,
          items: [{ quantity: 1, productName: "Croissant", variantName: null }],
        },
      }),
    );
    expect(vm.items.map((l) => l.text)).toEqual(["1 × Croissant"]);
  });

  it("multiple products with variants and quantities", () => {
    const vm = buildParcelLabel(input());
    expect(vm.items.map((l) => l.text)).toEqual(["2 × Iced Coffee — Large", "1 × Croissant"]);
    const html = render(input());
    expect(html).toContain("Iced Coffee — Large");
    expect(html).toContain("2 ×");
  });

  it("long Khmer/English names wrap (break-words, 2-row clamp) and use more row budget", () => {
    const long = "កាហ្វេទឹកដោះគោត្រជាក់ពិសេសសម្រាប់អតិថិជនជាទីស្រឡាញ់ Extra Large Premium Blend";
    const items = Array.from({ length: 6 }, () => ({
      quantity: 1,
      productName: long,
      variantName: "ធំ",
    }));
    const vm = buildParcelLabel(
      input({ order: { id: ORDER_ID, orderNumber: "A-1", itemCount: 6, items } }),
    );
    // 8 rows: three 2-row lines + 1 continuation row.
    expect(vm.items).toHaveLength(3);
    expect(vm.overflowCount).toBe(3);
    const html = render(
      input({ order: { id: ORDER_ID, orderNumber: "A-1", itemCount: 6, items } }),
    );
    expect(html).toContain("break-words");
    expect(html).not.toContain("truncate");
  });

  it("a very long address prints compact and leaves fewer rows for items", () => {
    const vm = buildParcelLabel(
      input({ customer: { ...input().customer, address: "x".repeat(200) } }),
    );
    expect(vm.addressCompact).toBe(true);
    const items = Array.from({ length: 10 }, (_, i) => ({
      quantity: 1,
      productName: `Item ${i}`,
      variantName: null,
    }));
    const vm2 = buildParcelLabel(
      input({
        customer: { ...input().customer, address: "x".repeat(200) },
        order: { id: ORDER_ID, orderNumber: "A-1", itemCount: 10, items },
      }),
    );
    expect(vm2.items.length + vm2.overflowCount).toBe(10);
    const vmShort = buildParcelLabel(
      input({ order: { id: ORDER_ID, orderNumber: "A-1", itemCount: 10, items } }),
    );
    // The address takes its lines first; the list keeps at least one line + "+N more".
    expect(vm2.items.length).toBeGreaterThanOrEqual(1);
    expect(vm2.items.length).toBeLessThan(vmShort.items.length);
    expect(vm2.overflowCount).toBeGreaterThan(0);
  });

  it("a long address is clamped to its budgeted lines and marked, never grown without bound", () => {
    const long = "ផ្ទះលេខ ១២៣ ផ្លូវ ២៤០ សង្កាត់បឹងកេងកង១ ខណ្ឌចំការមន រាជធានីភ្នំពេញ ".repeat(20);
    const vm = buildParcelLabel(input({ customer: { ...input().customer, address: long } }));
    expect(vm.addressTruncated).toBe(true);
    expect(vm.addressLines).toBeGreaterThanOrEqual(2);
    expect(vm.addressLines).toBeLessThanOrEqual(6);
    // Hard cap (300) + ellipsis; cut on a grapheme boundary (no orphan sign).
    expect(vm.customer.address!.length).toBeLessThanOrEqual(301);
    expect(vm.customer.address!.endsWith("…")).toBe(true);
    const html = render(input({ customer: { ...input().customer, address: long } }));
    expect(html).toContain(km.labels.parcel.addressTruncated);
    expect(html).toContain(`-webkit-line-clamp:${vm.addressLines}`);
  });

  it("a short address is printed whole with no marker", () => {
    const vm = buildParcelLabel(input());
    expect(vm.addressTruncated).toBe(false);
    expect(vm.customer.address).toBe("12 St 240, BKK1, Phnom Penh");
    expect(render(input())).not.toContain(km.labels.parcel.addressTruncated);
  });

  it("never prints an internal product/order UUID", () => {
    const html = render(input());
    expect(html).not.toContain(ORDER_ID);
  });
});

describe("label — shop header", () => {
  it("shows shop name and phone", () => {
    const html = render(input());
    expect(html).toContain("Dara Coffee");
    expect(html).toContain("023 999 888");
  });

  it("renders the logo when a safe URL is present", () => {
    const html = render(
      input({ merchant: { businessName: "Dara", logoUrl: "https://cdn.example.com/l.png" } }),
    );
    expect(html).toContain('data-testid="parcel-label-logo"');
    expect(html).toContain("https://cdn.example.com/l.png");
  });

  it("clean text-only header (no <img>) when the logo is absent or unsafe", () => {
    for (const logoUrl of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "http://x/l.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ]) {
      const html = render(input({ merchant: { businessName: "Dara", logoUrl } }));
      expect(html).not.toContain("<img");
      expect(html).toContain("Dara");
    }
    expect(safeLogoUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });
});

describe("label — receiver", () => {
  it("prints the receiver name, phone and address from the input (order snapshot)", () => {
    const html = render(input());
    expect(html).toContain("Sokha Chan");
    expect(html).toContain("012 345 678");
    expect(html).toContain("12 St 240, BKK1, Phnom Penh");
  });
});

describe("label — carrier", () => {
  it("shows carrier and tracking when available", () => {
    const html = render(input());
    expect(html).toContain("VET Express");
    expect(html).toContain("VET-123");
  });

  it("shows service when a future adapter provides one", () => {
    const html = render(
      input({
        delivery: {
          providerName: "ZTO",
          trackingNumber: "ZT1",
          status: "ready",
          serviceName: "Express",
        },
      }),
    );
    expect(html).toContain("Express");
  });

  it("safe fallback when no delivery exists — no invented carrier", () => {
    const html = render(input({ delivery: null }));
    expect(html).toContain(T.carrierNotAssigned);
    expect(html).not.toContain("VET");
  });
});

describe("label — payment", () => {
  it("COD shows the exact collectible amount, prominently (USD)", () => {
    const html = render(input());
    expect(html).toContain(T.codToCollect);
    expect(html).toContain("$35.00");
    expect(html).toContain("text-[22pt]");
  });

  it("COD in KHR shows riel exactly", () => {
    const html = render(
      input({ payment: { state: "cod", collect: { amount: 140000, currency: "KHR" } } }),
    );
    expect(html).toContain("៛140,000");
  });

  it("partial COD notes it is the remaining balance", () => {
    const html = render(
      input({
        payment: { state: "cod", collect: { amount: 2500, currency: "USD" }, partial: true },
      }),
    );
    expect(html).toContain("$25.00");
    expect(html).toContain(T.balanceDue);
  });

  it("PAID shows a small PAID mark and NO amount at all", () => {
    const html = render(input({ payment: { state: "paid", collect: null } }));
    expect(html).toContain(T.paid);
    expect(html).toContain(T.paidNoCollect);
    expect(html).not.toContain("$");
    expect(html).not.toContain(T.codToCollect);
  });

  it("PAID ignores any stray amount the input carries", () => {
    const vm = buildParcelLabel(
      input({ payment: { state: "paid", collect: { amount: 3500, currency: "USD" } } }),
    );
    expect(vm.payment.collectFormatted).toBeNull();
  });

  it("CHECK (refunded / reversed / review / failed / unavailable) shows neither PAID nor an amount", () => {
    for (const checkReason of [
      "refunded",
      "payment_reversed",
      "payment_review",
      "payment_failed",
      "settlement_unavailable",
    ] as const) {
      const html = render(
        input({
          payment: { state: "check", collect: { amount: 3500, currency: "USD" }, checkReason },
        }),
      );
      expect(html).toContain(T.checkPayment);
      expect(html).toContain(T.checkReason[checkReason]);
      expect(html).not.toContain("$35.00");
      expect(html).not.toContain(`✓ ${T.paid}`);
      expect(html).not.toContain(T.codToCollect);
    }
  });

  it("a COD state with no amount degrades to CHECK, never an empty COD box", () => {
    const vm = buildParcelLabel(input({ payment: { state: "cod", collect: null } }));
    expect(vm.payment.state).toBe("check");
    expect(vm.payment.collectFormatted).toBeNull();
  });
});

describe("label — QR + Code 128", () => {
  it("renders BOTH codes, encoding the same canonical parcel identity", () => {
    const vm = buildParcelLabel(input(), { now: FIXED_NOW });
    expect(vm.qr!.payload).toBe(PARCEL_CODE);
    expect(vm.code128!.payload).toBe(PARCEL_CODE);
    expect(isValidParcelCode(vm.qr!.payload)).toBe(true);
    const html = render(input());
    expect(html).toContain('data-testid="parcel-label-qr"');
    expect(html).toContain('data-testid="parcel-label-code128"');
    expect(html).toContain(PARCEL_CODE);
  });

  it("no PII, money, product or order data is encoded in either code", () => {
    const vm = buildParcelLabel(input());
    for (const s of [
      "Sokha",
      "012 345 678",
      "BKK1",
      "3500",
      "35.00",
      "Iced Coffee",
      "Dara",
      "APSA-2026-001048",
      ORDER_ID,
      CUSTOMER_ID,
    ]) {
      expect(vm.qr!.payload).not.toContain(s);
      expect(vm.code128!.payload).not.toContain(s);
    }
  });

  it("a reprint reuses the exact same code and identical code graphics", () => {
    const first = buildParcelLabel(input(), { now: FIXED_NOW });
    const reprint = buildParcelLabel(input({ reprint: true }), {
      now: new Date("2026-12-01T00:00:00Z"),
    });
    expect(reprint.parcelCode).toBe(first.parcelCode);
    expect(reprint.qr!.svg).toBe(first.qr!.svg);
    expect(reprint.code128!.svg).toBe(first.code128!.svg);
  });

  it("without a parcel code: a placeholder, no codes, no order-UUID fallback", () => {
    const html = render(input({ parcelCode: null }));
    expect(html).toContain(T.codesPending);
    expect(html).not.toContain("<svg");
    expect(html).not.toContain(ORDER_ID);
  });

  it("print geometry: QR ≥ 0.5 mm/module with a 4-module quiet zone at 30 mm", () => {
    const vm = buildParcelLabel(input());
    const dim = Number(/viewBox="0 0 (\d+) /.exec(vm.qr!.svg)![1]);
    const modules = dim / 4; // moduleSize 4
    expect(30 / modules).toBeGreaterThanOrEqual(0.5);
    // First dark module starts after the 4-module quiet zone.
    const firstRect = /<rect x="(\d+)" y="(\d+)" width="\d+" height="4"/.exec(vm.qr!.svg)!;
    expect(Number(firstRect[1])).toBeGreaterThanOrEqual(16);
    expect(Number(firstRect[2])).toBeGreaterThanOrEqual(16);
  });

  it("print geometry: Code 128 spans the label width with X ≥ 0.17 mm and 10-module quiet zones", () => {
    const vm = buildParcelLabel(input());
    const width = Number(/viewBox="0 0 (\d+) /.exec(vm.code128!.svg)![1]);
    const modules = width / 2; // moduleWidth 2
    const printableMm = PARCEL_LABEL_SIZE_MM.width - 8; // 4 mm padding each side
    expect(printableMm / modules).toBeGreaterThanOrEqual(0.17);
    const firstBar = /<rect x="(\d+)"/.exec(vm.code128!.svg)!;
    expect(Number(firstBar[1])).toBe(20); // 10 quiet modules × 2
    expect(render(input())).toContain("h-[12mm] w-full");
  });

  it("black/white only: no colour or grey utility classes on the printed label", () => {
    // The code SVGs are pure #000 on #fff; everything else must use no colour at all.
    const html = render(input()).replace(/<svg[\s\S]*?<\/svg>/g, "");
    expect(html).not.toMatch(
      /text-neutral|text-gray|bg-neutral|text-text-|bg-surface|#[0-9a-f]{3,6}/i,
    );
    expect(html).not.toContain("uppercase");
  });
});

describe("deterministic fixtures — paid parcel and COD parcel", () => {
  it("COD parcel fixture", () => {
    const html = render(input());
    expect(html).toContain("$35.00");
    expect(html).toContain("2026-10-01 17:30"); // Phnom Penh time
  });

  it("paid parcel fixture", () => {
    const html = render(input({ payment: { state: "paid", collect: null } }));
    expect(html).toContain(T.paid);
    expect(html).not.toContain("$35.00");
  });
});
