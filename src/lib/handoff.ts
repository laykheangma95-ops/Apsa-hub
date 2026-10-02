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

/** Reserved delivery-history reason written by the server for this workflow. */
export const COURIER_HANDOFF_CONFIRMED_REASON_CODE = "system:courier_handoff_confirmed";

// ── Display phase ──────────────────────────────────────────────────────────

export type HandoffPhase = "loading" | "preview" | "confirming" | "confirmed" | "error";

// ── Display predicates ──────────────────────────────────────────────────────

export function canConfirmHandoff(preview: HandoffPreview): boolean {
  return preview.eligible && preview.deliveryStatus === "ready";
}

export function isAlreadyHandedOff(preview: HandoffPreview): boolean {
  return preview.deliveryStatus === "in_transit" || preview.deliveryStatus === "delivered";
}

/**
 * Stable reason codes the server returns in HandoffPreview.reason.
 * Each maps to an i18n key under courierHandoff.
 */
const REASON_CODE_I18N: Record<string, string> = {
  parcel_voided: "courierHandoff.voided.body",
  no_active_delivery: "courierHandoff.noDelivery.body",
  order_not_eligible: "courierHandoff.orderNotConfirmed.body",
  already_handed_off: "courierHandoff.duplicateHandoff.body",
  delivery_not_ready: "courierHandoff.deliveryNotReady.body",
};

/**
 * Resolve a server-returned preview reason code to a localized message.
 * Returns the code itself as a fallback if no i18n key is mapped.
 */
export function handoffReasonMessage(
  reasonCode: string | null,
  t: (key: string) => string,
): string | null {
  if (!reasonCode) return null;
  const i18nKey = REASON_CODE_I18N[reasonCode];
  return t(i18nKey ?? "courierHandoff.error.body");
}

/**
 * Localize system-generated delivery-history reasons without changing
 * merchant-entered failure/cancellation notes. Unknown reserved system codes
 * fail closed to generic translated copy rather than leaking raw text.
 */
export function handoffHistoryReasonMessage(reason: string, t: (key: string) => string): string;
export function handoffHistoryReasonMessage(reason: null, t: (key: string) => string): null;
export function handoffHistoryReasonMessage(
  reason: string | null,
  t: (key: string) => string,
): string | null {
  if (!reason) return null;
  if (reason === COURIER_HANDOFF_CONFIRMED_REASON_CODE) {
    return t("courierHandoff.history.confirmed");
  }
  if (reason.startsWith("system:")) return t("courierHandoff.error.body");
  return reason;
}

/**
 * Map a HandoffResult to a localized error message for the confirmation flow.
 * Returns null for success.
 */
const RESULT_KIND_I18N: Record<string, string> = {
  parcel_not_found: "courierHandoff.notFound.body",
  parcel_voided: "courierHandoff.voided.body",
  no_active_delivery: "courierHandoff.noDelivery.body",
  delivery_not_ready: "courierHandoff.deliveryNotReady.body",
  order_not_confirmed: "courierHandoff.orderNotConfirmed.body",
  already_handed_off: "courierHandoff.duplicateHandoff.body",
  transition_failed: "courierHandoff.error.body",
};

export function handoffErrorMessage(
  result: HandoffResult,
  t: (key: string) => string,
): string | null {
  if (result.kind === "success") return null;
  const i18nKey = RESULT_KIND_I18N[result.kind];
  return i18nKey ? t(i18nKey) : t("courierHandoff.error.body");
}
