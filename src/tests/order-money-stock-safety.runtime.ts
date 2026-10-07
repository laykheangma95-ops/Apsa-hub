/**
 * V1 money + stock safety — REAL SQL behaviour (PGlite, every migration applied).
 *
 * Nothing here matches SQL text. Every assertion executes the migrated RPCs
 * (create_order_v2, transition_order_status_v1, create_delivery_v1,
 * transition_delivery_status_v1, record_payment_v1) and reads back the rows
 * they wrote. The last block drives the production TypeScript service through
 * the same database.
 *
 * Each guarantee below has at least one assertion that fails if the mechanism
 * behind it is removed: the idempotency unique index, the fingerprint
 * comparison, the delivery fee in the total, the confirm SALE movement, the
 * cancel RETURN movement, the org-scoped lookups and the delivery transition
 * table.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "../server/auth/authorization";
import { khr, usd } from "../lib/money";
import { isOrderCurrencyMismatch } from "../lib/orders";
import {
  calculateCartTotals,
  checkoutBlock,
  lineKey,
  type CartDiscountInput,
  type CartLine,
} from "../lib/pos-cart";
import type { Money } from "../types";
import { financialFixture } from "./helpers/payment-order-fixture";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
type Json = Record<string, unknown>;

let f: Fixture;

const actorA2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const actorB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const orgK = "cccccccc-0000-4000-8000-000000000001";

interface Catalog {
  product: string;
  variant1: string; // 1500
  variant2: string; // 2500
  archived: string;
  location: string;
  customer: string;
}
let A: Catalog;
let B: Catalog;
let kVariant: string;

/** Audit rows the service tried to write (captured by the transport below). */
const audits: Json[] = [];

async function seedCatalog(org: string, tag: string): Promise<Catalog> {
  const product = crypto.randomUUID();
  const variant1 = crypto.randomUUID();
  const variant2 = crypto.randomUUID();
  const archived = crypto.randomUUID();
  const location = crypto.randomUUID();
  const customer = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,$3)`, [
    product,
    org,
    `ផលិតផល ${tag}`,
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,status) values
     ($1,$4,$5,$6||'-1','Red',1500,'ACTIVE'),
     ($2,$4,$5,$6||'-2','Blue',2500,'ACTIVE'),
     ($3,$4,$5,$6||'-3','Old',900,'ARCHIVED')`,
    [variant1, variant2, archived, org, product, tag],
  );
  await f.db.query(`insert into locations(id,organization_id,name) values($1,$2,$3)`, [
    location,
    org,
    `Shop ${tag}`,
  ]);
  await f.db.query(`insert into customers(id,organization_id,display_name) values($1,$2,$3)`, [
    customer,
    org,
    `Customer ${tag}`,
  ]);
  // Opening stock: 10 of each sellable variant at the shop.
  await f.db.query(
    `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
     values($1,$2,$3,$5,10,'initial'),($1,$2,$4,$5,10,'initial')`,
    [org, product, variant1, variant2, location],
  );
  return { product, variant1, variant2, archived, location, customer };
}

interface CreateArgs {
  org: string;
  actor: string | null;
  source: string;
  items: unknown;
  customer: string | null;
  location: string | null;
  discount: number | null;
  delivery: number | null;
  conv: string | null;
  key: string | null;
}

function createArgs(overrides: Partial<CreateArgs> = {}): CreateArgs {
  return {
    org: f.org,
    actor: f.actor,
    source: "POS",
    items: [{ variant_id: A.variant1, quantity: 1 }],
    customer: null,
    location: A.location,
    discount: 0,
    delivery: 0,
    conv: null,
    key: crypto.randomUUID(),
    ...overrides,
  };
}

async function create(args: CreateArgs): Promise<Json> {
  const result = await f.db.query<{ r: Json }>(
    `select create_order_v2($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) as r`,
    [
      args.org,
      args.actor,
      args.source,
      JSON.stringify(args.items),
      args.customer,
      args.location,
      args.discount,
      args.delivery,
      args.conv,
      args.key,
    ],
  );
  return result.rows[0]!.r;
}

async function rpc(name: string, args: unknown[]): Promise<Json> {
  return (await f.rpc(name, args)) as Json;
}

async function transition(org: string, order: string, from: string, to: string) {
  return rpc("transition_order_status_v1", [org, order, "lifecycle", from, to, f.actor, null]);
}

async function scalar<T = number>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await f.db.query<{ v: T }>(sql, params);
  return result.rows[0]!.v;
}

const orderCount = (org: string) =>
  scalar<number>("select count(*)::int as v from orders where organization_id=$1", [org]);
const itemCount = (org: string) =>
  scalar<number>("select count(*)::int as v from order_items where organization_id=$1", [org]);
const lastNumber = (org: string) =>
  scalar<number | null>(
    "select max(last_number)::int as v from order_number_sequences where organization_id=$1",
    [org],
  );
const movementCount = (org: string) =>
  scalar<number>("select count(*)::int as v from inventory_movements where organization_id=$1", [
    org,
  ]);
const onHand = (org: string, variant: string, location: string) =>
  scalar<number>(
    `select coalesce(sum(quantity_on_hand),0)::int as v from inventory_stock
     where organization_id=$1 and variant_id=$2 and location_id=$3`,
    [org, variant, location],
  );

async function orderRow(id: string) {
  return (
    await f.db.query<Json>(
      `select id,organization_id,order_number,lifecycle_status,payment_status,refund_status,
       fulfillment_status,currency,subtotal_minor,discount_minor,delivery_minor,total_minor,
       idempotency_key,created_by
       from orders where id=$1`,
      [id],
    )
  ).rows[0]!;
}

async function orderMovements(order: string) {
  return (
    await f.db.query<Json>(
      `select m.organization_id,m.variant_id,m.location_id,m.quantity_delta,m.movement_type::text,
       m.reference_type,m.reference_id
       from inventory_movements m join order_items oi on oi.id=m.reference_id
       where oi.order_id=$1 order by m.movement_type,oi.created_at,oi.id`,
      [order],
    )
  ).rows;
}

async function createConfirmed(
  overrides: Partial<CreateArgs> = {},
): Promise<{ id: string; number: string }> {
  const created = await create(createArgs(overrides));
  expect(created.status).toBe("success");
  const org = overrides.org ?? f.org;
  const confirmed = await transition(org, created.order_id as string, "draft", "confirmed");
  expect(confirmed.status).toBe("success");
  return { id: created.order_id as string, number: created.order_number as string };
}

beforeAll(async () => {
  f = await financialFixture();
  await f.db.query(
    "insert into auth.users(id,email) values($1,'a2@test.invalid'),($2,'b@test.invalid')",
    [actorA2, actorB],
  );
  await f.db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by,default_currency)
     values($1,'K','K','riel-k',$2,'KHR')`,
    [orgK, f.actor],
  );
  A = await seedCatalog(f.org, "A");
  B = await seedCatalog(f.orgB, "B");
  const kProduct = crypto.randomUUID();
  kVariant = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'អង្ករ')`, [
    kProduct,
    orgK,
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,name,price_amount,price_currency)
     values($1,$2,$3,'5kg',20000,'KHR')`,
    [kVariant, orgK, kProduct],
  );
}, 120000);

afterAll(async () => {
  await f?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER CREATION
// ═══════════════════════════════════════════════════════════════════════════

describe("A. normal create", () => {
  it("creates one draft order priced from the catalog, with no stock effect", async () => {
    const before = { movements: await movementCount(f.org), number: await lastNumber(f.org) };
    const result = await create(
      createArgs({
        items: [
          { variant_id: A.variant1, quantity: 2 },
          { variant_id: A.variant2, quantity: 1 },
        ],
      }),
    );
    expect(result.status).toBe("success");
    expect(result.replayed).toBe(false);
    expect(result.order_number).toMatch(/^APSA-\d{4}-\d{6}$/);
    const row = await orderRow(result.order_id as string);
    expect(row).toMatchObject({
      organization_id: f.org,
      lifecycle_status: "draft",
      payment_status: "unpaid",
      fulfillment_status: "unfulfilled",
      currency: "USD",
      subtotal_minor: 5500,
      discount_minor: 0,
      delivery_minor: 0,
      total_minor: 5500,
      created_by: f.actor,
    });
    const lines = (
      await f.db.query<Json>(
        "select variant_id,unit_price_minor,quantity,line_total_minor from order_items where order_id=$1 order by unit_price_minor",
        [result.order_id],
      )
    ).rows;
    expect(lines).toEqual([
      { variant_id: A.variant1, unit_price_minor: 1500, quantity: 2, line_total_minor: 3000 },
      { variant_id: A.variant2, unit_price_minor: 2500, quantity: 1, line_total_minor: 2500 },
    ]);
    // Draft does not consume stock (migration 026 semantics).
    expect(await movementCount(f.org)).toBe(before.movements);
    expect(await lastNumber(f.org)).toBe((before.number ?? 0) + 1);
  });
});

describe("B. same idempotency key replay", () => {
  it("returns the existing order without a second order, number, line or movement", async () => {
    const args = createArgs({ items: [{ variant_id: A.variant2, quantity: 3 }] });
    const first = await create(args);
    expect(first.status).toBe("success");
    const snapshot = {
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
      movements: await movementCount(f.org),
    };

    for (let i = 0; i < 3; i++) {
      const replay = await create(args);
      expect(replay).toEqual({
        status: "success",
        replayed: true,
        order_id: first.order_id,
        order_number: first.order_number,
      });
    }
    expect({
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
      movements: await movementCount(f.org),
    }).toEqual(snapshot);
    expect(
      await scalar("select count(*)::int as v from orders where idempotency_key=$1", [args.key]),
    ).toBe(1);
  });

  it("a logically identical request (UUID case, key order, extra keys) is the same request", async () => {
    const args = createArgs({ items: [{ variant_id: A.variant1, quantity: 1 }] });
    const first = await create(args);
    const replay = await create({
      ...args,
      items: [{ quantity: 1, variant_id: A.variant1.toUpperCase(), note: "ignored" }],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.order_id).toBe(first.order_id);
  });

  it("replay still returns the order after its variant is archived (lookup precedes catalog checks)", async () => {
    const product = crypto.randomUUID();
    const variant = crypto.randomUUID();
    await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'x')`, [
      product,
      f.org,
    ]);
    await f.db.query(
      `insert into product_variants(id,organization_id,product_id,price_amount) values($1,$2,$3,700)`,
      [variant, f.org, product],
    );
    const args = createArgs({ items: [{ variant_id: variant, quantity: 1 }] });
    const first = await create(args);
    await f.db.query("update product_variants set status='ARCHIVED' where id=$1", [variant]);
    const replay = await create(args);
    expect(replay).toMatchObject({ status: "success", replayed: true, order_id: first.order_id });
  });

  it("the unique index itself refuses a second order under one (organization, key)", async () => {
    const args = createArgs();
    const first = await create(args);
    const row = await orderRow(first.order_id as string);
    await expect(
      f.db.query(
        `insert into orders(organization_id,order_number,source,currency,subtotal_minor,total_minor,
         idempotency_key,idempotency_fingerprint) values($1,'DUP-1','POS','USD',0,0,$2,'x')`,
        [f.org, row.idempotency_key],
      ),
    ).rejects.toThrow(/uniq_orders_idempotency_key_per_org|duplicate key/);
  });
});

describe("C. same key + different payload", () => {
  it("is an explicit conflict carrying nothing about the stored order, and mutates nothing", async () => {
    const args = createArgs({ items: [{ variant_id: A.variant1, quantity: 1 }] });
    const first = await create(args);
    expect(first.status).toBe("success");
    const snapshot = {
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
    };

    const variants: Partial<CreateArgs>[] = [
      { items: [{ variant_id: A.variant2, quantity: 3 }] }, // product B × 3
      { items: [{ variant_id: A.variant1, quantity: 2 }] }, // quantity only
      { discount: 100 },
      { delivery: 150 },
      { customer: A.customer },
      { location: null },
      { source: "MANUAL" },
      { conv: "conversation-1" },
      {
        items: [
          { variant_id: A.variant1, quantity: 1 },
          { variant_id: A.variant1, quantity: 1 },
        ],
      },
    ];
    for (const change of variants) {
      const result = await create({ ...args, ...change });
      expect(result).toEqual({ status: "idempotency_conflict" });
    }
    expect({
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
    }).toEqual(snapshot);
  });

  it("another member of the same organization cannot retrieve an order by reusing its key", async () => {
    const args = createArgs();
    const first = await create(args);
    const other = await create({ ...args, actor: actorA2 });
    expect(other).toEqual({ status: "idempotency_conflict" });
    expect(JSON.stringify(other)).not.toContain(first.order_id as string);
  });
});

describe("D. different key", () => {
  it("creates a new order with the next order number", async () => {
    const args = createArgs();
    const first = await create(args);
    const second = await create({ ...args, key: crypto.randomUUID() });
    expect(second.status).toBe("success");
    expect(second.replayed).toBe(false);
    expect(second.order_id).not.toBe(first.order_id);
    const n = (x: Json) => Number(String(x.order_number).slice(-6));
    expect(n(second)).toBe(n(first) + 1);
  });
});

describe("E. different organizations, same key", () => {
  it("never collide: each organization gets its own order", async () => {
    const key = crypto.randomUUID();
    const inA = await create(createArgs({ key }));
    const inB = await create(
      createArgs({
        key,
        org: f.orgB,
        actor: actorB,
        items: [{ variant_id: B.variant1, quantity: 1 }],
        location: B.location,
      }),
    );
    expect(inA).toMatchObject({ status: "success", replayed: false });
    expect(inB).toMatchObject({ status: "success", replayed: false });
    expect(inB.order_id).not.toBe(inA.order_id);
    expect((await orderRow(inB.order_id as string)).organization_id).toBe(f.orgB);
  });
});

describe("F. unauthorized tenant references", () => {
  it("Org A cannot price, attach or stock-locate Org B's catalog, customer or location", async () => {
    const before = { orders: await orderCount(f.org), number: await lastNumber(f.org) };
    expect(await create(createArgs({ items: [{ variant_id: B.variant1, quantity: 1 }] }))).toEqual({
      status: "variant_not_found",
      variant_id: B.variant1,
    });
    expect(await create(createArgs({ customer: B.customer }))).toEqual({
      status: "customer_not_found",
    });
    expect(await create(createArgs({ location: B.location }))).toEqual({
      status: "location_not_found",
    });
    expect({ orders: await orderCount(f.org), number: await lastNumber(f.org) }).toEqual(before);
  });

  it("Org A replaying Org B's key never receives Org B's order", async () => {
    const key = crypto.randomUUID();
    const bArgs = createArgs({
      key,
      org: f.orgB,
      actor: actorB,
      items: [{ variant_id: B.variant2, quantity: 1 }],
      location: B.location,
    });
    const inB = await create(bArgs);
    // Exact same payload, aimed from Org A: B's location and variant are
    // invisible to A, so it is refused as not-found before any lookup by key
    // could matter — and the key lookup itself is org-scoped regardless.
    const aimed = await create({ ...bArgs, org: f.org, actor: f.actor });
    expect(aimed.status).toMatch(/^(location|variant)_not_found$/);
    expect(JSON.stringify(aimed)).not.toContain(inB.order_id as string);
    // With A's own basket the key simply names a new, separate A order.
    const own = await create(createArgs({ key }));
    expect(own.status).toBe("success");
    expect(own.order_id).not.toBe(inB.order_id);
  });
});

describe("G. variant price authority", () => {
  it("prices every line from its own variant and ignores any caller-stated price", async () => {
    const result = await create(
      createArgs({
        items: [
          { variant_id: A.variant1, quantity: 1, unit_price_minor: 1, price: 1, total_minor: 1 },
          { variant_id: A.variant2, quantity: 2, product_id: A.product },
        ],
      }),
    );
    const row = await orderRow(result.order_id as string);
    expect(row.subtotal_minor).toBe(1500 + 5000);
    expect(row.total_minor).toBe(6500);
  });

  it("rejects an archived variant, a product/variant mismatch and non-integer quantities", async () => {
    expect(
      (await create(createArgs({ items: [{ variant_id: A.archived, quantity: 1 }] }))).status,
    ).toBe("variant_not_sellable");
    expect(
      (
        await create(
          createArgs({
            items: [{ variant_id: A.variant1, quantity: 1, product_id: B.product }],
          }),
        )
      ).status,
    ).toBe("product_variant_mismatch");
    for (const quantity of [0, -1, 1.5, "2"]) {
      expect(
        (await create(createArgs({ items: [{ variant_id: A.variant1, quantity }] }))).status,
      ).toBe("invalid_quantity");
    }
  });
});

describe("H. discount authority", () => {
  it("subtracts a bounded discount and rejects negative or oversized ones", async () => {
    const ok = await create(createArgs({ discount: 500 }));
    expect(await orderRow(ok.order_id as string)).toMatchObject({
      subtotal_minor: 1500,
      discount_minor: 500,
      total_minor: 1000,
    });
    expect((await create(createArgs({ discount: -1 }))).status).toBe("invalid_discount");
    expect((await create(createArgs({ discount: null }))).status).toBe("invalid_discount");
    expect((await create(createArgs({ discount: 1501 }))).status).toBe("discount_exceeds_subtotal");
  });
});

describe("I. delivery fee is part of the order total", () => {
  it("total = subtotal - discount + delivery fee, stored and DB-constrained", async () => {
    const result = await create(
      createArgs({
        items: [
          { variant_id: A.variant1, quantity: 2 },
          { variant_id: A.variant2, quantity: 1 },
        ],
        discount: 500,
        delivery: 250,
      }),
    );
    const row = await orderRow(result.order_id as string);
    expect(row).toMatchObject({
      subtotal_minor: 5500,
      discount_minor: 500,
      delivery_minor: 250,
      total_minor: 5250,
    });
    // orders_total_is_derived + the immutability trigger: the stored total
    // cannot be rewritten afterwards, not even by a privileged write.
    await expect(
      f.db.query("update orders set total_minor=5000 where id=$1", [row.id]),
    ).rejects.toThrow();
    await expect(
      f.db.query("update orders set delivery_minor=0,total_minor=5000 where id=$1", [row.id]),
    ).rejects.toThrow(/immutable/);
    expect((await orderRow(row.id as string)).total_minor).toBe(5250);
  });

  it("a delivery fee may exceed the goods subtotal, and the currency bound is inclusive", async () => {
    const big = await create(createArgs({ delivery: 100000 }));
    expect((await orderRow(big.order_id as string)).total_minor).toBe(101500);
    const riel = await create(
      createArgs({
        org: orgK,
        items: [{ variant_id: kVariant, quantity: 1 }],
        location: null,
        delivery: 4000000,
      }),
    );
    expect(await orderRow(riel.order_id as string)).toMatchObject({
      currency: "KHR",
      delivery_minor: 4000000,
      total_minor: 4020000,
    });
  });

  it("the delivery fee is owed exactly like goods: paying only the goods leaves the order pending", async () => {
    const result = await create(createArgs({ delivery: 300 }));
    const order = result.order_id as string;
    await f.verify(await f.record(1500, "cash", null, order));
    expect((await f.state(order)).payment_status).toBe("pending");
    await f.verify(await f.record(300, "cash", null, order));
    expect((await f.state(order)).payment_status).toBe("paid");
  });
});

describe("J. invalid delivery fee / key", () => {
  it("rejects negative, missing and out-of-bound fees before any write", async () => {
    const before = { orders: await orderCount(f.org), number: await lastNumber(f.org) };
    for (const delivery of [-1, null, 100001]) {
      expect(await create(createArgs({ delivery }))).toEqual({ status: "invalid_delivery_fee" });
    }
    expect(
      await create(
        createArgs({
          org: orgK,
          items: [{ variant_id: kVariant, quantity: 1 }],
          location: null,
          delivery: 4000001,
        }),
      ),
    ).toEqual({ status: "invalid_delivery_fee" });
    expect({ orders: await orderCount(f.org), number: await lastNumber(f.org) }).toEqual(before);
  });

  it("requires a well-formed idempotency key", async () => {
    for (const key of [null, "", "short", "has spaces in it!!", "x".repeat(129)]) {
      expect(await create(createArgs({ key }))).toEqual({ status: "invalid_idempotency_key" });
    }
    // The table refuses a malformed key or a key without its fingerprint too.
    await expect(
      f.db.query(
        `insert into orders(organization_id,order_number,source,currency,subtotal_minor,total_minor,
         idempotency_key) values($1,'BAD-1','POS','USD',0,0,$2)`,
        [f.org, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/orders_idempotency_pair/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════════════════════

describe("Inventory: confirm / replay / cancel", () => {
  it("confirm writes one SALE per line for the exact variant, quantity, org and location", async () => {
    const created = await create(
      createArgs({
        items: [
          { variant_id: A.variant1, quantity: 2 },
          { variant_id: A.variant2, quantity: 3 },
        ],
      }),
    );
    const order = created.order_id as string;
    const stock1 = await onHand(f.org, A.variant1, A.location);
    const stock2 = await onHand(f.org, A.variant2, A.location);
    expect(await orderMovements(order)).toEqual([]);

    const confirmed = await transition(f.org, order, "draft", "confirmed");
    expect(confirmed).toMatchObject({ status: "success", stock_movements: 2 });
    const movements = await orderMovements(order);
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m).toMatchObject({
        organization_id: f.org,
        location_id: A.location,
        movement_type: "sale",
        reference_type: "order_item",
      });
    }
    expect(movements.map((m) => [m.variant_id, m.quantity_delta]).sort()).toEqual(
      [
        [A.variant1, -2],
        [A.variant2, -3],
      ].sort(),
    );
    expect(await onHand(f.org, A.variant1, A.location)).toBe(stock1 - 2);
    expect(await onHand(f.org, A.variant2, A.location)).toBe(stock2 - 3);

    // Replayed confirmation: refused by the status gate, ledger untouched.
    const total = await movementCount(f.org);
    expect((await transition(f.org, order, "draft", "confirmed")).status).toBe("stale");
    expect((await transition(f.org, order, "confirmed", "confirmed")).status).toBe("no_change");
    expect(await movementCount(f.org)).toBe(total);

    // Replaying the CREATE after confirmation returns the same order and moves nothing.
    const replay = await create(
      createArgs({
        key: (await orderRow(order)).idempotency_key as string,
        items: [
          { variant_id: A.variant1, quantity: 2 },
          { variant_id: A.variant2, quantity: 3 },
        ],
      }),
    );
    expect(replay).toMatchObject({ replayed: true, order_id: order });
    expect(await movementCount(f.org)).toBe(total);

    // Cancel: one compensating RETURN per consumed line; stock restored.
    const cancelled = await transition(f.org, order, "confirmed", "cancelled");
    expect(cancelled).toMatchObject({ status: "success", stock_movements: 2 });
    const returns = (await orderMovements(order)).filter((m) => m.movement_type === "return");
    expect(returns.map((m) => [m.variant_id, m.quantity_delta]).sort()).toEqual(
      [
        [A.variant1, 2],
        [A.variant2, 3],
      ].sort(),
    );
    expect(await onHand(f.org, A.variant1, A.location)).toBe(stock1);
    expect(await onHand(f.org, A.variant2, A.location)).toBe(stock2);
    expect(await orderRow(order)).toMatchObject({
      lifecycle_status: "cancelled",
      fulfillment_status: "cancelled",
    });

    // Replayed cancel: no second restock.
    const after = await movementCount(f.org);
    expect((await transition(f.org, order, "confirmed", "cancelled")).status).toBe("stale");
    expect((await transition(f.org, order, "cancelled", "cancelled")).status).toBe("no_change");
    expect(await movementCount(f.org)).toBe(after);
  });

  it("cancelling a draft writes no movement (it never consumed stock)", async () => {
    const created = await create(createArgs());
    const before = await movementCount(f.org);
    expect(
      (await transition(f.org, created.order_id as string, "draft", "cancelled")).stock_movements,
    ).toBe(0);
    expect(await movementCount(f.org)).toBe(before);
  });

  it("two lines of the same variant are two movements, not one deduplicated", async () => {
    const { id } = await createConfirmed({
      items: [
        { variant_id: A.variant1, quantity: 1 },
        { variant_id: A.variant1, quantity: 4 },
      ],
    });
    const deltas = (await orderMovements(id)).map((m) => m.quantity_delta).sort();
    expect(deltas).toEqual([-1, -4].sort());
  });

  it("negative stock policy is preserved: confirming more than on hand succeeds and goes negative", async () => {
    const product = crypto.randomUUID();
    const variant = crypto.randomUUID();
    await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'y')`, [
      product,
      f.org,
    ]);
    await f.db.query(
      `insert into product_variants(id,organization_id,product_id,price_amount) values($1,$2,$3,100)`,
      [variant, f.org, product],
    );
    await f.db.query(
      `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
       values($1,$2,$3,$4,3,'initial')`,
      [f.org, product, variant, A.location],
    );
    await createConfirmed({ items: [{ variant_id: variant, quantity: 5 }] });
    expect(await onHand(f.org, variant, A.location)).toBe(-2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY
// ═══════════════════════════════════════════════════════════════════════════

async function createDelivery(org: string, order: string, cod: number | null = null) {
  return rpc("create_delivery_v1", [org, order, f.actor, null, null, null, "Courier", null, cod]);
}
async function moveDelivery(org: string, delivery: string, from: string, to: string) {
  // Since migration 054 only a packed order's delivery may become 'ready'; these
  // money/stock tests are not about packing, so the '→ ready' step is the one
  // Mark Packed makes (tagged with the reserved packed marker).
  const reason = to === "ready" ? "pack_order_packed" : null;
  return rpc("transition_delivery_status_v1", [org, delivery, from, to, f.actor, reason]);
}
async function money(order: string) {
  return (
    await f.db.query<Json>(
      `select subtotal_minor,discount_minor,delivery_minor,total_minor,currency,
       payment_status,refund_status from orders where id=$1`,
      [order],
    )
  ).rows[0]!;
}

describe("Delivery lifecycle", () => {
  it("requires a confirmed order and one active delivery at a time", async () => {
    const draft = await create(createArgs());
    expect((await createDelivery(f.org, draft.order_id as string)).status).toBe(
      "order_not_confirmed",
    );
    const { id } = await createConfirmed();
    const first = await createDelivery(f.org, id);
    expect(first.status).toBe("success");
    expect((await createDelivery(f.org, id)).status).toBe("duplicate_active");
  });

  it("walks the valid chain with history, drives fulfillment, and never touches stock, payment or totals", async () => {
    const { id } = await createConfirmed({
      items: [{ variant_id: A.variant2, quantity: 1 }],
      delivery: 200,
    });
    await f.verify(await f.record(1000, "cash", null, id)); // part-paid
    const moneyBefore = await money(id);
    const movementsBefore = await movementCount(f.org);

    const created = await createDelivery(f.org, id, 1700);
    const delivery = created.delivery_id as string;
    expect((await orderRow(id)).fulfillment_status).toBe("processing");
    const chain = ["pending", "preparing", "ready", "in_transit", "delivered"];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(await moveDelivery(f.org, delivery, chain[i]!, chain[i + 1]!)).toMatchObject({
        status: "success",
        from: chain[i],
        to: chain[i + 1],
      });
    }
    const history = (
      await f.db.query<Json>(
        `select from_status::text,to_status::text from delivery_status_history
         where delivery_id=$1 order by created_at,id`,
        [delivery],
      )
    ).rows.map((r) => `${r.from_status ?? "∅"}→${r.to_status}`);
    expect(history.sort()).toEqual(
      [
        "∅→pending",
        "pending→preparing",
        "preparing→ready",
        "ready→in_transit",
        "in_transit→delivered",
      ].sort(),
    );
    expect((await orderRow(id)).fulfillment_status).toBe("fulfilled");
    expect(await movementCount(f.org)).toBe(movementsBefore);
    expect(await money(id)).toEqual(moneyBefore);
    expect(moneyBefore.payment_status).toBe("pending");

    // COD stays its own operational amount in the order's currency; the
    // order total (goods + delivery fee) is untouched by it.
    const cod = (
      await f.db.query<Json>("select cod_amount_minor,cod_currency from deliveries where id=$1", [
        delivery,
      ])
    ).rows[0]!;
    expect(cod).toEqual({ cod_amount_minor: 1700, cod_currency: "USD" });
    expect(moneyBefore.total_minor).toBe(2700);

    // Terminal: nothing moves after delivered.
    expect((await moveDelivery(f.org, delivery, "delivered", "cancelled")).status).toBe("terminal");
  });

  it("rejects skipped, backwards and stale transitions without writing history", async () => {
    const { id } = await createConfirmed();
    const delivery = (await createDelivery(f.org, id)).delivery_id as string;
    const historyCount = () =>
      scalar("select count(*)::int as v from delivery_status_history where delivery_id=$1", [
        delivery,
      ]);
    const before = await historyCount();
    expect((await moveDelivery(f.org, delivery, "pending", "delivered")).status).toBe(
      "invalid_transition",
    );
    expect((await moveDelivery(f.org, delivery, "pending", "in_transit")).status).toBe(
      "invalid_transition",
    );
    expect((await moveDelivery(f.org, delivery, "pending", "failed")).status).toBe(
      "invalid_transition",
    );
    expect((await moveDelivery(f.org, delivery, "ready", "in_transit")).status).toBe("stale");
    expect(await moveDelivery(f.org, delivery, "pending", "preparing")).toMatchObject({
      status: "success",
    });
    expect((await moveDelivery(f.org, delivery, "preparing", "pending")).status).toBe(
      "invalid_transition",
    );
    expect(await historyCount()).toBe(before + 1);
  });

  it("a cancelled delivery returns fulfillment to unfulfilled, and a cancelled order freezes delivery", async () => {
    const { id } = await createConfirmed();
    const delivery = (await createDelivery(f.org, id)).delivery_id as string;
    expect((await moveDelivery(f.org, delivery, "pending", "cancelled")).status).toBe("success");
    expect((await orderRow(id)).fulfillment_status).toBe("unfulfilled");

    const other = await createConfirmed();
    const d2 = (await createDelivery(f.org, other.id)).delivery_id as string;
    expect((await transition(f.org, other.id, "confirmed", "cancelled")).status).toBe("success");
    expect((await moveDelivery(f.org, d2, "pending", "preparing")).status).toBe("order_terminal");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-TENANT
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-tenant: Org A against Org B", () => {
  it("cannot confirm or cancel Org B's order, and Org B's stock does not move", async () => {
    const bArgs = {
      org: f.orgB,
      actor: actorB,
      items: [{ variant_id: B.variant1, quantity: 2 }],
      location: B.location,
    };
    const draft = await create(createArgs(bArgs));
    const bStock = await onHand(f.orgB, B.variant1, B.location);
    const bMovements = await movementCount(f.orgB);
    expect(await transition(f.org, draft.order_id as string, "draft", "confirmed")).toEqual({
      status: "not_found",
    });
    expect((await orderRow(draft.order_id as string)).lifecycle_status).toBe("draft");

    const confirmed = await createConfirmed(bArgs);
    const afterConfirm = await movementCount(f.orgB);
    expect(await transition(f.org, confirmed.id, "confirmed", "cancelled")).toEqual({
      status: "not_found",
    });
    expect((await orderRow(confirmed.id)).lifecycle_status).toBe("confirmed");
    expect(await movementCount(f.orgB)).toBe(afterConfirm);
    expect(afterConfirm).toBe(bMovements + 1);
    expect(await onHand(f.orgB, B.variant1, B.location)).toBe(bStock - 2);
  });

  it("cannot write Org B's stock ledger, even with a direct privileged insert", async () => {
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type)
         values($1,$2,$3,5,'manual_adjustment')`,
        [f.org, B.product, B.variant1],
      ),
    ).rejects.toThrow();
  });

  it("cannot create or transition Org B's delivery", async () => {
    const { id } = await createConfirmed({
      org: f.orgB,
      actor: actorB,
      items: [{ variant_id: B.variant2, quantity: 1 }],
      location: B.location,
    });
    expect(await createDelivery(f.org, id)).toEqual({ status: "order_not_found" });
    const delivery = (await createDelivery(f.orgB, id)).delivery_id as string;
    expect(await moveDelivery(f.org, delivery, "pending", "preparing")).toEqual({
      status: "not_found",
    });
    const status = await scalar<string>("select status::text as v from deliveries where id=$1", [
      delivery,
    ]);
    expect(status).toBe("pending");
  });

  it("cannot change Org B's delivery fee or totals through any write", async () => {
    const created = await create(
      createArgs({
        org: f.orgB,
        actor: actorB,
        items: [{ variant_id: B.variant1, quantity: 1 }],
        location: B.location,
        delivery: 300,
      }),
    );
    const before = await money(created.order_id as string);
    await expect(
      f.db.query("update orders set delivery_minor=0,total_minor=1500 where id=$1", [
        created.order_id,
      ]),
    ).rejects.toThrow(/immutable/);
    expect(await money(created.order_id as string)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATOMICITY — a failure injected mid-transaction leaves no partial state
// ═══════════════════════════════════════════════════════════════════════════

async function withFailingTrigger(
  table: string,
  condition: string,
  run: () => Promise<void>,
): Promise<void> {
  await f.db.exec(`
    CREATE FUNCTION public.test_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER test_inject_failure BEFORE INSERT ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.test_inject_failure();
  `);
  try {
    await run();
  } finally {
    await f.db.exec(`DROP TRIGGER test_inject_failure ON public.${table};
      DROP FUNCTION public.test_inject_failure();`);
  }
}

describe("Atomicity", () => {
  it("a create that fails on its second line leaves no order, no line, no number and no consumed key", async () => {
    const args = createArgs({
      items: [
        { variant_id: A.variant1, quantity: 1 },
        { variant_id: A.variant2, quantity: 1 },
      ],
    });
    const before = {
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
    };
    await withFailingTrigger("order_items", `NEW.variant_id = '${A.variant2}'`, async () => {
      await expect(create(args)).rejects.toThrow(/injected failure/);
    });
    expect({
      orders: await orderCount(f.org),
      items: await itemCount(f.org),
      number: await lastNumber(f.org),
    }).toEqual(before);
    // The key was not consumed: the retry creates the order, with no gap.
    const retry = await create(args);
    expect(retry).toMatchObject({ status: "success", replayed: false });
    expect(Number(String(retry.order_number).slice(-6))).toBe((before.number ?? 0) + 1);
  });

  it("a confirm whose second SALE fails leaves the order draft with no movement and no history", async () => {
    const created = await create(
      createArgs({
        items: [
          { variant_id: A.variant1, quantity: 1 },
          { variant_id: A.variant2, quantity: 1 },
        ],
      }),
    );
    const order = created.order_id as string;
    const history = () =>
      scalar("select count(*)::int as v from order_status_history where order_id=$1", [order]);
    const historyBefore = await history();
    await withFailingTrigger(
      "inventory_movements",
      `NEW.movement_type = 'sale' AND NEW.variant_id = '${A.variant2}'`,
      async () => {
        await expect(transition(f.org, order, "draft", "confirmed")).rejects.toThrow(
          /injected failure/,
        );
      },
    );
    expect((await orderRow(order)).lifecycle_status).toBe("draft");
    expect(await orderMovements(order)).toEqual([]);
    expect(await history()).toBe(historyBefore);
  });

  it("a cancel whose RETURN fails leaves the order confirmed and its stock consumed", async () => {
    const { id } = await createConfirmed({ items: [{ variant_id: A.variant1, quantity: 2 }] });
    const stock = await onHand(f.org, A.variant1, A.location);
    await withFailingTrigger("inventory_movements", `NEW.movement_type = 'return'`, async () => {
      await expect(transition(f.org, id, "confirmed", "cancelled")).rejects.toThrow(
        /injected failure/,
      );
    });
    expect(await orderRow(id)).toMatchObject({
      lifecycle_status: "confirmed",
      fulfillment_status: "unfulfilled",
    });
    expect(await onHand(f.org, A.variant1, A.location)).toBe(stock);
    expect((await orderMovements(id)).map((m) => m.movement_type)).toEqual(["sale"]);
  });

  it("a delivery transition whose history write fails changes neither delivery nor order", async () => {
    const { id } = await createConfirmed();
    const delivery = (await createDelivery(f.org, id)).delivery_id as string;
    await moveDelivery(f.org, delivery, "pending", "preparing");
    const orderHistory = () =>
      scalar("select count(*)::int as v from order_status_history where order_id=$1", [id]);
    const before = await orderHistory();
    await withFailingTrigger("delivery_status_history", `NEW.to_status = 'ready'`, async () => {
      await expect(moveDelivery(f.org, delivery, "preparing", "ready")).rejects.toThrow(
        /injected failure/,
      );
    });
    expect(
      await scalar<string>("select status::text as v from deliveries where id=$1", [delivery]),
    ).toBe("preparing");
    expect((await orderRow(id)).fulfillment_status).toBe("processing");
    expect(await orderHistory()).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION SERVICE through the same database
// ═══════════════════════════════════════════════════════════════════════════

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
        return {
          insert: async (row: Json) => {
            audits.push(row);
            return { error: null };
          },
        };
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

const transport = sqlTransport();
mock.module("../lib/supabase/server", () => ({ supabaseAdmin: transport }));

function context(org: string, user: string, permissions: string[]): AuthorizationContext {
  return {
    organizationId: org,
    userId: user,
    can: (key: string) => permissions.includes(key),
    require: (key: string) => {
      if (!permissions.includes(key)) {
        throw Object.assign(new Error(`Missing permission: ${key}`), { statusCode: 403 });
      }
    },
  } as unknown as AuthorizationContext;
}

describe("Order service through the real database", () => {
  const perms = ["orders.create", "orders.read", "orders.apply_discount"];

  it("a retried create returns the same order, writes one audit row, and carries the delivery fee", async () => {
    const service = await import("../server/orders/service");
    const ctx = context(f.org, f.actor, perms);
    const input = {
      source: "MANUAL" as const,
      items: [{ variantId: A.variant1, quantity: 2 }],
      deliveryMinor: 250,
      idempotencyKey: crypto.randomUUID(),
    };
    const auditsBefore = audits.length;
    const first = await service.createOrder(ctx, input);
    const second = await service.createOrder(ctx, input);
    expect(second.id).toBe(first.id);
    expect(second.orderNumber).toBe(first.orderNumber);
    expect(first.delivery).toEqual({ amount: 250, currency: "USD" });
    expect(first.total).toEqual({ amount: 3250, currency: "USD" });
    expect(audits.length).toBe(auditsBefore + 1);

    await expect(
      service.createOrder(ctx, { ...input, items: [{ variantId: A.variant2, quantity: 3 }] }),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
  });

  it("refuses a create without a valid key before touching the database", async () => {
    const service = await import("../server/orders/service");
    const ctx = context(f.org, f.actor, perms);
    const before = await orderCount(f.org);
    for (const idempotencyKey of [undefined, "", "nope"]) {
      await expect(
        service.createOrder(ctx, {
          source: "POS",
          items: [{ variantId: A.variant1, quantity: 1 }],
          idempotencyKey: idempotencyKey as unknown as string,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(
      service.createOrder(ctx, {
        source: "POS",
        items: [{ variantId: A.variant1, quantity: 1 }],
        deliveryMinor: 1.5,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await orderCount(f.org)).toBe(before);
  });

  it("the tenant is the context's: an injected organization id is ignored, Org B's variant is 404", async () => {
    const service = await import("../server/orders/service");
    const ctx = context(f.org, f.actor, perms);
    const created = await service.createOrder(ctx, {
      source: "POS",
      items: [{ variantId: A.variant1, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
      organizationId: f.orgB,
    } as Parameters<typeof service.createOrder>[1]);
    expect((await orderRow(created.id)).organization_id).toBe(f.org);

    await expect(
      service.createOrder(ctx, {
        source: "POS",
        items: [{ variantId: B.variant1, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creation still requires orders.create, and a discount still requires orders.apply_discount", async () => {
    const service = await import("../server/orders/service");
    const before = await orderCount(f.org);
    await expect(
      service.createOrder(context(f.org, f.actor, ["orders.read"]), {
        source: "POS",
        items: [{ variantId: A.variant1, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.createOrder(context(f.org, f.actor, ["orders.create", "orders.read"]), {
        source: "POS",
        items: [{ variantId: A.variant1, quantity: 1 }],
        discountMinor: 100,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await orderCount(f.org)).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POS MONEY — the cart preview agrees with the order the server persists
// ═══════════════════════════════════════════════════════════════════════════
//
// POS shows a total computed in the browser (calculateCartTotals) and sends the
// server exactly one money value: the discount, in the cart's own currency's
// minor units. The server prices the lines from the catalog and derives every
// total itself. These tests drive both halves through the real migrated SQL and
// require them to agree to the minor unit — and require the currency to
// survive end-to-end (a riel cart is never relabelled or converted to dollars).

describe("POS money: cart preview agrees with the persisted order", () => {
  const perms = ["orders.create", "orders.read", "orders.apply_discount"];
  let kFive: string; // KHR 5,000 in the riel organization
  let kUsdPriced: string; // a USD-priced variant inside the riel organization

  beforeAll(async () => {
    const product = crypto.randomUUID();
    kFive = crypto.randomUUID();
    kUsdPriced = crypto.randomUUID();
    await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'ទឹក')`, [
      product,
      orgK,
    ]);
    await f.db.query(
      `insert into product_variants(id,organization_id,product_id,name,price_amount,price_currency)
       values($1,$3,$4,'Bottle',5000,'KHR'),($2,$3,$4,'Imported',300,'USD')`,
      [kFive, kUsdPriced, orgK, product],
    );
  });

  function line(variantId: string, unitPrice: Money, quantity: number): CartLine {
    return {
      key: lineKey(variantId),
      productId: variantId,
      variantId,
      nameKm: "ផលិតផល",
      nameEn: "Product",
      sku: "SKU",
      quantity,
      unitPrice,
      stock: null,
    };
  }

  function discount(
    mode: "amount" | "percent",
    text: string,
    currency: "USD" | "KHR",
  ): CartDiscountInput {
    return { enabled: true, mode, text, currency };
  }

  /** What PosCheckoutSheet.completeReal sends, built from the cart exactly as it does. */
  async function checkout(org: string, lines: CartLine[], input: CartDiscountInput, key: string) {
    const service = await import("../server/orders/service");
    const totals = calculateCartTotals(lines, input);
    if (totals.kind !== "priced" || checkoutBlock(totals)) throw new Error("cart refused");
    const detail = await service.createOrder(context(org, f.actor, perms), {
      source: "POS",
      items: lines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity })),
      ...(totals.discount.amount > 0 ? { discountMinor: totals.discount.amount } : {}),
      idempotencyKey: key,
    });
    return { totals, detail };
  }

  it("L/USD: a percentage discount persists exactly the cents the cart showed", async () => {
    const lines = [line(A.variant1, usd(1500), 2), line(A.variant2, usd(2500), 1)];
    const { totals, detail } = await checkout(
      f.org,
      lines,
      discount("percent", "15", "USD"),
      crypto.randomUUID(),
    );
    // 15% of $55.00 = $8.25.
    expect(totals).toMatchObject({ subtotal: usd(5500), discount: usd(825), total: usd(4675) });
    expect(detail.currency).toBe("USD");
    expect(detail.subtotal).toEqual(usd(5500));
    expect(detail.discount).toEqual(usd(825));
    expect(detail.total).toEqual(usd(4675));
    expect(await orderRow(detail.id)).toMatchObject({
      currency: "USD",
      subtotal_minor: 5500,
      discount_minor: 825,
      total_minor: 4675,
    });
  });

  it("L/USD: a fixed dollars-and-cents discount persists as the same cents", async () => {
    const lines = [line(A.variant2, usd(2500), 2)];
    const { detail } = await checkout(
      f.org,
      lines,
      discount("amount", "5.25", "USD"),
      crypto.randomUUID(),
    );
    expect(await orderRow(detail.id)).toMatchObject({
      currency: "USD",
      subtotal_minor: 5000,
      discount_minor: 525,
      total_minor: 4475,
    });
  });

  it("L/KHR: 2 × ៛5,000 persists as KHR 10,000 — never relabelled as $100.00", async () => {
    const lines = [line(kFive, khr(5000), 2)];
    const { totals, detail } = await checkout(
      orgK,
      lines,
      discount("percent", "0", "KHR"),
      crypto.randomUUID(),
    );
    expect(totals).toMatchObject({ currency: "KHR", subtotal: khr(10000), total: khr(10000) });
    expect(detail.currency).toBe("KHR");
    expect(detail.subtotal).toEqual(khr(10000));
    expect(detail.total).toEqual(khr(10000));
    expect(detail.items[0]!.unitPrice).toEqual(khr(5000));
    expect(await orderRow(detail.id)).toMatchObject({
      currency: "KHR",
      subtotal_minor: 10000,
      discount_minor: 0,
      total_minor: 10000,
    });
  });

  it("L/KHR: percentage and fixed riel discounts persist as the riel the cart showed", async () => {
    const lines = [line(kFive, khr(5000), 2)];
    const pct = await checkout(orgK, lines, discount("percent", "15", "KHR"), crypto.randomUUID());
    expect(await orderRow(pct.detail.id)).toMatchObject({
      currency: "KHR",
      subtotal_minor: 10000,
      discount_minor: 1500,
      total_minor: 8500,
    });
    const fixed = await checkout(
      orgK,
      lines,
      discount("amount", "2,000", "KHR"),
      crypto.randomUUID(),
    );
    expect(fixed.totals).toMatchObject({ discount: khr(2000), total: khr(8000) });
    expect(await orderRow(fixed.detail.id)).toMatchObject({
      currency: "KHR",
      discount_minor: 2000,
      total_minor: 8000,
    });
  });

  it("H/I: a mixed-currency cart is refused by the cart, and the server refuses it too", async () => {
    const lines = [line(kFive, khr(5000), 1), line(kUsdPriced, usd(300), 1)];
    const totals = calculateCartTotals(lines, discount("percent", "", "KHR"));
    expect(totals.kind).toBe("mixed_currency");
    expect(checkoutBlock(totals)).toBe("mixed_currency");

    // Defence in depth: even a client that ignored the cart is refused, with
    // the message POS recognises — and no order row is written.
    const service = await import("../server/orders/service");
    const before = await orderCount(orgK);
    let caught: unknown;
    try {
      await service.createOrder(context(orgK, f.actor, perms), {
        source: "POS",
        items: lines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity })),
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 409 });
    expect(isOrderCurrencyMismatch(caught)).toBe(true);
    expect(await orderCount(orgK)).toBe(before);
  });

  it("J: a discount above the subtotal is refused by the cart, and by the server", async () => {
    const lines = [line(A.variant1, usd(1500), 1)];
    const totals = calculateCartTotals(lines, discount("amount", "15.01", "USD"));
    expect(totals).toMatchObject({ kind: "priced", discountProblem: "exceeds_subtotal" });
    expect(checkoutBlock(totals)).toBe("discount");

    const service = await import("../server/orders/service");
    const before = await orderCount(f.org);
    await expect(
      service.createOrder(context(f.org, f.actor, perms), {
        source: "POS",
        items: [{ variantId: A.variant1, quantity: 1 }],
        discountMinor: 1501,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await orderCount(f.org)).toBe(before);
  });

  it("M: a retried POS checkout returns the same order and money; a changed discount under the same key is a conflict", async () => {
    const lines = [line(kFive, khr(5000), 2)];
    const key = crypto.randomUUID();
    const before = await orderCount(orgK);
    const first = await checkout(orgK, lines, discount("percent", "10", "KHR"), key);
    const replay = await checkout(orgK, lines, discount("percent", "10", "KHR"), key);
    expect(replay.detail.id).toBe(first.detail.id);
    expect(replay.detail.total).toEqual(first.detail.total);
    expect(first.detail.total).toEqual(khr(9000));
    expect(await orderCount(orgK)).toBe(before + 1);

    await expect(
      checkout(orgK, lines, discount("percent", "20", "KHR"), key),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    expect(await orderCount(orgK)).toBe(before + 1);
  });
});
