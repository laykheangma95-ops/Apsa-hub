/**
 * Receiving Inventory — production service against REAL SQL.
 *
 * Every migration (including 052) is applied to PGlite. The production
 * receiving service (src/server/inventory/receiving.ts) and the production
 * inventory/product repositories run unchanged; only their database client is
 * swapped, through the repositories' own test seams, for a small PostgREST-shaped
 * adapter that issues plain SQL. Unique indexes, CHECK constraints and the
 * cross-tenant trigger are therefore the real ones.
 *
 * Covers: scan product, manual entry, quantity increase, inventory ledger,
 * permission denial, cross-org denial, duplicate handling.
 *
 * Run: bun test src/tests/receiving-inventory.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import { setInventoryRepositoryDbForTests } from "../server/inventory/repository";
import { setProductRepositoryDbForTests } from "../server/products/repository";
import {
  receiveInventory,
  resolveReceivingScan,
  type ReceiveInventoryResult,
} from "../server/inventory/receiving";
import {
  classifyReceivingError,
  normalizeSupplierInput,
  parseReceiveQuantity,
  receiptRequestFingerprint,
  receiveResultMessageKey,
  receivingErrorKey,
  receivingScanMessageKey,
} from "../lib/receiving";
import { createIdempotencyKeyHolder } from "../lib/idempotency";
import en from "../locales/en.json";
import km from "../locales/km.json";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
let f: Fixture;
let restoreInventory: () => void;
let restoreProducts: () => void;

const RECEIVER_PERMS = ["inventory.receive_stock", "products.read", "inventory.read"];
const MEMBER_B = "aaaaaaaa-0000-4000-8000-0000000000b2";

function ctx(
  organizationId: string,
  permissions: string[] = RECEIVER_PERMS,
  userId = "aaaaaaaa-0000-4000-8000-000000000002",
) {
  const perms = new Set(permissions);
  return {
    organizationId,
    userId,
    can: (perm: string) => perms.has(perm),
    require(perm: string) {
      if (!perms.has(perm)) throw new Error(`Missing permission: ${perm}`);
    },
  } as any;
}

// ── PostgREST-shaped SQL adapter (test only) ──────────────────────────────────

function ident(value: string): string {
  if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`bad identifier ${value}`);
  return value;
}

function sqlDb() {
  function query(table: string) {
    const where: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let limit: number | undefined;
    let offset: number | undefined;
    let mode: "many" | "single" | "maybe" = "many";

    async function run() {
      let sql = `select ${columns} from ${table}`;
      if (where.length) sql += ` where ${where.join(" and ")}`;
      if (ordering.length) sql += ` order by ${ordering.join(",")}`;
      if (limit !== undefined) sql += ` limit ${limit}`;
      if (offset !== undefined) sql += ` offset ${offset}`;
      try {
        const rows = JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows));
        if (mode === "many") return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
        if (rows.length === 0 && mode === "single") {
          return { data: null, error: { code: "PGRST116", message: "no row" } };
        }
        return { data: rows[0] ?? null, error: null };
      } catch (error) {
        return { data: null, error };
      }
    }

    const chain: any = {
      select(cols = "*") {
        columns = cols;
        return chain;
      },
      eq(col: string, value: unknown) {
        if (value === null) where.push(`${ident(col)} is null`);
        else {
          values.push(value);
          where.push(`${ident(col)} = $${values.length}`);
        }
        return chain;
      },
      in(col: string, list: unknown[]) {
        values.push(list);
        where.push(`${ident(col)} = any($${values.length})`);
        return chain;
      },
      order(col: string, opts: { ascending: boolean }) {
        ordering.push(`${ident(col)} ${opts.ascending ? "asc" : "desc"}`);
        return chain;
      },
      limit(n: number) {
        limit = n;
        return chain;
      },
      range(from: number, to: number) {
        offset = from;
        limit = to - from + 1;
        return chain;
      },
      single() {
        mode = "single";
        return run();
      },
      maybeSingle() {
        mode = "maybe";
        return run();
      },
      then(ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) {
        return run().then(ok, fail);
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      const t = ident(table);
      const base = query(t);
      base.insert = (row: Record<string, unknown>) => {
        const entries = Object.entries(row).filter(([, v]) => v !== undefined);
        const sql = `insert into ${t}(${entries.map(([k]) => ident(k)).join(",")})
          values(${entries.map((_, i) => `$${i + 1}`).join(",")}) returning *`;
        const exec = async () => {
          try {
            const rows = JSON.parse(
              JSON.stringify(
                (
                  await f.db.query(
                    sql,
                    entries.map(([, v]) => v),
                  )
                ).rows,
              ),
            );
            return { data: rows[0] ?? null, error: null };
          } catch (error: any) {
            return { data: null, error: { code: error?.code, message: String(error?.message) } };
          }
        };
        return { select: () => ({ single: exec }) };
      };
      return base;
    },
  };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

interface Seeded {
  product: string;
  variant: string;
  barcode: string;
}

async function seedVariant(
  org: string,
  barcode: string,
  status: "ACTIVE" | "ARCHIVED" = "ACTIVE",
): Promise<Seeded> {
  const product = crypto.randomUUID();
  const variant = crypto.randomUUID();
  await f.db.query(
    `insert into products(id,organization_id,name_km,name_en) values($1,$2,'អាវយឺត','T-shirt')`,
    [product, org],
  );
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,barcode,name,price_amount,price_currency,status)
     values($1,$2,$3,$4,$5,'Blue M',1500,'USD',$6)`,
    [variant, org, product, `SKU-${variant.slice(0, 8)}`, barcode, status],
  );
  return { product, variant, barcode };
}

async function ledger(variant: string) {
  return (
    await f.db.query<any>(
      `select * from inventory_movements where variant_id=$1 order by created_at, id`,
      [variant],
    )
  ).rows;
}

async function onHand(variant: string): Promise<number> {
  const rows = (
    await f.db.query<{ q: number | null }>(
      `select sum(quantity_on_hand)::int as q from inventory_stock where variant_id=$1`,
      [variant],
    )
  ).rows;
  return rows[0]?.q ?? 0;
}

let A: Seeded;
let upc: Seeded;
let archived: Seeded;
let B: Seeded;
let locationA: string;
let locationB: string;

beforeAll(async () => {
  f = await financialFixture();
  const db = sqlDb();
  restoreInventory = setInventoryRepositoryDbForTests(db);
  restoreProducts = setProductRepositoryDbForTests(db);

  await f.db.query(`insert into auth.users(id,email) values($1,'member-b@test.invalid')`, [
    MEMBER_B,
  ]);
  A = await seedVariant(f.org, "8850001000017");
  upc = await seedVariant(f.org, "0012345678905");
  archived = await seedVariant(f.org, "8850009999993", "ARCHIVED");
  B = await seedVariant(f.orgB, "8859999000011");
  locationA = (
    await f.db.query<{ id: string }>(
      `insert into locations(organization_id,name) values($1,'Main shop') returning id`,
      [f.org],
    )
  ).rows[0]!.id;
  locationB = (
    await f.db.query<{ id: string }>(
      `insert into locations(organization_id,name) values($1,'Other shop') returning id`,
      [f.orgB],
    )
  ).rows[0]!.id;
}, 120_000);

afterAll(async () => {
  restoreInventory?.();
  restoreProducts?.();
  await f?.close();
});

function received(result: ReceiveInventoryResult) {
  if (result.kind !== "received") throw new Error(`expected received, got ${result.kind}`);
  return result;
}

// ── Scan product ──────────────────────────────────────────────────────────────

describe("scan product", () => {
  it("resolves a scanned retail barcode to the variant with identity and on-hand", async () => {
    const result = await resolveReceivingScan(ctx(f.org), A.barcode);
    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.product.variantId).toBe(A.variant);
    expect(result.product.productId).toBe(A.product);
    expect(result.product.productNameKm).toBe("អាវយឺត");
    expect(result.product.variantName).toBe("Blue M");
    expect(result.product.barcode).toBe(A.barcode);
    expect(typeof result.product.quantityOnHand).toBe("number");
    // Identity only — no price or cost leaves the server.
    expect(JSON.stringify(result)).not.toMatch(/price|cost/i);
  });

  it("matches a 12-digit UPC-A scan to a stored 13-digit EAN-13 code", async () => {
    const result = await resolveReceivingScan(ctx(f.org), "012345678905");
    expect(result.kind).toBe("product");
    if (result.kind === "product") expect(result.product.variantId).toBe(upc.variant);
  });

  it("resolves an APSA variant QR", async () => {
    const result = await resolveReceivingScan(ctx(f.org), `apsa:variant/${A.variant}`);
    expect(result.kind).toBe("product");
  });

  it("refuses an order code as not a product, without receiving anything", async () => {
    const result = await resolveReceivingScan(ctx(f.org), `apsa:order/${crypto.randomUUID()}`);
    expect(result.kind).toBe("not_a_product");
  });

  it("an archived variant is not receivable by barcode or by QR", async () => {
    expect((await resolveReceivingScan(ctx(f.org), archived.barcode)).kind).toBe("not_found");
    expect((await resolveReceivingScan(ctx(f.org), `apsa:variant/${archived.variant}`)).kind).toBe(
      "not_found",
    );
  });

  it("omits on-hand when the caller lacks inventory.read", async () => {
    const result = await resolveReceivingScan(
      ctx(f.org, ["inventory.receive_stock", "products.read"]),
      A.barcode,
    );
    expect(result.kind === "product" && result.product.quantityOnHand).toBeNull();
  });
});

// ── Manual entry ──────────────────────────────────────────────────────────────

describe("manual entry", () => {
  it("a typed code with surrounding whitespace resolves the same as a scan", async () => {
    const result = await resolveReceivingScan(ctx(f.org), `   ${A.barcode}  `);
    expect(result.kind === "product" && result.product.variantId).toBe(A.variant);
  });

  it("an unknown typed code is not_found, and a blank one never reaches a lookup", async () => {
    expect((await resolveReceivingScan(ctx(f.org), "0000000000000")).kind).toBe("not_found");
    expect((await resolveReceivingScan(ctx(f.org), "    ")).kind).toBe("not_found");
  });
});

// ── Quantity increase + inventory ledger ──────────────────────────────────────

describe("quantity increase and inventory ledger", () => {
  it("each receipt appends one restock movement and the ledger balance increases", async () => {
    const before = await onHand(A.variant);
    const first = received(
      await receiveInventory(ctx(f.org), {
        receiptKey: crypto.randomUUID(),
        variantId: A.variant,
        quantity: 12,
        locationId: locationA,
        supplierName: "  Phnom Penh Wholesale  ",
      }),
    );
    expect(first.replayed).toBe(false);
    expect(first.quantityOnHand).toBe(before + 12);

    const second = received(
      await receiveInventory(ctx(f.org), {
        receiptKey: crypto.randomUUID(),
        variantId: A.variant,
        quantity: 5,
      }),
    );
    expect(second.quantityOnHand).toBe(before + 17);
    expect(await onHand(A.variant)).toBe(before + 17);
  });

  it("writes an immutable ledger row: restock, receipt reference, supplier, actor, location", async () => {
    const key = crypto.randomUUID();
    const result = received(
      await receiveInventory(ctx(f.org), {
        receiptKey: key,
        variantId: A.variant,
        quantity: 3,
        locationId: locationA,
        supplierName: "  Kampot Farm ",
      }),
    );
    const row = (await ledger(A.variant)).find((r: any) => r.reference_id === key);
    expect(row).toBeDefined();
    expect(row.id).toBe(result.receipt.movementId);
    expect(row.movement_type).toBe("restock");
    expect(row.quantity_delta).toBe(3);
    expect(row.reference_type).toBe("inventory_receipt");
    expect(row.product_id).toBe(A.product);
    expect(row.location_id).toBe(locationA);
    expect(row.supplier_name).toBe("Kampot Farm");
    expect(row.created_by).toBe(f.actor);
    expect(result.receipt.supplierName).toBe("Kampot Farm");
    // The ledger stays append-only for JWT clients.
    try {
      await expect(
        f.db.exec(`set role authenticated; update inventory_movements set quantity_delta=999;`),
      ).rejects.toThrow();
    } finally {
      await f.db.exec(`reset role;`);
    }
  });

  it("rejects quantities that are not a whole number from 1 to 100,000 — nothing is written", async () => {
    const rowsBefore = (await ledger(A.variant)).length;
    for (const quantity of [0, -4, 1.5, 100_001, Number.NaN]) {
      await expect(
        receiveInventory(ctx(f.org), {
          receiptKey: crypto.randomUUID(),
          variantId: A.variant,
          quantity,
        }),
      ).rejects.toThrow(/quantity must be a whole number/);
    }
    await expect(
      receiveInventory(ctx(f.org), {
        receiptKey: crypto.randomUUID(),
        variantId: A.variant,
        quantity: 1,
        supplierName: "x".repeat(121),
      }),
    ).rejects.toThrow(/supplier_name must be at most/);
    expect((await ledger(A.variant)).length).toBe(rowsBefore);
  });

  it("refuses an archived variant without writing", async () => {
    const result = await receiveInventory(ctx(f.org), {
      receiptKey: crypto.randomUUID(),
      variantId: archived.variant,
      quantity: 2,
    });
    expect(result.kind).toBe("variant_not_found");
    expect(await ledger(archived.variant)).toHaveLength(0);
  });
});

// ── Permission denial ─────────────────────────────────────────────────────────

describe("permission denial", () => {
  it("without inventory.receive_stock neither scanning nor receiving is allowed", async () => {
    const cashier = ctx(f.org, ["inventory.read", "products.read", "inventory.adjust"]);
    await expect(resolveReceivingScan(cashier, A.barcode)).rejects.toThrow(
      "Missing permission: inventory.receive_stock",
    );
    const rowsBefore = (await ledger(A.variant)).length;
    await expect(
      receiveInventory(cashier, {
        receiptKey: crypto.randomUUID(),
        variantId: A.variant,
        quantity: 1,
      }),
    ).rejects.toThrow("Missing permission: inventory.receive_stock");
    expect((await ledger(A.variant)).length).toBe(rowsBefore);
  });

  it("scanning also requires products.read to identify the product", async () => {
    await expect(
      resolveReceivingScan(ctx(f.org, ["inventory.receive_stock"]), A.barcode),
    ).rejects.toThrow("Missing permission: products.read");
  });

  it("the permission check runs before any receipt-key lookup (no replay to the unauthorized)", async () => {
    const key = crypto.randomUUID();
    received(
      await receiveInventory(ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 1 }),
    );
    await expect(
      receiveInventory(ctx(f.org, ["inventory.read"]), {
        receiptKey: key,
        variantId: A.variant,
        quantity: 1,
      }),
    ).rejects.toThrow("Missing permission");
  });

  it("migration 022 grants inventory.receive_stock to OWNER and MANAGER only", async () => {
    const roles = (
      await f.db.query<{ system_role: string }>(
        `select r.system_role from role_permissions rp
         join roles r on r.id = rp.role_id
         join permissions p on p.id = rp.permission_id
         where p.key = 'inventory.receive_stock' and r.organization_id is null
         order by r.system_role`,
      )
    ).rows
      .map((r) => r.system_role)
      .sort();
    expect(roles).toEqual(["MANAGER", "OWNER"]);
  });
});

// ── Cross-org denial ──────────────────────────────────────────────────────────

describe("cross-org denial", () => {
  it("another organization's barcode and variant QR resolve as not_found", async () => {
    expect((await resolveReceivingScan(ctx(f.org), B.barcode)).kind).toBe("not_found");
    expect((await resolveReceivingScan(ctx(f.org), `apsa:variant/${B.variant}`)).kind).toBe(
      "not_found",
    );
  });

  it("receiving another organization's variant id is refused and writes nothing", async () => {
    const result = await receiveInventory(ctx(f.org), {
      receiptKey: crypto.randomUUID(),
      variantId: B.variant,
      quantity: 50,
    });
    expect(result.kind).toBe("variant_not_found");
    expect(await ledger(B.variant)).toHaveLength(0);
  });

  it("another organization's location is refused and writes nothing", async () => {
    const rowsBefore = (await ledger(A.variant)).length;
    const result = await receiveInventory(ctx(f.org), {
      receiptKey: crypto.randomUUID(),
      variantId: A.variant,
      quantity: 4,
      locationId: locationB,
    });
    expect(result.kind).toBe("location_not_found");
    expect((await ledger(A.variant)).length).toBe(rowsBefore);
  });

  it("receipt keys are scoped per organization: Org B cannot see or replay Org A's receipt", async () => {
    const key = crypto.randomUUID();
    received(
      await receiveInventory(ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 2 }),
    );
    const inB = received(
      await receiveInventory(ctx(f.orgB), { receiptKey: key, variantId: B.variant, quantity: 2 }),
    );
    // A fresh receipt in Org B — not a replay of Org A's movement.
    expect(inB.replayed).toBe(false);
    expect(inB.receipt.variantId).toBe(B.variant);
    expect(await onHand(B.variant)).toBe(2);
  });

  it("the database trigger refuses a cross-tenant ledger row even from the service role", async () => {
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type)
         values($1,$2,$3,1,'restock')`,
        [f.org, B.product, B.variant],
      ),
    ).rejects.toThrow(/cross_tenant/);
  });
});

// ── Duplicate handling ────────────────────────────────────────────────────────

describe("duplicate handling", () => {
  it("a retried receipt (same key, same request) is replayed and adds no stock", async () => {
    const key = crypto.randomUUID();
    const request = { receiptKey: key, variantId: A.variant, quantity: 7, supplierName: "Lucky" };
    const first = received(await receiveInventory(ctx(f.org), request));
    const stockAfterFirst = await onHand(A.variant);

    const retry = received(await receiveInventory(ctx(f.org), request));
    expect(retry.replayed).toBe(true);
    expect(retry.receipt.movementId).toBe(first.receipt.movementId);
    expect(retry.quantityOnHand).toBe(stockAfterFirst);
    expect(await onHand(A.variant)).toBe(stockAfterFirst);
    expect((await ledger(A.variant)).filter((r: any) => r.reference_id === key)).toHaveLength(1);
  });

  it("two concurrent submissions of one receipt write exactly one movement", async () => {
    const key = crypto.randomUUID();
    const before = await onHand(A.variant);
    const request = { receiptKey: key, variantId: A.variant, quantity: 9 };
    const results = (
      await Promise.all([
        receiveInventory(ctx(f.org), request),
        receiveInventory(ctx(f.org), request),
        receiveInventory(ctx(f.org), request),
      ])
    ).map(received);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receipt.movementId)).size).toBe(1);
    expect(await onHand(A.variant)).toBe(before + 9);
  });

  it("the same key with a different quantity, variant, supplier or member is a conflict and writes nothing", async () => {
    const key = crypto.randomUUID();
    received(
      await receiveInventory(ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 1 }),
    );
    const stockA = await onHand(A.variant);
    const stockUpc = await onHand(upc.variant);

    const variants: Array<[any, any]> = [
      [ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 2 }],
      [ctx(f.org), { receiptKey: key, variantId: upc.variant, quantity: 1 }],
      [ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 1, supplierName: "Other" }],
      [ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 1, locationId: locationA }],
      [
        ctx(f.org, RECEIVER_PERMS, MEMBER_B),
        { receiptKey: key, variantId: A.variant, quantity: 1 },
      ],
    ];
    for (const [caller, request] of variants) {
      expect((await receiveInventory(caller, request)).kind).toBe("receipt_conflict");
    }
    expect(await onHand(A.variant)).toBe(stockA);
    expect(await onHand(upc.variant)).toBe(stockUpc);
  });

  it("the database itself refuses a second movement under one receipt key, for any variant", async () => {
    const key = crypto.randomUUID();
    received(
      await receiveInventory(ctx(f.org), { receiptKey: key, variantId: A.variant, quantity: 1 }),
    );
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type,reference_type,reference_id)
         values($1,$2,$3,1,'restock','inventory_receipt',$4)`,
        [f.org, upc.product, upc.variant, key],
      ),
    ).rejects.toThrow(/uniq_inventory_movements_receipt_key|duplicate key/);
  });

  it("migration 052 constraints: receipt rows are positive restocks; supplier labels only on receipts, never blank", async () => {
    const insert = (type: string, delta: number, refType: string | null, supplier: string | null) =>
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type,reference_type,reference_id,supplier_name)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          f.org,
          A.product,
          A.variant,
          delta,
          type,
          refType,
          refType ? crypto.randomUUID() : null,
          supplier,
        ],
      );
    await expect(insert("sale", -1, "inventory_receipt", null)).rejects.toThrow(/receipt_shape/);
    await expect(insert("restock", -1, "inventory_receipt", null)).rejects.toThrow(/receipt_shape/);
    await expect(insert("manual_adjustment", 1, null, "Supplier")).rejects.toThrow(
      /supplier_name_valid/,
    );
    await expect(insert("restock", 1, null, "   ")).rejects.toThrow(/supplier_name_valid/);
    await expect(insert("restock", 1, null, "x".repeat(121))).rejects.toThrow(
      /supplier_name_valid/,
    );
  });
});

// ── Client helpers (pure) ─────────────────────────────────────────────────────

describe("client receiving helpers", () => {
  it("parseReceiveQuantity accepts whole numbers 1..100,000 only", () => {
    expect(parseReceiveQuantity("12")).toBe(12);
    expect(parseReceiveQuantity("1,000")).toBe(1000);
    for (const bad of ["", "0", "-3", "1.5", "abc", "100001"]) {
      expect(parseReceiveQuantity(bad)).toBeNull();
    }
  });

  it("a retry of the same request reuses its receipt key; a changed request gets a new one", () => {
    let n = 0;
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`);
    const base = { variantId: "v", quantity: 3, locationId: null, supplierName: null };
    const first = holder.keyFor(receiptRequestFingerprint(base));
    expect(holder.keyFor(receiptRequestFingerprint(base))).toBe(first);
    expect(holder.keyFor(receiptRequestFingerprint({ ...base, quantity: 4 }))).not.toBe(first);
    holder.release();
    expect(holder.keyFor(receiptRequestFingerprint(base))).not.toBe(first);
  });

  it("supplier input normalizes blank to null", () => {
    expect(normalizeSupplierInput("   ")).toBeNull();
    expect(normalizeSupplierInput(" Acme ")).toBe("Acme");
  });

  it("every outcome maps to localized copy present in both locales", () => {
    const keys = [
      receivingScanMessageKey({ kind: "not_found" }),
      receivingScanMessageKey({ kind: "not_a_product" }),
      receiveResultMessageKey({ kind: "variant_not_found" }),
      receiveResultMessageKey({ kind: "location_not_found" }),
      receiveResultMessageKey({ kind: "receipt_conflict" }),
      receivingErrorKey(classifyReceivingError(new Error("Missing permission: x"))),
      receivingErrorKey(classifyReceivingError(new Error("quantity must be a whole number"))),
      receivingErrorKey(classifyReceivingError(new Error("boom"))),
    ];
    const lookup = (dict: any, key: string) =>
      key.split(".").reduce((node: any, part) => node?.[part], dict);
    for (const key of keys) {
      expect(key).toBeString();
      expect(lookup(en, key!), `en ${key}`).toBeString();
      expect(lookup(km, key!), `km ${key}`).toBeString();
      expect((lookup(km, key!) as string).length).toBeGreaterThan(0);
    }
  });

  it("the receiving.* locale blocks have identical key sets", () => {
    const flat = (node: any, prefix = ""): string[] =>
      Object.entries(node).flatMap(([k, v]) =>
        typeof v === "object" ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(flat((km as any).receiving).sort()).toEqual(flat((en as any).receiving).sort());
  });
});

// ── Boundary (source-level) ───────────────────────────────────────────────────

describe("server boundary", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

  it("the receive server function accepts no organization, product, movement type or stock figure", () => {
    const api = read("src/api/receiving.ts");
    const schema = api.slice(api.indexOf("receiveInventoryFn"));
    expect(schema).toMatch(/\.strict\(\)/);
    expect(schema).not.toMatch(/organizationId|productId|movementType|quantityOnHand/);
  });

  it("migration 052 is additive and adds no permission", () => {
    const sql = read("supabase/migrations/052_inventory_receiving.sql");
    expect(sql).not.toMatch(/DROP\s/i);
    expect(sql).not.toMatch(/INSERT INTO public\.permissions/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });
});
