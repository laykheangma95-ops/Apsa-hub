/**
 * Customer Returns — production service against REAL SQL.
 *
 * Every migration (including 055 and 056) is applied to PGlite. The production
 * returns service (src/server/returns/service.ts) and repository run
 * unchanged; only the repository's database client is swapped, through its own
 * test seam, for a small PostgREST-shaped adapter that issues plain SQL —
 * including `.rpc()`, so request/receive/inspect/complete_customer_return_v1's
 * locks, guards, ledger inserts, history and audit are the real ones. Orders
 * are confirmed through the real transition_order_status_v1, so the `sale`
 * movements a return reverses are the ones production writes.
 *
 * Covers: resellable flow, damaged flow (and a mixed split), inventory and
 * ledger verification, append-only history, permission denial, cross-org
 * denial, duplicate prevention (request key replay/conflict, repeated steps,
 * over-return, stale completion), delivered-only gating, cancel-after-return
 * guard.
 *
 * Run: bun test src/tests/customer-returns.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";
import {
  MAX_PAGES,
  PAGE_SIZE,
  listReturnEvents,
  setReturnsRepositoryDbForTests,
} from "../server/returns/repository";
import { setInventoryRepositoryDbForTests } from "../server/inventory/repository";
import { recordMovement } from "../server/inventory/service";
import {
  completeCustomerReturn,
  findReturnableOrder,
  getCustomerReturn,
  inspectCustomerReturn,
  listCustomerReturns,
  receiveCustomerReturn,
  requestCustomerReturn,
} from "../server/returns/service";
import {
  buildInspection,
  buildReturnRequest,
  currentInspection,
  ledgerEffect,
  nextReturnAction,
  parseReturnQuantity,
  requestReturnMessageKey,
  returnRequestFingerprint,
  returnStepMessageKey,
  returnTotals,
  returnableOrderMessageKey,
  type ReturnDetail,
  type ReturnStepResult,
} from "../lib/returns";
import { UI_PERMISSION_KEYS } from "../lib/capabilities";
import en from "../locales/en.json";
import km from "../locales/km.json";

type Fixture = Awaited<ReturnType<typeof financialFixture>>;
let f: Fixture;
let restore: () => void;

const RETURN_PERMS = ["orders.return", "orders.read"];
const MEMBER_B = "bbbbbbbb-0000-4000-8000-0000000000b2";

function ctx(organizationId: string, permissions: string[] = RETURN_PERMS, userId?: string) {
  const perms = new Set(permissions);
  return {
    organizationId,
    userId: userId ?? (organizationId === f.orgB ? MEMBER_B : f.actor),
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

function columnList(value: string): string {
  if (value === "*") return value;
  return value
    .split(",")
    .map((c) => ident(c.trim()))
    .join(", ");
}

/**
 * PostgREST's max-rows: no response carries more rows than this, whatever the
 * request asked for — silently. The adapter enforces it so a repository that
 * forgets to page fails here exactly as it would in production.
 */
const POSTGREST_MAX_ROWS = 1000;

/** Every response the adapter served, for asserting reads were capped and paged. */
const served: Array<{ table: string; rows: number }> = [];

function sqlDb() {
  function query(table: string) {
    const where: string[] = [];
    const values: unknown[] = [];
    const ordering: string[] = [];
    let columns = "*";
    let limit: number | undefined;
    let offset = 0;
    let mode: "many" | "single" | "maybe" = "many";

    async function run() {
      let sql = `select ${columns} from ${table}`;
      if (where.length) sql += ` where ${where.join(" and ")}`;
      if (ordering.length) sql += ` order by ${ordering.join(",")}`;
      sql += ` limit ${Math.min(limit ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS)} offset ${offset}`;
      try {
        const rows = JSON.parse(JSON.stringify((await f.db.query(sql, values)).rows));
        served.push({ table, rows: rows.length });
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
        columns = columnList(cols);
        return chain;
      },
      eq(col: string, value: unknown) {
        // PostgREST's eq.null matches nothing; mirror that.
        if (value === null) where.push("false");
        else {
          values.push(value);
          where.push(`${ident(col)}::text = $${values.length}::text`);
        }
        return chain;
      },
      in(col: string, list: unknown[]) {
        values.push(list.map(String));
        where.push(`${ident(col)}::text = any($${values.length}::text[])`);
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
            const rows = (
              await f.db.query(
                sql,
                entries.map(([, v]) => v),
              )
            ).rows;
            return { data: JSON.parse(JSON.stringify(rows[0] ?? null)), error: null };
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
      const sql = `select ${ident(fn)}(${entries
        .map(([k], i) => `${ident(k)} => $${i + 1}`)
        .join(",")}) as result`;
      try {
        const rows = (
          await f.db.query<{ result: unknown }>(
            sql,
            // PostgREST sends JSON bodies; objects and arrays arrive as jsonb.
            entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
          )
        ).rows;
        return { data: JSON.parse(JSON.stringify(rows[0]!.result)), error: null };
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
}

async function seedVariant(org: string, name = "អាវយឺត"): Promise<Seeded> {
  const product = crypto.randomUUID();
  const variant = crypto.randomUUID();
  await f.db.query(`insert into products(id,organization_id,name_km,name_en) values($1,$2,$3,$4)`, [
    product,
    org,
    name,
    "T-shirt",
  ]);
  await f.db.query(
    `insert into product_variants(id,organization_id,product_id,sku,name,price_amount,price_currency)
     values($1,$2,$3,$4,'Blue M',1500,'USD')`,
    [variant, org, product, `SKU-${variant.slice(0, 8)}`],
  );
  return { product, variant };
}

async function stockIn(org: string, s: Seeded, quantity: number, location: string | null) {
  await f.db.query(
    `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
     values($1,$2,$3,$4,$5,'restock')`,
    [org, s.product, s.variant, location, quantity],
  );
}

interface SeededOrder {
  orderId: string;
  orderNumber: string;
  items: string[];
}

/**
 * An order of `lines`, confirmed through the real transition (writes the
 * `sale` movements), with one delivery in `deliveryStatus` (none when null).
 */
async function seedOrder(
  org: string,
  lines: Array<{ s: Seeded; quantity: number }>,
  opts: {
    location?: string | null;
    deliveryStatus?: "delivered" | "in_transit" | null;
    confirm?: boolean;
  } = {},
): Promise<SeededOrder> {
  const orderId = crypto.randomUUID();
  const orderNumber = `RET-${orderId.slice(0, 8)}`;
  const unit = 1000;
  const subtotal = lines.reduce((sum, line) => sum + unit * line.quantity, 0);
  await f.db.query(
    `insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by,location_id)
     values($1,$2,$3,'MANUAL','USD',$4,$4,$5,$6)`,
    [orderId, org, orderNumber, subtotal, f.actor, opts.location ?? null],
  );
  const items: string[] = [];
  for (const line of lines) {
    const id = crypto.randomUUID();
    items.push(id);
    await f.db.query(
      `insert into order_items(id,organization_id,order_id,product_id,variant_id,product_name_snapshot,
         variant_name_snapshot,sku_snapshot,unit_price_minor,quantity,line_total_minor)
       values($1,$2,$3,$4,$5,'អាវយឺត','Blue M','SKU',$6,$7,$8)`,
      [id, org, orderId, line.s.product, line.s.variant, unit, line.quantity, unit * line.quantity],
    );
  }
  if (opts.confirm !== false) {
    const result = await f.rpc("transition_order_status_v1", [
      org,
      orderId,
      "lifecycle",
      "draft",
      "confirmed",
      f.actor,
      null,
    ]);
    if (result.status !== "success") throw new Error(`confirm: ${JSON.stringify(result)}`);
  }
  const deliveryStatus = opts.deliveryStatus === undefined ? "delivered" : opts.deliveryStatus;
  if (deliveryStatus !== null) {
    await f.db.query(
      `insert into deliveries(organization_id,order_id,location_id,provider_name,status,created_by)
       values($1,$2,$3,'Manual courier',$4,$5)`,
      [org, orderId, opts.location ?? null, deliveryStatus, f.actor],
    );
  }
  return { orderId, orderNumber, items };
}

async function ledger(variant: string) {
  return (
    await f.db.query<any>(
      `select * from inventory_movements where variant_id=$1 order by created_at, id`,
      [variant],
    )
  ).rows;
}

async function onHand(variant: string, location: string | null = null): Promise<number> {
  const rows = (
    await f.db.query<{ q: number | null }>(
      `select sum(quantity_delta)::int as q from inventory_movements
       where variant_id=$1 and location_id is not distinct from $2`,
      [variant, location],
    )
  ).rows;
  return rows[0]?.q ?? 0;
}

async function returnMovements(variant: string) {
  return (
    await f.db.query<any>(
      `select * from inventory_movements
       where variant_id=$1 and reference_type='customer_return_item'
       order by created_at, movement_type`,
      [variant],
    )
  ).rows;
}

async function events(returnId: string) {
  return (
    await f.db.query<any>(
      `select * from customer_return_events where return_id=$1 order by created_at, id`,
      [returnId],
    )
  ).rows;
}

async function countRows(table: string, where = "true", params: unknown[] = []) {
  const rows = (
    await f.db.query<{ c: number }>(
      `select count(*)::int as c from ${table} where ${where}`,
      params,
    )
  ).rows;
  return rows[0]!.c;
}

function ok(result: ReturnStepResult): ReturnDetail {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.detail;
}

async function requested(
  org: string,
  order: SeededOrder,
  lines: Array<{ item: number; quantity: number }>,
  requestKey = crypto.randomUUID(),
): Promise<string> {
  const result = await requestCustomerReturn(ctx(org), {
    requestKey,
    orderId: order.orderId,
    lines: lines.map((l) => ({ orderItemId: order.items[l.item]!, quantity: l.quantity })),
  });
  if (result.kind !== "requested") throw new Error(`request: ${JSON.stringify(result)}`);
  return result.returnId;
}

/** request → receive → inspect (damaged per line, in item order). */
async function inspected(
  org: string,
  order: SeededOrder,
  lines: Array<{ item: number; quantity: number; damaged: number }>,
): Promise<ReturnDetail> {
  const returnId = await requested(org, order, lines);
  ok(await receiveCustomerReturn(ctx(org), returnId));
  const detail = ok(await getCustomerReturnDetail(org, returnId));
  const byOrderItem = new Map(lines.map((l) => [order.items[l.item]!, l.damaged]));
  return ok(
    await inspectCustomerReturn(ctx(org), {
      returnId,
      lines: detail.lines.map((line) => ({
        returnItemId: line.returnItemId,
        damagedQuantity: byOrderItem.get(line.orderItemId)!,
      })),
    }),
  );
}

async function getCustomerReturnDetail(org: string, returnId: string): Promise<ReturnStepResult> {
  const result = await getCustomerReturn(ctx(org), returnId);
  return result.kind === "return"
    ? { kind: "ok", detail: result.detail, replayed: false }
    : { kind: "return_not_found" };
}

let location: string;
let locationB: string;

beforeAll(async () => {
  f = await financialFixture();
  const db = sqlDb();
  const restoreReturns = setReturnsRepositoryDbForTests(db);
  const restoreInventory = setInventoryRepositoryDbForTests(db);
  restore = () => {
    restoreReturns();
    restoreInventory();
  };
  await f.db.query(`insert into auth.users(id,email) values($1,'member-b@test.invalid')`, [
    MEMBER_B,
  ]);
  location = (
    await f.db.query<{ id: string }>(
      `insert into locations(organization_id,name) values($1,'Main shop') returning id`,
      [f.org],
    )
  ).rows[0]!.id;
  locationB = (
    await f.db.query<{ id: string }>(
      `insert into locations(organization_id,name) values($1,'B shop') returning id`,
      [f.orgB],
    )
  ).rows[0]!.id;
}, 180000);

afterAll(async () => {
  restore?.();
  await f?.close();
});

// ── Resellable flow ──────────────────────────────────────────────────────────

describe("resellable return", () => {
  it("moves through requested → received → inspected → completed, and stock moves only at completion", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 3 }], { location });
    expect(await onHand(s.variant, location)).toBe(7);

    const lookup = await findReturnableOrder(ctx(f.org), order.orderNumber);
    expect(lookup.kind).toBe("order");
    if (lookup.kind !== "order") return;
    expect(lookup.order.lines).toHaveLength(1);
    expect(lookup.order.lines[0]).toMatchObject({
      orderedQuantity: 3,
      alreadyReturned: 0,
      returnableQuantity: 3,
    });

    const returnId = await requested(f.org, order, [{ item: 0, quantity: 2 }]);
    let detail = ok(await getCustomerReturnDetail(f.org, returnId));
    expect(detail.status).toBe("requested");
    expect(detail.orderNumber).toBe(order.orderNumber);
    expect(detail.lines[0]).toMatchObject({ quantity: 2, damagedQuantity: null });
    expect(await onHand(s.variant, location)).toBe(7);

    detail = ok(await receiveCustomerReturn(ctx(f.org), returnId));
    expect(detail.status).toBe("received");
    expect(await onHand(s.variant, location)).toBe(7);

    detail = ok(
      await inspectCustomerReturn(ctx(f.org), {
        returnId,
        lines: [{ returnItemId: detail.lines[0]!.returnItemId, damagedQuantity: 0 }],
      }),
    );
    expect(detail.status).toBe("inspected");
    expect(detail.totals).toEqual({ quantity: 2, resellable: 2, damaged: 0 });
    expect(await onHand(s.variant, location)).toBe(7);

    detail = ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(detail.status).toBe("completed");

    // Inventory: the 2 resellable units are available again, at the sale's location.
    expect(await onHand(s.variant, location)).toBe(9);

    // Ledger: one `return` +2, no `damage`, referencing the return line.
    const moves = await returnMovements(s.variant);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      movement_type: "return",
      quantity_delta: 2,
      location_id: location,
      reference_type: "customer_return_item",
      reference_id: detail.lines[0]!.returnItemId,
      created_by: f.actor,
    });
    expect(detail.lines[0]!.returnMovementId).toBe(moves[0].id);
    expect(detail.lines[0]!.damageMovementId).toBeNull();

    // History: append-only, one row per step.
    const history = await events(returnId);
    expect(history.map((e: any) => [e.from_status, e.to_status])).toEqual([
      [null, "requested"],
      ["requested", "received"],
      ["received", "inspected"],
      ["inspected", "completed"],
    ]);
    expect(detail.history.map((e) => e.toStatus)).toEqual([
      "requested",
      "received",
      "inspected",
      "completed",
    ]);

    // Audit: request and the stock-changing completion, each once.
    expect(
      await countRows(
        "audit_logs",
        "resource_id=$1 and action in ('orders.return_requested','inventory.customer_return')",
        [returnId],
      ),
    ).toBe(2);

    // The remaining quantity shrinks for the next return.
    const after = await findReturnableOrder(ctx(f.org), order.orderNumber);
    expect(after.kind === "order" && after.order.lines[0]).toMatchObject({
      alreadyReturned: 2,
      returnableQuantity: 1,
    });
  });
});

// ── Damaged flow ─────────────────────────────────────────────────────────────

describe("damaged return", () => {
  it("records return +n and damage −n: sellable stock does not increase", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 3 }], { location });
    expect(await onHand(s.variant, location)).toBe(7);

    const detail = await inspected(f.org, order, [{ item: 0, quantity: 3, damaged: 3 }]);
    expect(detail.totals).toEqual({ quantity: 3, resellable: 0, damaged: 3 });

    const done = ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(done.status).toBe("completed");
    expect(await onHand(s.variant, location)).toBe(7);

    const moves = await returnMovements(s.variant);
    // Same transaction, so ordered by movement type: return (+3), then damage (−3).
    expect(moves.map((m: any) => [m.movement_type, m.quantity_delta])).toEqual([
      ["return", 3],
      ["damage", -3],
    ]);
    for (const m of moves) {
      expect(m.reference_id).toBe(done.lines[0]!.returnItemId);
      expect(m.location_id).toBe(location);
    }
    expect(done.lines[0]!.damageMovementId).not.toBeNull();
  });

  it("splits one line: resellable units come back, damaged units do not", async () => {
    const a = await seedVariant(f.org);
    const b = await seedVariant(f.org, "សាប៊ូ");
    await stockIn(f.org, a, 10, location);
    await stockIn(f.org, b, 10, location);
    const order = await seedOrder(
      f.org,
      [
        { s: a, quantity: 4 },
        { s: b, quantity: 2 },
      ],
      { location },
    );
    const detail = await inspected(f.org, order, [
      { item: 0, quantity: 4, damaged: 1 },
      { item: 1, quantity: 2, damaged: 0 },
    ]);
    ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(await onHand(a.variant, location)).toBe(6 + 3);
    expect(await onHand(b.variant, location)).toBe(8 + 2);
    expect((await returnMovements(a.variant)).map((m: any) => m.quantity_delta).sort()).toEqual([
      -1, 4,
    ]);
  });

  it("returns to an order sold without a location exactly where the sale took it from", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 5, null);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location: null });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 0 }]);
    ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(await onHand(s.variant, null)).toBe(5);
    expect((await returnMovements(s.variant))[0].location_id).toBeNull();
  });
});

// ── Duplicate prevention ─────────────────────────────────────────────────────

describe("duplicate prevention", () => {
  it("replays a retried request under the same key and refuses the key for a different request", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 3 }], { location });
    const key = crypto.randomUUID();
    const input = {
      requestKey: key,
      orderId: order.orderId,
      lines: [{ orderItemId: order.items[0]!, quantity: 1 }],
    };

    const first = await requestCustomerReturn(ctx(f.org), input);
    const second = await requestCustomerReturn(ctx(f.org), input);
    expect(first).toMatchObject({ kind: "requested", replayed: false });
    expect(second).toMatchObject({ kind: "requested", replayed: true });
    if (first.kind !== "requested" || second.kind !== "requested") return;
    expect(second.returnId).toBe(first.returnId);
    expect(await countRows("customer_returns", "order_id=$1", [order.orderId])).toBe(1);
    expect(await countRows("customer_return_events", "return_id=$1", [first.returnId])).toBe(1);

    const conflict = await requestCustomerReturn(ctx(f.org), {
      ...input,
      lines: [{ orderItemId: order.items[0]!, quantity: 2 }],
    });
    expect(conflict).toEqual({ kind: "request_conflict" });
    expect(await countRows("customer_returns", "order_id=$1", [order.orderId])).toBe(1);
  });

  it("never lets more come back than was ordered, across returns", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 3 }], { location });
    await requested(f.org, order, [{ item: 0, quantity: 2 }]);

    const over = await requestCustomerReturn(ctx(f.org), {
      requestKey: crypto.randomUUID(),
      orderId: order.orderId,
      lines: [{ orderItemId: order.items[0]!, quantity: 2 }],
    });
    expect(over).toEqual({ kind: "quantity_exceeds_remaining", remaining: 1 });
    expect(await countRows("customer_returns", "order_id=$1", [order.orderId])).toBe(1);

    await requested(f.org, order, [{ item: 0, quantity: 1 }]);
    const lookup = await findReturnableOrder(ctx(f.org), order.orderNumber);
    expect(lookup.kind === "order" && lookup.order.lines[0]!.returnableQuantity).toBe(0);
  });

  it("treats repeated receive / inspect / complete as replays that write nothing", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const returnId = await requested(f.org, order, [{ item: 0, quantity: 2 }]);

    expect(await receiveCustomerReturn(ctx(f.org), returnId)).toMatchObject({ replayed: false });
    expect(await receiveCustomerReturn(ctx(f.org), returnId)).toMatchObject({
      kind: "ok",
      replayed: true,
    });

    const detail = ok(await getCustomerReturnDetail(f.org, returnId));
    const lines = [{ returnItemId: detail.lines[0]!.returnItemId, damagedQuantity: 1 }];
    expect(await inspectCustomerReturn(ctx(f.org), { returnId, lines })).toMatchObject({
      replayed: false,
    });
    expect(await inspectCustomerReturn(ctx(f.org), { returnId, lines })).toMatchObject({
      kind: "ok",
      replayed: true,
    });

    // Two completions racing for the same return.
    const [one, two] = await Promise.all([
      completeCustomerReturn(ctx(f.org), { returnId, expected: lines }),
      completeCustomerReturn(ctx(f.org), { returnId, expected: lines }),
    ]);
    expect([one, two].map((r) => r.kind === "ok" && r.replayed).sort()).toEqual([false, true]);
    expect(await completeCustomerReturn(ctx(f.org), { returnId, expected: lines })).toMatchObject({
      kind: "ok",
      replayed: true,
    });

    expect(await returnMovements(s.variant)).toHaveLength(2);
    expect(await onHand(s.variant, location)).toBe(8 + 1);
    expect((await events(returnId)).map((e: any) => e.to_status)).toEqual([
      "requested",
      "received",
      "inspected",
      "completed",
    ]);
    expect(
      await countRows("audit_logs", "resource_id=$1 and action='inventory.customer_return'", [
        returnId,
      ]),
    ).toBe(1);

    // A completed return cannot be completed differently or re-inspected.
    const other = [{ returnItemId: lines[0]!.returnItemId, damagedQuantity: 0 }];
    expect(await completeCustomerReturn(ctx(f.org), { returnId, expected: other })).toEqual({
      kind: "already_completed",
    });
    expect(await inspectCustomerReturn(ctx(f.org), { returnId, lines: other })).toEqual({
      kind: "already_completed",
    });
  });

  it("refuses a completion for an inspection that changed since it was shown — nothing written", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 0 }]);
    const shown = [{ returnItemId: detail.lines[0]!.returnItemId, damagedQuantity: 2 }];

    const result = await completeCustomerReturn(ctx(f.org), {
      returnId: detail.returnId,
      expected: shown,
    });
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.detail.lines[0]!.damagedQuantity).toBe(0);
    expect(await returnMovements(s.variant)).toHaveLength(0);
    expect(ok(await getCustomerReturnDetail(f.org, detail.returnId)).status).toBe("inspected");
  });

  it("allows only one return and one damage movement per return line in the ledger itself", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 1 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 1, damaged: 1 }]);
    ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    for (const [type, delta] of [
      ["return", 1],
      ["damage", -1],
    ] as const) {
      await expect(
        f.db.query(
          `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
             movement_type,reference_type,reference_id)
           values($1,$2,$3,$4,$5,$6,'customer_return_item',$7)`,
          [f.org, s.product, s.variant, location, delta, type, detail.lines[0]!.returnItemId],
        ),
      ).rejects.toThrow();
    }
  });
});

// ── Lifecycle and delivery gating ────────────────────────────────────────────

describe("lifecycle and delivered-only gating", () => {
  it("only a delivered order of a real sale can be returned", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const inTransit = await seedOrder(f.org, [{ s, quantity: 1 }], {
      location,
      deliveryStatus: "in_transit",
    });
    const noDelivery = await seedOrder(f.org, [{ s, quantity: 1 }], {
      location,
      deliveryStatus: null,
    });
    const draft = await seedOrder(f.org, [{ s, quantity: 1 }], {
      location,
      confirm: false,
    });

    for (const order of [inTransit, noDelivery]) {
      expect(await findReturnableOrder(ctx(f.org), order.orderNumber)).toEqual({
        kind: "order_not_delivered",
      });
      expect(
        await requestCustomerReturn(ctx(f.org), {
          requestKey: crypto.randomUUID(),
          orderId: order.orderId,
          lines: [{ orderItemId: order.items[0]!, quantity: 1 }],
        }),
      ).toEqual({ kind: "order_not_delivered" });
    }
    expect(await findReturnableOrder(ctx(f.org), draft.orderNumber)).toEqual({
      kind: "order_not_returnable",
    });
    expect(
      await requestCustomerReturn(ctx(f.org), {
        requestKey: crypto.randomUUID(),
        orderId: draft.orderId,
        lines: [{ orderItemId: draft.items[0]!, quantity: 1 }],
      }),
    ).toEqual({ kind: "order_not_returnable" });
    expect(await findReturnableOrder(ctx(f.org), "NO-SUCH-ORDER")).toEqual({
      kind: "order_not_found",
    });
  });

  it("refuses steps out of order and malformed inspections", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const other = await seedOrder(f.org, [{ s, quantity: 1 }], { location });
    const order = await seedOrder(
      f.org,
      [
        { s, quantity: 2 },
        { s: await seedVariant(f.org), quantity: 1 },
      ],
      { location },
    );

    // A line of another order is not part of this return.
    expect(
      await requestCustomerReturn(ctx(f.org), {
        requestKey: crypto.randomUUID(),
        orderId: order.orderId,
        lines: [{ orderItemId: other.items[0]!, quantity: 1 }],
      }),
    ).toEqual({ kind: "item_not_in_order" });

    const returnId = await requested(f.org, order, [
      { item: 0, quantity: 2 },
      { item: 1, quantity: 1 },
    ]);
    const detail = ok(await getCustomerReturnDetail(f.org, returnId));
    const full = detail.lines.map((l) => ({ returnItemId: l.returnItemId, damagedQuantity: 0 }));

    expect(await inspectCustomerReturn(ctx(f.org), { returnId, lines: full })).toEqual({
      kind: "not_received",
    });
    expect(await completeCustomerReturn(ctx(f.org), { returnId, expected: full })).toEqual({
      kind: "not_inspected",
    });

    ok(await receiveCustomerReturn(ctx(f.org), returnId));
    expect(await completeCustomerReturn(ctx(f.org), { returnId, expected: full })).toEqual({
      kind: "not_inspected",
    });
    // Every line, exactly once, never more damaged than returned.
    expect(await inspectCustomerReturn(ctx(f.org), { returnId, lines: full.slice(0, 1) })).toEqual({
      kind: "invalid_lines",
    });
    expect(
      await inspectCustomerReturn(ctx(f.org), {
        returnId,
        // 3 damaged is more than either line holds.
        lines: [{ ...full[0]!, damagedQuantity: 3 }, full[1]!],
      }),
    ).toEqual({ kind: "invalid_lines" });
    expect(
      await inspectCustomerReturn(ctx(f.org), {
        returnId,
        lines: [full[0]!, { returnItemId: crypto.randomUUID(), damagedQuantity: 0 }],
      }),
    ).toEqual({ kind: "invalid_lines" });
    expect(ok(await getCustomerReturnDetail(f.org, returnId)).status).toBe("received");

    // Re-inspection before completion is allowed and recorded in history.
    ok(await inspectCustomerReturn(ctx(f.org), { returnId, lines: full }));
    // Lines share created_at, so pick the 2-unit line by quantity, not position.
    const twoUnit = detail.lines.find((l) => l.quantity === 2)!.returnItemId;
    const again = full.map((l) => (l.returnItemId === twoUnit ? { ...l, damagedQuantity: 2 } : l));
    const reinspected = ok(await inspectCustomerReturn(ctx(f.org), { returnId, lines: again }));
    expect(reinspected.totals).toEqual({ quantity: 3, resellable: 1, damaged: 2 });
    expect((await events(returnId)).filter((e: any) => e.to_status === "inspected")).toHaveLength(
      2,
    );
    expect(await returnMovements(s.variant)).toHaveLength(0);
  });

  it("an order with a customer return can no longer be cancelled (no double restock)", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    await requested(f.org, order, [{ item: 0, quantity: 1 }]);

    await expect(
      f.rpc("transition_order_status_v1", [
        f.org,
        order.orderId,
        "lifecycle",
        "confirmed",
        "cancelled",
        f.actor,
        null,
      ]),
    ).rejects.toThrow(/order_has_customer_return/);
    expect(await onHand(s.variant, location)).toBe(8);
    const lifecycle = (
      await f.db.query<{ lifecycle_status: string }>(
        `select lifecycle_status from orders where id=$1`,
        [order.orderId],
      )
    ).rows[0]!.lifecycle_status;
    expect(lifecycle).toBe("confirmed");
  });
});

// ── Permission denial ────────────────────────────────────────────────────────

describe("permission denial", () => {
  it("every returns call requires orders.return and orders.read, before anything is read or written", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 0 }]);
    const expected = currentInspection(detail)!;
    const returnsBefore = await countRows("customer_returns");
    const movesBefore = (await ledger(s.variant)).length;

    for (const perms of [
      ["orders.read"],
      ["orders.return"],
      ["inventory.adjust", "inventory.receive_stock"],
    ]) {
      const denied = ctx(f.org, perms);
      const missing = perms.includes("orders.return") ? "orders.read" : "orders.return";
      const calls: Array<() => Promise<unknown>> = [
        () => listCustomerReturns(denied),
        () => getCustomerReturn(denied, detail.returnId),
        () => findReturnableOrder(denied, order.orderNumber),
        () =>
          requestCustomerReturn(denied, {
            requestKey: crypto.randomUUID(),
            orderId: order.orderId,
            lines: [{ orderItemId: order.items[0]!, quantity: 1 }],
          }),
        () => receiveCustomerReturn(denied, detail.returnId),
        () => inspectCustomerReturn(denied, { returnId: detail.returnId, lines: expected }),
        () => completeCustomerReturn(denied, { returnId: detail.returnId, expected }),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toThrow(`Missing permission: ${missing}`);
      }
    }

    expect(await countRows("customer_returns")).toBe(returnsBefore);
    expect((await ledger(s.variant)).length).toBe(movesBefore);
    expect(ok(await getCustomerReturnDetail(f.org, detail.returnId)).status).toBe("inspected");
  });

  it("seeds orders.return to OWNER and MANAGER only, and the RPCs are not callable by JWT clients", async () => {
    const roles = (
      await f.db.query<{ system_role: string }>(
        `select r.system_role::text from role_permissions rp
         join roles r on r.id = rp.role_id
         join permissions p on p.id = rp.permission_id
         where p.key = 'orders.return' and r.organization_id is null
         order by 1`,
      )
    ).rows.map((r) => r.system_role);
    expect(roles).toEqual(["MANAGER", "OWNER"]);
    expect(UI_PERMISSION_KEYS).toContain("orders.return");

    for (const signature of [
      "request_customer_return_v1(uuid,uuid,uuid,uuid,jsonb)",
      "receive_customer_return_v1(uuid,uuid,uuid)",
      "inspect_customer_return_v1(uuid,uuid,uuid,jsonb)",
      "complete_customer_return_v1(uuid,uuid,uuid,jsonb)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const can = (
          await f.db.query<{ ok: boolean }>(
            `select has_function_privilege($1, $2, 'execute') as ok`,
            [role, `public.${signature}`],
          )
        ).rows[0]!.ok;
        expect(can).toBe(false);
      }
    }
    for (const table of ["customer_returns", "customer_return_items", "customer_return_events"]) {
      for (const privilege of ["insert", "update", "delete"]) {
        const can = (
          await f.db.query<{ ok: boolean }>(
            `select has_table_privilege('authenticated', $1, $2) as ok`,
            [`public.${table}`, privilege],
          )
        ).rows[0]!.ok;
        expect(can).toBe(false);
      }
    }
  });
});

// ── Cross-org denial ─────────────────────────────────────────────────────────

describe("cross-org denial", () => {
  it("another organization's order and return resolve exactly like ones that do not exist", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 0 }]);
    const expected = currentInspection(detail)!;
    const B = ctx(f.orgB);

    expect(await findReturnableOrder(B, order.orderNumber)).toEqual({ kind: "order_not_found" });
    expect(
      await requestCustomerReturn(B, {
        requestKey: crypto.randomUUID(),
        orderId: order.orderId,
        lines: [{ orderItemId: order.items[0]!, quantity: 1 }],
      }),
    ).toEqual({ kind: "order_not_found" });
    expect(await getCustomerReturn(B, detail.returnId)).toEqual({ kind: "return_not_found" });
    expect(await receiveCustomerReturn(B, detail.returnId)).toEqual({ kind: "return_not_found" });
    expect(await inspectCustomerReturn(B, { returnId: detail.returnId, lines: expected })).toEqual({
      kind: "return_not_found",
    });
    expect(await completeCustomerReturn(B, { returnId: detail.returnId, expected })).toEqual({
      kind: "return_not_found",
    });
    expect((await listCustomerReturns(B)).returns.map((r) => r.returnId)).not.toContain(
      detail.returnId,
    );

    // Nothing changed for organization A.
    expect(ok(await getCustomerReturnDetail(f.org, detail.returnId)).status).toBe("inspected");
    expect(await returnMovements(s.variant)).toHaveLength(0);
    expect(await countRows("customer_returns", "organization_id=$1", [f.orgB])).toBe(0);
  });

  it("organization B's own return never sees or touches organization A's stock", async () => {
    const sB = await seedVariant(f.orgB);
    await stockIn(f.orgB, sB, 5, locationB);
    const orderB = await seedOrder(f.orgB, [{ s: sB, quantity: 2 }], { location: locationB });
    const detail = await inspected(f.orgB, orderB, [{ item: 0, quantity: 2, damaged: 1 }]);
    ok(
      await completeCustomerReturn(ctx(f.orgB), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(await onHand(sB.variant, locationB)).toBe(3 + 1);
    expect((await listCustomerReturns(ctx(f.org))).returns.map((r) => r.returnId)).not.toContain(
      detail.returnId,
    );
  });
});

// ── Append-only history and ledger shape ─────────────────────────────────────

describe("append-only history and ledger shape (service role included)", () => {
  it("history cannot be edited or deleted, and status never moves backwards", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 1 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 1, damaged: 0 }]);
    ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );

    await expect(
      f.db.query(`update customer_return_events set to_status='requested' where return_id=$1`, [
        detail.returnId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      f.db.query(`delete from customer_return_events where return_id=$1`, [detail.returnId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      f.db.query(`delete from customer_returns where id=$1`, [detail.returnId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      f.db.query(`update customer_returns set status='inspected' where id=$1`, [detail.returnId]),
    ).rejects.toThrow(/cannot move/);
    await expect(
      f.db.query(`update customer_return_items set damaged_quantity=1 where return_id=$1`, [
        detail.returnId,
      ]),
    ).rejects.toThrow(/completed/);
  });

  it("a damage movement can only ever belong to a customer return line", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
         values($1,$2,$3,$4,-1,'damage')`,
        [f.org, s.product, s.variant, location],
      ),
    ).rejects.toThrow(/inventory_movements_damage_shape/);
    await expect(
      f.db.query(
        `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
           movement_type,reference_type,reference_id)
         values($1,$2,$3,$4,5,'restock','customer_return_item',$5)`,
        [f.org, s.product, s.variant, location, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/customer_return_movement_reserved/);
  });
});

// ── Pure rules and copy ──────────────────────────────────────────────────────

describe("pure rules", () => {
  it("derives totals, ledger effect and the next step with integers only", () => {
    expect(returnTotals([{ quantity: 3, damagedQuantity: 1 }])).toEqual({
      quantity: 3,
      resellable: 2,
      damaged: 1,
    });
    expect(
      returnTotals([
        { quantity: 3, damagedQuantity: 1 },
        { quantity: 1, damagedQuantity: null },
      ]),
    ).toEqual({ quantity: 4, resellable: null, damaged: null });
    expect(ledgerEffect(3, 0)).toEqual({ returnDelta: 3, damageDelta: 0, sellableChange: 3 });
    expect(ledgerEffect(3, 3)).toEqual({ returnDelta: 3, damageDelta: -3, sellableChange: 0 });
    expect(nextReturnAction("requested")).toBe("receive");
    expect(nextReturnAction("received")).toBe("inspect");
    expect(nextReturnAction("inspected")).toBe("complete");
    expect(nextReturnAction("completed")).toBeNull();
  });

  it("builds requests and inspections only from valid quantities", () => {
    const order = {
      orderId: "o",
      orderNumber: "N",
      lines: [
        {
          orderItemId: "a",
          productName: "A",
          variantName: null,
          sku: null,
          orderedQuantity: 3,
          alreadyReturned: 1,
          returnableQuantity: 2,
        },
      ],
    };
    expect(buildReturnRequest(order, { a: 2 })).toEqual([{ orderItemId: "a", quantity: 2 }]);
    expect(buildReturnRequest(order, { a: 3 })).toBeNull();
    expect(buildReturnRequest(order, {})).toBeNull();
    expect(parseReturnQuantity("2", 2)).toBe(2);
    expect(parseReturnQuantity("3", 2)).toBeNull();
    expect(parseReturnQuantity("1.5", 2)).toBeNull();
    expect(returnRequestFingerprint("o", [{ orderItemId: "a", quantity: 1 }])).not.toBe(
      returnRequestFingerprint("o", [{ orderItemId: "a", quantity: 2 }]),
    );

    const detail = {
      lines: [{ returnItemId: "x", quantity: 2, damagedQuantity: null }],
    } as unknown as ReturnDetail;
    expect(buildInspection(detail, { x: 1 })).toEqual([{ returnItemId: "x", damagedQuantity: 1 }]);
    expect(buildInspection(detail, { x: 3 })).toBeNull();
    expect(buildInspection(detail, {})).toBeNull();
    expect(currentInspection(detail)).toBeNull();
  });

  it("every message key the screens can show exists in English and Khmer", () => {
    const keys = new Set<string>();
    for (const kind of [
      "order_not_found",
      "order_not_returnable",
      "order_not_delivered",
    ] as const) {
      keys.add(returnableOrderMessageKey({ kind })!);
    }
    for (const kind of [
      "request_conflict",
      "invalid_items",
      "order_not_found",
      "order_not_returnable",
      "order_not_delivered",
      "item_not_in_order",
      "item_not_returnable",
    ] as const) {
      keys.add(requestReturnMessageKey({ kind })!);
    }
    keys.add(requestReturnMessageKey({ kind: "quantity_exceeds_remaining", remaining: 0 })!);
    for (const kind of [
      "return_not_found",
      "not_received",
      "not_inspected",
      "already_completed",
      "invalid_lines",
      "order_not_returnable",
    ] as const) {
      keys.add(returnStepMessageKey({ kind })!);
    }
    for (const status of ["requested", "received", "inspected", "completed"]) {
      keys.add(`returns.status.${status}`);
      keys.add(`returns.history.${status}`);
    }
    keys.add("movementHistory.type.damage");
    keys.add("returns.history.label");

    const lookup = (dict: any, key: string) =>
      key.split(".").reduce((node, part) => (node ? node[part] : undefined), dict);
    for (const key of keys) {
      expect(typeof lookup(en, key)).toBe("string");
      expect(typeof lookup(km, key)).toBe("string");
    }
  });

  it("English and Khmer carry exactly the same returns keys", () => {
    const flatten = (node: any, prefix = ""): string[] =>
      Object.entries(node).flatMap(([k, v]) =>
        v && typeof v === "object" ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(flatten((km as any).returns).sort()).toEqual(flatten((en as any).returns).sort());
  });
});

// ── P1: the generic inventory path cannot bypass the Returns workflow ────────

describe("generic inventory writes can never create a customer-return movement", () => {
  const ADJUSTER = [
    "inventory.adjust",
    "inventory.receive_stock",
    "inventory.read",
    "inventory.view_movements",
  ];

  /** Every way the generic API could try to file stock under a return line. */
  async function expectGenericRefused(detail: ReturnDetail, s: Seeded) {
    const line = detail.lines[0]!;
    for (const referenceType of [
      "customer_return_item",
      "Customer_Return_Item",
      " customer_return_item ",
    ]) {
      for (const movementType of ["return", "restock", "manual_adjustment"] as const) {
        await expect(
          recordMovement(ctx(f.org, ADJUSTER), {
            productId: s.product,
            variantId: s.variant,
            locationId: location,
            quantityDelta: line.quantity,
            movementType,
            referenceType,
            referenceId: line.returnItemId,
            reason: "bypass attempt",
          }),
        ).rejects.toThrow(/reserved for customer returns/);
      }
    }
  }

  async function insertAs(
    org: string,
    s: Seeded,
    delta: number,
    type: "return" | "damage",
    returnItemId: string,
    at: string | null = location,
  ) {
    return f.db.query(
      `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
         movement_type,reference_type,reference_id)
       values($1,$2,$3,$4,$5,$6,'customer_return_item',$7)`,
      [org, s.product, s.variant, at, delta, type, returnItemId],
    );
  }

  /** Inside a transaction marked as completing `returnId` — the completion context. */
  async function insideCompletionMark(returnId: string, write: (tx: any) => Promise<unknown>) {
    await f.db.transaction(async (tx: any) => {
      await tx.query(`select set_config('apsa.customer_return_completion', $1, true)`, [returnId]);
      await write(tx);
    });
  }

  it("a requested return cannot alter stock through the generic API — nothing is written", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const returnId = await requested(f.org, order, [{ item: 0, quantity: 2 }]);
    const detail = ok(await getCustomerReturnDetail(f.org, returnId));
    const stockBefore = await onHand(s.variant, location);
    const ledgerBefore = (await ledger(s.variant)).length;
    const auditBefore = await countRows("audit_logs");

    await expectGenericRefused(detail, s);
    // Even below the API, with the line's exact figures.
    await expect(insertAs(f.org, s, 2, "return", detail.lines[0]!.returnItemId)).rejects.toThrow(
      /written only by complete_customer_return_v1/,
    );

    expect(await onHand(s.variant, location)).toBe(stockBefore);
    expect((await ledger(s.variant)).length).toBe(ledgerBefore);
    expect(await countRows("audit_logs")).toBe(auditBefore);
    expect(ok(await getCustomerReturnDetail(f.org, returnId)).status).toBe("requested");
  });

  it("an inspected return cannot alter stock — not by the API, not by a direct ledger insert", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 1 }]);
    const itemId = detail.lines[0]!.returnItemId;
    const stockBefore = await onHand(s.variant, location);
    const ledgerBefore = (await ledger(s.variant)).length;
    const auditBefore = await countRows("audit_logs");

    await expectGenericRefused(detail, s);
    await expect(insertAs(f.org, s, 2, "return", itemId)).rejects.toThrow(
      /written only by complete_customer_return_v1/,
    );
    await expect(insertAs(f.org, s, -1, "damage", itemId)).rejects.toThrow(
      /written only by complete_customer_return_v1/,
    );

    expect(await onHand(s.variant, location)).toBe(stockBefore);
    expect((await ledger(s.variant)).length).toBe(ledgerBefore);
    expect(await countRows("audit_logs")).toBe(auditBefore);
    expect(ok(await getCustomerReturnDetail(f.org, detail.returnId)).status).toBe("inspected");
  });

  it("inside the completion context SQL still verifies ownership, variant, quantity and location", async () => {
    const s = await seedVariant(f.org);
    const other = await seedVariant(f.org);
    const sB = await seedVariant(f.orgB);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 1 }]);
    const anotherReturn = await inspected(
      f.org,
      await seedOrder(f.org, [{ s, quantity: 1 }], { location }),
      [{ item: 0, quantity: 1, damaged: 0 }],
    );
    const itemId = detail.lines[0]!.returnItemId;
    const ledgerBefore = (await ledger(s.variant)).length;

    const attempts: Array<[string, RegExp, (tx: any) => Promise<unknown>]> = [
      [
        "another organization's movement",
        /written only by complete_customer_return_v1/,
        (tx) =>
          tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,$4,2,'return','customer_return_item',$5)`,
            [f.orgB, sB.product, sB.variant, locationB, itemId],
          ),
      ],
      [
        "a mark for a different return",
        /written only by complete_customer_return_v1/,
        async (tx) => {
          await tx.query(`select set_config('apsa.customer_return_completion', $1, true)`, [
            anotherReturn.returnId,
          ]);
          return tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,$4,2,'return','customer_return_item',$5)`,
            [f.org, s.product, s.variant, location, itemId],
          );
        },
      ],
      [
        "the wrong variant",
        /variant does not match/,
        (tx) =>
          tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,$4,2,'return','customer_return_item',$5)`,
            [f.org, other.product, other.variant, location, itemId],
          ),
      ],
      [
        "the wrong return quantity",
        /quantity does not match/,
        (tx) =>
          tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,$4,5,'return','customer_return_item',$5)`,
            [f.org, s.product, s.variant, location, itemId],
          ),
      ],
      [
        "the wrong damage quantity",
        /quantity does not match/,
        (tx) =>
          tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,$4,-2,'damage','customer_return_item',$5)`,
            [f.org, s.product, s.variant, location, itemId],
          ),
      ],
      [
        "the wrong location",
        /location does not match/,
        (tx) =>
          tx.query(
            `insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,
               movement_type,reference_type,reference_id) values($1,$2,$3,NULL,2,'return','customer_return_item',$4)`,
            [f.org, s.product, s.variant, itemId],
          ),
      ],
    ];
    for (const [, error, write] of attempts) {
      await expect(insideCompletionMark(detail.returnId, write)).rejects.toThrow(error);
    }

    expect((await ledger(s.variant)).length).toBe(ledgerBefore);
    expect(await returnMovements(s.variant)).toHaveLength(0);
  });

  it("legitimate completion still succeeds, and its movements cannot be altered afterwards", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 1 }]);
    await expectGenericRefused(detail, s);

    const done = ok(
      await completeCustomerReturn(ctx(f.org), {
        returnId: detail.returnId,
        expected: currentInspection(detail)!,
      }),
    );
    expect(done.status).toBe("completed");
    expect(await onHand(s.variant, location)).toBe(8 + 1);
    const moves = await returnMovements(s.variant);
    expect(moves.map((m: any) => [m.movement_type, m.quantity_delta])).toEqual([
      ["return", 2],
      ["damage", -1],
    ]);

    // The completion mark does not outlive its transaction.
    const mark = (
      await f.db.query<{ v: string | null }>(
        `select current_setting('apsa.customer_return_completion', true) as v`,
      )
    ).rows[0]!.v;
    expect(mark ?? "").toBe("");
    await expect(
      f.db.query(`update inventory_movements set quantity_delta = 5 where id = $1`, [moves[0].id]),
    ).rejects.toThrow(/customer_return_movement_reserved/);
    await expect(insertAs(f.org, s, 2, "return", done.lines[0]!.returnItemId)).rejects.toThrow(
      /written only by complete_customer_return_v1/,
    );
    expect(await onHand(s.variant, location)).toBe(9);
  });
});

// ── P2: complete reads under PostgREST's row cap ─────────────────────────────

describe("complete reads under PostgREST's 1000-row cap", () => {
  it("history is complete beyond 1000 events, read in capped pages", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 10, location);
    const order = await seedOrder(f.org, [{ s, quantity: 2 }], { location });
    const detail = await inspected(f.org, order, [{ item: 0, quantity: 2, damaged: 0 }]);
    await f.db.query(
      `insert into customer_return_events(organization_id,return_id,from_status,to_status,actor)
       select $1,$2,'inspected','inspected',$3 from generate_series(1,1500)`,
      [f.org, detail.returnId, f.actor],
    );
    const total = await countRows("customer_return_events", "return_id=$1", [detail.returnId]);
    expect(total).toBeGreaterThan(1500);

    // The cap is real: one un-paged request sees only the first 1000.
    const capped = await (sqlDb() as any)
      .from("customer_return_events")
      .select("id")
      .eq("return_id", detail.returnId);
    expect(capped.data).toHaveLength(POSTGREST_MAX_ROWS);

    served.length = 0;
    const full = ok(await getCustomerReturnDetail(f.org, detail.returnId));
    expect(full.history).toHaveLength(total);
    const pages = served.filter((r) => r.table === "customer_return_events").map((r) => r.rows);
    expect(pages[0]).toBe(PAGE_SIZE);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.every((rows) => rows <= POSTGREST_MAX_ROWS)).toBe(true);
  });

  it("unit totals and remaining quantities are exact when a read spans more than 1000 rows", async () => {
    const s = await seedVariant(f.org);
    await stockIn(f.org, s, 2000, location);
    const orderId = crypto.randomUUID();
    const orderNumber = `BIG-${orderId.slice(0, 8)}`;
    await f.db.query(
      `insert into orders(id,organization_id,order_number,source,currency,subtotal_minor,total_minor,created_by,location_id)
       values($1,$2,$3,'MANUAL','USD',1100000,1100000,$4,$5)`,
      [orderId, f.org, orderNumber, f.actor, location],
    );
    await f.db.query(
      `insert into order_items(organization_id,order_id,product_id,variant_id,product_name_snapshot,
         unit_price_minor,quantity,line_total_minor)
       select $1,$2,$3,$4,'ស្រោមជើង',1000,1,1000 from generate_series(1,1100)`,
      [f.org, orderId, s.product, s.variant],
    );
    const confirmed = await f.rpc("transition_order_status_v1", [
      f.org,
      orderId,
      "lifecycle",
      "draft",
      "confirmed",
      f.actor,
      null,
    ]);
    expect(confirmed.status).toBe("success");
    await f.db.query(
      `insert into deliveries(organization_id,order_id,location_id,provider_name,status,created_by)
       values($1,$2,$3,'Manual courier','delivered',$4)`,
      [f.org, orderId, location, f.actor],
    );
    const items = (
      await f.db.query<{ id: string }>(`select id from order_items where order_id=$1 order by id`, [
        orderId,
      ])
    ).rows.map((r) => r.id);

    const returnIds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const result = await requestCustomerReturn(ctx(f.org), {
        requestKey: crypto.randomUUID(),
        orderId,
        lines: items.slice(i * 100, i * 100 + 100).map((id) => ({ orderItemId: id, quantity: 1 })),
      });
      if (result.kind !== "requested") throw new Error(JSON.stringify(result));
      returnIds.push(result.returnId);
    }

    served.length = 0;
    const list = await listCustomerReturns(ctx(f.org));
    const ours = list.returns.filter((r) => returnIds.includes(r.returnId));
    expect(ours).toHaveLength(11);
    expect(ours.every((r) => r.quantity === 100)).toBe(true);
    expect(ours.reduce((sum, r) => sum + r.quantity, 0)).toBe(1100);
    // The item read hit the cap and was paged rather than truncated.
    expect(
      served.some((r) => r.table === "customer_return_items" && r.rows === POSTGREST_MAX_ROWS),
    ).toBe(true);

    const lookup = await findReturnableOrder(ctx(f.org), orderNumber);
    expect(lookup.kind).toBe("order");
    if (lookup.kind !== "order") return;
    expect(lookup.order.lines).toHaveLength(1100);
    expect(lookup.order.lines.every((l) => l.alreadyReturned === 1)).toBe(true);
    expect(lookup.order.lines.every((l) => l.returnableQuantity === 0)).toBe(true);
  }, 120000);

  it("reports a partial list instead of passing the first page off as every return", async () => {
    const s = await seedVariant(f.org);
    const existing = await countRows("customer_returns", "organization_id=$1", [f.org]);
    const needed = Math.max(101 - existing, 1);
    await stockIn(f.org, s, needed + 10, location);
    const order = await seedOrder(
      f.org,
      Array.from({ length: needed }, () => ({ s, quantity: 1 })),
      { location },
    );
    for (let i = 0; i < needed; i += 1) {
      await requested(f.org, order, [{ item: i, quantity: 1 }]);
    }
    expect(await countRows("customer_returns", "organization_id=$1", [f.org])).toBeGreaterThan(100);

    const list = await listCustomerReturns(ctx(f.org));
    expect(list.returns).toHaveLength(100);
    expect(list.truncated).toBe(true);

    const listB = await listCustomerReturns(ctx(f.orgB));
    expect(listB.truncated).toBe(false);
  }, 120000);

  it("a read that would exceed the page budget fails loudly instead of truncating", async () => {
    let ranges = 0;
    const fullPages: any = {
      select: () => fullPages,
      eq: () => fullPages,
      order: () => fullPages,
      range: async () => {
        ranges += 1;
        return {
          data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: String(i) })),
          error: null,
        };
      },
    };
    const restoreFake = setReturnsRepositoryDbForTests({ from: () => fullPages });
    try {
      await expect(listReturnEvents(f.org, crypto.randomUUID())).rejects.toThrow(
        /refusing a partial read/,
      );
      expect(ranges).toBe(MAX_PAGES);
    } finally {
      restoreFake();
    }
  });
});
