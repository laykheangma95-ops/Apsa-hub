import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What `role` and `ariaPressed`/`selected` resolve to on the rendered
 * button — the actual accessibility decision, factored out so it is testable
 * without rendering. See `ariaPressed` on `ChipProps` for the three cases.
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

interface ChipProps {
  children: ReactNode;
  selected?: boolean;
  /**
   * Overrides the aria-pressed/aria-selected state `selected` would otherwise
   * set.
   *
   * - omitted (`undefined`): falls back to `selected` — the normal toggle
   *   chip (filters, variants, categories), whose visual "selected" state IS
   *   its pressed/selected semantics.
   * - `null`: omits aria-pressed/aria-selected entirely. Use when `selected`
   *   styles pure visual emphasis (e.g. "this is the primary suggestion")
   *   rather than an actual toggled state — a command chip that fires an
   *   action and never stays "pressed" must not carry aria-pressed at all,
   *   and `ariaPressed={false}` still asserts one.
   * - `boolean`: an explicit forced value, for the rare case neither of the
   *   above fits.
   */
  ariaPressed?: boolean | null;
  disabled?: boolean;
  onClick?: () => void;
  count?: number | undefined;
  icon?: ReactNode;
  role?: "tab" | undefined;
  ariaLabel?: string | undefined;
  className?: string;
}

/**
 * One chip primitive for inbox filters, POS categories, variants and payment
 * methods. Khmer never truncates — chips wrap instead of clipping.
 */
export function Chip({
  children,
  selected = false,
  ariaPressed,
  disabled = false,
  onClick,
  count,
  icon,
  role,
  ariaLabel,
  className,
}: ChipProps) {
  const selectionProps = resolveChipAriaProps(role, ariaPressed, selected);

  return (
    <button
      type="button"
      role={role}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      {...selectionProps}
      className={cn(
        "tap-target text-label inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        selected
          ? "border-action-primary-border bg-action-primary-soft text-status-info-text"
          : "border-border-default bg-surface-primary text-text-secondary hover:bg-surface-secondary",
        disabled ? "opacity-50" : undefined,
        className,
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="chip-text">{children}</span>
      {count !== undefined ? (
        <span
          className={cn(
            "text-caption tnum rounded-full px-1.5",
            selected
              ? "bg-action-primary text-text-on-action"
              : "bg-surface-secondary text-text-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** Horizontal, edge-to-edge scroller for chip rows on 320px screens. */
export function ChipRow({
  children,
  label,
  role,
  className,
}: {
  children: ReactNode;
  label?: string | undefined;
  role?: "tablist" | undefined;
  className?: string;
}) {
  return (
    <div
      role={role}
      aria-label={label}
      className={cn("scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4", className)}
    >
      {children}
    </div>
  );
}
