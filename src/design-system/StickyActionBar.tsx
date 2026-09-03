import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StickyActionBarProps {
  children: ReactNode;
  /** Extra bottom room when the floating nav sits underneath. */
  aboveNav?: boolean;
  className?: string;
}

/**
 * The single deliberate action surface at the bottom of a screen: safe-area
 * padding, one hairline, soft depth. Only one dominant action lives here.
 */
export function StickyActionBar({ children, aboveNav = false, className }: StickyActionBarProps) {
  return (
    <div
      className={cn(
        "elevation-3 surface-glass sticky bottom-0 z-30 border-t border-border-default px-4 pt-3",
        aboveNav
          ? "pb-[calc(env(safe-area-inset-bottom)+4.75rem)]"
          : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)]",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[560px] flex-col gap-2">{children}</div>
    </div>
  );
}
