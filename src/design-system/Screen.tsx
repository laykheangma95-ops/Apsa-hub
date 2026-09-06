import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Clearance = "nav" | "none";

interface ScreenProps {
  children: ReactNode;
  /**
   * "nav" when this screen renders the floating nav, so the last row clears
   * it. Clearance comes from the --nav-clearance token, never hand-tuned per
   * page — a screen that reserved room for a nav it did not render left a dead
   * band under its own primary action. A StickyActionBar needs nothing here:
   * being sticky, it occupies its own space at the end of the scroll.
   */
  bottom?: Clearance;
  /** "wide" opens the column up on tablet/desktop. Phone measure is unchanged. */
  width?: "default" | "wide" | "full";
  /** Page background. "raised" is for list screens whose rows are white cards. */
  surface?: "page" | "raised";
  className?: string;
  contentClassName?: string;
}

const CLEARANCE_CLASS: Record<Clearance, string> = {
  nav: "pad-nav",
  none: "pb-[var(--space-screen-bottom)]",
};

const WIDTH_CLASS: Record<NonNullable<ScreenProps["width"]>, string> = {
  default: "max-w-[var(--screen-max)]",
  wide: "max-w-[var(--screen-max)] lg:max-w-[var(--screen-max-wide)]",
  full: "max-w-none",
};

/**
 * The frame every signed-in screen sits in.
 *
 * It owns three things so no route has to: the page surface, the reading
 * measure (a phone-width column that only widens on large screens), and the
 * bottom clearance for whatever floats over the content. Screens keep their
 * own header and sticky bars — those are siblings of this container, not
 * children, so they can stay pinned while the body scrolls.
 */
export function Screen({
  children,
  bottom = "nav",
  width = "default",
  surface = "page",
  className,
  contentClassName,
}: ScreenProps) {
  return (
    <div
      className={cn(
        "min-h-dvh",
        surface === "page" ? "bg-surface-page" : "bg-surface-secondary",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto w-full screen-gutter",
          WIDTH_CLASS[width],
          CLEARANCE_CLASS[bottom],
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Edge-to-edge variant for screens whose content is a full-bleed list (Inbox,
 * POS catalogue). Same clearance contract, no horizontal gutter.
 */
export function ScreenBleed({
  children,
  bottom = "nav",
  width = "default",
  surface = "page",
  className,
  contentClassName,
}: ScreenProps) {
  return (
    <div
      className={cn(
        "min-h-dvh",
        surface === "page" ? "bg-surface-page" : "bg-surface-secondary",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto w-full",
          WIDTH_CLASS[width],
          CLEARANCE_CLASS[bottom],
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
