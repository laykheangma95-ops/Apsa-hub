/**
 * Fulfillment (packing) service — the Ready-to-Pack queue and the parcel label.
 *
 * ── AUTHORITATIVE, NEVER RE-DERIVED ──────────────────────────────────────────
 *
 * Ready-to-Pack eligibility is a pure function of the order's own lifecycle and
 * fulfillment axes (isReadyToPackEligible) — not a new status, and NOT "payment
 * completed" (§11). Cambodian COD means most eligible orders are unpaid, so the
 * money to collect is derived from the order's own total and payment_status here
 * on the server; the client never computes it (§18).
 *
 * ── PII IS GATED, NEVER OVER-EXPOSED ─────────────────────────────────────────
 *
 * The queue shows a customer's display NAME only (not sensitive). The parcel
 * label additionally exposes phone + address, so getParcelLabelData requires
 * customers.view_sensitive on top of orders.read — a label is fulfillment
 * output, not a general customer export (§14). Email, notes, analytics and any
 * payment credential are never read.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { Money, Currency } from "@/types";
import * as ordersRepo from "@/server/orders/repository";
import { isReadyToPackEligible } from "@/server/orders/state-machine";
import * as repo from "./repository";
import type { ReadyToPackEntry, ParcelLabelData, ParcelLabelItem } from "./types";

/** Default and maximum queue page size. */
export const READY_TO_PACK_DEFAULT_LIMIT = 50;
const READY_TO_PACK_MAX_LIMIT = 100;

function money(amount: number, currency: string): Money {
  return { amount, currency: currency as Currency };
}

/**
 * Join Cambodian address parts into a single readable line, skipping blanks.
 * Order follows local convention (house/street → sangkat → khan → city/province).
 */
function formatAddress(row: repo.CustomerAddressRow): string | null {
  const parts = [
    [row.house_no, row.street].filter((p) => p && p.trim()).join(" "),
    row.sangkat,
    row.khan,
    row.city,
    row.province,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The merchant's Ready-to-Pack queue: confirmed orders that still need packing,
 * newest first, each enriched with customer name, item count, payment mode and
 * any current delivery state.
 */
export async function listReadyToPack(
  ctx: AuthorizationContext,
  options: { limit?: number; offset?: number } = {},
): Promise<ReadyToPackEntry[]> {
  ctx.require("orders.read");

  const limit = Math.min(options.limit ?? READY_TO_PACK_DEFAULT_LIMIT, READY_TO_PACK_MAX_LIMIT);
  const offset = options.offset ?? 0;

  const rows = await ordersRepo.listOrders(ctx.organizationId, {
    lifecycle_status: "confirmed",
    fulfillment_status: "unfulfilled",
    limit,
    offset,
  });

  // Defence in depth: the pure predicate is the single source of truth for what
  // "ready to pack" means, so even if the filters above drift the queue can only
  // ever contain genuinely eligible orders.
  const eligible = rows.filter((r) =>
    isReadyToPackEligible({
      lifecycleStatus: r.lifecycle_status,
      fulfillmentStatus: r.fulfillment_status,
    }),
  );
  if (eligible.length === 0) return [];

  const orderIds = eligible.map((r) => r.id);
  const customerIds = [
    ...new Set(eligible.map((r) => r.customer_id).filter((id): id is string => !!id)),
  ];

  const [itemCounts, customerNames, deliveryStatuses] = await Promise.all([
    repo.itemCountsByOrder(ctx.organizationId, orderIds),
    repo.customerNamesByIds(ctx.organizationId, customerIds),
    repo.latestDeliveryStatusByOrder(ctx.organizationId, orderIds),
  ]);

  return eligible.map((r) => {
    const paid = r.payment_status === "paid";
    return {
      orderId: r.id,
      orderNumber: r.order_number,
      createdAt: r.created_at,
      source: r.source,
      customerName: r.customer_id ? (customerNames.get(r.customer_id) ?? null) : null,
      itemCount: itemCounts.get(r.id) ?? 0,
      currency: r.currency as Currency,
      total: money(r.total_minor, r.currency),
      paid,
      collect: money(paid ? 0 : r.total_minor, r.currency),
      deliveryStatus: deliveryStatuses.get(r.id) ?? null,
    };
  });
}

/**
 * Assemble the data for one order's parcel label.
 *
 * Requires orders.read AND customers.view_sensitive — a parcel label necessarily
 * carries the customer's phone and address, so a member without sensitive
 * customer access cannot generate one (§14). A draft or cancelled order has no
 * committed sale to ship and is refused.
 */
export async function getParcelLabelData(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<ParcelLabelData> {
  ctx.require("orders.read");
  // A label exposes fulfillment PII; gate it on sensitive customer access.
  ctx.require("customers.view_sensitive");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) throw publicError("Order not found", 404);

  if (order.lifecycle_status === "draft" || order.lifecycle_status === "cancelled") {
    throw publicError("A parcel label is only available for a confirmed order", 409);
  }

  const [items, contact, address, businessName, delivery] = await Promise.all([
    ordersRepo.listOrderItems(ctx.organizationId, orderId),
    order.customer_id
      ? repo.customerContact(ctx.organizationId, order.customer_id)
      : Promise.resolve(null),
    order.customer_id
      ? repo.customerDefaultAddress(ctx.organizationId, order.customer_id)
      : Promise.resolve(null),
    repo.organizationName(ctx.organizationId),
    ctx.can("delivery.read")
      ? repo.latestDeliveryForOrder(ctx.organizationId, orderId)
      : Promise.resolve(null),
  ]);

  const labelItems: ParcelLabelItem[] = items.map((line) => ({
    quantity: line.quantity,
    productName: line.product_name_snapshot,
    variantName: line.variant_name_snapshot,
  }));
  const itemCount = labelItems.reduce((sum, i) => sum + i.quantity, 0);

  const paid = order.payment_status === "paid";

  return {
    merchant: { businessName: businessName ?? "" },
    customer: {
      name: contact?.display_name ?? null,
      phone: contact?.primary_phone ?? null,
      address: address ? formatAddress(address) : null,
    },
    order: {
      id: order.id,
      orderNumber: order.order_number,
      currency: order.currency as Currency,
      itemCount,
      items: labelItems,
    },
    payment: {
      paid,
      collect: paid ? null : money(order.total_minor, order.currency),
    },
    delivery: delivery
      ? {
          providerName: delivery.provider_name,
          trackingNumber: delivery.external_tracking_number,
          status: delivery.status,
        }
      : null,
  };
}
