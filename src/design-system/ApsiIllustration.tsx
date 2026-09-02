import { useState } from "react";
import { cn } from "@/lib/utils";

export type ApsiPose = "default" | "waving" | "winking" | "typing" | "merging";

interface ApsiIllustrationProps {
  pose?: ApsiPose;
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * Loads /apsi/{pose}.png. Until (or unless) the art loads, a soft blue blob
 * holds the exact requested dimensions, so dropping real art in later causes
 * zero layout shift and no broken-image flash.
 */
export function ApsiIllustration({
  pose = "default",
  size = 96,
  className,
  alt = "",
}: ApsiIllustrationProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt === "" ? true : undefined}
      className={cn("relative shrink-0 overflow-hidden rounded-[38%]", className)}
      style={{
        width: size,
        height: size,
        backgroundColor: loaded ? "transparent" : "var(--companion-nilo)",
        opacity: loaded ? 1 : 0.6,
      }}
    >
      {failed ? null : (
        <img
          src={`/apsi/${pose}.png`}
          alt=""
          width={size}
          height={size}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="size-full object-contain"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
  );
}
