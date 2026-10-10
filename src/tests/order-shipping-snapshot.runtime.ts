/**
 * Order shipping-destination snapshot — REAL SQL + production service behaviour
 * (PGlite, every migration applied). PR #80 final shipping-authority repair.
 *
 * Nothing here matches SQL text. Every assertion drives the migrated RPCs
 * (create_order_v3, update_order_shipping_v1) and/or the production TypeScript
 * order service through the same database, then reads back the rows they wrote.
 *
 * Guarantees, each with an assertion that fails if the mechanism is removed:
 *   - the shipping snapshot is written atomically with the order (§4);
 *   - a later edit to the customer's profile/address does NOT change the order
 *     snapshot (§16 — the critical immutability regression);
 *   - an order created against a NON-default address keeps that address (§17);
 *   - the snapshot is part of the idempotency fingerprint: same key + same
 *     address replays; same key + different address conflicts (§18);
 *   - update_order_shipping_v1 sets/confirms/corrects the snapshot, is refused
 *     once fulfillment is terminal (§10), and is tenant-isolated (§15);
 *   - the service audit for a shipping change records field PRESENCE only, never
 *     a raw name/phone/address (§11).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { AuthorizationContext } from "../server/auth/authorization";
import { financialFixture } from "./helpers/payment-order-fixture";
import { principalOf } from "./helpers/refuse-only-principal";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
type Json = Record<string, unknown>;

let f: Fixture;

const orgA = "aaaaaaaa-0000-4000-8000-000000000001"; // financialFixture's org
const actorA = "aaaaaaaa-0000-4000-8000-000000000002"; // financialFixture's actor

interface Catalog {
  variant: string;
  customer: string;
}
let A: Catalog;

/** Audit rows the service tried to write (captured by the transport below). */
const audits: Json[] = [];

async function seed(org: string): Promise<Catalog> {
  const product = crypto.randomUUID();
  const variant = crypto.randomUUID();
  const customer = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km) values($1,$2,'ផលិតផល')`, [
    product,
    org,
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency,status)
     values($1,$2,$3,$4,'Std',1500,'USD','ACTIVE')`,
    [variant, org, product, `SKU-${variant.slice(0, 8)}`],
  );
  await f.db.query(`insert into customers(id,organization_id,display_name) values($1,$2,'Sokha')`, [
    customer,
    org,
  ]);
  await f.db.query(
    `insert into customer_addresses(organization_id,customer_id,is_default,house_no,street,city)
     values($1,$2,true,'1','Default St','Phnom Penh')`,
    [org, customer],
  );
  return { variant, customer };
}

beforeAll(async () => {
  f = await financialFixture();
  A = await seed(orgA);
});
afterAll(async () => {
  await f.close();
});

async function orderShipping(id: string) {
  return (
    await f.db.query<{
      shipping_name: string | null;
      shipping_phone: string | null;
      shipping_address: string | null;
      fulfillment_status: string;
    }>(
      `select shipping_name,shipping_phone,shipping_address,fulfillment_status from orders where id=$1`,
      [id],
    )
  ).rows[0]!;
}

// ── The RPC directly ───────────────────────────────────────────────────────────

describe("create_order_v3 + update_order_shipping_v1 (SQL)", () => {
  async function createV3(
    key: string,
    address: string | null,
    name = "Recipient",
    phone = "012000111",
  ) {
    return f.rpc("create_order_v3", [
      orgA,
      actorA,
      "MANUAL",
      JSON.stringify([{ variant_id: A.variant, quantity: 1 }]),
      A.customer,
      null,
      0,
      0,
      null,
      key,
      address ? name : null,
      address ? phone : null,
      address,
    ]);
  }

  it("writes the shipping snapshot atomically with the order (§4)", async () => {
    const key = "shipkey0000000001aa";
    const r = (await createV3(key, "Order House A, Phnom Penh")) as Json;
    expect(r.status).toBe("success");
    const row = await orderShipping(r.order_id as string);
    expect(row.shipping_name).toBe("Recipient");
    expect(row.shipping_address).toBe("Order House A, Phnom Penh");
  });

  it("keeps the snapshot immutable across a later customer-profile/address edit (§16)", async () => {
    const key = "shipkey0000000002bb";
    const r = (await createV3(key, "Order House A, Phnom Penh")) as Json;
    const orderId = r.order_id as string;
    // The customer moves house AND is renamed after the order was placed.
    await f.db.query(
      `update customer_addresses set house_no='999', street='New St', city='Siem Reap' where customer_id=$1`,
      [A.customer],
    );
    await f.db.query(`update customers set display_name='Renamed' where id=$1`, [A.customer]);
    const row = await orderShipping(orderId);
    // The order's destination is unchanged — it is the snapshot, not the profile.
    expect(row.shipping_address).toBe("Order House A, Phnom Penh");
    expect(row.shipping_name).toBe("Recipient");
  });

  it("keeps a non-default address chosen for the order (§17)", async () => {
    const key = "shipkey0000000003cc";
    // Default on file is 'Default St, Phnom Penh'; this order ships elsewhere.
    const r = (await createV3(key, "Mother's House, Battambang")) as Json;
    const row = await orderShipping(r.order_id as string);
    expect(row.shipping_address).toBe("Mother's House, Battambang");
    expect(row.shipping_address).not.toContain("Default St");
  });

  it("folds the address into idempotency: same address replays, different address conflicts (§18)", async () => {
    const key = "shipkey0000000004dd";
    const first = (await createV3(key, "Addr A")) as Json;
    const replay = (await createV3(key, "Addr A")) as Json;
    expect(replay.status).toBe("success");
    expect(replay.replayed).toBe(true);
    expect(replay.order_id).toBe(first.order_id);

    const conflict = (await createV3(key, "Addr B — different")) as Json;
    expect(conflict.status).toBe("idempotency_conflict");
    expect(conflict.order_id).toBeUndefined();
  });

  it("update_order_shipping_v1 sets a snapshot, and is refused once fulfillment is terminal (§10)", async () => {
    const key = "shipkey0000000005ee";
    const r = (await createV3(key, null)) as Json; // pickup: no snapshot yet
    const orderId = r.order_id as string;
    expect((await orderShipping(orderId)).shipping_address).toBeNull();

    const set = (await f.rpc("update_order_shipping_v1", [
      orgA,
      orderId,
      actorA,
      "Confirmed Name",
      "0999",
      "Confirmed Address, Kandal",
    ])) as Json;
    expect(set.status).toBe("success");
    expect((await orderShipping(orderId)).shipping_address).toBe("Confirmed Address, Kandal");

    // Move fulfillment to a terminal state, then a further edit is refused.
    await f.db.query(`update orders set fulfillment_status='fulfilled' where id=$1`, [orderId]);
    const refused = (await f.rpc("update_order_shipping_v1", [
      orgA,
      orderId,
      actorA,
      "Too Late",
      "0000",
      "Cannot Change",
    ])) as Json;
    expect(refused.status).toBe("fulfillment_terminal");
    expect((await orderShipping(orderId)).shipping_address).toBe("Confirmed Address, Kandal");
  });

  it("update_order_shipping_v1 is tenant-isolated: another org cannot touch the snapshot (§15)", async () => {
    const key = "shipkey0000000006ff";
    const r = (await createV3(key, "Org A Only")) as Json;
    const orderId = r.order_id as string;
    const cross = (await f.rpc("update_order_shipping_v1", [
      f.orgB,
      orderId,
      actorA,
      "Intruder",
      "0000",
      "Elsewhere",
    ])) as Json;
    expect(cross.status).toBe("order_not_found");
    expect((await orderShipping(orderId)).shipping_address).toBe("Org A Only");
  });
});

// ── Production service through the same database ─────────────────────────────────

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
      neq(key: string, value: unknown) {
        values.push(value);
        where.push(`${identifier(key)} <> $${values.length}`);
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

describe("Order shipping snapshot through the real service", () => {
  it("createOrder persists the shipping snapshot and audits PRESENCE only, never raw PII (§4, §11)", async () => {
    const service = await import("../server/orders/service");
    const ctx = context(orgA, actorA, ["orders.create", "orders.read"]);
    const auditsBefore = audits.length;
    const detail = await service.createOrder(ctx, {
      expectedPrincipal: principalOf(ctx),
      source: "MANUAL",
      items: [{ variantId: A.variant, quantity: 1 }],
      customerId: A.customer,
      idempotencyKey: crypto.randomUUID(),
      shipping: { name: "Auntie Sith234", phone: "012777888", address: "Secret Lane 42, Kampot" },
    });
    const row = await orderShipping(detail.id);
    expect(row.shipping_address).toBe("Secret Lane 42, Kampot");

    // The audit for this create must not carry the raw address/name/phone.
    const created = audits.slice(auditsBefore);
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("Secret Lane 42, Kampot");
    expect(serialized).not.toContain("Auntie Sith234");
    expect(serialized).not.toContain("012777888");
    // …but it records that a shipping snapshot was captured.
    expect(serialized).toContain("shipping_snapshot");
  });

  it("rejects a shipping destination missing its address, before any write (§19)", async () => {
    const service = await import("../server/orders/service");
    const ctx = context(orgA, actorA, ["orders.create", "orders.read"]);
    await expect(
      service.createOrder(ctx, {
        expectedPrincipal: principalOf(ctx),
        source: "MANUAL",
        items: [{ variantId: A.variant, quantity: 1 }],
        customerId: A.customer,
        idempotencyKey: crypto.randomUUID(),
        shipping: { name: "Only A Name", phone: "012000000", address: "   " },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("updateOrderShippingSnapshot requires orders.update and audits presence only (§10, §11)", async () => {
    const service = await import("../server/orders/service");
    // First create a pickup order (no snapshot) with a creator context.
    const detail = await service.createOrder(
      context(orgA, actorA, ["orders.create", "orders.read"]),
      {
        expectedPrincipal: principalOf(context(orgA, actorA, ["orders.create", "orders.read"])),
        source: "MANUAL",
        items: [{ variantId: A.variant, quantity: 1 }],
        customerId: A.customer,
        idempotencyKey: crypto.randomUUID(),
      },
    );

    // A context lacking orders.update is refused.
    await expect(
      service.updateOrderShippingSnapshot(
        context(orgA, actorA, ["orders.read"]),
        detail.id,
        {
          name: "X",
          address: "Y",
        },
        principalOf(context(orgA, actorA, ["orders.read"])),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    const auditsBefore = audits.length;
    const result = await service.updateOrderShippingSnapshot(
      context(orgA, actorA, ["orders.update"]),
      detail.id,
      { name: "Confirmed Person", phone: "0912345678", address: "Confirmed Blvd 7, Takeo" },
      principalOf(context(orgA, actorA, ["orders.update"])),
    );
    expect(result).toEqual({ ok: true });
    expect((await orderShipping(detail.id)).shipping_address).toBe("Confirmed Blvd 7, Takeo");

    const serialized = JSON.stringify(audits.slice(auditsBefore));
    expect(serialized).not.toContain("Confirmed Blvd 7, Takeo");
    expect(serialized).not.toContain("Confirmed Person");
    expect(serialized).toContain("shipping_snapshot");
  });
});

describe("normalizeShippingSnapshot (pure validation, §19)", () => {
  it("returns null for a fully blank / pickup destination", async () => {
    const { normalizeShippingSnapshot } = await import("../server/orders/service");
    expect(normalizeShippingSnapshot(null)).toBeNull();
    expect(normalizeShippingSnapshot(undefined)).toBeNull();
    expect(normalizeShippingSnapshot({ name: "  ", phone: "", address: "  " })).toBeNull();
  });

  it("requires a name AND an address once any field is supplied", async () => {
    const { normalizeShippingSnapshot } = await import("../server/orders/service");
    expect(() => normalizeShippingSnapshot({ address: "Somewhere" })).toThrow();
    expect(() => normalizeShippingSnapshot({ name: "Someone" })).toThrow();
    expect(normalizeShippingSnapshot({ name: "Someone", address: "Somewhere" })).toEqual({
      name: "Someone",
      phone: null,
      address: "Somewhere",
    });
  });

  it("rejects markup and validates the phone, and keeps Khmer text", async () => {
    const { normalizeShippingSnapshot } = await import("../server/orders/service");
    expect(() => normalizeShippingSnapshot({ name: "<b>x</b>", address: "A" })).toThrow();
    expect(() => normalizeShippingSnapshot({ name: "N", phone: "abc", address: "A" })).toThrow();
    const km = normalizeShippingSnapshot({
      name: "សុខា",
      phone: "012 345 678",
      address: "ផ្ទះលេខ ១២, ភ្នំពេញ",
    });
    expect(km?.name).toBe("សុខា");
    expect(km?.address).toBe("ផ្ទះលេខ ១២, ភ្នំពេញ");
    expect(km?.phone).toBe("012 345 678");
  });

  it("collapses whitespace and strips control characters", async () => {
    const { normalizeShippingSnapshot } = await import("../server/orders/service");
    const out = normalizeShippingSnapshot({
      name: "  Two   Words \u0007 ",
      address: "Line\tone   two",
    });
    expect(out?.name).toBe("Two Words");
    expect(out?.address).toBe("Line one two");
  });
});

describe("normalizeShippingSnapshot phone validation", () => {
  const ship = async (phone: string) => {
    const { normalizeShippingSnapshot } = await import("../server/orders/service");
    return normalizeShippingSnapshot({ name: "N", phone, address: "A" });
  };

  it("rejects alphabetic content and stray symbols", async () => {
    for (const bad of [
      "abc",
      "012ABC123",
      "phone123",
      "012 345 678 ext",
      "012#345678",
      "01234*678",
    ]) {
      await expect(ship(bad)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("rejects a misplaced plus, and implausible digit counts", async () => {
    for (const bad of ["012+345678", "12345", "1234567890123456", "++85512345678"]) {
      await expect(ship(bad)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("keeps legitimate local and international formatting, incl. Khmer numerals", async () => {
    for (const good of [
      "012345678",
      "012 345 678",
      "+855 12 345 678",
      "+855-12-345-678",
      "(023) 123-456",
      "012.345.678",
      "០១២ ៣៤៥ ៦៧៨",
    ]) {
      expect((await ship(good))?.phone).toBe(good);
    }
  });
});

// ── Label destination authority, through the real fulfillment service ─────────────

describe("parcel label uses the ORDER's shipping snapshot, never the customer profile", () => {
  const perms = ["orders.create", "orders.read", "orders.update", "fulfillment.print_label"];
  const ctx = () => context(orgA, actorA, perms);

  async function newOrder(shipping?: { name: string; phone: string; address: string }) {
    const orders = await import("../server/orders/service");
    const created = await orders.createOrder(ctx(), {
      expectedPrincipal: principalOf(ctx()),
      source: "MANUAL",
      items: [{ variantId: A.variant, quantity: 1 }],
      customerId: A.customer,
      idempotencyKey: crypto.randomUUID(),
      ...(shipping ? { shipping } : {}),
    });
    // A label exists only for a confirmed order (parcelLabelPrintability).
    await f.db.query(`update orders set lifecycle_status='confirmed' where id=$1`, [created.id]);
    return created;
  }
  async function label(orderId: string) {
    const { getParcelLabelData } = await import("../server/fulfillment/service");
    return getParcelLabelData(ctx(), orderId);
  }
  const setCustomerAddress = (street: string) =>
    f.db.query(
      `update customer_addresses set street=$2, house_no='9' where customer_id=$1 and is_default`,
      [A.customer, street],
    );

  it("Order A keeps destination A after the customer moves to B; a new Order B captures B", async () => {
    await setCustomerAddress("Address A Street");
    const orderA = await newOrder({
      name: "Recipient A",
      phone: "012111222",
      address: "Address A Street, Phnom Penh",
    });
    expect((await label(orderA.id)).customer).toMatchObject({
      name: "Recipient A",
      address: "Address A Street, Phnom Penh",
      addressConfirmed: true,
    });

    // The customer's profile changes to B (and they are renamed).
    await setCustomerAddress("Address B Street");
    await f.db.query(`update customers set display_name='Moved Customer' where id=$1`, [
      A.customer,
    ]);
    const stillA = (await label(orderA.id)).customer;
    expect(stillA.address).toBe("Address A Street, Phnom Penh");
    expect(stillA.name).toBe("Recipient A");
    expect(JSON.stringify(stillA)).not.toContain("Address B Street");

    // A new order captures the new destination B.
    const orderB = await newOrder({
      name: "Recipient B",
      phone: "012333444",
      address: "Address B Street, Siem Reap",
    });
    expect((await label(orderB.id)).customer.address).toBe("Address B Street, Siem Reap");
    // …and A is still A.
    expect((await label(orderA.id)).customer.address).toBe("Address A Street, Phnom Penh");
  });

  it("an order with NO snapshot infers NOTHING from the customer: no name, phone or address", async () => {
    // The customer as they were when the old order was placed: Name A / Phone A / Address A.
    await f.db.query(
      `update customers set display_name='Customer Name A', primary_phone='011000001' where id=$1`,
      [A.customer],
    );
    await setCustomerAddress("Address A Street");
    // A pre-047 / pickup order: no shipping snapshot at all.
    const old = await newOrder();
    await f.db.query(
      `update orders set shipping_name=null, shipping_phone=null, shipping_address=null where id=$1`,
      [old.id],
    );
    // Later the profile becomes Name B / Phone B / Address B.
    await f.db.query(
      `update customers set display_name='Customer Name B', primary_phone='099000002' where id=$1`,
      [A.customer],
    );
    await setCustomerAddress("Address B Street");
    const customerRows = async () => ({
      customer: (await f.db.query(`select * from customers where id=$1`, [A.customer])).rows,
      addresses: (
        await f.db.query(`select * from customer_addresses where customer_id=$1 order by id`, [
          A.customer,
        ])
      ).rows,
    });
    const profileBefore = await customerRows();

    const data = await label(old.id);
    expect(data.customer).toEqual({
      name: null,
      phone: null,
      address: null,
      addressConfirmed: false,
    });
    const payload = JSON.stringify(data);
    for (const leaked of [
      "Customer Name A",
      "Customer Name B",
      "011000001",
      "099000002",
      "Address A Street",
      "Address B Street",
    ]) {
      expect(payload).not.toContain(leaked);
    }

    // Explicit merchant entry creates the Order-owned snapshot…
    const orders = await import("../server/orders/service");
    await orders.updateOrderShippingSnapshot(
      ctx(),
      old.id,
      {
        name: "Entered Recipient",
        phone: "012999000",
        address: "Entered Address, Phnom Penh",
      },
      principalOf(ctx()),
    );
    expect((await label(old.id)).customer).toMatchObject({
      name: "Entered Recipient",
      address: "Entered Address, Phnom Penh",
      addressConfirmed: true,
    });
    // Confirmation touched only the Order: the Customer profile is byte-identical.
    expect(await customerRows()).toEqual(profileBefore);

    // …and a later Customer change no longer touches it, nor is the profile mutated.
    await f.db.query(
      `update customers set display_name='Customer Name C', primary_phone='088000003' where id=$1`,
      [A.customer],
    );
    await setCustomerAddress("Address C Street");
    const after = (await label(old.id)).customer;
    expect(after).toMatchObject({ name: "Entered Recipient", addressConfirmed: true });
    expect(JSON.stringify(after)).not.toMatch(/Customer Name|088000003|Address C Street/);
  });

  it("correcting a destination rewrites only the order snapshot: no customer mutation, audited by presence", async () => {
    await setCustomerAddress("Profile Stays Street");
    const orders = await import("../server/orders/service");
    const order = await newOrder({
      name: "Wrong Person",
      phone: "012555666",
      address: "Wrong Address 1",
    });
    const profileBefore = (
      await f.db.query(`select * from customer_addresses where customer_id=$1 order by id`, [
        A.customer,
      ])
    ).rows;
    const auditsBefore = audits.length;

    await orders.updateOrderShippingSnapshot(
      ctx(),
      order.id,
      {
        name: "Right Person",
        phone: "012777888",
        address: "Corrected Address 2",
      },
      principalOf(ctx()),
    );

    expect((await label(order.id)).customer).toMatchObject({
      name: "Right Person",
      address: "Corrected Address 2",
      addressConfirmed: true,
    });
    const profileAfter = (
      await f.db.query(`select * from customer_addresses where customer_id=$1 order by id`, [
        A.customer,
      ])
    ).rows;
    expect(profileAfter).toEqual(profileBefore);
    const written = JSON.stringify(audits.slice(auditsBefore));
    expect(written).toContain("shipping_snapshot");
    expect(written).not.toContain("Corrected Address 2");
    expect(written).not.toContain("Right Person");

    // Without orders.update, the correction is refused and nothing changes.
    await expect(
      orders.updateOrderShippingSnapshot(
        context(orgA, actorA, ["orders.read", "fulfillment.print_label"]),
        order.id,
        { name: "Nope", address: "Nowhere" },
        principalOf(context(orgA, actorA, ["orders.read", "fulfillment.print_label"])),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await label(order.id)).customer.address).toBe("Corrected Address 2");
  });
});
