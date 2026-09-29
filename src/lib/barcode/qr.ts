/**
 * QR Code encoder + SVG renderer (client-safe).
 *
 * V1 renders an optional APSA QR on product labels and on parcel labels using
 * only the browser to print (no SDK). The payloads are tiny `apsa:` references
 * (see ./payload) with no PII or secret, so a low QR version with solid error
 * correction is plenty.
 *
 * ── WHY A LIBRARY, NOT A HAND-ROLLED ENCODER ─────────────────────────────────
 *
 * A previous revision shipped a bespoke ISO/IEC 18004 encoder. Its output
 * passed our structural unit tests (finder patterns, timing, matrix geometry)
 * yet failed independent ZXing/jsQR decoding — the exact class of defect a
 * "does it look like a QR" test cannot catch. Correctness of a 2-D symbology is
 * not something to re-derive: this now delegates to `qrcode-generator`
 * (Kazuhiko Arase's reference implementation, MIT), whose output is decoded by
 * every mainstream reader, and src/tests/qr-decode.test.ts proves that with an
 * INDEPENDENT decoder (jsQR).
 *
 * This module keeps its own tiny SVG renderer so the label toolkit controls the
 * quiet zone and the rect coalescing; it never emits script or external
 * resources. No DOM, no I/O, no randomness — safe to import from client or
 * server. Byte mode is used for every payload (all ASCII today), and the best
 * mask is chosen by the library's own penalty scoring, so identical input
 * yields an identical matrix.
 */
import qrcode from "qrcode-generator";

/**
 * EC level. Kept as L | M (the levels V1 labels use); the underlying library
 * also supports Q | H, but a short `apsa:` payload never needs them and a
 * higher level only makes the symbol denser to print.
 */
export type QrEcLevel = "L" | "M";

/**
 * Standards-safe quiet zone. ISO/IEC 18004 requires a 4-module light margin on
 * every side for reliable acquisition; rendering fewer (the old default on some
 * labels was 2–3) is the first thing that makes a valid symbol undecodable on a
 * cheap camera. This is the floor for every APSA label.
 */
export const QR_MIN_QUIET_MODULES = 4;

/**
 * Encode text into a QR module matrix (true = dark). Deterministic: the library
 * selects the best mask by the spec's penalty score, so identical input yields
 * an identical matrix. Auto-selects the smallest version that fits the payload.
 */
export function qrMatrix(text: string, ecLevel: QrEcLevel = "M"): boolean[][] {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("QR: cannot encode an empty string");
  }

  // typeNumber 0 = auto-select the smallest version that fits. Byte mode covers
  // the ASCII `apsa:` payloads without a Kanji/SJIS table.
  const qr = qrcode(0, ecLevel);
  qr.addData(text, "Byte");
  qr.make();

  const size = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row = new Array<boolean>(size);
    for (let c = 0; c < size; c += 1) {
      row[c] = qr.isDark(r, c);
    }
    matrix.push(row);
  }
  return matrix;
}

export interface QrRenderOptions {
  ecLevel?: QrEcLevel;
  /** Module size in px. Default 4. */
  moduleSize?: number;
  /**
   * Quiet-zone width in modules on each side. Default and minimum 4 (spec).
   * Any value below the 4-module floor is raised to it — a caller cannot render
   * a symbol with too little margin to decode.
   */
  quietModules?: number;
}

/**
 * Render text as a self-contained QR SVG string (black modules on a white quiet
 * zone). No external resources, no script — prints crisply at any physical
 * size. The quiet zone is clamped to the 4-module standard minimum.
 */
export function renderQrSvg(text: string, options: QrRenderOptions = {}): string {
  const moduleSize = options.moduleSize ?? 4;
  const quiet = Math.max(options.quietModules ?? QR_MIN_QUIET_MODULES, QR_MIN_QUIET_MODULES);
  const matrix = qrMatrix(text, options.ecLevel ?? "M");
  const n = matrix.length;
  const dimension = (n + quiet * 2) * moduleSize;

  const rects: string[] = [];
  for (let r = 0; r < n; r += 1) {
    let c = 0;
    while (c < n) {
      if (!matrix[r]![c]) {
        c += 1;
        continue;
      }
      let run = 1;
      while (c + run < n && matrix[r]![c + run]) run += 1;
      const x = (quiet + c) * moduleSize;
      const y = (quiet + r) * moduleSize;
      rects.push(
        `<rect x="${x}" y="${y}" width="${run * moduleSize}" height="${moduleSize}" fill="#000"/>`,
      );
      c += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="#fff"/>` +
    rects.join("") +
    `</svg>`
  );
}
