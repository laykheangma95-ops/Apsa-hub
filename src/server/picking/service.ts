/**
 * Picking service — read-only order-item requirements for Scan-to-Pick.
 *
 * Fetches the line items for a confirmed order along with their current variant
 * barcodes, so the pick screen can validate scans client-side. This is a READ
 * operation — no inventory mutations, no status changes.
 *
 * Security:
 *   - Requires `orders.read` (the same grant the Order detail page needs).
 *   - Every DB lookup is org-scoped via the AuthorizationContext.
 *   - Variant barcodes are operational data, not PII, so no additional
 *     sensitive-grant gate is needed.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as ordersRepo from "@/server/orders/repository";
import type { PickRequirementRow } from "./types";

/**
 * Get the pick requirements for an order: each line item with its current
 * variant barcode for scan validation.
 *
 * The order must be confirmed and not yet in a terminal fulfillment state.
 * Returns null if the order does not exist or belongs to another org.
 */
export async function getPickRequirements(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<PickRequirementRow[] | null> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) return null;

  if (order.lifecycle_status !== "confirmed") {
    throw publicError(`Order is ${order.lifecycle_status}, not confirmed — cannot pick`, 400);
  }

  if (order.fulfillment_status !== "unfulfilled" && order.fulfillment_status !== "processing") {
    throw publicError(`Order fulfillment is ${order.fulfillment_status} — cannot pick`, 400);
  }

  const items = await ordersRepo.listOrderItems(ctx.organizationId, orderId);

  const productsRepo = await import("@/server/products/repository");

  const requirements: PickRequirementRow[] = [];

  for (const item of items) {
    const variant = await productsRepo.findVariantById(ctx.organizationId, item.variant_id);

    requirements.push({
      orderItemId: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      productName: item.product_name_snapshot,
      variantName: item.variant_name_snapshot,
      sku: item.sku_snapshot,
      barcode: variant?.barcode ?? null,
      quantityRequired: item.quantity,
    });
  }

  return requirements;
}
