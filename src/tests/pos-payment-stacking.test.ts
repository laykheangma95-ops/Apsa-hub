/**
 * POS checkout → Record Payment: one focus trap at a time.
 *
 * Background. <BottomSheet> registers its Escape and focusin handlers on
 * `document`, not on its own panel (see its open effect). POS was the first
 * place in APSA where two sheets were open at once: the checkout sheet stayed
 * open behind RecordOrderPaymentSheet, so both traps ran. Each one's rule is
 * "if focus is not inside MY overlay, pull it back to MY panel", and as
 * siblings neither contains the other, so focus ping-ponged between them and
 * the amount field could not hold focus. Escape fired both handlers, which
 * closed the payment sheet AND tore down the checkout sheet — dropping the
 * merchant out of a confirmed order they had not been paid for.
 *
 * The fix is one prop: the checkout sheet stands down (`open && !
 * recordPaymentOpen`) while payment entry is up. It is presentation only —
 * no state is reset, so realDetail, the order id and the success surface come
 * straight back.
 *
 * Why this file is thin. The defect is not visible to a source-string
 * assertion: it is a real `focusin` racing a real `.focus()`, and two real
 * listeners on one real key. So the coverage that matters lives in
 * src/tests/pos-payment-stacking.browser.ts, which drives real Chromium
 * against the real <PosCheckoutSheet>. This file spawns it, in the same shape
 * as src/tests/bottom-sheet-focus-trap.test.ts, and adds the one guard a
 * browser cannot give: that the suite is really driving the shipped component
 * rather than a copy of the pattern.
 *
 * Run: bun test src/tests/pos-payment-stacking.test.ts
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSale } from "@/lib/api";
import { usd } from "@/lib/money";

const root = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

/*
 * Owns a browser process, an HTTP server and a bundle, so it is spawned rather
 * than inlined; it skips itself, loudly, where no Chromium exists, keeping
 * this file runnable on a bare machine.
 */
it("POS never runs two focus traps at once, in a real browser", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/pos-payment-stacking.browser.ts")],
    { cwd: root, encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  // Surface the skip notice when no browser is installed — a silent pass here
  // would be indistinguishable from real coverage.
  else if (result.stderr.includes("SKIPPED")) console.warn(result.stderr.trim());
  expect(result.status).toBe(0);
}, 310000);

describe("the browser suite drives the shipped component, not a copy of the pattern", () => {
  const fixture = read("src/tests/fixtures/pos-payment-stacking-page.tsx");
  const suite = read("src/tests/pos-payment-stacking.browser.ts");

  it("mounts the real PosCheckoutSheet", () => {
    expect(fixture).toContain('from "@/components/pos/PosCheckoutSheet"');
    // Not a local re-render of the stacking pattern: if the component stopped
    // standing the checkout sheet down, this fixture would show the defect.
    expect(fixture).not.toContain("<BottomSheet");
  });

  it("substitutes only the server boundary", () => {
    // Exactly two aliases, both at the network edge. Anything more would mean
    // the suite had started testing a stand-in.
    const aliases = suite.match(/builder\.onResolve\(/g) ?? [];
    expect(aliases.length).toBe(2);
    expect(suite).toContain("^@\\/lib\\/api$");
    expect(suite).toContain("^@\\/api\\/capabilities$");
  });

  it("drives an activated page with real key events", () => {
    expect(suite).toContain("Input.dispatchKeyEvent");
    // Without this the browser delivers no focus events and the containment
    // half of the suite silently stops covering anything.
    expect(suite).toContain('send("Page.bringToFront")');
  });

  it("covers every case the repair calls for", () => {
    for (const proof of [
      "A. only ONE sheet is mounted once payment entry opens",
      "B. the surviving trap is the payment sheet's, and it owns focus",
      "C. Escape closes ONLY the payment sheet",
      "D. the amount field takes focus and KEEPS it",
      "E. Tab stays inside the payment sheet",
      "F. closing payment restores the success surface for the SAME order",
      "G. Record Payment reopens cleanly, with no stale state",
    ]) {
      expect(suite).toContain(proof);
    }
  });
});

/*
 * Test-quality hardening carried over from the independent review: the
 * createSale production guard was asserted only as source text, and a string
 * match cannot tell a live guard from a commented-out one. createSale is a
 * plain importable function, so the guard is provable directly.
 *
 * This is the fake-success boundary — the launch blocker PR #64 exists to
 * close — so it is worth proving rather than describing.
 */
describe("createSale refuses production data at runtime, not just in a comment", () => {
  const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const base = {
    subtotal: usd(500),
    discount: usd(0),
    total: usd(500),
    paymentMethod: "khqr" as const,
  };
  const item = (productId: string) => ({
    productId,
    nameKm: "សាកល្បង",
    nameEn: "Test",
    quantity: 1,
    unitPrice: usd(500),
  });

  it("throws on a production product id", async () => {
    await expect(createSale({ ...base, items: [item(UUID)] })).rejects.toThrow(/prototype-only/);
  });

  it("throws on a production product id hidden among prototype lines", async () => {
    await expect(createSale({ ...base, items: [item("prd-1"), item(UUID)] })).rejects.toThrow(
      /prototype-only/,
    );
  });

  it("throws on a production customer id even when every line is prototype", async () => {
    await expect(createSale({ ...base, items: [item("prd-1")], customerId: UUID })).rejects.toThrow(
      /prototype-only/,
    );
  });

  it("still serves a genuine prototype sale, and never calls COD paid", async () => {
    const sale = await createSale({
      ...base,
      items: [item("prd-1")],
      paymentMethod: "cod",
      customerId: "cus-1",
    });
    expect(sale.code).toStartWith("APSA-");
    expect(sale.paymentStatus).not.toBe("paid");
  });
});
