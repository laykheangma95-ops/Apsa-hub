/**
 * Scan identity router — classifies a decoded barcode/QR value by type.
 *
 * Every scan in APSA (camera, wedge, typed) passes through this pure classifier
 * before reaching any business logic. The classifier answers ONE question: "what
 * kind of thing did the merchant scan?" It never performs a lookup, never
 * touches the network, and never decides what action to take — that is the
 * caller's domain.
 *
 * Kinds:
 *   - apsa-parcel:    an APSA parcel code (APSA:PCL:v1:<token>)
 *   - apsa-variant:   an APSA variant QR (apsa:variant/<uuid>)
 *   - apsa-order:     an APSA order QR (apsa:order/<uuid>)
 *   - product-barcode: a retail barcode (EAN, UPC, Code 128) including APSA-
 *                      generated product barcodes (APSA<org><serial><check>)
 *   - unknown:        unrecognisable input — never silently promoted to product
 *
 * Ordering matters: parcel codes are checked FIRST because both parcel codes
 * and APSA product barcodes start with "APSA". The parcel prefix "APSA:PCL:v1:"
 * is longer and more specific, so it wins.
 */

import { parseApsaQrPayload } from "./payload";
import { isValidParcelCode, looksLikeParcelCode } from "./parcel-code";
import { looksLikeApsaBarcode, isValidApsaBarcode } from "./apsa-code";

export type ScanIdentity =
  | { kind: "apsa-parcel"; code: string }
  | { kind: "apsa-variant"; id: string }
  | { kind: "apsa-order"; id: string }
  | { kind: "product-barcode"; code: string }
  | { kind: "unknown"; raw: string };

/**
 * Classify a scanned value into its APSA identity type. Pure, deterministic,
 * no I/O. The input is the raw decoded string from a camera, wedge scanner,
 * or manual entry field.
 */
export function classifyScan(raw: string): ScanIdentity {
  if (typeof raw !== "string" || raw.length === 0) {
    return { kind: "unknown", raw: String(raw ?? "") };
  }

  // 1. APSA parcel code — checked first because it also starts with "APSA"
  if (looksLikeParcelCode(raw)) {
    return isValidParcelCode(raw) ? { kind: "apsa-parcel", code: raw } : { kind: "unknown", raw };
  }

  // 2. APSA QR payloads (apsa:variant/<uuid> or apsa:order/<uuid>)
  const qrRef = parseApsaQrPayload(raw);
  if (qrRef) {
    return qrRef.kind === "variant"
      ? { kind: "apsa-variant", id: qrRef.id }
      : { kind: "apsa-order", id: qrRef.id };
  }

  // 3. APSA-generated product barcode (APSA<org><serial><check>)
  if (looksLikeApsaBarcode(raw)) {
    return isValidApsaBarcode(raw)
      ? { kind: "product-barcode", code: raw }
      : { kind: "unknown", raw };
  }

  // 4. Any other non-empty string is a manufacturer retail barcode
  return { kind: "product-barcode", code: raw };
}
