/**
 * What `role` and `ariaPressed`/`selected` resolve to on the rendered
 * button — the actual accessibility decision, factored out so it is testable
 * without rendering. See `ariaPressed` on `ChipProps` (Chip.tsx) for the
 * three cases.
 */
export function resolveChipAriaProps(
  role: "tab" | undefined,
  ariaPressed: boolean | null | undefined,
  selected: boolean,
): Record<string, boolean> {
  const pressedState = ariaPressed === undefined ? selected : ariaPressed;
  if (pressedState === null) return {};
  return role === "tab" ? { "aria-selected": pressedState } : { "aria-pressed": pressedState };
}
