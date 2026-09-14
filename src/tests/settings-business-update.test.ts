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
 *  5. The audit payload builder produces a before/after snapshot of exactly
 *     the two touched columns — never the untouched ones.
 *  6. The UI wiring: the sheet is gated on organization.update, cache is
 *     written (not just invalidated) on success, and there is no mock
 *     success fallback in the client wrapper.
 *
 * Mirrors src/tests/settings-domain.test.ts's mock/import-order constraints:
 * update-organization-profile.ts statically imports supabaseAdmin, so
 * mock.module must run before the one dynamic import of the module under
 * test.
 *
 * Deliberately does NOT mock "@/server/auth/audit" to assert on the
 * auditLog() call itself. update-organization-profile.ts's own
 * `import { auditLog } from "@/server/auth/audit"` resolves at THIS file's
 * top-level dynamic import below, so any mock.module("@/server/auth/audit", ...)
 * registered before that import would need to run at this file's top level
 * too — and unlike src/tests/team-domain.test.ts's installPassthroughAuthMocks()
 * (which registers its audit mock lazily, inside individual it() bodies,
 * long after every file's top-level code has already run), a top-level
 * mock.module call here executes during Bun's file-collection phase, where
 * it can — and, once, did in CI — leak into another file's OWN top-level
 * `import { auditLog, MANDATORY_AUDIT_ACTIONS } from "../server/auth/audit"`
 * (tenant-isolation.test.ts's "auditLog() rejects mandatory-audit actions"
 * guard), depending on file-processing order. Faking the audit_logs table
 * through the supabaseAdmin mock instead was tried next and turned out to
 * have the same fragility one level down (audit.ts's own separate
 * `import { supabaseAdmin }` is captured whenever some other file first
 * transitively loads audit.ts, not necessarily after this file's mock is in
 * place) — it passed every local run, including the exact CI command
 * repeated, but still failed once for real in CI (0 audit rows observed).
 * The robust fix is to not depend on cross-file module-registry timing at
 * all: the exact before/after shape is asserted directly against the pure
 * buildProfileAuditSnapshot() helper below, and updateOrganizationProfile()
 * is proven not to depend on auditLog() succeeding (best-effort) by the
 * "still saves" test, which runs against the real, unmocked auditLog and
 * lets its DB write no-op against this file's organizations-only
 * supabaseAdmin fake.
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

mock.module("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (_table: string) => ({
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
      // Real auditLog() (unmocked — see the file header) calls
      // .from("audit_logs").insert(...). A real Supabase client reports a
      // DB-level failure as a resolved `{ error }`, never a thrown
      // exception, so this mirrors that instead of leaving `.insert`
      // undefined (which would throw and — since audit.ts has no try/catch
      // of its own — reject the caller's await, wrongly failing the save).
      insert: (_row: Record<string, unknown>) =>
        Promise.resolve({ error: { message: "audit_logs not implemented in this test" } }),
    }),
  },
}));

const { updateOrganizationProfile, buildProfileAuditSnapshot } =
  await import("../server/org/update-organization-profile");

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

  it("still saves when the (real, unmocked) best-effort audit write cannot persist", async () => {
    // No "audit_logs" branch is faked in this file's supabaseAdmin mock, so
    // the real auditLog() hits `.from("audit_logs").insert` on an object
    // that doesn't implement it, throws, and — because org.update is not in
    // MANDATORY_AUDIT_ACTIONS — is swallowed exactly like a real DB outage
    // would be. The save must still succeed.
    const ctx = makeCtx({ organizationId: ORG_A, permissions: ["organization.update"] });
    const result = await updateOrganizationProfile(ctx, {
      displayName: "Survives Audit Failure",
      businessType: null,
    });
    expect(result.displayName).toBe("Survives Audit Failure");
  });
});

describe("buildProfileAuditSnapshot", () => {
  it("carries only display_name/business_type, before and after — never the untouched columns", () => {
    const before = { display_name: "Old Name", business_type: "cafe" };
    const after = { display_name: "New Name", business_type: "bakery" };
    const snapshot = buildProfileAuditSnapshot(before, after);

    expect(snapshot.beforeJson).toEqual({ display_name: "Old Name", business_type: "cafe" });
    expect(snapshot.afterJson).toEqual({ display_name: "New Name", business_type: "bakery" });
    expect(Object.keys(snapshot.beforeJson)).toEqual(["display_name", "business_type"]);
    expect(Object.keys(snapshot.afterJson)).toEqual(["display_name", "business_type"]);
  });

  it("carries a null business_type through unchanged", () => {
    const snapshot = buildProfileAuditSnapshot(
      { display_name: "Name", business_type: "retail" },
      { display_name: "Name", business_type: null },
    );
    expect(snapshot.afterJson["business_type"]).toBeNull();
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
