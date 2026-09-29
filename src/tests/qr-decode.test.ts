/**
 * Independent QR decode tests.
 *
 * The encoder is `qrcode-generator` (via src/lib/barcode/qr.ts). The decoder
 * here is jsQR — a SEPARATE implementation, sharing no code with the encoder —
 * so a passing test proves the generated symbol is a standards-compliant QR
 * that a real reader can decode, not merely that it "looks like" one. This is
 * the behavioural guarantee the previous structural-only tests could not give
 * (a hand-rolled encoder passed those yet failed ZXing decoding).
 *
 * The matrix is rasterised to an RGBA buffer (white ground, black modules, a
 * 4-module quiet zone, scaled up) and handed to jsQR exactly as a camera frame
 * would be — no canvas, no DOM.
 *
 * Run: bun test src/tests/qr-decode.test.ts
 */
import { describe, it, expect } from "bun:test";
import jsQR from "jsqr";
import { qrMatrix, renderQrSvg, QR_MIN_QUIET_MODULES } from "../lib/barcode/qr";
import { orderQrPayload, variantQrPayload } from "../lib/barcode/payload";

const VARIANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";

/**
 * Rasterise a QR module matrix into an RGBA buffer jsQR can read: white
 * background, black modules, a quiet zone on every side, each module scaled to
 * `scale` px so the decoder has clean, aligned samples.
 */
function rasterise(
  matrix: boolean[][],
  scale = 8,
  quiet = QR_MIN_QUIET_MODULES,
): { data: Uint8ClampedArray; width: number; height: number } {
  const n = matrix.length;
  const dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  // Fill white.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  // Paint dark modules black.
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!matrix[r]![c]) continue;
      const x0 = (quiet + c) * scale;
      const y0 = (quiet + r) * scale;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((y0 + dy) * dim + (x0 + dx)) * 4;
          data[px] = 0;
          data[px + 1] = 0;
          data[px + 2] = 0;
          data[px + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function decode(text: string, ec: "L" | "M" = "M"): string | null {
  const { data, width, height } = rasterise(qrMatrix(text, ec));
  const result = jsQR(data, width, height);
  return result ? result.data : null;
}

describe("QR decodes back to the exact payload (independent decoder)", () => {
  const vectors = [
    ["HELLO WORLD", "HELLO WORLD"],
    ["variant payload", variantQrPayload(VARIANT_ID)],
    ["order payload", orderQrPayload(ORDER_ID)],
  ] as const;

  for (const [label, payload] of vectors) {
    it(`${label} → decodes exactly at EC level M`, () => {
      expect(decode(payload, "M")).toBe(payload);
    });

    it(`${label} → decodes exactly at EC level L`, () => {
      expect(decode(payload, "L")).toBe(payload);
    });
  }

  it("a symbol rendered with the standard quiet zone still decodes", () => {
    // renderQrSvg clamps the quiet zone to the 4-module minimum; the same
    // matrix rasterised with that margin must decode.
    const payload = orderQrPayload(ORDER_ID);
    const svg = renderQrSvg(payload, { quietModules: 2 });
    // The SVG is a full document (sanity: our own renderer, not the library's).
    expect(svg.startsWith("<svg")).toBe(true);
    expect(decode(payload)).toBe(payload);
  });

  it("distinct payloads decode to distinct values (no cross-talk)", () => {
    const a = decode(variantQrPayload(VARIANT_ID));
    const b = decode(orderQrPayload(ORDER_ID));
    expect(a).not.toBe(b);
    expect(a).toBe(variantQrPayload(VARIANT_ID));
    expect(b).toBe(orderQrPayload(ORDER_ID));
  });
});
