import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { cn } from "@/lib/utils";

export interface Segment<T extends string> {
  value: T;
  label: string;
  /** Shown after the label. Omit rather than render a zero. */
  count?: number | undefined;
}

interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Required: names the group for screen readers. */
  label: string;
  /** "tabs" when the segments switch panels, "filter" when they narrow a list. */
  as?: "tabs" | "filter";
  size?: "md" | "sm";
  className?: string;
}

/**
 * Two to four peer choices, side by side, with a thumb that slides between
 * them. Above four, use a scrolling ChipRow instead — a segment squeezed to
 * 60px clips Khmer, which has no letter case and no hyphenation to fall back on.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  as = "filter",
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const layoutId = useId();
  const reduceMotion = useReducedMotion();
  const isTabs = as === "tabs";

  return (
    <div
      role={isTabs ? "tablist" : "group"}
      aria-label={label}
      className={cn(
        "flex w-full items-stretch gap-1 rounded-full border border-border-default bg-surface-secondary p-1",
        className,
      )}
    >
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            {...(isTabs
              ? { role: "tab" as const, "aria-selected": selected }
              : { "aria-pressed": selected })}
            onClick={() => onChange(segment.value)}
            className={cn(
              "press relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-center transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              // The segment itself is the target, not the padded track around it.
              size === "md" ? "min-h-[44px]" : "min-h-[36px]",
              selected ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {selected ? (
              <motion.span
                aria-hidden
                layoutId={layoutId}
                className="elevation-1 absolute inset-0 rounded-full bg-surface-primary"
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 480, damping: 38, mass: 0.7 }
                }
              />
            ) : null}
            <span
              className={cn(
                "chip-text text-label relative min-w-0",
                selected ? "font-semibold" : undefined,
              )}
            >
              {segment.label}
            </span>
            {segment.count ? (
              <span
                className={cn(
                  "text-caption tnum relative shrink-0 rounded-full px-1.5 py-px",
                  selected
                    ? "bg-action-primary-soft text-status-info-text"
                    : "bg-surface-primary text-text-muted",
                )}
              >
                {segment.count > 99 ? "99+" : segment.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
