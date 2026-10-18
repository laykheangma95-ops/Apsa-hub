import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getBusinessCurrencyFn } from "@/api/org";
import { useAppPrincipal } from "@/hooks/use-app-principal";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  businessCurrencyQueryKey,
  resolveBusinessCurrencyState,
  verifyBusinessCurrency,
  type BusinessCurrencyState,
  type MoneyBinding,
} from "@/lib/business-currency";

export interface BusinessCurrencyLookup {
  state: BusinessCurrencyState;
  /** Re-run a failed lookup. */
  retry: () => void;
  /**
   * Ask the server again, bypassing the cache, and resolve true only if it
   * still answers `binding`'s organization and currency. Called immediately
   * before a create, so a form bound to organization A does not submit after
   * the session has moved to B.
   */
  confirm: (binding: MoneyBinding) => Promise<boolean>;
}

/**
 * The signed-in member's business currency for Add Product.
 *
 * The principal is the /app guard's server-derived one (useAppPrincipal), the
 * cache key carries it, and every response is checked against it, so a reply
 * for another organization is rejected rather than shown. Pending, failed and
 * refused lookups each surface as their own state — never as a default.
 */
export function useBusinessCurrency(enabled = true): BusinessCurrencyLookup {
  const principal = useAppPrincipal();
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const canCreate = capabilities.can("products.create");
  const organizationId = principal?.organizationId ?? "";
  const userId = principal?.userId ?? "";

  const query = useQuery({
    queryKey: businessCurrencyQueryKey(userId, organizationId),
    queryFn: async () => verifyBusinessCurrency(await getBusinessCurrencyFn(), organizationId),
    retry: false,
    enabled: enabled && canCreate && principal !== null,
  });

  const state = resolveBusinessCurrencyState({
    principal,
    canCreate,
    query: { isError: query.isError, error: query.error, data: query.data },
  });

  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  const confirm = useCallback(
    async (binding: MoneyBinding) => {
      if (!principal || binding.organizationId !== principal.organizationId) return false;
      try {
        const fresh = await queryClient.fetchQuery({
          queryKey: businessCurrencyQueryKey(principal.userId, binding.organizationId),
          queryFn: async () =>
            verifyBusinessCurrency(await getBusinessCurrencyFn(), binding.organizationId),
          staleTime: 0,
          retry: false,
        });
        return (
          fresh.organizationId === binding.organizationId && fresh.currency === binding.currency
        );
      } catch {
        return false;
      }
    },
    [principal, queryClient],
  );

  return { state, retry, confirm };
}
