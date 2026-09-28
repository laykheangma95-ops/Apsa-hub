/**
 * Product label view-model builder (pure, client-safe).
 *
 * Assembles everything a 50×30 mm product label prints (§6): product name,
 * variant, SKU, a Code 128 barcode with its human-readable number, the price,
 * and an optional APSA QR. Pure and deterministic — it renders the SVGs itself so
 * the label component stays a thin presenter and the output is testable without a
 * DOM.
 *
 * It never fabricates money: the price is formatted from the authoritative Money
 * value (integer minor units) with the shared formatMoney, never recomputed.
 */
import type { Money } from "@/types";
import { formatMoney } from "@/lib/money";
import { renderCode128Svg } from "@/lib/barcode/code128";
import { renderQrSvg } from "@/lib/barcode/qr";
import { variantQrPayload } from "@/lib/barcode/payload";

/** Default physical target for a product label. */
export const PRODUCT_LABEL_SIZE_MM = { width: 50, height: 30 } as const;

export interface ProductLabelInput {
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  /** The variant's barcode (manufacturer, manual, or APSA-generated). */
  barcode?: string | null;
  price: Money;
  /** Render an APSA QR resolving to this variant. Requires a UUID variantId. */
  includeQr?: boolean;
  variantId?: string | null;
}

export interface ProductLabelViewModel {
  productName: string;
  variantName: string | null;
  sku: string | null;
  /** The raw barcode value, shown as the human-readable number under the bars. */
  barcode: string | null;
  /** Code 128 SVG for the barcode, or null when the variant has no barcode. */
  barcodeSvg: string | null;
  priceFormatted: string;
  /** Present only when includeQr is set AND a valid variantId is supplied. */
  qr: { payload: string; svg: string } | null;
}

export function buildProductLabel(input: ProductLabelInput): ProductLabelViewModel {
  const barcode = input.barcode?.trim() || null;
  const sku = input.sku?.trim() || null;
  const variantName = input.variantName?.trim() || null;

  let qr: ProductLabelViewModel["qr"] = null;
  if (input.includeQr && input.variantId) {
    // variantQrPayload throws on a non-UUID; a label must not silently drop the
    // QR, so callers pass a real variant id or leave includeQr off.
    const payload = variantQrPayload(input.variantId);
    qr = { payload, svg: renderQrSvg(payload, { moduleSize: 3, quietModules: 2, ecLevel: "M" }) };
  }

  return {
    productName: input.productName,
    variantName,
    sku,
    barcode,
    barcodeSvg: barcode ? renderCode128Svg(barcode, { moduleWidth: 2, height: 48 }) : null,
    priceFormatted: formatMoney(input.price),
    qr,
  };
}
