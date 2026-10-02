/**
 * Stock Count — production service against REAL SQL.
 *
 * Every migration (including 053) is applied to PGlite. The production stock
 * count service (src/server/inventory/stock-count.ts) and the production
 * inventory/product repositories run unchanged; only their database client is
 * swapped, through the repositories' own test seams, for a small
 * PostgREST-shaped adapter that issues plain SQL — including `.rpc()`, so
 * record_stock_count_v1's locks, stale check, ledger insert and audit insert
 * are the real ones.
 *
 * Covers: scan product, manual lookup, counted quantity, difference
 * calculation, zero difference, positive adjustment, negative adjustment,
 * permission denial, cross-org denial, ledger adjustment.
 *
 * Run: bun test src/tests/stock-count.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import { setInventoryRepositoryDbForTests } from "../server/inventory/repository";
import { setProductRepositoryDbForTests } from "../server/products/repository";
import {
  getStockCountItem,
  previewStockCount,
  recordStockCount,
  resolveStockCountScan,
  searchStockCountProducts,
} from "../server/inventory/stock-count";
import {
  classifyStockCountError,
  compareStockCount,
  directionLabelKey,
  formatDifference,
  normalizeSearchQuery,
  parseCountedQuantity,
  stockCountErrorKey,
  stockCountRequestFingerprint,
  stockCountResultMessageKey,
  stockCountScanMessageKey,
  type RecordStockCountResult,
} from "../lib/stock-count";
import { createIdempotencyKeyHolder } from "../lib/idempotency";
import en from "../locales/en.json";
import km from "../locales/km.json";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
let f: Fixture;
let restoreInventory: () => void;
let restoreProducts: () => void;

const COUNTER_PERMS = ["inventory.adjust", "inventory.read", "products.read"];
const MEMBER_B = "aaaaaaaa-0000-4000-8000-0000000000b3";

function ctx(
  organizationId: string,
  permissions: string[] = COUNTER_PERMS,
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
        // PostgREST's eq.null matches nothing; mirror that so a repository
        // that forgets .is() fails here exactly as it would in production.
        if (value === null) where.push("false");
        else {
          values.push(value);
          where.push(`${ident(col)} = $${values.length}`);
        }
        return chain;
      },
      is(col: string, value: null) {
        if (value !== null) throw new Error("adapter supports is(col, null) only");
        where.push(`${ident(col)} is null`);
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
    async rpc(fn: string, args: Record<string, unknown>) {
      const entries = Object.entries(args);
      const sql = `select * from ${ident(fn)}(${entries
        .map(([k], i) => `${ident(k)} => $${i + 1}`)
        .join(",")})`;
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
        // A scalar-returning function comes back as one row with one column
        // named after it; a set-returning one as rows.
        const scalar = rows.length === 1 && Object.keys(rows[0]).join() === fn;
        return { data: scalar ? rows[0][fn] : rows, error: null };
      } catch (error: any) {
        return { data: null, error: { code: error?.code, message: String(error?.message) } };
      }
    },
  };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

interface Seeded {
  product: string;
  variant: string;
  barcode: string;
  sku: string;
}

async function seedVariant(
  org: string,
  barcode: string,
  names: { km: string; en: string | null; variant: string } = {
    km: "អាវយឺត",
    en: "T-shirt",
    variant: "Blue M",
  },
  status: "ACTIVE" | "ARCHIVED" = "ACTIVE",
): Promise<Seeded> {
  const product = crypto.randomUUID();
  const variant = crypto.randomUUID();
  const sku = `SKU-${variant.slice(0, 8)}`;
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    names.km,
    names.en,
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,barcode,name,price_amount,price_currency,status)
     values($1,$2,$3,$4,$5,$6,1500,'USD',$7)`,
    [variant, org, product, sku, barcode, names.variant, status],
  );
  return { product, variant, barcode, sku };
}

async function stockIn(org: string, s: Seeded, quantity: number, location: string | null) {
  await f.db.query(
    `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
     values($1,$2,$3,$4,$5,'restock')`,
    [org, s.product, s.variant, location, quantity],
  );
}

async function ledger(variant: string) {
  return (
    await f.db.query<any>(
      `select * from inventory_movements where variant_id=$1 order by created_at, id`,
      [variant],
    )
  ).rows;
}

async function onHandAt(variant: string, location: string | null): Promise<number> {
  const rows = (
    await f.db.query<{ q: number | null }>(
      `select sum(quantity_delta)::int as q from inventory_movements
       where variant_id=$1 and location_id is not distinct from $2`,
      [variant, location],
    )
  ).rows;
  return rows[0]?.q ?? 0;
}

async function countRows(variant: string) {
  return (
    await f.db.query<any>(`select * from stock_counts where variant_id=$1 order by created_at`, [
      variant,
    ])
  ).rows;
}

async function auditRowsFor(variant: string) {
  return (
    await f.db.query<any>(
      `select * from audit_logs where action='inventory.adjust' and resource_id=$1 order by created_at`,
      [variant],
    )
  ).rows;
}

let A: Seeded;
let soap: Seeded;
let upc: Seeded;
let archived: Seeded;
let B: Seeded;
let locationA: string;
let locationA2: string;
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
  soap = await seedVariant(f.org, "8850002000016", {
    km: "សាប៊ូ",
    en: "Soap 100% natural",
    variant: "Lemon",
  });
  upc = await seedVariant(f.org, "0012345678905");
  archived = await seedVariant(
    f.org,
    "8850009999993",
    { km: "អាវយឺត", en: "T-shirt", variant: "Old" },
    "ARCHIVED",
  );
  B = await seedVariant(f.orgB, "8859999000011", { km: "អាវយឺត", en: "T-shirt", variant: "B" });
  const insertLocation = async (org: string, name: string) =>
    (
      await f.db.query<{ id: string }>(
        `insert into locations(organization_id,name) values($1,$2) returning id`,
        [org, name],
      )
    ).rows[0]!.id;
  locationA = await insertLocation(f.org, "Main shop");
  locationA2 = await insertLocation(f.org, "Warehouse");
  locationB = await insertLocation(f.orgB, "Other shop");

  await stockIn(f.org, A, 20, locationA);
  await stockIn(f.org, A, 7, locationA2);
  await stockIn(f.org, A, 3, null);
  await stockIn(f.orgB, B, 50, locationB);
}, 120_000);

afterAll(async () => {
  restoreInventory?.();
  restoreProducts?.();
  await f?.close();
});

function recorded(result: RecordStockCountResult) {
  if (result.kind !== "recorded") throw new Error(`expected recorded, got ${result.kind}`);
  return result;
}

// ── Scan product ──────────────────────────────────────────────────────────────

describe("scan product", () => {
  it("resolves a scanned barcode to the variant with the system quantity AT the chosen location", async () => {
    const result = await resolveStockCountScan(ctx(f.org), A.barcode, locationA);
    expect(result.kind).toBe("item");
    if (result.kind !== "item") return;
    expect(result.item.variantId).toBe(A.variant);
    expect(result.item.productId).toBe(A.product);
    expect(result.item.productNameKm).toBe("អាវយឺត");
    expect(result.item.locationId).toBe(locationA);
    expect(result.item.systemQuantity).toBe(await onHandAt(A.variant, locationA));
    // Identity only — no price or cost leaves the server.
    expect(JSON.stringify(result)).not.toMatch(/price|cost/i);
  });

  it("each location (and 'no location') is its own scope", async () => {
    const at = async (location: string | null) => {
      const r = await resolveStockCountScan(ctx(f.org), A.barcode, location);
      return r.kind === "item" ? r.item.systemQuantity : null;
    };
    expect(await at(locationA2)).toBe(await onHandAt(A.variant, locationA2));
    expect(await at(null)).toBe(await onHandAt(A.variant, null));
    expect(await at(locationA)).not.toBe(await at(locationA2));
  });

  it("matches a 12-digit UPC-A scan and an APSA variant QR", async () => {
    const r1 = await resolveStockCountScan(ctx(f.org), "012345678905", null);
    expect(r1.kind === "item" && r1.item.variantId).toBe(upc.variant);
    const r2 = await resolveStockCountScan(ctx(f.org), `apsa:variant/${A.variant}`, null);
    expect(r2.kind).toBe("item");
  });

  it("refuses parcel/order codes, unknown codes and archived variants", async () => {
    expect(
      (await resolveStockCountScan(ctx(f.org), `apsa:order/${crypto.randomUUID()}`, null)).kind,
    ).toBe("not_a_product");
    expect((await resolveStockCountScan(ctx(f.org), "0000000000000", null)).kind).toBe("not_found");
    expect((await resolveStockCountScan(ctx(f.org), "   ", null)).kind).toBe("not_found");
    expect((await resolveStockCountScan(ctx(f.org), archived.barcode, null)).kind).toBe(
      "not_found",
    );
  });
});

// ── Manual lookup ─────────────────────────────────────────────────────────────

describe("manual lookup", () => {
  it("finds active variants by Khmer name, English name, variant name, SKU and barcode", async () => {
    const ids = async (q: string) =>
      (await searchStockCountProducts(ctx(f.org), q)).results.map((r) => r.variantId);
    expect(await ids("សាប៊ូ")).toEqual([soap.variant]);
    expect(await ids("soap")).toEqual([soap.variant]);
    expect(await ids("lemon")).toEqual([soap.variant]);
    expect(await ids(soap.sku.toLowerCase())).toEqual([soap.variant]);
    expect(await ids(soap.barcode)).toEqual([soap.variant]);
    // Archived variants are not offered.
    expect(await ids("T-shirt")).not.toContain(archived.variant);
    expect(await ids("T-shirt")).toContain(A.variant);
  });

  it("matches the query literally: LIKE wildcards in it are not wildcards", async () => {
    const r = await searchStockCountProducts(ctx(f.org), "100%");
    expect(r.results.map((x) => x.variantId)).toEqual([soap.variant]);
    expect((await searchStockCountProducts(ctx(f.org), "%%")).results).toEqual([]);
    expect((await searchStockCountProducts(ctx(f.org), "__")).results).toEqual([]);
  });

  it("too short a query never reaches a lookup", async () => {
    expect((await searchStockCountProducts(ctx(f.org), " a ")).results).toEqual([]);
  });

  it("returns identity only, and the chosen result is read with its system quantity", async () => {
    const hit = (await searchStockCountProducts(ctx(f.org), "T-shirt")).results.find(
      (r) => r.variantId === A.variant,
    )!;
    expect(JSON.stringify(hit)).not.toMatch(/price|cost|quantity/i);
    const item = await getStockCountItem(ctx(f.org), hit.variantId, locationA);
    expect(item.kind === "item" && item.item.systemQuantity).toBe(
      await onHandAt(A.variant, locationA),
    );
  });
});

// ── Counted quantity + difference calculation ─────────────────────────────────

describe("counted quantity", () => {
  it("accepts 0..1,000,000 whole units; rejects anything else before writing", async () => {
    const rowsBefore = (await ledger(A.variant)).length;
    for (const counted of [-1, 1.5, 1_000_001, Number.NaN]) {
      await expect(
        previewStockCount(ctx(f.org), {
          variantId: A.variant,
          locationId: locationA,
          countedQuantity: counted,
        }),
      ).rejects.toThrow(/counted_quantity must be a whole number/);
      await expect(
        recordStockCount(ctx(f.org), {
          countKey: crypto.randomUUID(),
          variantId: A.variant,
          locationId: locationA,
          countedQuantity: counted,
          expectedSystemQuantity: 0,
        }),
      ).rejects.toThrow(/counted_quantity must be a whole number/);
    }
    expect((await ledger(A.variant)).length).toBe(rowsBefore);
  });

  it("client parse: 0 is a valid count, negatives/fractions/text are not", () => {
    expect(parseCountedQuantity("0")).toBe(0);
    expect(parseCountedQuantity("1,250")).toBe(1250);
    for (const bad of ["", "-1", "1.5", "abc", "1000001"]) {
      expect(parseCountedQuantity(bad)).toBeNull();
    }
  });
});

describe("difference calculation", () => {
  it("difference is counted − system and the result is always the counted quantity", () => {
    expect(compareStockCount(20, 17)).toEqual({
      systemQuantity: 20,
      countedQuantity: 17,
      difference: -3,
      resultingQuantity: 17,
      direction: "decrease",
    });
    expect(compareStockCount(5, 9).difference).toBe(4);
    expect(compareStockCount(5, 9).direction).toBe("increase");
    // A negative ledger balance is reconciled to the physical count too.
    expect(compareStockCount(-4, 2)).toMatchObject({ difference: 6, resultingQuantity: 2 });
    expect(formatDifference(4)).toBe("+4");
    expect(formatDifference(-3)).toBe("-3");
    expect(formatDifference(0)).toBe("0");
  });

  it("the server preview compares against the live ledger for that scope and writes nothing", async () => {
    const rowsBefore = (await ledger(A.variant)).length;
    const system = await onHandAt(A.variant, locationA2);
    const preview = await previewStockCount(ctx(f.org), {
      variantId: A.variant,
      locationId: locationA2,
      countedQuantity: system + 2,
    });
    expect(preview).toEqual({ kind: "preview", preview: compareStockCount(system, system + 2) });
    expect((await ledger(A.variant)).length).toBe(rowsBefore);
  });
});

// ── Zero / positive / negative adjustment ─────────────────────────────────────

describe("zero difference", () => {
  it("records the count with no ledger movement and no adjustment audit", async () => {
    const system = await onHandAt(A.variant, locationA);
    const ledgerBefore = (await ledger(A.variant)).length;
    const auditBefore = (await auditRowsFor(A.variant)).length;

    const result = recorded(
      await recordStockCount(ctx(f.org), {
        countKey: crypto.randomUUID(),
        variantId: A.variant,
        locationId: locationA,
        countedQuantity: system,
        expectedSystemQuantity: system,
      }),
    );
    expect(result.replayed).toBe(false);
    expect(result.count.difference).toBe(0);
    expect(result.count.movementId).toBeNull();
    expect((await ledger(A.variant)).length).toBe(ledgerBefore);
    expect((await auditRowsFor(A.variant)).length).toBe(auditBefore);
    expect(await onHandAt(A.variant, locationA)).toBe(system);
    const row = (await countRows(A.variant)).find((r: any) => r.id === result.count.countId);
    expect(row).toMatchObject({ system_quantity: system, counted_quantity: system, difference: 0 });
  });
});

describe("positive adjustment", () => {
  it("counting more than the ledger appends one +difference manual_adjustment", async () => {
    const system = await onHandAt(A.variant, locationA);
    const result = recorded(
      await recordStockCount(ctx(f.org), {
        countKey: crypto.randomUUID(),
        variantId: A.variant,
        locationId: locationA,
        countedQuantity: system + 5,
        expectedSystemQuantity: system,
      }),
    );
    expect(result.count.difference).toBe(5);
    expect(result.count.movementId).toBeString();
    expect(await onHandAt(A.variant, locationA)).toBe(system + 5);
    const row = (await ledger(A.variant)).find((r: any) => r.id === result.count.movementId);
    expect(row).toMatchObject({ quantity_delta: 5, movement_type: "manual_adjustment" });
  });
});

describe("negative adjustment", () => {
  it("counting less than the ledger appends one −difference manual_adjustment", async () => {
    const system = await onHandAt(A.variant, locationA);
    const result = recorded(
      await recordStockCount(ctx(f.org), {
        countKey: crypto.randomUUID(),
        variantId: A.variant,
        locationId: locationA,
        countedQuantity: system - 4,
        expectedSystemQuantity: system,
      }),
    );
    expect(result.count.difference).toBe(-4);
    expect(await onHandAt(A.variant, locationA)).toBe(system - 4);
    const row = (await ledger(A.variant)).find((r: any) => r.id === result.count.movementId);
    expect(row).toMatchObject({ quantity_delta: -4, movement_type: "manual_adjustment" });
  });

  it("counting zero writes the whole balance off", async () => {
    const system = await onHandAt(A.variant, null);
    expect(system).toBeGreaterThan(0);
    recorded(
      await recordStockCount(ctx(f.org), {
        countKey: crypto.randomUUID(),
        variantId: A.variant,
        locationId: null,
        countedQuantity: 0,
        expectedSystemQuantity: system,
      }),
    );
    expect(await onHandAt(A.variant, null)).toBe(0);
  });
});

// ── Ledger adjustment ─────────────────────────────────────────────────────────

describe("ledger adjustment", () => {
  it("writes an immutable, referenced, audited ledger row and touches no other location", async () => {
    const otherBefore = await onHandAt(A.variant, locationA2);
    const system = await onHandAt(A.variant, locationA);
    const key = crypto.randomUUID();
    const result = recorded(
      await recordStockCount(ctx(f.org), {
        countKey: key,
        variantId: A.variant,
        locationId: locationA,
        countedQuantity: system + 1,
        expectedSystemQuantity: system,
      }),
    );
    const movement = (await ledger(A.variant)).find((r: any) => r.id === result.count.movementId);
    expect(movement).toMatchObject({
      organization_id: f.org,
      product_id: A.product,
      location_id: locationA,
      quantity_delta: 1,
      movement_type: "manual_adjustment",
      reference_type: "stock_count",
      reference_id: result.count.countId,
      reason: "Stock count",
      created_by: f.actor,
    });
    expect(await onHandAt(A.variant, locationA2)).toBe(otherBefore);

    const count = (await countRows(A.variant)).find((r: any) => r.id === result.count.countId);
    expect(count).toMatchObject({
      count_key: key,
      system_quantity: system,
      counted_quantity: system + 1,
      difference: 1,
      movement_id: movement.id,
      created_by: f.actor,
    });

    const audit = (await auditRowsFor(A.variant)).find(
      (r: any) => r.after_json?.movement_id === movement.id,
    );
    expect(audit).toBeDefined();
    expect(audit.organization_id).toBe(f.org);
    expect(audit.actor_user_id).toBe(f.actor);
    expect(audit.before_json).toEqual({ system_quantity: system });
    expect(audit.after_json).toMatchObject({
      counted_quantity: system + 1,
      quantity_delta: 1,
      stock_count_id: result.count.countId,
    });

    // Ledger and count history are append-only.
    await expect(
      f.db.query(`update stock_counts set counted_quantity = 999 where id = $1`, [count.id]),
    ).rejects.toThrow(/append-only/);
    await expect(f.db.query(`delete from stock_counts where id = $1`, [count.id])).rejects.toThrow(
      /append-only/,
    );
    try {
      await expect(
        f.db.exec(`set role authenticated; update inventory_movements set quantity_delta=999;`),
      ).rejects.toThrow();
    } finally {
      await f.db.exec(`reset role;`);
    }
  });

  it("refuses as stale — writing nothing — when the ledger moved since the preview", async () => {
    const shown = await onHandAt(A.variant, locationA);
    await stockIn(f.org, A, 2, locationA); // a sale/receipt lands between preview and confirm
    const ledgerBefore = (await ledger(A.variant)).length;
    const countsBefore = (await countRows(A.variant)).length;
    const result = await recordStockCount(ctx(f.org), {
      countKey: crypto.randomUUID(),
      variantId: A.variant,
      locationId: locationA,
      countedQuantity: shown,
      expectedSystemQuantity: shown,
    });
    expect(result).toEqual({ kind: "stale", systemQuantity: shown + 2 });
    expect((await ledger(A.variant)).length).toBe(ledgerBefore);
    expect((await countRows(A.variant)).length).toBe(countsBefore);
  });

  it("a retried count (same key, same request) is replayed and adjusts nothing twice", async () => {
    const system = await onHandAt(A.variant, locationA);
    const request = {
      countKey: crypto.randomUUID(),
      variantId: A.variant,
      locationId: locationA,
      countedQuantity: system - 1,
      expectedSystemQuantity: system,
    };
    const results = (
      await Promise.all([
        recordStockCount(ctx(f.org), request),
        recordStockCount(ctx(f.org), request),
        recordStockCount(ctx(f.org), request),
      ])
    ).map(recorded);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.count.movementId)).size).toBe(1);
    expect(await onHandAt(A.variant, locationA)).toBe(system - 1);
    const retry = recorded(await recordStockCount(ctx(f.org), request));
    expect(retry.replayed).toBe(true);
    expect(await onHandAt(A.variant, locationA)).toBe(system - 1);
  });

  it("the same key with a different request or member is a conflict and writes nothing", async () => {
    const system = await onHandAt(A.variant, locationA);
    const key = crypto.randomUUID();
    const base = {
      countKey: key,
      variantId: A.variant,
      locationId: locationA,
      countedQuantity: system,
      expectedSystemQuantity: system,
    };
    recorded(await recordStockCount(ctx(f.org), base));
    const ledgerBefore = (await ledger(A.variant)).length;
    const cases: Array<[any, any]> = [
      [ctx(f.org), { ...base, countedQuantity: system + 3 }],
      [ctx(f.org), { ...base, locationId: locationA2 }],
      [ctx(f.org), { ...base, variantId: soap.variant, expectedSystemQuantity: 0 }],
      [ctx(f.org, COUNTER_PERMS, MEMBER_B), base],
    ];
    for (const [caller, request] of cases) {
      expect((await recordStockCount(caller, request)).kind).toBe("count_conflict");
    }
    expect((await ledger(A.variant)).length).toBe(ledgerBefore);
  });

  it("migration 053 constraints: count references are manual adjustments, one per count", async () => {
    const insert = (type: string, ref: string) =>
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type,reference_type,reference_id,reason)
         values($1,$2,$3,1,$4,'stock_count',$5,'x')`,
        [f.org, A.product, A.variant, type, ref],
      );
    await expect(insert("restock", crypto.randomUUID())).rejects.toThrow(/stock_count_shape/);
    const ref = crypto.randomUUID();
    await insert("manual_adjustment", ref);
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type,reference_type,reference_id,reason)
         values($1,$2,$3,1,'manual_adjustment','stock_count',$4,'x')`,
        [f.org, soap.product, soap.variant, ref],
      ),
    ).rejects.toThrow(/uniq_inventory_movements_stock_count|duplicate key/);
  });
});

// ── Permission denial ─────────────────────────────────────────────────────────

describe("permission denial", () => {
  it("without inventory.adjust no step is allowed — scan, search, item, preview, record", async () => {
    const cashier = ctx(f.org, ["inventory.read", "products.read", "inventory.receive_stock"]);
    const denied = "Missing permission: inventory.adjust";
    await expect(resolveStockCountScan(cashier, A.barcode, null)).rejects.toThrow(denied);
    await expect(searchStockCountProducts(cashier, "soap")).rejects.toThrow(denied);
    await expect(getStockCountItem(cashier, A.variant, null)).rejects.toThrow(denied);
    await expect(
      previewStockCount(cashier, { variantId: A.variant, locationId: null, countedQuantity: 1 }),
    ).rejects.toThrow(denied);
    const ledgerBefore = (await ledger(A.variant)).length;
    await expect(
      recordStockCount(cashier, {
        countKey: crypto.randomUUID(),
        variantId: A.variant,
        locationId: null,
        countedQuantity: 1,
        expectedSystemQuantity: 0,
      }),
    ).rejects.toThrow(denied);
    expect((await ledger(A.variant)).length).toBe(ledgerBefore);
  });

  it("inventory.read is required to see the system quantity; products.read to identify a product", async () => {
    await expect(
      previewStockCount(ctx(f.org, ["inventory.adjust"]), {
        variantId: A.variant,
        locationId: null,
        countedQuantity: 1,
      }),
    ).rejects.toThrow("Missing permission: inventory.read");
    await expect(
      resolveStockCountScan(ctx(f.org, ["inventory.adjust", "inventory.read"]), A.barcode, null),
    ).rejects.toThrow("Missing permission: products.read");
  });

  it("the permission check runs before any count-key lookup (no replay to the unauthorized)", async () => {
    const system = await onHandAt(A.variant, locationA);
    const request = {
      countKey: crypto.randomUUID(),
      variantId: A.variant,
      locationId: locationA,
      countedQuantity: system,
      expectedSystemQuantity: system,
    };
    recorded(await recordStockCount(ctx(f.org), request));
    await expect(recordStockCount(ctx(f.org, ["inventory.read"]), request)).rejects.toThrow(
      "Missing permission",
    );
  });

  it("migration 022 grants inventory.adjust to OWNER and MANAGER only", async () => {
    const roles = (
      await f.db.query<{ system_role: string }>(
        `select r.system_role from role_permissions rp
         join roles r on r.id = rp.role_id
         join permissions p on p.id = rp.permission_id
         where p.key = 'inventory.adjust' and r.organization_id is null`,
      )
    ).rows
      .map((r) => r.system_role)
      .sort();
    expect(roles).toEqual(["MANAGER", "OWNER"]);
  });

  it("JWT clients cannot call the count RPCs or write stock_counts directly", async () => {
    try {
      await f.db.exec(`set role authenticated;`);
      await expect(
        f.db.query(`select record_stock_count_v1($1,$2,$3,$4,null,1,0)`, [
          f.org,
          f.actor,
          crypto.randomUUID(),
          A.variant,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        f.db.query(`select * from search_stock_count_variants_v1($1,'soap',10)`, [f.org]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        f.db.query(
          `insert into stock_counts(organization_id,count_key,product_id,variant_id,system_quantity,counted_quantity,created_by)
           values($1,$2,$3,$4,0,0,$5)`,
          [f.org, crypto.randomUUID(), A.product, A.variant, f.actor],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await f.db.exec(`reset role;`);
    }
  });
});

// ── Cross-org denial ──────────────────────────────────────────────────────────

describe("cross-org denial", () => {
  it("another organization's barcode and variant QR resolve as not_found", async () => {
    expect((await resolveStockCountScan(ctx(f.org), B.barcode, null)).kind).toBe("not_found");
    expect((await resolveStockCountScan(ctx(f.org), `apsa:variant/${B.variant}`, null)).kind).toBe(
      "not_found",
    );
  });

  it("manual search never returns another organization's products", async () => {
    const results = (await searchStockCountProducts(ctx(f.org), "T-shirt")).results;
    expect(results.map((r) => r.variantId)).not.toContain(B.variant);
    expect((await searchStockCountProducts(ctx(f.org), B.barcode)).results).toEqual([]);
  });

  it("another organization's variant or location is refused at every step and nothing is written", async () => {
    expect((await getStockCountItem(ctx(f.org), B.variant, null)).kind).toBe("variant_not_found");
    expect((await getStockCountItem(ctx(f.org), A.variant, locationB)).kind).toBe(
      "location_not_found",
    );
    expect((await resolveStockCountScan(ctx(f.org), A.barcode, locationB)).kind).toBe(
      "location_not_found",
    );
    expect(
      (
        await previewStockCount(ctx(f.org), {
          variantId: B.variant,
          locationId: null,
          countedQuantity: 0,
        })
      ).kind,
    ).toBe("variant_not_found");
    const bBefore = await onHandAt(B.variant, locationB);
    expect(
      (
        await recordStockCount(ctx(f.org), {
          countKey: crypto.randomUUID(),
          variantId: B.variant,
          locationId: locationB,
          countedQuantity: 0,
          expectedSystemQuantity: bBefore,
        })
      ).kind,
    ).toBe("variant_not_found");
    expect(
      (
        await recordStockCount(ctx(f.org), {
          countKey: crypto.randomUUID(),
          variantId: A.variant,
          locationId: locationB,
          countedQuantity: 0,
          expectedSystemQuantity: 0,
        })
      ).kind,
    ).toBe("location_not_found");
    expect(await onHandAt(B.variant, locationB)).toBe(bBefore);
    expect(await countRows(B.variant)).toHaveLength(0);
  });

  it("count keys are scoped per organization: Org B cannot replay Org A's count", async () => {
    const key = crypto.randomUUID();
    const systemA = await onHandAt(A.variant, locationA);
    recorded(
      await recordStockCount(ctx(f.org), {
        countKey: key,
        variantId: A.variant,
        locationId: locationA,
        countedQuantity: systemA,
        expectedSystemQuantity: systemA,
      }),
    );
    const systemB = await onHandAt(B.variant, locationB);
    const inB = recorded(
      await recordStockCount(ctx(f.orgB), {
        countKey: key,
        variantId: B.variant,
        locationId: locationB,
        countedQuantity: systemB - 1,
        expectedSystemQuantity: systemB,
      }),
    );
    expect(inB.replayed).toBe(false);
    expect(inB.count.variantId).toBe(B.variant);
    expect(await onHandAt(B.variant, locationB)).toBe(systemB - 1);
  });
});

// ── Client helpers (pure) ─────────────────────────────────────────────────────

describe("client stock count helpers", () => {
  it("a retry of the same request reuses its count key; a changed request gets a new one", () => {
    let n = 0;
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`);
    const base = {
      variantId: "v",
      locationId: null,
      countedQuantity: 3,
      expectedSystemQuantity: 5,
    };
    const first = holder.keyFor(stockCountRequestFingerprint(base));
    expect(holder.keyFor(stockCountRequestFingerprint(base))).toBe(first);
    // A refreshed system quantity after a stale refusal is a new request.
    expect(
      holder.keyFor(stockCountRequestFingerprint({ ...base, expectedSystemQuantity: 6 })),
    ).not.toBe(first);
    holder.release();
    expect(holder.keyFor(stockCountRequestFingerprint(base))).not.toBe(first);
  });

  it("search input is trimmed and bounded", () => {
    expect(normalizeSearchQuery("  soap ")).toBe("soap");
    expect(normalizeSearchQuery("a")).toBeNull();
    expect(normalizeSearchQuery("x".repeat(101))).toBeNull();
  });

  it("every outcome maps to localized copy present in both locales", () => {
    const keys = [
      stockCountScanMessageKey({ kind: "not_found" }),
      stockCountScanMessageKey({ kind: "not_a_product" }),
      stockCountScanMessageKey({ kind: "location_not_found" }),
      stockCountResultMessageKey({ kind: "stale", systemQuantity: 1 }),
      stockCountResultMessageKey({ kind: "count_conflict" }),
      stockCountResultMessageKey({ kind: "variant_not_found" }),
      stockCountResultMessageKey({ kind: "location_not_found" }),
      stockCountErrorKey(classifyStockCountError(new Error("Missing permission: x"))),
      stockCountErrorKey(classifyStockCountError(new Error("counted_quantity must be"))),
      stockCountErrorKey(classifyStockCountError(new Error("boom"))),
      directionLabelKey("none"),
      directionLabelKey("increase"),
      directionLabelKey("decrease"),
    ];
    const lookup = (dict: any, key: string) =>
      key.split(".").reduce((node: any, part) => node?.[part], dict);
    for (const key of keys) {
      expect(key).toBeString();
      expect(lookup(en, key!), `en ${key}`).toBeString();
      expect(lookup(km, key!), `km ${key}`).toBeString();
    }
  });

  it("the stockCount.* locale blocks have identical key sets", () => {
    const flat = (node: any, prefix = ""): string[] =>
      Object.entries(node).flatMap(([k, v]) =>
        typeof v === "object" ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(flat((km as any).stockCount).sort()).toEqual(flat((en as any).stockCount).sort());
  });
});

// ── Boundary (source-level) ───────────────────────────────────────────────────

describe("server boundary", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

  it("no stock count server function accepts an organization, product, movement type, delta or balance", () => {
    const api = read("src/api/stock-count.ts");
    const handlers = api.slice(api.indexOf("resolveStockCountScanFn"));
    expect(handlers.match(/\.strict\(\)/g)?.length).toBe(5);
    expect(handlers).not.toMatch(
      /organizationId|productId|movementType|quantityDelta|quantityOnHand|difference/,
    );
  });

  it("the stock count screen and browser lib never import server modules", () => {
    for (const file of ["src/lib/stock-count.ts", "src/routes/app.inventory.count.tsx"]) {
      expect(read(file)).not.toMatch(/from "@\/server\/|supabase/);
    }
  });

  it("migration 053 is additive and adds no permission", () => {
    const sql = read("supabase/migrations/053_stock_counts.sql");
    expect(sql).not.toMatch(/DROP\s/i);
    expect(sql).not.toMatch(/INSERT INTO public\.permissions/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.inventory_movements\s+(DROP|ALTER)/i);
  });
});
