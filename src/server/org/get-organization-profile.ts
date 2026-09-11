/**
 * Organization profile read (server-only) — powers the Settings "Business"
 * section.
 *
 * Read-only by design: no organization *update* path exists yet (only
 * create_organization_for_founder — migration 009), so this module never
 * writes. Editing business details is a separate, not-yet-built phase.
 *
 * Security:
 *   - Requires the caller's AuthorizationContext, built server-side from the
 *     validated session + the caller's own active membership — the id here
 *     is ctx.organizationId, never a client-supplied value.
 *   - Requires the `organization.read` permission (seeded for OWNER/MANAGER
 *     only — migration 003/010), so Cashier/Sales/Customer Service get a
 *     real 403, not a hidden UI button.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { AuthorizationContext } from "@/server/auth/authorization";

export interface OrganizationProfile {
  displayName: string;
  legalName: string;
  slug: string;
  businessType: string | null;
  defaultCurrency: string;
  country: string;
}

interface OrganizationProfileRow {
  display_name: string;
  legal_name: string;
  slug: string;
  business_type: string | null;
  default_currency: string;
  country: string;
}

export async function getOrganizationProfile(
  ctx: AuthorizationContext,
): Promise<OrganizationProfile> {
  ctx.require("organization.read");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("organizations")
    .select("display_name, legal_name, slug, business_type, default_currency, country")
    .eq("id", ctx.organizationId)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Organization not found");
  }

  const row = data as OrganizationProfileRow;
  return {
    displayName: row.display_name,
    legalName: row.legal_name,
    slug: row.slug,
    businessType: row.business_type,
    defaultCurrency: row.default_currency,
    country: row.country,
  };
}
