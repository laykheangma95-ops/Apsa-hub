/**
 * Chip aria-pressed/aria-selected semantics — regression coverage for the P2
 * finding that SmartActionStrip's command chips rendered `aria-pressed="false"`.
 * A Smart Action chip fires a one-shot COMMAND (send this reply, open this
 * sheet) — it never stays "pressed" — so per WAI-ARIA a command button must
 * carry no aria-pressed attribute at all, not an explicit "not pressed".
 *
 * `resolveChipAriaProps` (src/design-system/Chip.tsx) is the one place that
 * decides which aria attribute, if any, a chip renders. These tests drive it
 * directly, and also scan the two call sites so a regression — SmartActionStrip
 * going back to `ariaPressed={false}`, or a real toggle chip losing its
 * selected semantics — fails here without a render harness.
 *
 * Run: bun test src/tests/chip-aria-semantics.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { resolveChipAriaProps } from "@/design-system/Chip";

const ROOT = process.cwd();
const readSource = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

describe("resolveChipAriaProps — the accessibility decision", () => {
  it("a command chip (ariaPressed=null) renders no aria-pressed / aria-selected at all", () => {
    expect(resolveChipAriaProps(undefined, null, true)).toEqual({});
    expect(resolveChipAriaProps(undefined, null, false)).toEqual({});
    // Even as a tab-role command (not a real usage today, but the contract
    // must hold): still nothing.
    expect(resolveChipAriaProps("tab", null, true)).toEqual({});
  });

  it("a real toggle chip (ariaPressed omitted) still gets aria-pressed from `selected`", () => {
    expect(resolveChipAriaProps(undefined, undefined, true)).toEqual({ "aria-pressed": true });
    expect(resolveChipAriaProps(undefined, undefined, false)).toEqual({ "aria-pressed": false });
  });

  it("a real toggle TAB chip (ariaPressed omitted) gets aria-selected, not aria-pressed", () => {
    expect(resolveChipAriaProps("tab", undefined, true)).toEqual({ "aria-selected": true });
    expect(resolveChipAriaProps("tab", undefined, false)).toEqual({ "aria-selected": false });
  });

  it("an explicit boolean override still forces that exact value", () => {
    expect(resolveChipAriaProps(undefined, true, false)).toEqual({ "aria-pressed": true });
    expect(resolveChipAriaProps("tab", false, true)).toEqual({ "aria-selected": false });
  });
});

describe("SmartActionStrip never asserts a pressed state for its command chips", () => {
  const FILE = "src/components/inbox/SmartActionStrip.tsx";

  it("passes ariaPressed={null}, never ariaPressed={false}", () => {
    const source = readSource(FILE);
    expect(source).toContain("ariaPressed={null}");
    expect(source).not.toContain("ariaPressed={false}");
  });
});

describe("legitimate Chip toggle/selection usage keeps working", () => {
  const TOGGLE_SITES = [
    "src/routes/app.inbox.tsx",
    "src/routes/app.pos.tsx",
    "src/routes/app.deliveries.tsx",
    "src/routes/app.products.tsx",
    "src/routes/app.products.$id.tsx",
    "src/routes/app.inventory.tsx",
    "src/routes/app.payments.tsx",
    "src/components/products/CategoryChoice.tsx",
    "src/components/products/MoneyAmountField.tsx",
    "src/components/inventory/LocationChoice.tsx",
    "src/components/inventory/ReceiveStockSheet.tsx",
  ];

  it("drives Chip's selected state through `selected`, with no ariaPressed override at all", () => {
    // These are real toggle/filter/variant chips: they rely on the default
    // (ariaPressed omitted -> falls back to `selected`) to get a correct
    // aria-pressed/aria-selected automatically. None of them needs, or may
    // start needing, an explicit ariaPressed to keep that semantics.
    for (const file of TOGGLE_SITES) {
      const source = readSource(file);
      expect(source).toContain("selected={");
      expect(source).not.toContain("ariaPressed");
    }
  });

  it("Chip itself still supports an explicit boolean ariaPressed for a real forced state", () => {
    const source = readSource("src/design-system/Chip.tsx");
    expect(source).toContain("ariaPressed?: boolean | null");
  });
});
