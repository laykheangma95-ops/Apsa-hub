/**
 * Product create × principal binding — the authoritative server boundary
 * (PR #130 final P2 #2).
 *
 * The defect: a form confirmed in organization A, submitted after the session
 * moved to B, was created under B — the create used whatever organization the
 * session resolved, and nothing tied the request to the one it was initiated
 * under. Now createProductFn requires `expected` (user, organization,
 * currency) and the service refuses any mismatch BEFORE a product or variant
 * row is written. `expected` is a consistency check only: authority is still
 * the session + active membership, so a forged `expected` naming another
 * organization is refused, never honoured.
 *
 * What is REAL: createProductFn's validator and handler (src/api/products.ts),
 * resolveAuthContext, the products service createProduct, and the server
 * currency read getBusinessCurrency. Replaced: the server-fn factory (calls
 * validator + handler directly), the session cookie, the active-membership
 * lookup, AuthorizationService (permission set), the organizations table read
 * and the product repository (recording writes).
 *
 * Runs in its own process (product-create-principal-binding.test.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const USER = "cccccccc-0000-4000-8000-00000000000c";
const OTHER_USER = "dddddddd-0000-4000-8000-00000000000d";
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => {
    const build = (validator?: (d: unknown) => any) => ({
      validator: (v: (d: unknown) => any) => build(v),
      handler: (fn: (args: { data: any }) => any) => async (args?: { data?: unknown }) =>
        fn({ data: validator ? validator(args?.data) : args?.data }),
    });
    return build();
  },
}));

let session: { userId: string; emailVerified: boolean } | null;
let activeOrg: string | null;
let permissions: Set<string>;
let defaultCurrency: Record<string, string>;

mock.module("@/api/auth", () => ({ getSessionFn: async () => session }));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => activeOrg,
}));
const realAuthorization = await import("@/server/auth/authorization");
mock.module("@/server/auth/authorization", () => ({
  ...realAuthorization,
  AuthorizationService: {
    forRequest: async (userId: string, organizationId: string) => ({
      userId,
      organizationId,
      can: (key: string) => permissions.has(key),
      require: (key: string) => {
        if (!permissions.has(key)) {
          throw new realAuthorization.ForbiddenError(`Missing permission: ${key}`);
        }
      },
    }),
  },
}));

const orgReads: string[] = [];
mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: async () => {
            orgReads.push(`${table}:${id}`);
            return id in defaultCurrency
              ? { data: { default_currency: defaultCurrency[id] }, error: null }
              : { data: null, error: { message: "not found" } };
          },
        }),
      }),
    }),
  },
}));

const writes: { table: string; organizationId: string; row: any }[] = [];
const realRepo = await import("@/server/products/repository");
mock.module("@/server/products/repository", () => ({
  ...realRepo,
  createProduct: async (organizationId: string, input: any) => {
    writes.push({ table: "products", organizationId, row: input });
    return {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      status: "ACTIVE",
      ...input,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
    };
  },
  createVariant: async (organizationId: string, productId: string, input: any) => {
    writes.push({ table: "product_variants", organizationId, row: input });
    return {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      product_id: productId,
      status: "ACTIVE",
      ...input,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
    };
  },
}));

const { createProductFn } = await import("@/api/products");
const { CREATE_BINDING_CHANGED_MESSAGE } = await import("@/lib/business-currency");

function payload(
  expected: { userId: string; organizationId: string; currency: string } | undefined,
  price: { amount: number; currency: string },
  cost?: { amount: number; currency: string },
) {
  return {
    name_km: "កាហ្វេ",
    name_en: null,
    description_km: null,
    category_id: null,
    initialVariant: {
      sku: null,
      barcode: null,
      name: "",
      price_amount: price.amount,
      price_currency: price.currency,
      cost_amount: cost?.amount ?? null,
      cost_currency: cost?.currency ?? null,
      weight_grams: null,
    },
    ...(expected ? { expected } : {}),
  };
}

const create = (data: unknown) => (createProductFn as any)({ data });

beforeEach(() => {
  session = { userId: USER, emailVerified: true };
  activeOrg = ORG_A;
  permissions = new Set(["products.create", "products.view_cost"]);
  defaultCurrency = { [ORG_A]: "KHR", [ORG_B]: "USD" };
  writes.length = 0;
  orgReads.length = 0;
});

const BOUND_A = { userId: USER, organizationId: ORG_A, currency: "KHR" };

describe("legitimate creates", () => {
  it("KHR business: product and variant written under the session's organization, in riel", async () => {
    const product = await create(
      payload(BOUND_A, { amount: 5000, currency: "KHR" }, { amount: 2000, currency: "KHR" }),
    );
    expect(writes.map((w) => [w.table, w.organizationId])).toEqual([
      ["products", ORG_A],
      ["product_variants", ORG_A],
    ]);
    expect(writes[0]!.row.created_by).toBe(USER);
    expect(writes[1]!.row).toMatchObject({
      price_amount: 5000,
      price_currency: "KHR",
      cost_amount: 2000,
      cost_currency: "KHR",
    });
    expect(product.organizationId ?? product.organization_id).toBe(ORG_A);
  });

  it("USD business: written in cents under that organization", async () => {
    activeOrg = ORG_B;
    await create(
      payload(
        { userId: USER, organizationId: ORG_B, currency: "USD" },
        { amount: 1250, currency: "USD" },
      ),
    );
    expect(writes.map((w) => w.organizationId)).toEqual([ORG_B, ORG_B]);
    expect(writes[1]!.row).toMatchObject({ price_amount: 1250, price_currency: "USD" });
  });
});

describe("refused before any product or variant write", () => {
  it("organization switched after currency confirmation (A confirmed, session now B)", async () => {
    activeOrg = ORG_B;
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      CREATE_BINDING_CHANGED_MESSAGE,
    );
    expect(writes).toEqual([]);
  });

  it("principal switched during creation (another user's session)", async () => {
    session = { userId: OTHER_USER, emailVerified: true };
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      CREATE_BINDING_CHANGED_MESSAGE,
    );
    expect(writes).toEqual([]);
  });

  it("expected organization is not authority: naming B from an A session is refused", async () => {
    await expect(
      create(
        payload(
          { userId: USER, organizationId: ORG_B, currency: "USD" },
          { amount: 1250, currency: "USD" },
        ),
      ),
    ).rejects.toThrow(CREATE_BINDING_CHANGED_MESSAGE);
    expect(writes).toEqual([]);
    expect(orgReads).toEqual([]); // B is never even read
  });

  it("revoked products.create: refused, nothing read or written", async () => {
    permissions.delete("products.create");
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      "Missing permission: products.create",
    );
    expect(writes).toEqual([]);
    expect(orgReads).toEqual([]);
  });

  it("business currency changed after confirmation (A now sells in USD)", async () => {
    defaultCurrency[ORG_A] = "USD";
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      CREATE_BINDING_CHANGED_MESSAGE,
    );
    expect(writes).toEqual([]);
  });

  it("price or cost in a currency other than the bound one", async () => {
    await expect(create(payload(BOUND_A, { amount: 1250, currency: "USD" }))).rejects.toThrow(
      CREATE_BINDING_CHANGED_MESSAGE,
    );
    await expect(
      create(payload(BOUND_A, { amount: 5000, currency: "KHR" }, { amount: 3, currency: "USD" })),
    ).rejects.toThrow(CREATE_BINDING_CHANGED_MESSAGE);
    expect(writes).toEqual([]);
  });

  it("a create without `expected` is rejected by the validator", async () => {
    await expect(create(payload(undefined, { amount: 5000, currency: "KHR" }))).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("no session / no active membership: refused before anything is read", async () => {
    session = null;
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      "Not authenticated",
    );
    session = { userId: USER, emailVerified: true };
    activeOrg = null;
    await expect(create(payload(BOUND_A, { amount: 5000, currency: "KHR" }))).rejects.toThrow(
      "No active organization membership",
    );
    expect(writes).toEqual([]);
    expect(orgReads).toEqual([]);
  });
});
