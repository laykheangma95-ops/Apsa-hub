/**
 * Courier Handoff service — server-authoritative parcel handoff operations.
 *
 * The handoff confirms a packed parcel has been physically given to a courier.
 * It transitions the delivery from 'ready' to 'in_transit' after validating:
 *   - Parcel exists and is active within the caller's organization
 *   - Order is in a confirmed lifecycle state
 *   - An active delivery exists for the order
 *   - The delivery is in 'ready' status (eligible for handoff)
 *   - The handoff has not already occurred (idempotent rejection)
 *
 * This is NOT shipment tracking and NOT courier API integration. It is a
 * merchant-initiated confirmation that the physical handoff happened.
 *
 * Future compatibility: courier APIs, tracking numbers, status webhooks,
 * returns, and replacement deliveries are designed-for but not implemented.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { COURIER_HANDOFF_CONFIRMED_REASON_CODE } from "@/lib/handoff";
import * as parcelsRepo from "@/server/parcels/repository";
import * as deliveriesRepo from "@/server/deliveries/repository";
import * as ordersRepo from "@/server/orders/repository";
import type { HandoffResult, HandoffPreview } from "./types";

/**
 * Preview the handoff state for a parcel — what the UI displays before the
 * merchant confirms. Returns null when the parcel does not exist in this org
 * (opaque not-found, same as parcel resolution).
 */
export async function getHandoffPreview(
  ctx: AuthorizationContext,
  parcelCode: string,
): Promise<HandoffPreview | null> {
  ctx.require("delivery.handoff");

  const parcel = await parcelsRepo.findParcelByCode(ctx.organizationId, parcelCode);
  if (!parcel) return null;

  if (parcel.status === "void") {
    return {
      parcelId: parcel.id,
      parcelCode: parcel.parcel_code,
      orderId: parcel.order_id,
      orderNumber: "",
      deliveryId: "",
      deliveryStatus: "pending",
      providerName: "",
      externalTrackingNumber: null,
      eligible: false,
      reason: "parcel_voided",
    };
  }

  const order = await ordersRepo.findOrderById(ctx.organizationId, parcel.order_id);
  if (!order) return null;

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(
    ctx.organizationId,
    parcel.order_id,
  );

  if (!delivery) {
    return {
      parcelId: parcel.id,
      parcelCode: parcel.parcel_code,
      orderId: parcel.order_id,
      orderNumber: order.order_number,
      deliveryId: "",
      deliveryStatus: "pending",
      providerName: "",
      externalTrackingNumber: null,
      eligible: false,
      reason: "no_active_delivery",
    };
  }

  if (order.lifecycle_status !== "confirmed") {
    return {
      parcelId: parcel.id,
      parcelCode: parcel.parcel_code,
      orderId: parcel.order_id,
      orderNumber: order.order_number,
      deliveryId: delivery.id,
      deliveryStatus: delivery.status,
      providerName: delivery.provider_name,
      externalTrackingNumber: delivery.external_tracking_number,
      eligible: false,
      reason: "order_not_eligible",
    };
  }

  const eligible = delivery.status === "ready";
  let reason: string | null = null;
  if (!eligible) {
    if (delivery.status === "in_transit") {
      reason = "already_handed_off";
    } else {
      reason = "delivery_not_ready";
    }
  }

  return {
    parcelId: parcel.id,
    parcelCode: parcel.parcel_code,
    orderId: parcel.order_id,
    orderNumber: order.order_number,
    deliveryId: delivery.id,
    deliveryStatus: delivery.status,
    providerName: delivery.provider_name,
    externalTrackingNumber: delivery.external_tracking_number,
    eligible,
    reason,
  };
}

/**
 * Confirm the courier handoff for a parcel.
 *
 * Transitions the parcel's order's active delivery from 'ready' to 'in_transit'.
 * Every precondition is re-validated at execution time — the preview is advisory.
 */
export async function confirmHandoff(
  ctx: AuthorizationContext,
  parcelCode: string,
): Promise<HandoffResult> {
  ctx.require("delivery.handoff");

  const parcel = await parcelsRepo.findParcelByCode(ctx.organizationId, parcelCode);
  if (!parcel) return { kind: "parcel_not_found" };

  if (parcel.status === "void") return { kind: "parcel_voided" };

  const order = await ordersRepo.findOrderById(ctx.organizationId, parcel.order_id);
  if (!order) return { kind: "parcel_not_found" };

  if (order.lifecycle_status !== "confirmed") return { kind: "order_not_confirmed" };

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(
    ctx.organizationId,
    parcel.order_id,
  );
  if (!delivery) return { kind: "no_active_delivery" };

  if (delivery.status === "in_transit") return { kind: "already_handed_off" };

  if (delivery.status !== "ready") {
    return { kind: "delivery_not_ready", currentStatus: delivery.status };
  }

  const result = await deliveriesRepo.transitionDelivery(
    ctx.organizationId,
    delivery.id,
    "ready",
    "in_transit",
    ctx.userId,
    COURIER_HANDOFF_CONFIRMED_REASON_CODE,
  );

  if (result.status !== "success") {
    if (result.status === "stale" && result.current === "in_transit") {
      return { kind: "already_handed_off" };
    }
    return { kind: "transition_failed", reason: result.status };
  }

  return {
    kind: "success",
    handoff: {
      parcelId: parcel.id,
      parcelCode: parcel.parcel_code,
      orderId: parcel.order_id,
      orderNumber: order.order_number,
      deliveryId: delivery.id,
      providerName: delivery.provider_name,
      externalTrackingNumber: delivery.external_tracking_number,
      handedOffAt: new Date().toISOString(),
    },
  };
}
