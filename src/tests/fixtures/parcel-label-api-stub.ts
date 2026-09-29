/**
 * The `@/lib/api` boundary, stubbed for the parcel-label revocation browser
 * fixture ONLY (aliased in src/tests/parcel-label-revocation.browser.ts, so no
 * production bundle can resolve it). The dialog, its capability reads, its
 * query cache and the child shipping sheet are all the shipped code; only the
 * two server calls they make resolve locally.
 */
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import "./parcel-label-capabilities-stub";

export const PII = {
  name: "Sokha Chan",
  phone: "+855 12 345 678",
  address: "Street 271, Toul Tompoung, Phnom Penh",
};

export async function getParcelLabelData(orderId: string): Promise<ParcelLabelInput> {
  const server = window.apsaServer;
  server.labelFetches.push(orderId);
  // The server refuses a label read once the grant is gone (migration 046).
  if (!server.permissions.includes("fulfillment.print_label")) {
    throw new Error("403 forbidden");
  }
  return {
    merchant: { businessName: "Dara Shop" },
    // A snapshotless order carries NO recipient data (service never infers it).
    customer: server.snapshotless
      ? { name: null, phone: null, address: null, addressConfirmed: false }
      : { ...PII, addressConfirmed: true },
    order: { id: orderId, orderNumber: "APSA-2026-001048", itemCount: 1, items: [] },
    reprint: false,
    payment: { paid: true, collect: null },
    delivery: null,
  };
}

export async function updateOrderShipping(): Promise<void> {}
