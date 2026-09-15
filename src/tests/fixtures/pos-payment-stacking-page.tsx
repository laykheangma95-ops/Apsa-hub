/**
 * Browser fixture for the POS checkout → Record Payment sheet-stacking
 * regression.
 *
 * Mounted in a real Chromium by src/tests/pos-payment-stacking.browser.ts. It
 * renders the actual <PosCheckoutSheet>, so the sheets under test are the
 * shipped ones with their real document-level Escape and focusin handlers —
 * not a copy of the pattern that would keep passing if the component stopped
 * using it.
 *
 * The bug: BottomSheet registers its trap on `document`, not on its own panel.
 * While RecordOrderPaymentSheet was open the checkout sheet stayed open too, so
 * two traps ran at once — each saw focus landing in the other as "outside me"
 * and yanked it back, and Escape fired both handlers, tearing down the
 * confirmed-but-unpaid order the merchant was settling.
 *
 * Only `@/lib/api` is substituted (see pos-payment-stacking-api-stub.ts), and
 * only because reaching the confirmed-unpaid success surface otherwise needs a
 * server function and a database. Everything the test asserts on — the sheets,
 * the traps, the component's state machine — is real.
 *
 * The cart is a production cart: real UUID product and variant ids, so
 * classifyCheckout routes it to the authoritative Order path exactly as it
 * would in the app. The prototype path is never exercised here.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PosCheckoutSheet } from "@/components/pos/PosCheckoutSheet";
import { CapabilityFixtureProvider } from "@/hooks/use-capabilities";
import { calculateCartTotals, type CartLine } from "@/lib/pos-cart";
import "@/lib/i18n";

const PRODUCT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const VARIANT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const ORG_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";

const LINES: CartLine[] = [
  {
    key: `${PRODUCT_ID}::${VARIANT_ID}`,
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    nameKm: "កាហ្វេ",
    nameEn: "Coffee",
    sku: "COF-1",
    quantity: 2,
    unitPrice: { amount: 600, currency: "USD" },
    stock: 0,
  },
];

declare global {
  interface Window {
    /** Every recordRealPayment call the shared Payment path made, in order. */
    apsaRecordedPayments?: unknown[];
    /**
     * How many times PosCheckoutSheet called onCompleted(). The checkout sheet
     * standing down for payment entry must NOT count as completion — that is
     * the path that used to discard the merchant's unpaid order.
     */
    apsaCompletedCount?: number;
    /** False once the parent has been told to close the whole checkout. */
    apsaCheckoutOpen?: boolean;
  }
}

window.apsaRecordedPayments = [];
window.apsaCompletedCount = 0;

export function Fixture() {
  const [open, setOpen] = useState(false);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const totals = calculateCartTotals(LINES, { enabled: false, mode: "amount", value: 0 });

  window.apsaCheckoutOpen = open;

  return (
    <QueryClientProvider client={client}>
      <CapabilityFixtureProvider permissions={["payments.record", "payments.mark_cod"]}>
        <button id="background" type="button">
          Behind the sheet
        </button>
        <button id="trigger" type="button" onClick={() => setOpen(true)}>
          Checkout
        </button>
        <PosCheckoutSheet
          open={open}
          onOpenChange={setOpen}
          lines={LINES}
          totals={totals}
          customer={null}
          offline={false}
          onCompleted={() => {
            window.apsaCompletedCount = (window.apsaCompletedCount ?? 0) + 1;
          }}
          userId={USER_ID}
          organizationId={ORG_ID}
        />
      </CapabilityFixtureProvider>
    </QueryClientProvider>
  );
}

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
}
