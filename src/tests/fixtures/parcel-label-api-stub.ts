/**
 * The `@/lib/api` boundary, stubbed for the parcel-label revocation browser
 * fixture ONLY (aliased in src/tests/parcel-label-revocation.browser.ts, so no
 * production bundle can resolve it). The dialog, its capability reads, its
 * query cache and the child shipping sheet are all the shipped code; only the
 * two server calls they make resolve locally.
 */
import type { ParcelLabelInput } from "@/lib/labels/parcel-label";
import "./parcel-label-capabilities-stub";

/** Structurally valid (APSA:PCL:v1: + 22 base64url chars), carries no PII. */
const STUB_PARCEL_CODE = "APSA:PCL:v1:stubParcelCode_abc0123";

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
    payment: { state: "paid", paid: true, collect: null, partial: false, checkReason: null },
    // A shipping label exists only for a carrier shipment (CORRECTION-003).
    delivery: { providerName: "VET Express", trackingNumber: "VET-1", status: "ready" },
    // The order's APSA Parcel ID — secondary text on the shipping label.
    parcelCode: STUB_PARCEL_CODE,
  };
}

export async function updateOrderShipping(): Promise<void> {}
