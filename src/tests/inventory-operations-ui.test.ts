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
}

function makeOrgScopedDb(tables: Record<string, FakeRow[]>): FakeDb {
  const writes: string[] = [];

  function from(table: string) {
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, readonly unknown[]]> = [];
    let pendingInsert: FakeRow | null = null;
    let limit: number | null = null;

    const matched = (): FakeRow[] => {
      let rows = (tables[table] ?? []).filter((row) =>
        eqFilters.every(([col, val]) => row[col] === val),
      );
      for (const [col, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row[col]));
      }
      return limit === null ? rows : rows.slice(0, limit);
    };

    const settle = () => {
      if (pendingInsert) {
        const inserted = { id: "generated-id", ...pendingInsert };
        (tables[table] ??= []).push(inserted);
        writes.push(`insert:${table}`);
        return { data: inserted, error: null };
      }
      return { data: matched(), error: null };
    };

    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      range: () => query,
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

  return { from, writes };
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
    expect(en2.nav.moreActions.productsStock.description).not.toMatch(/not in the app yet/i);
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
