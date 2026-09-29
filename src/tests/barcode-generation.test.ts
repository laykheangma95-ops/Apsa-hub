/**
 * APSA barcode generation — service behaviour (no live DB).
 *
 * Behavioural, not source-string: these drive generateVariantBarcode against a
 * STATEFUL fake repository (a shared, mutable variant store with an org-unique
 * barcode index) and assert what it actually does — mints a valid, org-unique
 * code, retries on collision, refuses to overwrite an existing barcode, gives
 * up after exhausting attempts, is org-scoped, permission gated, and — the
 * repaired blocker — is safe under concurrent generation for the SAME variant:
 * the first write wins and the second never overwrites it.
 *
 * The fake models the two guarantees the fix relies on:
 *   1. a CONDITIONAL update that only fires while barcode IS NULL (so a losing
 *      concurrent write matches zero rows), and
 *   2. an org-scoped unique index that throws on a cross-variant code clash.
 *
 * Run: bun test src/tests/barcode-generation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import { formatApsaBarcode, isValidApsaBarcode, orgBarcodePrefix } from "../lib/barcode/apsa-code";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_VARIANT_ID = "ffffffff-cccc-4ddd-8eee-111111111111";

const UNIQUE_VIOLATION =
  "duplicate key value violates unique constraint uniq_product_variants_barcode_per_org";

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

interface VariantRow {
  id: string;
  organization_id: string;
  product_id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  price_amount: number;
  price_currency: string;
  cost_amount: number | null;
  cost_currency: string | null;
  weight_grams: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function variant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
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
    ...overrides,
  };
}

interface StoreOptions {
  rows: VariantRow[];
  /** Force barcodeExistsForOrg answers in order (overrides the store lookup). */
  existsSequence?: boolean[];
  /** Captures the organizationId every query filtered on. */
  orgFilters?: string[];
}

/**
 * A stateful fake supabase client over an in-memory variant store. It resolves
 * the three query shapes the service uses and enforces the org-unique barcode
 * index on write. Terminals are genuinely async so `Promise.all` interleaving
 * reproduces a real same-variant generation race.
 */
function makeStore(opts: StoreOptions) {
  const rows = opts.rows.map((r) => ({ ...r }));
  let existsIdx = 0;

  function findRow(id: string | undefined, org: string | undefined): VariantRow | undefined {
    return rows.find((r) => r.id === id && r.organization_id === org);
  }

  return {
    from() {
      const state: {
        op: "select" | "update";
        selectArg: string;
        filters: { id?: string; organization_id?: string; barcode?: string };
        isNullBarcode: boolean;
        patch: Record<string, unknown>;
      } = { op: "select", selectArg: "*", filters: {}, isNullBarcode: false, patch: {} };

      const q: Record<string, unknown> = {
        select(arg: string) {
          state.selectArg = arg;
          return q;
        },
        update(patch: Record<string, unknown>) {
          state.op = "update";
          state.patch = patch;
          return q;
        },
        eq(col: string, val: string) {
          if (col === "organization_id") {
            state.filters.organization_id = val;
            opts.orgFilters?.push(val);
          } else if (col === "id") {
            state.filters.id = val;
          } else if (col === "barcode") {
            state.filters.barcode = val;
          }
          return q;
        },
        is(col: string, val: unknown) {
          if (col === "barcode" && val === null) state.isNullBarcode = true;
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
          const row = findRow(state.filters.id, state.filters.organization_id);
          if (row) return { data: { ...row }, error: null };
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        },
        maybeSingle: async () => {
          // The conditional barcode write.
          const row = findRow(state.filters.id, state.filters.organization_id);
          if (!row) return { data: null, error: null };
          // "barcode IS NULL" predicate: a concurrent winner already set it.
          if (state.isNullBarcode && row.barcode !== null) return { data: null, error: null };
          const nextBarcode = state.patch.barcode as string;
          // Org-unique index: another variant already holds this code.
          const clash = rows.find(
            (r) =>
              r.organization_id === row.organization_id &&
              r.id !== row.id &&
              r.barcode === nextBarcode,
          );
          if (clash) return { data: null, error: { message: UNIQUE_VIOLATION } };
          row.barcode = nextBarcode;
          return { data: { ...row }, error: null };
        },
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          // barcodeExistsForOrg: select("id") + limit, awaited directly.
          let exists: boolean;
          if (opts.existsSequence) {
            exists = opts.existsSequence[existsIdx++] ?? false;
          } else {
            exists = rows.some(
              (r) =>
                r.organization_id === state.filters.organization_id &&
                r.barcode === state.filters.barcode,
            );
          }
          return Promise.resolve({ data: exists ? [{ id: "x" }] : [], error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return q;
    },
    /** Test inspection: the live rows after the run. */
    rows,
  };
}

async function withStore<T>(opts: StoreOptions, fn: () => Promise<T>): Promise<T> {
  const { setProductRepositoryDbForTests } = await import("../server/products/repository");
  const store = makeStore(opts);
  const restore = setProductRepositoryDbForTests(store);
  try {
    return await fn();
  } finally {
    restore();
  }
}

describe("generateVariantBarcode", () => {
  it("mints a valid, org-branded APSA barcode and persists it", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const rows = [variant()];
    const store = makeStore({ rows });
    const { setProductRepositoryDbForTests } = await import("../server/products/repository");
    const restore = setProductRepositoryDbForTests(store);
    try {
      const result = await generateVariantBarcode(
        makeCtx(ORG_A, ["products.update_basic"]),
        VARIANT_ID,
        { serialFactory: () => "12345" },
      );
      expect(result.barcode).toBeTruthy();
      expect(isValidApsaBarcode(result.barcode!)).toBe(true);
      expect(result.barcode!.startsWith(`APSA${orgBarcodePrefix(ORG_A)}`)).toBe(true);
      // Actually written to the store (not just returned).
      expect(store.rows[0]!.barcode).toBe(result.barcode);
    } finally {
      restore();
    }
  });

  it("retries on collision until it finds a free code", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const serials = ["111", "222", "333"];
    let call = 0;
    const result = await withStore(
      { rows: [variant()], existsSequence: [true, true, false] }, // first two collide
      () =>
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => serials[call++]!,
        }),
    );
    expect(result.barcode).toContain("00000333");
    expect(call).toBe(3);
  });

  it("never overwrites an existing barcode (409)", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withStore({ rows: [variant({ barcode: "8850123456789" })] }, async () => {
      await expect(
        generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          serialFactory: () => "1",
        }),
      ).rejects.toThrow(/already has a barcode/i);
    });
  });

  it("gives up after exhausting attempts on relentless collisions", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withStore({ rows: [variant()], existsSequence: [true, true, true] }, async () => {
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
    await withStore({ rows: [variant()], orgFilters }, () =>
      generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
        serialFactory: () => "1",
      }),
    );
    expect(orgFilters.length).toBeGreaterThan(0);
    expect(orgFilters.every((o) => o === ORG_A)).toBe(true);
  });

  it("requires products.update_basic", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    await withStore({ rows: [variant()] }, async () => {
      await expect(
        generateVariantBarcode(makeCtx(ORG_A, []), VARIANT_ID, { serialFactory: () => "1" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("gives different organizations different code prefixes", () => {
    expect(orgBarcodePrefix(ORG_A)).not.toBe(orgBarcodePrefix(ORG_B));
  });

  // ── Blocker: concurrent same-variant generation ─────────────────────────────

  it("two concurrent generations for the same variant never both persist — the first wins, the second returns it", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    const rows = [variant()];
    const store = makeStore({ rows });
    const { setProductRepositoryDbForTests } = await import("../server/products/repository");
    const restore = setProductRepositoryDbForTests(store);
    try {
      const ctx = makeCtx(ORG_A, ["products.update_basic"]);
      // Distinct candidate codes so an overwrite would be observable: if the
      // race were unfixed, the second write (222) would clobber the first (111).
      const [a, b] = await Promise.all([
        generateVariantBarcode(ctx, VARIANT_ID, { serialFactory: () => "111" }),
        generateVariantBarcode(ctx, VARIANT_ID, { serialFactory: () => "222" }),
      ]);
      // Exactly one code is persisted, and BOTH callers observe that same code.
      expect(store.rows[0]!.barcode).toBeTruthy();
      expect(a.barcode).toBe(store.rows[0]!.barcode);
      expect(b.barcode).toBe(store.rows[0]!.barcode);
      expect(a.barcode).toBe(b.barcode);
      // The winner is the first-written code; the loser did not replace it.
      expect(store.rows[0]!.barcode).toContain("00000111");
    } finally {
      restore();
    }
  });

  // ── Manual barcode safety (§14) ─────────────────────────────────────────────

  it("updateVariant rejects a manual barcode Code 128 cannot encode, before writing", async () => {
    const { updateVariant } = await import("../server/products/service");
    const rows = [variant({ barcode: null })];
    const store = makeStore({ rows });
    const { setProductRepositoryDbForTests } = await import("../server/products/repository");
    const restore = setProductRepositoryDbForTests(store);
    try {
      await expect(
        updateVariant(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
          barcode: "88500 999", // non-breaking space — would crash label render
        }),
      ).rejects.toThrow(/Code 128|cannot be printed/i);
      // Nothing was written — the bad value never reached the store.
      expect(store.rows[0]!.barcode).toBeNull();
    } finally {
      restore();
    }
  });

  it("retries when the conditional write hits the org-unique index (cross-variant collision), not only the pre-read", async () => {
    const { generateVariantBarcode } = await import("../server/products/service");
    // Another variant in the SAME org already holds the code the first serial
    // would produce. The pre-read check is forced to say "free" (false) so the
    // write itself must be what rejects the clash — proving correctness does
    // not rely on the pre-read alone.
    const serials = ["111", "222"];
    let call = 0;
    // Exactly the code the first serial would mint, already held by another
    // variant in this org.
    const collidingCode = formatApsaBarcode(ORG_A, "111");
    const rows = [
      variant(),
      variant({ id: OTHER_VARIANT_ID, sku: "SKU-2", barcode: collidingCode }),
    ];
    const result = await withStore({ rows, existsSequence: [false, false] }, () =>
      generateVariantBarcode(makeCtx(ORG_A, ["products.update_basic"]), VARIANT_ID, {
        serialFactory: () => serials[call++]!,
      }),
    );
    // First candidate collided at the unique index; the retry (222) succeeded.
    expect(result.barcode).toContain("00000222");
    expect(call).toBe(2);
  });
});
