/**
 * INTERNAL APSA Parcel label — view model (CORRECTION-003).
 *
 * APSA has two identities on a parcel, and two labels:
 *
 *   1. The APSA Parcel (this label): the ORDER's internal warehouse identity,
 *      generated when the order is confirmed and stable through packing, every
 *      carrier shipment, courier handoff and returns. It is the only label that
 *      carries the APSA QR and Code 128 — both encode the same opaque parcel
 *      code (APSA:PCL:v1:…) and nothing else. Used only by APSA staff; the
 *      courier never scans it.
 *   2. The shipping label (./parcel-label.ts): exists only once a carrier
 *      shipment is arranged; carrier, tracking, sender, receiver, COD. It may
 *      show the APSA Parcel ID as text, never as a scannable APSA code.
 *
 * No customer PII and no carrier data appear here. Pure and client-safe.
 */
import { renderQrSvg } from "@/lib/barcode/qr";
import { renderCode128Svg, isCode128Encodable } from "@/lib/barcode/code128";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";
import { formatPrintedAt, PARCEL_LABEL_SIZE_MM } from "./parcel-label";

/** Same 100 × 150 mm stock as the shipping label: one printer roll for both. */
export const INTERNAL_PARCEL_LABEL_SIZE_MM = PARCEL_LABEL_SIZE_MM;

/** Mirrors the server's InternalParcelLabelData structurally (client-safe). */
export interface InternalParcelLabelInput {
  merchant: { businessName: string };
  order: { id: string; orderNumber: string; itemCount: number };
  parcelCode: string | null;
}

export interface InternalParcelLabelViewModel {
  merchantName: string;
  orderNumber: string;
  itemCount: number;
  /** The validated APSA parcel code, or null (then no code is rendered at all). */
  parcelCode: string | null;
  /** QR of the APSA parcel code; null without a valid code (never an order-UUID fallback). */
  qr: { payload: string; svg: string } | null;
  /** Code 128 of the SAME parcel code; null without a valid code. */
  code128: { payload: string; svg: string } | null;
  printTimestamp: string;
  printedAt: string;
}

export function buildInternalParcelLabel(
  input: InternalParcelLabelInput,
  options: { now?: Date } = {},
): InternalParcelLabelViewModel {
  const now = options.now ?? new Date();
  const parcelCode =
    input.parcelCode && isValidParcelCode(input.parcelCode) ? input.parcelCode : null;
  return {
    merchantName: input.merchant.businessName.trim(),
    orderNumber: input.order.orderNumber,
    itemCount: input.order.itemCount,
    parcelCode,
    qr: parcelCode
      ? {
          payload: parcelCode,
          svg: renderQrSvg(parcelCode, { moduleSize: 4, quietModules: 4, ecLevel: "M" }),
        }
      : null,
    code128:
      parcelCode && isCode128Encodable(parcelCode)
        ? {
            payload: parcelCode,
            svg: renderCode128Svg(parcelCode, { moduleWidth: 2, height: 40, quietModules: 10 }),
          }
        : null,
    printTimestamp: now.toISOString(),
    printedAt: formatPrintedAt(now),
  };
}
