/**
 * Order work queues — server-authoritative lists of orders that need work.
 *
 * The queue's membership is decided in the database (list_order_work_queue_v1,
 * migration 065) with the one packed rule (order_currently_packed_v1), so this
 * list, Order detail and every '→ ready' write can never disagree about whether
 * an order is packed. This service adds only display data: the customer's
 * display name (not PII-gated, as on Ready to Pack) and the outstanding balance
 * from the Payment ledger (never derived from payment_status).
 *
 * Security: orders.read; organization from the server-resolved membership; the
 * parcel code (which opens Courier Handoff) only for delivery.handoff.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { Currency } from "@/types";
import * as ordersRepo from "@/server/orders/repository";
import * as fulfillmentRepo from "@/server/fulfillment/repository";
import { outstandingMinor } from "@/server/fulfillment/service";
import {
  ORDER_WORK_QUEUE_LIMIT,
  type OrderWorkQueue,
  type OrderWorkQueueEntry,
} from "@/lib/order-work-queue";

export async function listOrderWorkQueue(
  ctx: AuthorizationContext,
  queue: OrderWorkQueue,
): Promise<OrderWorkQueueEntry[]> {
  ctx.require("orders.read");

  const rows = await ordersRepo.listOrderWorkQueue(
    ctx.organizationId,
    queue,
    ORDER_WORK_QUEUE_LIMIT,
  );
  if (rows.length === 0) return [];

  const orderIds = rows.map((r) => r.order_id);
  const customerIds = [
    ...new Set(rows.map((r) => r.customer_id).filter((id): id is string => !!id)),
  ];
  const [names, totals] = await Promise.all([
    fulfillmentRepo.customerNamesByIds(ctx.organizationId, customerIds),
    fulfillmentRepo.orderPaymentTotalsByIds(ctx.organizationId, orderIds),
  ]);
  const showParcelCode = ctx.can("delivery.handoff");

  return rows.map((r) => {
    const currency = r.currency as Currency;
    return {
      orderId: r.order_id,
      orderNumber: r.order_number,
      createdAt: r.created_at,
      customerName: r.customer_id ? (names.get(r.customer_id) ?? null) : null,
      currency,
      total: { amount: Number(r.total_minor), currency },
      due: {
        amount: outstandingMinor(totals.get(r.order_id), Number(r.total_minor)),
        currency,
      },
      lifecycleStatus: r.lifecycle_status as OrderWorkQueueEntry["lifecycleStatus"],
      paymentStatus: r.payment_status as OrderWorkQueueEntry["paymentStatus"],
      refundStatus: r.refund_status as OrderWorkQueueEntry["refundStatus"],
      fulfillmentStatus: r.fulfillment_status as OrderWorkQueueEntry["fulfillmentStatus"],
      packed: r.packed === true,
      activeDeliveryId: r.active_delivery_id,
      activeDeliveryStatus: r.active_delivery_status,
      latestDeliveryStatus: r.latest_delivery_status,
      anyDelivered: r.any_delivered === true,
      cod: r.cod_amount_minor !== null && Number(r.cod_amount_minor) > 0,
      parcelCode: showParcelCode ? r.parcel_code : null,
      packDetails:
        r.packed && r.package_count !== null && r.packed_recorded_at !== null
          ? {
              packageCount: r.package_count,
              weightGrams: r.weight_grams,
              storageLocation: r.storage_location,
              recordedAt: r.packed_recorded_at,
            }
          : null,
    };
  });
}
