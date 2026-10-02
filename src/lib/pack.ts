/**
 * Scan-to-Pack domain — pure packing logic.
 *
 * A pack session verifies that picked items are placed into the correct parcel.
 * The warehouse worker scans the parcel code first, then scans each product.
 * The domain validates each scan against the order's requirements.
 *
 * INVENTORY IS NOT MUTATED. Packing is a verification step — it confirms
 * physical items match the order, nothing more. Stock was consumed at order
 * confirmation; picking gathered the goods; packing checks they go into the
 * right box.
 *
 * Future compatibility: courier handoff, returns, multi-parcel orders,
 * warehouse zones and batch packing can extend this without restructuring.
 */

// ── Pack requirement (what the order needs) ─────────────────────────────────

export interface PackRequirement {
  orderItemId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  quantityRequired: number;
  siblingBarcodes: readonly string[];
}

// ── Pack session state ──────────────────────────────────────────────────────

export interface PackedItem {
  orderItemId: string;
  variantId: string;
  scannedAt: number;
}

export type PackPhase = "awaiting_parcel" | "scanning_products" | "complete";

export interface PackSession {
  orderId: string;
  orderNumber: string;
  expectedParcelCode: string;
  parcelVerified: boolean;
  requirements: readonly PackRequirement[];
  packed: readonly PackedItem[];
}

// ── Parcel scan result ──────────────────────────────────────────────────────

export type ParcelScanResult =
  | { kind: "parcel_accepted"; parcelCode: string }
  | { kind: "wrong_parcel"; scannedCode: string }
  | { kind: "parcel_already_verified" };

// ── Product scan result ─────────────────────────────────────────────────────

export type ProductScanResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "wrong_product"; scannedBarcode: string }
  | { kind: "wrong_variant"; scannedBarcode: string; expectedVariantName: string | null }
  | { kind: "duplicate_scan"; variantId: string; productName: string }
  | { kind: "already_complete" }
  | { kind: "parcel_not_verified" };

// ── Progress ────────────────────────────────────────────────────────────────

export interface PackProgress {
  totalRequired: number;
  totalPacked: number;
  remaining: number;
  isComplete: boolean;
  lines: readonly PackLineProgress[];
}

export interface PackLineProgress {
  orderItemId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantityRequired: number;
  quantityPacked: number;
  isComplete: boolean;
}

// ── Pure functions ──────────────────────────────────────────────────────────

export function createPackSession(
  orderId: string,
  orderNumber: string,
  expectedParcelCode: string,
  requirements: readonly PackRequirement[],
): PackSession {
  return {
    orderId,
    orderNumber,
    expectedParcelCode,
    parcelVerified: false,
    requirements,
    packed: [],
  };
}

function packedCountForItem(packed: readonly PackedItem[], orderItemId: string): number {
  return packed.filter((p) => p.orderItemId === orderItemId).length;
}

export function computePackProgress(session: PackSession): PackProgress {
  const lines: PackLineProgress[] = session.requirements.map((req) => {
    const quantityPacked = packedCountForItem(session.packed, req.orderItemId);
    return {
      orderItemId: req.orderItemId,
      productName: req.productName,
      variantName: req.variantName,
      sku: req.sku,
      quantityRequired: req.quantityRequired,
      quantityPacked,
      isComplete: quantityPacked >= req.quantityRequired,
    };
  });

  const totalRequired = lines.reduce((sum, l) => sum + l.quantityRequired, 0);
  const totalPacked = lines.reduce(
    (sum, l) => sum + Math.min(l.quantityPacked, l.quantityRequired),
    0,
  );

  return {
    totalRequired,
    totalPacked,
    remaining: totalRequired - totalPacked,
    isComplete: totalPacked >= totalRequired,
    lines,
  };
}

export function getPackPhase(session: PackSession): PackPhase {
  if (!session.parcelVerified) return "awaiting_parcel";
  const progress = computePackProgress(session);
  if (progress.isComplete) return "complete";
  return "scanning_products";
}

/**
 * Validate a scanned parcel code against the pack session's expected parcel.
 */
export function validateParcelScan(session: PackSession, scannedCode: string): ParcelScanResult {
  if (session.parcelVerified) {
    return { kind: "parcel_already_verified" };
  }

  if (scannedCode === session.expectedParcelCode) {
    return { kind: "parcel_accepted", parcelCode: scannedCode };
  }

  return { kind: "wrong_parcel", scannedCode };
}

/**
 * Apply an accepted parcel scan, returning a new session with parcel verified.
 */
export function applyParcelScan(
  session: PackSession,
  _result: Extract<ParcelScanResult, { kind: "parcel_accepted" }>,
): PackSession {
  return { ...session, parcelVerified: true };
}

/**
 * Validate a scanned product barcode against the pack session's requirements.
 *
 * Rules:
 *   1. Parcel must be verified first.
 *   2. If all items are already packed → already_complete.
 *   3. Find which requirement(s) match the barcode (by variant barcode).
 *   4. No match → check siblingBarcodes for a same-product / wrong-variant hit.
 *   5. Match found but all units for that line are packed → duplicate_scan.
 *   6. Match → accepted.
 */
export function validateProductScan(session: PackSession, barcode: string): ProductScanResult {
  if (!session.parcelVerified) {
    return { kind: "parcel_not_verified" };
  }

  const progress = computePackProgress(session);
  if (progress.isComplete) {
    return { kind: "already_complete" };
  }

  const matchingReqs = session.requirements.filter(
    (req) => req.barcode !== null && req.barcode === barcode,
  );

  if (matchingReqs.length === 0) {
    const siblingMatch = session.requirements.find((req) => req.siblingBarcodes.includes(barcode));
    if (siblingMatch) {
      return {
        kind: "wrong_variant",
        scannedBarcode: barcode,
        expectedVariantName: siblingMatch.variantName,
      };
    }
    return { kind: "wrong_product", scannedBarcode: barcode };
  }

  for (const req of matchingReqs) {
    const packed = packedCountForItem(session.packed, req.orderItemId);
    if (packed < req.quantityRequired) {
      return {
        kind: "accepted",
        orderItemId: req.orderItemId,
        variantId: req.variantId,
        productName: req.productName,
      };
    }
  }

  const firstMatch = matchingReqs[0]!;
  return {
    kind: "duplicate_scan",
    variantId: firstMatch.variantId,
    productName: firstMatch.productName,
  };
}

/**
 * Apply an accepted product scan to the session, returning a new session with
 * the item recorded. Only call after validateProductScan returned "accepted".
 */
export function applyAcceptedPackScan(
  session: PackSession,
  result: Extract<ProductScanResult, { kind: "accepted" }>,
): PackSession {
  return {
    ...session,
    packed: [
      ...session.packed,
      {
        orderItemId: result.orderItemId,
        variantId: result.variantId,
        scannedAt: Date.now(),
      },
    ],
  };
}

/**
 * Check whether an order is in a state where packing is allowed.
 * Packing requires a confirmed order with processing fulfillment (pick done).
 */
export function canPackOrder(order: {
  lifecycleStatus: string | undefined;
  fulfillmentStatus: string | undefined;
}): boolean {
  return (
    order.lifecycleStatus === "confirmed" &&
    (order.fulfillmentStatus === "processing" || order.fulfillmentStatus === "unfulfilled")
  );
}
