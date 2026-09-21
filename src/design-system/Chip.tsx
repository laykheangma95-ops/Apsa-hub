import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ChipProps {
  children: ReactNode;
  selected?: boolean;
  /**
   * Overrides the aria-pressed/aria-selected state `selected` would otherwise
   * set. Use when `selected` styles pure visual emphasis (e.g. "this is the
   * primary suggestion") rather than an actual toggled/pressed state — tapping
   * the chip fires an action and nothing about it stays "pressed".
   */
  ariaPressed?: boolean;
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
  const pressedState = ariaPressed ?? selected;
  const selectionProps =
    role === "tab" ? { "aria-selected": pressedState } : { "aria-pressed": pressedState };

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
