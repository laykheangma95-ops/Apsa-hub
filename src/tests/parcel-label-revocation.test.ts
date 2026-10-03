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
      "G. native browser print BEFORE authorization prints nothing",
      "H. native browser print after permission revocation prints nothing",
      "I. native browser print after order cancellation prints nothing",
      "J. native browser print after shipment replacement prints only refreshed data",
      "K. a failed pre-print refresh prints nothing",
      "L. closing the dialog destroys a print target",
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
    expect(dialog).toContain("if (!(allowed && live())) return null;");
    // A refused pre-print refresh (e.g. the grant was just revoked) still goes
    // through re-authorization, so a denial evicts the PII and shows denied
    // instead of a generic "refresh failed" (browser proof D).
    const refreshFailure = dialog.slice(dialog.indexOf("} catch {"));
    expect(refreshFailure.indexOf("await reauthorizePrint()")).toBeGreaterThan(-1);
    expect(refreshFailure.indexOf("await reauthorizePrint()")).toBeLessThan(
      refreshFailure.indexOf('setPrintNotice("refreshFailed")'),
    );
    expect(hook).toContain("cancelRefetch: true");
    expect(hook).toMatch(/state\?\.status === "success"/);
    // window.print() is reached only past the refusal check, with a target.
    const sheet = read("src/components/labels/LabelSheet.tsx");
    const handler = sheet.slice(sheet.indexOf("async function handlePrint()"));
    const refusal = handler.indexOf(
      "if (!pages || pages.length === 0 || !openRef.current) return;",
    );
    expect(refusal).toBeGreaterThan(-1);
    expect(handler.indexOf("window.print();")).toBeGreaterThan(refusal);
    // One call site only.
    expect((sheet.match(/^\s+window\.print\(\);$/gm) ?? []).length).toBe(1);
  });

  it("the preview is never the print target; only a validated temporary target prints", () => {
    const sheet = read("src/components/labels/LabelSheet.tsx");
    // Under print media everything but the target is removed from layout.
    expect(sheet).toContain("body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }");
    // The preview does not carry the print-root id or the printable page class.
    expect(sheet).toContain('mapPages(children, pageSize, "apsa-label-preview-page")');
    expect((sheet.match(/id=\{PRINT_ROOT_ID\}/g) ?? []).length).toBe(1);
    // The target is generated only from validated pages, as a child of <body>.
    expect(sheet).toContain("flushSync(() => setPrintPages(pages));");
    expect(sheet).toMatch(/createPortal\(<LabelPrintTarget [^)]*, document\.body\)/);
    // Native print: unarmed beforeprint and afterprint destroy the target, and
    // Ctrl/Cmd+P is routed into the guarded path.
    expect(sheet).toContain('window.addEventListener("beforeprint", onBeforeNativePrint);');
    expect(sheet).toContain('window.addEventListener("afterprint", onAfterPrint);');
    expect(sheet).toContain('window.addEventListener("keydown", onPrintShortcut, true);');
    expect(sheet).toContain("e.preventDefault();");
    // Both guarded dialogs build the target from FRESH data, not the preview.
    expect(dialog).toContain(
      "return fresh.map((d) => <ParcelLabel key={d.order.id} vm={buildParcelLabel(d)} />);",
    );
    const internal = read("src/components/labels/InternalParcelLabelDialog.tsx");
    expect(internal).toContain("onBeforePrint={handleBeforePrint}");
    expect(internal).toContain("verified = fresh;");
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
