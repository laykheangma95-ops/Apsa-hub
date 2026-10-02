/**
 * Packing service — server-authoritative Scan-to-Pack operations.
 *
 * All scan validation is performed here against org-scoped DB state.
 * The client displays results but never decides validity.
 *
 * Security:
 *   - Requires `orders.read` (same grant the Order detail and Pick pages need).
 *   - Every DB lookup is org-scoped via the AuthorizationContext.
 *   - Parcel ownership verified: parcel must belong to the order in the org.
 *   - Variant barcodes validated against the order's actual line items.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as ordersRepo from "@/server/orders/repository";
import * as parcelsRepo from "@/server/parcels/repository";
import type {
  PackRequirementRow,
  PackRequirementsResult,
  ServerParcelScanResult,
  ServerProductScanResult,
} from "./types";

function isPackEligible(lifecycleStatus: string, fulfillmentStatus: string): boolean {
  return (
    lifecycleStatus === "confirmed" &&
    (fulfillmentStatus === "unfulfilled" || fulfillmentStatus === "processing")
  );
}

/**
 * Get the pack requirements for an order: each line item with its current
 * variant barcode for scan validation, plus the parcel code to verify.
 *
 * The order must be confirmed and in an eligible fulfillment state.
 * Returns null if the order does not exist or belongs to another org.
 */
export async function getPackRequirements(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<PackRequirementsResult | null> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) return null;

  if (!isPackEligible(order.lifecycle_status, order.fulfillment_status)) {
    throw publicError(
      `Order is ${order.lifecycle_status}/${order.fulfillment_status} — cannot pack`,
      400,
    );
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
    eligible: true,
    requirements,
  };
}

/**
 * Server-authoritative parcel scan validation.
 *
 * Validates that the scanned code matches the order's active parcel,
 * all lookups org-scoped through the AuthorizationContext.
 */
export async function validatePackParcelScan(
  ctx: AuthorizationContext,
  orderId: string,
  scannedCode: string,
): Promise<ServerParcelScanResult> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order || !isPackEligible(order.lifecycle_status, order.fulfillment_status)) {
    return { kind: "invalid_order" };
  }

  const parcel = await parcelsRepo.findActiveParcelByOrder(ctx.organizationId, orderId);
  if (!parcel || parcel.status === "void") {
    return { kind: "invalid_order" };
  }

  if (scannedCode === parcel.parcel_code) {
    return { kind: "parcel_accepted", parcelCode: scannedCode };
  }

  return { kind: "wrong_parcel", scannedCode };
}

/**
 * Server-authoritative product barcode scan validation.
 *
 * Validates that the scanned barcode matches a variant in the order's
 * line items. All lookups are org-scoped through the AuthorizationContext.
 */
export async function validatePackProductScan(
  ctx: AuthorizationContext,
  orderId: string,
  barcode: string,
): Promise<ServerProductScanResult> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order || !isPackEligible(order.lifecycle_status, order.fulfillment_status)) {
    return { kind: "invalid_order" };
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

  for (const item of items) {
    const variant = variantMap.get(item.variant_id);
    if (variant?.barcode === barcode) {
      return {
        kind: "accepted",
        orderItemId: item.id,
        variantId: item.variant_id,
        productName: item.product_name_snapshot,
      };
    }
  }

  for (const item of items) {
    const siblings = (barcodesByProduct.get(item.product_id) ?? []).filter(
      (s) => s.variantId !== item.variant_id,
    );
    if (siblings.some((s) => s.barcode === barcode)) {
      return {
        kind: "wrong_variant",
        scannedBarcode: barcode,
        expectedVariantName: item.variant_name_snapshot,
      };
    }
  }

  return { kind: "wrong_product", scannedBarcode: barcode };
}
