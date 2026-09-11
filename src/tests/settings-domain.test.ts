/**
 * Settings "Business" section — src/server/org/get-organization-profile.ts.
 *
 * Covers:
 *  1. Missing organization.read permission is denied (Cashier/Sales/Customer
 *     Service — never granted this permission per migration 003/010).
 *  2. An authorized read (Owner/Manager) returns the mapped DTO.
 *  3. Tenant isolation: the query is always scoped by ctx.organizationId —
 *     switching the caller's org changes which row is read, and a guessed
 *     organization_id can never be passed in (there is no such parameter).
 *
 * get-organization-profile.ts statically imports supabaseAdmin (server-only
 * modules under src/server/* are allowed to — only src/api/* and
 * src/routes/* are required to use dynamic import; see bundle-boundary.test.ts).
 * That means the module's binding to supabaseAdmin is captured at first
 * import, so — same constraint as src/tests/team-repository.test.ts — the
 * mock.module call below must run before the ONE dynamic import of the
 * module under test, and every scenario reuses that same import.
 *
 * Run: bun test src/tests/settings-domain.test.ts
 */
import { describe, it, expect, mock } from "bun:test";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";

function makeCtx(opts: { organizationId: string; permissions: string[] }): AuthorizationContext {
  const perms = new Set(opts.permissions);
  return {
    userId: "user-1",
    organizationId: opts.organizationId,
    roleId: "role-1",
    systemRole: null,
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

type OrgRow = {
  display_name: string;
  legal_name: string;
  slug: string;
  business_type: string | null;
  default_currency: string;
  country: string;
};

const ORG_ROWS: Record<string, OrgRow> = {
  [ORG_A]: {
    display_name: "Dara Coffee",
    legal_name: "Dara Coffee Co., Ltd.",
    slug: "dara-coffee",
    business_type: "cafe",
    default_currency: "USD",
    country: "KH",
  },
  [ORG_B]: {
    display_name: "Other Shop",
    legal_name: "Other Shop Co., Ltd.",
    slug: "other-shop",
    business_type: "retail",
    default_currency: "KHR",
    country: "KH",
  },
};

const recordedFilters: Array<{ table: string; column: string; value: unknown }> = [];

mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          recordedFilters.push({ table, column, value });
          return {
            single: async () => {
              const row = ORG_ROWS[value as string];
              if (!row) return { data: null, error: { message: "not found" } };
              return { data: row, error: null };
            },
          };
        },
      }),
    }),
  },
}));

const { getOrganizationProfile } = await import("../server/org/get-organization-profile");

describe("getOrganizationProfile", () => {
  it("denies a caller without organization.read (Cashier/Sales/Customer Service)", async () => {
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["orders.read"] });
    await expect(getOrganizationProfile(ctx)).rejects.toThrow(ForbiddenError);
    await expect(getOrganizationProfile(ctx)).rejects.toThrow(
      "Missing permission: organization.read",
    );
  });

  it("returns the mapped business profile for an authorized caller (Owner/Manager)", async () => {
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["organization.read"] });
    const profile = await getOrganizationProfile(ctx);
    expect(profile).toEqual({
      displayName: "Dara Coffee",
      legalName: "Dara Coffee Co., Ltd.",
      slug: "dara-coffee",
      businessType: "cafe",
      defaultCurrency: "USD",
      country: "KH",
    });
  });

  it("scopes the read to the caller's own organization — never a guessed or cross-org id", async () => {
    recordedFilters.length = 0;
    const ctxA = makeCtx({ organizationId: ORG_A, permissions: ["organization.read"] });
    const ctxB = makeCtx({ organizationId: ORG_B, permissions: ["organization.read"] });

    const profileA = await getOrganizationProfile(ctxA);
    const profileB = await getOrganizationProfile(ctxB);

    expect(profileA.displayName).toBe("Dara Coffee");
    expect(profileB.displayName).toBe("Other Shop");
    expect(recordedFilters).toEqual([
      { table: "organizations", column: "id", value: ORG_A },
      { table: "organizations", column: "id", value: ORG_B },
    ]);
  });

  it("fails closed when the caller's own organization row cannot be found", async () => {
    const ctx = makeCtx({ organizationId: "unknown-org-id", permissions: ["organization.read"] });
    await expect(getOrganizationProfile(ctx)).rejects.toThrow();
  });
});
