/**
 * Customer Intelligence for one customer, as the CURRENT grants allow it.
 *
 * The one read path Customer Detail uses. Three layers, in order:
 *
 *   1. Current grants (customerInsightGrants) — from the live capability view,
 *      never from booleans or section statuses inside a cached response.
 *   2. Cache identity — the query key carries the grant set it was requested
 *      under, and every entry under any other grant set is cancelled and
 *      removed (enforceCustomerInsightsGrants) before this render reads. A late
 *      response that left under old grants lands only in its own old key.
 *   3. Render-time redaction (redactCustomerInsights) — whatever payload is
 *      read, a section whose grant does not hold right now is withheld.
 *
 * Without customers.read AND orders.read nothing is fetched and nothing is
 * returned: `status: "hidden"`, `insights: null`.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getCustomerInsights } from "@/lib/api";
import {
  customerInsightGrants,
  customerInsightGrantsTag,
  redactCustomerInsights,
  type CustomerInsightGrants,
  type CustomerInsights,
} from "@/lib/customer-insights-view";
import { customerKeys, enforceCustomerInsightsGrants } from "@/lib/customers-query";

export type CustomerInsightsDisplay =
  | { status: "hidden" | "loading" | "error" | "unavailable"; insights: null }
  | { status: "ready"; insights: CustomerInsights };

export interface UseCustomerInsightsResult {
  display: CustomerInsightsDisplay;
  grants: CustomerInsightGrants;
  refetch: () => void;
}

export function useCustomerInsights(input: {
  userId: string;
  organizationId: string;
  customerId: string;
  /** False for a non-production (mock) customer id. */
  enabled: boolean;
}): UseCustomerInsightsResult {
  const { userId, organizationId, customerId, enabled } = input;
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();

  const grants = customerInsightGrants(capabilities);
  const grantsTag = customerInsightGrantsTag(grants);
  const allowed = enabled && grants.base;

  // Before the query below reads the cache.
  enforceCustomerInsightsGrants(queryClient, userId, organizationId, grantsTag);

  const query = useQuery({
    queryKey: customerKeys.insights(userId, organizationId, customerId, grantsTag),
    queryFn: () => getCustomerInsights(customerId),
    enabled: allowed,
  });

  const refetch = () => void query.refetch();
  if (!allowed) return { display: { status: "hidden", insights: null }, grants, refetch };
  if (query.isError) return { display: { status: "error", insights: null }, grants, refetch };
  if (!query.data) return { display: { status: "loading", insights: null }, grants, refetch };
  if (query.data.status === "unavailable")
    return { display: { status: "unavailable", insights: null }, grants, refetch };

  const insights = redactCustomerInsights(query.data.data, grants);
  return insights
    ? { display: { status: "ready", insights }, grants, refetch }
    : { display: { status: "hidden", insights: null }, grants, refetch };
}
