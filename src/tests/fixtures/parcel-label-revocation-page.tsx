/**
 * Browser fixture for the parcel-label permission-revocation and nested-focus
 * regressions. Mounts the REAL <ParcelLabelDialog> under the REAL
 * <FulfillmentSensitiveCacheGuard>; only the capability set is driven by a
 * button (`#revoke` / `#grant`), standing in for a live permission change.
 */
import { DEFAULT_LANGUAGE } from "@/lib/i18n";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ParcelLabelDialog } from "@/components/labels/ParcelLabelDialog";
import { FulfillmentSensitiveCacheGuard } from "@/components/fulfillment/FulfillmentSensitiveCacheGuard";
import { CapabilityFixtureProvider } from "@/hooks/use-capabilities";
import type { UiPermissionKey } from "@/lib/capabilities";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const ORG_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";
const ORDER_ID = "6f1a6a2e-1f9c-4a6d-9a3b-2c5d7e8f9a01";

const GRANTED: UiPermissionKey[] = ["orders.read", "orders.update", "fulfillment.print_label"];
const REVOKED: UiPermissionKey[] = ["orders.read", "orders.update"];

function Fixture() {
  const [open, setOpen] = useState(false);
  const [granted, setGranted] = useState(true);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <CapabilityFixtureProvider permissions={granted ? GRANTED : REVOKED}>
        <FulfillmentSensitiveCacheGuard userId={USER_ID} organizationId={ORG_ID}>
          <button id="trigger" type="button" onClick={() => setOpen(true)}>
            Print label
          </button>
          <button id="revoke" type="button" onClick={() => setGranted(false)}>
            Revoke
          </button>
          <button id="grant" type="button" onClick={() => setGranted(true)}>
            Grant
          </button>
          <ParcelLabelDialog
            open={open}
            onClose={() => setOpen(false)}
            orderIds={[ORDER_ID]}
            userId={USER_ID}
            organizationId={ORG_ID}
          />
        </FulfillmentSensitiveCacheGuard>
      </CapabilityFixtureProvider>
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
