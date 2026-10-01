/**
 * Server-authoritative scan identity router.
 *
 * Every barcode or QR scan in APSA passes through this ONE entry point.
 * `resolveScan` normalizes the raw input, classifies it into an identity type,
 * and resolves it against the org-scoped database. Future scan features call
 * this function and never duplicate detection or resolution logic.
 *
 * Security:
 *   - Tenant isolation: every database lookup is org-scoped. A code belonging to
 *     Org A returns "unknown" when scanned in Org B.
 *   - Permission enforcement: the caller's AuthorizationContext is checked for
 *     the appropriate permission before each lookup.
 *   - No PII in the result: names, phones, and addresses are never returned.
 *   - Malformed input is rejected early (normalization returns null).
 *   - No cross-tenant leakage: "not found" and "wrong org" are indistinguishable.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { classifyScan } from "@/lib/barcode/scan-router";
import { normalizeScanInput, upcAToEan13, ean13ToUpcA } from "@/lib/barcode/normalize";
import type { ScanResolution } from "./types";

/**
 * Resolve a scanned value to its identity within the caller's organization.
 *
 * This is the single entry point for all scan resolution in APSA. The caller
 * passes the raw string from a camera, wedge scanner, or manual entry field,
 * and receives a typed result describing what was scanned and where to navigate.
 *
 * The function never throws for a scan that cannot be identified — it returns
 * { type: "unknown" } instead. Infrastructure errors (DB down, auth failure)
 * propagate as exceptions.
 */
export async function resolveScan(
  ctx: AuthorizationContext,
  raw: string,
): Promise<ScanResolution> {
  const normalized = normalizeScanInput(raw);
  if (normalized === null) {
    return { type: "unknown", payload: String(raw ?? "").slice(0, 100), metadata: null };
  }

  const identity = classifyScan(normalized);

  switch (identity.kind) {
    case "apsa-parcel":
      return resolveParcel(ctx, identity.code, normalized);

    case "apsa-variant":
      return resolveVariant(ctx, identity.id, normalized);

    case "apsa-order":
      return resolveOrder(ctx, identity.id, normalized);

    case "product-barcode":
      return resolveProductBarcode(ctx, identity.code, normalized);

    case "unknown":
      return { type: "unknown", payload: normalized, metadata: null };
  }
}

async function resolveParcel(
  ctx: AuthorizationContext,
  code: string,
  normalized: string,
): Promise<ScanResolution> {
  if (!ctx.can("fulfillment.scan_parcel")) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  const parcelsService = await import("@/server/parcels/service");
  const resolution = await parcelsService.resolveParcelCode(ctx, code);

  if (!resolution) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  return {
    type: "parcel",
    payload: normalized,
    metadata: {
      parcelId: resolution.parcelId,
      orderId: resolution.orderId,
      orderNumber: resolution.orderNumber,
      status: resolution.status,
    },
  };
}

async function resolveVariant(
  ctx: AuthorizationContext,
  variantId: string,
  normalized: string,
): Promise<ScanResolution> {
  if (!ctx.can("products.read")) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  const productsRepo = await import("@/server/products/repository");
  const variant = await productsRepo.findVariantById(ctx.organizationId, variantId);

  if (!variant) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  return {
    type: "variant",
    payload: normalized,
    metadata: {
      variantId: variant.id,
      productId: variant.product_id,
      variantName: variant.name ?? "",
    },
  };
}

async function resolveOrder(
  ctx: AuthorizationContext,
  orderId: string,
  normalized: string,
): Promise<ScanResolution> {
  if (!ctx.can("orders.read")) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  const ordersRepo = await import("@/server/orders/repository");
  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);

  if (!order) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  return {
    type: "order",
    payload: normalized,
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      lifecycleStatus: order.lifecycle_status,
    },
  };
}

async function resolveProductBarcode(
  ctx: AuthorizationContext,
  code: string,
  normalized: string,
): Promise<ScanResolution> {
  if (!ctx.can("products.read")) {
    return { type: "unknown", payload: normalized, metadata: null };
  }

  const productsService = await import("@/server/products/service");

  // Try the exact code first.
  const exact = await productsService.lookupByBarcode(ctx, code);
  if (exact) {
    return {
      type: "product",
      payload: normalized,
      metadata: {
        variantId: exact.variant.id,
        productId: exact.product.id,
        variantName: exact.variant.name ?? "",
        barcode: code,
      },
    };
  }

  // UPC-A → EAN-13: a 12-digit scan may be stored as 13-digit EAN-13.
  const ean = upcAToEan13(code);
  if (ean) {
    const eanResult = await productsService.lookupByBarcode(ctx, ean);
    if (eanResult) {
      return {
        type: "product",
        payload: normalized,
        metadata: {
          variantId: eanResult.variant.id,
          productId: eanResult.product.id,
          variantName: eanResult.variant.name ?? "",
          barcode: ean,
        },
      };
    }
  }

  // EAN-13 → UPC-A: a 13-digit "0"-prefixed scan may be stored as 12-digit UPC-A.
  const upc = ean13ToUpcA(code);
  if (upc) {
    const upcResult = await productsService.lookupByBarcode(ctx, upc);
    if (upcResult) {
      return {
        type: "product",
        payload: normalized,
        metadata: {
          variantId: upcResult.variant.id,
          productId: upcResult.product.id,
          variantName: upcResult.variant.name ?? "",
          barcode: upc,
        },
      };
    }
  }

  // No match — the code is structurally a product barcode but does not exist
  // in this org. Return unknown, never guess.
  return { type: "unknown", payload: normalized, metadata: null };
}
