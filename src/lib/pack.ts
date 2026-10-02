/**
 * Scan-to-Pack domain — client-side types and display logic.
 *
 * VALIDATION IS SERVER-AUTHORITATIVE. All scan validation (parcel identity,
 * product barcode, variant ownership) is performed by the server service in
 * src/server/packing/service.ts. This module contains only:
 *   - Type definitions shared between client and server response shapes
 *   - Progress computation for the UI progress bar
 *   - Phase derivation for UI state machine rendering
 *   - canPackOrder display predicate for the order detail button
 *
 * INVENTORY IS NOT MUTATED. Packing is a verification step — it confirms
 * physical items match the order, nothing more.
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

// ── Pack session state (client-side tracking for UI progress) ──────────────

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

// ── Server scan result types (match server/packing/types.ts) ──────────────

export type ServerParcelScanResult =
  | { kind: "parcel_accepted"; parcelCode: string }
  | { kind: "wrong_parcel"; scannedCode: string }
  | { kind: "invalid_order" };

export type ServerProductScanResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "wrong_product"; scannedBarcode: string }
  | { kind: "wrong_variant"; scannedBarcode: string; expectedVariantName: string | null }
  | { kind: "invalid_order" };

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
 * Apply a server-validated parcel acceptance to the local session.
 * Only call after the server returned parcel_accepted.
 */
export function applyServerParcelAccepted(session: PackSession): PackSession {
  return { ...session, parcelVerified: true };
}

/**
 * Apply a server-validated product acceptance to the local session.
 * Only call after the server returned accepted.
 */
export function applyServerProductAccepted(
  session: PackSession,
  result: { orderItemId: string; variantId: string },
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
 * Check whether a scan is a duplicate for display purposes.
 * This checks the LOCAL packed count against requirements.
 */
export function isLocalDuplicateScan(session: PackSession, orderItemId: string): boolean {
  const req = session.requirements.find((r) => r.orderItemId === orderItemId);
  if (!req) return false;
  return packedCountForItem(session.packed, orderItemId) >= req.quantityRequired;
}

/**
 * Check whether an order is in a state where packing is allowed.
 * Display predicate for showing/hiding the "Start packing" button.
 * The server enforces the same check authoritatively.
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
