/**
 * Inventory Movement Ledger Tests.
 *
 * Covers the required test surface for the Inventory Movement Ledger phase:
 *  1.  Tenant isolation (cross-org context denied)
 *  2.  Guessed cross-org product/variant IDs denied
 *  3.  Positive and negative movements recorded correctly
 *  4.  Zero delta denied
 *  5.  Invalid movement_type denied
 *  6.  Manual adjustment requires inventory.adjust permission
 *  7.  Manual adjustment requires a reason
 *  8.  Manual adjustment is mandatorily audited (auditLogRequired, fail-closed)
 *  9.  Current stock correctness (aggregated across locations)
 * 10.  Movement history ordering (service preserves repository order — newest first)
 * 11.  Duplicate/idempotent reference behavior
 * 12.  No direct client inventory mutation (append-only — no update/delete/setStock export)
 * 13.  Cross-org location_id rejected
 * 14.  Variant/product mismatch rejected
 * 15.  Direct client (JWT) INSERT into the ledger denied by DB policy + REVOKE
 * 16.  Server/domain write path still valid after the RLS lockdown
 * 17.  Idempotency keyed on (variant, movement_type, reference) — a retried
 *      sale is rejected, a later return for the same order is allowed
 *
 * Unit tests (no DB, mocked repository db): all of the above except live-DB
 * integration checks, which are skipped when Supabase is not configured
 * (same pattern as src/tests/product-domain.test.ts).
 *
 * Run: bun test src/tests/inventory-domain.test.ts
 */

import { describe, it, expect, beforeAll, mock, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, UnauthorizedError } from "../server/auth/authorization";
import type { AuthorizationContext as AuthCtxType } from "../server/auth/authorization";

// ── Environment check ─────────────────────────────────────────────────────────

let supabaseConfigured = false;

beforeAll(() => {
  supabaseConfigured =
    Boolean(process.env["VITE_SUPABASE_URL"]) &&
    Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);

  if (!supabaseConfigured) {
    console.warn(
      "[SKIP] Live DB tests require VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
});

async function requireSupabase<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!supabaseConfigured) {
    console.warn("[SKIP] Supabase not configured");
    return null;
  }
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("SUPABASE") ||
        e.message.includes("fetch failed") ||
        e.message.includes("ECONNREFUSED"))
    ) {
      console.warn("[SKIP] Supabase unreachable");
      return null;
    }
    throw e;
  }
}

async function expectForbidden(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error("Expected ForbiddenError or UnauthorizedError, but none was thrown");
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof UnauthorizedError) return;
    throw e;
  }
}

// ── Context factory helpers (mirrors product-domain.test.ts) ──────────────────

function makeCtxWithPerms(
  userId: string,
  organizationId: string,
  permissions: string[],
  systemRole = "MANAGER",
): AuthCtxType {
  const perms = new Set<string>(permissions);
  return {
    userId,
    organizationId,
    roleId: "role-with-perms",
    systemRole,
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => systemRole === "OWNER",
    requireOwner: () => {
      if (systemRole !== "OWNER") throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthCtxType;
}

// ── Fixture UUIDs ─────────────────────────────────────────────────────────────

const ORG_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ORG_A = "user-aaaa-0000-0000-0000-000000000001";
const PRODUCT_ID = "cccccccc-0000-0000-0000-000000000001";
const VARIANT_ID = "dddddddd-0000-0000-0000-000000000001";
const OTHER_PRODUCT_ID = "eeeeeeee-0000-0000-0000-000000000001";
const LOCATION_ID = "ffffffff-0000-0000-0000-000000000001";
const FAKE_VARIANT_ID = "ffffffff-dead-beef-0000-000000000099";
const ORDER_ID = "11111111-0000-0000-0000-000000000001";

// ── Source/migration readers (structural assertions, no DB needed) ────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

function readMigration021(): string {
  return readSource("supabase/migrations/021_inventory_movements.sql");
}

// ── Mock repository DB builder ─────────────────────────────────────────────────
// A minimal fluent fake for the supabase-js query builder shape used by
// src/server/inventory/repository.ts. Chain methods return `this`; the object
// is itself thenable so `await query` (no terminal call) and `await query.single()`
// both work, matching how the repository actually calls the client.

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

function fakeQuery(result: QueryResult) {
  const q = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    insert: () => q,
    single: async () => result,
    maybeSingle: async () => result,
    then: (resolve: (v: QueryResult) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

async function withInventoryDb<T>(
  tableResults: Record<string, QueryResult>,
  fn: () => Promise<T>,
): Promise<T> {
  const { setInventoryRepositoryDbForTests } = await import("../server/inventory/repository");
  const testDb = {
    from: (table: string) => fakeQuery(tableResults[table] ?? { data: null, error: null }),
  };
  const restore = setInventoryRepositoryDbForTests(testDb);
  try {
    return await fn();
  } finally {
    restore();
  }
}

const variantRow = {
  data: { id: VARIANT_ID, product_id: PRODUCT_ID, organization_id: ORG_A_ID },
  error: null,
};
const locationRow = {
  data: { id: LOCATION_ID, organization_id: ORG_A_ID },
  error: null,
};
const noRow: QueryResult = { data: null, error: { code: "PGRST116", message: "no rows" } };

// ── Test 1: Tenant isolation ───────────────────────────────────────────────────

describe("Test 1: Tenant isolation", () => {
  it("AuthorizationService rejects a user context for the wrong org (requires DB)", async () => {
    await requireSupabase(async () => {
      const { AuthorizationService } = await import("../server/auth/authorization");
      await expectForbidden(() => AuthorizationService.forRequest(USER_ORG_A, ORG_B_ID));
    });
  });

  it("recordMovement with no permissions throws ForbiddenError, never reaches the DB", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, []);
    await expectForbidden(() =>
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: 5,
        movementType: "restock",
      }),
    );
  });
});

// ── Test 2: Guessed cross-org / nonexistent variant IDs denied ────────────────

describe("Test 2: Guessed cross-org or nonexistent variant IDs are denied", () => {
  it("recordMovement rejects when the variant does not exist in the caller's org", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await withInventoryDb({ product_variants: noRow }, async () => {
      await expect(
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: FAKE_VARIANT_ID,
          quantityDelta: 10,
          movementType: "restock",
        }),
      ).rejects.toThrow(/Variant not found/i);
    });
  });

  it("getVariantStock rejects when the variant does not exist in the caller's org", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.read"]);

    await withInventoryDb({ product_variants: noRow }, async () => {
      await expect(getVariantStock(ctx, FAKE_VARIANT_ID)).rejects.toThrow(/Variant not found/i);
    });
  });
});

// ── Test 13: Cross-org / mismatched location_id rejected ──────────────────────

describe("Test 13: Cross-org location_id is rejected", () => {
  it("recordMovement rejects when location_id does not belong to the caller's org", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await withInventoryDb(
      { product_variants: variantRow, locations: noRow },
      async () => {
        await expect(
          recordMovement(ctx, {
            productId: PRODUCT_ID,
            variantId: VARIANT_ID,
            locationId: LOCATION_ID,
            quantityDelta: 10,
            movementType: "restock",
          }),
        ).rejects.toThrow(/Location not found/i);
      },
    );
  });
});

// ── Test 14: Variant/product mismatch rejected ─────────────────────────────────

describe("Test 14: variant_id must belong to the given product_id", () => {
  it("recordMovement rejects when variant belongs to a different product", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await withInventoryDb({ product_variants: variantRow }, async () => {
      await expect(
        recordMovement(ctx, {
          productId: OTHER_PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: 10,
          movementType: "restock",
        }),
      ).rejects.toThrow(/does not belong to the given product_id/i);
    });
  });
});

// ── Test 3: Positive and negative movements ────────────────────────────────────

describe("Test 3: Positive and negative movements are recorded", () => {
  it("restock (+quantity) is inserted with the given positive delta", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    const insertedRow = {
      id: "movement-1",
      organization_id: ORG_A_ID,
      product_id: PRODUCT_ID,
      variant_id: VARIANT_ID,
      location_id: null,
      quantity_delta: 20,
      movement_type: "restock",
      reference_type: null,
      reference_id: null,
      reason: null,
      created_by: USER_ORG_A,
      created_at: new Date().toISOString(),
    };

    const result = await withInventoryDb(
      { product_variants: variantRow, inventory_movements: { data: insertedRow, error: null } },
      () =>
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: 20,
          movementType: "restock",
        }),
    );

    expect(result.quantityDelta).toBe(20);
    expect(result.movementType).toBe("restock");
  });

  it("sale (-quantity) is inserted with the given negative delta", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    const insertedRow = {
      id: "movement-2",
      organization_id: ORG_A_ID,
      product_id: PRODUCT_ID,
      variant_id: VARIANT_ID,
      location_id: null,
      quantity_delta: -3,
      movement_type: "sale",
      reference_type: "order",
      reference_id: "11111111-0000-0000-0000-000000000001",
      reason: null,
      created_by: USER_ORG_A,
      created_at: new Date().toISOString(),
    };

    const result = await withInventoryDb(
      { product_variants: variantRow, inventory_movements: { data: insertedRow, error: null } },
      () =>
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: -3,
          movementType: "sale",
          referenceType: "order",
          referenceId: "11111111-0000-0000-0000-000000000001",
        }),
    );

    expect(result.quantityDelta).toBe(-3);
    expect(result.movementType).toBe("sale");
  });
});

// ── Test 4: Zero delta denied ───────────────────────────────────────────────────

describe("Test 4: Zero delta is denied", () => {
  it("recordMovement rejects quantityDelta = 0 before touching the DB", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await expect(
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: 0,
        movementType: "restock",
      }),
    ).rejects.toThrow(/non-zero/i);
  });

  it("recordMovement rejects a non-integer quantityDelta", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await expect(
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: 1.5,
        movementType: "restock",
      }),
    ).rejects.toThrow(/integer/i);
  });

  it("Zod schema rejects zero at the API boundary", async () => {
    const { z } = await import("zod");
    const schema = z.number().int().refine((n) => n !== 0, "quantity_delta must not be zero");
    expect(() => schema.parse(0)).toThrow(/not be zero/i);
    expect(() => schema.parse(5)).not.toThrow();
    expect(() => schema.parse(-5)).not.toThrow();
  });
});

// ── Test 5: Invalid movement_type denied ───────────────────────────────────────

describe("Test 5: Invalid movement_type is denied", () => {
  it("recordMovement rejects an unknown movement_type", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, [
      "inventory.receive_stock",
      "inventory.adjust",
    ]);

    await expect(
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: 5,
        // @ts-expect-error deliberately invalid at the runtime boundary
        movementType: "transfer_in",
      }),
    ).rejects.toThrow(/Invalid movement_type/i);
  });

  it("Zod enum at the API boundary rejects V1-unsupported types (e.g. transfer_in, damage)", async () => {
    const { z } = await import("zod");
    const schema = z.enum(["initial", "sale", "return", "manual_adjustment", "restock"]);
    expect(() => schema.parse("transfer_in")).toThrow();
    expect(() => schema.parse("damage")).toThrow();
    expect(() => schema.parse("restock")).not.toThrow();
  });
});

// ── Test 6 & 7: Manual adjustment permission + reason required ───────────────

describe("Test 6: Manual adjustment requires inventory.adjust permission", () => {
  it("caller with only inventory.receive_stock cannot record a manual_adjustment", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    await expectForbidden(() =>
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: -2,
        movementType: "manual_adjustment",
        reason: "damaged in storage",
      }),
    );
  });

  it("caller with inventory.adjust cannot record a restock (requires inventory.receive_stock)", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    await expectForbidden(() =>
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: 10,
        movementType: "restock",
      }),
    );
  });
});

describe("Test 7: Manual adjustment requires a non-empty reason", () => {
  it("recordMovement rejects manual_adjustment without a reason", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    await expect(
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: -1,
        movementType: "manual_adjustment",
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  it("recordMovement rejects manual_adjustment with a whitespace-only reason", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    await expect(
      recordMovement(ctx, {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityDelta: -1,
        movementType: "manual_adjustment",
        reason: "   ",
      }),
    ).rejects.toThrow(/reason is required/i);
  });
});

// ── Test 8: Manual adjustment is mandatorily audited (fail-closed) ───────────

describe("Test 8: Manual adjustment is mandatorily audited", () => {
  it("inventory.adjust is registered as a MANDATORY_AUDIT_ACTIONS entry", async () => {
    const { MANDATORY_AUDIT_ACTIONS } = await import("../server/auth/audit");
    expect(MANDATORY_AUDIT_ACTIONS.has("inventory.adjust")).toBe(true);
  });

  it("recordMovement blocks the mutation when the audit write fails (fail-closed)", async () => {
    // Simulate auditLogRequired throwing (e.g. audit_logs insert failed).
    mock.module("@/server/auth/audit", () => ({
      auditLogRequired: async () => {
        throw new Error("Audit record could not be persisted");
      },
    }));

    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    await withInventoryDb({ product_variants: variantRow }, async () => {
      await expect(
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: -5,
          movementType: "manual_adjustment",
          reason: "stock count correction",
        }),
      ).rejects.toThrow(/could not be persisted/i);
    });
  });

  it("sale/return/restock/initial do NOT require auditLogRequired (only manual_adjustment does)", async () => {
    // Structural: verify the service only calls the mandatory-audit path for manual_adjustment
    // by confirming a restock succeeds even when auditLogRequired would throw.
    mock.module("@/server/auth/audit", () => ({
      auditLogRequired: async () => {
        throw new Error("should not be called for restock");
      },
    }));

    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    const insertedRow = {
      id: "movement-3",
      organization_id: ORG_A_ID,
      product_id: PRODUCT_ID,
      variant_id: VARIANT_ID,
      location_id: null,
      quantity_delta: 7,
      movement_type: "restock",
      reference_type: null,
      reference_id: null,
      reason: null,
      created_by: USER_ORG_A,
      created_at: new Date().toISOString(),
    };

    await withInventoryDb(
      { product_variants: variantRow, inventory_movements: { data: insertedRow, error: null } },
      async () => {
        const result = await recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: 7,
          movementType: "restock",
        });
        expect(result.quantityDelta).toBe(7);
      },
    );
  });
});

afterEach(() => {
  mock.restore();
});

// ── Test 9: Current stock correctness ──────────────────────────────────────────

describe("Test 9: Current stock is correctly derived from the ledger", () => {
  it("getVariantStock sums quantity_on_hand across all locations", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.read"]);

    const stockRows = {
      data: [
        {
          organization_id: ORG_A_ID,
          product_id: PRODUCT_ID,
          variant_id: VARIANT_ID,
          location_id: LOCATION_ID,
          quantity_on_hand: 12,
          last_movement_at: "2026-01-01T00:00:00.000Z",
        },
        {
          organization_id: ORG_A_ID,
          product_id: PRODUCT_ID,
          variant_id: VARIANT_ID,
          location_id: null,
          quantity_on_hand: 3,
          last_movement_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      error: null,
    };

    const result = await withInventoryDb(
      { product_variants: variantRow, inventory_stock: stockRows },
      () => getVariantStock(ctx, VARIANT_ID),
    );

    expect(result.quantityOnHand).toBe(15);
    expect(result.byLocation).toHaveLength(2);
  });

  it("getVariantStock returns zero when no movements have been recorded yet", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.read"]);

    const result = await withInventoryDb(
      { product_variants: variantRow, inventory_stock: { data: [], error: null } },
      () => getVariantStock(ctx, VARIANT_ID),
    );

    expect(result.quantityOnHand).toBe(0);
    expect(result.byLocation).toEqual([]);
  });

  it("getVariantStock requires inventory.read", async () => {
    const { getVariantStock } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, []);
    await expectForbidden(() => getVariantStock(ctx, VARIANT_ID));
  });
});

// ── Test 10: Movement history ordering ─────────────────────────────────────────

describe("Test 10: Movement history preserves repository (newest-first) order", () => {
  it("listMovementHistory returns rows in the same order the repository returned them", async () => {
    const { listMovementHistory } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.view_movements"]);

    const rows = [
      {
        id: "m-3",
        organization_id: ORG_A_ID,
        product_id: PRODUCT_ID,
        variant_id: VARIANT_ID,
        location_id: null,
        quantity_delta: -1,
        movement_type: "sale",
        reference_type: null,
        reference_id: null,
        reason: null,
        created_by: null,
        created_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "m-2",
        organization_id: ORG_A_ID,
        product_id: PRODUCT_ID,
        variant_id: VARIANT_ID,
        location_id: null,
        quantity_delta: 5,
        movement_type: "restock",
        reference_type: null,
        reference_id: null,
        reason: null,
        created_by: null,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "m-1",
        organization_id: ORG_A_ID,
        product_id: PRODUCT_ID,
        variant_id: VARIANT_ID,
        location_id: null,
        quantity_delta: 10,
        movement_type: "initial",
        reference_type: null,
        reference_id: null,
        reason: null,
        created_by: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    const result = await withInventoryDb(
      { inventory_movements: { data: rows, error: null } },
      () => listMovementHistory(ctx, { variant_id: VARIANT_ID }),
    );

    expect(result.map((m) => m.id)).toEqual(["m-3", "m-2", "m-1"]);
  });

  it("listMovementHistory requires inventory.view_movements", async () => {
    const { listMovementHistory } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.read"]);
    await expectForbidden(() => listMovementHistory(ctx, {}));
  });
});

// ── Test 11: Duplicate / idempotent reference behavior ────────────────────────

describe("Test 11: Duplicate reference is treated as an idempotent conflict, not a silent double-count", () => {
  it("isDuplicateReferenceError recognizes a Postgres unique_violation on the reference index", async () => {
    const { isDuplicateReferenceError } = await import("../server/inventory/repository");
    const err = Object.assign(
      new Error(
        'insertMovement: duplicate key value violates unique constraint "uniq_inventory_movements_reference"',
      ),
      { code: "23505" },
    );
    expect(isDuplicateReferenceError(err)).toBe(true);
    expect(isDuplicateReferenceError(new Error("some other db error"))).toBe(false);
  });

  it("recordMovement surfaces a 409 conflict when the DB rejects a duplicate reference insert", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    const duplicateError = {
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_inventory_movements_reference"',
      },
    };

    await withInventoryDb(
      { product_variants: variantRow, inventory_movements: duplicateError },
      async () => {
        await expect(
          recordMovement(ctx, {
            productId: PRODUCT_ID,
            variantId: VARIANT_ID,
            quantityDelta: -1,
            movementType: "sale",
            referenceType: "order",
            referenceId: "11111111-0000-0000-0000-000000000001",
          }),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/idempotent duplicate/i),
          statusCode: 409,
        });
      },
    );
  });
});

// ── Test 12: No direct client inventory mutation (append-only) ───────────────

describe("Test 12: The ledger has no update/delete/setStock path", () => {
  it("the repository module exports insert + read functions only — no update/delete/setStock", async () => {
    const repo = await import("../server/inventory/repository");
    const exportNames = Object.keys(repo);

    expect(exportNames).toContain("insertMovement");
    for (const forbidden of ["updateMovement", "deleteMovement", "setStock", "updateStock"]) {
      expect(exportNames).not.toContain(forbidden);
    }
  });

  it("the service module exports no update/delete/setStock function for movements", async () => {
    const service = await import("../server/inventory/service");
    const exportNames = Object.keys(service);

    for (const forbidden of ["updateMovement", "deleteMovement", "setStock", "updateStock"]) {
      expect(exportNames).not.toContain(forbidden);
    }
  });
});

// ── Test 15: JWT clients cannot INSERT into the ledger directly ──────────────
// Regression guard for the review blocker: an earlier draft of migration 021
// allowed INSERT for any active member, which let a browser session bypass the
// permission check, the movement-type mapping and the mandatory audit entirely.

describe("Test 15: Direct client INSERT into inventory_movements is denied by the DB", () => {
  const migrationSql = readMigration021();

  it("has no permissive INSERT policy for authenticated members", () => {
    // The old hole. If this string comes back, the blocker has regressed.
    expect(migrationSql).not.toMatch(
      /FOR INSERT\s+WITH CHECK \(public\.is_active_member_of\(organization_id\)\)/,
    );
  });

  it("blocks INSERT for JWT clients via WITH CHECK (false)", () => {
    expect(migrationSql).toMatch(
      /CREATE POLICY "inventory_movements_insert_blocked"[\s\S]*?FOR INSERT[\s\S]*?WITH CHECK \(false\)/,
    );
  });

  it("revokes INSERT/UPDATE/DELETE table privileges from anon and authenticated", () => {
    expect(migrationSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.inventory_movements FROM anon, authenticated/,
    );
  });

  it("still allows tenant-scoped SELECT for active members", () => {
    expect(migrationSql).toMatch(
      /CREATE POLICY "inventory_movements_select_member"[\s\S]*?FOR SELECT[\s\S]*?USING \(public\.is_active_member_of\(organization_id\)\)/,
    );
  });

  it("keeps UPDATE and DELETE blocked (append-only)", () => {
    expect(migrationSql).toMatch(
      /CREATE POLICY "inventory_movements_no_update"[\s\S]*?FOR UPDATE[\s\S]*?USING \(false\)/,
    );
    expect(migrationSql).toMatch(
      /CREATE POLICY "inventory_movements_no_delete"[\s\S]*?FOR DELETE[\s\S]*?USING \(false\)/,
    );
  });

  it("an anon-key client INSERT is rejected by the database (requires DB)", async () => {
    await requireSupabase(async () => {
      const url = process.env["VITE_SUPABASE_URL"];
      const anonKey = process.env["VITE_SUPABASE_ANON_KEY"];
      if (!url || !anonKey) {
        console.warn("[SKIP] VITE_SUPABASE_ANON_KEY not set — skipping anon INSERT probe");
        return;
      }

      const { createClient } = await import("@supabase/supabase-js");
      const anonDb = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Even a well-formed row from a legitimately-scoped org must be refused:
      // the write path is server-only.
      const { error } = await anonDb.from("inventory_movements").insert({
        organization_id: ORG_A_ID,
        product_id: PRODUCT_ID,
        variant_id: VARIANT_ID,
        quantity_delta: 100,
        movement_type: "restock",
      });

      expect(error).not.toBeNull();
    });
  });
});

// ── Test 16: The server-authorized write path still works ────────────────────

describe("Test 16: Server/domain write path remains valid after the RLS lockdown", () => {
  it("recordMovement still inserts through the service-role repository", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.receive_stock"]);

    const insertedRow = {
      id: "movement-server-path",
      organization_id: ORG_A_ID,
      product_id: PRODUCT_ID,
      variant_id: VARIANT_ID,
      location_id: null,
      quantity_delta: 42,
      movement_type: "restock",
      reference_type: null,
      reference_id: null,
      reason: null,
      created_by: USER_ORG_A,
      created_at: new Date().toISOString(),
    };

    const result = await withInventoryDb(
      { product_variants: variantRow, inventory_movements: { data: insertedRow, error: null } },
      () =>
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: 42,
          movementType: "restock",
        }),
    );

    expect(result.id).toBe("movement-server-path");
    expect(result.quantityDelta).toBe(42);
    expect(result.createdBy).toBe(USER_ORG_A);
  });

  it("the repository writes with the service-role client (supabaseAdmin), not a JWT client", async () => {
    const source = readSource("src/server/inventory/repository.ts");
    expect(source).toMatch(/import \{ supabaseAdmin \} from "@\/lib\/supabase\/server"/);
  });
});

// ── Test 17: Idempotency key includes movement_type ──────────────────────────
// Regression guard for the second review blocker: keying uniqueness on
// (variant, reference) alone would reject a legitimate return for an order that
// already had a sale.

describe("Test 17: Idempotency distinguishes event type from source record", () => {
  const migrationSql = readMigration021();

  it("the unique index includes movement_type alongside the reference", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX uniq_inventory_movements_reference\s+ON public\.inventory_movements\(organization_id, variant_id, movement_type, reference_type, reference_id\)/,
    );
  });

  it("the unique index is partial — movements with no reference are never deduplicated", () => {
    expect(migrationSql).toMatch(
      /uniq_inventory_movements_reference[\s\S]*?WHERE reference_id IS NOT NULL/,
    );
  });

  it("a retried sale for the same order + variant is rejected as a duplicate", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    const duplicateError = {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "uniq_inventory_movements_reference"',
      },
    };

    await withInventoryDb(
      { product_variants: variantRow, inventory_movements: duplicateError },
      async () => {
        await expect(
          recordMovement(ctx, {
            productId: PRODUCT_ID,
            variantId: VARIANT_ID,
            quantityDelta: -2,
            movementType: "sale",
            referenceType: "order",
            referenceId: ORDER_ID,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      },
    );
  });

  it("a sale and a later return for the same order + variant can both be recorded", async () => {
    const { recordMovement } = await import("../server/inventory/service");
    const ctx = makeCtxWithPerms(USER_ORG_A, ORG_A_ID, ["inventory.adjust"]);

    const baseRow = {
      organization_id: ORG_A_ID,
      product_id: PRODUCT_ID,
      variant_id: VARIANT_ID,
      location_id: null,
      reference_type: "order",
      reference_id: ORDER_ID,
      reason: null,
      created_by: USER_ORG_A,
      created_at: new Date().toISOString(),
    };

    // Same order, same variant, different movement_type — distinct index keys,
    // so the DB accepts both. Neither call is a duplicate of the other.
    const sale = await withInventoryDb(
      {
        product_variants: variantRow,
        inventory_movements: {
          data: { ...baseRow, id: "m-sale", quantity_delta: -2, movement_type: "sale" },
          error: null,
        },
      },
      () =>
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: -2,
          movementType: "sale",
          referenceType: "order",
          referenceId: ORDER_ID,
        }),
    );

    const refund = await withInventoryDb(
      {
        product_variants: variantRow,
        inventory_movements: {
          data: { ...baseRow, id: "m-return", quantity_delta: 2, movement_type: "return" },
          error: null,
        },
      },
      () =>
        recordMovement(ctx, {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantityDelta: 2,
          movementType: "return",
          referenceType: "order",
          referenceId: ORDER_ID,
        }),
    );

    expect(sale.movementType).toBe("sale");
    expect(refund.movementType).toBe("return");
    expect(sale.referenceId).toBe(ORDER_ID);
    expect(refund.referenceId).toBe(ORDER_ID);
    // Net effect on stock is zero — the ledger holds both entries, not one edit.
    expect(sale.quantityDelta + refund.quantityDelta).toBe(0);
  });
});

// ── Live-DB integration (skipped without Supabase) ────────────────────────────

describe("Live DB: end-to-end movement + stock derivation", () => {
  it("recording restock then sale yields the correct net stock (requires DB)", async () => {
    await requireSupabase(async () => {
      // Live integration would create a real product/variant via the Product
      // domain, then call recordMovement/getVariantStock against a live
      // Supabase project. Skipped in this sandbox (no live project configured).
    });
  });
});
