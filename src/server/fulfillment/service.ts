/**
 * Fulfillment (packing) service — the Ready-to-Pack queue and the parcel label.
 *
 * ── AUTHORITATIVE, NEVER RE-DERIVED ──────────────────────────────────────────
 *
 * Ready-to-Pack eligibility is a pure function of the order's own lifecycle and
 * fulfillment axes (isReadyToPackEligible) — not a new status, and NOT "payment
 * completed" (§11). It spans confirmed orders that are unfulfilled OR processing
 * (both still awaiting shipment). Cambodian COD means most eligible orders are
 * unpaid, so the money to collect is the authoritative OUTSTANDING balance from
 * the Payment ledger (order_payment_totals), never the full total and never
 * derived from payment_status alone; the client never computes it (§18).
 *
 * ── PII IS GATED, NEVER OVER-EXPOSED ─────────────────────────────────────────
 *
 * The queue shows a customer's display NAME only (not sensitive). The parcel
 * label additionally exposes phone + shipping address, so getParcelLabelData
 * requires the NARROW fulfillment.print_label capability on top of orders.read —
 * an operational grant scoped to exactly the shipping fields packing needs, not
 * the Owner/Manager-only customers.view_sensitive (§14, §20). Email, notes,
 * analytics and any payment credential are never read.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { Money, Currency } from "@/types";
import * as ordersRepo from "@/server/orders/repository";
import {
  isReadyToPackEligible,
  parcelLabelPrintability,
  READY_TO_PACK_FULFILLMENT_STATUSES,
  type ParcelLabelBlockReason,
} from "@/server/orders/state-machine";
import * as repo from "./repository";
import type { ReadyToPackEntry, ParcelLabelData, ParcelLabelItem } from "./types";

/** Default and maximum queue page size. */
export const READY_TO_PACK_DEFAULT_LIMIT = 50;
const READY_TO_PACK_MAX_LIMIT = 100;

function money(amount: number, currency: string): Money {
  return { amount, currency: currency as Currency };
}

/**
 * Amount still to collect on an order, in integer minor units — the
 * authoritative OUTSTANDING balance, never the full total.
 *
 * total_minor and net_minor both come from the Payment domain's
 * order_payment_totals view (net = received - refunded). Subtracting is the only
 * arithmetic here; the settlement itself is the SQL view's, not duplicated. A
 * negative result (an overpaid/over-refunded edge) clamps to zero — a courier
 * never collects a negative amount. When the view has no row for an order (it
 * should always, being a LEFT JOIN on orders), we fall back to the order total,
 * i.e. assume nothing settled — the safe direction for COD.
 */
function outstandingMinor(
  totals: repo.OrderPaymentTotalsRow | undefined,
  orderTotalMinor: number,
): number {
  if (!totals) return orderTotalMinor;
  return Math.max(0, totals.total_minor - totals.net_minor);
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
    // Both "still needs shipping" fulfillment axes, not unfulfilled alone (§11):
    // an order mid-pack (processing / pending delivery) still belongs here.
    fulfillment_statuses: READY_TO_PACK_FULFILLMENT_STATUSES,
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

  const [itemCounts, customerNames, deliveryStatuses, paymentTotals] = await Promise.all([
    repo.itemCountsByOrder(ctx.organizationId, orderIds),
    repo.customerNamesByIds(ctx.organizationId, customerIds),
    repo.latestDeliveryStatusByOrder(ctx.organizationId, orderIds),
    // Authoritative outstanding balance per order — never payment_status alone.
    repo.orderPaymentTotalsByIds(ctx.organizationId, orderIds),
  ]);

  return eligible.map((r) => {
    const outstanding = outstandingMinor(paymentTotals.get(r.id), r.total_minor);
    const paid = outstanding === 0;
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
      collect: money(outstanding, r.currency),
      deliveryStatus: deliveryStatuses.get(r.id) ?? null,
    };
  });
}

/** Human-facing refusal for each non-printable order state (§19). */
function printBlockError(reason: ParcelLabelBlockReason): Error {
  switch (reason) {
    case "draft":
    case "cancelled":
      return publicError("A parcel label is only available for a confirmed order", 409);
    case "completed":
      return publicError("This order is completed; a parcel label is no longer available", 409);
    case "delivery_cancelled":
      return publicError("This order's delivery was cancelled; its parcel label is void", 409);
  }
}

/**
 * Assemble the data for one order's parcel label.
 *
 * ── PERMISSION (§11, §20) ─────────────────────────────────────────────────────
 * Requires orders.read AND fulfillment.print_label — a NARROW capability that
 * grants exactly the minimum shipping fields (name, phone, delivery address) for
 * packing, and nothing else about a customer. This is deliberately NOT
 * customers.view_sensitive: that grant is Owner/Manager-only, so gating on it
 * left cashiers/fulfillment staff — the people who actually pack — unable to
 * print a label. fulfillment.print_label is seeded to those operational roles
 * too (migration 046) without handing them general customer PII access.
 *
 * ── LIFECYCLE (§19) ───────────────────────────────────────────────────────────
 * parcelLabelPrintability is the authoritative guard: draft/cancelled/completed
 * orders and cancelled deliveries are refused; a confirmed order that has
 * advanced past unfulfilled prints as a REPRINT rather than a fresh label.
 *
 * ── COD (§18) ─────────────────────────────────────────────────────────────────
 * The amount to collect is the authoritative OUTSTANDING balance from the
 * Payment ledger, not the full total and not derived from payment_status.
 *
 * ── ADDRESS (§13) ─────────────────────────────────────────────────────────────
 * V1 has no order/delivery destination snapshot, so the address shown is the
 * customer's mutable on-file default, flagged addressConfirmed:false so the label
 * warns rather than presenting it as the shipping truth.
 */
export async function getParcelLabelData(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<ParcelLabelData> {
  ctx.require("orders.read");
  // A label exposes only the shipping fields (name/phone/address); gate it on
  // the narrow fulfillment capability, not general customer-sensitive access.
  ctx.require("fulfillment.print_label");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) throw publicError("Order not found", 404);

  const printability = parcelLabelPrintability({
    lifecycleStatus: order.lifecycle_status,
    fulfillmentStatus: order.fulfillment_status,
  });
  if (!printability.allowed && printability.reason) {
    throw printBlockError(printability.reason);
  }

  const [items, contact, address, businessName, delivery, totals] = await Promise.all([
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
    repo.orderPaymentTotals(ctx.organizationId, orderId),
  ]);

  const labelItems: ParcelLabelItem[] = items.map((line) => ({
    quantity: line.quantity,
    productName: line.product_name_snapshot,
    variantName: line.variant_name_snapshot,
  }));
  const itemCount = labelItems.reduce((sum, i) => sum + i.quantity, 0);

  const outstanding = outstandingMinor(totals ?? undefined, order.total_minor);
  const paid = outstanding === 0;

  return {
    merchant: { businessName: businessName ?? "" },
    customer: {
      name: contact?.display_name ?? null,
      phone: contact?.primary_phone ?? null,
      address: address ? formatAddress(address) : null,
      // V1: no order/delivery destination snapshot — the on-file default is not
      // authoritative and must be human-verified before shipping (§13).
      addressConfirmed: false,
    },
    order: {
      id: order.id,
      orderNumber: order.order_number,
      currency: order.currency as Currency,
      itemCount,
      items: labelItems,
    },
    reprint: printability.reprint,
    payment: {
      paid,
      collect: paid ? null : money(outstanding, order.currency),
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
