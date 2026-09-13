/**
 * Regression tests for BottomSheet modal focus containment.
 *
 * Background: with a sheet open, pressing Shift+Tab twice moved focus to a
 * button on the page behind while the sheet stayed open. The old trap only
 * intervened when `document.activeElement` was *exactly* the first or last tab
 * stop inside the panel and handed every other case to the browser. Right
 * after open, focus sits on the dialog container, which is in neither
 * position — so the first Shift+Tab fell through to the scrim `<button>`
 * (a focusable sibling *before* the panel in DOM order, and not in the panel's
 * own focusable list) and the second fell out of the overlay entirely.
 *
 * The trap's two decisions are pure functions in src/design-system/focus-trap.ts
 * so they can be proven here: this runner has no DOM, and both functions read
 * only a narrow, stubbable slice of an element. The wiring that calls them is
 * asserted against the component source, in the same style as
 * src/tests/motion-polish.test.ts.
 *
 * Run: bun test src/tests/bottom-sheet-focus-trap.test.ts
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  TRAP_FOCUSABLE_SELECTOR,
  collectTrapFocusables,
  isTrapFocusable,
  nextTrapFocus,
  type TrapCandidate,
} from "@/design-system/focus-trap";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const bottomSheet = read("src/design-system/BottomSheet.tsx");

/** A stand-in for one tab stop. Identity is all the cycle logic needs. */
const stop = (name: string) => ({ name });

/**
 * A stubbed element exposing exactly the slice `isTrapFocusable` reads.
 * Rendered and attribute-free unless the test says otherwise.
 */
function candidate(
  tagName: string,
  attrs: Record<string, string> = {},
  opts: { rects?: number; hiddenAncestor?: boolean } = {},
): TrapCandidate {
  return {
    tagName,
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    closest: () => (opts.hiddenAncestor ? {} : null),
    getClientRects: () => ({ length: opts.rects ?? 1 }),
  };
}

describe("nextTrapFocus — Tab and Shift+Tab cannot leave the sheet", () => {
  const [a, b, c] = [stop("a"), stop("b"), stop("c")];
  const stops = [a, b, c];

  /*
   * The reported escape, stated as the rule that failed. `panel` is the dialog
   * container: focusable (tabIndex -1), focused on open, and deliberately NOT
   * one of the panel's tab stops. The old code matched neither the "first" nor
   * the "last" branch here and let the browser move focus — backwards, out of
   * the panel, through the scrim and onto the page.
   */
  it("sends Shift+Tab from the dialog container to the last stop inside, not backwards out", () => {
    const panel = stop("panel");
    expect(nextTrapFocus(stops, panel, true)).toBe(c);
  });

  it("sends Tab from the dialog container to the first stop inside", () => {
    const panel = stop("panel");
    expect(nextTrapFocus(stops, panel, false)).toBe(a);
  });

  /*
   * Second press of the reported repro. Even if focus somehow reached the
   * scrim — which is outside the panel and now out of the tab order — the next
   * Shift+Tab must come back inside rather than continue outwards.
   */
  it("pulls Shift+Tab back inside from the scrim instead of leaving the overlay", () => {
    const scrim = stop("scrim");
    expect(nextTrapFocus(stops, scrim, true)).toBe(c);
    expect(nextTrapFocus(stops, scrim, false)).toBe(a);
  });

  it("treats an unfocused document (null activeElement) as not yet inside", () => {
    expect(nextTrapFocus(stops, null, true)).toBe(c);
    expect(nextTrapFocus(stops, undefined, false)).toBe(a);
  });

  it("wraps Shift+Tab from the first stop round to the last", () => {
    expect(nextTrapFocus(stops, a, true)).toBe(c);
  });

  it("wraps Tab from the last stop round to the first", () => {
    expect(nextTrapFocus(stops, c, false)).toBe(a);
  });

  it("steps forwards and backwards through the middle without escaping", () => {
    expect(nextTrapFocus(stops, a, false)).toBe(b);
    expect(nextTrapFocus(stops, b, false)).toBe(c);
    expect(nextTrapFocus(stops, c, true)).toBe(b);
    expect(nextTrapFocus(stops, b, true)).toBe(a);
  });

  it("never returns a destination outside the sheet's own stops", () => {
    const outside = [stop("panel"), stop("scrim"), stop("retry"), null, a, b, c];
    for (const active of outside) {
      for (const shiftKey of [true, false]) {
        const next = nextTrapFocus(stops, active, shiftKey);
        expect(stops).toContain(next);
      }
    }
  });

  it("keeps a single-stop sheet on that one stop in both directions", () => {
    expect(nextTrapFocus([a], a, true)).toBe(a);
    expect(nextTrapFocus([a], a, false)).toBe(a);
  });

  /*
   * An empty sheet has nowhere to send focus. The contract is an explicit
   * `null` so the caller still swallows the keystroke — returning "no opinion"
   * is what let Tab fall through to the page behind.
   */
  it("reports no destination for a sheet with no tab stops", () => {
    expect(nextTrapFocus([], null, false)).toBeNull();
    expect(nextTrapFocus([], stop("panel"), true)).toBeNull();
  });
});

describe("isTrapFocusable — what counts as a tab stop", () => {
  it("accepts the ordinary interactive elements a sheet is built from", () => {
    expect(isTrapFocusable(candidate("BUTTON"))).toBe(true);
    expect(isTrapFocusable(candidate("INPUT", { type: "text" }))).toBe(true);
    expect(isTrapFocusable(candidate("TEXTAREA"))).toBe(true);
    expect(isTrapFocusable(candidate("SELECT"))).toBe(true);
    expect(isTrapFocusable(candidate("A", { href: "/x" }))).toBe(true);
    expect(isTrapFocusable(candidate("DIV", { tabindex: "0" }))).toBe(true);
  });

  it("rejects a disabled control, so a saving sheet's spinner button is skipped", () => {
    expect(isTrapFocusable(candidate("BUTTON", { disabled: "" }))).toBe(false);
  });

  /*
   * The dialog container and the scrim both carry tabindex="-1". Excluding by
   * value matters: a `[tabindex]` selector alone would have pulled the panel
   * into its own cycle.
   */
  it("rejects anything opted out with a negative tabindex", () => {
    expect(isTrapFocusable(candidate("DIV", { tabindex: "-1" }))).toBe(false);
    expect(isTrapFocusable(candidate("BUTTON", { tabindex: "-1" }))).toBe(false);
  });

  it("rejects a hidden input", () => {
    expect(isTrapFocusable(candidate("INPUT", { type: "hidden" }))).toBe(false);
  });

  it("rejects an element inside an aria-hidden or inert subtree", () => {
    expect(isTrapFocusable(candidate("BUTTON", {}, { hiddenAncestor: true }))).toBe(false);
  });

  it("rejects an element the browser is not rendering", () => {
    expect(isTrapFocusable(candidate("BUTTON", {}, { rects: 0 }))).toBe(false);
  });

  it("matches summary and contenteditable, which the old selector missed", () => {
    expect(TRAP_FOCUSABLE_SELECTOR).toContain("summary");
    expect(TRAP_FOCUSABLE_SELECTOR).toContain("contenteditable");
  });
});

describe("collectTrapFocusables — nested and empty sheet content", () => {
  it("keeps document order for deeply nested content and drops non-stops", () => {
    const nameField = candidate("INPUT", { type: "text" });
    const hidden = candidate("INPUT", { type: "hidden" });
    const disabledSave = candidate("BUTTON", { disabled: "" });
    const save = candidate("BUTTON");
    const panel = {
      // querySelectorAll is depth-first, so this is the order a panel with a
      // field inside a card inside the scroll pane actually yields.
      querySelectorAll: () => [nameField, hidden, disabledSave, save],
    } as unknown as { querySelectorAll(s: string): ArrayLike<HTMLElement> };

    expect(collectTrapFocusables(panel)).toEqual([nameField, save] as unknown as HTMLElement[]);
  });

  it("returns an empty list for a sheet with no focusable content", () => {
    const panel = { querySelectorAll: () => [] } as unknown as {
      querySelectorAll(s: string): ArrayLike<HTMLElement>;
    };
    expect(collectTrapFocusables(panel)).toEqual([]);
  });
});

describe("BottomSheet wiring", () => {
  it("routes Tab through the shared trap instead of the old first/last check", () => {
    expect(bottomSheet).toContain("collectTrapFocusables");
    expect(bottomSheet).toContain("nextTrapFocus");
    // The escape hatch: a Tab branch that only acted on the boundary stops.
    expect(bottomSheet).not.toMatch(/document\.activeElement === first/);
    expect(bottomSheet).not.toMatch(/document\.activeElement === last/);
  });

  it("claims every Tab keystroke while open, including on an empty sheet", () => {
    const guard = 'if (event.key !== "Tab") return;';
    const body = bottomSheet
      .slice(
        bottomSheet.indexOf(guard) + guard.length,
        bottomSheet.indexOf('document.addEventListener("keydown"'),
      )
      // Prose about `return` is not code.
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(body).toContain("event.preventDefault()");
    // No early `return` may sit between the Tab guard and preventDefault, or
    // the browser gets the keystroke back and focus leaves the sheet.
    const beforePrevent = body.slice(0, body.indexOf("event.preventDefault()"));
    expect(beforePrevent).not.toMatch(/\breturn\b/);
    // An empty sheet keeps focus on the dialog container rather than escaping.
    expect(body).toContain("(next ?? panel).focus()");
  });

  it("keeps the scrim out of the tab order", () => {
    const scrim = bottomSheet.slice(
      bottomSheet.indexOf("<motion.button"),
      bottomSheet.indexOf("<motion.div"),
    );
    expect(scrim).toContain("tabIndex={-1}");
  });

  it("pulls focus back inside when it lands outside the overlay", () => {
    expect(bottomSheet).toContain("overlayRef");
    expect(bottomSheet).toMatch(
      /if \(!overlayRef\.current\?\.contains\(field\)\) \{\s*panel\.focus\(\);/,
    );
  });

  /*
   * Focus restoration depends on the effect running once per open. Consumers
   * pass an inline onOpenChange (CreateProductSheet wraps it to reset the
   * form), so keeping it in the dependency array re-ran the effect on every
   * keystroke: teardown restored focus to the trigger, setup stole it to the
   * panel, and restoreRef was overwritten.
   */
  it("keys the open effect to `open` alone so focus is not churned per render", () => {
    expect(bottomSheet).toContain("}, [open]);");
    expect(bottomSheet).not.toContain("}, [open, onOpenChange, reduceMotion]);");
    expect(bottomSheet).toContain("onOpenChangeRef");
  });

  it("still restores focus to the trigger and unlocks body scroll on close", () => {
    expect(bottomSheet).toContain("restoreRef.current = document.activeElement");
    expect(bottomSheet).toContain("restoreRef.current?.focus?.()");
    expect(bottomSheet).toContain('document.body.style.overflow = "hidden"');
    expect(bottomSheet).toContain("document.body.style.overflow = previousOverflow");
  });

  it("still closes on Escape and on scrim click", () => {
    expect(bottomSheet).toContain('if (event.key === "Escape")');
    expect(bottomSheet).toContain("onOpenChangeRef.current(false)");
    expect(bottomSheet).toContain("onClick={() => onOpenChange(false)}");
  });

  it("keeps the sheet stacked above BottomNav and keeps the sticky footer", () => {
    expect(bottomSheet).toContain("z-[60]");
    expect(bottomSheet).toContain("env(safe-area-inset-bottom)");
  });
});
