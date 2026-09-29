/**
 * The `@/lib/api` boundary, stubbed for the parcel-label revocation browser
 * fixture ONLY (aliased in src/tests/parcel-label-revocation.browser.ts, so no
 * production bundle can resolve it). The dialog, its capability reads, its
 * query cache and the child shipping sheet are all the shipped code; only the
 * two server calls they make resolve locally.
 */
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";

export const PII = {
  name: "Sokha Chan",
  phone: "+855 12 345 678",
  address: "Street 271, Toul Tompoung, Phnom Penh",
};

declare global {
  interface Window {
    /** Every getParcelLabelData call — a reopen after revocation must add none. */
    apsaLabelFetches?: string[];
  }
}
window.apsaLabelFetches = [];

export async function getParcelLabelData(orderId: string): Promise<ParcelLabelInput> {
  window.apsaLabelFetches!.push(orderId);
  return {
    merchant: { businessName: "Dara Shop" },
    customer: { ...PII, addressConfirmed: true },
    order: { id: orderId, orderNumber: "APSA-2026-001048", itemCount: 1, items: [] },
    reprint: false,
    payment: { paid: true, collect: null },
    delivery: null,
  };
}

export async function updateOrderShipping(): Promise<void> {}
