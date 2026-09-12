/**
 * Product Catalog UI — focused tests for /app/products and /app/products/$id.
 *
 * What is covered, and why each one exists:
 *
 *   A. Capability visibility — every gate this UI exposes, in every state of
 *      the capability snapshot (pending / denied / ready).
 *   B. Server denial survives the UI — the service refuses each action for a
 *      member without the key, whatever the browser chose to render.
 *   C. Cross-organization ids — a product/variant/category UUID from another
 *      organization reads as not-found and mutates nothing.
 *   D. Cost withholding — the browser never reconstructs a cost the server
 *      withheld, and never sends one it cannot see.
 *   K. Cost isolation across a sign-out/sign-in into a different member of the
 *      same organization (cache partitioning by userId+organizationId).
 *   L. Cost masking for the SAME member of the SAME organization losing
 *      products.view_cost mid-session — cache partitioning alone cannot catch
 *      this since the key never changes, so every cost-rendering surface must
 *      mask through visibleVariantCost() off the CURRENT capability state.
 *   M. Cost masking when the capability snapshot is retained but UNCONFIRMED
 *      (background refresh rejected). can() tolerates that for navigation;
 *      cost must not, so both product screens gate cost on canSensitive().
 *   E. Duplicate SKU / barcode — the 409 reaches the merchant as its own
 *      message, not a generic failure.
 *   F. Archive — archive, never delete; confirmation before it happens.
 *   G. Money — minor units parsed with integer arithmetic only.
 *   H. Khmer/English parity for every new catalog string.
 *   I. No production mock/fallback path in the catalog data layer.
 *   J. No browser-boundary regression — no server-only import reachable from
 *      the new routes or components.
 *
 * Run: bun test src/tests/product-catalog-ui.test.ts
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
  UNRESOLVED_CAPABILITIES,
  type UiPermissionKey,
} from "../lib/capabilities";
import {
  CATALOG_PAGE_LIMIT,
  CATALOG_QUERY_ROOT,
  catalogErrorKey,
  catalogKeys,
  categoryLabel,
  classifyCatalogError,
  clearCatalogQueries,
  enforceCatalogCachePrincipal,
  formatMinorUnitsForInput,
  isCatalogId,
  parseMinorUnits,
  productLeadPrice,
  searchLoadedProducts,
  variantFieldAccess,
  visibleVariantCost,
  type CatalogProduct,
  type CatalogVariant,
  type VariantPermissions,
} from "../lib/catalog";

const ROOT = process.cwd();
const read = (rel: string): string => {
  const abs = path.resolve(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
};

const LIST_ROUTE = "src/routes/app.products.tsx";
const DETAIL_ROUTE = "src/routes/app.products.$id.tsx";
const CATALOG_LIB = "src/lib/catalog.ts";
const PRODUCT_COMPONENTS = [
  "src/components/products/CreateProductSheet.tsx",
  "src/components/products/VariantSheet.tsx",
  "src/components/products/CategorySheet.tsx",
  "src/components/products/CategoryChoice.tsx",
  "src/components/products/MoneyAmountField.tsx",
];

/** The eight product keys this phase added to the UI vocabulary. */
const PRODUCT_KEYS: UiPermissionKey[] = [
  "products.read",
  "products.create",
  "products.update_basic",
  "products.update_price",
  "products.update_cost",
  "products.view_cost",
  "products.archive",
  "products.manage_categories",
];

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "11111111-0000-0000-0000-000000000001";
/** A second member of Org A — same organization as USER_A, different account. */
const USER_B = "22222222-0000-0000-0000-000000000002";
const PRODUCT_A = "cccccccc-0000-0000-0000-0000000000a1";
/** A real row that belongs to Org B. Org A must never reach it. */
const PRODUCT_B = "dddddddd-0000-0000-0000-0000000000b1";
const VARIANT_B = "eeeeeeee-0000-0000-0000-0000000000b2";
const CATEGORY_B = "ffffffff-0000-0000-0000-0000000000b3";

function ctxWith(permissions: string[], organizationId = ORG_A): AuthCtxType {
  const granted = new Set<string>(permissions);
  return {
    userId: USER_A,
    organizationId,
    roleId: "role-test",
    systemRole: "MANAGER",
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

// ── A fake, organization-scoped database ──────────────────────────────────────
//
// Rows carry an organization_id; every `.eq()` in the repository is applied as
// a real filter, so a query scoped to Org A simply cannot see an Org B row —
// the same outcome the live WHERE organization_id = $1 produces. Writes are
// recorded so a cross-tenant attempt can be shown to have changed nothing.

type FakeRow = Record<string, unknown>;

interface FakeDb {
  from: (table: string) => unknown;
  writes: string[];
}

function makeOrgScopedDb(tables: Record<string, FakeRow[]>): FakeDb {
  const writes: string[] = [];

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: FakeRow | null = null;
    let pendingInsert: FakeRow | null = null;

    const matched = (): FakeRow[] =>
      (tables[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));

    const settle = () => {
      if (pendingInsert) {
        const inserted = { id: "generated-id", ...pendingInsert };
        (tables[table] ??= []).push(inserted);
        writes.push(`insert:${table}`);
        return { data: inserted, error: null };
      }
      const rows = matched();
      if (pendingUpdate) {
        // An UPDATE ... WHERE that matches nothing writes nothing. That is the
        // whole point of the cross-organization cases below.
        if (rows.length === 0) {
          return { data: null, error: { code: "PGRST116", message: "The result contains 0 rows" } };
        }
        for (const row of rows) Object.assign(row, pendingUpdate);
        writes.push(`update:${table}`);
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    };

    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      in: (col: string, values: unknown[]) => {
        filters.push([col, values[0]]);
        return query;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return query;
      },
      update: (patch: FakeRow) => {
        pendingUpdate = patch;
        return query;
      },
      insert: (row: FakeRow) => {
        pendingInsert = row;
        return query;
      },
      single: async () => {
        const result = settle();
        if (result.error) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        if (!data) {
          return { data: null, error: { code: "PGRST116", message: "The result contains 0 rows" } };
        }
        return { data, error: null };
      },
      maybeSingle: async () => {
        const result = settle();
        if (result.error) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      },
      // List queries are awaited directly.
      then: (resolve: (value: unknown) => unknown) => {
        const result = settle();
        return Promise.resolve(
          result.error ? result : { data: Array.isArray(result.data) ? result.data : [] },
        ).then(resolve);
      },
    });

    return query;
  }

  return { from, writes };
}

async function withDb<T>(db: FakeDb, fn: () => Promise<T>): Promise<T> {
  const { setProductRepositoryDbForTests } = await import("../server/products/repository");
  const restore = setProductRepositoryDbForTests(db);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function orgBFixture(): FakeDb {
  return makeOrgScopedDb({
    products: [
      {
        id: PRODUCT_B,
        organization_id: ORG_B,
        workspace_id: null,
        name_km: "ទំនិញរបស់អង្គភាព ខ",
        name_en: null,
        description_km: null,
        description_en: null,
        category_id: null,
        status: "ACTIVE",
        created_by: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    product_variants: [
      {
        id: VARIANT_B,
        organization_id: ORG_B,
        product_id: PRODUCT_B,
        sku: "ORGB-1",
        barcode: "9999",
        name: "",
        price_amount: 1500,
        price_currency: "USD",
        cost_amount: 900,
        cost_currency: "USD",
        weight_grams: null,
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    product_categories: [
      {
        id: CATEGORY_B,
        organization_id: ORG_B,
        parent_id: null,
        name_km: "ប្រភេទរបស់អង្គភាព ខ",
        name_en: null,
        sort_order: 0,
        status: "ACTIVE",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
}

// ── A. Capability visibility, in every state ──────────────────────────────────

describe("A. capability visibility states", () => {
  it("every product key this UI consults is in the declared UI vocabulary", () => {
    for (const key of PRODUCT_KEYS) {
      expect(UI_PERMISSION_KEYS).toContain(key);
    }
  });

  it("a pending snapshot offers nothing", () => {
    for (const key of PRODUCT_KEYS) {
      expect(UNRESOLVED_CAPABILITIES.can(key)).toBe(false);
    }
    expect(UNRESOLVED_CAPABILITIES.state).toBe("pending");
  });

  it("a denied snapshot offers nothing", () => {
    const denied = createCapabilityView({
      result: { status: "no_membership" },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    expect(denied.state).toBe("denied");
    for (const key of PRODUCT_KEYS) expect(denied.can(key)).toBe(false);
  });

  it("an unresolvable snapshot offers nothing and says only that it is unavailable", () => {
    const unavailable = createCapabilityView({
      result: undefined,
      isPending: false,
      isError: true,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    expect(unavailable.reason).toBe("unavailable");
    for (const key of PRODUCT_KEYS) expect(unavailable.can(key)).toBe(false);
  });

  it("a snapshot for another organization grants nothing, even with the keys in it", () => {
    const mismatched = createCapabilityView({
      result: {
        status: "active",
        userId: USER_A,
        organizationId: ORG_B,
        role: "OWNER",
        permissions: PRODUCT_KEYS,
      },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    expect(mismatched.state).toBe("denied");
    for (const key of PRODUCT_KEYS) expect(mismatched.can(key)).toBe(false);
  });

  it("each key is granted on its own and grants no other", () => {
    for (const key of PRODUCT_KEYS) {
      const view = createFixtureCapabilityView([key]);
      expect(view.can(key)).toBe(true);
      for (const other of PRODUCT_KEYS) {
        if (other !== key) expect(view.can(other)).toBe(false);
      }
    }
  });
});

describe("A2. each gated surface names the key its server function requires", () => {
  /*
   * `reader` records WHICH capability reader the surface uses, and it is part
   * of the contract, not an implementation detail: cost is the one thing on
   * these screens whose display is itself a disclosure, so it reads through
   * the narrowed canSensitive() (false whenever the snapshot is unconfirmed —
   * see section M). Everything else keeps the ordinary stale-tolerant can().
   */
  const surfaces: Array<{
    name: string;
    file: string;
    key: string;
    reader: "can" | "canSensitive";
  }> = [
    { name: "product list", file: LIST_ROUTE, key: "products.read", reader: "can" },
    { name: "add product", file: LIST_ROUTE, key: "products.create", reader: "can" },
    {
      name: "category management",
      file: LIST_ROUTE,
      key: "products.manage_categories",
      reader: "can",
    },
    {
      name: "initial cost entry",
      file: LIST_ROUTE,
      key: "products.update_cost",
      reader: "canSensitive",
    },
    { name: "product detail", file: DETAIL_ROUTE, key: "products.read", reader: "can" },
    {
      name: "edit product basics",
      file: DETAIL_ROUTE,
      key: "products.update_basic",
      reader: "can",
    },
    { name: "price controls", file: DETAIL_ROUTE, key: "products.update_price", reader: "can" },
    {
      name: "cost controls",
      file: DETAIL_ROUTE,
      key: "products.update_cost",
      reader: "canSensitive",
    },
    {
      name: "cost visibility",
      file: DETAIL_ROUTE,
      key: "products.view_cost",
      reader: "canSensitive",
    },
    { name: "archive product", file: DETAIL_ROUTE, key: "products.archive", reader: "can" },
  ];

  const serverSource = read("src/server/products/service.ts");

  for (const surface of surfaces) {
    it(`${surface.name} gates on ${surface.key} via ${surface.reader}(), which the service enforces`, () => {
      expect(read(surface.file)).toContain(`capabilities.${surface.reader}("${surface.key}")`);
      expect(serverSource).toContain(`"${surface.key}"`);
    });
  }

  it("every cost key is read through canSensitive, and no other key is", () => {
    for (const surface of surfaces) {
      const isCostKey =
        surface.key === "products.view_cost" || surface.key === "products.update_cost";
      expect(`${surface.key}:${surface.reader}`).toBe(
        `${surface.key}:${isCostKey ? "canSensitive" : "can"}`,
      );
    }
  });

  it("both screens read capabilities from the one shared hook", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(read(file)).toContain('from "@/hooks/use-capabilities"');
      expect(read(file)).toContain("useCapabilities()");
    }
  });

  it("neither screen builds its own role matrix", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
      const source = read(file);
      expect(source).not.toMatch(/\b(OWNER|MANAGER|CASHIER)\b\s*[:=]/);
      expect(source).not.toMatch(/permissionsFor|currentRole/);
    }
  });

  it("the list does not fetch the catalogue it is not allowed to show", () => {
    expect(read(LIST_ROUTE)).toContain("enabled: !detailOpen && canReadProducts");
  });

  it("the detail screen does not fetch a product it is not allowed to show", () => {
    expect(read(DETAIL_ROUTE)).toContain("enabled: canReadProducts && idLooksValid");
  });

  it("the denied branch returns before the search box and the filters render", () => {
    const source = read(LIST_ROUTE);
    const deniedIdx = source.indexOf("<CapabilityDeniedState");
    const searchIdx = source.indexOf("catalog.list.searchPlaceholder");
    expect(deniedIdx).toBeGreaterThan(-1);
    expect(deniedIdx).toBeLessThan(searchIdx);
  });

  it("the create and category sheets are not even mounted without their key", () => {
    const source = read(LIST_ROUTE);
    expect(source).toContain("{canCreateProduct ? (\n        <CreateProductSheet");
    expect(source).toContain("{canManageCategories ? (\n        <CategorySheet");
  });
});

describe("A3. variant form fields follow the keys the server checks", () => {
  const none: VariantPermissions = {
    canCreate: false,
    canUpdateBasic: false,
    canUpdatePrice: false,
    canUpdateCost: false,
    canViewCost: false,
  };

  it("creating needs products.create for every field, price included", () => {
    const access = variantFieldAccess({ ...none, canCreate: true }, false);
    expect(access.basicEditable).toBe(true);
    expect(access.priceEditable).toBe(true);
  });

  /*
   * Creation is not subject to the update_basic requirement below — createVariant
   * requires only products.create per field (src/server/products/service.ts) —
   * so the cost-only combination that is refused on edit is accepted on create.
   */
  it("creating can set a cost with only view_cost + update_cost — no update_basic needed", () => {
    const access = variantFieldAccess(
      { ...none, canCreate: true, canUpdateCost: true, canViewCost: true },
      false,
    );
    expect(access.costEditable).toBe(true);
  });

  it("a member with no keys is offered no editable field", () => {
    for (const isEdit of [true, false]) {
      const access = variantFieldAccess(none, isEdit);
      expect(access.basicEditable).toBe(false);
      expect(access.priceEditable).toBe(false);
      expect(access.costVisible).toBe(false);
      expect(access.costEditable).toBe(false);
    }
  });

  it("editing basics does not unlock price", () => {
    const access = variantFieldAccess({ ...none, canUpdateBasic: true }, true);
    expect(access.basicEditable).toBe(true);
    expect(access.priceEditable).toBe(false);
  });

  it("price editing does not unlock basics or cost", () => {
    const access = variantFieldAccess({ ...none, canUpdatePrice: true }, true);
    expect(access.priceEditable).toBe(true);
    expect(access.basicEditable).toBe(false);
    expect(access.costEditable).toBe(false);
  });

  /*
   * Blocker #2 (independent review): updateVariant's own authorization
   * (src/server/products/service.ts) requires products.update_basic for any
   * patch that is not a price change — which every cost-only edit is. The
   * view_cost + update_cost combination alone used to render an editable
   * cost-save action that the server would refuse every time. It must not.
   */
  it("cost cannot be edited without also being visible", () => {
    const blind = variantFieldAccess({ ...none, canUpdateCost: true, canUpdateBasic: true }, true);
    expect(blind.costVisible).toBe(false);
    expect(blind.costEditable).toBe(false);
  });

  it("seeing a cost does not let it be changed", () => {
    const access = variantFieldAccess({ ...none, canViewCost: true, canUpdateBasic: true }, true);
    expect(access.costVisible).toBe(true);
    expect(access.costEditable).toBe(false);
  });

  it("view_cost + update_cost alone — WITHOUT update_basic — cannot edit cost on an existing variant", () => {
    const access = variantFieldAccess({ ...none, canUpdateCost: true, canViewCost: true }, true);
    expect(access.costVisible).toBe(true);
    // The value is visible (read-only) but the action the old UI offered here
    // would always have been rejected by the server. It must not be offered.
    expect(access.costEditable).toBe(false);
  });

  it("the fully permitted combination — view_cost + update_cost + update_basic — can edit cost", () => {
    const access = variantFieldAccess(
      { ...none, canUpdateCost: true, canViewCost: true, canUpdateBasic: true },
      true,
    );
    expect(access.costVisible).toBe(true);
    expect(access.costEditable).toBe(true);
  });

  it("update_basic alone, without update_cost, still cannot edit cost", () => {
    const access = variantFieldAccess({ ...none, canUpdateBasic: true, canViewCost: true }, true);
    expect(access.costEditable).toBe(false);
  });
});

// ── B. Server denial survives whatever the UI rendered ────────────────────────

describe("B. the server refuses every catalog action the UI could have offered", () => {
  it("reading the catalogue requires products.read", async () => {
    const { getProductCatalog, getProductDetail } = await import("../server/products/service");
    await expectForbidden(() => getProductCatalog(ctxWith([])));
    await expectForbidden(() => getProductDetail(ctxWith([]), PRODUCT_A));
  });

  it("creating a product requires products.create", async () => {
    const { createProduct } = await import("../server/products/service");
    await expectForbidden(() =>
      createProduct(ctxWith(["products.read"]), {
        name_km: "ទំនិញ",
        initialVariant: { price_amount: 1000, price_currency: "USD" },
      }),
    );
  });

  it("editing basics requires products.update_basic", async () => {
    const { updateProduct } = await import("../server/products/service");
    await expectForbidden(() =>
      updateProduct(ctxWith(["products.read"]), PRODUCT_A, { name_km: "ថ្មី" }),
    );
  });

  it("changing a price requires products.update_price, not update_basic", async () => {
    const { updateVariant } = await import("../server/products/service");
    await expectForbidden(() =>
      updateVariant(ctxWith(["products.read", "products.update_basic"]), VARIANT_B, {
        price_amount: 2500,
      }),
    );
  });

  it("changing a cost requires products.update_cost", async () => {
    const { updateVariant } = await import("../server/products/service");
    await expectForbidden(() =>
      updateVariant(
        ctxWith(["products.read", "products.update_basic", "products.view_cost"]),
        VARIANT_B,
        { cost_amount: 100 },
      ),
    );
  });

  /*
   * Blocker #2 (independent review): this is precisely the combination the
   * old UI would have offered an editable cost-save action for — view_cost +
   * update_cost, missing update_basic. The fixed UI now hides that action
   * (see A3 above), but a bypass — devtools, a stale client, a direct call —
   * must still be refused server-side. It always was; this pins it so it
   * cannot regress silently alongside the UI fix.
   */
  it("bypassing the UI: view_cost + update_cost WITHOUT update_basic is still refused server-side", async () => {
    const { updateVariant } = await import("../server/products/service");
    await expectForbidden(() =>
      updateVariant(
        ctxWith(["products.read", "products.view_cost", "products.update_cost"]),
        VARIANT_B,
        { cost_amount: 100, cost_currency: "USD" },
      ),
    );
  });

  it("the fully permitted combination succeeds, proving the refusal above is about the missing key, not the request shape", async () => {
    const db = orgBFixture();
    const { updateVariant } = await import("../server/products/service");
    await withDb(db, async () => {
      const updated = await updateVariant(
        ctxWith(
          ["products.read", "products.view_cost", "products.update_cost", "products.update_basic"],
          ORG_B,
        ),
        VARIANT_B,
        { cost_amount: 1234, cost_currency: "USD" },
      );
      expect(updated.cost).toEqual({ amount: 1234, currency: "USD" });
    });
  });

  it("archiving requires products.archive", async () => {
    const { archiveProduct } = await import("../server/products/service");
    await expectForbidden(() =>
      archiveProduct(ctxWith(["products.read", "products.update_basic"]), PRODUCT_A),
    );
  });

  it("managing categories requires products.manage_categories", async () => {
    const { createCategory, updateCategory } = await import("../server/products/service");
    await expectForbidden(() =>
      createCategory(ctxWith(["products.read", "products.create"]), { name_km: "ប្រភេទ" }),
    );
    await expectForbidden(() =>
      updateCategory(ctxWith(["products.read", "products.create"]), CATEGORY_B, {
        status: "ARCHIVED",
      }),
    );
  });

  it("the browser never supplies the organization — the API resolves it from membership", () => {
    const apiSource = read("src/api/products.ts");
    expect(apiSource).toContain("resolveAuthContext");
    // No handler accepts an organization id from the request body.
    expect(apiSource).not.toMatch(/organization_id:\s*z\./);
    // And the catalog client never tries to send one.
    expect(read(CATALOG_LIB)).not.toContain("organization_id");
  });
});

// ── C. Cross-organization ids ─────────────────────────────────────────────────

describe("C. a product, variant or category id from another organization", () => {
  it("reads as not found, and the Org B row is untouched", async () => {
    const db = orgBFixture();
    const { getProductDetail } = await import("../server/products/service");
    await withDb(db, async () => {
      await expect(getProductDetail(ctxWith(["products.read"]), PRODUCT_B)).rejects.toThrow(
        "Product not found",
      );
    });
    expect(db.writes).toEqual([]);
  });

  it("does not appear in the caller's own catalogue list", async () => {
    const db = orgBFixture();
    const { getProductCatalog } = await import("../server/products/service");
    await withDb(db, async () => {
      const rows = await getProductCatalog(ctxWith(["products.read"]));
      expect(rows).toEqual([]);
    });
  });

  it("cannot be edited — not found, and nothing is written", async () => {
    const db = orgBFixture();
    const { updateProduct } = await import("../server/products/service");
    await withDb(db, async () => {
      await expect(
        updateProduct(ctxWith(["products.read", "products.update_basic"]), PRODUCT_B, {
          name_km: "ប្ដូរឈ្មោះ",
        }),
      ).rejects.toThrow("Product not found");
    });
    expect(db.writes).toEqual([]);
  });

  it("cannot be archived — the call fails, nothing is written, nothing is revealed", async () => {
    const db = orgBFixture();
    const { archiveProduct } = await import("../server/products/service");

    /*
     * archiveProduct's UPDATE ... WHERE organization_id = <caller's org> matches
     * no row, so PostgREST's .single() answers PGRST116 and repo.updateProduct
     * raises it rather than returning null (unlike findProductById, which maps
     * that code to null). The merchant-facing outcome is still correct and safe
     * — the action fails, the Org B row is untouched, and the message names no
     * organization, product or field — but it classifies as a generic failure
     * instead of the cleaner "not found" the read path gives. Pinned here so
     * the safety is guaranteed and the rough edge is visible.
     */
    await withDb(db, async () => {
      const failure = await archiveProduct(
        ctxWith(["products.read", "products.archive"]),
        PRODUCT_B,
      ).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).not.toContain(ORG_B);
      expect(failure!.message).not.toContain(PRODUCT_B);
      expect(failure!.message).not.toContain("ទំនិញរបស់អង្គភាព ខ");
      expect(classifyCatalogError(failure)).toBe("generic");
    });

    expect(db.writes).toEqual([]);
  });

  it("a variant from another organization cannot be patched", async () => {
    const db = orgBFixture();
    const { updateVariant } = await import("../server/products/service");
    await withDb(db, async () => {
      await expect(
        updateVariant(ctxWith(["products.read", "products.update_basic"]), VARIANT_B, {
          name: "ប្ដូរ",
        }),
      ).rejects.toThrow("Variant not found");
    });
    expect(db.writes).toEqual([]);
  });

  it("a category from another organization cannot be patched", async () => {
    const db = orgBFixture();
    const { updateCategory } = await import("../server/products/service");
    await withDb(db, async () => {
      await expect(
        updateCategory(ctxWith(["products.manage_categories"]), CATEGORY_B, {
          status: "ARCHIVED",
        }),
      ).rejects.toThrow("Category not found");
    });
    expect(db.writes).toEqual([]);
  });

  it("the same ids resolve normally for the organization that owns them", async () => {
    const db = orgBFixture();
    const { getProductDetail } = await import("../server/products/service");
    await withDb(db, async () => {
      const product = await getProductDetail(ctxWith(["products.read"], ORG_B), PRODUCT_B);
      expect(product.id).toBe(PRODUCT_B);
      expect(product.organizationId).toBe(ORG_B);
    });
  });

  it("the detail screen answers a malformed id itself instead of guessing", () => {
    expect(isCatalogId(PRODUCT_B)).toBe(true);
    expect(isCatalogId("prd-1")).toBe(false);
    expect(isCatalogId("")).toBe(false);
    expect(read(DETAIL_ROUTE)).toContain("isCatalogId(id)");
  });

  it("catalog cache keys are partitioned by organization AND by user", () => {
    // Same user, different organization.
    expect(catalogKeys.products(USER_A, ORG_A, "ACTIVE", null)).not.toEqual(
      catalogKeys.products(USER_A, ORG_B, "ACTIVE", null),
    );
    // Different user, SAME organization — the exact shape blocker #1 fixed.
    expect(catalogKeys.products(USER_A, ORG_A, "ACTIVE", null)).not.toEqual(
      catalogKeys.products(USER_B, ORG_A, "ACTIVE", null),
    );
    expect(catalogKeys.product(USER_A, ORG_A, PRODUCT_A)).not.toEqual(
      catalogKeys.product(USER_B, ORG_A, PRODUCT_A),
    );
    expect(catalogKeys.categories(USER_A, ORG_A)).not.toEqual(
      catalogKeys.categories(USER_B, ORG_A),
    );
  });

  it("both screens derive catalog identity from the server-derived route context, not the capability snapshot", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      const source = read(file);
      expect(source).toContain("Route.useRouteContext()");
      expect(source).toContain("session.userId");
      expect(source).toContain("enforceCatalogCachePrincipal(");
      // The pre-fix fallback — an organization-only, placeholder-keyed read —
      // is gone from the actual code (comments are allowed to describe it).
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/organizationId\s*\?\?\s*["']unresolved["']/);
      expect(source).toContain("catalogKeys.categories(userId, organizationId");
    }
    expect(read(LIST_ROUTE)).toContain("catalogKeys.products(userId, organizationId");
    expect(read(DETAIL_ROUTE)).toContain("catalogKeys.product(userId, organizationId");
  });

  it("both screens fail closed when the route identity is incomplete or diverges from the capability snapshot", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      const source = read(file);
      expect(source).toContain("identityOk");
      expect(source).toContain("capabilities.organizationId === routeOrganizationId");
      // Every permission this screen offers is gated behind identityOk — a
      // mismatched or incomplete identity turns every one of them off.
      expect(source).toContain("identityOk && capabilities.can(");
    }
  });
});

// ── K. Catalog cache isolation between two members of the SAME organization ──

describe("K. cost data does not survive a sign-out/sign-in into a different member of the same org", () => {
  const SHARED_ORG = ORG_A;

  /** A distinguishable payload: only USER_A's session gets cost back. */
  function catalogFor(viewerId: string): CatalogProduct[] {
    return [
      fakeProduct({
        id: PRODUCT_A,
        variants: [
          {
            id: "v1",
            productId: PRODUCT_A,
            sku: "SKU-1",
            barcode: null,
            name: "",
            price: { amount: 1500, currency: "USD" },
            cost: viewerId === USER_A ? { amount: 900, currency: "USD" } : null,
            weightGrams: null,
            status: "ACTIVE",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ];
  }

  /**
   * Stands in for listCatalogProducts()/getCatalogProduct(): identity comes
   * only from the session the fake server holds, exactly like the real
   * server functions, which resolve the caller from the validated session
   * cookie — never from a parameter this test could pass in.
   */
  function createFakeServer() {
    let session: { userId: string; organizationId: string } | null = null;
    return {
      signIn(userId: string, organizationId: string) {
        session = { userId, organizationId };
      },
      signOut() {
        session = null;
      },
      async listProducts(): Promise<CatalogProduct[]> {
        if (!session) throw new Error("Not authenticated");
        return catalogFor(session.userId);
      },
    };
  }

  function cachedCatalogEntries(client: QueryClient) {
    return client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === CATALOG_QUERY_ROOT);
  }

  it("User B (same org, no products.view_cost) cannot render or read User A's cached cost", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    // 1. User A signs in and loads the catalog. Cost is visible.
    server.signIn(USER_A, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_A, SHARED_ORG);
    const aKey = catalogKeys.products(USER_A, SHARED_ORG, "ACTIVE", null);
    const aList = await client.fetchQuery({ queryKey: aKey, queryFn: () => server.listProducts() });
    expect(aList[0]!.variants[0]!.cost).toEqual({ amount: 900, currency: "USD" });

    // 2. User A signs out. Settings' explicit clear runs (app.settings.tsx).
    server.signOut();
    clearCatalogQueries(client);
    expect(client.getQueryData(aKey)).toBeUndefined();
    expect(cachedCatalogEntries(client)).toHaveLength(0);

    // 3. User B signs in — the SAME organization, but without products.view_cost.
    server.signIn(USER_B, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_B, SHARED_ORG);
    const bKey = catalogKeys.products(USER_B, SHARED_ORG, "ACTIVE", null);

    // Before B's own fetch resolves, neither B's nor A's key holds anything.
    expect(client.getQueryData(bKey)).toBeUndefined();
    expect(client.getQueryData(aKey)).toBeUndefined();

    // 4. B's own load returns B's view — no cost — and nothing of A's.
    const bList = await client.fetchQuery({ queryKey: bKey, queryFn: () => server.listProducts() });
    expect(bList[0]!.variants[0]!.cost).toBeNull();
    expect(client.getQueryData(aKey)).toBeUndefined();
  });

  it("purges A's cached cost even when the explicit sign-out clear never ran", async () => {
    // Defense in depth, matching enforceHomeCachePrincipal's own second test
    // (src/tests/home-cache-isolation.test.ts): the principal-keyed cache
    // must catch this on its own, independent of Settings' queryClient.clear().
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_A, SHARED_ORG);
    await client.fetchQuery({
      queryKey: catalogKeys.products(USER_A, SHARED_ORG, "ACTIVE", null),
      queryFn: () => server.listProducts(),
    });

    // No clearCatalogQueries() at all — straight to B mounting the same org.
    server.signIn(USER_B, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_B, SHARED_ORG);

    expect(
      client.getQueryData(catalogKeys.products(USER_A, SHARED_ORG, "ACTIVE", null)),
    ).toBeUndefined();
    expect(cachedCatalogEntries(client)).toHaveLength(0);
  });

  it("the same isolation holds for the product detail query, not just the list", async () => {
    const client = new QueryClient();
    const server = createFakeServer();

    server.signIn(USER_A, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_A, SHARED_ORG);
    const aDetailKey = catalogKeys.product(USER_A, SHARED_ORG, PRODUCT_A);
    await client.fetchQuery({
      queryKey: aDetailKey,
      queryFn: async () => (await server.listProducts())[0]!,
    });
    expect(client.getQueryData(aDetailKey)).toBeDefined();

    server.signIn(USER_B, SHARED_ORG);
    enforceCatalogCachePrincipal(client, USER_B, SHARED_ORG);

    expect(client.getQueryData(aDetailKey)).toBeUndefined();
  });

  it("documents the bug directly: an organization-only key cannot distinguish A from B", () => {
    // The pre-fix key shape — organization only. Recreated here (not
    // exported, and must not be) purely to demonstrate why it was unsafe.
    const legacyKey = (organizationId: string) =>
      [CATALOG_QUERY_ROOT, organizationId, "products", "ACTIVE", "all"] as const;

    // A and B, same organization, produced the IDENTICAL key under the old
    // shape — so B's read was A's cache entry, cost included.
    expect(legacyKey(SHARED_ORG)).toEqual(legacyKey(SHARED_ORG));

    // The real, fixed key includes the user, so A and B never collide.
    expect(catalogKeys.products(USER_A, SHARED_ORG, "ACTIVE", null)).not.toEqual(
      catalogKeys.products(USER_B, SHARED_ORG, "ACTIVE", null),
    );
  });
});

// ── D. Cost withholding ───────────────────────────────────────────────────────

describe("D. a withheld cost stays withheld", () => {
  it("the service sends no cost to a caller without products.view_cost", async () => {
    const db = orgBFixture();
    const { getProductDetail } = await import("../server/products/service");

    await withDb(db, async () => {
      const blind = await getProductDetail(ctxWith(["products.read"], ORG_B), PRODUCT_B);
      expect(blind.variants[0]!.cost).toBeNull();
      // The price is still present — withholding cost is not withholding everything.
      expect(blind.variants[0]!.price).toEqual({ amount: 1500, currency: "USD" });

      const sighted = await getProductDetail(
        ctxWith(["products.read", "products.view_cost"], ORG_B),
        PRODUCT_B,
      );
      expect(sighted.variants[0]!.cost).toEqual({ amount: 900, currency: "USD" });
    });
  });

  it("the browser never derives, defaults or back-calculates a cost", () => {
    const sources = [read(CATALOG_LIB), read(DETAIL_ROUTE), ...PRODUCT_COMPONENTS.map(read)].join(
      "\n",
    );
    // No margin/markup arithmetic, and no zero-filled stand-in for a missing cost.
    expect(sources).not.toMatch(/margin|markup/i);
    expect(sources).not.toMatch(/cost\s*\?\?\s*0/);
    expect(sources).not.toMatch(/costAmount\s*=\s*0/);
  });

  it("the variant form sends no cost field when the cost was withheld", () => {
    const source = read("src/components/products/VariantSheet.tsx");
    // The cost keys are inside a costEditable branch, which requires canViewCost.
    expect(source).toContain("...(costEditable");
    expect(source).toContain("costWithheld");
    const access = variantFieldAccess(
      {
        canCreate: true,
        canUpdateBasic: true,
        canUpdatePrice: true,
        canUpdateCost: true,
        canViewCost: false,
      },
      true,
    );
    expect(access.costEditable).toBe(false);
  });

  it("an emptied field is cleared, not silently kept", () => {
    /*
     * updateVariantFn once mapped every nullish field through `?? undefined`,
     * which turned "clear this SKU" into "leave the SKU alone" while still
     * reporting success. Absent and null must stay different instructions.
     */
    const handler = read("src/api/products.ts");
    const updateVariantBlock = handler.slice(
      handler.indexOf("export const updateVariantFn"),
      handler.indexOf("// ── listCategoriesFn"),
    );
    expect(updateVariantBlock).toContain("sku: patch.sku,");
    expect(updateVariantBlock).toContain("cost_amount: patch.cost_amount,");
    expect(updateVariantBlock).not.toMatch(
      /patch\.(sku|barcode|cost_amount|cost_currency|weight_grams)\s*\?\?\s*undefined/,
    );
  });

  it("clearing a cost still demands products.update_cost", async () => {
    const { updateVariant } = await import("../server/products/service");
    await expectForbidden(() =>
      updateVariant(ctxWith(["products.read", "products.update_basic"]), VARIANT_B, {
        cost_amount: null,
      }),
    );
  });

  it("the detail screen renders a cost only when the current capability state allows it", () => {
    const detail = read(DETAIL_ROUTE);
    // Rendering goes through the masking helper's result, not the raw field.
    expect(detail).toContain("visibleVariantCost(variant, canViewCost)");
    expect(detail).toContain("{cost ? (");
    expect(detail).not.toContain("{variant.cost ? (");
    expect(detail).toContain("catalog.detail.costHidden");
  });
});

// ── K2. same-principal products.view_cost revocation masks cached cost ────────
//
// K covers cost never crossing from one member to another. This covers the
// blocker an independent review found in that same PR: the SAME member,
// SAME organization, loses products.view_cost mid-session. Cache partitioning
// by userId+organizationId does nothing there — the key does not change — so
// masking must happen at render time, off the CURRENT capability state, not
// off whatever the cached CatalogVariant happens to still be carrying.

describe("L. same-principal products.view_cost revocation masks cached cost immediately", () => {
  /** Stands in for a product fetched into the cache while view_cost held. */
  const cachedVariant: CatalogVariant = {
    id: "v1",
    productId: PRODUCT_A,
    sku: "SKU-1",
    barcode: null,
    name: "Regular",
    price: { amount: 1500, currency: "USD" },
    cost: { amount: 900, currency: "USD" },
    weightGrams: null,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("positive control: an authorized member still sees the cached cost", () => {
    expect(visibleVariantCost(cachedVariant, true)).toEqual({ amount: 900, currency: "USD" });

    const access = variantFieldAccess(
      {
        canCreate: true,
        canUpdateBasic: true,
        canUpdatePrice: true,
        canUpdateCost: true,
        canViewCost: true,
      },
      true,
    );
    expect(access.costVisible).toBe(true);
    expect(access.costEditable).toBe(true);
  });

  it("User A / Org A loses products.view_cost: the cache still holds the real cost, but nothing shows it", () => {
    // 1. User A loaded this product earlier, while authorized — this IS that
    //    cached row, unchanged, still carrying the real cost value.
    expect(cachedVariant.cost).toEqual({ amount: 900, currency: "USD" });

    // 2. Same User A, same Org A, revoked mid-session. No refetch, no
    //    invalidation, no queryClient interaction at all — only the
    //    capability snapshot changed.
    const revoked = createFixtureCapabilityView([
      "products.read",
      "products.update_cost",
      "products.update_basic",
    ]);
    const canViewCost = revoked.can("products.view_cost");
    expect(canViewCost).toBe(false);

    // 3. The cached data is untouched — still the pre-revocation cost. This is
    //    the exact condition the reviewer flagged: partitioning by user+org
    //    does not protect against this, because the key never changed.
    expect(cachedVariant.cost).not.toBeNull();

    // 4. The mandatory masking helper refuses it anyway, purely off the
    //    current capability — this is what makes rendering safe on the very
    //    next paint rather than after a round trip.
    expect(visibleVariantCost(cachedVariant, canViewCost)).toBeNull();

    // 5. And no cost-edit affordance survives either, even though this member
    //    still holds products.update_cost AND products.update_basic — cost
    //    editing requires view_cost too (requirement: view_cost && update_cost
    //    && update_basic), so losing view_cost alone is enough to close it.
    const access = variantFieldAccess(
      {
        canCreate: true,
        canUpdateBasic: true,
        canUpdatePrice: true,
        canUpdateCost: true,
        canViewCost,
      },
      true,
    );
    expect(access.costVisible).toBe(false);
    expect(access.costEditable).toBe(false);
  });

  it("fails closed for pending, denied, and identity-mismatched capability states too", () => {
    // Still resolving.
    expect(
      visibleVariantCost(cachedVariant, UNRESOLVED_CAPABILITIES.can("products.view_cost")),
    ).toBeNull();

    // Resolved but no usable membership (e.g. removed from the org).
    const deniedView = createCapabilityView({
      result: { status: "no_membership" },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    expect(visibleVariantCost(cachedVariant, deniedView.can("products.view_cost"))).toBeNull();

    // A snapshot that resolved to a DIFFERENT organization than the route
    // context expects — mid organization-switch, or a stale response race.
    // Even though it carries products.view_cost, the identity mismatch alone
    // must deny everything.
    const mismatched = createCapabilityView({
      result: {
        status: "active",
        userId: USER_A,
        organizationId: ORG_B,
        role: "OWNER",
        permissions: ["products.read", "products.view_cost"],
      },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
    });
    expect(mismatched.state).toBe("denied");
    expect(visibleVariantCost(cachedVariant, mismatched.can("products.view_cost"))).toBeNull();
  });

  it("every cost-rendering surface routes through visibleVariantCost — none reads variant.cost directly", () => {
    const detail = read(DETAIL_ROUTE);
    const sheet = read("src/components/products/VariantSheet.tsx");
    const list = read(LIST_ROUTE);
    const createSheet = read("src/components/products/CreateProductSheet.tsx");

    // Product detail's variant rows.
    expect(detail).toContain("visibleVariantCost(variant, canViewCost)");
    expect(detail).not.toContain("{variant.cost ? (");
    expect(detail).not.toContain("formatMoney(variant.cost)");

    // The edit sheet's form state (seeded from a variant, potentially cached).
    expect(sheet).toContain("visibleVariantCost(variant, canViewCost)");
    expect(sheet).not.toContain("variant.cost.amount");
    expect(sheet).not.toContain("variant.cost?.currency");
    expect(sheet).not.toContain("variant.cost ?");

    // The product list/card surface shows a lead price only — it has no cost
    // to mask because it never reads one.
    expect(list).not.toMatch(/\.cost\b/);

    // Product creation never seeds from a cached variant at all — its cost
    // field is always a blank input, never read off a `variant` object — so
    // there is nothing there to mask. (Translation keys like
    // "catalog.variant.cost" legitimately contain the substring "variant.cost",
    // so this checks for an actual property access, not just the text.)
    expect(createSheet).not.toContain("variant.cost.amount");
    expect(createSheet).not.toContain("variant.cost?.currency");
    expect(createSheet).not.toContain("variant.cost ?");
  });

  it("the row-level gate is the live per-render capability, not a value captured once", () => {
    // VariantRow receives canViewCost as an explicit prop recomputed on every
    // render of ProductDetailScreen from the live capabilities hook — not
    // read off the cached variant — so a capability change taking effect on
    // the very next render (no fetch required) changes what the row draws.
    const detail = read(DETAIL_ROUTE);
    expect(detail).toContain("canViewCost={canViewCost}");
    expect(detail).toMatch(
      /canViewCost\s*=\s*identityOk\s*&&\s*capabilities\.canSensitive\("products\.view_cost"\)/,
    );
  });
});

// ── M. An unconfirmed capability snapshot cannot show a cached cost ───────────
//
// L covers an explicit revocation. This covers the narrower P1 underneath it:
// the member is NOT revoked as far as the browser knows — same user, same
// organization, prior authorized snapshot still held — but the background
// capability refresh REJECTED. createCapabilityView deliberately keeps that
// snapshot alive for navigation (see U1 in capability-model.test.ts), so
// `can("products.view_cost")` still answers true. A revocation landing inside
// that unconfirmed window would look identical, so cost must fail closed on
// canSensitive, before any further server response arrives.

describe("M. a retained-but-unconfirmed capability snapshot shows no cost", () => {
  const cachedVariant: CatalogVariant = {
    id: "v1",
    productId: PRODUCT_A,
    sku: "SKU-1",
    barcode: null,
    name: "Regular",
    price: { amount: 1500, currency: "USD" },
    cost: { amount: 900, currency: "USD" },
    weightGrams: null,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const ALL_COST_KEYS: UiPermissionKey[] = [
    "products.read",
    "products.view_cost",
    "products.update_cost",
    "products.update_basic",
  ];

  /** The capability view for USER_A / ORG_A, with the query state varied. */
  function viewFor(overrides: { isPending?: boolean; isError?: boolean } = {}) {
    return createCapabilityView({
      result: {
        status: "active",
        userId: USER_A,
        organizationId: ORG_A,
        role: "MANAGER",
        permissions: ALL_COST_KEYS,
      },
      isPending: false,
      isError: false,
      expectedUserId: USER_A,
      expectedOrganizationId: ORG_A,
      ...overrides,
    });
  }

  /**
   * Exactly how both product screens derive their cost gates, reproduced so
   * the assertions below run against the real composition rather than a
   * restatement of it: identity + canSensitive, then variantFieldAccess.
   */
  function costGates(capabilities: ReturnType<typeof viewFor>, identityOk = true) {
    const canViewCost = identityOk && capabilities.canSensitive("products.view_cost");
    const canUpdateCost = identityOk && capabilities.canSensitive("products.update_cost");
    const canUpdateBasic = identityOk && capabilities.can("products.update_basic");
    const access = variantFieldAccess(
      {
        canCreate: true,
        canUpdateBasic,
        canUpdatePrice: true,
        canUpdateCost,
        canViewCost,
      },
      true,
    );
    return { canViewCost, canUpdateCost, canUpdateBasic, access };
  }

  it("positive control: a confirmed snapshot shows the cost and allows editing it", () => {
    const { canViewCost, access } = costGates(viewFor());

    expect(canViewCost).toBe(true);
    expect(visibleVariantCost(cachedVariant, canViewCost)).toEqual({
      amount: 900,
      currency: "USD",
    });
    expect(access.costVisible).toBe(true);
    expect(access.costEditable).toBe(true);
  });

  it("a rejected background refresh hides the cached cost immediately", () => {
    const stale = viewFor({ isError: true });

    // The snapshot is retained and still lists the key — this is the exact
    // condition the reviewer flagged.
    expect(stale.state).toBe("ready");
    expect(stale.can("products.view_cost")).toBe(true);
    expect(cachedVariant.cost).toEqual({ amount: 900, currency: "USD" });

    // Nothing renders it: the gate is canSensitive, which refuses a stale view.
    const { canViewCost } = costGates(stale);
    expect(canViewCost).toBe(false);
    expect(visibleVariantCost(cachedVariant, canViewCost)).toBeNull();
  });

  it("an open VariantSheet clears its cost and submits no cost field after the error", () => {
    const stale = viewFor({ isError: true });
    const { access } = costGates(stale);

    // No cost field is offered, and no cost-edit affordance survives — even
    // though update_cost and update_basic are both still in the snapshot.
    expect(access.costVisible).toBe(false);
    expect(access.costEditable).toBe(false);

    // The value the already-open form holds after the cost-sync effect runs:
    // the effect recomputes exactly this and writes it into costText.
    const cost = visibleVariantCost(cachedVariant, access.costVisible);
    expect(cost).toBeNull();
    const costTextAfterError = cost ? formatMinorUnitsForInput(cost.amount, cost.currency) : "";
    expect(costTextAfterError).toBe("");

    // And the submit payload: the cost keys live inside a `costEditable`
    // branch, so with costEditable false the patch carries no cost key at all.
    const sheet = read("src/components/products/VariantSheet.tsx");
    expect(sheet).toContain("...(costEditable");
    expect(sheet).toMatch(/\.\.\.\(costEditable\s*\n?\s*\?\s*\{\s*costAmount/);
  });

  it("pending, denied, no-membership, identity mismatch and error all fail closed", () => {
    const cases: Array<[string, ReturnType<typeof viewFor>]> = [
      ["pending", UNRESOLVED_CAPABILITIES],
      ["errored with a retained snapshot", viewFor({ isError: true })],
      [
        "errored with nothing retained",
        createCapabilityView({
          result: undefined,
          isPending: false,
          isError: true,
          expectedUserId: USER_A,
          expectedOrganizationId: ORG_A,
        }),
      ],
      [
        "no membership",
        createCapabilityView({
          result: { status: "no_membership" },
          isPending: false,
          isError: false,
          expectedUserId: USER_A,
          expectedOrganizationId: ORG_A,
        }),
      ],
      [
        "unauthenticated",
        createCapabilityView({
          result: { status: "unauthenticated" },
          isPending: false,
          isError: false,
          expectedUserId: USER_A,
          expectedOrganizationId: ORG_A,
        }),
      ],
      [
        "identity mismatch",
        createCapabilityView({
          result: {
            status: "active",
            userId: USER_A,
            organizationId: ORG_B,
            role: "OWNER",
            permissions: ALL_COST_KEYS,
          },
          isPending: false,
          isError: false,
          expectedUserId: USER_A,
          expectedOrganizationId: ORG_A,
        }),
      ],
    ];

    for (const [label, capabilities] of cases) {
      const { canViewCost, access } = costGates(capabilities);
      expect(`${label}:${canViewCost}`).toBe(`${label}:false`);
      expect(`${label}:${visibleVariantCost(cachedVariant, canViewCost)}`).toBe(`${label}:null`);
      expect(`${label}:${access.costVisible}`).toBe(`${label}:false`);
      expect(`${label}:${access.costEditable}`).toBe(`${label}:false`);
    }

    // Pending is also covered by the route's own identity gate, which fails
    // closed independently when the route context has no organization yet.
    const { canViewCost: noIdentity } = costGates(viewFor(), false);
    expect(noIdentity).toBe(false);
  });

  it("both product screens gate cost on canSensitive, and nothing else on it", () => {
    const detail = read(DETAIL_ROUTE);
    const list = read(LIST_ROUTE);

    // Cost — and only cost — uses the narrowed reader.
    expect(detail).toContain('capabilities.canSensitive("products.view_cost")');
    expect(detail).toContain('capabilities.canSensitive("products.update_cost")');
    expect(list).toContain('capabilities.canSensitive("products.update_cost")');

    // The non-sensitive gates keep the ordinary stale-tolerant reader, so a
    // timed-out background refresh does not blank the rest of the screen.
    expect(detail).toContain('capabilities.can("products.read")');
    expect(detail).toContain('capabilities.can("products.update_basic")');
    expect(detail).toContain('capabilities.can("products.update_price")');
    expect(list).toContain('capabilities.can("products.read")');
    expect(list).toContain('capabilities.can("products.create")');
    expect(list).toContain('capabilities.can("products.manage_categories")');

    // No cost key is read through the stale-tolerant reader anywhere.
    for (const source of [detail, list]) {
      expect(source).not.toContain('capabilities.can("products.view_cost")');
      expect(source).not.toContain('capabilities.can("products.update_cost")');
    }
  });

  it("the variant form tracks cost visibility live, on its own effect", () => {
    // The cost-only effect is what makes an ALREADY-OPEN sheet safe: it
    // depends on costVisible, so a mid-session loss empties costText without
    // waiting for a refetch — and without discarding the rest of the form.
    const sheet = read("src/components/products/VariantSheet.tsx");
    expect(sheet).toContain("visibleVariantCost(variant, costVisible)");
    expect(sheet).toContain("}, [open, variant, costVisible]);");
  });
});

// ── E. Duplicate SKU / barcode ────────────────────────────────────────────────

describe("E. duplicate SKU and barcode reach the merchant as themselves", () => {
  it("the 409 messages classify to their own copy keys", () => {
    expect(classifyCatalogError(new Error("SKU already exists in this organization"))).toBe(
      "duplicate_sku",
    );
    expect(classifyCatalogError(new Error("Barcode already exists in this organization"))).toBe(
      "duplicate_barcode",
    );
    expect(catalogErrorKey("duplicate_sku")).toBe("catalog.error.duplicate_sku");
    expect(catalogErrorKey("duplicate_barcode")).toBe("catalog.error.duplicate_barcode");
  });

  it("the service still translates the constraint names it always did", () => {
    const source = read("src/server/products/service.ts");
    expect(source).toContain("uniq_product_variants_sku_per_org");
    expect(source).toContain("uniq_product_variants_barcode_per_org");
    expect(source).toContain("statusCode: 409");
  });

  it("a denial, a missing row and an invalid amount are not reported as duplicates", () => {
    expect(classifyCatalogError(new Error("Missing permission: products.create"))).toBe("denied");
    expect(classifyCatalogError(new Error("Product not found"))).toBe("not_found");
    expect(classifyCatalogError(new Error("Variant not found"))).toBe("not_found");
    expect(classifyCatalogError(new Error("Category not found"))).toBe("not_found");
    expect(
      classifyCatalogError(new Error("price_amount must be a non-negative integer (minor units)")),
    ).toBe("invalid_money");
    expect(classifyCatalogError(new Error("listProducts: connection reset"))).toBe("generic");
    expect(classifyCatalogError("not an error")).toBe("generic");
  });

  it("a DB outage mentioning a product is not misread as a missing product", () => {
    expect(classifyCatalogError(new Error("findProductById: Product not found upstream"))).toBe(
      "generic",
    );
  });

  it("every classified failure has copy in both locales", () => {
    const en = JSON.parse(read("src/locales/en.json"));
    const km = JSON.parse(read("src/locales/km.json"));
    for (const kind of [
      "denied",
      "not_found",
      "duplicate_sku",
      "duplicate_barcode",
      "invalid_money",
      "generic",
    ] as const) {
      expect(en.catalog.error[kind]).toBeTruthy();
      expect(km.catalog.error[kind]).toBeTruthy();
    }
  });
});

// ── F. Archive, never delete ──────────────────────────────────────────────────

describe("F. archive semantics are preserved", () => {
  it("the UI never calls a delete path", () => {
    /*
     * WeakMap#delete is the JS primitive enforceCatalogCachePrincipal uses to
     * drop a stale cache-identity fingerprint (src/lib/catalog.ts) — it is
     * cache bookkeeping, not a data-deletion call, and is excluded here so it
     * cannot be confused with one.
     */
    const sources = [read(CATALOG_LIB), read(LIST_ROUTE), read(DETAIL_ROUTE)]
      .join("\n")
      .replace(/LAST_CATALOG_PRINCIPAL\.delete\([^)]*\)/g, "");
    expect(sources).not.toMatch(/deleteProduct|deleteVariant|deleteCategory|\.delete\(/);
  });

  it("archiving a product goes through archiveProductFn, which sets status ARCHIVED", async () => {
    expect(read(CATALOG_LIB)).toContain("archiveProductFn");
    expect(read("src/server/products/service.ts")).toContain('status: "ARCHIVED"');

    const db = orgBFixture();
    const { archiveProduct } = await import("../server/products/service");
    await withDb(db, async () => {
      const archived = await archiveProduct(
        ctxWith(["products.read", "products.archive"], ORG_B),
        PRODUCT_B,
      );
      expect(archived.status).toBe("ARCHIVED");
    });
    expect(db.writes).toEqual(["update:products"]);
  });

  it("archiving is confirmed before it happens", () => {
    const source = read(DETAIL_ROUTE);
    // The confirm sheet, not the archive call, is what the archive button opens.
    expect(source).toContain("onClick={() => setArchiveOpen(true)}");
    expect(source).toContain("catalog.detail.archive.title");
    expect(source).toContain("catalog.detail.archive.confirm");
    expect(source).toContain("common.cancel");
  });

  it("a failed archive is reported, never shown as success", () => {
    const source = read(DETAIL_ROUTE);
    const archiveBody = source.slice(source.indexOf("async function archive()"));
    const catchIdx = archiveBody.indexOf("} catch (err) {");
    const successIdx = archiveBody.indexOf("notifySuccess");
    expect(catchIdx).toBeGreaterThan(-1);
    // The success toast is inside the try, before the catch — never after it.
    expect(successIdx).toBeLessThan(catchIdx);
    expect(archiveBody.slice(catchIdx)).toContain("notifyError");
  });

  it("archived products are a list the merchant can actually open", () => {
    expect(read(LIST_ROUTE)).toContain("CATALOG_LIST_STATUSES");
    expect(read(DETAIL_ROUTE)).toContain("catalog.detail.variantsArchived");
  });
});

// ── G. Money: integer minor units only ────────────────────────────────────────

describe("G. money is parsed into integer minor units without floating point", () => {
  it("parses USD to cents exactly, including the values float maths gets wrong", () => {
    expect(parseMinorUnits("19.99", "USD")).toBe(1999);
    expect(parseMinorUnits("0.07", "USD")).toBe(7);
    expect(parseMinorUnits("1.10", "USD")).toBe(110);
    expect(parseMinorUnits("12", "USD")).toBe(1200);
    expect(parseMinorUnits("12.5", "USD")).toBe(1250);
    expect(parseMinorUnits("1,234.56", "USD")).toBe(123456);
  });

  it("parses KHR as whole riel — the minor unit has no decimals", () => {
    expect(parseMinorUnits("4000", "KHR")).toBe(4000);
    expect(parseMinorUnits("4000.5", "KHR")).toBeNull();
    expect(parseMinorUnits("4,100", "KHR")).toBe(4100);
  });

  it("rejects anything that is not an amount", () => {
    for (const bad of ["", "   ", "abc", "-5", "1.234", "1e3", "$5", ".", "1.2.3", "12 50"]) {
      expect(parseMinorUnits(bad, "USD")).toBeNull();
    }
  });

  it("accepts a half-typed amount as the whole amount, rather than rejecting mid-keystroke", () => {
    // "12." is what the field holds for one keystroke on the way to "12.50".
    expect(parseMinorUnits("12.", "USD")).toBe(1200);
    expect(parseMinorUnits("12.5", "USD")).toBe(1250);
  });

  it("every parsed value is a safe integer", () => {
    for (const input of ["19.99", "0.01", "123456.78", "0"]) {
      const parsed = parseMinorUnits(input, "USD");
      expect(parsed).not.toBeNull();
      expect(Number.isSafeInteger(parsed!)).toBe(true);
    }
  });

  it("round-trips minor units back into the field", () => {
    expect(formatMinorUnitsForInput(1999, "USD")).toBe("19.99");
    expect(formatMinorUnitsForInput(7, "USD")).toBe("0.07");
    expect(formatMinorUnitsForInput(1200, "USD")).toBe("12.00");
    expect(formatMinorUnitsForInput(4000, "KHR")).toBe("4000");
    for (const amount of [0, 1, 7, 99, 100, 1999, 123456]) {
      expect(parseMinorUnits(formatMinorUnitsForInput(amount, "USD"), "USD")).toBe(amount);
    }
  });

  it("the catalog layer and its screens do no floating-point money arithmetic", () => {
    // Comments explain why float maths is avoided; only real code counts.
    const sources = [CATALOG_LIB, LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]
      .map((file) =>
        read(file)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      )
      .join("\n");
    expect(sources).not.toMatch(/parseFloat/);
    expect(sources).not.toMatch(/\*\s*100\b/);
    expect(sources).not.toMatch(/\/\s*100\b/);
    expect(sources).not.toMatch(/toFixed\(/);
  });

  it("the server still rejects a non-integer amount whatever the browser sent", async () => {
    const { createProduct } = await import("../server/products/service");
    await expect(
      createProduct(ctxWith(["products.create", "products.read"]), {
        name_km: "ទំនិញ",
        initialVariant: { price_amount: 9.99, price_currency: "USD" },
      }),
    ).rejects.toThrow(/integer/i);
  });
});

// ── Catalog list helpers ──────────────────────────────────────────────────────

function fakeProduct(over: Partial<CatalogProduct>): CatalogProduct {
  return {
    id: PRODUCT_A,
    organizationId: ORG_A,
    workspaceId: null,
    nameKm: "កាហ្វេ",
    nameEn: "Coffee",
    descriptionKm: null,
    descriptionEn: null,
    categoryId: null,
    status: "ACTIVE",
    companion: "nilo",
    stock: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    ...over,
  };
}

describe("catalog list search is honest about its own scope", () => {
  const loaded: CatalogProduct[] = [
    fakeProduct({ id: "p1", nameKm: "កាហ្វេ", nameEn: "Coffee" }),
    fakeProduct({ id: "p2", nameKm: "តែ", nameEn: "Tea" }),
    fakeProduct({
      id: "p3",
      nameKm: "នំបុ័ង",
      nameEn: null,
      variants: [
        {
          id: "v3",
          productId: "p3",
          sku: "BRD-01",
          barcode: "8850",
          name: "Large",
          price: { amount: 250, currency: "USD" },
          cost: null,
          weightGrams: null,
          status: "ACTIVE",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
  ];

  it("matches Khmer and English names, SKU and barcode", () => {
    expect(searchLoadedProducts(loaded, "កាហ្វេ").map((p) => p.id)).toEqual(["p1"]);
    expect(searchLoadedProducts(loaded, "tea").map((p) => p.id)).toEqual(["p2"]);
    expect(searchLoadedProducts(loaded, "brd-01").map((p) => p.id)).toEqual(["p3"]);
    expect(searchLoadedProducts(loaded, "8850").map((p) => p.id)).toEqual(["p3"]);
    expect(searchLoadedProducts(loaded, "large").map((p) => p.id)).toEqual(["p3"]);
  });

  it("returns the loaded page unchanged for an empty query — it never re-queries", () => {
    expect(searchLoadedProducts(loaded, "   ").map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("searches nothing beyond what was loaded", () => {
    expect(searchLoadedProducts([], "កាហ្វេ")).toEqual([]);
    expect(searchLoadedProducts(loaded, "nothing-here")).toEqual([]);
  });

  it("the screen says so, in both languages, and flags a full page", () => {
    const en = JSON.parse(read("src/locales/en.json"));
    const km = JSON.parse(read("src/locales/km.json"));
    expect(en.catalog.list.searchScope).toMatch(/this page/i);
    expect(km.catalog.list.searchScope).toMatch(/[ក-៿]/);
    expect(read(LIST_ROUTE)).toContain("catalog.list.searchScope");
    expect(read(LIST_ROUTE)).toContain("catalog.list.pageLimit");
    expect(CATALOG_PAGE_LIMIT).toBeGreaterThan(0);
  });

  it("the lead price is a real variant price, never a computed one", () => {
    const withArchivedFirst = fakeProduct({
      variants: [
        {
          id: "v-old",
          productId: PRODUCT_A,
          sku: null,
          barcode: null,
          name: "",
          price: { amount: 100, currency: "USD" },
          cost: null,
          weightGrams: null,
          status: "ARCHIVED",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "v-new",
          productId: PRODUCT_A,
          sku: null,
          barcode: null,
          name: "",
          price: { amount: 250, currency: "USD" },
          cost: null,
          weightGrams: null,
          status: "ACTIVE",
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
    expect(productLeadPrice(withArchivedFirst)).toEqual({ amount: 250, currency: "USD" });
    expect(productLeadPrice(fakeProduct({ variants: [] }))).toBeNull();
  });

  it("category labels fall back to Khmer when there is no English name", () => {
    const category = { nameKm: "ភេសជ្ជៈ", nameEn: "Drinks" };
    expect(categoryLabel(category, "en")).toBe("Drinks");
    expect(categoryLabel(category, "km")).toBe("ភេសជ្ជៈ");
    expect(categoryLabel({ nameKm: "ភេសជ្ជៈ", nameEn: null }, "en")).toBe("ភេសជ្ជៈ");
  });
});

// ── H. Khmer / English parity for the new copy ────────────────────────────────

describe("H. every new catalog string exists in Khmer and English", () => {
  type JsonTree = { [key: string]: JsonTree | string | number | boolean | null };

  function flatten(tree: JsonTree, prefix = ""): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(tree)) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        keys.push(...flatten(value as JsonTree, next));
      } else {
        keys.push(next);
      }
    }
    return keys;
  }

  const en = JSON.parse(read("src/locales/en.json")) as JsonTree;
  const km = JSON.parse(read("src/locales/km.json")) as JsonTree;
  const enKeys = flatten(en).filter((key) => key.startsWith("catalog."));
  const kmKeys = flatten(km).filter((key) => key.startsWith("catalog."));

  it("the catalog namespace is non-trivial", () => {
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it("the two locales carry exactly the same catalog keys", () => {
    expect([...enKeys].sort()).toEqual([...kmKeys].sort());
  });

  it("the Khmer copy is actually Khmer, not an English placeholder", () => {
    const khmer = /[ក-៿]/;
    const kmCatalog = (km as unknown as { catalog: JsonTree }).catalog;
    const values = flatten(kmCatalog).map((key) =>
      key.split(".").reduce<unknown>((node, part) => (node as JsonTree)[part], kmCatalog),
    );
    // Every Khmer string carries Khmer script (currency codes are the only
    // Latin text this namespace shows, and those are rendered, not translated).
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect(value as string).toMatch(khmer);
    }
  });

  it("the new navigation entry is translated too", () => {
    const enNav = (en as unknown as { nav: { moreActions: Record<string, JsonTree> } }).nav;
    const kmNav = (km as unknown as { nav: { moreActions: Record<string, JsonTree> } }).nav;
    expect(enNav.moreActions["productCatalog"]).toBeTruthy();
    expect(kmNav.moreActions["productCatalog"]).toBeTruthy();
    expect(String(kmNav.moreActions["productCatalog"]!["label"])).toMatch(/[ក-៿]/);
  });

  it("no user-facing string is hard-coded in the new screens", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
      const source = read(file);
      // Every rendered text node goes through t(...) — no bare JSX text.
      const bareText = source.match(/>[A-Za-zក-៿][^<>{}\n]{3,}</g) ?? [];
      expect(bareText).toEqual([]);
    }
  });

  it("no hard-coded hex colour is introduced by the new screens", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
      expect(read(file)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("no uppercase transform is applied to any label", () => {
    for (const file of [LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
      expect(read(file)).not.toMatch(/uppercase/);
    }
  });
});

// ── I. No production mock path ────────────────────────────────────────────────

describe("I. the catalog has no mock or fallback data path", () => {
  it("the catalog client imports nothing from the mock layer", () => {
    for (const file of [CATALOG_LIB, LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
      expect(read(file)).not.toMatch(/@\/lib\/mock/);
      expect(read(file)).not.toMatch(/isDemoModeError|getProducts\(|getPosProducts\(/);
    }
  });

  it("a failed catalog call surfaces as a failure, with no invented rows", () => {
    const source = read(CATALOG_LIB);
    // No try/catch that swallows a server error into a substitute value.
    expect(source).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*return\s*\[/);
    expect(source).not.toMatch(/\?\?\s*products\b/);
    expect(read(LIST_ROUTE)).toContain("productsQuery.isError");
    expect(read(DETAIL_ROUTE)).toContain("productQuery.isError");
  });
});

// ── J. Browser boundary ───────────────────────────────────────────────────────

describe("J. the new screens keep the server/browser boundary", () => {
  function staticImports(source: string): string[] {
    return source.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import ") && !trimmed.startsWith("import{")) return false;
      return !/^import\s+type\b/.test(trimmed);
    });
  }

  for (const file of [CATALOG_LIB, LIST_ROUTE, DETAIL_ROUTE, ...PRODUCT_COMPONENTS]) {
    it(`${file} statically imports no server-only module`, () => {
      const offenders = staticImports(read(file)).filter(
        (line) =>
          line.includes("@/server/") ||
          line.includes("/server/") ||
          line.includes("supabase/server") ||
          line.includes("supabaseAdmin"),
      );
      expect(offenders.filter((line) => !line.includes("@tanstack/react-start/server"))).toEqual(
        [],
      );
    });

    it(`${file} creates no Supabase client of its own`, () => {
      const source = read(file);
      expect(source).not.toMatch(/createClient|createServerClient|createBrowserClient/);
      expect(source).not.toMatch(/SERVICE_ROLE|service_role/);
      expect(source).not.toMatch(/\.from\(["']products["']\)/);
    });
  }

  it("the catalog client reaches the server only through src/api/products.ts", () => {
    const source = read(CATALOG_LIB);
    const dynamicImports = [...source.matchAll(/await import\(["']([^"']+)["']\)/g)].map(
      (match) => match[1]!,
    );
    expect(dynamicImports.length).toBeGreaterThan(5);
    expect([...new Set(dynamicImports)]).toEqual(["@/api/products"]);
  });

  it("the archived-variant flag stayed a presentation option, not a new scope", () => {
    const api = read("src/api/products.ts");
    const service = read("src/server/products/service.ts");
    expect(api).toContain("includeArchivedVariants");
    expect(service).toContain("includeArchivedVariants = false");
    // The read is still permission-checked and still organization-scoped.
    expect(service).toContain('ctx.require("products.read")');
    expect(service).toContain("repo.listVariantsByProduct(ctx.organizationId, productId");
  });

  it("this phase added no migration", () => {
    const migrations = fs
      .readdirSync(path.resolve(ROOT, "supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    // 042 is the migration head this phase inherited. The Product Catalog UI is
    // built entirely on migrations 017-019, which already exist; adding a new
    // file here would move this pin and fail the test on purpose.
    expect(migrations.at(-1)).toBe("042_team_permissions.sql");
    for (const required of [
      "017_product_categories.sql",
      "018_products.sql",
      "019_product_permissions.sql",
    ]) {
      expect(migrations).toContain(required);
    }
  });
});
