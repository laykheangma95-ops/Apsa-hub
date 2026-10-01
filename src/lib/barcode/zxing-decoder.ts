/**
 * The ZXing fallback decoder for browsers without a usable BarcodeDetector
 * (iOS Safari, Firefox, Chromium builds with no platform barcode service).
 *
 * Takes the @zxing/library namespace as an argument rather than importing it,
 * so the browser loads the library lazily (only when a merchant opens the
 * camera on such a browser — it never enters the main bundle) while `bun test`
 * passes the statically imported module and decodes real rasterised symbols.
 * One code path for both: luminance in, text or null out.
 */
import type * as ZXing from "@zxing/library";
import type { CameraScanFormat } from "@/lib/barcode/camera-scan";

export interface LuminanceDecoder {
  /** Decoded text, or null when no barcode is in this frame. Never throws for "not found". */
  decode(luminance: Uint8ClampedArray, width: number, height: number): string | null;
}

function zxingFormat(lib: typeof ZXing, format: CameraScanFormat): ZXing.BarcodeFormat {
  const F = lib.BarcodeFormat;
  switch (format) {
    case "code_128":
      return F.CODE_128;
    case "ean_13":
      return F.EAN_13;
    case "ean_8":
      return F.EAN_8;
    case "upc_a":
      return F.UPC_A;
    case "upc_e":
      return F.UPC_E;
    case "code_39":
      return F.CODE_39;
    case "itf":
      return F.ITF;
  }
}

export function createZxingDecoder(
  lib: typeof ZXing,
  formats: readonly CameraScanFormat[],
): LuminanceDecoder {
  const hints = new Map<ZXing.DecodeHintType, unknown>();
  hints.set(
    lib.DecodeHintType.POSSIBLE_FORMATS,
    formats.map((f) => zxingFormat(lib, f)),
  );
  // Phone frames are rarely square-on; TRY_HARDER scans more rows and also
  // tries the frame rotated, which is what makes a hand-held 1D scan work.
  hints.set(lib.DecodeHintType.TRY_HARDER, true);
  // MultiFormatOneDReader, not MultiFormatReader: every format we scan is 1D,
  // and MultiFormatReader console.warn()s on each frame that holds no barcode
  // (a NotFoundException it fails to recognise), which at ~6 frames/s would
  // flood the merchant's console.
  const reader = new lib.MultiFormatOneDReader(hints);

  return {
    decode(luminance, width, height) {
      const source = new lib.RGBLuminanceSource(luminance, width, height);
      const bitmap = new lib.BinaryBitmap(new lib.HybridBinarizer(source));
      try {
        return reader.decode(bitmap, hints).getText();
      } catch {
        // NotFound / Checksum / Format all mean "no usable barcode in this
        // frame" — the next frame is the retry. Nothing here is fatal.
        return null;
      } finally {
        reader.reset();
      }
    },
  };
}
