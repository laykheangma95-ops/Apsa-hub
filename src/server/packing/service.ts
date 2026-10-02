/**
 * Packing service — server-authoritative Pack Order operations.
 *
 * Pack Order is the single V1 warehouse action (there is no separate picking
 * step). All scan validation and the Mark Packed transition are performed here
 * against org-scoped DB state. The client displays results but never decides
 * validity.
 *
 * Security:
 *   - Reads and scan validation require `orders.read` (same grant as Order detail).
 *   - Mark Packed additionally requires `delivery.handoff` — the operational
 *     fulfillment grant the person at the packing bench already holds for
 *     courier handoff — because it moves the order's delivery to 'ready'.
 *   - Every DB lookup is org-scoped via the AuthorizationContext.
 *   - Parcel ownership verified: parcel must belong to the order in the org.
 *   - Variant barcodes / QR ids validated against the order's actual line items.
 *
 * Inventory is NOT touched: stock was consumed at order confirmation.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as ordersRepo from "@/server/orders/repository";
import * as parcelsRepo from "@/server/parcels/repository";
import * as deliveriesRepo from "@/server/deliveries/repository";
import { classifyScan } from "@/lib/barcode/scan-router";
import { normalizeScanInput, upcAToEan13, ean13ToUpcA } from "@/lib/barcode/normalize";
import { PACK_ORDER_PACKED_REASON_CODE } from "@/lib/pack";
import type {
  MarkPackedResult,
  PackedLineInput,
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

type OrderItemRow = Awaited<ReturnType<typeof ordersRepo.listOrderItems>>[number];

interface OrderVariantIndex {
  items: OrderItemRow[];
  variantMap: Map<string, { id: string; product_id: string; barcode: string | null }>;
  barcodesByProduct: Map<string, { variantId: string; barcode: string }[]>;
}

/** The order's line items plus every active variant of the products they reference. */
async function loadOrderVariantIndex(
  organizationId: string,
  orderId: string,
): Promise<OrderVariantIndex> {
  const items = await ordersRepo.listOrderItems(organizationId, orderId);
  const productsRepo = await import("@/server/products/repository");

  const productIds = [...new Set(items.map((i) => i.product_id))];
  const allVariants = await productsRepo.listVariantsByOrg(organizationId, productIds);

  const variantMap = new Map(allVariants.map((v) => [v.id.toLowerCase(), v]));
  const barcodesByProduct = new Map<string, { variantId: string; barcode: string }[]>();
  for (const v of allVariants) {
    if (!v.barcode) continue;
    const list = barcodesByProduct.get(v.product_id) ?? [];
    list.push({ variantId: v.id, barcode: v.barcode });
    barcodesByProduct.set(v.product_id, list);
  }

  return { items, variantMap, barcodesByProduct };
}

/**
 * Get the pack requirements for an order: each line item with its current
 * variant barcode for scan validation, plus the parcel the order is packed into.
 *
 * The order must be confirmed and in an eligible fulfillment state, and its
 * parcel label must exist (Print Parcel Label comes before packing).
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
    throw publicError("Order has no parcel identity — print the parcel label before packing", 400);
  }

  if (parcel.status === "void") {
    throw publicError("Parcel has been voided — cannot pack", 400);
  }

  const { items, variantMap, barcodesByProduct } = await loadOrderVariantIndex(
    ctx.organizationId,
    orderId,
  );

  const requirements: PackRequirementRow[] = items.map((item) => {
    const variant = variantMap.get(item.variant_id.toLowerCase());
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

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(ctx.organizationId, orderId);

  return {
    orderNumber: order.order_number,
    parcelCode: parcel.parcel_code,
    eligible: true,
    deliveryStatus: delivery?.status ?? null,
    requirements,
  };
}

/**
 * Server-authoritative parcel scan validation.
 *
 * Scanning the parcel label inside Pack Order is optional; when it happens it
 * confirms the labelled parcel belongs to this order. All lookups org-scoped.
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
 * Server-authoritative product scan validation.
 *
 * Every scan passes through the shared APSA scan router (classifyScan), so a
 * retail barcode, an APSA-generated barcode and an APSA variant QR are all
 * accepted, and the same UPC-A ↔ EAN-13 normalization used by the global scan
 * lookup applies here. Matching is against the order's own line items only; a
 * sibling variant of an ordered product is reported as wrong_variant.
 */
export async function validatePackProductScan(
  ctx: AuthorizationContext,
  orderId: string,
  scannedCode: string,
): Promise<ServerProductScanResult> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order || !isPackEligible(order.lifecycle_status, order.fulfillment_status)) {
    return { kind: "invalid_order" };
  }

  const code = normalizeScanInput(scannedCode);
  if (code === null) return { kind: "wrong_product", scannedBarcode: scannedCode };

  const identity = classifyScan(code);
  const { items, variantMap, barcodesByProduct } = await loadOrderVariantIndex(
    ctx.organizationId,
    orderId,
  );

  if (identity.kind === "apsa-variant") {
    const variantId = identity.id.toLowerCase();
    const item = items.find((i) => i.variant_id.toLowerCase() === variantId);
    if (item) {
      return {
        kind: "accepted",
        orderItemId: item.id,
        variantId: item.variant_id,
        productName: item.product_name_snapshot,
      };
    }
    const scannedVariant = variantMap.get(variantId);
    const sameProduct = scannedVariant
      ? items.find((i) => i.product_id === scannedVariant.product_id)
      : undefined;
    if (sameProduct) {
      return {
        kind: "wrong_variant",
        scannedBarcode: code,
        expectedVariantName: sameProduct.variant_name_snapshot,
      };
    }
    return { kind: "wrong_product", scannedBarcode: code };
  }

  if (identity.kind !== "product-barcode") {
    return { kind: "wrong_product", scannedBarcode: code };
  }

  const candidates = new Set(
    [identity.code, upcAToEan13(identity.code), ean13ToUpcA(identity.code)].filter(
      (c): c is string => c !== null,
    ),
  );

  for (const item of items) {
    const variant = variantMap.get(item.variant_id.toLowerCase());
    if (variant?.barcode && candidates.has(variant.barcode)) {
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
    if (siblings.some((s) => candidates.has(s.barcode))) {
      return {
        kind: "wrong_variant",
        scannedBarcode: code,
        expectedVariantName: item.variant_name_snapshot,
      };
    }
  }

  return { kind: "wrong_product", scannedBarcode: code };
}

/**
 * Mark Packed — the end of Pack Order.
 *
 * Re-validates everything at execution time (the screen is advisory): the order
 * is pack-eligible, its parcel exists, and the submitted per-line counts cover
 * every unit of every line exactly. Then the order's active delivery moves to
 * 'ready' through the existing delivery transition RPC (pending → preparing →
 * ready as needed), which records history with the actor and a reason code.
 * Courier Handoff then takes it from 'ready' to 'in_transit', unchanged.
 *
 * Idempotent: a delivery already 'ready' (or further) reports already_packed.
 */
export async function markOrderPacked(
  ctx: AuthorizationContext,
  orderId: string,
  packedLines: readonly PackedLineInput[],
): Promise<MarkPackedResult> {
  ctx.require("orders.read");
  ctx.require("delivery.handoff");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order || !isPackEligible(order.lifecycle_status, order.fulfillment_status)) {
    return { kind: "invalid_order" };
  }

  const parcel = await parcelsRepo.findActiveParcelByOrder(ctx.organizationId, orderId);
  if (!parcel || parcel.status === "void") return { kind: "no_parcel" };

  const items = await ordersRepo.listOrderItems(ctx.organizationId, orderId);
  if (!isPackingComplete(items, packedLines)) return { kind: "incomplete" };

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(ctx.organizationId, orderId);
  if (!delivery) return { kind: "no_active_delivery" };

  if (delivery.status === "ready" || delivery.status === "in_transit") {
    return { kind: "already_packed", deliveryId: delivery.id };
  }

  if (delivery.status !== "pending" && delivery.status !== "preparing") {
    return { kind: "delivery_not_packable", currentStatus: delivery.status };
  }

  const steps: readonly (readonly ["pending" | "preparing", "preparing" | "ready"])[] =
    delivery.status === "pending"
      ? [
          ["pending", "preparing"],
          ["preparing", "ready"],
        ]
      : [["preparing", "ready"]];

  for (const [from, to] of steps) {
    const result = await deliveriesRepo.transitionDelivery(
      ctx.organizationId,
      delivery.id,
      from,
      to,
      ctx.userId,
      PACK_ORDER_PACKED_REASON_CODE,
    );
    if (result.status !== "success") {
      if (
        result.status === "stale" &&
        (result.current === "ready" || result.current === "in_transit")
      ) {
        return { kind: "already_packed", deliveryId: delivery.id };
      }
      return { kind: "transition_failed", reason: result.status };
    }
  }

  return { kind: "packed", deliveryId: delivery.id };
}

/**
 * Every order line is covered exactly once with its full quantity, and nothing
 * outside the order is claimed.
 */
function isPackingComplete(
  items: readonly OrderItemRow[],
  packedLines: readonly PackedLineInput[],
): boolean {
  if (items.length === 0) return false;
  const submitted = new Map<string, number>();
  for (const line of packedLines) {
    if (submitted.has(line.orderItemId)) return false;
    submitted.set(line.orderItemId, line.quantity);
  }
  if (submitted.size !== items.length) return false;
  return items.every((item) => submitted.get(item.id) === item.quantity);
}
