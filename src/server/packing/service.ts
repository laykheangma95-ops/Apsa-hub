/**
 * Packing service — read-only order-item requirements for Scan-to-Pack.
 *
 * Fetches the line items for a confirmed order along with the parcel identity
 * and current variant barcodes, so the pack screen can validate scans
 * client-side. This is a READ operation — no inventory mutations, no status
 * changes.
 *
 * Security:
 *   - Requires `orders.read` (same grant the Order detail and Pick pages need).
 *   - Every DB lookup is org-scoped via the AuthorizationContext.
 *   - The parcel must belong to the order (verified server-side).
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as ordersRepo from "@/server/orders/repository";
import * as parcelsRepo from "@/server/parcels/repository";
import type { PackRequirementRow, PackRequirementsResult } from "./types";

/**
 * Get the pack requirements for an order: each line item with its current
 * variant barcode for scan validation, plus the parcel code to verify.
 *
 * The order must be confirmed. Returns null if the order does not exist or
 * belongs to another org.
 */
export async function getPackRequirements(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<PackRequirementsResult | null> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) return null;

  if (order.lifecycle_status !== "confirmed") {
    throw publicError(`Order is ${order.lifecycle_status}, not confirmed — cannot pack`, 400);
  }

  const parcel = await parcelsRepo.findActiveParcelByOrder(ctx.organizationId, orderId);
  if (!parcel) {
    throw publicError("Order has no parcel identity — create one before packing", 400);
  }

  if (parcel.status === "void") {
    throw publicError("Parcel has been voided — cannot pack", 400);
  }

  const items = await ordersRepo.listOrderItems(ctx.organizationId, orderId);

  const productsRepo = await import("@/server/products/repository");

  const productIds = [...new Set(items.map((i) => i.product_id))];
  const allVariants = await productsRepo.listVariantsByOrg(ctx.organizationId, productIds);

  const variantMap = new Map(allVariants.map((v) => [v.id, v]));
  const barcodesByProduct = new Map<string, { variantId: string; barcode: string }[]>();
  for (const v of allVariants) {
    if (!v.barcode) continue;
    const list = barcodesByProduct.get(v.product_id) ?? [];
    list.push({ variantId: v.id, barcode: v.barcode });
    barcodesByProduct.set(v.product_id, list);
  }

  const requirements: PackRequirementRow[] = items.map((item) => {
    const variant = variantMap.get(item.variant_id);
    const siblings = (barcodesByProduct.get(item.product_id) ?? [])
      .filter((s) => s.variantId !== item.variant_id)
      .map((s) => s.barcode);

    return {
      orderItemId: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      productName: item.product_name_snapshot,
      variantName: item.variant_name_snapshot,
      sku: item.sku_snapshot,
      barcode: variant?.barcode ?? null,
      quantityRequired: item.quantity,
      siblingBarcodes: siblings,
    };
  });

  return {
    orderNumber: order.order_number,
    parcelCode: parcel.parcel_code,
    requirements,
  };
}
