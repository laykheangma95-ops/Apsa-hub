import { useQuery } from "@tanstack/react-query";
import { getOrganizationProfileFn } from "@/api/org";
import { useCapabilities } from "@/hooks/use-capabilities";
import { isBusinessCurrency } from "@/lib/business-currency";
import { ORGANIZATION_PROFILE_QUERY_KEY } from "@/lib/settings-view";
import type { Currency } from "@/types";

/**
 * The signed-in member's business currency, or null while it is unknown.
 *
 * Reads the same business-profile query as Home and Settings (same key, same
 * organization.read gate, so it is usually already cached and is purged with
 * the rest of the settings partition on a principal change). A member
 * without organization.read, a pending read, or a failed read all resolve to
 * null — callers fall back to their previous behaviour rather than guess.
 */
export function useBusinessCurrency(enabled = true): Currency | null {
  const capabilities = useCapabilities();
  const canReadOrganization = capabilities.can("organization.read");
  const profileQuery = useQuery({
    queryKey: ORGANIZATION_PROFILE_QUERY_KEY,
    queryFn: () => getOrganizationProfileFn(),
    retry: false,
    enabled: enabled && canReadOrganization,
  });

  if (!canReadOrganization) return null;
  const currency = profileQuery.data?.defaultCurrency;
  return isBusinessCurrency(currency) ? currency : null;
}
