/**
 * Courier Handoff domain — client-side types and display logic.
 *
 * VALIDATION IS SERVER-AUTHORITATIVE. All handoff validation (parcel ownership,
 * delivery lifecycle, order state) is performed by the server service in
 * src/server/handoff/service.ts. This module contains only:
 *   - Type definitions shared between client and server response shapes
 *   - Display predicates for UI state rendering
 *   - Phase derivation for the handoff confirmation flow
 *
 * This module is safe to bundle for the browser — no server imports, no secrets.
 */

import type { DeliveryStatus } from "@/server/deliveries/state-machine";

// ── Handoff preview (what the server returns for display) ───────────────────

export interface HandoffPreview {
  parcelId: string;
  parcelCode: string;
  orderId: string;
  orderNumber: string;
  deliveryId: string;
  deliveryStatus: DeliveryStatus;
  providerName: string;
  externalTrackingNumber: string | null;
  eligible: boolean;
  reason: string | null;
}

// ── Handoff confirmation (what the server returns after confirm) ─────────────

export interface HandoffConfirmation {
  parcelId: string;
  parcelCode: string;
  orderId: string;
  orderNumber: string;
  deliveryId: string;
  providerName: string;
  externalTrackingNumber: string | null;
  handedOffAt: string;
}

export type HandoffResultKind =
  | "success"
  | "parcel_not_found"
  | "parcel_voided"
  | "no_active_delivery"
  | "delivery_not_ready"
  | "order_not_confirmed"
  | "already_handed_off"
  | "transition_failed";

export type HandoffResult =
  | { kind: "success"; handoff: HandoffConfirmation }
  | { kind: "parcel_not_found" }
  | { kind: "parcel_voided" }
  | { kind: "no_active_delivery" }
  | { kind: "delivery_not_ready"; currentStatus: DeliveryStatus }
  | { kind: "order_not_confirmed" }
  | { kind: "already_handed_off" }
  | { kind: "transition_failed"; reason: string };

// ── Display phase ──────────────────────────────────────────────────────────

export type HandoffPhase = "loading" | "preview" | "confirming" | "confirmed" | "error";

// ── Display predicates ──────────────────────────────────────────────────────

export function canConfirmHandoff(preview: HandoffPreview): boolean {
  return preview.eligible && preview.deliveryStatus === "ready";
}

export function isAlreadyHandedOff(preview: HandoffPreview): boolean {
  return preview.deliveryStatus === "in_transit" || preview.deliveryStatus === "delivered";
}

export function handoffErrorMessage(result: HandoffResult): string | null {
  switch (result.kind) {
    case "success":
      return null;
    case "parcel_not_found":
      return "Parcel not found in this organization";
    case "parcel_voided":
      return "This parcel has been voided";
    case "no_active_delivery":
      return "No active delivery exists for this order";
    case "delivery_not_ready":
      return `Delivery is '${result.currentStatus}' — must be 'ready' for handoff`;
    case "order_not_confirmed":
      return "Order is not in a confirmed state";
    case "already_handed_off":
      return "This parcel has already been handed off to the courier";
    case "transition_failed":
      return `Handoff failed: ${result.reason}`;
  }
}
