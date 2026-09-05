import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  companionSource,
  resolveMascotSource,
  COMPANION_TOKEN,
  type MascotSource,
} from "./mascot-assets";
import { MASCOT_STATES, type MascotState } from "./mascot-states";

export interface MascotProps {
  /** A named moment, never a raw pose. */
  state?: MascotState;
  size?: number;
  /** Show the accent companion assigned to this state. */
  withCompanion?: boolean;
  /** Accessible label. Empty string (default) marks the mascot decorative. */
  alt?: string;
  className?: string;
}

function Frame({ source, size, alt }: { source: MascotSource; size: number; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (source.kind !== "image") {
    // Future Rive/Lottie/video renderers plug in here; the API above stays put.
    return null;
  }

  return (
    <div
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt === "" ? true : undefined}
      className="relative shrink-0 overflow-hidden rounded-[38%]"
      style={{
        width: size,
        height: size,
        backgroundColor: loaded && !failed ? "transparent" : "var(--action-primary-soft)",
      }}
    >
      {failed ? null : (
        <img
          src={source.url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="size-full object-contain transition-opacity duration-200"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
  );
}

/**
 * The single way Apsi appears in APSA. Screens name a state; the registry
 * decides pose, companion and (later) animation format.
 */
export function Mascot({
  state = "default",
  size = 96,
  withCompanion = false,
  alt = "",
  className,
}: MascotProps) {
  const spec = MASCOT_STATES[state];
  const source = resolveMascotSource(spec.asset, spec.pose);
  const companion = withCompanion ? spec.companion : undefined;

  return (
    <div className={cn("relative inline-flex shrink-0", className)} style={{ width: size }}>
      <Frame source={source} size={size} alt={alt} />
      {companion ? (
        <span
          className="absolute -right-1 -bottom-1 overflow-hidden rounded-full"
          style={{
            width: Math.round(size * 0.42),
            height: Math.round(size * 0.42),
            boxShadow: `0 0 0 2px var(--surface-primary), 0 6px 16px -8px ${COMPANION_TOKEN[companion]}`,
          }}
          aria-hidden
        >
          <img
            src={companionSource(companion).url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-contain"
          />
        </span>
      ) : null}
    </div>
  );
}
