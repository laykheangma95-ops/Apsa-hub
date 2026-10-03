/**
 * Ready-to-Pack queue + parcel label — eligibility, lifecycle, COD outstanding
 * and PII gating.
 *
 * Behavioural, driven against a mocked db. Covers the PR #80 repairs:
 *   - Ready-to-Pack includes confirmed + (unfulfilled | processing) (§11).
 *   - parcelLabelPrintability rejects terminal/never-shippable states and marks
 *     re-issues as reprints (§19).
 *   - the COD amount is the authoritative OUTSTANDING balance from
 *     order_payment_totals — partial payment, full settlement and refund all
 *     derive correctly, in integer minor units, no floating point (§18).
 *   - the parcel label is gated on the narrow fulfillment.print_label capability,
 *     NOT customers.view_sensitive (§20), and the on-file address is flagged
 *     addressConfirmed:false (§13).
 *
 * Run: bun test src/tests/ready-to-pack.test.ts
 */
import { describe, it, expect } from "bun:test";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import {
  isReadyToPackEligible,
  parcelLabelPrintability,
  ORDER_LIFECYCLE_STATUSES,
  ORDER_FULFILLMENT_STATUSES,
} from "../server/orders/state-machine";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";
const CUSTOMER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const PRINT_PERMS = ["orders.read", "fulfillment.print_label"];

function makeCtx(permissions: string[]): AuthorizationContext {
  const perms = new Set(permissions);
  return {
    userId: "user-1",
    organizationId: ORG_A,
    roleId: "role",
    systemRole: "MANAGER",
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

// ── Pure predicates ─────────────────────────────────────────────────────────────

describe("isReadyToPackEligible (pure)", () => {
  it("is true for confirmed + unfulfilled AND confirmed + processing (§11)", () => {
    for (const lifecycleStatus of ORDER_LIFECYCLE_STATUSES) {
      for (const fulfillmentStatus of ORDER_FULFILLMENT_STATUSES) {
        const expected =
          lifecycleStatus === "confirmed" &&
          (fulfillmentStatus === "unfulfilled" || fulfillmentStatus === "processing");
        expect(isReadyToPackEligible({ lifecycleStatus, fulfillmentStatus })).toBe(expected);
      }
    }
  });

  it("includes a processing order still awaiting shipment", () => {
    expect(
      isReadyToPackEligible({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" }),
    ).toBe(true);
  });

  it("excludes fulfilled, cancelled, completed and draft", () => {
    expect(
      isReadyToPackEligible({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" }),
    ).toBe(false);
    expect(
      isReadyToPackEligible({ lifecycleStatus: "confirmed", fulfillmentStatus: "cancelled" }),
    ).toBe(false);
    expect(
      isReadyToPackEligible({ lifecycleStatus: "completed", fulfillmentStatus: "unfulfilled" }),
    ).toBe(false);
    expect(
      isReadyToPackEligible({ lifecycleStatus: "cancelled", fulfillmentStatus: "unfulfilled" }),
    ).toBe(false);
    expect(
      isReadyToPackEligible({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" }),
    ).toBe(false);
  });
});

describe("parcelLabelPrintability (pure, §19)", () => {
  it("allows a confirmed unfulfilled order as a fresh print (not a reprint)", () => {
    expect(
      parcelLabelPrintability({ lifecycleStatus: "confirmed", fulfillmentStatus: "unfulfilled" }),
    ).toEqual({ allowed: true, reprint: false });
  });

  it("allows a confirmed processing/fulfilled order but marks it a REPRINT", () => {
    expect(
      parcelLabelPrintability({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" }),
    ).toEqual({ allowed: true, reprint: true });
    expect(
      parcelLabelPrintability({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" }),
    ).toEqual({ allowed: true, reprint: true });
  });

  it("refuses draft, cancelled, completed and a cancelled delivery", () => {
    expect(
      parcelLabelPrintability({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" }),
    ).toEqual({ allowed: false, reprint: false, reason: "draft" });
    expect(
      parcelLabelPrintability({ lifecycleStatus: "cancelled", fulfillmentStatus: "unfulfilled" }),
    ).toEqual({ allowed: false, reprint: false, reason: "cancelled" });
    expect(
      parcelLabelPrintability({ lifecycleStatus: "completed", fulfillmentStatus: "fulfilled" }),
    ).toEqual({ allowed: false, reprint: false, reason: "completed" });
    expect(
      parcelLabelPrintability({ lifecycleStatus: "confirmed", fulfillmentStatus: "cancelled" }),
    ).toEqual({ allowed: false, reprint: false, reason: "delivery_cancelled" });
  });
});

// ── Service (mocked db) ─────────────────────────────────────────────────────────

interface Tables {
  orders?: unknown;
  order_items?: unknown;
  customers?: unknown;
  customer_addresses?: unknown;
  organizations?: unknown;
  deliveries?: unknown;
  order_payment_totals?: unknown;
  payments?: unknown;
  locations?: unknown;
}

/**
 * Minimal fake supabase builder keyed by table name; each terminal (await,
 * .single(), .maybeSingle()) yields that table's canned {data,error}.
 */
function makeDb(tables: Tables) {
  const result = (table: string) => {
    const data = (tables as Record<string, unknown>)[table] ?? null;
    return { data, error: data === null ? { code: "PGRST116", message: "no rows" } : null };
  };
  return {
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
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
    currency: "KHR",
    subtotal_minor: 100000,
    discount_minor: 0,
    delivery_minor: 0,
    total_minor: 100000,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    refund_status: "none",
    fulfillment_status: "unfulfilled",
    created_by: "user-1",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    source_conversation_ref: null,
    ...overrides,
  };
}

/** One order_payment_totals view row. net_minor = received - refunded. */
function totalsRow(overrides: Record<string, unknown> = {}) {
  const total = (overrides.total_minor as number | undefined) ?? 100000;
  const received = (overrides.received_minor as number | undefined) ?? 0;
  const refunded = (overrides.refunded_minor as number | undefined) ?? 0;
  return {
    order_id: ORDER_ID,
    organization_id: ORG_A,
    total_minor: total,
    received_minor: received,
    refunded_minor: refunded,
    net_minor: received - refunded,
    currency: "KHR",
    payment_status: "unpaid",
    refund_status: "none",
    ...overrides,
  };
}

async function withDb<T>(tables: Tables, fn: () => Promise<T>): Promise<T> {
  const orders = await import("../server/orders/repository");
  const fulfil = await import("../server/fulfillment/repository");
  const parcels = await import("../server/parcels/repository");
  // No payment rows, location or parcel unless a test says otherwise. The label
  // read no longer swallows a failed parcel lookup, so the parcel repository is
  // served by the same fake rather than left pointing at a real client.
  const withDefaults: Tables = { payments: [], locations: [], parcels: [], ...tables };
  const restoreOrders = orders.setOrderRepositoryDbForTests(makeDb(withDefaults));
  const restoreFulfil = fulfil.setFulfillmentRepositoryDbForTests(makeDb(withDefaults));
  const restoreParcels = parcels.setParcelRepositoryDbForTests(makeDb(withDefaults));
  try {
    return await fn();
  } finally {
    restoreParcels();
    restoreFulfil();
    restoreOrders();
  }
}

describe("listReadyToPack", () => {
  it("returns a confirmed/unfulfilled order with the outstanding COD amount", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow({ total_minor: 100000 })],
        order_items: [{ order_id: ORDER_ID, quantity: 3 }],
        customers: [{ id: CUSTOMER_ID, display_name: "Sokha" }],
        deliveries: [],
        // Partial payment: 30,000 of 100,000 settled → collect 70,000.
        order_payment_totals: [totalsRow({ received_minor: 30000 })],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderNumber).toBe("APSA-2026-001048");
    expect(rows[0]!.customerName).toBe("Sokha");
    expect(rows[0]!.itemCount).toBe(3);
    expect(rows[0]!.paid).toBe(false);
    expect(rows[0]!.collect).toEqual({ amount: 70000, currency: "KHR" });
  });

  it("includes a processing order still awaiting shipment (§11)", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow({ fulfillment_status: "processing" })],
        order_items: [{ order_id: ORDER_ID, quantity: 1 }],
        customers: [{ id: CUSTOMER_ID, display_name: "Sokha" }],
        deliveries: [],
        order_payment_totals: [totalsRow()],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBe(ORDER_ID);
  });

  it("shows PAID (collect 0) when the order is fully settled", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [orderRow({ total_minor: 100000, payment_status: "paid" })],
        order_items: [{ order_id: ORDER_ID, quantity: 1 }],
        customers: [{ id: CUSTOMER_ID, display_name: "Sokha" }],
        deliveries: [],
        order_payment_totals: [totalsRow({ received_minor: 100000, payment_status: "paid" })],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows[0]!.paid).toBe(true);
    expect(rows[0]!.collect).toEqual({ amount: 0, currency: "KHR" });
  });

  it("excludes an order the DB somehow returned that is not eligible", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    const rows = await withDb(
      {
        orders: [
          orderRow({ fulfillment_status: "fulfilled" }),
          orderRow({ lifecycle_status: "cancelled" }),
        ],
        order_items: [],
        customers: [],
        deliveries: [],
        order_payment_totals: [],
      },
      () => listReadyToPack(makeCtx(["orders.read"])),
    );
    expect(rows).toHaveLength(0);
  });

  it("requires orders.read", async () => {
    const { listReadyToPack } = await import("../server/fulfillment/service");
    await withDb({ orders: [] }, async () => {
      await expect(listReadyToPack(makeCtx([]))).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe("getParcelLabelData — permission (§20)", () => {
  it("requires fulfillment.print_label on top of orders.read", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    await withDb({ orders: orderRow() }, async () => {
      await expect(getParcelLabelData(makeCtx(["orders.read"]), ORDER_ID)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it("does NOT accept customers.view_sensitive as a substitute", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    await withDb({ orders: orderRow() }, async () => {
      await expect(
        getParcelLabelData(makeCtx(["orders.read", "customers.view_sensitive"]), ORDER_ID),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe("getParcelLabelData — assembly", () => {
  it("assembles authoritative COD data with only fulfillment PII, address flagged unconfirmed", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow({ total_minor: 100000 }),
        order_items: [
          {
            id: "l1",
            order_id: ORDER_ID,
            product_id: "p1",
            variant_id: "v1",
            product_name_snapshot: "Classic Tee",
            variant_name_snapshot: "Black / M",
            sku_snapshot: "TEE-BM",
            unit_price_minor: 50000,
            quantity: 2,
            line_total_minor: 100000,
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [
          {
            house_no: "12",
            street: "St 240",
            sangkat: "Boeng Keng Kang",
            khan: "Chamkarmon",
            city: "Phnom Penh",
            province: null,
            country: "KH",
            landmark: null,
            is_default: true,
          },
        ],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        order_payment_totals: totalsRow({ received_minor: 30000 }),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
    expect(data.merchant.businessName).toBe("Dara Shop");
    // No order snapshot on this order → NO recipient field is inferred from the
    // mutable customer profile (§13, migration 047): name, phone and address are
    // all null and the destination is unconfirmed.
    expect(data.customer.name).toBeNull();
    expect(data.customer.phone).toBeNull();
    expect(data.customer.address).toBeNull();
    expect(data.customer.addressConfirmed).toBe(false);
    expect(data.order.itemCount).toBe(2);
    expect(data.reprint).toBe(false);
    // §18: outstanding = 100,000 - 30,000 net = 70,000.
    expect(data.payment.paid).toBe(false);
    expect(data.payment.collect).toEqual({ amount: 70000, currency: "KHR" });
    // Only name/phone/address(+flag) — no email/notes fields exist on the shape.
    expect(Object.keys(data.customer).sort()).toEqual([
      "address",
      "addressConfirmed",
      "name",
      "phone",
    ]);
  });

  it("uses the ORDER shipping snapshot as the destination, never the customer default (§13, §16)", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        // The order carries its own confirmed destination snapshot…
        orders: orderRow({
          shipping_name: "Mother",
          shipping_phone: "0987654321",
          shipping_address: "Snapshot House, Siem Reap",
        }),
        order_items: [],
        // …and the customer contact/default is DIFFERENT. It must not leak in.
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [
          {
            house_no: "12",
            street: "St 240",
            sangkat: "Boeng Keng Kang",
            khan: "Chamkarmon",
            city: "Phnom Penh",
            province: null,
            country: "KH",
            landmark: null,
            is_default: true,
          },
        ],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        order_payment_totals: totalsRow({ received_minor: 0 }),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
    // Destination is the order snapshot — name, phone AND address — and it is
    // confirmed. The customer's own name/phone/default address never appear.
    expect(data.customer.name).toBe("Mother");
    expect(data.customer.phone).toBe("0987654321");
    expect(data.customer.address).toBe("Snapshot House, Siem Reap");
    expect(data.customer.addressConfirmed).toBe(true);
    expect(data.customer.address).not.toContain("Boeng Keng Kang");
  });

  it("marks a processing order's label as a REPRINT (§19)", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow({ fulfillment_status: "processing" }),
        order_items: [],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        order_payment_totals: totalsRow(),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
    expect(data.reprint).toBe(true);
  });

  it("shows PAID with nothing to collect for a fully settled order", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow({ total_minor: 100000, payment_status: "paid" }),
        order_items: [],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        order_payment_totals: totalsRow({ received_minor: 100000, payment_status: "paid" }),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
    expect(data.payment.paid).toBe(true);
    expect(data.payment.collect).toBeNull();
  });

  it("a refunded order prints CHECK PAYMENT — never a COD amount for refunded money", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    const data = await withDb(
      {
        orders: orderRow({ total_minor: 100000, payment_status: "paid" }),
        order_items: [],
        customers: { display_name: "Sokha", primary_phone: "012345678" },
        customer_addresses: [],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        // Paid 100,000 then refunded 30,000 → net 70,000 → outstanding 30,000.
        order_payment_totals: totalsRow({
          received_minor: 100000,
          refunded_minor: 30000,
          payment_status: "paid",
          refund_status: "partial",
        }),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
    // Previously this printed "collect 30,000": the courier would have collected
    // money the shop had just refunded. A refund makes the label CHECK PAYMENT.
    expect(data.payment.paid).toBe(false);
    expect(data.payment.state).toBe("check");
    expect(data.payment.checkReason).toBe("refunded");
    expect(data.payment.collect).toBeNull();
  });

  it("refuses draft / cancelled / completed orders (§19)", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    for (const [status, pattern] of [
      ["draft", /confirmed order/i],
      ["cancelled", /confirmed order/i],
      ["completed", /completed/i],
    ] as const) {
      await withDb(
        { orders: orderRow({ lifecycle_status: status }), order_payment_totals: totalsRow() },
        async () => {
          await expect(getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID)).rejects.toThrow(pattern);
        },
      );
    }
  });

  it("refuses an order whose delivery was cancelled (§19)", async () => {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    await withDb(
      {
        orders: orderRow({ fulfillment_status: "cancelled" }),
        order_payment_totals: totalsRow(),
      },
      async () => {
        await expect(getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID)).rejects.toThrow(/void/i);
      },
    );
  });
});

// ── COD outstanding balance, both currencies (§18) ──────────────────────────────

describe("COD outstanding balance", () => {
  async function collectFor(
    tableOverrides: Record<string, unknown>,
    orderOverrides: Record<string, unknown>,
  ) {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    return withDb(
      {
        orders: orderRow(orderOverrides),
        order_items: [],
        customers: { display_name: "Sokha", primary_phone: "012" },
        customer_addresses: [],
        organizations: { display_name: "Dara Shop" },
        deliveries: [],
        order_payment_totals: totalsRow(tableOverrides),
      },
      () => getParcelLabelData(makeCtx(PRINT_PERMS), ORDER_ID),
    );
  }

  it("KHR: total 100000, settled 30000 → collect 70000", async () => {
    const data = await collectFor(
      { currency: "KHR", total_minor: 100000, received_minor: 30000 },
      { currency: "KHR", total_minor: 100000 },
    );
    expect(data.payment.collect).toEqual({ amount: 70000, currency: "KHR" });
  });

  it("USD: total 2000, settled 500 → collect 1500", async () => {
    const data = await collectFor(
      { currency: "USD", total_minor: 2000, received_minor: 500 },
      { currency: "USD", total_minor: 2000 },
    );
    expect(data.payment.collect).toEqual({ amount: 1500, currency: "USD" });
  });

  it("over-settlement never yields a negative collect (clamps to PAID)", async () => {
    const data = await collectFor(
      { currency: "USD", total_minor: 2000, received_minor: 2500 },
      { currency: "USD", total_minor: 2000 },
    );
    expect(data.payment.paid).toBe(true);
    expect(data.payment.collect).toBeNull();
  });
});
