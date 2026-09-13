/**
 * Apsi's search: what it finds, and what it must never invent.
 *
 * The rule these tests defend is the one that makes Apsi trustworthy — it
 * routes to records that exist and does nothing else. A result that cannot be
 * opened, a suggestion built from a placeholder, or a match on a value the
 * server deliberately withheld would each be worse than no Apsi at all.
 *
 * Run: bun test src/tests/apsi-search.test.ts
 */
import { describe, expect, it } from "bun:test";
import {
  matchCommands,
  runApsiSearch,
  searchCustomerRecords,
  searchOrders,
  searchPayments,
  searchProducts,
  type ApsiCommand,
} from "@/lib/apsi-search";
import { usd } from "@/lib/money";
import type { Customer, Order, Product } from "@/types";
import type { UiPayment } from "@/lib/payments";

const order = (over: Partial<Order> = {}): Order => ({
  id: "ord-1",
  code: "#1052",
  customerId: null,
  channel: "facebook",
  items: [],
  subtotal: usd(0),
  discount: usd(0),
  deliveryFee: usd(0),
  total: usd(1200),
  paymentStatus: "unpaid",
  fulfillmentStatus: "unfulfilled",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const customer = (over: Partial<Customer> = {}): Customer => ({
  id: "cus-1",
  nameKm: "សុខា",
  nameEn: "Sokha",
  phone: "012 345 678",
  identities: [],
  tags: [],
  orderCount: 0,
  lifetimeSpend: usd(0),
  ...over,
});

const product = (over: Partial<Product> = {}): Product => ({
  id: "prd-1",
  nameKm: "អាវ",
  nameEn: "Shirt",
  sku: "SH-001",
  price: usd(900),
  stock: null,
  lowStockThreshold: 3,
  companion: "nilo",
  ...over,
});

const payment = (over: Partial<UiPayment> = {}): UiPayment => ({
  id: "pay-11111111",
  orderId: "ord-1",
  method: "aba",
  amount: usd(1200),
  status: "paid",
  verificationState: "unverified",
  reference: "ABA-77",
  note: null,
  recordedBy: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("finding an order", () => {
  it("matches the code with or without the # a merchant types", () => {
    const orders = [order()];
    expect(searchOrders(orders, "1052")).toHaveLength(1);
    expect(searchOrders(orders, "#1052")).toHaveLength(1);
    expect(searchOrders(orders, "105")).toHaveLength(1);
    expect(searchOrders(orders, "9999")).toHaveLength(0);
  });

  it("routes to the order that exists, and carries its real statuses", () => {
    const [hit] = searchOrders([order({ lifecycleStatus: "confirmed" })], "1052");
    expect(hit!.href).toBe("/app/orders/ord-1");
    expect(hit!.statuses).toEqual(["confirmed", "unpaid"]);
  });

  it("answers an empty query with nothing rather than everything", () => {
    expect(searchOrders([order()], "   ")).toEqual([]);
  });
});

describe("finding a customer", () => {
  it("matches either script and the phone number", () => {
    const customers = [customer()];
    expect(searchCustomerRecords(customers, "sokha")).toHaveLength(1);
    expect(searchCustomerRecords(customers, "សុខា")).toHaveLength(1);
    expect(searchCustomerRecords(customers, "345")).toHaveLength(1);
    expect(searchCustomerRecords(customers, "012345678")).toHaveLength(1);
  });

  it("does not treat one or two stray digits as a phone match", () => {
    expect(searchCustomerRecords([customer()], "01")).toHaveLength(0);
  });

  it("routes to Customer 360", () => {
    expect(searchCustomerRecords([customer()], "sokha")[0]!.href).toBe("/app/customers/cus-1");
  });
});

describe("finding a product", () => {
  it("matches name, SKU and barcode", () => {
    const products = [product({ barcode: "8850001" })];
    expect(searchProducts(products, "shirt")).toHaveLength(1);
    expect(searchProducts(products, "អាវ")).toHaveLength(1);
    expect(searchProducts(products, "sh-001")).toHaveLength(1);
    expect(searchProducts(products, "8850001")).toHaveLength(1);
    expect(searchProducts(products, "trousers")).toHaveLength(0);
  });
});

describe("finding a payment", () => {
  it("matches a reference the server actually returned", () => {
    expect(searchPayments([payment()], "aba-77")).toHaveLength(1);
  });

  it("never matches a reference the server withheld", () => {
    // `reference: null` means "you were not told this". Searching must not
    // become a way to confirm a value the server refused to disclose.
    const withheld = [payment({ reference: null })];
    expect(searchPayments(withheld, "aba-77")).toHaveLength(0);
    expect(searchPayments(withheld, "null")).toHaveLength(0);
  });
});

describe("commands", () => {
  const commands: ApsiCommand[] = [
    {
      id: "unpaid-orders",
      label: "Show unpaid orders",
      keywords: ["unpaid", "owed"],
      href: "/app/orders?payment=unpaid",
      count: 4,
    },
    {
      id: "low-stock",
      label: "Low stock items",
      keywords: ["stock"],
      href: "/app/products",
    },
  ];

  it("matches on the label or on a localized keyword", () => {
    expect(matchCommands(commands, "unpaid").map((c) => c.id)).toEqual(["unpaid-orders"]);
    expect(matchCommands(commands, "owed").map((c) => c.id)).toEqual(["unpaid-orders"]);
    expect(matchCommands(commands, "Low stock").map((c) => c.id)).toEqual(["low-stock"]);
    expect(matchCommands(commands, "")).toEqual([]);
  });

  it("puts whole commands above individual records", () => {
    const results = runApsiSearch({
      query: "unpaid",
      commands,
      orders: [],
      customers: [],
      products: [],
      payments: [],
    });
    expect(results.commands.map((c) => c.id)).toEqual(["unpaid-orders"]);
    expect(results.entities).toEqual([]);
  });

  it("returns nothing at all when nothing matches — never a consolation result", () => {
    const results = runApsiSearch({
      query: "zzzzz",
      commands,
      orders: [order()],
      customers: [customer()],
      products: [product()],
      payments: [payment()],
    });
    expect(results.commands).toEqual([]);
    expect(results.entities).toEqual([]);
  });

  it("caps each kind so one chatty domain cannot bury the rest", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      order({ id: `ord-${index}`, code: `#20${index}` }),
    );
    const results = runApsiSearch({
      query: "20",
      commands: [],
      orders: many,
      customers: [customer({ nameEn: "20th Street Shop" })],
      products: [],
      payments: [],
      perKindLimit: 5,
    });
    expect(results.entities.filter((entity) => entity.kind === "order")).toHaveLength(5);
    expect(results.entities.filter((entity) => entity.kind === "customer")).toHaveLength(1);
  });
});
