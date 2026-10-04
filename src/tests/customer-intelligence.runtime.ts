/**
 * Customer Intelligence V1 (migration 060) — executed against the REAL migrated
 * schema (every migration, in order, through PGlite). Spawned by
 * customer-intelligence.test.ts (isolated: mock.module is process-wide).
 *
 * The production service (src/server/customers/insights.ts) and repository
 * (src/server/customers/repository.ts) run unchanged over a local SQL
 * transport, under `SET ROLE service_role`, in an environment that mirrors
 * Supabase's privilege defaults:
 *   - RESTRICTED table defaults — service_role holds only what migrations
 *     explicitly grant, so "the service path works" proves 060 needs nothing
 *     it was not already given;
 *   - functions EXECUTE-granted to anon/authenticated by default — so the
 *     browser-denial assertions prove 060's own REVOKE, not an environment
 *     that never granted anything.
 *
 * Commerce is seeded in exact states. Orders, lines, deliveries and returns are
 * inserted directly (bypassing the lifecycle RPCs, which are not what this file
 * tests); payments go through the real payment RPCs so the
 * order_payment_totals ledger is authentic. Deliberately CORRUPT cross-tenant
 * rows (Org B rows pointing at Org A's customer/orders) are planted on every
 * relation the function reads, so a missing organization filter anywhere shows
 * up as a wrong number.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { conversationPostgrest } from "./helpers/conversation-postgrest";
import { AuthorizationContext } from "../server/auth/authorization";

const db = new PGlite();
const transport = conversationPostgrest(db);
mock.module("../lib/supabase/server", () => ({ supabaseAdmin: transport }));
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: transport }));

const { getCustomerInsights } = await import("../server/customers/insights");

const MIGRATION_060 = readFileSync("supabase/migrations/060_customer_purchase_profile.sql", "utf8");
const SIGNATURE =
  "public.customer_purchase_profile_v1(uuid, uuid, boolean, boolean, boolean, boolean, integer)";

const orgA = "aaaaaaaa-0000-4000-8000-000000000001";
const orgB = "bbbbbbbb-0000-4000-8000-000000000001";
const actor = "aaaaaaaa-0000-4000-8000-000000000002";

const ALL = [
  "customers.read",
  "orders.read",
  "customers.view_sensitive",
  "payments.reconcile",
  "payments.read",
  "delivery.read",
  "orders.return",
];

/** A real AuthorizationContext — the class the API builds — for a given org and grant set. */
function ctx(organizationId: string, permissions: string[] = ALL, userId = actor) {
  return new AuthorizationContext({
    membership: {
      id: crypto.randomUUID(),
      user_id: userId,
      organization_id: organizationId,
      role_id: crypto.randomUUID(),
      status: "active",
    },
    role: { id: crypto.randomUUID(), system_role: null },
    permissions: new Set(permissions),
  } as unknown as ConstructorParameters<typeof AuthorizationContext>[0]);
}

async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** The production read path, as the server runs it — expected to be available. */
async function available(result: Promise<Awaited<ReturnType<typeof getCustomerInsights>>>) {
  const r = await result;
  if (r.status !== "available") throw new Error(`expected available, got ${r.status}`);
  return r.data;
}
const insights = (organizationId: string, customerId: string, permissions: string[] = ALL) =>
  available(
    asRole("service_role", () => getCustomerInsights(ctx(organizationId, permissions), customerId)),
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function one(sql: string, args: unknown[] = []): Promise<any> {
  return (await db.query<Record<string, unknown>>(sql, args)).rows[0];
}

const ids = {
  cNone: "",
  cOne: "",
  cMulti: "",
  cTie: "",
  cB: "",
  pA: "",
  pB: "",
  pC: "",
  pX: "",
  pY: "",
  vBlackM: "",
  vRedL: "",
  vB: "",
  vC: "",
  vX: "",
  vY: "",
  pBOrgB: "",
  vBOrgB: "",
  o1: "",
  o2: "",
  o3: "",
};

let orderSeq = 0;
async function order(
  tenant: string,
  customer: string | null,
  o: {
    lifecycle: string;
    currency?: string;
    createdAt: string;
    source?: string;
    conversationRef?: string | null;
    lines: Array<{
      product: string;
      variant: string;
      label: string;
      variantLabel?: string | null;
      unit: number;
      qty: number;
    }>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  orderSeq += 1;
  const subtotal = o.lines.reduce((s, l) => s + l.unit * l.qty, 0);
  await db.query(
    `insert into orders(id, organization_id, order_number, customer_id, source, currency,
       subtotal_minor, total_minor, created_by, created_at, lifecycle_status, source_conversation_ref)
     values ($1,$2,$3,$4,$5::order_source,$6,$7,$7,$8,$9,$10::order_lifecycle_status,$11)`,
    [
      id,
      tenant,
      `CI-${orderSeq}`,
      customer,
      o.source ?? "MANUAL",
      o.currency ?? "USD",
      subtotal,
      actor,
      o.createdAt,
      o.lifecycle,
      o.conversationRef ?? null,
    ],
  );
  let n = 0;
  for (const l of o.lines) {
    n += 1;
    await db.query(
      `insert into order_items(organization_id, order_id, product_id, variant_id,
         product_name_snapshot, variant_name_snapshot, unit_price_minor, quantity,
         line_total_minor, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz + ($11 || ' ms')::interval)`,
      [
        tenant,
        id,
        l.product,
        l.variant,
        l.label,
        l.variantLabel ?? null,
        l.unit,
        l.qty,
        l.unit * l.qty,
        o.createdAt,
        String(n),
      ],
    );
  }
  return id;
}

async function rpc(name: string, args: unknown[]) {
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  const result = (await one(`select ${name}(${params}) as result`, args)).result;
  return result as Record<string, unknown>;
}

async function pay(
  tenant: string,
  orderId: string,
  method: string,
  amount: number,
): Promise<string> {
  const r = await rpc("record_payment_v1", [
    tenant,
    orderId,
    actor,
    method,
    amount,
    null,
    null,
    null,
  ]);
  if (r.status !== "success") throw new Error(`record_payment_v1: ${JSON.stringify(r)}`);
  return r.payment_id as string;
}

async function verify(tenant: string, payment: string) {
  const r = await rpc("verify_payment_v1", [
    tenant,
    payment,
    actor,
    "unverified",
    "bank_verified",
    "test",
    null,
  ]);
  if (r.status !== "success") throw new Error(`verify_payment_v1: ${JSON.stringify(r)}`);
}

async function delivery(tenant: string, orderId: string, status: string, createdAt: string) {
  await db.query(
    `insert into deliveries(organization_id, order_id, provider_name, status, created_by, created_at)
     values ($1,$2,'Test courier',$3::delivery_status,$4,$5)`,
    [tenant, orderId, status, actor, createdAt],
  );
}

async function customerReturn(
  tenant: string,
  orderId: string,
  status: string,
  lines: Array<{ product: string; variant: string; label: string; qty: number }>,
) {
  const d = await one(
    `select id from deliveries where order_id = $1 and organization_id = $2 order by created_at desc limit 1`,
    [orderId, tenant],
  );
  const r = await one(
    `insert into customer_returns(organization_id, request_key, order_id, delivery_id, status, created_by)
     values ($1, gen_random_uuid(), $2, $3, $4, $5) returning id`,
    [tenant, orderId, d?.id ?? crypto.randomUUID(), status, actor],
  );
  for (const l of lines) {
    const item = await one(
      `select id from order_items where order_id = $1 and variant_id = $2 limit 1`,
      [orderId, l.variant],
    );
    await db.query(
      `insert into customer_return_items(organization_id, return_id, order_item_id, product_id,
         variant_id, product_name_snapshot, quantity)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [tenant, r.id, item?.id ?? crypto.randomUUID(), l.product, l.variant, l.label, l.qty],
    );
  }
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d{3}_.*\.sql$/.test(n))
    .sort()) {
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }

  await db.query("insert into auth.users(id,email) values($1,'ci@test.invalid')", [actor]);
  await db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
     values($1,'A','A','ci-a',$3),($2,'B','B','ci-b',$3)`,
    [orgA, orgB, actor],
  );

  const customer = async (tenant: string, name: string) =>
    (
      await one(
        `insert into customers(organization_id, display_name, primary_phone)
         values ($1,$2,'012 345 678') returning id`,
        [tenant, name],
      )
    ).id as string;
  ids.cNone = await customer(orgA, "New customer");
  ids.cOne = await customer(orgA, "One order");
  ids.cMulti = await customer(orgA, "Sophea");
  ids.cTie = await customer(orgA, "Tie");
  ids.cB = await customer(orgB, "Org B customer");

  // Sophea has two channel identities; nothing about them may leak into insights.
  await db.query(
    `insert into customer_identities(organization_id, customer_id, provider, provider_user_id, handle)
     values ($1,$2,'FACEBOOK','fb-psid-SECRET-1','sophea.fb'),
            ($1,$2,'TELEGRAM','tg-SECRET-2','sophea_tg')`,
    [orgA, ids.cMulti],
  );

  const product = async (tenant: string, name: string) =>
    (
      await one(`insert into products(organization_id, name_km) values ($1,$2) returning id`, [
        tenant,
        name,
      ])
    ).id as string;
  const variant = async (tenant: string, productId: string, name: string, price = 1500) =>
    (
      await one(
        `insert into product_variants(organization_id, product_id, name, price_amount)
         values ($1,$2,$3,$4) returning id`,
        [tenant, productId, name, price],
      )
    ).id as string;
  ids.pA = await product(orgA, "Product A");
  ids.pB = await product(orgA, "Product B");
  ids.pC = await product(orgA, "Product C");
  ids.pX = await product(orgA, "Product X");
  ids.pY = await product(orgA, "Product Y");
  ids.vBlackM = await variant(orgA, ids.pA, "Black / M");
  ids.vRedL = await variant(orgA, ids.pA, "Red / L");
  ids.vB = await variant(orgA, ids.pB, "", 2000);
  ids.vC = await variant(orgA, ids.pC, "");
  ids.vX = await variant(orgA, ids.pX, "");
  ids.vY = await variant(orgA, ids.pY, "");
  ids.pBOrgB = await product(orgB, "Org B product");
  ids.vBOrgB = await variant(orgB, ids.pBOrgB, "");

  const A = (variantLabel: string, variantId: string, qty: number, label = "Product A") => ({
    product: ids.pA,
    variant: variantId,
    label,
    variantLabel,
    unit: 1500,
    qty,
  });

  // ── cOne: one completed POS order, paid in cash, delivered.
  const one1 = await order(orgA, ids.cOne, {
    lifecycle: "completed",
    createdAt: "2026-08-01T03:00:00.000Z",
    source: "POS",
    lines: [{ product: ids.pB, variant: ids.vB, label: "Product B", unit: 1000, qty: 1 }],
  });
  await verify(orgA, await pay(orgA, one1, "cash", 1000));
  await delivery(orgA, one1, "delivered", "2026-08-01T05:00:00.000Z");

  // ── cMulti (Sophea).
  // o1 completed, USD, Instagram: A Black/M ×2 (old snapshot name), B ×1. Paid (KHQR).
  ids.o1 = await order(orgA, ids.cMulti, {
    lifecycle: "completed",
    createdAt: "2026-09-01T03:00:00.000Z",
    source: "INSTAGRAM",
    lines: [
      A("Black / M", ids.vBlackM, 2, "Product A (old name)"),
      { product: ids.pB, variant: ids.vB, label: "Product B", unit: 2000, qty: 1 },
    ],
  });
  await verify(orgA, await pay(orgA, ids.o1, "khqr", 5000));
  // Failed first attempt, then delivered.
  await delivery(orgA, ids.o1, "failed", "2026-09-02T03:00:00.000Z");
  await delivery(orgA, ids.o1, "delivered", "2026-09-03T03:00:00.000Z");

  // o2 confirmed, USD, Facebook via Inbox: A Red/L ×1. COD pending; a KHQR payment reversed.
  ids.o2 = await order(orgA, ids.cMulti, {
    lifecycle: "confirmed",
    createdAt: "2026-09-05T03:00:00.000Z",
    source: "FACEBOOK",
    conversationRef: "conv-ref-OPAQUE-123",
    lines: [A("Red / L", ids.vRedL, 1)],
  });
  await pay(orgA, ids.o2, "cod", 1500);
  const reversed = await pay(orgA, ids.o2, "khqr", 1500);
  await verify(orgA, reversed);
  const rev = await rpc("reverse_payment_v1", [orgA, reversed, actor, "test reversal"]);
  if (rev.status !== "success") throw new Error(`reverse: ${JSON.stringify(rev)}`);
  await delivery(orgA, ids.o2, "in_transit", "2026-09-06T03:00:00.000Z");

  // o3 confirmed, KHR, manual: A Black/M ×1 at ៛40,000. Paid in cash, ៛10,000 refunded.
  ids.o3 = await order(orgA, ids.cMulti, {
    lifecycle: "confirmed",
    currency: "KHR",
    createdAt: "2026-09-10T03:00:00.000Z",
    source: "MANUAL",
    lines: [{ ...A("Black / M", ids.vBlackM, 1), unit: 40000 }],
  });
  const khrPayment = await pay(orgA, ids.o3, "cash", 40000);
  await verify(orgA, khrPayment);
  const refund = await rpc("refund_payment_v1", [orgA, khrPayment, actor, 10000, "test refund"]);
  if (refund.status !== "success") throw new Error(`refund: ${JSON.stringify(refund)}`);

  // o4 cancelled (USD 99,999 of Product C) and o5 draft — neither is commerce.
  await order(orgA, ids.cMulti, {
    lifecycle: "cancelled",
    createdAt: "2026-09-12T03:00:00.000Z",
    lines: [{ product: ids.pC, variant: ids.vC, label: "Product C", unit: 19999, qty: 5 }],
  });
  await order(orgA, ids.cMulti, {
    lifecycle: "draft",
    createdAt: "2026-09-13T03:00:00.000Z",
    lines: [{ product: ids.pC, variant: ids.vC, label: "Product C", unit: 1000, qty: 3 }],
  });

  // Returns on o1: one completed (A ×1), one still requested (B ×1).
  await customerReturn(orgA, ids.o1, "completed", [
    { product: ids.pA, variant: ids.vBlackM, label: "Product A", qty: 1 },
  ]);
  await customerReturn(orgA, ids.o1, "requested", [
    { product: ids.pB, variant: ids.vB, label: "Product B", qty: 1 },
  ]);

  // ── cTie: X and Y bought identically on one order — ranking must fall to product id.
  await order(orgA, ids.cTie, {
    lifecycle: "completed",
    createdAt: "2026-09-20T03:00:00.000Z",
    lines: [
      { product: ids.pY, variant: ids.vY, label: "Product Y", unit: 100, qty: 2 },
      { product: ids.pX, variant: ids.vX, label: "Product X", unit: 100, qty: 2 },
    ],
  });

  // ── Org B: its own customer and order.
  await order(orgB, ids.cB, {
    lifecycle: "completed",
    createdAt: "2026-09-15T03:00:00.000Z",
    lines: [
      { product: ids.pBOrgB, variant: ids.vBOrgB, label: "Org B product", unit: 777, qty: 7 },
    ],
  });

  // ── CORRUPT cross-tenant rows. Triggers would refuse these; replication mode
  // plants them anyway so that each organization filter in 060 is load-bearing.
  await db.exec("SET session_replication_role = replica");
  // An Org B order pointing at Org A's customer.
  await order(orgB, ids.cMulti, {
    lifecycle: "completed",
    createdAt: "2026-09-30T03:00:00.000Z",
    source: "TELEGRAM",
    lines: [{ product: ids.pC, variant: ids.vC, label: "LEAK product", unit: 77777, qty: 9 }],
  });
  // An Org B line on Org A's order.
  await db.query(
    `insert into order_items(organization_id, order_id, product_id, variant_id,
       product_name_snapshot, unit_price_minor, quantity, line_total_minor)
     values ($1,$2,$3,$4,'LEAK line',1,50,50)`,
    [orgB, ids.o1, ids.pC, ids.vC],
  );
  // An Org B payment on Org A's order.
  await db.query(
    `insert into payments(organization_id, order_id, method, currency, amount_minor, status)
     values ($1,$2,'bank_transfer','USD',9999,'paid')`,
    [orgB, ids.o1],
  );
  // An Org B delivery attempt, newest, on Org A's order.
  await db.query(
    `insert into deliveries(organization_id, order_id, provider_name, status, created_at)
     values ($1,$2,'LEAK','failed','2026-12-01T00:00:00Z')`,
    [orgB, ids.o2],
  );
  // An Org B completed return on Org A's order.
  await db.query(
    `insert into customer_returns(organization_id, request_key, order_id, delivery_id, status, created_by)
     values ($1, gen_random_uuid(), $2, gen_random_uuid(), 'completed', $3)`,
    [orgB, ids.o1, actor],
  );
  await db.exec("SET session_replication_role = origin");

  // The product was archived and renamed after the purchase: labels must not follow.
  await db.query(`update products set status='ARCHIVED', name_km='RENAMED' where id = $1`, [
    ids.pB,
  ]);
  await db.query(`update products set name_km='Live name A' where id = $1`, [ids.pA]);
});

afterAll(async () => {
  await db.close();
});

describe("migration 060 — applies from the committed file", () => {
  it("is present after every migration, and re-applies cleanly with identical results", async () => {
    const present = await one(
      `select count(*)::int as n from pg_proc where oid = to_regprocedure($1)`,
      [SIGNATURE],
    );
    expect(present.n).toBe(1);
    const before = await insights(orgA, ids.cMulti);
    await db.exec(MIGRATION_060);
    await db.exec(MIGRATION_060);
    expect(await insights(orgA, ids.cMulti)).toEqual(before);
  });

  it("creates no relation (nothing persisted; derived on read)", async () => {
    const rel = await one(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname ilike '%purchase_profile%'`,
    );
    expect(rel.n).toBe(0);
  });

  it("is SECURITY INVOKER with a pinned search_path", async () => {
    const fn = await one(
      `select prosecdef, proconfig from pg_proc where oid = to_regprocedure($1)`,
      [SIGNATURE],
    );
    expect(fn.prosecdef).toBe(false);
    expect(fn.proconfig).toEqual(["search_path=public, pg_temp"]);
  });
});

describe("1 — a customer with no purchases", () => {
  it("is found, has no purchase history, and nothing is invented", async () => {
    const r = await insights(orgA, ids.cNone);
    expect(r.hasPurchases).toBe(false);
    expect(r.activity.orderCount).toBe(0);
    expect(r.activity.firstOrderAt).toBeNull();
    expect(r.activity.lastOrderAt).toBeNull();
    expect(r.activity.lastOrderProducts).toEqual([]);
    expect(r.topProducts).toEqual([]);
    // No currency at all — not a fabricated "$0.00".
    expect(r.money).toEqual({ status: "available", data: [] });
    expect(r.activity.sourceCounts).toEqual({});
  });
});

describe("2 — one completed purchase", () => {
  it("counts it, its money, its product and its delivery", async () => {
    const r = await insights(orgA, ids.cOne);
    expect(r.hasPurchases).toBe(true);
    expect(r.activity.orderCount).toBe(1);
    expect(r.activity.completedOrderCount).toBe(1);
    expect(r.activity.firstOrderAt).toBe(r.activity.lastOrderAt);
    expect(r.money).toEqual({
      status: "available",
      data: [
        {
          currency: "USD",
          orderCount: 1,
          ordered: { amount: 1000, currency: "USD" },
          received: { amount: 1000, currency: "USD" },
          refunded: { amount: 0, currency: "USD" },
          netPaid: { amount: 1000, currency: "USD" },
          outstanding: { amount: 0, currency: "USD" },
          averageOrder: { amount: 1000, currency: "USD" },
        },
      ],
    });
    expect(r.topProducts.map((p) => [p.label, p.units])).toEqual([["Product B", 1]]);
    expect(r.payments).toEqual({ status: "available", data: { methodOrderCounts: { cash: 1 } } });
    expect(r.activity.sourceCounts).toEqual({ POS: 1 });
  });
});

describe("3–12, 16 — Sophea: several orders, products, variants, currencies and outcomes", () => {
  it("activity: committed orders only; cancelled counted apart; drafts ignored", async () => {
    const { activity } = await insights(orgA, ids.cMulti);
    expect(activity).toEqual({
      orderCount: 3,
      openOrderCount: 2,
      completedOrderCount: 1,
      cancelledOrderCount: 1,
      refundedOrderCount: 1,
      firstOrderAt: expect.stringContaining("2026-09-01"),
      lastOrderAt: expect.stringContaining("2026-09-10"),
      lastOrderId: ids.o3,
      lastOrderSource: "MANUAL",
      lastOrderProducts: ["Product A"],
      distinctProductCount: 2,
      unitsPurchased: 5,
      conversationLinkedOrderCount: 1,
      sourceCounts: { INSTAGRAM: 1, FACEBOOK: 1, MANUAL: 1 },
    });
  });

  it("money: USD and KHR stay separate; refunds net out; COD counts only once received", async () => {
    const r = await insights(orgA, ids.cMulti);
    expect(r.money).toEqual({
      status: "available",
      data: [
        {
          currency: "KHR",
          orderCount: 1,
          ordered: { amount: 40000, currency: "KHR" },
          received: { amount: 40000, currency: "KHR" },
          refunded: { amount: 10000, currency: "KHR" },
          netPaid: { amount: 30000, currency: "KHR" },
          outstanding: { amount: 0, currency: "KHR" },
          averageOrder: { amount: 40000, currency: "KHR" },
        },
        {
          currency: "USD",
          orderCount: 2,
          ordered: { amount: 6500, currency: "USD" },
          // o1 paid 5000. o2's COD is still pending and its KHQR was reversed.
          received: { amount: 5000, currency: "USD" },
          refunded: { amount: 0, currency: "USD" },
          netPaid: { amount: 5000, currency: "USD" },
          outstanding: { amount: 1500, currency: "USD" },
          averageOrder: { amount: 3250, currency: "USD" },
        },
      ],
    });
  });

  it("the cancelled order's 99,999 and its product never appear", async () => {
    const r = JSON.stringify(await insights(orgA, ids.cMulti));
    expect(r).not.toContain("99995");
    expect(r).not.toContain("Product C");
  });

  it("product affinity: units across variants, most-bought variant, snapshot labels", async () => {
    const { topProducts } = await insights(orgA, ids.cMulti);
    expect(topProducts).toEqual([
      {
        productId: ids.pA,
        // The most recent line's snapshot — not "Product A (old name)", not the live "Live name A".
        label: "Product A",
        topVariantLabel: "Black / M",
        variantCount: 2,
        units: 4,
        orderCount: 3,
        lastPurchasedAt: expect.stringContaining("2026-09-10"),
      },
      {
        productId: ids.pB,
        // Archived and renamed to "RENAMED" since — the purchase still reads as bought.
        label: "Product B",
        topVariantLabel: null,
        variantCount: 1,
        units: 1,
        orderCount: 1,
        lastPurchasedAt: expect.stringContaining("2026-09-01"),
      },
    ]);
  });

  it("payments: methods actually used — a reversed payment is not usage", async () => {
    const r = await insights(orgA, ids.cMulti);
    expect(r.payments).toEqual({
      status: "available",
      data: { methodOrderCounts: { khqr: 1, cod: 1, cash: 1 } },
    });
  });

  it("delivery: current state is the newest attempt; the earlier failure is still counted", async () => {
    const r = await insights(orgA, ids.cMulti);
    expect(r.delivery).toEqual({
      status: "available",
      data: {
        ordersWithDelivery: 2,
        failedAttemptCount: 1,
        currentStatusCounts: { delivered: 1, in_transit: 1 },
      },
    });
  });

  it("returns: partial and pending returns reported; they do not change spend", async () => {
    const r = await insights(orgA, ids.cMulti);
    expect(r.returns).toEqual({
      status: "available",
      data: {
        returnCount: 2,
        returnedOrderCount: 1,
        completedReturnCount: 1,
        completedReturnedUnits: 1,
      },
    });
    // o1 was paid 5000 and a unit came back, but nothing was refunded on it.
    if (r.money.status !== "available") throw new Error("unreachable");
    expect(r.money.data.find((m) => m.currency === "USD")!.netPaid.amount).toBe(5000);
  });

  it("11 — multiple channel identities: none of their identifiers reach the payload", async () => {
    const r = JSON.stringify(await insights(orgA, ids.cMulti));
    for (const secret of ["fb-psid-SECRET-1", "tg-SECRET-2", "sophea.fb", "sophea_tg"]) {
      expect(r).not.toContain(secret);
    }
  });
});

describe("13–15 — tenant isolation", () => {
  it("Org A's figures exclude every planted Org B row (orders, lines, payments, deliveries, returns)", async () => {
    const r = await insights(orgA, ids.cMulti);
    const text = JSON.stringify(r);
    expect(text).not.toContain("LEAK");
    expect(text).not.toContain("TELEGRAM");
    expect(text).not.toContain("bank_transfer");
    expect(r.activity.orderCount).toBe(3);
    expect(r.activity.unitsPurchased).toBe(5);
    if (r.delivery.status !== "available" || r.returns.status !== "available")
      throw new Error("unreachable");
    expect(r.delivery.data.failedAttemptCount).toBe(1);
    expect(r.returns.data.returnCount).toBe(2);
  });

  it("Org A's customer asked for under Org B is not found — even though a corrupt Org B order points at it", async () => {
    await expect(insights(orgB, ids.cMulti)).rejects.toMatchObject({
      statusCode: 404,
      message: "Customer not found",
    });
  });

  it("14 — one user in two organizations: each context sees only its own organization", async () => {
    const asA = await available(
      asRole("service_role", () => getCustomerInsights(ctx(orgA, ALL, actor), ids.cMulti)),
    );
    expect(asA.activity.orderCount).toBe(3);
    const asB = await available(
      asRole("service_role", () => getCustomerInsights(ctx(orgB, ALL, actor), ids.cB)),
    );
    expect(asB.activity.orderCount).toBe(1);
    expect(asB.topProducts.map((p) => p.label)).toEqual(["Org B product"]);
    // And the same user, in Org A, cannot reach Org B's customer.
    await expect(
      asRole("service_role", () => getCustomerInsights(ctx(orgA, ALL, actor), ids.cB)),
    ).rejects.toMatchObject({ statusCode: 404, message: "Customer not found" });
  });

  it("an unknown customer id is indistinguishable from another tenant's", async () => {
    await expect(insights(orgA, crypto.randomUUID())).rejects.toMatchObject({
      statusCode: 404,
      message: "Customer not found",
    });
  });
});

describe("17 — stable ordering", () => {
  it("a full tie on units, orders and recency falls to product id, every time", async () => {
    const expected = [ids.pX, ids.pY].sort();
    for (let i = 0; i < 3; i++) {
      const { topProducts } = await insights(orgA, ids.cTie);
      expect(topProducts.map((p) => p.productId)).toEqual(expected);
    }
  });
});

describe("18 — no message-body dependency", () => {
  it("the function reads no conversation or message relation", async () => {
    const def = (await one(`select pg_get_functiondef(to_regprocedure($1)) as d`, [SIGNATURE]))
      .d as string;
    expect(def).not.toMatch(/\bpublic\.(messages|conversations|conversation_\w+)\b/);
    expect(def).not.toMatch(/\bbody\b/);
  });

  it("the opaque conversation reference itself is not returned", async () => {
    expect(JSON.stringify(await insights(orgA, ids.cMulti))).not.toContain("conv-ref-OPAQUE");
  });
});

describe("19 — browser roles cannot reach 060", () => {
  for (const role of ["anon", "authenticated"]) {
    it(`${role} has no EXECUTE and is refused`, async () => {
      const priv = await one(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [
        role,
        SIGNATURE,
      ]);
      expect(priv.ok).toBe(false);
      await expect(
        asRole(role, () =>
          db.query(`select public.customer_purchase_profile_v1($1,$2,true,true,true,true,5)`, [
            orgA,
            ids.cMulti,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  }

  it("PUBLIC holds no EXECUTE either", async () => {
    const acl = await one(
      `select proacl::text as acl from pg_proc where oid = to_regprocedure($1)`,
      [SIGNATURE],
    );
    // An ACL entry for PUBLIC is written "=X/owner" (empty grantee).
    expect(acl.acl).not.toMatch(/(^|[{,])=X/);
    expect(acl.acl).not.toContain("anon=");
    expect(acl.acl).not.toContain("authenticated=");
  });
});

describe("20 — the service_role path works under restricted defaults", () => {
  it("service_role holds EXECUTE and every SELECT the function needs", async () => {
    const priv = await one(`select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [
      SIGNATURE,
    ]);
    expect(priv.ok).toBe(true);
    // Every assertion above already ran as service_role; run once more with
    // every section on to be explicit.
    const r = await insights(orgA, ids.cMulti);
    expect(r.money.status).toBe("available");
    expect(r.delivery.status).toBe("available");
    expect(r.returns.status).toBe("available");
    expect(r.payments.status).toBe("available");
  });
});

describe("authorization — sections the caller may not see are withheld, never zeroed", () => {
  it("customers.read + orders.read only: activity and products, nothing else", async () => {
    const r = await insights(orgA, ids.cMulti, ["customers.read", "orders.read"]);
    expect(r.activity.orderCount).toBe(3);
    expect(r.topProducts).toHaveLength(2);
    expect(r.money).toEqual({ status: "permission_denied" });
    expect(r.payments).toEqual({ status: "permission_denied" });
    expect(r.delivery).toEqual({ status: "permission_denied" });
    expect(r.returns).toEqual({ status: "permission_denied" });
  });

  it("money needs BOTH the financial boundary and customers.view_sensitive", async () => {
    const base = ["customers.read", "orders.read"];
    for (const extra of [["payments.reconcile"], ["customers.view_sensitive"]]) {
      const r = await insights(orgA, ids.cMulti, [...base, ...extra]);
      expect(r.money).toEqual({ status: "permission_denied" });
    }
    const r = await insights(orgA, ids.cMulti, [
      ...base,
      "payments.reconcile",
      "customers.view_sensitive",
    ]);
    expect(r.money.status).toBe("available");
  });

  it("without orders.read the read is refused before the database is asked", async () => {
    const before = transport.requests.length;
    await expect(insights(orgA, ids.cMulti, ["customers.read"])).rejects.toThrow(/orders\.read/);
    expect(transport.requests.length).toBe(before);
  });

  it("without customers.read the read is refused", async () => {
    await expect(insights(orgA, ids.cMulti, ["orders.read"])).rejects.toThrow(/customers\.read/);
  });
});

describe("deploy ordering — the app may ship before 060 is applied", () => {
  it("without the function the service answers 'unavailable', never zeros; with it, data again", async () => {
    await db.exec(`DROP FUNCTION ${SIGNATURE}`);
    try {
      const r = await asRole("service_role", () => getCustomerInsights(ctx(orgA), ids.cMulti));
      expect(r).toEqual({ status: "unavailable" });
    } finally {
      await db.exec(MIGRATION_060);
    }
    expect((await insights(orgA, ids.cMulti)).activity.orderCount).toBe(3);
  });
});
