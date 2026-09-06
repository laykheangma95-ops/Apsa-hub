import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface InlineActionProps {
  children: ReactNode;
  onClick?: () => void;
  /** Renders numbers with tabular figures — order codes, tracking numbers. */
  numeric?: boolean;
  className?: string;
}

/**
 * A link-weight action that appears inside a row or a section header — "view
 * order", "view delivery", the order code on a delivery.
 *
 * It reads as small text but is not a small target: negative margins let the
 * 44px hit area extend past the visible label without pushing the row taller.
 * Measured at 320px these were 77×19 before, which is a miss on a real thumb.
 */
export function InlineAction({ children, onClick, numeric, className }: InlineActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press text-label -my-2.5 -mr-2 inline-flex min-h-11 items-center justify-end rounded-full px-2 text-action-primary",
        numeric && "tnum",
        className,
      )}
    >
      <span className="chip-text">{children}</span>
    </button>
  );
}
