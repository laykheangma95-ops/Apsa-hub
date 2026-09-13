import { cn } from "@/lib/utils";

/**
 * Badge tone is a claim, not decoration.
 *
 * Red means somebody has to do something. Green means a thing finished and is
 * safe. Everything else is neutral — a count that is merely informational does
 * not get to borrow the colour of work. There is deliberately no warning tone:
 * on a 17px surface amber and red are the same glance, and a badge that is
 * "sort of urgent" trains merchants to ignore the urgent ones.
 */
export type BadgeTone = "danger" | "success" | "neutral";

const COUNT_TONE_CLASS: Record<BadgeTone, string> = {
  danger: "bg-status-danger text-text-inverse",
  success: "bg-status-success text-text-inverse",
  neutral: "bg-surface-secondary text-text-secondary",
};

const DOT_TONE_CLASS: Record<BadgeTone, string> = {
  danger: "bg-status-danger",
  success: "bg-status-success",
  neutral: "bg-text-muted",
};

interface CountBadgeProps {
  count: number;
  tone?: BadgeTone;
  /** Above this the badge shows `max`+ rather than growing without limit. */
  max?: number;
  /** A ring in the colour of whatever the badge sits on, so it reads as separate. */
  ringClassName?: string;
  className?: string;
  /**
   * Screen-reader text. Omit when the parent control already announces the
   * count (the nav does), and the badge is then hidden from assistive tech
   * instead of read twice.
   */
  label?: string | undefined;
}

/**
 * The one count badge in APSA. Consistent height, radius, type and spacing
 * everywhere it appears — nav tabs, list rows, hub tiles — so a merchant reads
 * "seven waiting" the same way wherever they meet it.
 */
export function CountBadge({
  count,
  tone = "danger",
  max = 99,
  ringClassName,
  className,
  label,
}: CountBadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "text-caption tnum inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 leading-none",
        COUNT_TONE_CLASS[tone],
        ringClassName,
        className,
      )}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

interface DotBadgeProps {
  tone?: BadgeTone;
  ringClassName?: string;
  className?: string;
  label?: string | undefined;
}

/**
 * "Something is here" without a number.
 *
 * Used where a count would be a false precision — Home's attention dot says
 * work exists; the cards inside say how much and of what.
 */
export function DotBadge({ tone = "danger", ringClassName, className, label }: DotBadgeProps) {
  return (
    <span
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "inline-flex size-[9px] rounded-full",
        DOT_TONE_CLASS[tone],
        ringClassName,
        className,
      )}
    />
  );
}
