/**
 * Packing domain types — server-side only.
 *
 * Never import this file from browser-bundled code.
 */

export interface PackRequirementRow {
  orderItemId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  quantityRequired: number;
  siblingBarcodes: string[];
}

export interface PackRequirementsResult {
  orderNumber: string;
  parcelCode: string;
  eligible: boolean;
  /**
   * Status of the order's active delivery, or null when none is arranged.
   * 'ready' / 'in_transit' mean the order has already been marked packed.
   */
  deliveryStatus: string | null;
  requirements: PackRequirementRow[];
}

// ── Server-side scan validation results ────────────────────────────────────

export type ServerParcelScanResult =
  | { kind: "parcel_accepted"; parcelCode: string }
  | { kind: "wrong_parcel"; scannedCode: string }
  | { kind: "invalid_order" };

export type ServerProductScanResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "wrong_product"; scannedBarcode: string }
  | { kind: "wrong_variant"; scannedBarcode: string; expectedVariantName: string | null }
  | { kind: "invalid_order" };

// ── Mark Packed ─────────────────────────────────────────────────────────────

export interface PackedLineInput {
  orderItemId: string;
  quantity: number;
}

export type MarkPackedResult =
  | { kind: "packed"; deliveryId: string }
  | { kind: "already_packed"; deliveryId: string }
  | { kind: "incomplete" }
  | { kind: "no_parcel" }
  | { kind: "no_active_delivery" }
  | { kind: "delivery_not_packable"; currentStatus: string }
  | { kind: "invalid_order" }
  | { kind: "transition_failed"; reason: string };
