/**
 * Scan-to-Pick domain — pure picking logic.
 *
 * A pick session tracks which items an order requires, validates barcode scans
 * against those requirements, and computes progress. No React, no I/O, no
 * server imports.
 *
 * INVENTORY IS NOT MUTATED. Picking validates that the correct product was
 * scanned; it does not write inventory movements. Stock was consumed at
 * order confirmation (migration 026). This domain records what the warehouse
 * worker has physically gathered, nothing more.
 *
 * Future compatibility: Scan-to-Pack, courier handoff, returns, warehouse
 * zones and batch picking can extend this without restructuring it.
 */

// ── Pick requirement (what the order needs) ─────────────────────────────────

export interface PickRequirement {
  /** order_items row id */
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

// ── Pick session state ──────────────────────────────────────────────────────

export interface PickedItem {
  orderItemId: string;
  variantId: string;
  scannedAt: number;
}

export interface PickSession {
  orderId: string;
  orderNumber: string;
  requirements: readonly PickRequirement[];
  picked: readonly PickedItem[];
}

// ── Scan result ─────────────────────────────────────────────────────────────

export type ScanResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "wrong_product"; scannedBarcode: string }
  | { kind: "wrong_variant"; scannedBarcode: string; expectedVariantName: string | null }
  | { kind: "over_quantity"; variantId: string; productName: string }
  | { kind: "already_complete" };

// ── Progress ────────────────────────────────────────────────────────────────

export interface PickProgress {
  totalRequired: number;
  totalPicked: number;
  remaining: number;
  isComplete: boolean;
  lines: readonly PickLineProgress[];
}

export interface PickLineProgress {
  orderItemId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantityRequired: number;
  quantityPicked: number;
  isComplete: boolean;
}

// ── Pure functions ──────────────────────────────────────────────────────────

export function createPickSession(
  orderId: string,
  orderNumber: string,
  requirements: readonly PickRequirement[],
): PickSession {
  return { orderId, orderNumber, requirements, picked: [] };
}

function pickedCountForItem(picked: readonly PickedItem[], orderItemId: string): number {
  return picked.filter((p) => p.orderItemId === orderItemId).length;
}

export function computeProgress(session: PickSession): PickProgress {
  const lines: PickLineProgress[] = session.requirements.map((req) => {
    const quantityPicked = pickedCountForItem(session.picked, req.orderItemId);
    return {
      orderItemId: req.orderItemId,
      productName: req.productName,
      variantName: req.variantName,
      sku: req.sku,
      quantityRequired: req.quantityRequired,
      quantityPicked,
      isComplete: quantityPicked >= req.quantityRequired,
    };
  });

  const totalRequired = lines.reduce((sum, l) => sum + l.quantityRequired, 0);
  const totalPicked = lines.reduce(
    (sum, l) => sum + Math.min(l.quantityPicked, l.quantityRequired),
    0,
  );

  return {
    totalRequired,
    totalPicked,
    remaining: totalRequired - totalPicked,
    isComplete: totalPicked >= totalRequired,
    lines,
  };
}

/**
 * Validate a scanned barcode against the pick session's requirements.
 *
 * Rules:
 *   1. If all items are already picked → already_complete.
 *   2. Find which requirement(s) match the barcode (by variant barcode).
 *   3. No match → check siblingBarcodes for a same-product / wrong-variant hit.
 *   4. Match found but all units for that line are picked → over_quantity.
 *   5. Match → accepted.
 */
export function validateScan(session: PickSession, barcode: string): ScanResult {
  const progress = computeProgress(session);
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
    const picked = pickedCountForItem(session.picked, req.orderItemId);
    if (picked < req.quantityRequired) {
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
    kind: "over_quantity",
    variantId: firstMatch.variantId,
    productName: firstMatch.productName,
  };
}

/**
 * Apply an accepted scan to the session, returning a new session with
 * the item recorded. Only call after validateScan returned "accepted".
 */
export function applyAcceptedScan(
  session: PickSession,
  result: Extract<ScanResult, { kind: "accepted" }>,
): PickSession {
  return {
    ...session,
    picked: [
      ...session.picked,
      {
        orderItemId: result.orderItemId,
        variantId: result.variantId,
        scannedAt: Date.now(),
      },
    ],
  };
}

/**
 * Check whether a pick session's order is in a state where picking is allowed.
 * Picking is only valid for confirmed orders with unfulfilled/processing status.
 */
export function canPickOrder(order: {
  lifecycleStatus: string | undefined;
  fulfillmentStatus: string | undefined;
}): boolean {
  return (
    order.lifecycleStatus === "confirmed" &&
    (order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "processing")
  );
}
