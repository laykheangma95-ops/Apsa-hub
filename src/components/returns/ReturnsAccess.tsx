import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { enforceReturnsCapabilityCache } from "@/lib/returns";

/**
 * Fail-closed rendering boundary for cached return data (list, detail).
 *
 * `children` is a function so the authorized subtree — including any header
 * that would name an order — is not evaluated at all once the member may not
 * see returns, even if React Query still holds a payload fetched while the
 * grant existed. The same boolean gates the queries, this boundary and the
 * cache; eviction happens before children() could read anything.
 */
export function ReturnsAccess({
  userId,
  organizationId,
  allowed,
  denied,
  children,
}: {
  userId: string;
  organizationId: string;
  allowed: boolean;
  denied: ReactNode;
  children: () => ReactNode;
}) {
  const queryClient = useQueryClient();
  enforceReturnsCapabilityCache(queryClient, userId, organizationId, allowed);
  return <>{allowed ? children() : denied}</>;
}
