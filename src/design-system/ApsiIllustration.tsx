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
 * Loads /apsi/{pose}.png. On failure renders a soft blue blob at the exact
 * requested dimensions so dropping real art in later causes zero layout shift.
 */
export function ApsiIllustration({
  pose = "default",
  size = 96,
  className,
  alt = "",
}: ApsiIllustrationProps) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };

  if (failed) {
    return (
      <div
        aria-hidden={alt === "" ? true : undefined}
        role={alt === "" ? undefined : "img"}
        aria-label={alt || undefined}
        className={cn("shrink-0 rounded-[38%]", className)}
        style={{ ...style, backgroundColor: "var(--companion-nilo)", opacity: 0.6 }}
      />
    );
  }

  return (
    <img
      src={`/apsi/${pose}.png`}
      alt={alt}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={cn("shrink-0 rounded-[38%] object-contain", className)}
      style={style}
    />
  );
}
