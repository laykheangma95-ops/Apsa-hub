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
