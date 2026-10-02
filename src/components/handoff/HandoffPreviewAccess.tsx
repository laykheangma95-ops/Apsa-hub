import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { enforceHandoffCapabilityCache } from "@/lib/handoff-query";

/**
 * Fail-closed rendering boundary for cached Handoff preview data.
 *
 * `children` is a function so the authorized subtree is not evaluated at all
 * after the current capability snapshot loses `delivery.handoff`, even if
 * React Query still holds a preview fetched while the grant existed.
 */
export function HandoffPreviewAccess({
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

  // The same boolean gates the query, this render boundary, and the cache.
  // Eviction happens before children() can read a retained preview.
  enforceHandoffCapabilityCache(queryClient, userId, organizationId, allowed);

  return <>{allowed ? children() : denied}</>;
}
