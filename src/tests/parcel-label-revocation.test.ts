/**
 * Parcel label: permission revocation clears PII while the dialog is open, and
 * only one focus trap is live at a time (label overlay ↔ shipping sheet).
 *
 * The coverage that matters is behavioural and lives in
 * src/tests/parcel-label-revocation.browser.ts, which drives real Chromium
 * against the real <ParcelLabelDialog> (same shape as pos-payment-stacking.test.ts).
 * This file spawns it, and pins the guards a browser cannot give: that the suite
 * mounts the shipped component, and the source-level rules the behaviour rests on.
 *
 * Run: bun test src/tests/parcel-label-revocation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

it("parcel label revocation + focus trap behave correctly, in a real browser", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/parcel-label-revocation.browser.ts")],
    { cwd: root, encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  else if (result.stderr.includes("SKIPPED")) console.warn(result.stderr.trim());
  expect(result.status).toBe(0);
}, 310000);

describe("the browser suite drives the shipped dialog, not a copy", () => {
  const fixture = read("src/tests/fixtures/parcel-label-revocation-page.tsx");
  const suite = read("src/tests/parcel-label-revocation.browser.ts");

  it("mounts the real ParcelLabelDialog under the real cache guard", () => {
    expect(fixture).toContain('from "@/components/labels/ParcelLabelDialog"');
    expect(fixture).toContain('from "@/components/fulfillment/FulfillmentSensitiveCacheGuard"');
    expect(fixture).not.toContain("<LabelSheet");
  });

  it("uses the REAL CapabilityProvider — never the fixture provider or a prop swap", () => {
    expect(fixture).toContain("<CapabilityProvider");
    expect(fixture).not.toContain("CapabilityFixtureProvider");
    expect(fixture).not.toContain("setGranted");
  });

  it("substitutes only the server boundary and covers every required transition", () => {
    expect((suite.match(/builder\.onResolve\(/g) ?? []).length).toBe(2);
    for (const proof of [
      "A. a SERVER-side revocation reaches the open label",
      "B. reopening stays denied",
      "D. print-time re-authorization",
      "E. if the fresh authorization request FAILS",
      "F. a snapshotless order shows NO inferred recipient",
      "C. only ONE focus trap is live",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});

describe("capability revalidation source rules", () => {
  const dialog = read("src/components/labels/ParcelLabelDialog.tsx");
  const hook = read("src/hooks/use-capabilities.tsx");

  it("polls the production capability query only while the dialog is open", () => {
    expect(dialog).toContain("useSensitiveCapabilityRevalidation(userId, organizationId, open)");
    expect(hook).toContain("refetchInterval: active ? SENSITIVE_CAPABILITY_REVALIDATE_MS : false");
    expect(hook).toContain("queryKey: capabilityQueryKey(userId, organizationId)");
  });

  it("re-authorizes against the server immediately before printing, failing closed", () => {
    expect(dialog).toContain("onBeforePrint={handleBeforePrint}");
    // Re-authorized as the LAST step, and only honoured if the attempt is
    // still live (same open dialog, user, organization and orders).
    expect(dialog).toContain("const allowed = await reauthorizePrint();");
    expect(dialog).toContain("return allowed && live();");
    expect(hook).toContain("cancelRefetch: true");
    expect(hook).toMatch(/state\?\.status === "success"/);
    expect(read("src/components/labels/LabelSheet.tsx")).toMatch(
      /if \(allowed\) window\.print\(\)/,
    );
  });

  it("never persists capabilities in browser storage", () => {
    expect(hook).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("dialog source rules the behaviour depends on", () => {
  const dialog = read("src/components/labels/ParcelLabelDialog.tsx");
  const sheet = read("src/components/labels/LabelSheet.tsx");

  it("never keeps PII in component state — only an order id is parked", () => {
    expect(dialog).toContain("useState<string | null>(null)");
    expect(dialog).not.toMatch(/useState<\{\s*input: ParcelLabelInput/);
  });

  it("reads label data only while print_label holds, on every render", () => {
    expect(dialog).toMatch(/const data: ParcelLabelInput\[\] = canPrint \?/);
    expect(dialog).toMatch(/canPrint && canConfirm && confirmOrderId/);
  });

  it("the label overlay stands down while the child sheet is open", () => {
    expect(dialog).toContain("active={confirmTarget === null}");
    expect(sheet).toMatch(/if \(!open \|\| !active\) return;/);
    expect(sheet).toContain("e.timeStamp < armedAt");
  });
});
