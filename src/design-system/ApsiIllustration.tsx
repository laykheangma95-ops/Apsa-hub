import { Apsi } from "./mascot/Apsi";
import type { ApsiEmotion } from "./mascot/apsi-emotions";

export type ApsiPose = "default" | "waving" | "winking" | "typing" | "merging";

interface ApsiIllustrationProps {
  pose?: ApsiPose;
  size?: number;
  className?: string;
  alt?: string;
}

const POSE_TO_EMOTION: Record<ApsiPose, ApsiEmotion> = {
  default: "default",
  waving: "waving",
  winking: "winking",
  typing: "typing",
  merging: "merge",
};

/**
 * Legacy pose-based entry point, kept so existing screens keep working.
 * New code should use <Apsi emotion="..." /> from `@/design-system/mascot`.
 */
export function ApsiIllustration({
  pose = "default",
  size = 96,
  className,
  alt = "",
}: ApsiIllustrationProps) {
  return <Apsi emotion={POSE_TO_EMOTION[pose]} size={size} alt={alt} className={className} />;
}
