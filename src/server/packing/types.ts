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
  requirements: PackRequirementRow[];
}
