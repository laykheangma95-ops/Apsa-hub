import { ArrowUpRight, Lock, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One APSA Blue body; the tone only changes the colour of the tile's light. */
export type GlassTileTone = "sky" | "teal" | "violet" | "ice";

interface GlassActionTileProps {
  icon: LucideIcon;
  title: string;
  /** Shown only when the tile is large enough for it (see .glass-tile-description). */
  description?: string | undefined;
  tone: GlassTileTone;
  /**
   * What the tile does. Absent means the action is not available to this
   * member: the tile keeps its place but renders as a plain, non-interactive
   * tile carrying `unavailableLabel` — never a button that leads to a refusal.
   */
  onPress?: (() => void) | undefined;
  /** Required wording for the unavailable state, e.g. "Not available for your role". */
  unavailableLabel: string;
  className?: string;
}

/**
 * A large, square, liquid-glass starting point (Home's Quick Actions).
 *
 * The whole tile is one native button, so Enter and Space both activate it and
 * its accessible name is simply its visible text. Styling lives in styles.css
 * (.glass-tile) because it is built from the --tile-* tokens and container
 * queries rather than utility classes.
 */
export function GlassActionTile({
  icon: Icon,
  title,
  description,
  tone,
  onPress,
  unavailableLabel,
  className,
}: GlassActionTileProps) {
  const available = onPress !== undefined;

  const body = (
    <>
      <span className="glass-tile-top">
        <span className="glass-tile-icon" aria-hidden>
          <Icon strokeWidth={2} />
        </span>
        <span className="glass-tile-arrow" aria-hidden>
          {available ? <ArrowUpRight className="size-4" /> : <Lock className="size-4" />}
        </span>
      </span>
      <span className="block min-w-0">
        <span className="glass-tile-title">{title}</span>
        {available ? (
          description ? (
            <span className="glass-tile-description">{description}</span>
          ) : null
        ) : (
          <span className="glass-tile-description">{unavailableLabel}</span>
        )}
      </span>
    </>
  );

  if (!available) {
    return (
      <div
        data-tile=""
        data-tone={tone}
        data-unavailable=""
        className={cn("glass-tile", className)}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-tile=""
      data-tone={tone}
      onClick={onPress}
      className={cn("glass-tile", className)}
    >
      {body}
    </button>
  );
}
