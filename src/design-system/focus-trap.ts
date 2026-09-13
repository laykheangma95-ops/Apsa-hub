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
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
  getClientRects(): { readonly length: number };
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
 * Whether `element` is a tab stop the trap should cycle through.
 *
 * Rejects, in order: disabled controls, anything opted out with a negative
 * tabindex, hidden inputs, subtrees hidden from assistive tech or made inert,
 * and anything the browser is not currently rendering (`display: none`,
 * `visibility: hidden`, a collapsed `<details>`). An element scrolled out of
 * view inside the sheet's own scroll pane is still rendered, so it stays in the
 * cycle — which is what we want: the merchant tabs to it and the pane scrolls.
 */
export function isTrapFocusable(element: TrapCandidate): boolean {
  if (element.hasAttribute("disabled")) return false;

  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null) {
    const parsed = Number.parseInt(tabindex, 10);
    if (Number.isNaN(parsed) || parsed < 0) return false;
  }

  if (element.tagName === "INPUT" && element.getAttribute("type") === "hidden") return false;

  if (element.closest('[aria-hidden="true"], [inert]') !== null) return false;

  return element.getClientRects().length > 0;
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
