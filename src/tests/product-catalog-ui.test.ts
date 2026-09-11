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
  catalogErrorKey,
  catalogKeys,
  categoryLabel,
  classifyCatalogError,
  formatMinorUnitsForInput,
  isCatalogId,
  parseMinorUnits,
  productLeadPrice,
  searchLoadedProducts,
  variantFieldAccess,
  type CatalogProduct,
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
  const surfaces: Array<{ name: string; file: string; key: string }> = [
    { name: "product list", file: LIST_ROUTE, key: "products.read" },
    { name: "add product", file: LIST_ROUTE, key: "products.create" },
    { name: "category management", file: LIST_ROUTE, key: "products.manage_categories" },
    { name: "initial cost entry", file: LIST_ROUTE, key: "products.update_cost" },
    { name: "product detail", file: DETAIL_ROUTE, key: "products.read" },
    { name: "edit product basics", file: DETAIL_ROUTE, key: "products.update_basic" },
    { name: "price controls", file: DETAIL_ROUTE, key: "products.update_price" },
    { name: "cost controls", file: DETAIL_ROUTE, key: "products.update_cost" },
    { name: "cost visibility", file: DETAIL_ROUTE, key: "products.view_cost" },
    { name: "archive product", file: DETAIL_ROUTE, key: "products.archive" },
  ];

  const serverSource = read("src/server/products/service.ts");

  for (const surface of surfaces) {
    it(`${surface.name} gates on ${surface.key}, which the service enforces`, () => {
      expect(read(surface.file)).toContain(`capabilities.can("${surface.key}")`);
      expect(serverSource).toContain(`"${surface.key}"`);
    });
  }

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

  it("cost cannot be edited without also being visible", () => {
    const blind = variantFieldAccess({ ...none, canUpdateCost: true }, true);
    expect(blind.costVisible).toBe(false);
    expect(blind.costEditable).toBe(false);

    const sighted = variantFieldAccess({ ...none, canUpdateCost: true, canViewCost: true }, true);
    expect(sighted.costEditable).toBe(true);
  });

  it("seeing a cost does not let it be changed", () => {
    const access = variantFieldAccess({ ...none, canViewCost: true }, true);
    expect(access.costVisible).toBe(true);
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

  it("catalog cache keys are partitioned by organization", () => {
    const a = catalogKeys.products(ORG_A, "ACTIVE", null);
    const b = catalogKeys.products(ORG_B, "ACTIVE", null);
    expect(a).not.toEqual(b);
    expect(catalogKeys.product(ORG_A, PRODUCT_A)).not.toEqual(
      catalogKeys.product(ORG_B, PRODUCT_A),
    );
    expect(catalogKeys.categories(ORG_A)).not.toEqual(catalogKeys.categories(ORG_B));
    // Both screens key their queries on the server-derived organization.
    for (const file of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(read(file)).toContain("capabilities.organizationId");
    }
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

  it("the detail screen renders a cost only when the server sent one", () => {
    expect(read(DETAIL_ROUTE)).toContain("{variant.cost ? (");
    expect(read(DETAIL_ROUTE)).toContain("catalog.detail.costHidden");
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
    const sources = [read(CATALOG_LIB), read(LIST_ROUTE), read(DETAIL_ROUTE)].join("\n");
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
