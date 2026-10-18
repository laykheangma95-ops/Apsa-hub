/**
 * Business currency read (server-only) — what Add Product prices in.
 *
 * Returns organizations.default_currency together with the organization id it
 * was read for. The id is not authority (the client never sends one back):
 * it lets the browser reject a response that was answered for a different
 * organization than the one its form is bound to — a late reply after an
 * organization switch, or a cached value from another membership.
 *
 * Security:
 *   - ctx comes from the validated session + the caller's own active
 *     membership; the organization is ctx.organizationId, never client input.
 *   - Requires `products.create`, the same permission as the create path this
 *     read serves, so the form never depends on a settings permission
 *     (organization.read) to know its own currency.
 *   - An unexpected stored value is an error, never coerced to a default.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { Currency } from "@/types";

export interface BusinessCurrency {
  organizationId: string;
  currency: Currency;
}

export async function getBusinessCurrency(ctx: AuthorizationContext): Promise<BusinessCurrency> {
  ctx.require("products.create");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("organizations")
    .select("default_currency")
    .eq("id", ctx.organizationId)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Organization not found");
  }

  const currency = (data as { default_currency: unknown }).default_currency;
  if (currency !== "USD" && currency !== "KHR") {
    throw new Error("Organization has no supported business currency");
  }

  return { organizationId: ctx.organizationId, currency };
}
