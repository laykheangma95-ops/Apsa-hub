/**
 * Every barcode-scan entry point a merchant can tap opens the real camera.
 *
 * Root cause this covers: PR #91 added CameraScanSheet and wired it to new
 * camera buttons on the POS and Inventory screens, but the scan action a
 * phone user actually reaches — the Apsi console's "Scan barcode with camera"
 * row (BottomNav's centre Ask tab, promoted to the top on Inventory/Products)
 * — was still hard-coded `availability: "coming-soon"` with the copy "Camera
 * scanning is not in the app yet". Home's create sheet carried the same stale
 * "Scan barcode · Coming soon" row. Staging phone QA hit the console row.
 *
 * These tests drive the real nav config through the same decision function
 * the console's row uses, and pin the source wiring, so restoring either
 * placeholder fails here.
 *
 * Run: bun test src/tests/barcode-entry-points.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askShortcutBehavior,
  filterBusinessNavConfig,
  getBusinessNavConfig,
  type BusinessNavVariant,
} from "@/design-system/mobile-nav-config";
import { createFixtureCapabilityView, UI_PERMISSION_KEYS } from "@/lib/capabilities";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const VARIANTS: readonly BusinessNavVariant[] = ["online-seller", "mart"];
const owner = createFixtureCapabilityView(UI_PERMISSION_KEYS);

function scanRow(variant: BusinessNavVariant, capabilities = owner) {
  const config = filterBusinessNavConfig(getBusinessNavConfig(variant), capabilities);
  return config.askGroups.flatMap((g) => g.actions).find((a) => a.id === "scan-barcode");
}

/** The body of a top-level `function name(...) { ... }` in a source file. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

describe("Apsi console scan row (the phone path that showed 'Coming soon')", () => {
  it("tapping the scan row opens the camera scanner — for every nav variant", () => {
    for (const variant of VARIANTS) {
      const row = scanRow(variant);
      expect(row).toBeDefined();
      expect(askShortcutBehavior(row!)).toEqual({ kind: "camera-scan" });
    }
  });

  it("the decision function would refuse a restored coming-soon row", () => {
    const row = scanRow("online-seller")!;
    expect(askShortcutBehavior({ ...row, availability: "coming-soon" })).toEqual({
      kind: "unavailable",
    });
  });

  it("no Apsi shortcut is a dead row: each routes or opens a capability", () => {
    for (const variant of VARIANTS) {
      const actions = filterBusinessNavConfig(
        getBusinessNavConfig(variant),
        owner,
      ).askGroups.flatMap((g) => g.actions);
      for (const action of actions) {
        expect({ id: action.id, kind: askShortcutBehavior(action).kind }).not.toEqual({
          id: action.id,
          kind: "unavailable",
        });
      }
    }
  });

  it("stays permission-gated: a member without products.read never sees it", () => {
    const noProducts = createFixtureCapabilityView(
      UI_PERMISSION_KEYS.filter((key) => key !== "products.read"),
    );
    expect(scanRow("online-seller", noProducts)).toBeUndefined();
  });
});

describe("Apsi console wiring", () => {
  const consoleSrc = read("components/apsi/ApsiConsoleSheet.tsx");

  it("renders exactly one CameraScanSheet, as a sibling of the console sheet (never nested)", () => {
    expect(consoleSrc).toContain(
      'import { CameraScanSheet } from "@/components/barcode/CameraScanSheet";',
    );
    expect(consoleSrc.match(/<CameraScanSheet\b/g)).toHaveLength(1);
    expect(consoleSrc.indexOf("<CameraScanSheet")).toBeGreaterThan(
      consoleSrc.lastIndexOf("</BottomSheet>"),
    );
  });

  it("the row's click comes from askShortcutBehavior and opens the camera", () => {
    const row = functionBody(consoleSrc, "ShortcutRow");
    expect(row).toContain("askShortcutBehavior(action)");
    expect(row).toMatch(/behavior\.kind === "camera-scan"\s*\?\s*onCameraScan/);
    expect(row).toContain("onClick={onClick}");
    // The pre-fix handler: disabled purely on coming-soon, click only on a route.
    expect(row).not.toContain('action.availability === "coming-soon"');
    expect(row).not.toContain("onClick={action.to ?");
  });

  it("every shortcut list (empty search and below results) can open the camera", () => {
    expect(consoleSrc.match(/onCameraScan=\{openCameraScan\}/g)).toHaveLength(2);
  });

  it("closes the console before opening the camera — one sheet at a time, no duplicate", () => {
    const open = functionBody(consoleSrc, "openCameraScan");
    expect(open.indexOf("onOpenChange(false)")).toBeGreaterThanOrEqual(0);
    expect(open.indexOf("onOpenChange(false)")).toBeLessThan(open.indexOf("setCameraOpen(true)"));
  });

  it("returns to the console when the camera closes (cancel, denied, or a code)", () => {
    const change = functionBody(consoleSrc, "onCameraOpenChange");
    expect(change).toContain("setCameraOpen(next)");
    expect(change).toContain("if (!next) onOpenChange(true)");
  });

  it("a scanned or typed code goes through the console's existing lookup", () => {
    const scanned = functionBody(consoleSrc, "onScannedCode");
    expect(scanned).toContain("setDraft(code)");
    expect(scanned).toContain("submit(code)");
    expect(consoleSrc).toContain("onCode={onScannedCode}");
  });
});

describe("Home create sheet scan row", () => {
  const home = read("routes/app.index.tsx");

  it("opens the camera instead of the disabled Coming soon row", () => {
    expect(home).toMatch(
      /action\.key === "scanBarcode" \? \([\s\S]*?setCreateOpen\(false\);\s*setCameraOpen\(true\);/,
    );
    expect(home).toContain('{ key: "scanBarcode", to: null, available: canScan }');
    // The camera branch is evaluated before the to: null "not built" branch.
    expect(home.indexOf('action.key === "scanBarcode"')).toBeLessThan(
      home.indexOf('{t("nav.comingSoon")}'),
    );
  });

  it("resolves exactly like Inventory, behind the same read grants", () => {
    expect(home).toContain(
      'const canScan = capabilities.can("inventory.read") && capabilities.can("products.read");',
    );
    expect(home).toContain("lookupVariantByBarcode(code.trim())");
    expect(home).toContain('to: "/app/inventory/$variantId"');
    expect(home.match(/<CameraScanSheet\b/g)).toHaveLength(1);
    expect(home).toMatch(
      /\{canScan \? \(\s*<CameraScanSheet open=\{cameraOpen\} onOpenChange=\{setCameraOpen\} onCode=\{resolveScan\} \/>/,
    );
  });
});

describe("the scanner every entry point opens keeps its safety net", () => {
  const sheet = read("components/barcode/CameraScanSheet.tsx");

  it("manual entry is always present, so a denied camera still finds the product", () => {
    expect(sheet).toContain('id="camera-scan-manual"');
    expect(sheet).toMatch(/case "denied":\s*return "barcodeScanner\.denied"/);
  });

  it("imports BottomSheet directly, so console → scanner is not an import cycle", () => {
    expect(sheet).toContain('import { BottomSheet } from "@/design-system/BottomSheet";');
    expect(sheet).not.toMatch(/from "@\/design-system";/);
  });
});

describe("placeholder copy is gone in both languages", () => {
  it("the scan row no longer says camera scanning is missing", () => {
    const en = JSON.parse(read("locales/en.json")).nav.askActions.scanBarcode.description as string;
    const km = JSON.parse(read("locales/km.json")).nav.askActions.scanBarcode.description as string;
    expect(en).not.toMatch(/not in the app yet/i);
    expect(km).not.toContain("មិនទាន់មាន");
    expect(en.length).toBeGreaterThan(0);
    expect(km.length).toBeGreaterThan(0);
  });
});
