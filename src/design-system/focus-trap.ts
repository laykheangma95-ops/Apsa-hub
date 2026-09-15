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
  /**
   * The element's real parent. Used only to walk the `<details>` ancestor
   * chain — see `isHiddenByClosedDetails` / `isControllingSummary`. A single
   * `closest()` call cannot distinguish two different `<details>` ancestors
   * from each other, and that distinction is exactly what a closed `<details>`
   * nested inside another one needs: being the controlling summary of the
   * inner one says nothing about whether the outer one still hides it.
   *
   * Optional because most stubs never exercise `<details>` nesting; when
   * absent, the walk has nowhere to go and both functions behave exactly as
   * they did before this property existed.
   */
  readonly parentElement?: TrapCandidate | null;
}

/**
 * Everything the platform can put in the tab order. Deliberately wider than the
 * old `button, [href], input, select, textarea, [tabindex]` list, which missed
 * `summary`, media with controls, and contenteditable regions — each of them a
 * real tab stop a merchant could land on and then Tab straight out of.
 *
 * `[tabindex]` is matched unfiltered here and narrowed in `isTrapFocusable`,
 * because a negative tabindex must be excluded by *value*, not by selector.
 * `summary` is matched unfiltered for the same reason: whether a given
 * `<summary>` is the one HTML actually makes interactive depends on its real
 * parent and its position among siblings, which a selector cannot express
 * without knowing the live DOM shape the trap does not assume here — see
 * `isControllingSummary`.
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

/**
 * Whether `element` is the one `<summary>` that gives its immediate parent
 * `<details>` its disclosure behavior.
 *
 * HTML picks exactly one: the first `<summary>` element child. Any other
 * `<summary>` — a later sibling, or one that is not a `<details>`'s direct
 * child at all — gets none of that behavior. It is not natively interactive,
 * carries no implicit tab stop, and Chromium will not move focus to it no
 * matter what `getClientRects()`/`visibility` say, which is exactly the shape
 * of bug this whole module exists to catch — so `summary` is matched broadly
 * by the selector (see `TRAP_FOCUSABLE_SELECTOR`) and narrowed here, the same
 * way `[tabindex]` is narrowed by value rather than by selector.
 *
 * `:first-of-type` is evaluated by the real DOM against `element`'s actual
 * siblings under its actual parent, so this reads the platform's own answer
 * rather than re-deriving sibling order from anything the trap tracks itself.
 */
function isControllingSummary(element: TrapCandidate): boolean {
  if (element.tagName !== "SUMMARY") return false;
  const parent = element.parentElement;
  return !!parent && parent.tagName === "DETAILS" && element.matches(":first-of-type");
}

/**
 * Whether `element` sits inside collapsed `<details>` content it cannot
 * reach.
 *
 * A closed `<details>` hides everything below it except its own controlling
 * `<summary>` (see `isControllingSummary`) — but a candidate can sit under
 * several `<details>` ancestors nested inside one another, and being the
 * controlling summary of ONE of them says nothing about the others further
 * up. Asking only the nearest closed ancestor — the most a single
 * `closest("details:not([open])")` call can answer — missed exactly that: a
 * closed inner `<details>`'s own controlling summary is still hidden when
 * that whole inner `<details>` sits, as ordinary collapsed content, inside a
 * further closed OUTER `<details>`. The inner summary is the inner details'
 * disclosure widget, not the outer's, so the outer's collapsed body still
 * swallows it, open-inner-details or not.
 *
 * So every `<details>` ancestor is walked and judged independently. `child`
 * is the node the walk arrived from at each step; it must be that specific
 * `<details>`'s own controlling summary to be shielded from it. Anything
 * else — a plain descendant, or even another `<details>`'s controlling
 * summary — is hidden the moment one closed ancestor fails to shield it, and
 * the walk can stop there: a `display: none` part-way up already hides
 * everything below it regardless of what sits further above.
 *
 * Geometry and computed style are never consulted here: collapsed content can
 * still report a client rect and `visibility: visible` in Chromium even
 * though `.focus()` refuses to move there.
 */
function isHiddenByClosedDetails(element: TrapCandidate): boolean {
  let child: TrapCandidate = element;
  let parent = element.parentElement;
  while (parent) {
    const isClosedDetails = parent.tagName === "DETAILS" && parent.getAttribute("open") === null;
    if (isClosedDetails && !isControllingSummary(child)) return true;
    child = parent;
    parent = parent.parentElement;
  }
  return false;
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
 * inputs, subtrees hidden from assistive tech or made inert, a `<summary>`
 * that is not the one HTML actually makes interactive and carries no explicit
 * tabindex of its own (see `isControllingSummary`), anything inside a closed
 * `<details>` other than the controlling `<summary>` of every closed
 * `<details>` ancestor between it and the document (see
 * `isHiddenByClosedDetails` — asked explicitly, before geometry, because
 * collapsed content can still report a client rect), anything the browser is
 * not laying out (`display: none`), and anything laid out but not painted
 * (`visibility: hidden`). An element scrolled out of view inside the sheet's
 * own scroll pane is still rendered and still focusable, so it stays in the
 * cycle — which is what we want: the merchant tabs to it and the pane
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

  // `tabindex === null` here means no *valid* explicit tabindex either — a
  // negative one already returned false above, so anything left is either
  // absent or a genuine non-negative value the browser itself will honor.
  if (element.tagName === "SUMMARY" && tabindex === null && !isControllingSummary(element)) {
    return false;
  }

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

/**
 * Directional recovery for a candidate `nextTrapFocus` names that turns out
 * not to actually accept focus.
 *
 * `isTrapFocusable` is the primary defense — correct candidate filtering
 * should mean this never has to do anything. It exists for whatever that
 * filter cannot see: a candidate a browser quirk still fools it on, or one
 * whose own `.focus()` handler declines or redirects. Falling back straight
 * to a safe target (the panel) on a single failure is not enough by itself:
 * the very next Tab starts from that safe target and can compute the SAME
 * bad candidate as next, refocus the panel, and repeat forever — never
 * advancing to a later valid control. So on a failure this keeps walking in
 * the SAME direction, past the bad candidate, until something actually
 * accepts focus.
 *
 * Kept separate from `nextTrapFocus` on purpose: that function stays a pure
 * calculation with no notion of whether focus "worked", reusable anywhere
 * ordering alone is needed. `attemptFocus` is injected here — a side effect,
 * but an explicit parameter rather than a global `document` reference — so
 * this stays unit-testable without a DOM, the same discipline the rest of
 * this module follows.
 *
 * Bounded to at most `focusables.length` attempts: `nextTrapFocus` steps
 * through a fixed list as a single cycle in either direction, so that many
 * steps starting anywhere visits every candidate exactly once. That is
 * enough to either land somewhere or prove nothing in the list will ever
 * accept focus — never more, so a list where every candidate fails cannot
 * loop forever.
 *
 * Returns `null` when no candidate accepted focus (including an empty list);
 * the caller's own safe fallback (the panel) is what handles that case, the
 * same way it already does when `nextTrapFocus` itself returns `null`.
 */
export function resolveTrapFocus<T>(
  focusables: readonly T[],
  active: T | null | undefined,
  shiftKey: boolean,
  attemptFocus: (candidate: T) => boolean,
): T | null {
  let candidate = nextTrapFocus(focusables, active, shiftKey);
  for (let attempts = 0; candidate !== null && attempts < focusables.length; attempts++) {
    if (attemptFocus(candidate)) return candidate;
    candidate = nextTrapFocus(focusables, candidate, shiftKey);
  }
  return null;
}
