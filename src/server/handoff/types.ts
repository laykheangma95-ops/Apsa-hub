import type { DeliveryStatus } from "@/server/deliveries/state-machine";

export interface HandoffValidation {
  parcelId: string;
  parcelCode: string;
  orderId: string;
  orderNumber: string;
  deliveryId: string;
  deliveryStatus: DeliveryStatus;
  providerName: string;
  externalTrackingNumber: string | null;
}

export type HandoffResult =
  | { kind: "success"; handoff: HandoffConfirmation }
  | { kind: "parcel_not_found" }
  | { kind: "parcel_voided" }
  | { kind: "no_active_delivery" }
  | { kind: "delivery_not_ready"; currentStatus: DeliveryStatus }
  | { kind: "order_not_confirmed" }
  | { kind: "already_handed_off" }
  | { kind: "transition_failed"; reason: string };

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
