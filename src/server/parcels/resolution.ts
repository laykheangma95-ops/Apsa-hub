/**
 * Server-authoritative Parcel Resolution service.
 *
 * Given a parcel code, resolves the full operational context required for
 * navigation and investigation: Parcel → Order → Customer → Delivery →
 * Shipping Snapshot.
 *
 * This is the deeper resolution layer that future features consume (Parcel
 * Investigation page, Scan-to-Pack, Courier Handoff, Returns). The scan
 * identity router provides quick classification; this service provides the
 * complete operational record.
 *
 * Security:
 *   - Tenant isolation: every lookup is org-scoped. A parcel belonging to
 *     Org A returns null when resolved in Org B.
 *   - Permission enforcement: requires fulfillment.scan_parcel.
 *   - No PII in the result: customer is id-only, shipping is presence-only.
 *   - Malformed input is rejected early (isValidParcelCode).
 *   - Voided parcels resolve with status "void" — never silently redirected.
 *   - "Not found" and "wrong org" are indistinguishable (opaque not-found).
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";
import * as parcelRepo from "./repository";
import * as ordersRepo from "@/server/orders/repository";
import * as deliveriesRepo from "@/server/deliveries/repository";
import type { ParcelResolutionResult } from "./resolution-types";

/**
 * Resolve a parcel code to its full operational context within the caller's
 * organization.
 *
 * Returns null when the code is malformed, does not exist, or belongs to a
 * different organization. These cases are indistinguishable to the caller.
 *
 * Voided parcels resolve with their historical references intact and a
 * status of "void" — the caller decides presentation.
 */
export async function resolveParcelIdentity(
  ctx: AuthorizationContext,
  parcelCode: string,
): Promise<ParcelResolutionResult | null> {
  ctx.require("fulfillment.scan_parcel");

  if (!isValidParcelCode(parcelCode)) return null;

  const parcelRow = await parcelRepo.findParcelByCode(ctx.organizationId, parcelCode);
  if (!parcelRow) return null;

  const orderRow = await ordersRepo.findOrderById(ctx.organizationId, parcelRow.order_id);
  if (!orderRow) return null;

  const deliveryRows = await deliveriesRepo.listDeliveries(ctx.organizationId, {
    order_id: parcelRow.order_id,
    limit: 1,
  });
  const latestDelivery = deliveryRows[0] ?? null;

  return {
    parcel: {
      id: parcelRow.id,
      parcelCode: parcelRow.parcel_code,
      status: parcelRow.status,
      createdAt: parcelRow.created_at,
    },
    order: {
      id: orderRow.id,
      orderNumber: orderRow.order_number,
      lifecycleStatus: orderRow.lifecycle_status,
      fulfillmentStatus: orderRow.fulfillment_status,
      paymentStatus: orderRow.payment_status,
    },
    customer: orderRow.customer_id ? { id: orderRow.customer_id } : null,
    delivery: latestDelivery
      ? {
          id: latestDelivery.id,
          status: latestDelivery.status,
          providerName: latestDelivery.provider_name,
          externalTrackingNumber: latestDelivery.external_tracking_number,
        }
      : null,
    shippingSnapshot: {
      hasName: orderRow.shipping_name !== null && orderRow.shipping_name !== "",
      hasPhone: orderRow.shipping_phone !== null && orderRow.shipping_phone !== "",
      hasAddress: orderRow.shipping_address !== null && orderRow.shipping_address !== "",
    },
  };
}
