import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StickyActionBarProps {
  /** The single dominant action. Full width, in the thumb zone. */
  children: ReactNode;
  /**
   * Everything the merchant might do instead. Rendered as one quiet row under
   * the primary action — never as a stack of equally loud full-width buttons.
   */
  secondary?: ReactNode;
  /** Short context above the action: a total, a warning, a blocked reason. */
  lead?: ReactNode;
  /**
   * Only set when this screen also renders the floating nav. A screen that
   * reserves nav room it does not use leaves a dead band under its own button.
   */
  aboveNav?: boolean;
  className?: string;
}

/**
 * The one deliberate action surface at the bottom of a screen.
 *
 * Sticky, not fixed. Sticky stays pinned to the bottom of the viewport while
 * there is content below it, then settles into its own slot at the end of the
 * scroll — so the last row of an order is never hidden behind the bar, and no
 * screen has to guess the bar's height to reserve room for it. A fixed bar
 * needs that reservation, and it was measurably wrong the moment a secondary
 * action wrapped the bar onto a second row.
 *
 * One primary action, optional quiet row beneath — hierarchy is the point, so
 * this component refuses to stack peers.
 */
export function StickyActionBar({
  children,
  secondary,
  lead,
  aboveNav = false,
  className,
}: StickyActionBarProps) {
  return (
    <div
      className={cn(
        "glass-bar sticky bottom-0 z-40 border-t border-[var(--glass-border)] px-4 pt-3",
        aboveNav
          ? "pb-[calc(var(--nav-clearance)+0.75rem)]"
          : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)]",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[var(--screen-max)] flex-col gap-2">
        {lead ? <div className="px-0.5">{lead}</div> : null}
        {children}
        {secondary ? (
          <div className="flex items-center justify-center gap-1">{secondary}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A quiet action inside `secondary`. Reads as a link, still hits 44px.
 * Destructive intent is carried by the word, never by colour alone.
 */
export function SecondaryAction({
  children,
  onClick,
  tone = "neutral",
  disabled = false,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "neutral" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "press tap-target text-label inline-flex items-center justify-center rounded-full px-4 disabled:opacity-40",
        tone === "danger" ? "text-status-danger-text" : "text-text-secondary",
        className,
      )}
    >
      <span className="chip-text">{children}</span>
    </button>
  );
}
