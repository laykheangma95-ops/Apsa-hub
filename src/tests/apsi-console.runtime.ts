/**
 * Apsi FIND-layer behaviour, against a stand-in domain layer.
 *
 * Spawned as its own bun process by apsi-console.test.ts: it replaces
 * `@/lib/api` and `@/lib/inventory` with recording doubles, which must not
 * leak into the shared module cache of the rest of the suite.
 *
 * The doubles behave the way the real boundary behaves, and that is the point
 * of the whole file: they record every call, so a test can assert that a
 * request for data the member may not see was NEVER ISSUED — not merely that
 * its result was hidden afterwards.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { UiPermissionKey } from "@/lib/capabilities";

const calls: string[] = [];

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERY_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const VARIANT_ID = "55555555-5555-4555-8555-555555555555";
const CUSTOMER_ID_2 = "66666666-6666-4666-8666-666666666666";

/** The merchant-facing order code, in the format allocate_order_number emits. */
const ORDER_CODE = "APSA-2026-000123";
const CUSTOMER_NAME = "Sokha";
const CUSTOMER_PHONE = "012 345 678";

/**
 * A single token that every double answers with "nothing", so a lookup can
 * reach its domains, be answered, and still find no record — the one state in
 * which the console is entitled to say nothing matched.
 */
const NO_MATCH_QUERY = "NOMATCH-XYZ";

const usd = (minor: number) => ({ amountMinor: minor, currency: "USD" as const });

mock.module("@/lib/api", () => ({
  getRealOrderDetail: async (id: string) => {
    calls.push(`order:${id}`);
    if (id !== ORDER_ID) throw new Error("not found");
    return {
      order: {
        id: ORDER_ID,
        code: "APSA-1042",
        total: usd(1980),
        lifecycleStatus: "confirmed",
        paymentStatus: "pending_payment",
        fulfillmentStatus: "packing",
      },
      items: [],
    };
  },
  getRealPaymentDetail: async (id: string) => {
    calls.push(`payment:${id}`);
    if (id !== PAYMENT_ID) throw new Error("not found");
    return {
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: usd(1980),
      status: "pending",
      verificationState: "unverified",
    };
  },
  getRealDeliveryDetail: async (id: string) => {
    calls.push(`delivery:${id}`);
    if (id !== DELIVERY_ID) throw new Error("not found");
    return {
      id: DELIVERY_ID,
      orderId: ORDER_ID,
      status: "in_transit",
      providerName: "J&T",
      externalTrackingNumber: "JT-9001",
    };
  },
  getCustomer360: async (id: string) => {
    calls.push(`customer:${id}`);
    if (id !== CUSTOMER_ID) throw new Error("not found");
    return {
      customer: {
        id: CUSTOMER_ID,
        nameKm: "សុខា",
        nameEn: "Sokha",
        // What the SERVER sends a caller without customers.view_sensitive.
        phone: "",
        sensitiveVisible: false,
        orderCount: 9,
        lastPurchaseAt: "2026-09-01T00:00:00.000Z",
      },
      orders: [],
      events: [],
      notes: [],
      activeConversationId: null,
    };
  },
  lookupProductByBarcode: async (barcode: string) => {
    calls.push(`barcode:${barcode}`);
    if (barcode !== "8850007123456") return null;
    return {
      id: "prod-1",
      variantId: VARIANT_ID,
      nameKm: "កូកា ៣៣០ម.ល",
      nameEn: "Coca-Cola 330ml",
      sku: "SKU-COKE-330",
      barcode: "8850007123456",
      price: usd(75),
      stock: null,
    };
  },
  lookupProductBySku: async (sku: string) => {
    calls.push(`sku:${sku}`);
    return null;
  },
  lookupRealOrderByCode: async (code: string) => {
    calls.push(`order-by-code:${code}`);
    if (code !== ORDER_CODE) return null;
    return {
      id: ORDER_ID,
      code: ORDER_CODE,
      total: usd(1980),
      lifecycleStatus: "confirmed",
      paymentStatus: "pending_payment",
      fulfillmentStatus: "packing",
    };
  },
  searchRealCustomers: async (query: string, canViewSensitive: boolean) => {
    calls.push(`customer-search:${query}:${canViewSensitive}`);
    const empty = {
      customers: [],
      field: null,
      hasMore: false,
      truncated: false,
      phoneSearchDenied: false,
      limit: 5,
      offset: 0,
    };
    if (query === CUSTOMER_PHONE) {
      return {
        ...empty,
        field: "phone",
        customers: [
          {
            id: CUSTOMER_ID,
            nameKm: "សុខា",
            nameEn: "Sokha",
            phone: CUSTOMER_PHONE,
            sensitiveVisible: true,
          },
        ],
      };
    }
    if (query === CUSTOMER_NAME) {
      // TWO customers share this name. Apsi must show both rather than pick.
      return {
        ...empty,
        field: "name",
        // The server held more than it returned — the console must say so.
        hasMore: true,
        customers: [
          {
            id: CUSTOMER_ID,
            nameKm: "សុខា",
            nameEn: "Sokha",
            // What the SERVER sends a caller without customers.view_sensitive.
            phone: "",
            sensitiveVisible: false,
          },
          {
            id: CUSTOMER_ID_2,
            nameKm: "សុខា",
            nameEn: "Sokha",
            phone: "",
            sensitiveVisible: false,
          },
        ],
      };
    }
    return empty;
  },
  listRealDeliveries: async (options: { search?: string }) => {
    calls.push(`delivery-search:${options.search}`);
    // A real search that genuinely matches nothing — the case where the
    // console HAS looked and may honestly say so.
    if (options.search === NO_MATCH_QUERY) {
      return { items: [], hasMore: false, truncated: false };
    }
    return {
      items: [
        {
          id: DELIVERY_ID,
          orderId: ORDER_ID,
          orderCode: "APSA-1042",
          status: "in_transit",
          providerName: "J&T",
          externalTrackingNumber: "JT-9001",
          customerName: "Sokha",
        },
      ],
      hasMore: false,
      truncated: false,
    };
  },
}));

mock.module("@/lib/inventory", () => ({
  getVariantStock: async (variantId: string) => {
    calls.push(`stock:${variantId}`);
    return { variantId, productId: "prod-1", quantityOnHand: 14, byLocation: [] };
  },
}));

const { classifyApsiQuery } = await import("@/lib/apsi/input");
const { planApsiLookup, runApsiLookup, APSI_PROBE_PERMISSIONS } = await import("@/lib/apsi/lookup");

function grantsFor(keys: readonly UiPermissionKey[]) {
  const set = new Set<string>(keys);
  return { can: (key: UiPermissionKey) => set.has(key) };
}

const ALL: readonly UiPermissionKey[] = [
  "orders.read",
  "payments.read",
  "delivery.read",
  "customers.read",
  "customers.view_sensitive",
  "products.read",
  "inventory.read",
];

afterEach(() => {
  calls.length = 0;
});

describe("Apsi FIND — deterministic lookup", () => {
  it("routes a pasted order id straight to the Order domain", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(ORDER_ID), grantsFor(ALL));

    const order = outcome.results.find((r) => r.kind === "order");
    expect(order).toBeDefined();
    expect(order).toMatchObject({ id: ORDER_ID, code: "APSA-1042" });
    expect(calls).toContain(`order:${ORDER_ID}`);
  });

  it("finds a delivery by tracking number through the real server-side search", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor(ALL));

    expect(calls).toContain("delivery-search:JT-9001");
    expect(outcome.results.some((r) => r.kind === "delivery" && r.id === DELIVERY_ID)).toBe(true);
  });

  it("looks a barcode up exactly, and asks Inventory for the balance separately", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("8850007123456"), grantsFor(ALL));

    const product = outcome.results.find((r) => r.kind === "product");
    expect(product).toMatchObject({ sku: "SKU-COKE-330", stock: 14 });
    expect(calls).toContain("barcode:8850007123456");
    expect(calls).toContain(`stock:${VARIANT_ID}`);
  });

  it("never asks Inventory for stock without inventory.read, and never guesses it", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery("8850007123456"),
      grantsFor(["products.read"]),
    );

    const product = outcome.results.find((r) => r.kind === "product");
    // null is "not checked", never 0. A guessed zero would read as out of stock.
    expect(product).toMatchObject({ stock: null });
    expect(calls.some((call) => call.startsWith("stock:"))).toBe(false);
  });

  it("reports a failed probe as a failure, never as 'nothing found'", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const outcome = await runApsiLookup(classifyApsiQuery(missing), grantsFor(ALL));

    expect(outcome.results).toEqual([]);
    expect(outcome.failed.length).toBeGreaterThan(0);
  });

  it("returns one card when a barcode and a SKU probe resolve to the same product", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("8850007123456"), grantsFor(ALL));
    const products = outcome.results.filter((r) => r.kind === "product");
    expect(products).toHaveLength(1);
  });
});

describe("Apsi FIND — order code reaches the Orders domain", () => {
  /*
   * The headline gap this phase closes. Before it, "APSA-2026-000123" reached
   * an order only if that order happened to have a delivery row, because the
   * Delivery list's free-text search was the only free-text search APSA had.
   * An order created at the counter and never shipped was unfindable by the
   * reference printed on its own receipt, and the console said "nothing
   * matched" — which a staff member repeats as "we have no record of it".
   */
  it("looks an order code up in Orders, not through the Delivery search", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(ORDER_CODE), grantsFor(ALL));

    expect(calls).toContain(`order-by-code:${ORDER_CODE}`);
    // Behavioural, not source-text: no delivery request was made at all.
    expect(calls.some((call) => call.startsWith("delivery"))).toBe(false);
    expect(calls.some((call) => call.startsWith("sku:"))).toBe(false);

    const order = outcome.results.find((r) => r.kind === "order");
    expect(order).toMatchObject({ id: ORDER_ID, code: ORDER_CODE });
  });

  it("routes the card to the REAL production order id", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(ORDER_CODE), grantsFor(ALL));
    const order = outcome.results.find((r) => r.kind === "order")!;

    const { apsiResultRoute } = await import("@/lib/apsi/lookup");
    // The id, never the code: the code is a human reference and routes nowhere.
    expect(apsiResultRoute(order)).toEqual({ to: "/app/orders/$id", id: ORDER_ID });
  });

  it("normalizes case and stray whitespace into one lookup", async () => {
    await runApsiLookup(classifyApsiQuery("  apsa-2026-000123 "), grantsFor(ALL));
    expect(calls).toContain(`order-by-code:${ORDER_CODE}`);
  });

  it("reports a code that matches nothing as answered-and-empty, never as a failure", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("APSA-2026-999999"), grantsFor(ALL));

    expect(calls).toContain("order-by-code:APSA-2026-999999");
    expect(outcome.answered).toBe(true);
    expect(outcome.results).toEqual([]);
    // A real "no order carries this code" — not an error dressed as an answer.
    expect(outcome.failed).toEqual([]);
  });

  it("issues no Order request at all for a member without orders.read", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery(ORDER_CODE),
      grantsFor(["delivery.read", "customers.read"]),
    );

    expect(calls).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.skipped.map((s) => s.permission)).toEqual(["orders.read"]);
  });
});

describe("Apsi FIND — customer search reaches the Customers domain", () => {
  it("sends a name to the Customer search and returns EVERY match", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(CUSTOMER_NAME), grantsFor(ALL));

    expect(calls.some((call) => call.startsWith(`customer-search:${CUSTOMER_NAME}`))).toBe(true);

    // Two customers share this name. Apsi shows both — silently picking one is
    // how a staff member ends up telling the wrong person about an order.
    const customers = outcome.results.filter((r) => r.kind === "customer");
    expect(customers).toHaveLength(2);
    expect(new Set(customers.map((c) => c.id))).toEqual(new Set([CUSTOMER_ID, CUSTOMER_ID_2]));
  });

  it("carries the server's 'there are more' answer through, never presenting a page as the set", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(CUSTOMER_NAME), grantsFor(ALL));
    expect(outcome.incomplete).toBe(true);
  });

  it("reports no order history rather than inventing a zero", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(CUSTOMER_NAME), grantsFor(ALL));
    const customer = outcome.results.find((r) => r.kind === "customer")!;
    // null is "not asked". 0 would read to a merchant as "never bought anything".
    expect(customer).toMatchObject({ orderCount: null, lastPurchaseAt: null });
  });

  it("passes a withheld phone through untouched, and never reconstructs one", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(CUSTOMER_NAME), grantsFor(ALL));
    const customer = outcome.results.find((r) => r.kind === "customer")!;
    expect(customer).toMatchObject({ phone: "", sensitiveVisible: false });
  });

  it("finds a customer by phone when BOTH grants hold", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(CUSTOMER_PHONE), grantsFor(ALL));

    expect(calls.some((call) => call.startsWith("customer-search:"))).toBe(true);
    expect(outcome.results.some((r) => r.kind === "customer" && r.id === CUSTOMER_ID)).toBe(true);
  });
});

describe("Apsi permission model — withheld before the request, not after", () => {
  /*
   * THE LAUNCH-CRITICAL PROBE, asserted behaviourally.
   *
   * A member with customers.read but not customers.view_sensitive must not be
   * able to use Apsi as a phone-number existence oracle. The recording double
   * is what makes this a real proof: it records every call, so this asserts
   * that NO REQUEST CARRYING THE NUMBER WAS EVER MADE — not merely that the
   * digits were blanked on the card afterwards. Masking the result would leave
   * "which customers came back" answering the question the grant gates.
   */
  it("never issues a customer phone search without customers.view_sensitive", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery(CUSTOMER_PHONE),
      grantsFor(["customers.read", "orders.read", "delivery.read", "products.read"]),
    );

    expect(calls).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped.map((s) => s.permission)).toEqual(["customers.view_sensitive"]);

    // And the console cannot claim absence from that silence.
    const nothingFound =
      outcome.answered && outcome.results.length === 0 && outcome.failed.length === 0;
    expect(nothingFound).toBe(false);
  });

  /*
   * REVOCATION, end to end. The same typed number, the same principal, before
   * and after the grant is withdrawn. The second lookup must issue nothing —
   * and because the cache key carries the grant (apsiKeys.lookup), the first
   * lookup's answer is not at the address the second one reads either.
   */
  it("stops issuing the phone search the moment the grant is revoked", async () => {
    const plan = classifyApsiQuery(CUSTOMER_PHONE);

    const granted = await runApsiLookup(plan, grantsFor(ALL));
    expect(granted.results.length).toBeGreaterThan(0);
    const callsWhileGranted = [...calls];
    expect(callsWhileGranted.some((call) => call.startsWith("customer-search:"))).toBe(true);

    calls.length = 0;

    const revoked = await runApsiLookup(plan, grantsFor(["customers.read"]));
    expect(calls).toEqual([]);
    expect(revoked.results).toEqual([]);
    expect(revoked.answered).toBe(false);

    const { apsiKeys } = await import("@/lib/apsi-query");
    expect(apsiKeys.lookup("u", "o", plan.normalized, true)).not.toEqual(
      apsiKeys.lookup("u", "o", plan.normalized, false),
    );
  });

  it("never issues a customer search of any kind without customers.read", async () => {
    await runApsiLookup(classifyApsiQuery(CUSTOMER_NAME), grantsFor(["delivery.read"]));
    expect(calls.some((call) => call.startsWith("customer-search:"))).toBe(false);
  });

  it("never issues a Payment read for a member without payments.read", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(PAYMENT_ID), grantsFor(["orders.read"]));

    expect(calls.some((call) => call.startsWith("payment:"))).toBe(false);
    expect(outcome.results.some((r) => r.kind === "payment")).toBe(false);
    expect(outcome.skipped.map((s) => s.permission)).toContain("payments.read");
  });

  it("never issues a Customer read for a member without customers.read", async () => {
    await runApsiLookup(classifyApsiQuery(CUSTOMER_ID), grantsFor(["orders.read"]));

    expect(calls.some((call) => call.startsWith("customer:"))).toBe(false);
  });

  it("never issues a Delivery read or search for a member without delivery.read", async () => {
    await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor(["products.read"]));

    expect(calls.some((call) => call.startsWith("delivery"))).toBe(false);
  });

  it("never issues an Order read for a member without orders.read", async () => {
    await runApsiLookup(classifyApsiQuery(ORDER_ID), grantsFor(["payments.read"]));

    expect(calls.some((call) => call.startsWith("order:"))).toBe(false);
  });

  it("passes the server's withheld customer phone through untouched", async () => {
    const outcome = await runApsiLookup(
      classifyApsiQuery(CUSTOMER_ID),
      grantsFor(["customers.read"]),
    );

    const customer = outcome.results.find((r) => r.kind === "customer");
    expect(customer).toMatchObject({ phone: "", sensitiveVisible: false });
  });

  it("issues nothing at all for a member with no supported access", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery("JT-9001"), grantsFor([]));

    expect(calls).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.skipped.length).toBeGreaterThan(0);
  });

  /*
   * The console may only say "nothing matched" when a domain actually
   * answered. `answered` is the flag it gates that sentence on, so the two
   * tests below fix its meaning behaviourally, against the recording doubles:
   * silence caused by permissions is never an answer, and a real empty result
   * always is.
   *
   * Before this guard existed, a member with no grants pasted a tracking
   * number, the console issued NOTHING, and the screen still told them the
   * record did not match — a negative existence claim built from a request
   * that was never made.
   */
  it("does not count a fully withheld lookup as answered, so nothing-found cannot render", async () => {
    const plan = classifyApsiQuery("JT-9001");
    // The input really does produce candidate probes; they are all withheld.
    expect(plan.probes.length).toBeGreaterThan(0);

    const outcome = await runApsiLookup(plan, grantsFor([]));

    // Behavioural, not source-text: the domain layer recorded no request.
    expect(calls).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.failed).toEqual([]);
    // What the member is owed instead: the withheld set, one entry per probe.
    expect(outcome.skipped.map((probe) => probe.kind).sort()).toEqual(
      [...plan.probes.map((probe) => probe.kind)].sort(),
    );

    // The exact condition ApsiConsoleSheet renders apsi.noResults behind.
    const nothingFound =
      outcome.answered && outcome.results.length === 0 && outcome.failed.length === 0;
    expect(nothingFound).toBe(false);
  });

  it("counts a real empty answer as answered, so nothing-found still renders", async () => {
    const outcome = await runApsiLookup(classifyApsiQuery(NO_MATCH_QUERY), grantsFor(ALL));

    // The requests were genuinely issued and genuinely came back empty.
    expect(calls).toContain(`delivery-search:${NO_MATCH_QUERY}`);
    expect(outcome.answered).toBe(true);
    expect(outcome.results).toEqual([]);
    expect(outcome.failed).toEqual([]);

    const nothingFound =
      outcome.answered && outcome.results.length === 0 && outcome.failed.length === 0;
    expect(nothingFound).toBe(true);
  });

  it("declares a permission for every probe the classifier can emit", () => {
    const plans = [ORDER_ID, ORDER_CODE, CUSTOMER_NAME, CUSTOMER_PHONE, "JT-9001"].map(
      classifyApsiQuery,
    );
    for (const plan of plans) {
      expect(plan.probes.length).toBeGreaterThan(0);
      for (const probe of plan.probes) {
        expect({
          kind: probe.kind,
          keys: (APSI_PROBE_PERMISSIONS[probe.kind] ?? []).length,
        }).toEqual({ kind: probe.kind, keys: expect.any(Number) });
        expect(APSI_PROBE_PERMISSIONS[probe.kind]!.length).toBeGreaterThan(0);
      }
      expect(planApsiLookup(plan, grantsFor([])).runnable).toEqual([]);
    }
  });
});
