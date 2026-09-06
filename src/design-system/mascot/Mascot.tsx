import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { companionSource, COMPANION_TOKEN, type MascotSource } from "./mascot-assets";
import { apsiEmotions, type ApsiAnimation, type ApsiEmotion } from "./apsi-emotions";
import { resolveMascotEmotion, type MascotState } from "./mascot-states";

export type ApsiSize = "xs" | "sm" | "md" | "lg" | "xl" | number;

export interface MascotProps {
  /** Legacy named-moment API. Prefer `emotion` for new work. */
  state?: MascotState;
  /** Semantic emotion; screens never choose a raw file or pose. */
  emotion?: ApsiEmotion;
  size?: ApsiSize;
  /** Overrides the emotion's default subtle motion. */
  animation?: ApsiAnimation;
  /** Show the accent companion assigned to this state. */
  withCompanion?: boolean;
  /** Accessible label. Empty string (default) marks the mascot decorative. */
  alt?: string;
  className?: string | undefined;
}

const SIZE_CLASS: Record<Exclude<ApsiSize, number>, string> = {
  xs: "size-10 sm:size-11",
  sm: "size-14 sm:size-16",
  md: "size-20 sm:size-24",
  lg: "size-28 sm:size-32 lg:size-36",
  xl: "size-36 sm:size-44 lg:size-52",
};

const MOTION_CLASS: Record<ApsiAnimation, string> = {
  none: "",
  float: "apsi-motion-float",
  "gentle-bounce": "apsi-motion-bounce",
  wave: "apsi-motion-wave",
  blink: "apsi-motion-blink",
  pulse: "apsi-motion-pulse",
  celebrate: "apsi-motion-celebrate",
  thinking: "apsi-motion-thinking",
};

function Frame({ source, size, alt }: { source: MascotSource; size: ApsiSize; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // The image can already be complete before React attaches onLoad (SSR markup).
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);

  const numericSize = typeof size === "number" ? size : undefined;
  const sizeClass = typeof size === "number" ? "" : SIZE_CLASS[size];
  const fallbackUrl = source.posterUrl ?? source.url;

  return (
    <div
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt === "" ? true : undefined}
      className={`relative aspect-square shrink-0 overflow-hidden rounded-[38%] ${sizeClass}`}
      style={{
        width: numericSize,
        height: numericSize,
        backgroundColor: loaded && !failed ? "transparent" : "var(--action-primary-soft)",
      }}
    >
      {failed ? null : (
        <img
          ref={imgRef}
          src={fallbackUrl}
          alt=""
          width={numericSize}
          height={numericSize}
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
  emotion,
  size = "md",
  animation,
  withCompanion = false,
  alt = "",
  className,
}: MascotProps) {
  const resolvedEmotion = emotion ?? resolveMascotEmotion(state);
  const spec = apsiEmotions[resolvedEmotion];
  const source = spec.source;
  const companion = withCompanion ? spec.companion : undefined;
  const motion = animation ?? spec.animation;
  const numericSize = typeof size === "number" ? size : undefined;

  return (
    <div
      className={cn("relative inline-flex shrink-0", MOTION_CLASS[motion], className)}
      style={{ width: numericSize }}
      data-apsi-emotion={resolvedEmotion}
      data-apsi-media={source.kind}
    >
      <Frame source={source} size={size} alt={alt} />
      {companion ? (
        <span
          className="absolute -right-[4%] -bottom-[4%] size-[42%] overflow-hidden rounded-full"
          style={{
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
