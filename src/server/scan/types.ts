/**
 * Scan identity router — server-side resolution types.
 *
 * These types describe the result of resolving a scanned value through the
 * server-authoritative identity router. Every scan in APSA produces exactly one
 * of these results. No PII is returned — only identifiers and operational
 * metadata needed for the caller to navigate to the correct record.
 *
 * Never import this file from browser-bundled code — use the API layer types.
 */

export type ScanResolutionType = "product" | "parcel" | "variant" | "order" | "unknown";

export interface ProductScanResolution {
  type: "product";
  payload: string;
  metadata: {
    variantId: string;
    productId: string;
    variantName: string;
    barcode: string;
  };
}

export interface ParcelScanResolution {
  type: "parcel";
  payload: string;
  metadata: {
    parcelId: string;
    orderId: string;
    orderNumber: string;
    status: string;
  };
}

export interface VariantScanResolution {
  type: "variant";
  payload: string;
  metadata: {
    variantId: string;
    productId: string;
    variantName: string;
  };
}

export interface OrderScanResolution {
  type: "order";
  payload: string;
  metadata: {
    orderId: string;
    orderNumber: string;
    lifecycleStatus: string;
  };
}

export interface UnknownScanResolution {
  type: "unknown";
  payload: string;
  metadata: null;
}

export type ScanResolution =
  | ProductScanResolution
  | ParcelScanResolution
  | VariantScanResolution
  | OrderScanResolution
  | UnknownScanResolution;
