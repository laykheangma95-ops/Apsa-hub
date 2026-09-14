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
 * A stub, though, agrees with us by construction — it cannot answer "will the
 * browser actually focus this?", which is the question behind the second bug
 * this file covers: `visibility: hidden` controls and controls inside
 * `<fieldset disabled>` looked focusable (right selector, real client rects, no
 * `disabled` attribute of their own) but refuse `.focus()`. Since Tab is always
 * prevented, choosing one stranded focus on the previous control. So the rules
 * below are also proven against real Chromium driving the real component, in
 * src/tests/bottom-sheet-focus-trap.browser.ts, spawned at the end of this file.
 *
 * That split is why effective disabled state is no longer computed here at all.
 * Nested `<fieldset disabled>`s made the derived version wrong — a control in
 * an inner fieldset's first `<legend>` is still disabled by an outer one — so
 * the trap asks the platform (`:disabled`) and these tests pin that it obeys
 * the answer. What the answer *is* for each DOM shape is Chromium's to say, and
 * the browser suite says it.
 *
 * Run: bun test src/tests/bottom-sheet-focus-trap.test.ts
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
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

/** The exact ancestor selectors the trap asks about. */
const HIDDEN_ANCESTOR = '[aria-hidden="true"], [inert]';
const DISABLED_FIELDSET = "fieldset[disabled]";
const FIRST_LEGEND = "fieldset[disabled] > legend:first-of-type";
const CLOSED_DETAILS = "details:not([open])";
const CLOSED_DETAILS_ELIGIBLE_SUMMARY = "details:not([open]) > summary:first-of-type";

interface CandidateOpts {
  rects?: number;
  hiddenAncestor?: boolean;
  /**
   * Ancestor selectors this element matches. Matched by exact string, so a
   * test cannot pass by accident if production stops asking what it asks now.
   */
  ancestors?: readonly string[];
  /** Computed visibility. Omitted means "no window" — see `isVisible`. */
  visibility?: string;
  /**
   * What the browser answers for `:disabled` on this element.
   *
   * Stated per case rather than derived, on purpose. Effective disabled state
   * is the platform's computation now — the trap asks `:disabled` instead of
   * re-deriving the nested-fieldset rule from ancestor selectors, which is the
   * defect this file covers — so the honest unit contract is "the trap obeys
   * the platform's verdict". Every value below is Chromium's own answer for
   * that DOM shape, taken from the fixture the browser suite drives.
   */
  platformDisabled?: boolean;
}

/**
 * A stubbed element exposing exactly the slice `isTrapFocusable` reads.
 * Rendered, visible, enabled and attribute-free unless the test says otherwise.
 */
function candidate(
  tagName: string,
  attrs: Record<string, string> = {},
  opts: CandidateOpts = {},
): TrapCandidate {
  const ancestors = new Set<string>(opts.ancestors ?? []);
  if (opts.hiddenAncestor) ancestors.add(HIDDEN_ANCESTOR);
  return {
    tagName,
    matches: (selectors) => selectors === ":disabled" && (opts.platformDisabled ?? false),
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selectors) => (ancestors.has(selectors) ? {} : null),
    getClientRects: () => ({ length: opts.rects ?? 1 }),
    ...(opts.visibility === undefined
      ? {}
      : {
          ownerDocument: {
            defaultView: { getComputedStyle: () => ({ visibility: opts.visibility! }) },
          },
        }),
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
    expect(isTrapFocusable(candidate("BUTTON", { disabled: "" }, { platformDisabled: true }))).toBe(
      false,
    );
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

/*
 * The second bug, and the rule that answers it.
 *
 * Both cases below match the selector, have real client rects and carry no
 * `disabled` attribute of their own, so the first version of this filter called
 * them tab stops — but the browser refuses to focus either. Tab is prevented
 * unconditionally while the sheet is open, so nominating an unfocusable element
 * is not a harmless extra entry in the cycle: `.focus()` no-ops, focus stays on
 * the control before it, and the merchant cannot get past it however many times
 * they press Tab. Proven end to end in bottom-sheet-focus-trap.browser.ts.
 */
describe("isTrapFocusable — controls the browser will not actually focus", () => {
  it("rejects a control hidden by computed visibility, rects and all", () => {
    // The signature of the bug: laid out (rects present), still unfocusable.
    expect(isTrapFocusable(candidate("BUTTON", {}, { visibility: "hidden", rects: 1 }))).toBe(
      false,
    );
    expect(isTrapFocusable(candidate("INPUT", { type: "text" }, { visibility: "hidden" }))).toBe(
      false,
    );
    // `collapse` hides in exactly the same way outside table rows.
    expect(isTrapFocusable(candidate("BUTTON", {}, { visibility: "collapse" }))).toBe(false);
  });

  it("keeps a control that inherits visible from a hidden parent", () => {
    // Computed style already resolves inheritance, so a `visibility: visible`
    // child of a hidden container reads as visible — and is focusable.
    expect(isTrapFocusable(candidate("BUTTON", {}, { visibility: "visible" }))).toBe(true);
  });

  it("rejects a control disabled only by an ancestor fieldset", () => {
    const inFieldset = { ancestors: [DISABLED_FIELDSET], platformDisabled: true };
    expect(isTrapFocusable(candidate("INPUT", { type: "text" }, inFieldset))).toBe(false);
    expect(isTrapFocusable(candidate("BUTTON", {}, inFieldset))).toBe(false);
    expect(isTrapFocusable(candidate("SELECT", {}, inFieldset))).toBe(false);
    expect(isTrapFocusable(candidate("TEXTAREA", {}, inFieldset))).toBe(false);
  });

  it("keeps a control in the disabled fieldset's first legend, which HTML leaves enabled", () => {
    const inLegend = { ancestors: [DISABLED_FIELDSET, FIRST_LEGEND], platformDisabled: false };
    expect(isTrapFocusable(candidate("BUTTON", {}, inLegend))).toBe(true);
  });

  it("keeps an anchor inside a disabled fieldset — `disabled` does not reach it", () => {
    // Over-excluding is not the safe direction: a control the browser will
    // focus but the trap skips is one a merchant can never Tab to.
    expect(
      isTrapFocusable(candidate("A", { href: "/x" }, { ancestors: [DISABLED_FIELDSET] })),
    ).toBe(true);
  });

  it("ignores a `disabled` attribute on an element HTML cannot disable", () => {
    expect(isTrapFocusable(candidate("DIV", { disabled: "", tabindex: "0" }))).toBe(true);
    expect(isTrapFocusable(candidate("A", { href: "/x", disabled: "" }))).toBe(true);
    // Even a selector engine that answered `:disabled` for one of these must
    // not cost a merchant the control: the tag guard runs first.
    expect(
      isTrapFocusable(
        candidate("DIV", { disabled: "", tabindex: "0" }, { platformDisabled: true }),
      ),
    ).toBe(true);
  });

  it("keeps a fixed-position control, the classic false negative", () => {
    // `offsetParent === null` is true of every position: fixed element — which
    // is what a sheet's pinned footer action is. Computed visibility is read
    // instead precisely so that heuristic is never needed.
    expect(isTrapFocusable(candidate("BUTTON", {}, { visibility: "visible" }))).toBe(true);
  });

  it("treats a candidate with no window as visible rather than guessing it away", () => {
    expect(isTrapFocusable(candidate("BUTTON"))).toBe(true);
  });
});

/*
 * The nested-fieldset defect.
 *
 * HTML's rule is not "the nearest disabled fieldset decides". A control is
 * disabled if *any* ancestor `<fieldset disabled>` reaches it, and a fieldset
 * fails to reach only the descendants of its own first `<legend>`. The old
 * check asked `closest()` two questions — "is a disabled fieldset above me?"
 * and "is a first legend above me?" — which conflated the legends of different
 * fieldsets and cleared controls an outer fieldset still disables. Chromium
 * reports those as `:disabled` and refuses `.focus()`, so the trap nominated a
 * tab stop focus could not move to and Tab stalled on the control before it.
 *
 * So the rule is no longer derived: `isDisabledControl` asks the platform.
 * These cases pin that contract — the trap follows `:disabled`, whatever the
 * ancestor shape looks like. That the platform's answers below are the real
 * ones is proven in Chromium, against the same DOM, in
 * bottom-sheet-focus-trap.browser.ts.
 */
describe("isTrapFocusable — nested disabled fieldsets", () => {
  /** The shape that fooled the old rule: in a first legend, still disabled. */
  const NESTED_LEGEND = { ancestors: [DISABLED_FIELDSET, FIRST_LEGEND] };

  it("rejects a first-legend control an outer disabled fieldset still reaches", () => {
    // <fieldset disabled><fieldset disabled><legend><button>: shielded from
    // the inner fieldset only. Chromium: :disabled, and .focus() is a no-op.
    expect(
      isTrapFocusable(candidate("BUTTON", {}, { ...NESTED_LEGEND, platformDisabled: true })),
    ).toBe(false);
    expect(
      isTrapFocusable(
        candidate("INPUT", { type: "text" }, { ...NESTED_LEGEND, platformDisabled: true }),
      ),
    ).toBe(false);
  });

  it("keeps a first-legend control no fieldset reaches, ancestor shape notwithstanding", () => {
    // The same two ancestor selectors match here — a disabled fieldset nested
    // inside the outer one's own first legend — and this one Chromium does
    // focus. Dropping it would strand a merchant just as surely.
    expect(
      isTrapFocusable(candidate("BUTTON", {}, { ...NESTED_LEGEND, platformDisabled: false })),
    ).toBe(true);
  });

  it("rejects a control inside a nested fieldset the outer one cannot reach", () => {
    // #deep-fs-input: outside the outer fieldset's reach, inside its own
    // fieldset's. The old rule found a first legend above it and cleared it.
    expect(
      isTrapFocusable(
        candidate("INPUT", { type: "text" }, { ...NESTED_LEGEND, platformDisabled: true }),
      ),
    ).toBe(false);
  });

  /*
   * The structural half of the fix: the incomplete derivation is gone, not
   * merely outvoted. If the ancestor selectors came back, two elements with
   * identical `closest()` answers could no longer disagree — which is exactly
   * what the two cases above require.
   */
  it("no longer decides disabled-ness from ancestor selectors at all", () => {
    const asked: string[] = [];
    const probe: TrapCandidate = {
      ...candidate("BUTTON"),
      closest: (selectors) => {
        asked.push(selectors);
        return null;
      },
    };
    isTrapFocusable(probe);
    expect(asked).not.toContain(DISABLED_FIELDSET);
    expect(asked).not.toContain(FIRST_LEGEND);
    // The one ancestor question the trap still owns is unrelated to disabling.
    expect(asked).toContain(HIDDEN_ANCESTOR);
  });

  it("asks the platform exactly `:disabled`, and only of disableable tags", () => {
    const asked: string[] = [];
    const probe = (tagName: string): TrapCandidate => ({
      ...candidate(tagName, { href: "/x" }),
      matches: (selectors) => {
        asked.push(selectors);
        return false;
      },
    });
    isTrapFocusable(probe("BUTTON"));
    expect(asked).toEqual([":disabled"]);
    // An <a> is not disableable, so the question is never put.
    asked.length = 0;
    isTrapFocusable(probe("A"));
    expect(asked).toEqual([]);
  });
});

/*
 * The closed-<details> defect this file was reopened for. Chromium can report
 * a client rect and `visibility: visible` for a control collapsed inside a
 * closed <details> — the trap accepted it, BottomSheet's Tab handler focused
 * it, `.focus()` silently no-opped, and Tab stalled: three Tabs stayed on the
 * <summary>, three Shift+Tabs stayed on the control before the details.
 *
 * `isHiddenByClosedDetails` (private; exercised only through `isTrapFocusable`,
 * same as `isDisabledControl` and `isVisible` above) asks two ancestor
 * questions instead of trusting geometry. Real Chromium behavior for each
 * shape below is proven in bottom-sheet-focus-trap.browser.ts.
 */
describe("isTrapFocusable — closed <details> collapsed content", () => {
  it("rejects a control collapsed inside a closed details, rects and visibility notwithstanding", () => {
    const collapsed = {
      ancestors: [CLOSED_DETAILS],
      rects: 1,
      visibility: "visible",
    };
    expect(isTrapFocusable(candidate("INPUT", { type: "text" }, collapsed))).toBe(false);
    expect(isTrapFocusable(candidate("BUTTON", {}, collapsed))).toBe(false);
  });

  it("keeps a closed details' own eligible summary focusable", () => {
    expect(
      isTrapFocusable(
        candidate("SUMMARY", {}, { ancestors: [CLOSED_DETAILS, CLOSED_DETAILS_ELIGIBLE_SUMMARY] }),
      ),
    ).toBe(true);
  });

  it("keeps normal focusability once the details is open", () => {
    // No closed-details ancestor at all — neither selector matches.
    expect(isTrapFocusable(candidate("INPUT", { type: "text" }))).toBe(true);
  });

  it("rejects a second <summary> in the same closed details — only the first is the disclosure widget", () => {
    // Matches CLOSED_DETAILS (a closed details is above it) but not the
    // eligible-summary selector (:first-of-type fails for a second summary).
    expect(isTrapFocusable(candidate("SUMMARY", {}, { ancestors: [CLOSED_DETAILS] }))).toBe(false);
  });

  it("rejects a nested open details' own summary when its outer details is closed", () => {
    // The nested case: an inner <details open> sits inside an outer closed
    // one. The inner summary's real parent is the open inner details, so it
    // can never match `details:not([open]) > summary:first-of-type` — only
    // CLOSED_DETAILS matches, via the outer ancestor. Hidden, exactly like any
    // other content the outer closed details swallows.
    expect(
      isTrapFocusable(candidate("SUMMARY", { type: "text" }, { ancestors: [CLOSED_DETAILS] })),
    ).toBe(false);
  });
});

describe("collectTrapFocusables — nested and empty sheet content", () => {
  it("keeps document order for deeply nested content and drops non-stops", () => {
    const nameField = candidate("INPUT", { type: "text" });
    const hidden = candidate("INPUT", { type: "hidden" });
    const invisible = candidate("BUTTON", {}, { visibility: "hidden" });
    const inDisabledFieldset = candidate(
      "INPUT",
      { type: "text" },
      {
        ancestors: [DISABLED_FIELDSET],
        platformDisabled: true,
      },
    );
    const legendToggle = candidate(
      "BUTTON",
      {},
      { ancestors: [DISABLED_FIELDSET, FIRST_LEGEND], platformDisabled: false },
    );
    // Same ancestor shape as `legendToggle`, opposite platform verdict: a
    // first legend an outer disabled fieldset still reaches. The old rule put
    // this in the list, and Tab then stalled on `legendToggle` for good.
    const nestedLegendToggle = candidate(
      "BUTTON",
      {},
      { ancestors: [DISABLED_FIELDSET, FIRST_LEGEND], platformDisabled: true },
    );
    const disabledSave = candidate("BUTTON", { disabled: "" }, { platformDisabled: true });
    const save = candidate("BUTTON");
    const panel = {
      // querySelectorAll is depth-first, so this is the order a panel with a
      // field inside a card inside the scroll pane actually yields.
      querySelectorAll: () => [
        nameField,
        hidden,
        invisible,
        legendToggle,
        nestedLegendToggle,
        inDisabledFieldset,
        disabledSave,
        save,
      ],
    } as unknown as { querySelectorAll(s: string): ArrayLike<HTMLElement> };

    expect(collectTrapFocusables(panel)).toEqual([
      nameField,
      legendToggle,
      save,
    ] as unknown as HTMLElement[]);
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
    expect(body).toContain("const target = next ?? panel;");
    expect(body).toContain("target.focus()");
    // Defensive verification: a candidate .focus() did not actually move
    // focus to falls back to the panel instead of stranding Tab on the
    // control the merchant was already on.
    expect(body).toContain("if (document.activeElement !== target) panel.focus();");
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

// ═══════════════════════════════════════════════════════════════════════════════
// Real-browser regression (isolated subprocess)
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * The stubs above can only prove that the rule says what we think it says. The
 * bug was that the rule disagreed with the browser, so the rule is also checked
 * against real Chromium driving the real <BottomSheet> — including an assertion
 * that the trap's list of tab stops is *exactly* the set Chromium will focus.
 *
 * Spawned rather than inlined because it owns a browser process, an HTTP server
 * and a bundle; it skips itself, loudly, where no Chromium/Chrome binary
 * exists, so this file stays runnable on a bare machine.
 */
it("BottomSheet focus trap holds in a real browser", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/bottom-sheet-focus-trap.browser.ts")],
    { cwd: root, encoding: "utf8", timeout: 180000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  // Surface the skip notice when no browser is installed — a silent pass here
  // would be indistinguishable from real coverage.
  else if (result.stderr.includes("SKIPPED")) console.warn(result.stderr.trim());
  expect(result.status).toBe(0);
}, 185000);

describe("browser regression coverage exists for this exact bug", () => {
  const browserSuite = read("src/tests/bottom-sheet-focus-trap.browser.ts");

  it("drives the real component, not a re-implementation of its handlers", () => {
    const fixture = read("src/tests/fixtures/bottom-sheet-focus-trap-page.tsx");
    expect(fixture).toContain('from "@/design-system/BottomSheet"');
    expect(fixture).toContain('visibility: "hidden"');
    expect(fixture).toContain("<fieldset disabled>");
    expect(browserSuite).toContain("Input.dispatchKeyEvent");
    // The page must be the foreground one, or the browser delivers no focus
    // events and the containment half of the suite stops covering anything.
    expect(browserSuite).toContain('send("Page.bringToFront")');
  });

  it("covers every case the regression calls for", () => {
    for (const proof of [
      "drives an activated page, so real focus events are delivered",
      "counts exactly the controls Chromium will actually focus",
      "skips a visibility:hidden candidate",
      "skips descendants of <fieldset disabled>",
      "skips a first-legend control an outer disabled fieldset still reaches",
      "tabs past nested disabled fieldsets instead of stalling",
      "advances Tab through every valid control and wraps",
      "walks Shift+Tab back through the same controls without stalling",
      "never lets Tab reach the page behind the sheet",
      "swallows Tab on a sheet with no tab stops at all",
      "keeps a controlled input focused across repeated keystrokes",
      "forward Tab goes before -> summary -> after, never landing on the collapsed input",
      "reverse Shift+Tab goes after -> summary -> before, never landing on the collapsed input",
      "opening the details lets its inner control participate normally",
      "a closed outer details hides an open inner details entirely, summary included",
      "repeated Tab and Shift+Tab keep moving without ever stalling on one control",
    ]) {
      expect(browserSuite).toContain(proof);
    }
  });
});
