/**
 * Camera barcode scanning — the pure, DOM-free decisions.
 *
 * APSA's first scanner (use-barcode-scanner.ts) only listens for a USB /
 * Bluetooth keyboard-wedge scanner. A merchant on a phone has no wedge, so the
 * POS scan control did nothing for them. The camera path fills that gap, and
 * everything it decides that can be decided without a camera lives here so it
 * is proven by `bun test` rather than eyeballed on a device:
 *
 *   - which decoder runs (native BarcodeDetector, else the ZXing fallback);
 *   - how a getUserMedia failure is explained to the merchant;
 *   - what a decoded value must look like before it reaches the lookup;
 *   - the scanner lifecycle, including "one decode = one emission".
 *
 * The lookup itself is NOT here: the decoded value goes to the same org-scoped
 * server lookup (lookupByBarcodeFn) a wedge scan or typed code uses. The camera
 * is only another way of typing the barcode.
 */

/**
 * Symbologies the camera looks for, in BarcodeDetector's vocabulary.
 *
 * code_128 is what APSA prints on its own labels (src/lib/barcode/code128.ts);
 * the EAN/UPC family is what manufacturer packaging carries; code_39 and itf
 * cover older retail and carton stock. qr_code is included so the camera can
 * decode APSA parcel QRs (APSA:PCL:v1:<token>) and variant/order QRs — the
 * scan router (src/lib/barcode/scan-router.ts) classifies the decoded value.
 */
export const CAMERA_SCAN_FORMATS = [
  "code_128",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_39",
  "itf",
  "qr_code",
] as const;

export type CameraScanFormat = (typeof CAMERA_SCAN_FORMATS)[number];

/** Native formats that must ALL be supported before the native decoder is trusted. */
const NATIVE_REQUIRED_FORMATS: readonly CameraScanFormat[] = ["code_128", "ean_13"];

export type DecoderKind = "native" | "zxing";

/**
 * Pick the decoder. Native BarcodeDetector is used only when it exists AND
 * reports support for both APSA's own label symbology and retail EAN-13 — some
 * Chromium builds expose the constructor with an empty format list (no platform
 * barcode service), which would scan forever and find nothing. Everything else
 * (iOS Safari, Firefox, those Chromium builds) gets the ZXing fallback.
 */
export function chooseDecoderKind(input: {
  hasBarcodeDetector: boolean;
  supportedFormats: readonly string[];
}): DecoderKind {
  if (!input.hasBarcodeDetector) return "zxing";
  const supported = new Set(input.supportedFormats);
  return NATIVE_REQUIRED_FORMATS.every((f) => supported.has(f)) ? "native" : "zxing";
}

/** The native formats to request: what we want, intersected with what the platform has. */
export function nativeFormatsToRequest(supportedFormats: readonly string[]): CameraScanFormat[] {
  const supported = new Set(supportedFormats);
  return CAMERA_SCAN_FORMATS.filter((f) => supported.has(f));
}

/** Why the camera is not scanning — each maps to one merchant-facing message. */
export type CameraFailure = "denied" | "no_camera" | "busy" | "unsupported" | "error";

/**
 * Classify a getUserMedia / play() rejection by its DOMException name. Names are
 * the stable contract across Safari, Chrome and Firefox; messages are not.
 */
export function classifyCameraError(err: unknown): CameraFailure {
  const name =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no_camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    case "TypeError":
    case "NotSupportedError":
      return "unsupported";
    default:
      return "error";
  }
}

/** Same ceiling lookupByBarcodeFn's validator enforces. */
export const MAX_BARCODE_LENGTH = 100;

/**
 * Turn a decoded (or typed) value into what the lookup receives, or null when it
 * cannot be a barcode. Strips ASCII control characters — GS1 symbols carry an
 * FNC1 group separator (0x1D) that is never part of a stored barcode — and
 * surrounding whitespace. Never rewrites the code otherwise (no EAN/UPC
 * zero-padding guesses): the lookup is exact-match by design.
 */
export function normalizeScannedCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0 || cleaned.length > MAX_BARCODE_LENGTH) return null;
  return cleaned;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type CameraScanStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "detected"; code: string }
  | { kind: "paused" }
  | { kind: "failed"; reason: CameraFailure };

export type CameraScanEvent =
  | { type: "start" }
  | { type: "ready" }
  | { type: "decoded"; raw: unknown }
  | { type: "fail"; reason: CameraFailure }
  | { type: "hidden" }
  | { type: "stop" };

export interface CameraScanStep {
  status: CameraScanStatus;
  /** A code to hand to the lookup — set on exactly one step per scanning session. */
  emit: string | null;
}

export const initialCameraScanStatus: CameraScanStatus = { kind: "idle" };

/**
 * Advance the scanner. Rules:
 *   - stop always returns to idle (sheet closed, route left — camera released);
 *   - start is accepted from idle, paused and failed (Try again);
 *   - a decode is honoured only while scanning, and moves to `detected`, so the
 *     frame loop can never emit the same physical scan twice (no double add);
 *   - an unusable decode (empty, control chars only, too long) is ignored and
 *     scanning continues;
 *   - the page being hidden (iOS backgrounding kills the stream) pauses rather
 *     than leaving a frozen preview that silently never scans.
 */
export function stepCameraScan(status: CameraScanStatus, event: CameraScanEvent): CameraScanStep {
  const stay = { status, emit: null };
  switch (event.type) {
    case "stop":
      return { status: { kind: "idle" }, emit: null };
    case "start":
      if (status.kind === "idle" || status.kind === "paused" || status.kind === "failed") {
        return { status: { kind: "starting" }, emit: null };
      }
      return stay;
    case "ready":
      return status.kind === "starting" ? { status: { kind: "scanning" }, emit: null } : stay;
    case "decoded": {
      if (status.kind !== "scanning") return stay;
      const code = normalizeScannedCode(event.raw);
      if (code === null) return stay;
      return { status: { kind: "detected", code }, emit: code };
    }
    case "fail":
      return status.kind === "starting" || status.kind === "scanning"
        ? { status: { kind: "failed", reason: event.reason }, emit: null }
        : stay;
    case "hidden":
      return status.kind === "starting" || status.kind === "scanning"
        ? { status: { kind: "paused" }, emit: null }
        : stay;
  }
}

/** True while the camera stream should be held open. */
export function cameraShouldRun(status: CameraScanStatus): boolean {
  return status.kind === "starting" || status.kind === "scanning";
}

// ── Frame → luminance (shared by the ZXing fallback and its tests) ───────────

/**
 * RGBA pixels (canvas getImageData layout) to 8-bit luminance, using the same
 * integer weights ZXing's own RGB source uses. Integer-only on purpose.
 */
export function rgbaToLuminance(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    out[i] = (r + 2 * g + b) >> 2;
  }
  return out;
}

/**
 * Size the frame the fallback decoder samples: long edge capped so a 4K phone
 * sensor does not cost a quarter-second per attempt, never upscaled.
 */
export function sampleSize(
  videoWidth: number,
  videoHeight: number,
  maxEdge = 960,
): { width: number; height: number } | null {
  if (videoWidth <= 0 || videoHeight <= 0) return null;
  const scale = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight));
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}
