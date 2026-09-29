/**
 * Browser fixture for the parcel-label permission-revocation and nested-focus
 * regressions. Mounts the REAL <ParcelLabelDialog> under the REAL
 * <FulfillmentSensitiveCacheGuard> and the REAL <CapabilityProvider>. The
 * grant lives in an in-page fake server (parcel-label-capabilities-stub.ts), so
 * a revocation is discovered through the production capability query.
 */
import { DEFAULT_LANGUAGE } from "@/lib/i18n";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ParcelLabelDialog } from "@/components/labels/ParcelLabelDialog";
import { FulfillmentSensitiveCacheGuard } from "@/components/fulfillment/FulfillmentSensitiveCacheGuard";
import { CapabilityProvider } from "@/hooks/use-capabilities";
import { ALL_GRANTED, ORG_ID, USER_ID } from "./parcel-label-capabilities-stub";

const ORDER_ID = "6f1a6a2e-1f9c-4a6d-9a3b-2c5d7e8f9a01";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      {/* The REAL provider, seeded like the /app loader's SSR snapshot. */}
      <CapabilityProvider
        userId={USER_ID}
        organizationId={ORG_ID}
        initialResult={{
          status: "active",
          userId: USER_ID,
          organizationId: ORG_ID,
          role: "STAFF",
          permissions: ALL_GRANTED,
        }}
      >
        <FulfillmentSensitiveCacheGuard userId={USER_ID} organizationId={ORG_ID}>
          <button id="trigger" type="button" onClick={() => setOpen(true)}>
            Print label
          </button>
          <ParcelLabelDialog
            open={open}
            onClose={() => setOpen(false)}
            orderIds={[ORDER_ID]}
            userId={USER_ID}
            organizationId={ORG_ID}
          />
        </FulfillmentSensitiveCacheGuard>
      </CapabilityProvider>
    </QueryClientProvider>
  );
}

// Referencing the binding keeps the i18n module (and its synchronous init) in the bundle.
document.documentElement.setAttribute("lang", DEFAULT_LANGUAGE);

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
}
