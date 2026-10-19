/**
 * Onboarding form validation — client-safe, pure, and the UX layer only.
 *
 * The server re-validates everything through CreateOrganizationInputSchema
 * (src/lib/org-schema.ts) and the organizations table's CHECK constraints;
 * this module only decides which field message the founder sees first.
 *
 * Business currency is a deliberate choice, never a silent default. The
 * contract still defaults to USD for older callers, but the onboarding form
 * refuses to submit until the founder has picked USD or KHR themselves:
 * orders snapshot the organization's default_currency and the order RPC
 * refuses any product priced in a different currency, and Settings shows the
 * currency read-only, so a guessed value would quietly decide every price
 * the business ever sells at.
 */
import { isBusinessCurrency } from "@/lib/business-currency";
import { slugSchema, type CreateOrganizationInput } from "@/lib/org-schema";

export { BUSINESS_CURRENCIES } from "@/lib/business-currency";

export type OnboardingFieldError =
  "nameRequired" | "slugRequired" | "slugFormat" | "currencyRequired";

export interface OnboardingFormValues {
  name: string;
  slug: string;
  /** Empty until the founder chooses. */
  currency: string;
}

export interface OnboardingFieldErrors {
  name?: OnboardingFieldError;
  slug?: OnboardingFieldError;
  currency?: OnboardingFieldError;
}

export type OnboardingValidation =
  { ok: true; input: CreateOrganizationInput } | { ok: false; errors: OnboardingFieldErrors };

export function validateOnboardingForm(values: OnboardingFormValues): OnboardingValidation {
  const name = values.name.trim();
  const slug = values.slug.trim();
  const errors: OnboardingFieldErrors = {};

  if (name.length === 0) errors.name = "nameRequired";

  if (slug.length === 0) {
    errors.slug = "slugRequired";
  } else if (!slugSchema.safeParse(slug).success) {
    // Format only. Availability is decided by the database, never here.
    errors.slug = "slugFormat";
  }

  const currency = values.currency;
  if (!isBusinessCurrency(currency)) errors.currency = "currencyRequired";

  if (errors.name || errors.slug || !isBusinessCurrency(currency)) return { ok: false, errors };

  return { ok: true, input: { legalName: name, displayName: name, slug, currency } };
}
