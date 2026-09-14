/**
 * Organization profile update (server-only) — powers Settings "Business" →
 * Edit (Phase 1).
 *
 * Scope note: PERMISSIONS_MATRIX.md §6 documents a split
 * organization.update_basic / organization.update_sensitive contract, but
 * only a single flat organization.update permission is actually seeded
 * (migrations 003 / 010), granted unconditionally to OWNER and MANAGER —
 * the matrix's "⚠️ limited/conditional" for MANAGER, and its Owner-only
 * "sensitive" bucket, are not implemented anywhere. Rather than guess at
 * that split (see CORRECTION-001 for what guessing here has cost before),
 * this phase edits only display_name and business_type — purely
 * descriptive fields with no legal, financial or URL-identity weight, so
 * no reasonable reading of the matrix would place them in "sensitive."
 * legal_name, slug, default_currency and country stay read-only until the
 * project owner resolves the gap (flagged in the PR description as a
 * candidate CORRECTIONS.md entry).
 *
 * Security:
 *   - Requires the caller's AuthorizationContext, built server-side from the
 *     validated session + the caller's own active membership — the id here
 *     is ctx.organizationId, never a client-supplied value.
 *   - Requires the `organization.update` permission (OWNER/MANAGER —
 *     migration 003/010).
 *   - Exact allowlist: only display_name/business_type are ever written.
 *     The caller-facing validator (src/lib/org-schema.ts,
 *     UpdateOrganizationProfileInputSchema, `.strict()`) already rejects any
 *     other field before this function ever runs — no mass assignment.
 *   - Best-effort audit (org.update — already in the audit vocabulary,
 *     src/server/auth/audit.ts, and NOT in MANDATORY_AUDIT_ACTIONS) with a
 *     before/after snapshot of exactly the two touched columns.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { auditLog } from "@/server/auth/audit";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { OrganizationProfile } from "./get-organization-profile";

export interface UpdateOrganizationProfileInput {
  displayName: string;
  businessType: string | null;
}

interface OrganizationProfileRow {
  display_name: string;
  legal_name: string;
  slug: string;
  business_type: string | null;
  default_currency: string;
  country: string;
}

const PROFILE_SELECT = "display_name, legal_name, slug, business_type, default_currency, country";

function toProfile(row: OrganizationProfileRow): OrganizationProfile {
  return {
    displayName: row.display_name,
    legalName: row.legal_name,
    slug: row.slug,
    businessType: row.business_type,
    defaultCurrency: row.default_currency,
    country: row.country,
  };
}

export async function updateOrganizationProfile(
  ctx: AuthorizationContext,
  input: UpdateOrganizationProfileInput,
): Promise<OrganizationProfile> {
  ctx.require("organization.update");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: beforeData, error: beforeError } = await (supabaseAdmin as any)
    .from("organizations")
    .select(PROFILE_SELECT)
    .eq("id", ctx.organizationId)
    .single();

  if (beforeError || !beforeData) {
    throw new Error(beforeError?.message ?? "Organization not found");
  }
  const before = beforeData as OrganizationProfileRow;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: afterData, error: afterError } = await (supabaseAdmin as any)
    .from("organizations")
    .update({
      display_name: input.displayName,
      business_type: input.businessType,
    })
    .eq("id", ctx.organizationId)
    .select(PROFILE_SELECT)
    .single();

  if (afterError || !afterData) {
    throw new Error(afterError?.message ?? "Organization update failed");
  }
  const after = afterData as OrganizationProfileRow;

  // Best-effort: org.update is not in MANDATORY_AUDIT_ACTIONS, so a logging
  // failure never blocks the merchant's save (mirrors products.price_change
  // in src/server/products/service.ts).
  await auditLog(ctx, {
    action: "org.update",
    resourceType: "organizations",
    resourceId: ctx.organizationId,
    beforeJson: { display_name: before.display_name, business_type: before.business_type },
    afterJson: { display_name: after.display_name, business_type: after.business_type },
  });

  return toProfile(after);
}
