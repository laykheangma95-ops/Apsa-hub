/*
 * Focus containment for modal surfaces (today: BottomSheet).
 *
 * Split out of the component on purpose. The trap's two decisions — "does this
 * element count as a tab stop?" and "where does Tab go from here?" — are pure,
 * so they live here where they can be tested directly. The repo's test runner
 * has no DOM, and a focus trap is exactly the kind of thing that must be
 * proven rather than eyeballed, so both functions read only a narrow, stubbable
 * slice of an element instead of touching globals.
 */

/**
 * The slice of an element the trap actually reads.
 *
 * Real `HTMLElement`s satisfy this structurally, so production passes DOM nodes
 * and tests pass plain objects — same code path, no DOM dependency.
 */
export interface TrapCandidate {
  readonly tagName: string;
  /**
   * The platform's own selector match. The trap asks it exactly one question —
   * `:disabled` — because effective disabled state is a whole-ancestry
   * computation the browser already performs, and re-deriving it is what
   * shipped a wrong answer. See `isDisabledControl`.
   */
  matches(selectors: string): boolean;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
  getClientRects(): { readonly length: number };
  /**
   * The element's own window, used for one thing only: its computed
   * `visibility`. Read through the element rather than a global so the trap
   * stays testable without a DOM and keeps working inside an iframe or a
   * popout window, where the global `getComputedStyle` is the wrong one.
   *
   * Optional because a stub may not supply it. When it is missing the element
   * is treated as visible — the trap never guesses a control away.
   */
  readonly ownerDocument?: {
    readonly defaultView?: {
      getComputedStyle(element: TrapCandidate): { readonly visibility: string };
    } | null;
  } | null;
}

/**
 * Everything the platform can put in the tab order. Deliberately wider than the
 * old `button, [href], input, select, textarea, [tabindex]` list, which missed
 * `summary`, media with controls, and contenteditable regions — each of them a
 * real tab stop a merchant could land on and then Tab straight out of.
 *
 * `[tabindex]` is matched unfiltered here and narrowed in `isTrapFocusable`,
 * because a negative tabindex must be excluded by *value*, not by selector.
 */
export const TRAP_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(", ");

/**
 * Elements the `disabled` attribute actually disables, per HTML. Nothing else
 * is disableable: `disabled` on a `<div>` or an `<a>` is decoration, the
 * browser still focuses it, and excluding it would strand a reachable control.
 */
const DISABLEABLE = /^(BUTTON|INPUT|SELECT|TEXTAREA|FIELDSET|OPTGROUP|OPTION)$/;

/**
 * Whether a form control is *effectively* disabled — by its own attribute, or
 * by any ancestor `<fieldset disabled>` that reaches it.
 *
 * Delegated to `:disabled` rather than derived, because deriving it is exactly
 * where this trap got it wrong. HTML's rule is not "the nearest disabled
 * fieldset decides": a control is disabled if *any* ancestor
 * `<fieldset disabled>` reaches it, and a fieldset fails to reach only the
 * descendants of its own first `<legend>` child. Reading that off `closest()`
 * — nearest disabled fieldset, then "is a first legend anywhere above me?" —
 * cleared controls an *outer* fieldset still disables:
 *
 *     <fieldset disabled>              // outer: reaches everything below
 *       <fieldset disabled>
 *         <legend><button></legend>    // shielded from the inner fieldset
 *                                      // only — the outer one still applies
 *
 * Chromium reports that button as `:disabled` and refuses to focus it, so the
 * old rule nominated a tab stop `.focus()` cannot move to. Tab is prevented
 * unconditionally while the sheet is open, so that is not a harmless extra
 * entry: focus stayed on the control before it however many times a merchant
 * pressed Tab. The same shape strands focus the other way round, on a control
 * inside a disabled fieldset nested *within* an outer fieldset's first legend.
 *
 * `:disabled` is the browser's own answer to that whole computation — nesting
 * and the legend exception included — so the trap's verdict cannot drift from
 * what `.focus()` will actually do.
 *
 * The tag guard stays in front of it: `:disabled` is asked only of elements
 * HTML can genuinely disable, so a decorative `disabled` attribute on a
 * `<div>` or an `<a href>` never removes a control a merchant can still reach.
 */
function isDisabledControl(element: TrapCandidate): boolean {
  if (!DISABLEABLE.test(element.tagName)) return false;
  return element.matches(":disabled");
}

/** The two ancestor questions `isHiddenByClosedDetails` asks, and nothing else. */
const CLOSED_DETAILS = "details:not([open])";
const CLOSED_DETAILS_ELIGIBLE_SUMMARY = "details:not([open]) > summary:first-of-type";

/**
 * Whether `element` sits inside a closed `<details>`'s collapsed content.
 *
 * Same shape as the fieldset/legend exception above, one level simpler: a
 * closed `<details>` hides everything below it except its own first
 * `<summary>` child — the disclosure widget, which stays focusable and is how
 * a merchant opens it. Nothing else inside a closed details is in the tab
 * order, however deeply nested, and regardless of what `getClientRects()` or
 * computed `visibility` report for it: collapsed-details content is hidden by
 * a UA-stylesheet `display: none` on the details' non-summary children, and
 * Chromium can still surface a client rect and `visibility: visible` for a
 * descendant of that hidden subtree even though `.focus()` refuses to move
 * there — geometry and computed style are not reliable signals for this case,
 * so it is asked for explicitly rather than folded into `isVisible`.
 *
 * Two `closest()` questions, mirroring the fieldset check's two-question
 * shape:
 *
 * 1. `details:not([open])` — is there a closed `<details>` anywhere above
 *    `element` at all? If not, this rule does not apply, open or no
 *    `<details>` in the ancestry.
 * 2. `details:not([open]) > summary:first-of-type` — is `element` itself the
 *    eligible summary of a specific closed `<details>`? Because `matches()`
 *    (which `closest()` calls at each step) checks the *real* parent of the
 *    candidate element, this only answers yes for a `<summary>` that is a
 *    closed `<details>`'s own first `<summary>` child — never a second
 *    `<summary>` in the same details, and never a `<summary>` belonging to a
 *    different, open `<details>` nested inside the closed one's collapsed
 *    content (that summary's real parent is the open inner details, which
 *    fails `:not([open])`, so it cannot match). A closed outer `<details>`
 *    therefore still hides an open inner `<details>` and everything in it,
 *    summary included — exactly what the browser does.
 */
function isHiddenByClosedDetails(element: TrapCandidate): boolean {
  if (element.closest(CLOSED_DETAILS) === null) return false;
  return element.closest(CLOSED_DETAILS_ELIGIBLE_SUMMARY) === null;
}

/**
 * Whether the element is painted, as opposed to merely laid out.
 *
 * `visibility: hidden` (and `collapse`) leaves the box in the layout tree, so
 * `getClientRects()` still reports a rect and the element still matched the
 * selector — but `.focus()` on it does nothing. Computed style is read rather
 * than inferred: it already accounts for inheritance (a hidden container hides
 * its children, and a `visibility: visible` child of one is visible again), and
 * it does not misjudge the things a heuristic would. `offsetParent === null`,
 * the usual shortcut, is true of every `position: fixed` control — which is
 * what a sheet's pinned footer is.
 */
function isVisible(element: TrapCandidate): boolean {
  const view = element.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return true;
  const { visibility } = view.getComputedStyle(element);
  return visibility !== "hidden" && visibility !== "collapse";
}

/**
 * Whether `element` is a tab stop the trap should cycle through.
 *
 * The governing rule is one question: will `.focus()` on this element actually
 * move focus? Tab is unconditionally prevented while the sheet is open, so a
 * candidate the browser refuses to focus is not a harmless extra entry — focus
 * stays where it was and the merchant is stuck on the previous control, unable
 * to reach the next one. That is the bug this filter exists to prevent, and it
 * is why the checks below track the platform's own rules rather than a
 * shorthand for them.
 *
 * Rejects, in order: controls the browser itself reports as `:disabled` (their
 * own attribute, or any ancestor `<fieldset disabled>` — however deeply nested
 * — that reaches them), anything opted out with a negative tabindex, hidden
 * inputs, subtrees hidden from assistive tech or made inert, anything inside a
 * closed `<details>` other than its own eligible `<summary>` (see
 * `isHiddenByClosedDetails` — asked explicitly, before geometry, because a
 * collapsed details' content can still report a client rect), anything the
 * browser is not laying out (`display: none`), and anything laid out but not
 * painted (`visibility: hidden`). An element scrolled out of view inside the
 * sheet's own scroll pane is still rendered and still focusable, so it stays
 * in the cycle — which is what we want: the merchant tabs to it and the pane
 * scrolls.
 */
export function isTrapFocusable(element: TrapCandidate): boolean {
  if (isDisabledControl(element)) return false;

  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null) {
    const parsed = Number.parseInt(tabindex, 10);
    if (Number.isNaN(parsed) || parsed < 0) return false;
  }

  if (element.tagName === "INPUT" && element.getAttribute("type") === "hidden") return false;

  if (element.closest('[aria-hidden="true"], [inert]') !== null) return false;

  if (isHiddenByClosedDetails(element)) return false;

  if (element.getClientRects().length === 0) return false;

  return isVisible(element);
}

/**
 * The sheet's tab stops, in document order.
 *
 * `querySelectorAll` is depth-first, so nested content (a fieldset inside a
 * card inside the scroll pane) is already in the right order — the trap does
 * not need to know how deeply a consumer nests its form.
 */
export function collectTrapFocusables(root: {
  querySelectorAll(selectors: string): ArrayLike<HTMLElement>;
}): HTMLElement[] {
  return Array.from(root.querySelectorAll(TRAP_FOCUSABLE_SELECTOR)).filter(isTrapFocusable);
}

/**
 * Where Tab (or Shift+Tab) must move focus next, given the sheet's tab stops.
 *
 * This is the fix for the escape hatch. The previous rule only intervened when
 * `activeElement` was *exactly* the first or last stop and let the browser
 * handle every other case — so with focus on the dialog container itself (where
 * it sits right after open) neither branch matched, Shift+Tab fell through to
 * the scrim button, and a second Shift+Tab fell out of the overlay entirely
 * onto whatever was behind it. Anything not in the list, including the
 * container and the scrim, is treated as "not yet inside": Tab enters at the
 * first stop, Shift+Tab enters at the last. Everything else wraps.
 *
 * Returns `null` only when there is nothing to focus; the caller still has to
 * swallow the keystroke in that case so an empty sheet cannot be tabbed out of.
 */
export function nextTrapFocus<T>(
  focusables: readonly T[],
  active: T | null | undefined,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;

  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;

  const index = active == null ? -1 : focusables.indexOf(active);
  if (index === -1) return shiftKey ? last : first;

  if (shiftKey) return index === 0 ? last : focusables[index - 1]!;
  return index === focusables.length - 1 ? first : focusables[index + 1]!;
}
