/**
 * Evicts raw customer PII from the React Query cache when
 * `customers.view_sensitive` stops holding — see
 * enforceCustomerSensitiveCache in src/lib/customers-query.ts.
 *
 * Mounted once inside the /app CapabilityProvider, wrapping the shell, so it
 * renders (and evicts) before any customer surface below it renders. Renders
 * nothing of its own.
 */
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/hooks/use-capabilities";
import { enforceCustomerSensitiveCache } from "@/lib/customers-query";

interface CustomerSensitiveCacheGuardProps {
  /** From the /app route guard's server-derived context. */
  userId: string;
  /** From the /app route guard's server-derived context. */
  organizationId: string;
  children: ReactNode;
}

export function CustomerSensitiveCacheGuard({
  userId,
  organizationId,
  children,
}: CustomerSensitiveCacheGuardProps) {
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  // canSensitive, not can: a snapshot whose latest refresh failed must not
  // keep grant-era PII in the cache either. During render, not in an effect,
  // so no child paints from an entry that should already be gone.
  enforceCustomerSensitiveCache(
    queryClient,
    userId,
    organizationId,
    capabilities.canSensitive("customers.view_sensitive"),
  );
  return <>{children}</>;
}
