/**
 * Settings "Business" section → Edit (Phase 1) —
 * src/server/org/update-organization-profile.ts,
 * src/lib/org-schema.ts#UpdateOrganizationProfileInputSchema.
 *
 * Covers:
 *  1. Missing organization.update permission is denied (read-only callers —
 *     organization.read alone is not enough to write).
 *  2. An authorized caller (Owner/Manager, organization.update) updates only
 *     display_name/business_type and gets back the full mapped DTO.
 *  3. Tenant isolation: the write is always scoped by ctx.organizationId —
 *     there is no organizationId parameter for a caller to override, and two
 *     contexts for two different orgs write two different rows.
 *  4. The validator rejects unknown fields (mass-assignment guard) and
 *     invalid values (empty/over-length name, over-length type).
 *  5. A best-effort audit row is written with a before/after snapshot of
 *     exactly the two touched columns — never the untouched ones.
 *  6. The UI wiring: the sheet is gated on organization.update, cache is
 *     written (not just invalidated) on success, and there is no mock
 *     success fallback in the client wrapper.
 *
 * Mirrors src/tests/settings-domain.test.ts's mock/import-order constraints:
 * update-organization-profile.ts statically imports supabaseAdmin, so
 * mock.module must run before the one dynamic import of the module under
 * test.
 *
 * Run: bun test src/tests/settings-business-update.test.ts
 */
import { describe, it, expect, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";
import { UpdateOrganizationProfileInputSchema } from "../lib/org-schema";

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

const updateCalls: Array<{ orgId: string; patch: Record<string, unknown> }> = [];
const auditRows: Array<Record<string, unknown>> = [];

// Deliberately does NOT mock "@/server/auth/audit" — that module is imported
// (unmocked) by other test files in the same bun test run, and mock.module()
// replaces a module path process-wide, not per file. Mocking it here would
// silently swap out the real auditLog()/MANDATORY_AUDIT_ACTIONS guard for
// every file that happens to run afterwards (this broke
// tenant-isolation.test.ts's "auditLog() rejects mandatory-audit actions"
// coverage the first time this file was written). Instead the audit_logs
// table itself is faked below, so the real auditLog() runs unmodified.
mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "audit_logs") {
        return {
          insert: (row: Record<string, unknown>) => {
            auditRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select: () => ({
          eq: (_column: string, value: unknown) => ({
            single: async () => {
              const row = ORG_ROWS[value as string];
              if (!row) return { data: null, error: { message: "not found" } };
              return { data: row, error: null };
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, value: unknown) => ({
            select: () => ({
              single: async () => {
                const existing = ORG_ROWS[value as string];
                if (!existing) return { data: null, error: { message: "not found" } };
                // Simulate the write: only the columns actually sent change.
                const updated = { ...existing, ...patch };
                ORG_ROWS[value as string] = updated;
                updateCalls.push({ orgId: value as string, patch });
                return { data: updated, error: null };
              },
            }),
          }),
        }),
      };
    },
  },
}));

const { updateOrganizationProfile } = await import("../server/org/update-organization-profile");

describe("updateOrganizationProfile", () => {
  it("denies a caller without organization.update (read-only organization.read)", async () => {
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["organization.read"] });
    await expect(
      updateOrganizationProfile(ctx, { displayName: "New Name", businessType: null }),
    ).rejects.toThrow("Missing permission: organization.update");
  });

  it("updates display_name and business_type for an authorized caller", async () => {
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["organization.update"] });
    const result = await updateOrganizationProfile(ctx, {
      displayName: "Dara Coffee & Pastry",
      businessType: "bakery",
    });
    expect(result).toEqual({
      displayName: "Dara Coffee & Pastry",
      legalName: "Dara Coffee Co., Ltd.",
      slug: "dara-coffee",
      businessType: "bakery",
      defaultCurrency: "USD",
      country: "KH",
    });
    // legal_name, slug, default_currency, country were never sent in the patch.
    expect(updateCalls.at(-1)?.patch).toEqual({
      display_name: "Dara Coffee & Pastry",
      business_type: "bakery",
    });
  });

  it("scopes the write to the caller's own organization — there is no id parameter to override", async () => {
    updateCalls.length = 0;
    const ctxA = makeCtx({ organizationId: ORG_A, permissions: ["organization.update"] });
    const ctxB = makeCtx({ organizationId: ORG_B, permissions: ["organization.update"] });

    await updateOrganizationProfile(ctxA, { displayName: "Org A Name", businessType: null });
    await updateOrganizationProfile(ctxB, { displayName: "Org B Name", businessType: null });

    expect(updateCalls.map((c) => c.orgId)).toEqual([ORG_A, ORG_B]);
    expect(ORG_ROWS[ORG_A]?.display_name).toBe("Org A Name");
    expect(ORG_ROWS[ORG_B]?.display_name).toBe("Org B Name");
  });

  it("fails closed when the caller's own organization row cannot be found", async () => {
    const ctx = makeCtx({ organizationId: "unknown-org-id", permissions: ["organization.update"] });
    await expect(
      updateOrganizationProfile(ctx, { displayName: "X", businessType: null }),
    ).rejects.toThrow();
  });

  it("writes a best-effort audit row with a before/after snapshot of only the touched columns", async () => {
    auditRows.length = 0;
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["organization.update"] });
    await updateOrganizationProfile(ctx, { displayName: "Audited Name", businessType: "retail" });

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row?.["action"]).toBe("org.update");
    expect(row?.["resource_type"]).toBe("organizations");
    expect(row?.["resource_id"]).toBe(ORG_A);
    expect(row?.["organization_id"]).toBe(ORG_A);
    const before = row?.["before_json"] as Record<string, unknown>;
    const after = row?.["after_json"] as Record<string, unknown>;
    expect(Object.keys(before)).toEqual(["display_name", "business_type"]);
    expect(Object.keys(after)).toEqual(["display_name", "business_type"]);
    expect(after["display_name"]).toBe("Audited Name");
  });
});

describe("UpdateOrganizationProfileInputSchema — allowlist and validation", () => {
  it("accepts a valid patch", () => {
    const result = UpdateOrganizationProfileInputSchema.parse({
      displayName: "Valid Name",
      businessType: "retail",
    });
    expect(result).toEqual({ displayName: "Valid Name", businessType: "retail" });
  });

  it("allows businessType to be cleared to null", () => {
    const result = UpdateOrganizationProfileInputSchema.parse({
      displayName: "Valid Name",
      businessType: null,
    });
    expect(result.businessType).toBeNull();
  });

  it("normalizes an empty businessType string to null", () => {
    const result = UpdateOrganizationProfileInputSchema.parse({
      displayName: "Valid Name",
      businessType: "  ",
    });
    expect(result.businessType).toBeNull();
  });

  it("rejects an unknown field — no mass assignment (e.g. slug, organizationId, legalName)", () => {
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "Valid Name",
        businessType: null,
        slug: "new-slug",
      }),
    ).toThrow();
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "Valid Name",
        businessType: null,
        organizationId: ORG_B,
      }),
    ).toThrow();
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "Valid Name",
        businessType: null,
        legalName: "Sneaky Legal Name Co.",
      }),
    ).toThrow();
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "Valid Name",
        businessType: null,
        defaultCurrency: "KHR",
      }),
    ).toThrow();
  });

  it("rejects an empty display name", () => {
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({ displayName: "   ", businessType: null }),
    ).toThrow();
  });

  it("rejects a display name over 255 characters", () => {
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "x".repeat(256),
        businessType: null,
      }),
    ).toThrow();
  });

  it("rejects a business type over 100 characters", () => {
    expect(() =>
      UpdateOrganizationProfileInputSchema.parse({
        displayName: "Valid Name",
        businessType: "x".repeat(101),
      }),
    ).toThrow();
  });
});

describe("UI wiring — Settings Business edit", () => {
  const ROOT = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

  it("gates the edit affordance on organization.update, distinct from the organization.read gate", () => {
    const source = read("src/routes/app.settings.tsx");
    expect(source).toContain('capabilities.can("organization.update")');
    expect(source).toContain('capabilities.can("organization.read")');
  });

  it("writes the fresh profile into the exact read query's cache on success — no stale name after save", () => {
    const source = read("src/routes/app.settings.tsx");
    expect(source).toContain("queryClient.setQueryData(ORGANIZATION_PROFILE_QUERY_KEY, updated)");
    expect(source).toContain("queryKey: ORGANIZATION_PROFILE_QUERY_KEY");
  });

  it("the edit sheet guards against a double-submit while a save is already in flight", () => {
    const source = read("src/components/settings/EditBusinessProfileSheet.tsx");
    expect(source).toContain("if (saving) return;");
  });

  it("the client wrapper has no mock success fallback — a thrown error always surfaces", () => {
    const source = read("src/lib/settings-view.ts");
    const updateFnSource = source.slice(
      source.indexOf("export async function updateBusinessProfile"),
    );
    expect(updateFnSource).not.toMatch(/mock|fallback|catch\s*\(/i);
  });
});
