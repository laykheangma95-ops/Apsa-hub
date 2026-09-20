/**
 * Inventory Operations UI — behavioural and structural tests.
 *
 * Covers the surface this phase added, in the order the risk runs:
 *
 *   A. The org-wide stock read: zero for a variant with no movements, negative
 *      quantities kept exactly, truncation declared rather than silent.
 *   B. Tenant isolation: another organization's variant, location or stock row
 *      is unreachable through every new read.
 *   C. Permission enforcement, server-side: each of the four inventory keys
 *      independently gates what it names.
 *   D. Capability gating, browser-side: the same four keys decide what the UI
 *      OFFERS, with no role name anywhere in the decision.
 *   E. Mutations: both sheets go through recordMovement; a manual adjustment
 *      needs a reason; a failed mandatory audit blocks the stock change;
 *      idempotent duplicates still come back as duplicates.
 *   F. Cache isolation: keys partitioned per user AND organization, and
 *      movement history evicted the moment view_movements stops holding.
 *   G. The Product × Inventory join stays honest about what it knows.
 *   H. Khmer/English parity for every new string.
 *   I. No production mock/fallback path.
 *   J. Browser/server bundle boundary for the new modules.
 *
 * Run: bun test src/tests/inventory-operations-ui.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { QueryClient } from "@tanstack/react-query";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";
import {
  UI_PERMISSION_KEYS,
  createCapabilityView,
  createFixtureCapabilityView,
} from "@/lib/capabilities";
import {
  buildInventoryRows,
  canSubmitAdjustment,
  canSubmitReceipt,
  classifyInventoryError,
  clearInventoryMovementQueries,
  enforceInventoryCachePrincipal,
  enforceMovementHistoryCapability,
  formatMovementDelta,
  formatQuantity,
  inventoryKeys,
  locationName,
  movementTypeLabelKey,
  parseQuantity,
  searchLoadedInventory,
  stockState,
  type OrgStockList,
} from "@/lib/inventory";
import type { CatalogProduct } from "@/lib/catalog";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

/**
 * Source with comments removed.
 *
 * Used wherever the assertion is "this code does not do X": a doc comment
 * SAYING there is no setStock, or that this module never talks to Supabase, is
 * documentation of the invariant — matching it would fail the very files that
 * explain why the rule exists. Only real code counts.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The four inventory keys this phase put in front of the merchant. */
const INVENTORY_KEYS = [
  "inventory.read",
  "inventory.view_movements",
  "inventory.receive_stock",
  "inventory.adjust",
] as const;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "11111111-0000-0000-0000-000000000001";
/** A second member of Org A — same organization, different account. */
const USER_B = "22222222-0000-0000-0000-000000000002";
const PRODUCT_A = "cccccccc-0000-0000-0000-0000000000a1";
const VARIANT_MOVED = "dddddddd-0000-0000-0000-0000000000a2";
const VARIANT_NEVER_MOVED = "dddddddd-0000-0000-0000-0000000000a3";
const VARIANT_OVERSOLD = "dddddddd-0000-0000-0000-0000000000a4";
/** Real rows that belong to Org B. Org A must never reach them. */
const VARIANT_B = "eeeeeeee-0000-0000-0000-0000000000b1";
const LOCATION_A = "ffffffff-0000-0000-0000-0000000000a5";
const LOCATION_B = "ffffffff-0000-0000-0000-0000000000b2";

function ctxWith(permissions: readonly string[], organizationId = ORG_A): AuthCtxType {
  const granted = new Set<string>(permissions);
  return {
    userId: USER_A,
    organizationId,
    roleId: "role-test",
    // Deliberately a role that would fail a role-name check, to prove nothing
    // in the server or the UI is deciding on the role.
    systemRole: "CASHIER",
    permissions: granted,
    can: (key: string) => granted.has(key),
    require: (key: string) => {
      if (!granted.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthCtxType;
}

async function expectForbidden(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow(/Missing permission/);
}

// ── An organization-scoped fake database ─────────────────────────────────────
//
// Rows carry an organization_id; every `.eq()` and `.in()` the repository issues
// is applied as a real filter, so a query scoped to Org A simply cannot see an
// Org B row — the same outcome the live WHERE organization_id = $1 produces.
// Writes are recorded so a refused mutation can be shown to have written nothing.

type FakeRow = Record<string, unknown>;

interface FakeDb {
  from: (table: string) => unknown;
  writes: string[];
  /** One entry per SELECT that actually hit a table, e.g. "select:inventory_stock". */
  reads: string[];
}

/**
 * Options that make the fake behave like a real hosted PostgREST.
 *
 * `maxRows` models the project's `db.max_rows`: the server silently truncates
 * EVERY response to at most this many rows, whatever the request asked for,
 * with no error and no flag. This is the condition the org-wide stock read has
 * to stay correct under, so the harness has to be able to produce it.
 */
interface FakeDbOptions {
  maxRows?: number;
}

function makeOrgScopedDb(tables: Record<string, FakeRow[]>, options: FakeDbOptions = {}): FakeDb {
  const writes: string[] = [];
  const reads: string[] = [];

  function from(table: string) {
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, readonly unknown[]]> = [];
    const orderKeys: Array<[string, boolean]> = [];
    let pendingInsert: FakeRow | null = null;
    let limit: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;

    const matched = (): FakeRow[] => {
      let rows = (tables[table] ?? []).filter((row) =>
        eqFilters.every(([col, val]) => row[col] === val),
      );
      for (const [col, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row[col]));
      }

      // ORDER BY, so offset paging is over a deterministic total order.
      // NULLs sort last ascending, matching Postgres' default.
      if (orderKeys.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const [col, ascending] of orderKeys) {
            const av = a[col];
            const bv = b[col];
            if (av === bv) continue;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return ascending ? cmp : -cmp;
          }
          return 0;
        });
      }

      // OFFSET/LIMIT — .range() wins when both were set, as in postgrest-js.
      if (rangeFrom !== null && rangeTo !== null) {
        rows = rows.slice(rangeFrom, rangeTo + 1);
      } else if (limit !== null) {
        rows = rows.slice(0, limit);
      }

      // The server's own ceiling, applied LAST and silently — exactly like
      // db.max_rows. The caller is never told this happened.
      if (options.maxRows !== undefined && rows.length > options.maxRows) {
        rows = rows.slice(0, options.maxRows);
      }
      return rows;
    };

    const settle = () => {
      if (pendingInsert) {
        const inserted = { id: "generated-id", ...pendingInsert };
        (tables[table] ??= []).push(inserted);
        writes.push(`insert:${table}`);
        return { data: inserted, error: null };
      }
      reads.push(`select:${table}`);
      return { data: matched(), error: null };
    };

    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderKeys.push([column, opts?.ascending !== false]);
        return query;
      },
      limit: (value: number) => {
        limit = value;
        return query;
      },
      range: (fromRow: number, toRow: number) => {
        rangeFrom = fromRow;
        rangeTo = toRow;
        return query;
      },
      in: (col: string, values: readonly unknown[]) => {
        inFilters.push([col, values]);
        return query;
      },
      eq: (col: string, val: unknown) => {
        eqFilters.push([col, val]);
        return query;
      },
      insert: (row: FakeRow) => {
        pendingInsert = row;
        return query;
      },
      single: async () => {
        const result = settle();
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        if (!data) {
          return { data: null, error: { code: "PGRST116", message: "The result contains 0 rows" } };
        }
        return { data, error: null };
      },
      maybeSingle: async () => {
        const result = settle();
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        const result = settle();
        return Promise.resolve({
          data: Array.isArray(result.data) ? result.data : [],
          error: null,
        }).then(resolve);
      },
    });

    return query;
  }

  return { from, writes, reads };
}

async function withDb<T>(db: FakeDb, fn: () => Promise<T>): Promise<T> {
  const { setInventoryRepositoryDbForTests } = await import("../server/inventory/repository");
  const restore = setInventoryRepositoryDbForTests(db);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Org A holds three active variants:
 *   VARIANT_MOVED        — +10 then -3 at one location, so 7 on hand
 *   VARIANT_NEVER_MOVED  — no ledger rows at all
 *   VARIANT_OVERSOLD     — net -3: sold more than the ledger says arrived
 * Org B holds one active variant and one location, which Org A must never see.
 */
function twoOrgFixture(): FakeDb {
  return makeOrgScopedDb({
    product_variants: [
      {
        id: VARIANT_MOVED,
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: VARIANT_NEVER_MOVED,
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        status: "ACTIVE",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: VARIANT_OVERSOLD,
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        status: "ACTIVE",
        created_at: "2026-01-03T00:00:00Z",
      },
      {
        id: VARIANT_B,
        organization_id: ORG_B,
        product_id: "b-product",
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    inventory_stock: [
      {
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        variant_id: VARIANT_MOVED,
        location_id: LOCATION_A,
        quantity_on_hand: 7,
        last_movement_at: "2026-02-01T00:00:00Z",
      },
      {
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        variant_id: VARIANT_OVERSOLD,
        location_id: LOCATION_A,
        quantity_on_hand: -3,
        last_movement_at: "2026-02-02T00:00:00Z",
      },
      {
        organization_id: ORG_B,
        product_id: "b-product",
        variant_id: VARIANT_B,
        location_id: LOCATION_B,
        quantity_on_hand: 999,
        last_movement_at: "2026-02-03T00:00:00Z",
      },
    ],
    locations: [
      { id: LOCATION_A, organization_id: ORG_A, name: "Phnom Penh shop", status: "active" },
      { id: LOCATION_B, organization_id: ORG_B, name: "Org B warehouse", status: "active" },
    ],
    audit_logs: [],
  });
}

// ── A. The org-wide stock read ───────────────────────────────────────────────

describe("A. the org-wide stock read answers with the ledger, honestly", () => {
  it("returns one entry per ACTIVE variant in the organization", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries.map((entry) => entry.variantId).sort()).toEqual(
      [VARIANT_MOVED, VARIANT_NEVER_MOVED, VARIANT_OVERSOLD].sort(),
    );
    expect(result.truncated).toBe(false);
  });

  it("an active variant with NO movement history is 0, not missing and not unknown", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));
    const entry = result.entries.find((row) => row.variantId === VARIANT_NEVER_MOVED);

    expect(entry).toBeDefined();
    expect(entry!.quantityOnHand).toBe(0);
    expect(entry!.lastMovementAt).toBeNull();
  });

  it("a negative balance is returned exactly, never clamped to zero", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));
    const oversold = result.entries.find((row) => row.variantId === VARIANT_OVERSOLD);

    expect(oversold!.quantityOnHand).toBe(-3);
    expect(oversold!.quantityOnHand).toBeLessThan(0);
  });

  it("sums a variant's per-location rows into one on-hand total", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = makeOrgScopedDb({
      product_variants: [
        {
          id: VARIANT_MOVED,
          organization_id: ORG_A,
          product_id: PRODUCT_A,
          status: "ACTIVE",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      inventory_stock: [
        {
          organization_id: ORG_A,
          product_id: PRODUCT_A,
          variant_id: VARIANT_MOVED,
          location_id: LOCATION_A,
          quantity_on_hand: 12,
          last_movement_at: "2026-02-01T00:00:00Z",
        },
        {
          organization_id: ORG_A,
          product_id: PRODUCT_A,
          variant_id: VARIANT_MOVED,
          location_id: null,
          quantity_on_hand: -5,
          last_movement_at: "2026-03-09T00:00:00Z",
        },
      ],
    });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries[0]!.quantityOnHand).toBe(7);
    // The newest movement across every location, not the first row seen.
    expect(result.entries[0]!.lastMovementAt).toBe("2026-03-09T00:00:00Z");
  });

  it("declares truncation instead of silently dropping variants", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const result = await withDb(db, () =>
      listOrganizationStock(ctxWith(["inventory.read"]), { limit: 2 }),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("clamps an absurd limit rather than passing it through", async () => {
    const { listOrganizationStock, INVENTORY_STOCK_MAX_LIMIT } =
      await import("../server/inventory/service");
    const db = twoOrgFixture();

    // The point is that it answers at all and stays within the declared
    // ceiling — a caller cannot ask the server to scan without bound.
    const result = await withDb(db, () =>
      listOrganizationStock(ctxWith(["inventory.read"]), { limit: 9_999_999 }),
    );

    expect(result.entries.length).toBeLessThanOrEqual(INVENTORY_STOCK_MAX_LIMIT);
    expect(result.entries.length).toBe(3);
  });

  it("an organization with no active variants gets an empty, untruncated list", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = makeOrgScopedDb({ product_variants: [], inventory_stock: [] });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("reads the whole organization in two queries, never one per variant", async () => {
    // Structural: an N+1 shape would be a loop calling getVariantStockRows.
    const source = read("src/server/inventory/service.ts");
    const start = source.indexOf("export async function listOrganizationStock");
    const body = source.slice(start, source.indexOf("\n}", start));

    expect(body).toContain("repo.listActiveVariantsForOrg");
    expect(body).toContain("repo.listStockRowsForVariants");
    expect(body).not.toContain("getVariantStockRows");
  });
});

// ── A2. A capped server response never becomes a confident wrong total ───────
//
// Regression cover for the P1 found in independent review of 253cf05.
//
// PostgREST silently truncates every response to the project's `db.max_rows`.
// The previous implementation asked for 5000 rows and called the result
// truncated only when it got >= 5000 back, so a project capped at 1000 could
// never trip it: 1100 real rows arrived as 1000 and were reported COMPLETE.
// The merchant then saw understated stock, and a variant whose rows fell off
// the end of the cap showed a confident 0.
//
// Every test below runs against a fake whose `maxRows` is SMALLER than the
// page size the repository asks for, which is precisely the condition the old
// heuristic could not see.

/** `variantCount` active variants, each held at `locationsPer` locations. */
function stockAtScale(
  variantCount: number,
  locationsPer: number,
  quantityFor: (variantIndex: number, locationIndex: number) => number = () => 1,
): Record<string, FakeRow[]> {
  const product_variants: FakeRow[] = [];
  const inventory_stock: FakeRow[] = [];

  for (let v = 0; v < variantCount; v += 1) {
    const variantId = `v-${String(v).padStart(5, "0")}`;
    product_variants.push({
      id: variantId,
      organization_id: ORG_A,
      product_id: PRODUCT_A,
      status: "ACTIVE",
      created_at: `2026-01-01T00:00:00Z`,
    });
    for (let l = 0; l < locationsPer; l += 1) {
      inventory_stock.push({
        organization_id: ORG_A,
        product_id: PRODUCT_A,
        variant_id: variantId,
        location_id: `loc-${String(l).padStart(5, "0")}`,
        quantity_on_hand: quantityFor(v, l),
        last_movement_at: "2026-02-01T00:00:00Z",
      });
    }
  }
  return { product_variants, inventory_stock, locations: [], audit_logs: [] };
}

describe("A2. a server row cap below the requested page size never understates stock", () => {
  it("the reported case: 1100 rows behind a 1000-row cap reads complete and correct", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 100 variants x 11 locations = 1100 stock rows, one variant chunk.
    const db = makeOrgScopedDb(stockAtScale(100, 11), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    // Option A of the requirement: fetch all 1100 and return correct totals.
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(100);
    // Every variant holds 11 units. Not one of them may be short.
    const wrong = result.entries.filter((entry) => entry.quantityOnHand !== 11);
    expect(wrong).toEqual([]);
    // And the grand total proves all 1100 rows were consumed, not 1000.
    const total = result.entries.reduce((sum, entry) => sum + entry.quantityOnHand, 0);
    expect(total).toBe(1100);
  });

  it("a variant whose rows straddle the cap boundary is not understated", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = makeOrgScopedDb(stockAtScale(100, 11), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    // Ordered by (variant_id, location_id), row 1000 lands inside v-00090:
    // its rows occupy 990..1000, so the first capped page cuts it in half.
    const straddling = result.entries.find((entry) => entry.variantId === "v-00090");
    expect(straddling).toBeDefined();
    expect(straddling!.quantityOnHand).toBe(11);
  });

  it("a variant whose rows fall ENTIRELY past the cap is never a false zero", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = makeOrgScopedDb(stockAtScale(100, 11), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    // v-00092 onwards begin after row 1000 — under the old heuristic every one
    // of these came back as a confident 0.
    for (const variantId of ["v-00092", "v-00095", "v-00099"]) {
      const entry = result.entries.find((row) => row.variantId === variantId);
      expect(entry).toBeDefined();
      expect(entry!.quantityOnHand).toBe(11);
      expect(entry!.quantityOnHand).not.toBe(0);
    }
    expect(result.entries.filter((entry) => entry.quantityOnHand === 0)).toEqual([]);
  });

  it("walks as many pages as the cap forces, and proves the end with an empty page", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // A deliberately mean cap: 300 rows per response for 1100 rows of data.
    const db = makeOrgScopedDb(stockAtScale(100, 11), { maxRows: 300 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(false);
    expect(result.entries.reduce((sum, entry) => sum + entry.quantityOnHand, 0)).toBe(1100);

    // 1100 rows at 300 per response = 4 data pages, then one empty page that
    // proves exhaustion. The empty page is the terminal condition and is not
    // optional: a short page proves nothing under an unknown cap.
    const stockReads = db.reads.filter((entry) => entry === "select:inventory_stock");
    expect(stockReads).toHaveLength(5);
  });

  it("a cap exactly equal to the requested page size still terminates on an empty page", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // Exactly 1000 rows, cap 1000, page size 1000 — the boundary where a
    // "short page means the end" rule would be indistinguishable from a cap.
    const db = makeOrgScopedDb(stockAtScale(100, 10), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(false);
    expect(result.entries.reduce((sum, entry) => sum + entry.quantityOnHand, 0)).toBe(1000);
    // One full page, then the empty page that proves there is no more.
    expect(db.reads.filter((entry) => entry === "select:inventory_stock")).toHaveLength(2);
  });

  it("exact negative quantities survive paging, and are never clamped", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // Every third location is oversold; one variant nets negative overall.
    const db = makeOrgScopedDb(
      stockAtScale(100, 11, (variantIndex, locationIndex) =>
        variantIndex === 97 ? -3 : locationIndex % 3 === 0 ? -1 : 2,
      ),
      { maxRows: 1000 },
    );

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(false);
    // v-00097 sits past the cap boundary AND is negative: -3 x 11 locations.
    const oversold = result.entries.find((entry) => entry.variantId === "v-00097");
    expect(oversold!.quantityOnHand).toBe(-33);
    // Ordinary variants: 4 locations at -1, 7 at +2 = 10.
    const ordinary = result.entries.find((entry) => entry.variantId === "v-00050");
    expect(ordinary!.quantityOnHand).toBe(10);
    expect(result.entries.some((entry) => entry.quantityOnHand < 0)).toBe(true);
  });

  it("tenant isolation holds across every page — Org B rows are never drained in", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const tables = stockAtScale(100, 11);
    // Org B holds a large amount of its own stock, interleaved by id so a
    // filter that leaked would surface it on the very first page.
    tables.product_variants!.push({
      id: "v-00000-orgb",
      organization_id: ORG_B,
      product_id: "b-product",
      status: "ACTIVE",
      created_at: "2026-01-01T00:00:00Z",
    });
    for (let l = 0; l < 50; l += 1) {
      tables.inventory_stock!.push({
        organization_id: ORG_B,
        product_id: "b-product",
        variant_id: "v-00000-orgb",
        location_id: `loc-${String(l).padStart(5, "0")}`,
        quantity_on_hand: 999,
        last_movement_at: "2026-02-01T00:00:00Z",
      });
    }
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries.some((entry) => entry.variantId === "v-00000-orgb")).toBe(false);
    // Org A's total is exactly its own 1100 rows — no Org B quantity bled in.
    expect(result.entries.reduce((sum, entry) => sum + entry.quantityOnHand, 0)).toBe(1100);
    expect(result.entries).toHaveLength(100);
  });

  it("stays chunked: reads scale with pages, never one query per variant", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 300 variants at one location each = 300 rows across 3 variant chunks.
    const db = makeOrgScopedDb(stockAtScale(300, 1), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries).toHaveLength(300);
    const stockReads = db.reads.filter((entry) => entry === "select:inventory_stock");
    // 3 chunks x (1 data page + 1 empty terminal page) = 6. An N+1 shape would
    // be 300. The count tracks chunks and pages, never variant count.
    expect(stockReads).toHaveLength(6);
    expect(stockReads.length).toBeLessThan(300);
  });

  it("when the safety budget stops the walk it says INCOMPLETE, never a total", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 100 variants x 201 locations = 20_100 rows, past the 20_000 per-chunk
    // budget. The budget is a runaway guard, not a completeness signal — so
    // tripping it must surface as truncated rather than as a confident sum.
    const db = makeOrgScopedDb(stockAtScale(100, 201), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(true);
    // "Never a total" has to mean the entries too, not just the flag. The
    // budget cut this single chunk mid-walk, so not one of its 100 variants
    // can be proven complete and not one may carry a number.
    expect(result.entries).toEqual([]);
  });

  it("the single-variant read fails closed rather than reporting a partial total", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    // One variant across 5_100 locations, past the 5_000 per-variant budget.
    const tables = stockAtScale(1, 5_100);
    const onlyVariant = tables.product_variants![0]!.id as string;
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    // It must refuse outright. Returning the 5_000 rows it did read would put a
    // confidently wrong on-hand number on the variant detail screen.
    await withDb(db, async () => {
      await expect(getVariantStock(ctxWith(["inventory.read"]), onlyVariant)).rejects.toThrow(
        /could not be read completely/i,
      );
    });
  });

  it("the single-variant read drains every page when it can", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    // 1_100 location rows for one variant, behind a 1000-row cap.
    const tables = stockAtScale(1, 1_100);
    const onlyVariant = tables.product_variants![0]!.id as string;
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const stock = await withDb(db, () => getVariantStock(ctxWith(["inventory.read"]), onlyVariant));

    expect(stock.byLocation).toHaveLength(1_100);
    expect(stock.quantityOnHand).toBe(1_100);
  });

  it("no completeness decision is made from a requested page size", () => {
    // The defect was a row-count comparison against a self-chosen constant.
    // Guard the shape, not just the behaviour: nothing may compare a result
    // length against the page size to decide truncation.
    const repo = readCode("src/server/inventory/repository.ts");
    expect(repo).not.toMatch(/length\s*>=\s*STOCK_PAGE_SIZE/);
    expect(repo).not.toMatch(/length\s*===\s*STOCK_PAGE_SIZE/);
    expect(repo).not.toMatch(/STOCK_ROWS_PER_CHUNK/);
    // The terminal condition is an empty page.
    expect(repo).toContain("page.length === 0");
    // And the offset advances by rows actually returned.
    expect(repo).toContain("offset += page.length");
  });
});

// ── A3. Budget exhaustion must fail closed, not produce confident wrong stock ──
//
// The deterministic paging fix removed the row-cap defect, but left a second
// way to the SAME user-visible harm. When a chunk hit STOCK_ROW_BUDGET_PER_CHUNK
// the read reported `truncated: true` — and then still built an entry for every
// variant in the page using "partial total OR 0". So:
//
//   - a variant straddling the cutoff showed a confident UNDERSTATED number; and
//   - a variant lying entirely past the cutoff showed a confident FALSE ZERO,
//     which a merchant reads as "nothing on hand" and restocks against.
//
// Reproduced at 100 variants x 250 locations against a 20_000-row budget:
// truncated was true, yet 20 variants carried wrong values including zeros, and
// the UI marked NOTHING as unknown because every variant had an entry.
//
// Fix: an incomplete chunk contributes no rows and its variant ids come back in
// `incompleteVariantIds`; the service omits those variants from `entries`, so
// the existing `truncated ? null : 0` presentation path renders them unknown.

describe("A3. an exhausted row budget never yields a confident total or a false zero", () => {
  /** True on-hand for every variant built by `stockAtScale(_, locationsPer)`. */
  const TRUE_QTY = (locationsPer: number) => locationsPer;

  it("100 variants x 250 locations vs a 20_000 budget: unknown, never wrong", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 25_000 rows in ONE chunk. The walk stops at 20_000, so the last ~20
    // variants were never reached at all and the straddling one is a prefix.
    const db = makeOrgScopedDb(stockAtScale(100, 250), { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(true);

    // The precise regression: no entry may carry a wrong number, and the old
    // bug's signature — a confident 0 for a variant that really holds 250 —
    // must not appear at all.
    const wrong = result.entries.filter((e) => e.quantityOnHand !== TRUE_QTY(250));
    expect(wrong).toEqual([]);
    const falseZeros = result.entries.filter((e) => e.quantityOnHand === 0);
    expect(falseZeros).toEqual([]);
  });

  it("the unproven variants reach the UI as unknown, not as a quantity", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const tables = stockAtScale(100, 250);
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    // Join against the catalogue exactly as the screen does.
    const products = [
      {
        id: PRODUCT_A,
        nameKm: "ផលិតផល",
        nameEn: "Product",
        status: "ACTIVE",
        variants: (tables.product_variants ?? []).map((v) => ({
          id: v.id as string,
          name: "V",
          sku: null,
          status: "ACTIVE",
        })),
      },
    ];
    const rows = buildInventoryRows(products as never, result as never);

    expect(rows).toHaveLength(100);
    // Every variant the read could not prove renders as unknown (null), which
    // the screen shows as "Not loaded". None renders as a number.
    const unknown = rows.filter((r) => r.quantityOnHand === null);
    expect(unknown).toHaveLength(100);
    expect(rows.filter((r) => r.quantityOnHand === 0)).toEqual([]);
  });

  it("a boundary-straddling variant is unknown, never its partial 101", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 100 x 201 = 20_100 rows. The 100th variant truly holds 201 but only 101
    // of its rows sit inside the 20_000 budget. 101 must never be reported.
    const tables = stockAtScale(100, 201);
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(true);
    const straddler = (tables.product_variants ?? [])[99]!.id as string;
    const entry = result.entries.find((e) => e.variantId === straddler);
    expect(entry).toBeUndefined();
    // The specific understated value the old code produced.
    expect(result.entries.some((e) => e.quantityOnHand === 101)).toBe(false);
  });

  it("a variant entirely past the cutoff is unknown, never a confident 0", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const tables = stockAtScale(100, 250);
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    // 80 x 250 = 20_000 exactly, so variants 80..99 were never read at all
    // while genuinely holding 250 each.
    const beyond = (tables.product_variants ?? [])[99]!.id as string;
    expect(result.entries.find((e) => e.variantId === beyond)).toBeUndefined();
    expect(result.entries.every((e) => e.quantityOnHand !== 0)).toBe(true);
  });

  it("a fully drained chunk keeps its exact totals when another chunk is cut", async () => {
    const { listStockRowsForVariants } = await import("../server/inventory/repository");
    // Chunk 1: 100 variants x 5 locations = 500 rows, drains cleanly.
    // Chunk 2: 100 variants x 250 locations = 25_000 rows, hits the budget.
    const small = stockAtScale(100, 5);
    const big = stockAtScale(100, 250);
    const rename = (rows: FakeRow[], prefix: string) =>
      rows.map((r) => ({ ...r, variant_id: `${prefix}${r.variant_id as string}` }));
    const tables: Record<string, FakeRow[]> = {
      inventory_stock: [
        ...rename(small.inventory_stock ?? [], "a-"),
        ...rename(big.inventory_stock ?? [], "b-"),
      ],
    };
    const smallIds = (small.product_variants ?? []).map((v) => `a-${v.id as string}`);
    const bigIds = (big.product_variants ?? []).map((v) => `b-${v.id as string}`);

    const db = makeOrgScopedDb(tables, { maxRows: 1000 });
    const result = await withDb(db, () =>
      listStockRowsForVariants(ORG_A, [...smallIds, ...bigIds]),
    );

    expect(result.truncated).toBe(true);
    // One oversized chunk must not poison an independent, complete one.
    expect(result.incompleteVariantIds.sort()).toEqual([...bigIds].sort());
    expect(result.rows).toHaveLength(500);
    expect(result.rows.every((r) => r.variant_id.startsWith("a-"))).toBe(true);
  });

  it("negative quantities stay exact for variants that were proven complete", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    // 11 locations per variant: +1 x 10 and -33 on the last -> -23 exactly.
    const db = makeOrgScopedDb(
      stockAtScale(100, 11, (_v, l) => (l === 10 ? -33 : 1)),
      { maxRows: 1000 },
    );

    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(100);
    // Nothing clamped to zero, and the sign preserved.
    expect(result.entries.filter((e) => e.quantityOnHand !== -23)).toEqual([]);
  });

  it("an exhausted budget still never leaks another tenant's rows", async () => {
    const { listStockRowsForVariants } = await import("../server/inventory/repository");
    const mine = stockAtScale(100, 250);
    // Org B holds the SAME variant ids at the same locations, with loud
    // quantities. Neither the drained rows nor the incomplete-id list may
    // acquire anything of Org B's, budget or no budget.
    const theirs = (mine.inventory_stock ?? []).map((r) => ({
      ...r,
      organization_id: ORG_B,
      quantity_on_hand: 9999,
    }));
    const interleaved: FakeRow[] = [];
    for (let i = 0; i < (mine.inventory_stock ?? []).length; i += 1) {
      interleaved.push(mine.inventory_stock![i]!, theirs[i]!);
    }
    const ids = (mine.product_variants ?? []).map((v) => v.id as string);

    const db = makeOrgScopedDb({ inventory_stock: interleaved }, { maxRows: 1000 });
    const result = await withDb(db, () => listStockRowsForVariants(ORG_A, ids));

    expect(result.truncated).toBe(true);
    expect(result.rows.every((r) => r.organization_id === ORG_A)).toBe(true);
    expect(result.rows.some((r) => r.quantity_on_hand === 9999)).toBe(false);
  });

  it("exactly at the budget it stays conservative rather than guessing complete", async () => {
    const { listStockRowsForVariants } = await import("../server/inventory/repository");
    // 100 x 200 = 20_000 rows, exactly the budget. The walk stops without ever
    // seeing an empty terminal page, so completeness was never PROVEN. Calling
    // that complete would be the same class of guess the paging fix removed.
    const tables = stockAtScale(100, 200);
    const ids = (tables.product_variants ?? []).map((v) => v.id as string);
    const db = makeOrgScopedDb(tables, { maxRows: 1000 });

    const result = await withDb(db, () => listStockRowsForVariants(ORG_A, ids));

    expect(result.truncated).toBe(true);
    expect(result.incompleteVariantIds).toHaveLength(100);
    expect(result.rows).toEqual([]);
  });

  it("the service never turns an unproven variant into a number", async () => {
    // Structural guard: entries are built from a list filtered by the
    // incomplete set, so a future edit cannot quietly reintroduce
    // "partial total OR 0" for every variant in the page.
    const svc = await Bun.file(
      new URL("../server/inventory/service.ts", import.meta.url).pathname,
    ).text();
    expect(svc).toContain("incompleteVariantIds");
    expect(svc).toMatch(/filter\(\s*\(variant\)\s*=>\s*!incomplete\.has\(variant\.id\)\s*\)/);
  });
});

// ── B. Tenant isolation ──────────────────────────────────────────────────────

describe("B. another organization's inventory is unreachable", () => {
  it("Org A's stock list never contains an Org B variant or quantity", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const result = await withDb(db, () =>
      listOrganizationStock(ctxWith(["inventory.read"], ORG_A), {}),
    );

    expect(result.entries.map((entry) => entry.variantId)).not.toContain(VARIANT_B);
    expect(result.entries.map((entry) => entry.quantityOnHand)).not.toContain(999);
  });

  it("a variant id copied from Org B comes back as a plain not-found", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expect(getVariantStock(ctxWith(["inventory.read"], ORG_A), VARIANT_B)).rejects.toThrow(
        /Variant not found/i,
      );
    });
  });

  it("the locations list is scoped to the caller's own organization", async () => {
    const { listInventoryLocations } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const orgA = await withDb(db, () => listInventoryLocations(ctxWith(["inventory.read"], ORG_A)));

    expect(orgA.map((location) => location.id)).toEqual([LOCATION_A]);
    expect(orgA.map((location) => location.name)).not.toContain("Org B warehouse");
  });

  it("recording a movement against an Org B variant writes nothing", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expect(
        recordMovement(ctxWith(["inventory.receive_stock"], ORG_A), {
          productId: PRODUCT_A,
          variantId: VARIANT_B,
          quantityDelta: 5,
          movementType: "restock",
        }),
      ).rejects.toThrow(/Variant not found/i);
    });

    expect(db.writes).toEqual([]);
  });

  it("receiving into an Org B location writes nothing", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expect(
        recordMovement(ctxWith(["inventory.receive_stock"], ORG_A), {
          productId: PRODUCT_A,
          variantId: VARIANT_MOVED,
          locationId: LOCATION_B,
          quantityDelta: 5,
          movementType: "restock",
        }),
      ).rejects.toThrow(/Location not found/i);
    });

    expect(db.writes).toEqual([]);
  });

  it("the new reads take organization only from the auth context, never from input", () => {
    const api = read("src/api/inventory.ts");
    const start = api.indexOf("export const listOrganizationStockFn");
    const block = api.slice(start);

    // The only thing on the wire is a limit.
    expect(block).toContain("resolveAuthContext()");
    expect(block).not.toMatch(/organizationId:\s*z\./);
    expect(block).not.toMatch(/organization_id/);
    // Locations takes no input at all.
    expect(api).toContain("export const listInventoryLocationsFn = createServerFn().handler");
  });
});

// ── C. Server-side permission enforcement ────────────────────────────────────

describe("C. each inventory key independently gates what it names, server-side", () => {
  it("the stock list requires inventory.read", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expectForbidden(() => listOrganizationStock(ctxWith([]), {}));
      await expectForbidden(() =>
        listOrganizationStock(ctxWith(["inventory.view_movements", "inventory.adjust"]), {}),
      );
    });
  });

  it("the locations list requires inventory.read", async () => {
    const { listInventoryLocations } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expectForbidden(() => listInventoryLocations(ctxWith([])));
    });
  });

  it("movement history requires inventory.view_movements, not inventory.read", async () => {
    const { listMovementHistory } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expectForbidden(() => listMovementHistory(ctxWith(["inventory.read"]), {}));
    });
  });

  it("receiving stock requires inventory.receive_stock, and reading is not enough", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expectForbidden(() =>
        recordMovement(ctxWith(["inventory.read", "inventory.view_movements"]), {
          productId: PRODUCT_A,
          variantId: VARIANT_MOVED,
          quantityDelta: 5,
          movementType: "restock",
        }),
      );
    });
    expect(db.writes).toEqual([]);
  });

  it("adjusting requires inventory.adjust, and receive_stock is not enough", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expectForbidden(() =>
        recordMovement(ctxWith(["inventory.read", "inventory.receive_stock"]), {
          productId: PRODUCT_A,
          variantId: VARIANT_MOVED,
          quantityDelta: -1,
          movementType: "manual_adjustment",
          reason: "Stocktake",
        }),
      );
    });
    expect(db.writes).toEqual([]);
  });

  it("a CASHIER-role context with inventory.read still reads stock — role names decide nothing", async () => {
    const { listOrganizationStock } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    // ctxWith() reports systemRole CASHIER throughout this file, and isOwner()
    // is false. The read succeeds on the permission alone.
    const result = await withDb(db, () => listOrganizationStock(ctxWith(["inventory.read"]), {}));

    expect(result.entries.length).toBe(3);
  });
});

// ── D. Browser-side capability gating ────────────────────────────────────────

describe("D. the UI offers exactly what the member's keys allow", () => {
  it("every inventory key the UI consults is in the declared vocabulary", () => {
    for (const key of INVENTORY_KEYS) {
      expect(UI_PERMISSION_KEYS).toContain(key);
    }
  });

  it("does not declare permissions the server does not implement", () => {
    // PERMISSIONS_MATRIX.md §13 lists these; no migration seeds them and no
    // server function checks them, so the UI must not pretend to gate on them.
    for (const speculative of [
      "inventory.transfer",
      "inventory.mark_damage",
      "inventory.override_reservation",
    ]) {
      expect(UI_PERMISSION_KEYS as readonly string[]).not.toContain(speculative);
    }
  });

  it("inventory.read alone opens the list and the detail view", () => {
    const view = createFixtureCapabilityView(["inventory.read", "products.read"], "CASHIER");
    expect(view.can("inventory.read")).toBe(true);
  });

  it("without inventory.read the list is denied", () => {
    const view = createFixtureCapabilityView(["products.read"], "CASHIER");
    expect(view.can("inventory.read")).toBe(false);
  });

  it("view_movements, receive_stock and adjust each gate only themselves", () => {
    const readOnly = createFixtureCapabilityView(["inventory.read"], "CASHIER");
    expect(readOnly.can("inventory.view_movements")).toBe(false);
    expect(readOnly.can("inventory.receive_stock")).toBe(false);
    expect(readOnly.can("inventory.adjust")).toBe(false);

    const receiver = createFixtureCapabilityView(
      ["inventory.read", "inventory.receive_stock"],
      "SALES",
    );
    expect(receiver.can("inventory.receive_stock")).toBe(true);
    expect(receiver.can("inventory.adjust")).toBe(false);
    expect(receiver.can("inventory.view_movements")).toBe(false);

    const adjuster = createFixtureCapabilityView(["inventory.read", "inventory.adjust"], "SALES");
    expect(adjuster.can("inventory.adjust")).toBe(true);
    expect(adjuster.can("inventory.receive_stock")).toBe(false);
  });

  it("restricted staff see stock but no admin actions, whatever their role label says", () => {
    // An OWNER label with only inventory.read gets no more than a CASHIER
    // label with only inventory.read: the label is never consulted.
    const labelledOwner = createFixtureCapabilityView(["inventory.read"], "OWNER");
    const labelledCashier = createFixtureCapabilityView(["inventory.read"], "CASHIER");

    for (const view of [labelledOwner, labelledCashier]) {
      expect(view.can("inventory.read")).toBe(true);
      expect(view.can("inventory.receive_stock")).toBe(false);
      expect(view.can("inventory.adjust")).toBe(false);
      expect(view.can("inventory.view_movements")).toBe(false);
    }
  });

  it("nothing is offered while the snapshot is unresolved or denied", () => {
    const pending = createCapabilityView({
      result: undefined,
      isPending: true,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    const denied = createCapabilityView({
      result: { status: "no_membership" },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });

    for (const view of [pending, denied]) {
      for (const key of INVENTORY_KEYS) {
        expect(view.can(key)).toBe(false);
      }
    }
  });

  it("movement history uses canSensitive, so an unconfirmed snapshot hides it", () => {
    // A retained snapshot whose latest refresh failed: still "ready" for
    // navigation, never confirmed for a disclosure.
    const stale = createCapabilityView({
      result: {
        status: "active",
        userId: USER_A,
        organizationId: ORG_A,
        role: "MANAGER",
        permissions: ["inventory.read", "inventory.view_movements"],
      },
      isPending: false,
      isError: true,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });

    expect(stale.state).toBe("ready");
    expect(stale.stale).toBe(true);
    // Quantities survive a flaky refresh; the history behind them does not.
    expect(stale.can("inventory.read")).toBe(true);
    expect(stale.canSensitive("inventory.view_movements")).toBe(false);

    const detail = read("src/routes/app.inventory.$variantId.tsx");
    expect(detail).toContain('canSensitive("inventory.view_movements")');
  });

  it("the inventory screens gate on keys, never on a role name", () => {
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
      "src/components/inventory/ReceiveStockSheet.tsx",
      "src/components/inventory/AdjustStockSheet.tsx",
    ]) {
      const code = readCode(file);
      expect(code).not.toMatch(/\b(OWNER|MANAGER|CASHIER|SALES|CUSTOMER_SERVICE)\b/);
      expect(code).not.toMatch(/capabilities\.role|\.isOwner\(/);
    }
  });

  it("each gated surface names the key its server function requires", () => {
    const list = read("src/routes/app.inventory.tsx");
    const detail = read("src/routes/app.inventory.$variantId.tsx");
    const service = read("src/server/inventory/service.ts");

    expect(list).toContain('"inventory.read"');
    expect(detail).toContain('"inventory.read"');
    expect(detail).toContain('"inventory.view_movements"');
    expect(detail).toContain('"inventory.receive_stock"');
    expect(detail).toContain('"inventory.adjust"');

    for (const key of INVENTORY_KEYS) {
      expect(service).toContain(`"${key}"`);
    }
  });

  it("a screen does not fetch the data it is not allowed to show", () => {
    const list = read("src/routes/app.inventory.tsx");
    const detail = read("src/routes/app.inventory.$variantId.tsx");

    expect(list).toContain("enabled: !detailOpen && canReadStock");
    expect(detail).toContain("enabled: canReadStock && idLooksValid");
    expect(detail).toContain("enabled: canViewMovements && idLooksValid");
  });

  it("both screens read capabilities from the one shared hook", () => {
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain('from "@/hooks/use-capabilities"');
      expect(source).toContain("useCapabilities()");
    }
  });

  it("the stock workspace nav entry is live and gated on inventory.read", () => {
    const nav = read("src/design-system/mobile-nav-config.ts");
    const start = nav.indexOf('id: "products-stock"');
    const entry = nav.slice(start, nav.indexOf("},", start));

    expect(entry).toContain('availability: "live"');
    expect(entry).toContain('to: "/app/inventory"');
    expect(entry).toContain('requiresAll: ["inventory.read"]');
    // The Product catalogue stays its own entry, on its own key.
    expect(nav).toContain('to: "/app/products"');
    expect(nav).toContain('requiresAll: ["products.read"]');
  });
});

// ── E. Mutations ─────────────────────────────────────────────────────────────

describe("E. every stock change is a ledger movement", () => {
  it("there is no setStock, no quantity write and no stock overwrite anywhere", () => {
    for (const file of [
      "src/server/inventory/service.ts",
      "src/server/inventory/repository.ts",
      "src/api/inventory.ts",
      "src/lib/inventory.ts",
      "src/components/inventory/ReceiveStockSheet.tsx",
      "src/components/inventory/AdjustStockSheet.tsx",
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const source = readCode(file);
      expect(source).not.toMatch(/\bsetStock\b/);
      expect(source).not.toMatch(/updateStock|overwriteStock|quantity_on_hand\s*=/);
    }
    // The ledger table is never updated or deleted from, only inserted into.
    const repo = readCode("src/server/inventory/repository.ts");
    expect(repo).not.toMatch(/\.update\(|\.delete\(/);
  });

  it("both sheets mutate only through the recordMovement path", () => {
    for (const file of [
      "src/components/inventory/ReceiveStockSheet.tsx",
      "src/components/inventory/AdjustStockSheet.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("recordInventoryMovement");
    }
    const lib = read("src/lib/inventory.ts");
    expect(lib).toContain("recordMovementFn");
    expect(lib).toContain('await import("@/api/inventory")');
  });

  it("the adjustment sheet sends movementType manual_adjustment with a reason", () => {
    const source = read("src/components/inventory/AdjustStockSheet.tsx");
    expect(source).toContain('movementType: "manual_adjustment"');
    expect(source).toContain("reason: reason.trim()");
  });

  it("the receive sheet offers only the two receive movement types", () => {
    const lib = read("src/lib/inventory.ts");
    expect(lib).toContain('export const RECEIVE_MOVEMENT_TYPES = ["restock", "initial"] as const');

    const sheet = read("src/components/inventory/ReceiveStockSheet.tsx");
    expect(sheet).toContain("RECEIVE_MOVEMENT_TYPES");
    const code = readCode("src/components/inventory/ReceiveStockSheet.tsx");
    expect(code).not.toMatch(/"sale"|"return"|"manual_adjustment"/);
  });

  it("a manual adjustment without a reason is refused by the server and writes nothing", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      for (const reason of [undefined, "", "   "]) {
        await expect(
          recordMovement(ctxWith(["inventory.adjust"]), {
            productId: PRODUCT_A,
            variantId: VARIANT_MOVED,
            quantityDelta: -2,
            movementType: "manual_adjustment",
            ...(reason === undefined ? {} : { reason }),
          }),
        ).rejects.toThrow(/reason is required/i);
      }
    });

    expect(db.writes).toEqual([]);
  });

  it("the adjustment form refuses to submit a blank reason before any request", () => {
    expect(canSubmitAdjustment("-3", "Stocktake correction")).toBe(true);
    expect(canSubmitAdjustment("-3", "")).toBe(false);
    // Whitespace is not a reason — the same rule the server applies.
    expect(canSubmitAdjustment("-3", "   ")).toBe(false);
    expect(canSubmitAdjustment("", "Stocktake correction")).toBe(false);
    expect(canSubmitAdjustment("0", "Stocktake correction")).toBe(false);
  });

  it("a manual adjustment is audited BEFORE the ledger row, and stays fail-closed", async () => {
    const source = read("src/server/inventory/service.ts");
    const start = source.indexOf("export async function recordMovement");
    const body = source.slice(start, source.indexOf("\n}", source.indexOf("return mapMovement")));

    const auditIdx = body.indexOf("auditLogRequired");
    const insertIdx = body.indexOf("repo.insertMovement");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeLessThan(insertIdx);

    // And the audit helper itself throws rather than warning.
    const audit = read("src/server/auth/audit.ts");
    expect(audit).toContain("The operation was blocked to preserve the audit trail");
  });

  it("a blocked audit surfaces as its own message, never as a generic retry", () => {
    const auditFailure = new Error(
      "Audit record could not be persisted for action 'inventory.adjust'. The operation was blocked to preserve the audit trail. (db down)",
    );
    expect(classifyInventoryError(auditFailure)).toBe("audit_blocked");
  });

  it("the receive form refuses a zero, negative or non-integer quantity", () => {
    expect(canSubmitReceipt("5")).toBe(true);
    expect(canSubmitReceipt("0")).toBe(false);
    expect(canSubmitReceipt("-5")).toBe(false);
    expect(canSubmitReceipt("2.5")).toBe(false);
    expect(canSubmitReceipt("")).toBe(false);
    expect(canSubmitReceipt("abc")).toBe(false);
  });

  it("a zero delta is refused by the server too", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    await withDb(db, async () => {
      await expect(
        recordMovement(ctxWith(["inventory.receive_stock"]), {
          productId: PRODUCT_A,
          variantId: VARIANT_MOVED,
          quantityDelta: 0,
          movementType: "restock",
        }),
      ).rejects.toThrow(/non-zero integer/i);
    });
    expect(db.writes).toEqual([]);
  });

  it("idempotency behaviour is unchanged — a duplicate reference is still a duplicate", async () => {
    const { isDuplicateReferenceError } = await import("../server/inventory/repository");
    const uniqueViolation = Object.assign(
      new Error("insertMovement: duplicate key value violates uniq_inventory_movements_reference"),
      { code: "23505" },
    );

    expect(isDuplicateReferenceError(uniqueViolation)).toBe(true);
    expect(
      classifyInventoryError(
        new Error("A movement for this reference already exists (idempotent duplicate)"),
      ),
    ).toBe("duplicate");

    // The idempotency key is still (org, variant, movement_type, reference).
    const migration = read("supabase/migrations/021_inventory_movements.sql");
    expect(migration).toContain(
      "ON public.inventory_movements(organization_id, variant_id, movement_type, reference_type, reference_id)",
    );
  });

  it("a valid receipt reaches the ledger as one appended row", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const db = twoOrgFixture();

    const movement = await withDb(db, () =>
      recordMovement(ctxWith(["inventory.receive_stock"]), {
        productId: PRODUCT_A,
        variantId: VARIANT_MOVED,
        locationId: LOCATION_A,
        quantityDelta: 12,
        movementType: "restock",
      }),
    );

    expect(movement.quantityDelta).toBe(12);
    expect(movement.movementType).toBe("restock");
    expect(db.writes).toEqual(["insert:inventory_movements"]);
  });
});

// ── F. Cache isolation ───────────────────────────────────────────────────────

describe("F. one browser tab never serves another principal's inventory data", () => {
  it("keys are partitioned by user AND organization", () => {
    const a = inventoryKeys.stockList(USER_A, ORG_A);
    const sameOrgOtherUser = inventoryKeys.stockList(USER_B, ORG_A);
    const sameUserOtherOrg = inventoryKeys.stockList(USER_A, ORG_B);

    expect(a).not.toEqual(sameOrgOtherUser);
    expect(a).not.toEqual(sameUserOtherOrg);

    // Movement history, the most sensitive payload, is partitioned the same way.
    expect(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED)).not.toEqual(
      inventoryKeys.movements(USER_B, ORG_A, VARIANT_MOVED),
    );
  });

  it("user B's key cannot read back user A's cached stock", () => {
    const client = new QueryClient();
    client.setQueryData(inventoryKeys.stockList(USER_A, ORG_A), {
      entries: [
        { variantId: VARIANT_MOVED, productId: PRODUCT_A, quantityOnHand: 7, lastMovementAt: null },
      ],
      truncated: false,
    });

    expect(client.getQueryData(inventoryKeys.stockList(USER_B, ORG_A))).toBeUndefined();
  });

  it("a principal change REMOVES the previous member's inventory data, not just invalidates it", () => {
    const client = new QueryClient();
    enforceInventoryCachePrincipal(client, USER_A, ORG_A);
    client.setQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED), [
      { id: "m1", reason: "Damaged in transit" },
    ]);

    enforceInventoryCachePrincipal(client, USER_B, ORG_A);

    // Removed outright — nothing readable while a refetch resolves.
    expect(
      client.getQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED)),
    ).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("the same principal keeps its cache, so ordinary caching still works", () => {
    const client = new QueryClient();
    enforceInventoryCachePrincipal(client, USER_A, ORG_A);
    client.setQueryData(inventoryKeys.stockList(USER_A, ORG_A), { entries: [], truncated: false });

    enforceInventoryCachePrincipal(client, USER_A, ORG_A);

    expect(client.getQueryData(inventoryKeys.stockList(USER_A, ORG_A))).toBeDefined();
  });

  it("losing inventory.view_movements evicts cached history and leaves quantities alone", () => {
    const client = new QueryClient();
    client.setQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED), [
      { id: "m1", reason: "Adjusted after stocktake" },
    ]);
    client.setQueryData(inventoryKeys.stockList(USER_A, ORG_A), { entries: [], truncated: false });
    client.setQueryData(inventoryKeys.variantStock(USER_A, ORG_A, VARIANT_MOVED), {
      quantityOnHand: 7,
    });

    enforceMovementHistoryCapability(client, false);

    expect(
      client.getQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED)),
    ).toBeUndefined();
    expect(client.getQueryData(inventoryKeys.stockList(USER_A, ORG_A))).toBeDefined();
    expect(
      client.getQueryData(inventoryKeys.variantStock(USER_A, ORG_A, VARIANT_MOVED)),
    ).toBeDefined();
  });

  it("keeping the grant keeps the history cached", () => {
    const client = new QueryClient();
    client.setQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED), [{ id: "m1" }]);

    enforceMovementHistoryCapability(client, true);

    expect(
      client.getQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED)),
    ).toBeDefined();
  });

  it("the history purge reaches every principal's entry, not only the current one", () => {
    const client = new QueryClient();
    client.setQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED), [{ id: "a" }]);
    client.setQueryData(inventoryKeys.movements(USER_B, ORG_B, VARIANT_MOVED), [{ id: "b" }]);

    clearInventoryMovementQueries(client);

    expect(
      client.getQueryData(inventoryKeys.movements(USER_A, ORG_A, VARIANT_MOVED)),
    ).toBeUndefined();
    expect(
      client.getQueryData(inventoryKeys.movements(USER_B, ORG_B, VARIANT_MOVED)),
    ).toBeUndefined();
  });

  it("both screens take cache identity from the route context, never the snapshot", () => {
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("Route.useRouteContext()");
      expect(source).toContain(
        "enforceInventoryCachePrincipal(queryClient, userId, routeOrganizationId)",
      );
      expect(source).toContain("capabilities.organizationId === routeOrganizationId");
    }
  });
});

// ── G. The Product × Inventory join ──────────────────────────────────────────

function productFixture(): CatalogProduct[] {
  return [
    {
      id: PRODUCT_A,
      organizationId: ORG_A,
      workspaceId: null,
      nameKm: "អាវយឺត",
      nameEn: "T-shirt",
      descriptionKm: null,
      descriptionEn: null,
      categoryId: null,
      status: "ACTIVE",
      companion: "blue" as CatalogProduct["companion"],
      stock: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      variants: [
        {
          id: VARIANT_MOVED,
          productId: PRODUCT_A,
          sku: "TS-M",
          barcode: null,
          name: "Medium",
          price: { amount: 1500, currency: "USD" },
          cost: { amount: 900, currency: "USD" },
          weightGrams: null,
          status: "ACTIVE",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: VARIANT_NEVER_MOVED,
          productId: PRODUCT_A,
          sku: "TS-L",
          barcode: null,
          name: "Large",
          price: { amount: 1500, currency: "USD" },
          cost: null,
          weightGrams: null,
          status: "ACTIVE",
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
  ];
}

describe("G. the join keeps the ledger authoritative and stays honest about gaps", () => {
  const stock: OrgStockList = {
    entries: [
      {
        variantId: VARIANT_MOVED,
        productId: PRODUCT_A,
        quantityOnHand: -3,
        lastMovementAt: "2026-02-01T00:00:00Z",
      },
      {
        variantId: VARIANT_NEVER_MOVED,
        productId: PRODUCT_A,
        quantityOnHand: 0,
        lastMovementAt: null,
      },
    ],
    truncated: false,
  };

  it("takes quantity only from Inventory and identity only from the catalogue", () => {
    const rows = buildInventoryRows(productFixture(), stock);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.quantityOnHand).toBe(-3);
    expect(rows[0]!.productNameKm).toBe("អាវយឺត");
    expect(rows[0]!.sku).toBe("TS-M");
  });

  it("never carries a product cost onto a stock row", () => {
    const rows = buildInventoryRows(productFixture(), stock);

    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("cost");
      expect(Object.keys(row)).not.toContain("price");
    }
    // And no stock screen reads a cost or renders money.
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toContain("visibleVariantCost");
      expect(source).not.toContain("formatMoney");
      expect(source).not.toContain("products.view_cost");
    }
  });

  it("a covered variant with no movements reads 0, never unknown", () => {
    const rows = buildInventoryRows(productFixture(), stock);
    const large = rows.find((row) => row.variantId === VARIANT_NEVER_MOVED);

    expect(large!.quantityOnHand).toBe(0);
  });

  it("a variant the untruncated read did not mention is still 0", () => {
    const rows = buildInventoryRows(productFixture(), { entries: [], truncated: false });

    expect(rows.every((row) => row.quantityOnHand === 0)).toBe(true);
  });

  it("a variant outside a TRUNCATED read is unknown, never a fabricated 0", () => {
    const rows = buildInventoryRows(productFixture(), { entries: [], truncated: true });

    expect(rows.every((row) => row.quantityOnHand === null)).toBe(true);
  });

  it("no stock yet, and no join input at all, still produces no invented number", () => {
    expect(buildInventoryRows(productFixture(), undefined)).toHaveLength(2);
    expect(
      buildInventoryRows(productFixture(), undefined).every((row) => row.quantityOnHand === 0),
    ).toBe(true);
    expect(buildInventoryRows([], stock)).toEqual([]);
  });

  it("the Product domain's own stock field is never read", () => {
    for (const file of ["src/routes/app.inventory.tsx", "src/lib/inventory.ts"]) {
      const code = readCode(file);
      expect(code).not.toMatch(/product\.stock|\.stock\b/);
    }
  });
});

// ── Presentation helpers ─────────────────────────────────────────────────────

describe("negative stock is rendered as itself, never clamped", () => {
  it("classifies the three states without inventing a threshold", () => {
    expect(stockState(-3)).toBe("negative");
    expect(stockState(0)).toBe("zero");
    expect(stockState(12)).toBe("positive");
    // No low-stock band exists — 1 is simply positive.
    expect(stockState(1)).toBe("positive");
  });

  it("formats the exact quantity, sign included", () => {
    expect(formatQuantity(-3)).toBe("-3");
    expect(formatQuantity(0)).toBe("0");
    expect(formatQuantity(12)).toBe("12");
  });

  it("shows a movement's direction explicitly", () => {
    expect(formatMovementDelta(5)).toBe("+5");
    expect(formatMovementDelta(-5)).toBe("-5");
  });

  it("no screen floors, absolutes or Math.max-es a quantity", () => {
    for (const file of [
      "src/lib/inventory.ts",
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/Math\.abs|Math\.max\(0/);
    }
  });

  it("parses whole units only, with signs allowed only where a delta is", () => {
    expect(parseQuantity("7", false)).toBe(7);
    expect(parseQuantity("-7", false)).toBeNull();
    expect(parseQuantity("-7", true)).toBe(-7);
    expect(parseQuantity("7.5", true)).toBeNull();
    expect(parseQuantity(" 7 ", false)).toBe(7);
    expect(parseQuantity("", true)).toBeNull();
  });

  it("movement history uses business labels, never the enum value", () => {
    expect(movementTypeLabelKey("restock")).toBe("movementHistory.type.restock");
    expect(movementTypeLabelKey("manual_adjustment")).toBe(
      "movementHistory.type.manual_adjustment",
    );

    const en = JSON.parse(read("src/locales/en.json"));
    expect(en.movementHistory.type.restock).toBe("Stock received");
    expect(en.movementHistory.type.manual_adjustment).toBe("Manual adjustment");
  });

  it("names a location when it is known and says so plainly when it is not", () => {
    const locations = [{ id: LOCATION_A, name: "Phnom Penh shop", status: "active" }];
    expect(locationName(LOCATION_A, locations)).toBe("Phnom Penh shop");
    expect(locationName(null, locations)).toBeNull();
    expect(locationName(LOCATION_B, locations)).toBeNull();
  });

  it("search is scoped to what is loaded and says so on screen", () => {
    const rows = buildInventoryRows(productFixture(), {
      entries: [],
      truncated: false,
    });

    expect(searchLoadedInventory(rows, "medium")).toHaveLength(1);
    expect(searchLoadedInventory(rows, "TS-L")).toHaveLength(1);
    expect(searchLoadedInventory(rows, "អាវយឺត")).toHaveLength(2);
    expect(searchLoadedInventory(rows, "nothing")).toHaveLength(0);
    expect(searchLoadedInventory(rows, "")).toHaveLength(2);

    expect(read("src/routes/app.inventory.tsx")).toContain("inventoryList.searchScope");
  });
});

// ── H. Localization ──────────────────────────────────────────────────────────

describe("H. every new inventory string exists in Khmer and English", () => {
  const en = JSON.parse(read("src/locales/en.json"));
  const km = JSON.parse(read("src/locales/km.json"));

  const NAMESPACES = [
    "inventory",
    "inventoryList",
    "inventoryDetail",
    "receiveStock",
    "stockAdjustment",
    "movementHistory",
  ];

  function flatten(tree: Record<string, unknown>, prefix = ""): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(tree)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        keys.push(...flatten(value as Record<string, unknown>, p));
      } else {
        keys.push(p);
      }
    }
    return keys;
  }

  it("both locales declare every inventory namespace", () => {
    for (const ns of NAMESPACES) {
      expect(en[ns]).toBeTruthy();
      expect(km[ns]).toBeTruthy();
    }
  });

  it("Khmer and English carry the same inventory keys", () => {
    for (const ns of NAMESPACES) {
      const enKeys = flatten(en[ns]).sort();
      const kmKeys = flatten(km[ns]).sort();
      expect(kmKeys).toEqual(enKeys);
    }
  });

  it("the Khmer copy is actually Khmer, not an English placeholder", () => {
    const khmer = /[ក-៿]/;
    expect(km.inventoryList.title).toMatch(khmer);
    expect(km.inventoryList.subtitle).toMatch(khmer);
    expect(km.inventoryDetail.negativeNotice).toMatch(khmer);
    expect(km.receiveStock.confirm).toMatch(khmer);
    expect(km.stockAdjustment.reasonHint).toMatch(khmer);
    expect(km.movementHistory.type.manual_adjustment).toMatch(khmer);
    expect(km.inventory.error.audit_blocked).toMatch(khmer);
  });

  it("no Khmer inventory copy is uppercased", () => {
    for (const ns of NAMESPACES) {
      for (const key of flatten(km[ns])) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], km[ns]);
        if (typeof value === "string") {
          expect(value).not.toMatch(/[A-Z]{4,}/);
        }
      }
    }
  });

  it("every error kind the classifier can return has copy in both locales", () => {
    for (const kind of [
      "denied",
      "not_found",
      "location_not_found",
      "reason_required",
      "invalid_quantity",
      "duplicate",
      "audit_blocked",
      "generic",
    ]) {
      expect(en.inventory.error[kind]).toBeTruthy();
      expect(km.inventory.error[kind]).toBeTruthy();
    }
  });

  it("the screens hard-code no user-facing string", () => {
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
      "src/components/inventory/ReceiveStockSheet.tsx",
      "src/components/inventory/AdjustStockSheet.tsx",
      "src/components/inventory/LocationChoice.tsx",
    ]) {
      const source = read(file);
      expect(source).toMatch(/useTranslation\(\)|label=\{|noneLabel=\{/);
    }
    // The nav entry the workspace hangs off is no longer described as missing.
    const en2 = JSON.parse(read("src/locales/en.json"));
    // Moved from the retired "More" sheet into Sales with the nav redesign.
    expect(en2.nav.salesActions.productsStock.description).not.toMatch(/not in the app yet/i);
  });
});

// ── I. No production mock path ───────────────────────────────────────────────

describe("I. the inventory workspace has no mock or fallback data path", () => {
  it("nothing in the inventory data layer imports the mock layer", () => {
    for (const file of [
      "src/lib/inventory.ts",
      "src/api/inventory.ts",
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
      "src/components/inventory/ReceiveStockSheet.tsx",
      "src/components/inventory/AdjustStockSheet.tsx",
      "src/components/inventory/LocationChoice.tsx",
    ]) {
      expect(read(file)).not.toMatch(/@\/lib\/mock/);
    }
  });

  it("a failed read surfaces as a failure, never as an invented quantity", () => {
    const lib = read("src/lib/inventory.ts");
    // No catch that swallows an error into placeholder data.
    expect(lib).not.toMatch(/catch\s*\([\s\S]{0,40}\)\s*\{\s*return\s*\[/);

    const list = read("src/routes/app.inventory.tsx");
    expect(list).toContain("inventoryList.error.title");
    expect(list).toContain('tone="danger"');
  });
});

// ── J. Browser/server boundary ───────────────────────────────────────────────

describe("J. the new modules keep the server/browser boundary", () => {
  it("the inventory API module never statically imports server-only code", () => {
    const source = read("src/api/inventory.ts");
    const staticImports = source
      .split("\n")
      .filter((line) => /^import\s/.test(line.trim()) && !/^import\s+type\b/.test(line.trim()));

    for (const line of staticImports) {
      expect(line).not.toContain("@/lib/supabase/server");
      expect(line).not.toContain("@/server/inventory/");
    }
    // The new handlers still pull the service in dynamically.
    expect(source).toMatch(/await import\(["']@\/server\/inventory\/service["']\)/);
  });

  it("the browser boundary imports nothing from src/server and no Supabase client", () => {
    const source = readCode("src/lib/inventory.ts");
    expect(source).not.toMatch(/from ["']@\/server\//);
    expect(source).not.toMatch(/supabase/i);
  });

  it("the routes import nothing from src/server", () => {
    for (const file of [
      "src/routes/app.inventory.tsx",
      "src/routes/app.inventory.$variantId.tsx",
    ]) {
      const staticImports = read(file)
        .split("\n")
        .filter((line) => /^import\s/.test(line.trim()));
      for (const line of staticImports) {
        expect(line).not.toContain("@/server/");
        expect(line).not.toContain("@/lib/supabase/server");
      }
    }
  });

  it("the inventory repository is still the only file touching supabaseAdmin", () => {
    const repo = read("src/server/inventory/repository.ts");
    expect(repo).toContain('from "@/lib/supabase/server"');
    expect(read("src/server/inventory/service.ts")).not.toContain("@/lib/supabase/server");
  });
});

// ── K. No migrations, no schema drift ────────────────────────────────────────

describe("K. this phase adds no migration and no schema change", () => {
  it("the inventory reads work against the tables migrations 005 and 021 already define", () => {
    const repo = read("src/server/inventory/repository.ts");
    // Only tables that already exist.
    const tables = [...repo.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]!);
    expect([...new Set(tables)].sort()).toEqual([
      "inventory_movements",
      "inventory_stock",
      "locations",
      "product_variants",
    ]);

    expect(read("supabase/migrations/005_locations.sql")).toContain(
      "CREATE TABLE public.locations",
    );
    expect(read("supabase/migrations/021_inventory_movements.sql")).toContain(
      "CREATE VIEW public.inventory_stock",
    );
  });

  it("the four inventory permissions are the ones migration 022 already seeds", () => {
    const migration = read("supabase/migrations/022_inventory_permissions.sql");
    for (const key of INVENTORY_KEYS) {
      expect(migration).toContain(`'${key}'`);
    }
    for (const speculative of [
      "inventory.transfer",
      "inventory.mark_damage",
      "inventory.override_reservation",
    ]) {
      expect(migration).not.toContain(`'${speculative}'`);
    }
  });
});

describe("Inventory detail does not reserve dead space for a nav it never renders", () => {
  // Same defect class as the Product detail regression: this route is a
  // pushed sub-route (BottomNav never mounted here) but ScreenBleed's
  // bottom="nav" default reserved its ~100px clearance anyway, leaving a
  // dead band under the sticky Receive/Adjust button on every load.
  it("wraps its screen with bottom=\"none\"", () => {
    const detail = read("src/routes/app.inventory.$variantId.tsx");
    expect(detail).toMatch(/<ScreenBleed surface="raised" bottom="none">/);
  });
});
