/**
 * APSA barcode + QR toolkit (pure, client-safe).
 *
 * Product identification and label rendering for V1. Everything here is
 * dependency-free and deterministic; the server owns uniqueness (collision
 * checks) and authorization, never this module.
 */
export {
  encodeCode128B,
  code128Modules,
  code128ModuleCount,
  renderCode128Svg,
  isCode128Encodable,
  type Code128RenderOptions,
} from "./code128";

export {
  APSA_BARCODE_PREFIX,
  APSA_BARCODE_LENGTH,
  APSA_SERIAL_LENGTH,
  orgBarcodePrefix,
  luhnCheckDigit,
  formatApsaBarcode,
  isValidApsaBarcode,
  looksLikeApsaBarcode,
} from "./apsa-code";

export {
  APSA_QR_SCHEME,
  variantQrPayload,
  orderQrPayload,
  parseApsaQrPayload,
  type ApsaQrKind,
  type ApsaQrRef,
} from "./payload";

export {
  qrMatrix,
  renderQrSvg,
  QR_MIN_QUIET_MODULES,
  type QrEcLevel,
  type QrRenderOptions,
} from "./qr";

export {
  PARCEL_CODE_PREFIX,
  PARCEL_CODE_TOKEN_LENGTH,
  PARCEL_CODE_LENGTH,
  isValidParcelCode,
  looksLikeParcelCode,
} from "./parcel-code";

export { classifyScan, type ScanIdentity } from "./scan-router";

export { normalizeScanInput, upcAToEan13, ean13ToUpcA } from "./normalize";
