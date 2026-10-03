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
 *     courier handoff. V1 keeps the existing permission model; a dedicated
 *     packing grant is a TODO for APSA V2 (needs a permission migration).
 *   - Every DB lookup is org-scoped via the AuthorizationContext.
 *   - Parcel ownership verified: parcel must belong to the order in the org.
 *   - Variant barcodes / QR ids validated against the order's actual line items.
 *
 * Packing does NOT require a delivery. Mark Packed records the packed fact on
 * append-only history with PACK_ORDER_PACKED_REASON_CODE and never creates,
 * assigns, starts or hands off a delivery:
 *   - no delivery yet  → order fulfillment history (unfulfilled → processing)
 *   - delivery arranged → delivery history, moving it to 'ready'
 * Arranging a delivery later for a packed order moves the new delivery to
 * 'ready' (readyPackedOrderDelivery), so Courier Handoff (ready → in_transit)
 * is unchanged.
 *
 * Packed is current state: reopening the order's fulfillment (processing →
 * unfulfilled) clears it and cancels a 'ready' delivery, so a delivery arranged
 * afterwards stays pending until Mark Packed runs again. A cancelled/failed
 * delivery attempt does not clear it. No path — including the generic delivery
 * "Mark ready" — can ready a delivery while the order is not currently packed
 * (enforced in the database, migration 054).
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
import { PACK_ORDER_PACKED_REASON_CODE, isPackedDeliveryStatus } from "@/lib/pack";
import type {
  MarkPackedResult,
  OrderPackStateResult,
  PackedLineInput,
  PackRequirementRow,
  PackRequirementsResult,
  RetryDeliveryReadyResult,
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
    packed: await isOrderPacked(ctx.organizationId, orderId, delivery?.status ?? null),
    requirements,
  };
}

/**
 * Whether the order is packed: its active delivery is ready (or further), or
 * Pack Order's trusted packed state is current (isCurrentlyPackedByPackOrder).
 */
async function isOrderPacked(
  organizationId: string,
  orderId: string,
  activeDeliveryStatus: string | null,
): Promise<boolean> {
  if (isPackedDeliveryStatus(activeDeliveryStatus)) return true;
  return isCurrentlyPackedByPackOrder(organizationId, orderId);
}

/**
 * Whether Pack Order's packed state is CURRENT for the order: the reserved
 * packed reason (order fulfillment or any delivery's history) is newer than the
 * last time the order's fulfillment was reopened to 'unfulfilled'. Packed once,
 * then reopened, is not packed: a delivery arranged afterwards waits for Pack
 * Order again.
 *
 * The rule exists once, in the database (order_currently_packed_v1, migration
 * 054). The same function guards every '→ ready' write under row locks —
 * Arrange Delivery auto-ready, Retry delivery ready and the generic delivery
 * transition — so this read and those writes can never disagree.
 *
 * The marker is trusted because it is reserved — generic order and delivery
 * transition APIs reject it (isReservedOperationalReason), so only this
 * service writes it. Org-scoped by the RPC.
 */
function isCurrentlyPackedByPackOrder(organizationId: string, orderId: string): Promise<boolean> {
  return deliveriesRepo.isOrderCurrentlyPacked(organizationId, orderId);
}

/**
 * Packed state for the Order detail fulfillment section. Requires orders.read.
 * The parcel code (needed to open Courier Handoff) is only returned to members
 * who may hand off. Returns null for a missing or other-org order.
 */
export async function getOrderPackState(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<OrderPackStateResult | null> {
  ctx.require("orders.read");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) return null;

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(ctx.organizationId, orderId);
  const packed =
    order.lifecycle_status === "confirmed" &&
    order.fulfillment_status !== "cancelled" &&
    (await isOrderPacked(ctx.organizationId, orderId, delivery?.status ?? null));

  let parcelCode: string | null = null;
  if (ctx.can("delivery.handoff")) {
    const parcel = await parcelsRepo.findActiveParcelByOrder(ctx.organizationId, orderId);
    if (parcel && parcel.status !== "void") parcelCode = parcel.parcel_code;
  }

  return { packed, parcelCode };
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
 * every unit of every line exactly. Then the packed fact is recorded — and only
 * that. No delivery is created, no courier assigned, nothing handed off:
 *   - With an arranged delivery (pending/preparing) it moves to 'ready' through
 *     the existing delivery transition RPC, recording the actor and reason code.
 *   - With no delivery, the order fulfillment history records the reason code
 *     (unfulfilled → processing, which the state machine defines as "packing
 *     has started"). Arranging a delivery later readies it for handoff.
 *
 * Idempotent: an order already packed reports already_packed.
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
  const alreadyPacked = await isOrderPacked(ctx.organizationId, orderId, delivery?.status ?? null);

  if (delivery) {
    const moved = await moveDeliveryToReady(ctx.organizationId, ctx.userId, delivery);
    if (moved.kind === "failed") return { kind: "transition_failed", reason: moved.reason };
    return {
      kind: alreadyPacked || moved.kind === "already_ready" ? "already_packed" : "packed",
      deliveryId: delivery.id,
    };
  }

  if (alreadyPacked) return { kind: "already_packed", deliveryId: null };

  const recorded = await recordPackedOnOrder(
    ctx.organizationId,
    ctx.userId,
    orderId,
    order.fulfillment_status,
  );
  if (recorded !== "success") return { kind: "transition_failed", reason: recorded };
  return { kind: "packed", deliveryId: null };
}

/**
 * Arrange Delivery after packing: when the order is currently packed, move its
 * newly arranged delivery to 'ready' so Courier Handoff can take it. Called by
 * the delivery service after a delivery is created; a no-op for an order that
 * is not packed (Mark Packed will ready the delivery instead).
 *
 * The packed check and the readiness write happen in one locked transaction
 * (ready_packed_delivery_v1), so a reopen racing this call can never leave a
 * ready delivery behind on an unpacked order.
 */
export async function readyPackedOrderDelivery(
  organizationId: string,
  userId: string,
  orderId: string,
): Promise<"not_packed" | "no_delivery" | "ready" | "already_ready" | "failed"> {
  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(organizationId, orderId);
  if (!delivery) return "no_delivery";
  if (isPackedDeliveryStatus(delivery.status)) return "already_ready";
  // Read-only shortcut for the common unpacked case (every Arrange Delivery
  // runs this). It can only say "no"; a "yes" is re-decided under the RPC's locks.
  if (!(await isCurrentlyPackedByPackOrder(organizationId, orderId))) return "not_packed";
  const result = await deliveriesRepo.readyPackedDelivery(
    organizationId,
    orderId,
    delivery.id,
    userId,
  );
  switch (result.status) {
    case "success":
      return "ready";
    case "already_ready":
      return "already_ready";
    case "not_packed":
      return "not_packed";
    default:
      return "failed";
  }
}

/**
 * Retry delivery readiness for an order that is currently packed.
 *
 * Recovers a packed order whose delivery was left 'pending'/'preparing' — e.g.
 * the best-effort readying after Arrange Delivery failed. It never repacks:
 * no scan counts are taken and it never writes the packed marker, so it cannot
 * recreate Packed. ready_packed_delivery_v1 verifies, under the same locks as
 * its write, that the order is packed with no newer reopen, then writes only
 * the delivery steps still missing (pending → preparing → ready). A delivery
 * already ready reports already_ready without writing anything. Courier
 * Handoff is unchanged — it still takes the delivery from 'ready'.
 *
 * Same grants as Mark Packed (orders.read + delivery.handoff); the packed fact
 * comes from the current trusted packed state, never from the delivery status.
 */
export async function retryPackedDeliveryReady(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<RetryDeliveryReadyResult> {
  ctx.require("orders.read");
  ctx.require("delivery.handoff");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (
    !order ||
    order.lifecycle_status !== "confirmed" ||
    order.fulfillment_status === "cancelled"
  ) {
    return { kind: "invalid_order" };
  }

  const delivery = await deliveriesRepo.findActiveDeliveryForOrder(ctx.organizationId, orderId);
  if (!delivery) return { kind: "no_delivery" };
  if (isPackedDeliveryStatus(delivery.status)) {
    return { kind: "already_ready", deliveryId: delivery.id };
  }

  const result = await deliveriesRepo.readyPackedDelivery(
    ctx.organizationId,
    orderId,
    delivery.id,
    ctx.userId,
  );
  switch (result.status) {
    case "success":
      return { kind: "ready", deliveryId: delivery.id };
    case "already_ready":
      return { kind: "already_ready", deliveryId: delivery.id };
    case "not_packed":
      return { kind: "not_packed" };
    case "invalid_order":
      return { kind: "invalid_order" };
    default:
      return { kind: "transition_failed", reason: result.status };
  }
}

type DeliveryReadyOutcome =
  { kind: "ready" } | { kind: "already_ready" } | { kind: "failed"; reason: string };

/** pending → preparing → ready (as needed), each step tagged with the packed reason. */
async function moveDeliveryToReady(
  organizationId: string,
  userId: string,
  delivery: { id: string; status: string },
): Promise<DeliveryReadyOutcome> {
  if (isPackedDeliveryStatus(delivery.status)) return { kind: "already_ready" };

  let steps: readonly (readonly ["pending" | "preparing", "preparing" | "ready"])[];
  if (delivery.status === "pending") {
    steps = [
      ["pending", "preparing"],
      ["preparing", "ready"],
    ];
  } else if (delivery.status === "preparing") {
    steps = [["preparing", "ready"]];
  } else {
    return { kind: "failed", reason: "invalid_transition" };
  }

  for (const [from, to] of steps) {
    const result = await deliveriesRepo.transitionDelivery(
      organizationId,
      delivery.id,
      from,
      to,
      userId,
      PACK_ORDER_PACKED_REASON_CODE,
    );
    if (result.status !== "success") {
      if (result.status === "stale" && isPackedDeliveryStatus(result.current)) {
        return { kind: "already_ready" };
      }
      return { kind: "failed", reason: result.status };
    }
  }
  return { kind: "ready" };
}

/**
 * Record the packed fact on the order fulfillment history (no delivery exists).
 *
 * unfulfilled → processing carries the reason. An order already 'processing'
 * with no active delivery (only reachable through a manual fulfillment
 * transition) cannot write a processing → processing row, so the marker is the
 * pair processing → unfulfilled → processing, both rows tagged with the reason.
 */
async function recordPackedOnOrder(
  organizationId: string,
  userId: string,
  orderId: string,
  fulfillmentStatus: string,
): Promise<string> {
  const steps: readonly (readonly [string, string])[] =
    fulfillmentStatus === "unfulfilled"
      ? [["unfulfilled", "processing"]]
      : [
          ["processing", "unfulfilled"],
          ["unfulfilled", "processing"],
        ];
  for (const [from, to] of steps) {
    const result = await ordersRepo.transitionStatus(
      organizationId,
      orderId,
      "fulfillment",
      from,
      to,
      userId,
      PACK_ORDER_PACKED_REASON_CODE,
    );
    if (result.status !== "success") return result.status;
  }
  return "success";
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
