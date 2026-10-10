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
import { principalOf } from "./helpers/refuse-only-principal";

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
/** A second member, for a member switch under an open sheet. */
const MEMBER_2 = "aaaaaaaa-0000-4000-8000-0000000000b9";
await f.db.query("insert into auth.users(id,email) values($1,'member-2@test.invalid')", [MEMBER_2]);

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
let activeUser = f.actor;
const SERVER_PERMISSIONS = [
  "products.read",
  "orders.create",
  "orders.read",
  "orders.apply_discount",
];

function context(): AuthorizationContext {
  return {
    organizationId: activeOrg,
    userId: activeUser,
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
/**
 * When set, each create's RESPONSE is held until the test releases it — the
 * server has already answered (committed or refused) by then, exactly as a
 * slow network delivers a finished request late.
 */
let holdResponses = false;
/** Release functions for held responses, indexed like `sent`. */
const held: (() => void)[] = [];
/** When set, the next create never reaches the database and fails with this. */
let failNextWith: unknown = null;

mock.module("@/api/orders", () => ({
  createOrderFn: async ({ data }: { data: Json }) => {
    const index = sent.push(JSON.parse(JSON.stringify(data))) - 1;
    // Fixed when the request is SENT: the member and organization it was sent
    // as, and how its response travels.
    const ctx = context();
    const hold = holdResponses;
    const lose = loseNextResponse;
    loseNextResponse = false;
    const failure = failNextWith;
    failNextWith = null;

    let outcome: { detail: unknown } | { error: unknown };
    if (failure) {
      outcome = { error: failure };
    } else {
      try {
        const { createOrder } = await import("@/server/orders/service");
        // src/api/orders.ts createOrderFn's handler, field for field.
        const detail = await createOrder(ctx, {
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
          expectedPrincipal: data.expectedPrincipal,
        });
        outcome = { detail };
      } catch (error) {
        outcome = { error };
      }
    }
    if (hold) await new Promise<void>((release) => (held[index] = release));
    if (lose) throw new TypeError("Failed to fetch");
    if ("error" in outcome) throw outcome.error;
    return outcome.detail;
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
        userId: activeUser,
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
  // Anything still held belongs to a sheet that no longer exists.
  for (const release of held) release?.();
  held.length = 0;
  sent.length = 0;
  crashes.length = 0;
  loseNextResponse = false;
  holdResponses = false;
  failNextWith = null;
  activeUser = f.actor;
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

/** Close the sheet the way a merchant does: the scrim's own close control. */
async function closeSheet() {
  await click(button(en.common.close), "sheet close");
  await rerender();
  expect(h.open).toBe(false);
}

/** Open New Order again on the same, still-mounted sheet. */
async function reopenSheet() {
  h.open = true;
  await rerender();
  await settle(10);
}

/** Deliver request `index`'s held response — the server answered it long ago. */
async function release(index: number) {
  for (let i = 0; i < 200 && !held[index]; i++) await settle(1);
  if (!held[index]) throw new Error(`request ${index} never reached the server`);
  await act(async () => held[index]!());
  await settle(10);
}

/** True when the control cannot be used: its own flag or a disabled fieldset around it. */
function inert(el: Element | null | undefined): boolean {
  if (!el) throw new Error("no control");
  return (
    (el as HTMLButtonElement).disabled === true ||
    (el.closest("fieldset") as HTMLFieldSetElement | null)?.disabled === true
  );
}

/** The created confirmation, if the sheet is showing one: "Order <code> created". */
function createdBanner(): string | null {
  const pattern = new RegExp(en.orderCreate.created.replace("{{code}}", "(\\S+)"));
  return pattern.exec(text())?.[0] ?? null;
}

async function orderNumberFor(request: Json): Promise<string | null> {
  const rows = (
    await f.db.query<{ order_number: string }>(
      "select order_number from orders where idempotency_key=$1",
      [request.idempotencyKey],
    )
  ).rows;
  return rows[0]?.order_number ?? null;
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
    expect(discountInput() === null).toBe(true);
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
    expect(button(en.common.retry, dialog()) === undefined).toBe(true);
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
      expectedPrincipal: principalOf(context()),
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

// ═══════════════════════════════════════════════════════════════════════════
// Session identity: a late response never reaches a newer sheet session
// ═══════════════════════════════════════════════════════════════════════════
//
// Every open of the sheet is one session, for one member of one organization.
// A create can outlive it: closed while pending, member or organization
// switched, sheet unmounted. The server's answer stays authoritative — the
// order it created is real and stays in the database — and these pin that the
// browser never applies that answer to whichever session is open now.

describe("Session identity: a late response never reaches a newer session", () => {
  it("1. A pending → close → reopen → choose B → A succeeds late: B's session is untouched", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);

    await closeSheet();
    await reopenSheet();
    await pickProduct("Soap");
    await increaseQuantity(1);
    expect(total()).toBe("៛6,000");

    await release(0);
    expect(crashes).toEqual([]);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(h.open).toBe(true);
    expect(unitPrice()).toBe("៛3,000");
    expect(total()).toBe("៛6,000");
    expect(alerts()).toEqual([]);
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.submit);
    expect(submitButton()?.disabled).toBe(false);
    // A is real: the server created it, and nothing here undoes that.
    expect(await orderNumberFor(sent[0]!)).not.toBeNull();
    expect(await orderCount(ORG_KHR)).toBe(before + 1);

    // B itself is created normally, once.
    await submit();
    await release(1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 6000, currency: "KHR" });
    expect(createdBanner()).toContain((await orderNumberFor(sent[1]!))!);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("1b. the same when the PARENT closes the sheet instead of its own control", async () => {
    await openSheet(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();
    h.open = false;
    await rerender();
    await reopenSheet();
    await pickProduct("Soap");

    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(unitPrice()).toBe("៛3,000");
    expect(submitButton()?.disabled).toBe(false);
  });

  it("2. A pending → close → reopen → B submitted → A succeeds late: A cannot close or overwrite B", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();
    await closeSheet();
    await reopenSheet();
    await pickProduct("Soap");
    await submit();
    expect(sent).toHaveLength(2);

    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(h.open).toBe(true);
    // B is still the attempt in flight: its guard and its draft are intact.
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);
    expect(submitButton()?.disabled).toBe(true);
    expect(unitPrice()).toBe("៛3,000");
    await click(submitButton());
    expect(sent).toHaveLength(2);

    await release(1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 3000, currency: "KHR" });
    expect(createdBanner()).toContain((await orderNumberFor(sent[1]!))!);
    expect(createdBanner()).not.toContain((await orderNumberFor(sent[0]!))!);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("3. A pending → close → reopen → A fails late: the failure never appears in B's session", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    failNextWith = new TypeError("Failed to fetch");
    await pickProduct("Water");
    await submit();
    await closeSheet();
    await reopenSheet();
    await pickProduct("Soap");

    await release(0);
    expect(alerts()).toEqual([]);
    expect(text()).not.toContain(en.orderCreate.error.title);
    expect(button(en.common.retry, dialog()) === undefined).toBe(true);
    expect(unitPrice()).toBe("៛3,000");
    expect(submitButton()?.disabled).toBe(false);
    expect(await orderCount(ORG_KHR)).toBe(before);
  });

  it("4a. A pending → the organization changes → A succeeds late: the new organization's session is untouched", async () => {
    await openSheet(ORG_KHR);
    const khrBefore = await orderCount(ORG_KHR);
    const usdBefore = await orderCount(ORG_USD);
    holdResponses = true;
    await pickProduct("Water");
    await submit();

    activeOrg = ORG_USD;
    await rerender();
    await settle(10);
    // A fresh New Order for the new organization: its catalog, none of A's draft.
    expect(text()).toContain("Serum");
    expect(text()).not.toContain("Water");
    await pickProduct("Serum");

    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(unitPrice()).toBe("$20.00");
    expect(submitButton()?.disabled).toBe(false);
    // A was created in the organization that sent it.
    expect(await orderCount(ORG_KHR)).toBe(khrBefore + 1);

    await submit();
    await release(1);
    expect(h.created).toHaveLength(1);
    expect(await persisted()).toMatchObject({
      organization_id: ORG_USD,
      currency: "USD",
      total_minor: 2000,
    });
    expect(await orderCount(ORG_USD)).toBe(usdBefore + 1);
  });

  it("4b. A pending → the member changes → A succeeds late: ignored, and the new member's identical order gets its own key", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();

    activeUser = MEMBER_2;
    await rerender();
    await settle(10);
    // The new member starts from an empty New Order, not the previous member's draft.
    expect(submitButton() === undefined).toBe(true);
    await pickProduct("Water");
    await submit();
    // The identical basket, but another member's request: never the first member's key.
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);

    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);

    await release(1);
    expect(h.created).toHaveLength(1);
    const createdBy = async (request: Json) =>
      (
        await f.db.query<{ created_by: string }>(
          "select created_by from orders where idempotency_key=$1",
          [request.idempotencyKey],
        )
      ).rows[0]?.created_by;
    expect(await createdBy(sent[0]!)).toBe(f.actor);
    expect(await createdBy(sent[1]!)).toBe(MEMBER_2);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("5. three sessions, three late responses out of order: only the live session's own answer lands", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit(); // request 0 — session 1
    await closeSheet();
    await reopenSheet();
    await pickProduct("Soap");
    await submit(); // request 1 — session 2
    await closeSheet();
    await reopenSheet();
    await pickProduct("Water");
    await increaseQuantity(1);
    await submit(); // request 2 — session 3, the live one

    await release(1);
    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);
    expect(total()).toBe("៛10,000");

    await release(2);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 10000, currency: "KHR" });
    expect(createdBanner()).toContain((await orderNumberFor(sent[2]!))!);
    expect(await orderCount(ORG_KHR)).toBe(before + 3);
  });

  it("6. the live session's own late success still lands: ៛5,000 × 2 = ៛10,000 created and persisted", async () => {
    await openSheet(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await increaseQuantity(1);
    await submit();
    expect(createdBanner()).toBeNull();

    await release(0);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 10000, currency: "KHR" });
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    expect(await persisted()).toMatchObject({ currency: "KHR", total_minor: 10000 });
  });

  it("7. the live session's own late failure still shows, keeps the draft, and its retry creates the order once", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    failNextWith = Object.assign(new Error("Order service unavailable"), { statusCode: 500 });
    await pickProduct("Water");
    await submit();
    await release(0);
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);
    expect(total()).toBe("៛5,000");
    expect(await orderCount(ORG_KHR)).toBe(before);

    holdResponses = false;
    await click(button(en.common.retry, dialog()), "retry");
    await settle(10);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("8. a dropped late success keeps its key: the identical order rebuilt after reopening is replayed, not duplicated", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await increaseQuantity(1);
    await submit(); // request 0 — committed by the server, response held
    await closeSheet();
    await reopenSheet();
    await pickProduct("Water");
    await increaseQuantity(1);
    await submit(); // request 1 — the same request
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);

    await release(0);
    expect(createdBanner()).toBeNull();
    await release(1);
    // The server answered the rebuilt request with the order it had already made.
    expect(h.created).toHaveLength(1);
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("8b. A's late success arrives BEFORE the identical order is rebuilt: dropped, but its key is kept, so the rebuild is replayed — still one order", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit(); // request 0 — committed by the server, response held
    holdResponses = false;
    await closeSheet();
    await reopenSheet();

    await release(0); // A's answer reaches a sheet that never asked for it
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);

    // The merchant, never told A exists, enters the very same order again.
    await pickProduct("Water");
    await submit();
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("9. a late success cannot retire the newer session's key: B's lost-response retry is still replayed exactly once", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit(); // request 0 (A) — response held
    holdResponses = false;
    await closeSheet();
    await reopenSheet();
    await pickProduct("Soap");
    loseNextResponse = true;
    await submit(); // request 1 (B) — committed, response lost
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);

    await release(0); // A's success arrives now
    expect(createdBanner()).toBeNull();
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);

    await click(button(en.common.retry, dialog()), "retry");
    await settle(10);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 3000, currency: "KHR" });
    // A once, B once — never a second B.
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("the draft is locked while its create is pending, so the request cannot change under it", async () => {
    await openSheet(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();
    expect(inert(button(en.orderCreate.change))).toBe(true);
    expect(inert(button(en.common.increase))).toBe(true);
    expect(inert(discountSwitch())).toBe(true);
    expect(inert(feeInput())).toBe(true);
    // Closing is always possible — and ends the session (cases above).
    expect(inert(button(en.common.close))).toBe(false);

    await release(0);
    expect(h.created).toHaveLength(1);
  });

  it("the sheet unmounts while A is pending (navigating away): A's late success reports nothing", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await pickProduct("Water");
    await submit();
    await act(async () => root!.unmount());
    root = null;

    await release(0);
    expect(crashes).toEqual([]);
    expect(h.created).toHaveLength(0);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Replay identity survives an identity switch and back (PR #120 review P2)
// ═══════════════════════════════════════════════════════════════════════════
//
// The sheet stays mounted while the member or organization changes under it.
// A create whose outcome is unknown (committed, response lost) must keep its
// key for ITS member and organization: switching away and back, then
// rebuilding the identical order, must be replayed by the server — one order.
// The first repair replaced the holder on every switch, so A → B → A minted a
// new key and create_order_v3 correctly persisted a second order.

/** Switch the member and/or organization under the still-mounted sheet. */
async function switchIdentity(next: { org?: string; user?: string }) {
  if (next.org) activeOrg = next.org;
  if (next.user) activeUser = next.user;
  await rerender();
  await settle(10);
}

/** Orders persisted under one request's key — the authoritative duplicate check. */
async function ordersUnderKey(request: Json): Promise<number> {
  return (
    await f.db.query<{ n: number }>(
      "select count(*)::int as n from orders where idempotency_key=$1",
      [request.idempotencyKey],
    )
  ).rows[0]!.n;
}

/** Water × 2, the committed-but-lost request every case below rebuilds. */
async function buildWaterTimesTwo() {
  await pickProduct("Water");
  await increaseQuantity(1);
  expect(total()).toBe("៛10,000");
}

describe("Replay identity survives an identity switch and back", () => {
  it("A. organization A → B → A: the identical retry sends the original key — exactly one order", async () => {
    await openSheet(ORG_KHR);
    const khrBefore = await orderCount(ORG_KHR);
    const usdBefore = await orderCount(ORG_USD);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit(); // committed by the server, response lost
    expect(h.created).toHaveLength(0);
    expect(await orderCount(ORG_KHR)).toBe(khrBefore + 1);
    await closeSheet();

    await switchIdentity({ org: ORG_USD });
    await reopenSheet();
    expect(text()).toContain("Serum");
    await closeSheet();
    await switchIdentity({ org: ORG_KHR });
    await reopenSheet();

    await buildWaterTimesTwo();
    await submit();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    // The server answered with the order the first request made.
    expect(h.created).toHaveLength(1);
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    expect(await ordersUnderKey(sent[0]!)).toBe(1);
    expect(await orderCount(ORG_KHR)).toBe(khrBefore + 1);
    expect(await orderCount(ORG_USD)).toBe(usdBefore);
    expect(await persisted()).toMatchObject({ currency: "KHR", total_minor: 10000 });
  });

  it("A2. the same without closing first: the organization switches under the open, failed sheet", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit();
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);

    await switchIdentity({ org: ORG_USD });
    // B's session starts clean: none of A's draft or failure.
    expect(alerts()).toEqual([]);
    expect(text()).not.toContain("Water");
    await switchIdentity({ org: ORG_KHR });

    await buildWaterTimesTwo();
    await submit();
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("B. member A → B → A: the identical retry sends the original key — exactly one order", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit();
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
    await closeSheet();

    await switchIdentity({ user: MEMBER_2 });
    await reopenSheet();
    await closeSheet();
    await switchIdentity({ user: f.actor });
    await reopenSheet();

    await buildWaterTimesTwo();
    await submit();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    expect(await ordersUnderKey(sent[0]!)).toBe(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("C1. different organizations never share a key: each keeps its own, and each is replayed once", async () => {
    await openSheet(ORG_KHR);
    const khrBefore = await orderCount(ORG_KHR);
    const usdBefore = await orderCount(ORG_USD);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit(); // 0: A's Water, lost

    await switchIdentity({ org: ORG_USD });
    await pickProduct("Serum");
    loseNextResponse = true;
    await submit(); // 1: B's Serum, lost
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);

    await switchIdentity({ org: ORG_KHR });
    await buildWaterTimesTwo();
    await submit(); // 2: A's retry
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);

    await closeSheet();
    await switchIdentity({ org: ORG_USD });
    await reopenSheet();
    await pickProduct("Serum");
    await submit(); // 3: B's retry
    expect(sent[3]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.total).toEqual({ amount: 2000, currency: "USD" });

    expect(await orderCount(ORG_KHR)).toBe(khrBefore + 1);
    expect(await orderCount(ORG_USD)).toBe(usdBefore + 1);
  });

  it("C2. different members never share a key, even for the identical basket", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit(); // 0: member 1, lost

    await switchIdentity({ user: MEMBER_2 });
    await buildWaterTimesTwo();
    await submit(); // 1: member 2's identical basket — their own order
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);

    await closeSheet();
    await switchIdentity({ user: f.actor });
    await reopenSheet();
    await buildWaterTimesTwo();
    await submit(); // 2: member 1's retry — their key, never member 2's
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(sent[2]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
    expect(h.created).toHaveLength(2);
    expect(await ordersUnderKey(sent[0]!)).toBe(1);
    expect(await ordersUnderKey(sent[1]!)).toBe(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("C3. a different logical order after the switch back is a new order with a new key", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit(); // 0: Water × 2, lost

    await switchIdentity({ org: ORG_USD });
    await switchIdentity({ org: ORG_KHR });
    await pickProduct("Water"); // Water × 1 — a different request
    await submit();
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.total).toEqual({ amount: 5000, currency: "KHR" });
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("D. late responses across A → B → A reach no session, retire no key, and the rebuilds are replayed once each", async () => {
    await openSheet(ORG_KHR);
    const khrBefore = await orderCount(ORG_KHR);
    const usdBefore = await orderCount(ORG_USD);
    holdResponses = true;
    await buildWaterTimesTwo();
    await submit(); // 0: A, committed, response held

    await switchIdentity({ org: ORG_USD });
    await pickProduct("Serum");
    await submit(); // 1: B, committed, response held
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);

    // A's late success lands in B's live session: ignored.
    await release(0);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(submitButton()?.textContent?.trim()).toBe(en.orderCreate.creating);
    expect(unitPrice()).toBe("$20.00");

    await switchIdentity({ org: ORG_KHR });
    await buildWaterTimesTwo();
    // B's late success lands in A's live, unsubmitted session: ignored.
    await release(1);
    expect(createdBanner()).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(total()).toBe("៛10,000");
    expect(submitButton()?.disabled).toBe(false);

    // Neither stale success retired its key: both rebuilds are replays.
    holdResponses = false;
    await submit(); // 2: A's rebuild
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(createdBanner()).toContain((await orderNumberFor(sent[0]!))!);
    await closeSheet();
    await switchIdentity({ org: ORG_USD });
    await reopenSheet();
    await pickProduct("Serum");
    await submit(); // 3: B's rebuild
    expect(sent[3]!.idempotencyKey).toBe(sent[1]!.idempotencyKey);
    expect(createdBanner()).toContain((await orderNumberFor(sent[1]!))!);

    expect(h.created).toHaveLength(2);
    expect(await orderCount(ORG_KHR)).toBe(khrBefore + 1);
    expect(await orderCount(ORG_USD)).toBe(usdBefore + 1);
  });

  it("D2. an old attempt cannot retire the newer replay key: A stale, A rebuilt and lost, A's retry still replayed", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    holdResponses = true;
    await buildWaterTimesTwo();
    await submit(); // 0: held
    holdResponses = false;

    await switchIdentity({ org: ORG_USD });
    await switchIdentity({ org: ORG_KHR });
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit(); // 1: same key, server replays, response lost
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);

    await release(0); // the first session's late success
    expect(createdBanner()).toBeNull();
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);

    await click(button(en.common.retry, dialog()), "retry");
    await settle(10);
    expect(sent[2]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("E1. an accepted create is retired: after A → B → A the identical order is a NEW order", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    await submit();
    expect(h.created).toHaveLength(1);
    await click(button(en.orderCreate.done), "Done");
    await rerender();

    await switchIdentity({ org: ORG_USD });
    await switchIdentity({ org: ORG_KHR });
    await reopenSheet();
    await buildWaterTimesTwo();
    await submit();
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(2);
    expect(await orderCount(ORG_KHR)).toBe(before + 2);
  });

  it("E2. a refused attempt stays retryable across A → B → A on its original key", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    failNextWith = Object.assign(new Error("Order service unavailable"), { statusCode: 500 });
    await buildWaterTimesTwo();
    await submit();
    expect(alerts().join(" ")).toContain(en.orderCreate.error.title);
    expect(await orderCount(ORG_KHR)).toBe(before);

    await switchIdentity({ org: ORG_USD });
    await switchIdentity({ org: ORG_KHR });
    await buildWaterTimesTwo();
    await submit();
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });

  it("E3. many identity switches in between never evict the unresolved key", async () => {
    await openSheet(ORG_KHR);
    const before = await orderCount(ORG_KHR);
    await buildWaterTimesTwo();
    loseNextResponse = true;
    await submit();

    // Organizations this member passes through without ordering anything.
    for (let i = 0; i < 30; i++) {
      await switchIdentity({ org: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}` });
    }
    await switchIdentity({ org: ORG_KHR });
    await buildWaterTimesTwo();
    await submit();
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(h.created).toHaveLength(1);
    expect(await orderCount(ORG_KHR)).toBe(before + 1);
  });
});
