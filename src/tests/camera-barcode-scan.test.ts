/**
 * Phone-camera barcode scanning.
 *
 * Root cause this covers: on a phone, the POS "scan" control only toggled a
 * keyboard-wedge listener (use-barcode-scanner.ts). There was no camera path at
 * all, so scanning a physical barcode on a phone could never work. These tests
 * prove the camera path's decisions (decoder choice, failure classification,
 * value normalisation, lifecycle / single emission), prove the ZXing fallback
 * decodes real rasterised symbols — APSA's own Code 128 labels and retail
 * EAN-13 — and pin the wiring (wedge and camera never both fire; manual entry
 * always present; library lazy-loaded).
 *
 * Org scoping of the lookup the decoded value is sent to is covered by
 * product-domain.test.ts (lookupByBarcode within/across orgs, exact match).
 *
 * Run: bun test src/tests/camera-barcode-scan.test.ts
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ZXing from "@zxing/library";
import {
  CAMERA_SCAN_FORMATS,
  MAX_BARCODE_LENGTH,
  cameraShouldRun,
  chooseDecoderKind,
  classifyCameraError,
  initialCameraScanStatus,
  nativeFormatsToRequest,
  normalizeScannedCode,
  rgbaToLuminance,
  sampleSize,
  stepCameraScan,
  type CameraScanStatus,
} from "../lib/barcode/camera-scan";
import { createZxingDecoder } from "../lib/barcode/zxing-decoder";
import { code128Modules } from "../lib/barcode/code128";
import { formatApsaBarcode } from "../lib/barcode/apsa-code";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// ── Raster helpers: a 1D symbol drawn the way a camera frame would carry it ──

/** Draw modules (true = bar) as an RGBA frame, with a quiet zone and height. */
function rasterise1D(modules: boolean[], moduleWidth = 3, height = 60, quiet = 12) {
  const all = [...Array(quiet).fill(false), ...modules, ...Array(quiet).fill(false)];
  const width = all.length * moduleWidth;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bar = all[Math.floor(x / moduleWidth)];
      const v = bar ? 0 : 255;
      const p = (y * width + x) * 4;
      rgba[p] = v;
      rgba[p + 1] = v;
      rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  return { rgba, width, height };
}

/**
 * An independent EAN-13 encoder (GS1 tables), so the decode test does not use
 * ZXing to produce the symbol ZXing then reads.
 */
function ean13Modules(digits12: string): { modules: boolean[]; text: string } {
  const L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
  ];
  const G = [
    "0100111",
    "0110011",
    "0011011",
    "0100001",
    "0011101",
    "0111001",
    "0000101",
    "0010001",
    "0001001",
    "0010111",
  ];
  const R = [
    "1110010",
    "1100110",
    "1101100",
    "1000010",
    "1011100",
    "1001110",
    "1010000",
    "1000100",
    "1001000",
    "1110100",
  ];
  const parity = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
  ];
  const d = digits12.split("").map(Number);
  const sum = d.reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  const all = [...d, check];
  const first = all[0] as number;
  let bits = "101";
  for (let i = 1; i <= 6; i++) {
    const n = all[i] as number;
    bits += (parity[first] as string)[i - 1] === "L" ? L[n] : G[n];
  }
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[all[i] as number];
  bits += "101";
  return { modules: bits.split("").map((b) => b === "1"), text: all.join("") };
}

function decodeFrame(frame: { rgba: Uint8ClampedArray; width: number; height: number }) {
  const decoder = createZxingDecoder(ZXing, CAMERA_SCAN_FORMATS);
  return decoder.decode(
    rgbaToLuminance(frame.rgba, frame.width, frame.height),
    frame.width,
    frame.height,
  );
}

// ── Decoder choice ───────────────────────────────────────────────────────────

describe("decoder choice (unsupported-API fallback)", () => {
  it("falls back to ZXing when BarcodeDetector does not exist (iOS Safari, Firefox)", () => {
    expect(chooseDecoderKind({ hasBarcodeDetector: false, supportedFormats: [] })).toBe("zxing");
  });

  it("falls back to ZXing when BarcodeDetector exists but supports no formats", () => {
    expect(chooseDecoderKind({ hasBarcodeDetector: true, supportedFormats: [] })).toBe("zxing");
  });

  it("falls back when native lacks APSA's own Code 128 label format", () => {
    expect(
      chooseDecoderKind({ hasBarcodeDetector: true, supportedFormats: ["qr_code", "ean_13"] }),
    ).toBe("zxing");
  });

  it("uses native only when it supports Code 128 AND EAN-13", () => {
    expect(
      chooseDecoderKind({
        hasBarcodeDetector: true,
        supportedFormats: ["code_128", "ean_13", "qr_code", "upc_a"],
      }),
    ).toBe("native");
  });

  it("requests only formats the platform has, including QR for parcel code scanning", () => {
    const req = nativeFormatsToRequest(["code_128", "ean_13", "qr_code", "aztec"]);
    expect(req).toEqual(["code_128", "ean_13", "qr_code"]);
    expect(CAMERA_SCAN_FORMATS as readonly string[]).toContain("qr_code");
  });
});

// ── Permission / device failures ────────────────────────────────────────────

describe("camera failure classification", () => {
  const cases: Array<[string, string]> = [
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no_camera"],
    ["OverconstrainedError", "no_camera"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["NotSupportedError", "unsupported"],
    ["TypeError", "unsupported"],
    ["SomethingNew", "error"],
  ];
  for (const [name, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyCameraError({ name })).toBe(
        expected as ReturnType<typeof classifyCameraError>,
      );
    });
  }

  it("non-object rejections are a generic error, never a throw", () => {
    expect(classifyCameraError(undefined)).toBe("error");
    expect(classifyCameraError("boom")).toBe("error");
  });
});

// ── Normalisation ───────────────────────────────────────────────────────────

describe("scanned/typed value normalisation", () => {
  it("trims whitespace and strips GS1 FNC1 / control characters", () => {
    expect(normalizeScannedCode("  8850123456789 \n")).toBe("8850123456789");
    expect(normalizeScannedCode("\u001d0108850123456789")).toBe("0108850123456789");
  });

  it("rejects empty, control-only, non-string and over-length values", () => {
    expect(normalizeScannedCode("")).toBeNull();
    expect(normalizeScannedCode("   ")).toBeNull();
    expect(normalizeScannedCode("\u001d\u0000")).toBeNull();
    expect(normalizeScannedCode(42)).toBeNull();
    expect(normalizeScannedCode("9".repeat(MAX_BARCODE_LENGTH + 1))).toBeNull();
    expect(normalizeScannedCode("9".repeat(MAX_BARCODE_LENGTH))).toHaveLength(MAX_BARCODE_LENGTH);
  });

  it("never rewrites a code (exact-match lookup: no UPC/EAN zero-padding guesses)", () => {
    expect(normalizeScannedCode("036000291452")).toBe("036000291452");
    expect(normalizeScannedCode("APSA-abc")).toBe("APSA-abc");
  });

  it("matches the server validator's length ceiling", () => {
    expect(read("api/products.ts")).toContain(
      'barcode: z.string().min(1).max(100, "Barcode too long")',
    );
    expect(MAX_BARCODE_LENGTH).toBe(100);
  });
});

// ── Lifecycle (mobile-safe state) ───────────────────────────────────────────

describe("scanner lifecycle", () => {
  const run = (events: Parameters<typeof stepCameraScan>[1][]) => {
    let status: CameraScanStatus = initialCameraScanStatus;
    const emitted: string[] = [];
    for (const e of events) {
      const step = stepCameraScan(status, e);
      status = step.status;
      if (step.emit !== null) emitted.push(step.emit);
    }
    return { status, emitted };
  };

  it("start → ready → decoded emits exactly once, then stops scanning", () => {
    const { status, emitted } = run([
      { type: "start" },
      { type: "ready" },
      { type: "decoded", raw: "8850123456789" },
      { type: "decoded", raw: "8850123456789" },
      { type: "decoded", raw: "OTHER-CODE" },
    ]);
    expect(emitted).toEqual(["8850123456789"]);
    expect(status).toEqual({ kind: "detected", code: "8850123456789" });
    expect(cameraShouldRun(status)).toBe(false);
  });

  it("ignores decodes before the stream is ready", () => {
    const { emitted, status } = run([{ type: "start" }, { type: "decoded", raw: "123456" }]);
    expect(emitted).toEqual([]);
    expect(status.kind).toBe("starting");
  });

  it("an unusable decode keeps scanning", () => {
    const { emitted, status } = run([
      { type: "start" },
      { type: "ready" },
      { type: "decoded", raw: "   " },
    ]);
    expect(emitted).toEqual([]);
    expect(status.kind).toBe("scanning");
  });

  it("permission failure is terminal until Try again, and releases the camera", () => {
    const failed = run([{ type: "start" }, { type: "fail", reason: "denied" }]);
    expect(failed.status).toEqual({ kind: "failed", reason: "denied" });
    expect(cameraShouldRun(failed.status)).toBe(false);
    // Try again = stop then start.
    const again = stepCameraScan(stepCameraScan(failed.status, { type: "stop" }).status, {
      type: "start",
    });
    expect(again.status.kind).toBe("starting");
  });

  it("page hidden (iOS background) pauses instead of freezing the preview", () => {
    const { status } = run([{ type: "start" }, { type: "ready" }, { type: "hidden" }]);
    expect(status.kind).toBe("paused");
    expect(cameraShouldRun(status)).toBe(false);
    expect(stepCameraScan(status, { type: "start" }).status.kind).toBe("starting");
  });

  it("stop always returns to idle from any state", () => {
    const states: CameraScanStatus[] = [
      { kind: "starting" },
      { kind: "scanning" },
      { kind: "detected", code: "x" },
      { kind: "paused" },
      { kind: "failed", reason: "busy" },
    ];
    for (const s of states) expect(stepCameraScan(s, { type: "stop" }).status.kind).toBe("idle");
  });

  it("a late failure after detection does not overwrite the found code", () => {
    const s: CameraScanStatus = { kind: "detected", code: "abc1" };
    expect(stepCameraScan(s, { type: "fail", reason: "error" }).status).toEqual(s);
  });
});

// ── Frame sampling ──────────────────────────────────────────────────────────

describe("frame sampling", () => {
  it("caps the long edge and never upscales", () => {
    expect(sampleSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(sampleSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(sampleSize(1080, 1920)).toEqual({ width: 540, height: 960 });
  });

  it("returns null before the video has dimensions", () => {
    expect(sampleSize(0, 0)).toBeNull();
  });

  it("converts RGBA to luminance with integer weights", () => {
    const lum = rgbaToLuminance(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
    expect(Array.from(lum)).toEqual([255, 0]);
  });
});

// ── Real decoding through the fallback decoder ──────────────────────────────

describe("ZXing fallback decodes real symbols", () => {
  it("decodes an APSA-generated Code 128 label barcode", () => {
    const code = formatApsaBarcode("11111111-2222-3333-4444-555555555555", "0000123");
    const frame = rasterise1D(code128Modules(code));
    expect(decodeFrame(frame)).toBe(code);
  });

  it("decodes a manufacturer-style Code 128 value", () => {
    const frame = rasterise1D(code128Modules("SKU-TSHIRT-M-BLK"));
    expect(decodeFrame(frame)).toBe("SKU-TSHIRT-M-BLK");
  });

  it("decodes a retail EAN-13 (independent encoder)", () => {
    const { modules, text } = ean13Modules("885012345678");
    expect(decodeFrame(rasterise1D(modules))).toBe(text);
  });

  it("an empty frame does not write to the console (no per-frame warning spam)", () => {
    const original = console.warn;
    let warned = 0;
    console.warn = () => {
      warned++;
    };
    try {
      for (let i = 0; i < 5; i++) decodeFrame(rasterise1D([]));
    } finally {
      console.warn = original;
    }
    expect(warned).toBe(0);
  });

  it("returns null (not a throw) for a frame with no barcode", () => {
    const blank = rasterise1D([]);
    expect(decodeFrame(blank)).toBeNull();
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────

describe("camera scan wiring", () => {
  const pos = read("routes/app.pos.tsx");
  const inventory = read("routes/app.inventory.tsx");
  const sheet = read("components/barcode/CameraScanSheet.tsx");
  const hook = read("hooks/use-camera-barcode-scanner.ts");

  it("POS routes the camera code through the same handleScan (org-scoped lookup)", () => {
    expect(pos).toContain("<CameraScanSheet");
    expect(pos).toContain("onCode={(code) => void handleScan(code)}");
    expect(pos).toContain("lookupVariantByBarcode(code.trim())");
  });

  it("POS wedge listener stands down while the camera sheet is open", () => {
    expect(pos).toMatch(/enabled: canSell && scanEnabled && !checkoutOpen && !cameraOpen/);
  });

  it("Inventory: wedge and camera share one read-only resolver, gated on read capabilities", () => {
    expect(inventory).toContain("onScan: resolveScan");
    expect(inventory).toContain("onCode={resolveScan}");
    expect(inventory).toContain("const canScan = canReadStock && canReadProducts;");
    expect(inventory).toMatch(/enabled: !detailOpen && canScan && !cameraOpen/);
  });

  it("manual entry is always rendered, independent of camera state", () => {
    expect(sheet).toContain('id="camera-scan-manual"');
    expect(sheet).toContain("onSubmit={submitManual}");
    // Not inside any status-conditional branch.
    expect(sheet.indexOf("<form")).toBeGreaterThan(sheet.indexOf("{canRetry ?"));
    expect(sheet).not.toMatch(/\?\s*\(\s*<form/);
  });

  it("video is iOS-inline-safe", () => {
    expect(sheet).toMatch(/<video[\s\S]*playsInline[\s\S]*muted/);
    expect(hook).toContain('video.setAttribute("playsinline", "true")');
  });

  it("the camera is released on close, unmount, hide and detection", () => {
    expect(hook).toContain("track.stop()");
    expect(hook).toContain('document.addEventListener("visibilitychange"');
    expect(hook).toContain('document.removeEventListener("visibilitychange"');
    expect(hook).toMatch(/after\.kind === "detected"\) \{\s*release\(\);/);
  });

  it("ZXing is lazy-loaded, never statically imported into the app bundle", () => {
    for (const src of [hook, sheet, pos, inventory]) {
      expect(src).not.toMatch(/^import[^;]*from "@zxing\/library"/m);
    }
    expect(hook).toContain('import("@zxing/library")');
    expect(read("lib/barcode/zxing-decoder.ts")).toContain(
      'import type * as ZXing from "@zxing/library"',
    );
  });

  it("every scanner message exists in Khmer and English", () => {
    const en = JSON.parse(read("locales/en.json")).barcodeScanner as Record<string, string>;
    const km = JSON.parse(read("locales/km.json")).barcodeScanner as Record<string, string>;
    expect(Object.keys(km).sort()).toEqual(Object.keys(en).sort());
    const keysUsed = [...sheet.matchAll(/"barcodeScanner\.([a-zA-Z]+)"/g)].map((m) => m[1]);
    const keysUsedPos = [...pos.matchAll(/"barcodeScanner\.([a-zA-Z]+)"/g)].map((m) => m[1]);
    for (const k of [...keysUsed, ...keysUsedPos]) {
      expect(en[k as string]).toBeTruthy();
      expect(km[k as string]).toBeTruthy();
    }
  });
});

// ── Lookup tenant scoping (runs without a DB) ───────────────────────────────
//
// product-domain.test.ts Test 13 proves cross-org isolation against a live DB,
// but it is skipped when no Supabase env is configured. These pin the same
// guarantee structurally so it is always enforced.

describe("barcode lookup is org-scoped by the server, never the client", () => {
  const api = read("api/products.ts");
  const service = read("server/products/service.ts");
  const repo = read("server/products/repository.ts");

  const block = (src: string, start: string, len = 1200) =>
    src.slice(src.indexOf(start), src.indexOf(start) + len);

  it("the server function accepts only the barcode — no client organization id", () => {
    const fn = block(api, "export const lookupByBarcodeFn", 500);
    expect(fn).toContain("z.object({ barcode:");
    expect(fn).not.toContain("organization");
    expect(fn).toContain("resolveAuthContext()");
  });

  it("the service requires products.read and scopes by the resolved org", () => {
    const fn = block(service, "export async function lookupByBarcode(", 700);
    expect(fn).toContain('ctx.require("products.read")');
    expect(fn).toContain("repo.findVariantByBarcode(ctx.organizationId, barcode)");
    expect(fn).toContain("repo.findProductById(ctx.organizationId, variant.product_id)");
  });

  it("the repository filters by organization, exact barcode and ACTIVE status (single row)", () => {
    const fn = block(repo, "export async function findVariantByBarcode(", 700);
    expect(fn).toContain('.eq("organization_id", organizationId)');
    expect(fn).toContain('.eq("barcode", barcode.trim())');
    expect(fn).toContain('.eq("status", "ACTIVE")');
    expect(fn).toContain(".maybeSingle()");
  });

  it("duplicate barcodes within an org are impossible at the database", () => {
    const sql = readFileSync(join(root, "..", "supabase/migrations/018_products.sql"), "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX uniq_product_variants_barcode_per_org");
  });
});
