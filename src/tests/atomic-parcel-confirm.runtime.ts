/**
 * APSA Parcel is created ATOMICALLY with order confirmation — REAL SQL
 * (PGlite, every migration applied). CORRECTION-003 / migration 057.
 *
 * Nothing here matches SQL text: each assertion drives the migrated
 * transition_order_status_v1 and reads back the rows it wrote.
 *
 *   - confirm → exactly one active parcel, valid APSA:PCL:v1 code, returned
 *   - a parcel-write failure rolls back the WHOLE confirmation: lifecycle,
 *     stock 'sale' movements and status history
 *   - an existing active parcel is reused, never duplicated
 *   - migration 058 backfills historical confirmed/completed orders once and is
 *     idempotent; draft/cancelled orders get nothing
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { financialFixture } from "./helpers/payment-order-fixture";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
let f: Fixture;
const CODE_RE = /^APSA:PCL:v1:[A-Za-z0-9_-]{22}$/;

let variant: string;
let product: string;

beforeAll(async () => {
  f = await financialFixture();
  product = crypto.randomUUID();
  variant = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'ផលិតផល')`, [
    product,
    f.org,
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency,status)
     values($1,$2,$3,'SKU-ATOMIC','Std',1500,'USD','ACTIVE')`,
    [variant, f.org, product],
  );
});
afterAll(async () => {
  await f.close();
});

/** A draft order with one stocked line, ready to confirm. */
async function draftOrder(): Promise<string> {
  const id = await f.newOrder();
  await f.db.query(
    `insert into order_items(organization_id,order_id,product_id,variant_id,product_name_snapshot,
       unit_price_minor,quantity,line_total_minor)
     values($1,$2,$3,$4,'Iced Coffee',1500,2,3000)`,
    [f.org, id, product, variant],
  );
  return id;
}

async function confirm(orderId: string) {
  return f.rpc("transition_order_status_v1", [
    f.org,
    orderId,
    "lifecycle",
    "draft",
    "confirmed",
    f.actor,
    null,
  ]);
}

async function snapshot(orderId: string) {
  const one = async (sql: string) =>
    Number((await f.db.query<{ n: number }>(sql, [orderId])).rows[0]!.n);
  return {
    lifecycle: (
      await f.db.query<{ s: string }>(`select lifecycle_status::text s from orders where id=$1`, [
        orderId,
      ])
    ).rows[0]!.s,
    parcels: await one(`select count(*)::int n from parcels where order_id=$1 and status<>'void'`),
    movements: await one(
      `select count(*)::int n from inventory_movements m join order_items i
         on m.reference_type='order_item' and m.reference_id=i.id where i.order_id=$1`,
    ),
    history: await one(`select count(*)::int n from order_status_history where order_id=$1`),
  };
}

describe("migration 057 — confirmation creates the APSA Parcel atomically", () => {
  it("parcel always exists after confirmation, and the RPC returns it", async () => {
    const id = await draftOrder();
    const result = await confirm(id);
    expect(result.status).toBe("success");
    const after = await snapshot(id);
    expect(after.lifecycle).toBe("confirmed");
    expect(after.parcels).toBe(1);
    const row = (
      await f.db.query<{ id: string; parcel_code: string }>(
        `select id, parcel_code from parcels where order_id=$1`,
        [id],
      )
    ).rows[0]!;
    expect(row.parcel_code).toMatch(CODE_RE);
    expect(result.parcel_id).toBe(row.id);
    expect(result.parcel_code).toBe(row.parcel_code);
  });

  it("parcel generation failure rolls back confirmation, stock and history", async () => {
    const id = await draftOrder();
    const before = await snapshot(id);
    await f.db.exec(`
      create function test_block_parcel() returns trigger language plpgsql as $$
      begin raise exception 'parcel write failed (test)'; end $$;
      create trigger test_block_parcel before insert on parcels
        for each row execute function test_block_parcel();`);
    try {
      await expect(confirm(id)).rejects.toThrow(/parcel write failed/);
    } finally {
      await f.db.exec(`drop trigger test_block_parcel on parcels;
        drop function test_block_parcel();`);
    }
    expect(await snapshot(id)).toEqual(before);
    expect(before.lifecycle).toBe("draft");
    expect(before.parcels).toBe(0);

    // Recovers cleanly once the parcel can be written.
    expect((await confirm(id)).status).toBe("success");
    const after = await snapshot(id);
    expect(after.lifecycle).toBe("confirmed");
    expect(after.parcels).toBe(1);
    expect(after.movements).toBeGreaterThan(before.movements);
  });

  it("an existing active parcel is reused — never a duplicate", async () => {
    const id = await draftOrder();
    await f.db.query(
      `insert into parcels(organization_id,order_id,parcel_code,status)
       values($1,$2,'APSA:PCL:v1:PreexistingParcel_00001','created')`,
      [f.org, id],
    );
    const result = await confirm(id);
    expect(result.parcel_code).toBe("APSA:PCL:v1:PreexistingParcel_00001");
    expect((await snapshot(id)).parcels).toBe(1);
  });

  it("a refused confirmation (stale) creates no parcel", async () => {
    const id = await draftOrder();
    await confirm(id);
    const again = await confirm(id);
    expect(again.status).not.toBe("success");
    expect((await snapshot(id)).parcels).toBe(1);
  });

  it("other transitions never create a parcel", async () => {
    const id = await draftOrder();
    const cancelled = await f.rpc("transition_order_status_v1", [
      f.org,
      id,
      "lifecycle",
      "draft",
      "cancelled",
      f.actor,
      "test",
    ]);
    expect(cancelled.status).toBe("success");
    expect((await snapshot(id)).parcels).toBe(0);
  });

  it("generated codes are well-formed and distinct", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = (await f.db.query<{ c: string }>(`select public.new_apsa_parcel_code_v1() c`))
        .rows[0]!.c;
      expect(code).toMatch(CODE_RE);
      codes.add(code);
    }
    expect(codes.size).toBe(50);
  });
});

describe("migration 058 — historical backfill (separate from runtime)", () => {
  it("backfills confirmed/completed orders once, idempotently; draft/cancelled untouched", async () => {
    const confirmed = await f.newOrder();
    const completed = await f.newOrder();
    const draft = await f.newOrder();
    // Historical rows written before 057 existed: confirmed without a parcel.
    await f.db.query(`update orders set lifecycle_status='confirmed' where id=$1;`, [confirmed]);
    await f.db.query(`update orders set lifecycle_status='completed' where id=$1`, [completed]);

    const backfill = readFileSync("supabase/migrations/058_backfill_apsa_parcels.sql", "utf8");
    await f.db.exec(backfill);
    await f.db.exec(backfill);

    const count = async (id: string) =>
      Number(
        (
          await f.db.query<{ n: number }>(
            `select count(*)::int n from parcels where order_id=$1 and status<>'void'`,
            [id],
          )
        ).rows[0]!.n,
      );
    expect(await count(confirmed)).toBe(1);
    expect(await count(completed)).toBe(1);
    expect(await count(draft)).toBe(0);
  });
});

describe("migration 059 — recovery of a confirmed order left without its parcel", () => {
  /** The real pre-057 confirmation: lifecycle, stock 'sale' and history — no parcel. */
  async function strandedOrder(): Promise<string> {
    const id = await draftOrder();
    const result = await f.rpc("transition_order_before_payment_authority_v1", [
      f.org,
      id,
      "lifecycle",
      "draft",
      "confirmed",
      f.actor,
      null,
    ]);
    expect(result.status).toBe("success");
    return id;
  }
  const recover = (id: string, org = f.org) => f.rpc("recover_order_parcel_v1", [org, id, f.actor]);

  async function withParcelWritesBlocked(fn: () => Promise<void>) {
    await f.db.exec(`
      create function test_block_parcel() returns trigger language plpgsql as $$
      begin raise exception 'parcel write failed (test)'; end $$;
      create trigger test_block_parcel before insert on parcels
        for each row execute function test_block_parcel();`);
    try {
      await fn();
    } finally {
      await f.db.exec(`drop trigger test_block_parcel on parcels;
        drop function test_block_parcel();`);
    }
  }

  it("confirmation side effects happen once; failed and successful recoveries never repeat them", async () => {
    const id = await strandedOrder();
    const confirmed = await snapshot(id);
    expect(confirmed.lifecycle).toBe("confirmed");
    expect(confirmed.parcels).toBe(0);
    expect(confirmed.movements).toBe(1); // one 'sale' per line, written once
    expect(confirmed.history).toBeGreaterThan(0);

    // Repeated recovery failures: each raises and rolls back — no side effect.
    await withParcelWritesBlocked(async () => {
      await expect(recover(id)).rejects.toThrow(/parcel write failed/);
      await expect(recover(id)).rejects.toThrow(/parcel write failed/);
    });
    expect(await snapshot(id)).toEqual(confirmed);

    // A replayed confirmation is refused (stale) and moves no stock.
    expect((await confirm(id)).status).toBe("stale");
    expect(await snapshot(id)).toEqual(confirmed);

    // Recovery creates exactly one parcel and nothing else.
    const created = await recover(id);
    expect(created.status).toBe("created");
    expect(String(created.parcel_code)).toMatch(CODE_RE);
    expect(await snapshot(id)).toEqual({ ...confirmed, parcels: 1 });

    // Again: the same parcel back, nothing written.
    const again = await recover(id);
    expect(again).toMatchObject({ status: "exists", parcel_id: created.parcel_id });
    expect(await snapshot(id)).toEqual({ ...confirmed, parcels: 1 });
  });

  it("refuses draft, cancelled and cross-tenant orders, writing nothing", async () => {
    const draft = await draftOrder();
    expect(await recover(draft)).toMatchObject({ status: "not_confirmed", current: "draft" });
    expect((await snapshot(draft)).parcels).toBe(0);

    const cancelled = await strandedOrder();
    await f.rpc("transition_order_status_v1", [
      f.org,
      cancelled,
      "lifecycle",
      "confirmed",
      "cancelled",
      f.actor,
      "test",
    ]);
    const before = await snapshot(cancelled);
    expect(await recover(cancelled)).toMatchObject({
      status: "not_confirmed",
      current: "cancelled",
    });
    expect(await snapshot(cancelled)).toEqual(before);
    expect(before.parcels).toBe(0);

    const stranded = await strandedOrder();
    expect(await recover(stranded, f.orgB)).toMatchObject({ status: "not_found" });
    expect((await snapshot(stranded)).parcels).toBe(0);
  });
});
