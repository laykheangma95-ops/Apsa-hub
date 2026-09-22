/**
 * Payment action sheets — aria-busy regression (P3).
 *
 * Verify/Refund/Reverse already disable their submit button and swap its
 * label to "working…" while `pending` is true, but did not expose that state
 * to assistive tech via aria-busy. No render harness exists in this repo
 * (see payments-operations-ui.test.ts), so this scans the real source for
 * the wiring on each of the three submit buttons.
 *
 * Run: bun test src/tests/payment-action-sheets-aria-busy.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const FILE = "src/components/payments/PaymentActionSheets.tsx";
const source = fs.readFileSync(path.resolve(process.cwd(), FILE), "utf-8");

/** The three submit <Button> blocks, isolated by their onClick/onConfirm shape. */
function buttonBlock(afterMarker: string): string {
  const idx = source.indexOf(afterMarker);
  expect(idx, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<Button", idx);
  const end = source.indexOf("</Button>", idx) + "</Button>".length;
  return source.slice(start, end);
}

describe("PaymentActionSheets — aria-busy while a mutation is pending", () => {
  it("PaymentVerifySheet's submit exposes aria-busy={pending}", () => {
    const block = buttonBlock("onConfirm(trimmed.length > 0 ? trimmed : undefined)");
    expect(block).toContain("aria-busy={pending}");
    expect(block).toContain("disabled={pending}");
  });

  it("PaymentRefundSheet's submit exposes aria-busy={pending}", () => {
    const block = buttonBlock("onConfirm(parsed, trimmedReason)");
    expect(block).toContain("aria-busy={pending}");
    expect(block).toContain("disabled={pending || !amountValid || trimmedReason.length === 0}");
  });

  it("PaymentReverseSheet's submit exposes aria-busy={pending}", () => {
    const block = buttonBlock("onClick={() => onConfirm(trimmed)}");
    expect(block).toContain("aria-busy={pending}");
    expect(block).toContain("disabled={pending || trimmed.length === 0}");
  });

  it("every pending submit button in the file is wired the same way", () => {
    const disabledCount = (source.match(/disabled=\{pending/g) ?? []).length;
    const busyCount = (source.match(/aria-busy=\{pending\}/g) ?? []).length;
    expect(busyCount).toBe(disabledCount);
    expect(busyCount).toBe(3);
  });
});
