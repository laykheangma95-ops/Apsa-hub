/**
 * APSA barcode generation — service behaviour (no live DB).
 *
 * Behavioural, not source-string: these drive generateVariantBarcode against a
 * mocked repository db and assert what it actually does — mints a valid,
 * org-unique code, retries on collision, refuses to overwrite an existing
 * barcode, gives up after exhausting attempts, is org-scoped, and is permission
 * gated.
 *
 * Run: bun test src/tests/barcode-generation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import { isValidApsaBarcode, orgBarcodePrefix } from "../lib/barcode/apsa-code";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makeCtx(organizationId: string, permissions: string[]): AuthorizationContext {
  const perms = new Set(permissions);
  return {
    userId: "user-1",
    organizationId,
    roleId: "role",
    systemRole: "MANAGER",
    permissions: perms,
    can: (k: string) => perms.has(k),
    require: (k: string) => {
      if (!perms.has(k)) throw new ForbiddenError(`Missing permission: ${k}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("owner");
    },
  } as unknown as AuthorizationContext;
}

interface DbOptions {
  /** Row returned by findVariantById; null → not found. */
  variantRow: Record<string, unknown> | null;
  /** barcodeExistsForOrg answers, consumed in order. */
  existsSequence?: boolean[];
  /** Row returned by updateVariant, with the persisted barcode filled in by the fake. */
  onUpdate?: (patch: Record<string, unknown>) => void;
  /** Force updateVariant to throw (e.g. a unique-constraint race). */
  updateError?: string;
  /** Captures the organizationId every query filtered on. */
  orgFilters?: string[];
}

/**
 * A fake supabase query builder that distinguishes the three reads the service
 * makes by their shape: select("*")+single = findVariantById, select("id")+await
 * = barcodeExistsForOrg, update()+single = updateVariant.
 */
function makeDb(opts: DbOptions) {
  let existsIdx = 0;
  let lastPatch: Record<string, unknown> = {};
  return {
    from() {
      const state = { selectArg: "*", isUpdate: false };
      const q: Record<string, unknown> = {
        select(arg: string) {
          state.selectArg = arg;
          return q;
        },
        update(patch: Record<string, unknown>) {
          state.isUpdate = true;
          lastPatch = patch;
          return q;
        },
        eq(col: string, val: string) {
          if (col === "organization_id" && opts.orgFilters) opts.orgFilters.push(val);
          return q;
        },
        in() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        single: async () => {
          if (state.isUpdate) {
            if (opts.updateError) throw new Error(opts.updateError);
            opts.onUpdate?.(lastPatch);
            return { data: { ...(opts.variantRow ?? {}), ...lastPatch }, error: null };
          }
          if (opts.variantRow) return { data: opts.variantRow, error: null };
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        },
        maybeSingle: async () => ({ data: opts.variantRow, error: null }),
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          const exists = opts.existsSequence?.[existsIdx++] ?? false;
          return Promise.resolve({ data: exists ? [{ id: "x" }] : [], error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return q;
    },
  };
}

async function withDb<T>(opts: DbOptions, fn: () => Promise<T>): Promise<T> {
  const { setProductRepositoryDbForTests } = await import("../server/products/repository");
  const restore = setProductRepositoryDbForTests(makeDb(opts));
  try {
    return await fn();
  } finally {
    restore();
  }
}

const activeVariant = {
  id: VARIANT_ID,
  organization_id: ORG_A,
  product_id: "prod-1",
  sku: "SKU-1",
  barcode: null,
  name: "Black / M",
  price_amount: 2500,
  price_currency: "USD",
  cost_amount: null,
  cost_currency: null,
  weight_grams: null,
  status: "ACTIVE",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("generateVariantBarcode", () => {
  it("mints a valid, org-branded APSA barcode and persists it", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const captured: Record<string, unknown>[] = [];
    const result = await withDb(
      {
        variantRow: activeVariant,
        existsSequence: [false],
        onUpdate: (p) => captured.push(p),
      },
      () =>
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => "12345",
        }),
    );
    expect(result.barcode).toBeTruthy();
    expect(isValidApsaBarcode(result.barcode!)).toBe(true);
    // Carries this org's stable prefix.
    expect(result.barcode!.startsWith(`APSA${orgBarcodePrefix(ORG_A)}`)).toBe(true);
    // Actually written to the DB (not just returned).
    expect(captured[0]!.barcode).toBe(result.barcode);
  });

  it("retries on collision until it finds a free code", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const serials = ["111", "222", "333"];
    let call = 0;
    const result = await withDb(
      {
        variantRow: activeVariant,
        existsSequence: [true, true, false], // first two collide
      },
      () =>
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => serials[call++]!,
        }),
    );
    // The third serial (333) is the one that survived; it must be in the code.
    expect(result.barcode).toContain("00000333");
    expect(call).toBe(3);
  });

  it("never overwrites an existing barcode (409)", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withDb({ variantRow: { ...activeVariant, barcode: "8850123456789" } }, async () => {
      await expect(
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => "1",
        }),
      ).rejects.toThrow(/already has a barcode/i);
    });
  });

  it("gives up after exhausting attempts on relentless collisions", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withDb({ variantRow: activeVariant, existsSequence: [true, true, true] }, async () => {
      await expect(
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => "1",
          maxAttempts: 3,
        }),
      ).rejects.toThrow(/unique barcode/i);
    });
  });

  it("is org-scoped: every query filters on the caller's organization", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const orgFilters: string[] = [];
    await withDb({ variantRow: activeVariant, existsSequence: [false], orgFilters }, () =>
      generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
        serialFactory: () => "1",
      }),
    );
    expect(orgFilters.length).toBeGreaterThan(0);
    expect(orgFilters.every((o) => o === ORG_A)).toBe(true);
  });

  it("requires products.update_basic", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withDb({ variantRow: activeVariant }, async () => {
      await expect(
        generateVariantBarcode(makeCtx(ORG_A, []), VARIANT_ID, { serialFactory: () => "1" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("gives different organizations different code prefixes", () => {
    expect(orgBarcodePrefix(ORG_A)).not.toBe(orgBarcodePrefix(ORG_B));
  });
});
