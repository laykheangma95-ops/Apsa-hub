/**
 * Orders → New Order (CreateRealOrderSheet) money — MOUNTED, through REAL SQL.
 *
 * Mounts the real production <CreateRealOrderSheet> in happy-dom and drives it
 * the way a merchant does. Between the sheet and PostgreSQL nothing is faked
 * except the transport:
 *
 *   catalog  getProducts (src/lib/api, real mapServerProductToUi)
 *            → listProductsFn → products service getProductCatalog → PGlite
 *   create   createRealOrder (src/lib/api, real idempotency key + fingerprint)
 *            → createOrderFn → orders service createOrder → create_order_v3
 *            → PGlite with every migration applied
 *
 * So every submitting case reads three figures and requires them to agree to
 * the minor unit: the total the sheet DISPLAYS, the request it SENDS, and the
 * order row the database PERSISTS — in the currency the catalog priced it in.
 *
 * Replaced, and only these: the two server-function modules (createServerFn
 * cannot run in a unit process, so their handlers are re-stated as the same
 * service calls under a fixed authorization context), the Supabase admin
 * client (an SQL transport onto PGlite), and the customer-picker reads.
 *
 * Runs in its own process (orders-new-order-money-mounted.test.ts): it installs
 * DOM globals and module mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "../server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";

type Json = Record<string, any>;

// ── Database: every migration, created before any DOM global exists ─────────

const f = await financialFixture();

/** The fixture's own organizations default to USD. */
const ORG_USD = f.org;
const ORG_KHR = "cccccccc-0000-4000-8000-0000000000c1";
await f.db.query(
  `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
   values($1,'Riel shop','Riel shop','riel-shop',$2,'KHR')`,
  [ORG_KHR, f.actor],
);

interface Seeded {
  product: string;
  variants: string[];
}

/** One product and its ACTIVE variants, listed in the order given. */
async function seedProduct(
  org: string,
  nameEn: string,
  variants: { name: string; price: number; currency: "USD" | "KHR" }[],
): Promise<Seeded> {
  const product = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    `${nameEn}-km`,
    nameEn,
  ]);
  const ids: string[] = [];
  for (const [i, v] of variants.entries()) {
    const id = crypto.randomUUID();
    await f.db.query(
      `insert into product_variants
         (id,organization_id,product_id,sku,name,price_amount,price_currency,created_at)
       values($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
      [id, org, product, `${nameEn}-${i}`, v.name, v.price, v.currency, i],
    );
    ids.push(id);
  }
  return { product, variants: ids };
}

// Riel organization.
const WATER = await seedProduct(ORG_KHR, "Water", [{ name: "", price: 5000, currency: "KHR" }]);
const SOAP = await seedProduct(ORG_KHR, "Soap", [{ name: "", price: 3000, currency: "KHR" }]);
const SHIRT = await seedProduct(ORG_KHR, "Shirt", [
  { name: "Small", price: 5000, currency: "KHR" },
  { name: "Large", price: 7000, currency: "KHR" },
]);
// One product whose variants are priced in different currencies. The catalog
// allows it; an order in this organization can only ever use the riel one.
const DUAL = await seedProduct(ORG_KHR, "Dual", [
  { name: "Local", price: 5000, currency: "KHR" },
  { name: "Imported", price: 300, currency: "USD" },
]);
// Dollar organization.
const SERUM = await seedProduct(ORG_USD, "Serum", [{ name: "", price: 2000, currency: "USD" }]);
const TONER = await seedProduct(ORG_USD, "Toner", [{ name: "", price: 1500, currency: "USD" }]);

// ── Authorization context: the one the server would derive for this member ──

let activeOrg = ORG_KHR;
const SERVER_PERMISSIONS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.apply_discount",
];

function context(): AuthorizationContext {
  return {
    organizationId: activeOrg,
    userId: f.actor,
    can: (key: string) => SERVER_PERMISSIONS.includes(key),
    require: (key: string) => {
      if (!SERVER_PERMISSIONS.includes(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 });
      }
    },
  } as unknown as AuthorizationContext;
}

// ── Supabase admin client → PGlite ───────────────────────────────────────────

function sqlTransport() {
  const identifier = (value: string) => {
    if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
    return value;
  };
  function select(table: string) {
    const where: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let single = false;
    let max: number | undefined;
    const chain = {
      select(cols = "*") {
        columns = cols;
        return chain;
      },
      eq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} = $${values.length}`);
        return chain;
      },
      in(key: string, list: unknown[]) {
        const params = list.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        where.push(list.length ? `${identifier(key)} in (${params.join(",")})` : "false");
        return chain;
      },
      order(key: string, options: { ascending: boolean }) {
        ordering.push(`${identifier(key)} ${options.ascending ? "asc" : "desc"}`);
        return chain;
      },
      limit(n: number) {
        max = n;
        return chain;
      },
      single() {
        single = true;
        return chain;
      },
      maybeSingle() {
        single = true;
        return chain;
      },
      async execute() {
        let sql = `select ${columns} from ${table}`;
        if (where.length) sql += ` where ${where.join(" and ")}`;
        if (ordering.length) sql += ` order by ${ordering.join(",")}`;
        if (max !== undefined) sql += ` limit ${max}`;
        try {
          const rows = JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows));
          if (single) {
            return rows.length
              ? { data: rows[0], error: null }
              : { data: null, error: { code: "PGRST116" } };
          }
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
        return chain.execute().then(ok, fail);
      },
    };
    return chain;
  }
  return {
    from(table: string) {
      if (table === "audit_logs") {
        return { insert: async () => ({ error: null }) };
      }
      return select(identifier(table));
    },
    async rpc(name: string, input: Record<string, unknown>) {
      const entries = Object.entries(input);
      const sql = `select ${identifier(name)}(${entries
        .map(([key], i) => `${identifier(key)} => $${i + 1}`)
        .join(",")}) as result`;
      const values = entries.map(([, value]) =>
        value !== null && typeof value === "object" ? JSON.stringify(value) : value,
      );
      try {
        const result = await f.db.query<{ result: unknown }>(sql, values);
        return { data: result.rows[0]!.result, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: sqlTransport() }));

// ── Server functions: the same service calls their handlers make ─────────────

/** Every create request exactly as the browser sent it. */
const sent: Json[] = [];
/** When set, the next create COMMITS but its response never reaches the browser. */
let loseNextResponse = false;

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    sent.push(JSON.parse(JSON.stringify(data)));
    const { createOrder } = await import("@/server/orders/service");
    // src/api/orders.ts createOrderFn's handler, field for field.
    const detail = await createOrder(context(), {
      source: data.source,
      items: data.items.map((line: Json) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        productId: line.productId,
      })),
      customerId: data.customerId ?? null,
      locationId: data.locationId ?? null,
      discountMinor: data.discountMinor,
      sourceConversationRef: data.sourceConversationRef ?? null,
      deliveryMinor: data.deliveryMinor,
      idempotencyKey: data.idempotencyKey,
      ...(data.shipping ? { shipping: data.shipping } : {}),
    });
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new TypeError("Failed to fetch");
    }
    return detail;
  },
}));

mock.module("@/api/products", () => ({
  listProductsFn: async ({ data }: { data?: Json } = {}) => {
    const { getProductCatalog } = await import("@/server/products/service");
    return getProductCatalog(context(), { status: data?.status });
  },
}));

const realApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({
  ...realApi,
  listRealCustomers: async () => [],
  searchRealCustomers: async () => ({
    customers: [],
    hasMore: false,
    truncated: false,
    phoneSearchDenied: false,
  }),
}));

// ── DOM ──────────────────────────────────────────────────────────────────────

GlobalRegistrator.register({ url: "http://localhost/app/orders" });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const reducedMotionQuery = (query: string) => ({
  matches: /prefers-reduced-motion:\s*reduce/.test(query),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
(window as any).matchMedia = reducedMotionQuery;
(globalThis as any).matchMedia = reducedMotionQuery;
(window as any).HTMLElement.prototype.scrollIntoView = function () {};
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CapabilityFixtureProvider } = await import("@/hooks/use-capabilities");
const i18n = (await import("@/lib/i18n")).default;
const en = (await import("@/locales/en.json")).default as any;
const { CreateRealOrderSheet } = await import("@/components/orders/CreateRealOrderSheet");

const UI_PERMISSIONS = ["orders.create", "orders.apply_discount", "customers.read"] as const;

interface Harness {
  open: boolean;
  created: any[];
}

let h: Harness = { open: false, created: [] };
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let client: InstanceType<typeof QueryClient>;
/** Render errors no boundary caught — a crashed sheet lands here, not in a figure. */
const crashes: unknown[] = [];

function tree() {
  return React.createElement(
    QueryClientProvider,
    { client },
    React.createElement(
      CapabilityFixtureProvider,
      { permissions: UI_PERMISSIONS as any },
      React.createElement(CreateRealOrderSheet, {
        open: h.open,
        onOpenChange: (next: boolean) => {
          h.open = next;
        },
        onCreated: (order: any) => h.created.push(order),
        userId: f.actor,
        organizationId: activeOrg,
      }),
    ),
  );
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function rerender() {
  await act(async () => root!.render(tree()));
  await settle();
}

/** Open the New Order sheet as a member of `org`, with its catalog loaded. */
async function openSheet(org: string) {
  activeOrg = org;
  h = { open: true, created: [] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, {
    onUncaughtError: (error: unknown) => crashes.push(error),
  });
  await rerender();
  await settle(10);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
  client?.clear();
  sent.length = 0;
  crashes.length = 0;
  loseNextResponse = false;
});

afterAll(async () => {
  await f.close();
  await GlobalRegistrator.unregister();
});

// ── Page helpers ─────────────────────────────────────────────────────────────

const text = () => document.body.textContent ?? "";

function dialog(): HTMLElement {
  const el = document.querySelector("[role=dialog]");
  if (!el) throw new Error(`no dialog open; page: ${text().slice(0, 300)}`);
  return el as HTMLElement;
}

async function click(el: Element | null | undefined, label = "element") {
  if (!el) throw new Error(`no ${label} to click; page: ${text().slice(0, 400)}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error(`no input to type into; page: ${text().slice(0, 400)}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Tap a product in the picker by its English name (shown in Khmer by default). */
async function pickProduct(nameEn: string) {
  const row = [...dialog().querySelectorAll("button")].find((b) =>
    [nameEn, `${nameEn}-km`].includes(b.querySelector("span span")?.textContent?.trim() ?? ""),
  );
  await click(row, `product ${nameEn}`);
}

async function pickVariant(name: string) {
  const row = [...dialog().querySelectorAll("button[aria-pressed]")].find(
    (b) => b.querySelector("span span")?.textContent?.trim() === name,
  );
  await click(row, `variant ${name}`);
}

async function increaseQuantity(times: number) {
  for (let i = 0; i < times; i++) await click(button(en.common.increase), "quantity +");
}

/** The figure printed beside a label, e.g. figure("Subtotal") → "៛10,000". */
function figure(label: string): string | null {
  const labels = [...dialog().querySelectorAll("span")].filter(
    (s) => s.textContent?.trim() === label,
  );
  for (const span of labels.reverse()) {
    const cells = [...span.parentElement!.children].filter((c) => c.tagName === "SPAN");
    if (cells.length > 1 && cells.at(-1) !== span) return cells.at(-1)!.textContent!.trim();
  }
  return null;
}

const unitPrice = () => figure(en.orderCreate.unitPrice);
const subtotal = () => figure(en.orderCreate.subtotal);
const total = () => figure(en.orderCreate.total);
const discountSwitch = () =>
  [...dialog().querySelectorAll("button[role=switch]")].find(
    (b) => b.getAttribute("aria-label") === en.orderCreate.discount,
  ) as HTMLButtonElement;
const discountInput = () =>
  document.getElementById("order-create-discount") as HTMLInputElement | null;
const feeInput = () =>
  document.getElementById("order-create-delivery-fee") as HTMLInputElement | null;
const submitButton = () => button(en.orderCreate.submit) ?? button(en.orderCreate.creating);
const alerts = () => [...dialog().querySelectorAll("[role=alert]")].map((a) => a.textContent);

async function submit() {
  const control = submitButton();
  expect(control?.disabled).toBe(false);
  await click(control, "Create order");
  await settle(10);
}

/** The order row the server persisted for the request the sheet sent last. */
async function persisted(request: Json = sent.at(-1)!) {
  const order = (
    await f.db.query<Json>(
      `select id,organization_id,currency,subtotal_minor,discount_minor,delivery_minor,total_minor
       from orders where idempotency_key=$1`,
      [request.idempotencyKey],
    )
  ).rows;
  expect(order).toHaveLength(1);
  const items = (
    await f.db.query<Json>(
      `select variant_id,quantity,unit_price_minor,line_total_minor
       from order_items where order_id=$1`,
      [order[0]!.id],
    )
  ).rows;
  return { ...order[0]!, items };
}

async function orderCount(org: string): Promise<number> {
  return (
    await f.db.query<{ n: number }>(
      "select count(*)::int as n from orders where organization_id=$1",
      [org],
    )
  ).rows[0]!.n;
}

/** The money keys a create request carries — inputs only, never a price or total. */
function moneyKeys(request: Json) {
  return Object.keys(request)
    .filter((k) => /price|total|subtotal|currency|minor/i.test(k))
    .sort();
}

// ═══════════════════════════════════════════════════════════════════════════
// A/B. A riel product is priced in riel — never against a USD zero
// ═══════════════════════════════════════════════════════════════════════════

describe("A/B. KHR product: shown, sent and persisted in riel", () => {
  it("៛5,000 × 1 = ៛5,000 — no crash, no dollar figure, persisted as KHR 5,000", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    expect(crashes).toEqual([]);
    expect(unitPrice()).toBe("៛5,000");
    expect(subtotal()).toBe("៛5,000");
    expect(total()).toBe("៛5,000");
    expect(dialog().textContent).not.toContain("$");

    await submit();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.items).toEqual([
      { variantId: WATER.variants[0], quantity: 1, productId: WATER.product },
    ]);
    expect(moneyKeys(sent[0]!)).toEqual([]);
    expect(await persisted()).toMatchObject({
      organization_id: ORG_KHR,
      currency: "KHR",
      subtotal_minor: 5000,
      discount_minor: 0,
      delivery_minor: 0,
      total_minor: 5000,
    });
    expect(h.created[0]!.total).toEqual({ amount: 5000, currency: "KHR" });
  });

  it("the reproduction: ៛5,000 × 2 = ៛10,000 on screen, in the request and in the database", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(1);
    expect(crashes).toEqual([]);
    expect(subtotal()).toBe("៛10,000");
    expect(total()).toBe("៛10,000");

    await submit();
    expect(sent[0]!.items[0].quantity).toBe(2);
    const row = await persisted();
    expect(row).toMatchObject({ currency: "KHR", subtotal_minor: 10000, total_minor: 10000 });
    expect(row.items).toEqual([
      {
        variant_id: WATER.variants[0],
        quantity: 2,
        unit_price_minor: 5000,
        line_total_minor: 10000,
      },
    ]);
    // The order the sheet reports is the server's, and it agrees to the riel.
    expect(h.created[0]!.subtotal).toEqual({ amount: 10000, currency: "KHR" });
    expect(h.created[0]!.total).toEqual({ amount: 10000, currency: "KHR" });
  });

  it("៛5,000 × 5 = ៛25,000", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(4);
    expect(total()).toBe("៛25,000");
    await submit();
    expect(await persisted()).toMatchObject({ currency: "KHR", total_minor: 25000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. USD is unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("D. USD product: unchanged", () => {
  it("$20 × 1 = $20.00, persisted as 2,000 cents", async () => {
    await openSheet(ORG_USD);
    await pickProduct("Serum");
    expect(unitPrice()).toBe("$20.00");
    expect(total()).toBe("$20.00");
    expect(dialog().textContent).not.toContain("៛");
    await submit();
    expect(await persisted()).toMatchObject({
      currency: "USD",
      subtotal_minor: 2000,
      total_minor: 2000,
    });
  });

  it("$20 × 5 = $100.00, persisted as 10,000 cents", async () => {
    await openSheet(ORG_USD);
    await pickProduct("Serum");
    await increaseQuantity(4);
    expect(total()).toBe("$100.00");
    await submit();
    expect(sent[0]!.items[0].quantity).toBe(5);
    expect(await persisted()).toMatchObject({ currency: "USD", total_minor: 10000 });
  });

  it("the picker lists this organization's catalog only", async () => {
    await openSheet(ORG_USD);
    const names = text();
    expect(names).toContain("Serum");
    expect(names).not.toContain("Water");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Discount: typed and parsed in the order's own currency
// ═══════════════════════════════════════════════════════════════════════════

describe("Discount is bound to the order currency", () => {
  it("KHR: '1,000' off ៛5,000 × 2 is ៛1,000 — sent as 1,000 riel, persisted ៛9,000", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(1);
    await click(discountSwitch(), "discount switch");
    await type(discountInput(), "1,000");
    expect(crashes).toEqual([]);
    expect(figure(en.orderCreate.discount)).toBe("-៛1,000");
    expect(total()).toBe("៛9,000");
    expect(dialog().textContent).not.toContain("$");

    await submit();
    expect(sent[0]!.discountMinor).toBe(1000);
    expect(await persisted()).toMatchObject({
      currency: "KHR",
      subtotal_minor: 10000,
      discount_minor: 1000,
      total_minor: 9000,
    });
  });

  it("USD: '2.50' off $20.00 is 250 cents, persisted $17.50", async () => {
    await openSheet(ORG_USD);
    await pickProduct("Serum");
    await click(discountSwitch(), "discount switch");
    await type(discountInput(), "2.50");
    expect(figure(en.orderCreate.discount)).toBe("-$2.50");
    expect(total()).toBe("$17.50");
    await submit();
    expect(sent[0]!.discountMinor).toBe(250);
    expect(await persisted()).toMatchObject({ discount_minor: 250, total_minor: 1750 });
  });

  it("malformed amounts are refused with a reason and block submit — never coerced", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await click(discountSwitch(), "discount switch");
    // Riel has no fraction; "1,5" is not a thousands grouping; letters are not money.
    for (const typed of ["10.5", "1,5", "abc", "-500"]) {
      await type(discountInput(), typed);
      expect(discountInput()?.getAttribute("aria-invalid")).toBe("true");
      expect(alerts()).toContain(en.pos.discount.invalidKhr);
      expect(total()).toBe("៛5,000");
      expect(submitButton()?.disabled).toBe(true);
    }
    await click(submitButton());
    expect(sent).toHaveLength(0);
  });

  it("a discount above the subtotal is refused, not silently clamped to it", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await click(discountSwitch(), "discount switch");
    await type(discountInput(), "6,000");
    expect(alerts()).toContain(en.pos.discount.exceedsSubtotal);
    expect(total()).toBe("៛5,000");
    expect(submitButton()?.disabled).toBe(true);
    await click(submitButton());
    expect(sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Delivery fee: typed and parsed in the order's own currency
// ═══════════════════════════════════════════════════════════════════════════

describe("Delivery fee is bound to the order currency", () => {
  it("KHR: '2,000' on ៛5,000 × 2 makes ៛12,000 — sent as 2,000 riel and persisted", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(1);
    await type(feeInput(), "2,000");
    expect(figure(en.order.deliveryFee)).toBe("+៛2,000");
    expect(total()).toBe("៛12,000");
    await submit();
    expect(sent[0]!.deliveryMinor).toBe(2000);
    expect(await persisted()).toMatchObject({
      currency: "KHR",
      subtotal_minor: 10000,
      delivery_minor: 2000,
      total_minor: 12000,
    });
  });

  it("USD: '1.50' is 150 cents", async () => {
    await openSheet(ORG_USD);
    await pickProduct("Serum");
    await type(feeInput(), "1.50");
    expect(total()).toBe("$21.50");
    await submit();
    expect(sent[0]!.deliveryMinor).toBe(150);
    expect(await persisted()).toMatchObject({ delivery_minor: 150, total_minor: 2150 });
  });

  it("KHR: a fractional riel fee is refused and blocks submit", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await type(feeInput(), "1.50");
    expect(feeInput()?.getAttribute("aria-invalid")).toBe("true");
    expect(total()).toBe("៛5,000");
    expect(submitButton()?.disabled).toBe(true);
  });

  it("discount and fee together: ៛5,000 × 2 − ៛1,000 + ៛2,000 = ៛11,000 everywhere", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(1);
    await click(discountSwitch(), "discount switch");
    await type(discountInput(), "1000");
    await type(feeInput(), "2000");
    expect(total()).toBe("៛11,000");
    await submit();
    expect(moneyKeys(sent[0]!)).toEqual(["deliveryMinor", "discountMinor"]);
    expect(sent[0]).toMatchObject({ discountMinor: 1000, deliveryMinor: 2000 });
    expect(await persisted()).toMatchObject({
      subtotal_minor: 10000,
      discount_minor: 1000,
      delivery_minor: 2000,
      total_minor: 11000,
    });
    expect(h.created[0]!.total).toEqual({ amount: 11000, currency: "KHR" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Typed money belongs to the currency it was typed for
// ═══════════════════════════════════════════════════════════════════════════

describe("A currency change clears typed money instead of reinterpreting it", () => {
  it("$-priced variant → ៛-priced variant: the '5' discount and '1.50' fee do not become riel", async () => {
    // The DUAL product's variants are priced in different currencies, so
    // choosing the other variant changes the order currency under the same
    // product.
    await openSheet(ORG_KHR);
    await pickProduct("Dual");
    await pickVariant("Imported");
    expect(unitPrice()).toBe("$3.00");
    await click(discountSwitch(), "discount switch");
    await type(discountInput(), "1");
    await type(feeInput(), "1.50");
    expect(total()).toBe("$3.50");

    await pickVariant("Local");
    expect(crashes).toEqual([]);
    expect(unitPrice()).toBe("៛5,000");
    expect(discountSwitch().getAttribute("aria-checked")).toBe("false");
    expect(discountInput()).toBeNull();
    expect(feeInput()?.value).toBe("");
    expect(total()).toBe("៛5,000");

    await submit();
    expect(moneyKeys(sent[0]!)).toEqual([]);
    expect(await persisted()).toMatchObject({
      currency: "KHR",
      discount_minor: 0,
      delivery_minor: 0,
      total_minor: 5000,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Variants price — and are sold — as themselves
// ═══════════════════════════════════════════════════════════════════════════

describe("F. KHR variants", () => {
  it("no variant chosen: submit blocked; 'Large' ៛7,000 × 2 = ៛14,000 for that exact variant", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Shirt");
    expect(submitButton()?.disabled).toBe(true);
    await pickVariant("Large");
    expect(crashes).toEqual([]);
    expect(unitPrice()).toBe("៛7,000");
    await increaseQuantity(1);
    expect(total()).toBe("៛14,000");

    await submit();
    expect(sent[0]!.items).toEqual([
      { variantId: SHIRT.variants[1], quantity: 2, productId: SHIRT.product },
    ]);
    const row = await persisted();
    expect(row).toMatchObject({ currency: "KHR", subtotal_minor: 14000, total_minor: 14000 });
    expect(row.items).toEqual([
      {
        variant_id: SHIRT.variants[1],
        quantity: 2,
        unit_price_minor: 7000,
        line_total_minor: 14000,
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E/9. Currency mismatch fails closed
// ═══════════════════════════════════════════════════════════════════════════

describe("E. currency mismatch fails closed", () => {
  it("a $-priced variant in a riel business: shown in its own currency, refused by the server, nothing persisted", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await pickProduct("Dual");
    await pickVariant("Imported");
    // The browser never converts: the variant is shown as what it is.
    expect(unitPrice()).toBe("$3.00");
    expect(total()).toBe("$3.00");

    await submit();
    expect(sent).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before);
    expect(h.created).toHaveLength(0);
    // Told why, and not offered a retry that can never succeed.
    const body = dialog().textContent ?? "";
    expect(body).toContain(en.conversation.prepareOrder.currency.serverMismatch.title);
    expect(button(en.common.retry, dialog())).toBeUndefined();
  });

  it("the sheet can only ever send one line, so it cannot build a mixed-currency basket", async () => {
    await openSheet(ORG_KHR);
    await pickProduct("Water");
    await submit();
    expect(sent[0]!.items).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Several same-currency lines (server arithmetic the preview mirrors)
// ═══════════════════════════════════════════════════════════════════════════
//
// The New Order sheet is single-line by construction, so a multi-line basket
// is asserted where it is summed: the shared preview helper the sheet now
// prices through, and create_order_v3 itself.

describe("C. several same-currency lines", () => {
  async function serverCreate(org: string, items: { variantId: string; quantity: number }[]) {
    activeOrg = org;
    const { createOrder } = await import("@/server/orders/service");
    return createOrder(context(), {
      source: "MANUAL",
      items,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  it("KHR: ៛5,000 × 2 + ៛3,000 × 1 = ៛13,000 in the preview and in the database", async () => {
    const { calculateDraftTotals } = await import("@/lib/order-draft");
    const { khr } = await import("@/lib/money");
    expect(
      calculateDraftTotals([
        { unitPrice: khr(5000), quantity: 2 },
        { unitPrice: khr(3000), quantity: 1 },
      ]),
    ).toMatchObject({ kind: "priced", currency: "KHR", total: khr(13000) });

    const detail = await serverCreate(ORG_KHR, [
      { variantId: WATER.variants[0]!, quantity: 2 },
      { variantId: SOAP.variants[0]!, quantity: 1 },
    ]);
    expect(detail.total).toEqual({ amount: 13000, currency: "KHR" });
    const row = (
      await f.db.query<Json>("select currency,total_minor from orders where id=$1", [detail.id])
    ).rows[0];
    expect(row).toEqual({ currency: "KHR", total_minor: 13000 });
  });

  it("USD: $20.00 × 2 + $15.00 × 1 = $55.00 in the preview and in the database", async () => {
    const { calculateDraftTotals } = await import("@/lib/order-draft");
    const { usd } = await import("@/lib/money");
    expect(
      calculateDraftTotals([
        { unitPrice: usd(2000), quantity: 2 },
        { unitPrice: usd(1500), quantity: 1 },
      ]),
    ).toMatchObject({ kind: "priced", currency: "USD", total: usd(5500) });

    const detail = await serverCreate(ORG_USD, [
      { variantId: SERUM.variants[0]!, quantity: 2 },
      { variantId: TONER.variants[0]!, quantity: 1 },
    ]);
    expect(detail.total).toEqual({ amount: 5500, currency: "USD" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency: a lost response is replayed by the server, never duplicated
// ═══════════════════════════════════════════════════════════════════════════

describe("Idempotency through the real database", () => {
  it("committed-but-lost KHR create → retry sends the same key → the same order, once", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await pickProduct("Water");
    await increaseQuantity(1);
    await type(feeInput(), "2,000");

    loseNextResponse = true;
    await submit();
    expect(h.created).toHaveLength(0);
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);

    await click(button(en.common.retry, dialog()), "retry");
    await settle(10);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 12000, currency: "KHR" });
    expect(await persisted()).toMatchObject({ total_minor: 12000, delivery_minor: 2000 });
  });

  it("a second identical order after a success is a new order with a new key", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await pickProduct("Water");
    await submit();
    await click(button(en.orderCreate.done), "Done");
    await rerender();
    h.open = true;
    await rerender();
    await pickProduct("Water");
    await submit();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });
});
