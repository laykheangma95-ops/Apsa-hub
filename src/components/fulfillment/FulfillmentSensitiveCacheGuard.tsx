/**
 * Evicts raw parcel-label PII (customer name, phone, address) from the React
 * Query cache when `customers.view_sensitive` stops holding — see
 * enforceFulfillmentSensitiveCache in src/lib/fulfillment-query.ts.
 *
 * Mounted once inside the /app CapabilityProvider, wrapping the shell, so it
 * renders (and evicts) before any fulfillment/label surface below it renders.
 * The Fulfillment counterpart of CustomerSensitiveCacheGuard, for the same
 * reason: a parcel label carries the same gated fields a customer profile does.
 * Renders nothing of its own.
 */
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCapabilities } from "@/hooks/use-capabilities";
import { enforceFulfillmentSensitiveCache } from "@/lib/fulfillment-query";

interface FulfillmentSensitiveCacheGuardProps {
  /** From the /app route guard's server-derived context. */
  userId: string;
  /** From the /app route guard's server-derived context. */
  organizationId: string;
  children: ReactNode;
}

export function FulfillmentSensitiveCacheGuard({
  userId,
  organizationId,
  children,
}: FulfillmentSensitiveCacheGuardProps) {
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  // Gated on fulfillment.print_label — the SAME capability the server requires
  // for the label (migration 046) — so the moment it stops holding, the label
  // PII leaves the cache. canSensitive, not can: a snapshot whose latest refresh
  // failed must not keep grant-era PII either. During render, not in an effect,
  // so no child paints from an entry that should already be gone.
  enforceFulfillmentSensitiveCache(
    queryClient,
    userId,
    organizationId,
    capabilities.canSensitive("fulfillment.print_label"),
  );
  return <>{children}</>;
}
