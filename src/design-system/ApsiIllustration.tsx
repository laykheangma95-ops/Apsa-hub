import { Mascot } from "./mascot/Mascot";
import type { MascotState } from "./mascot/mascot-states";

export type ApsiPose = "default" | "waving" | "winking" | "typing" | "merging";

interface ApsiIllustrationProps {
  pose?: ApsiPose;
  size?: number;
  className?: string;
  alt?: string;
}

const POSE_TO_STATE: Record<ApsiPose, MascotState> = {
  default: "default",
  waving: "greeting",
  winking: "success",
  typing: "typing",
  merging: "celebration",
};

/**
 * Legacy pose-based entry point, kept so existing screens keep working.
 * New code should use <Mascot state="..." /> from `@/design-system/mascot`.
 */
export function ApsiIllustration({
  pose = "default",
  size = 96,
  className,
  alt = "",
}: ApsiIllustrationProps) {
  return <Mascot state={POSE_TO_STATE[pose]} size={size} alt={alt} className={className} />;
}
