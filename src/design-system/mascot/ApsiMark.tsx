import { cn } from "@/lib/utils";

export type ApsiMarkExpression = "idle" | "listening" | "thinking";

interface ApsiMarkProps {
  size?: number;
  expression?: ApsiMarkExpression;
  className?: string;
}

/**
 * Apsi reduced to a mark: two eyes and a smile, drawn in currentColor.
 *
 * The full Apsi artwork is a ~180KB character illustration meant for
 * onboarding, empty states and moments. At 52px inside a navigation bar it
 * would be a smudge that costs a network request on every cold start, so the
 * bar carries this instead — the same face, authored as geometry, weightless,
 * and crisp at any density.
 *
 * Deliberately not a mascot: no body, no companion, no motion of its own. It
 * is a control's icon, and it behaves like one.
 */
export function ApsiMark({ size = 26, expression = "idle", className }: ApsiMarkProps) {
  const blinking = expression === "thinking";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      focusable="false"
      className={cn("shrink-0", className)}
    >
      {/* Eyes. Rounded rects rather than circles: Apsi's eyes are soft
          verticals in the brand artwork, and circles read as a robot. */}
      <rect
        x="8.5"
        y={blinking ? "13.6" : "10.5"}
        width="4"
        height={blinking ? "2.8" : "9"}
        rx="2"
        fill="currentColor"
      />
      <rect
        x="19.5"
        y={blinking ? "13.6" : "10.5"}
        width="4"
        height={blinking ? "2.8" : "9"}
        rx="2"
        fill="currentColor"
      />
      {/* Smile. One open arc — a closed curve turns the face into an emoji. */}
      <path
        d="M11 22.5c1.4 1.6 3.1 2.4 5 2.4s3.6-.8 5-2.4"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      {expression === "listening" ? (
        <circle cx="16" cy="6.4" r="1.6" fill="currentColor" opacity="0.7" />
      ) : null}
    </svg>
  );
}
