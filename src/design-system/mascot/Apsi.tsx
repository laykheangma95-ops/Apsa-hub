import { Mascot, type MascotProps } from "./Mascot";
import type { ApsiEmotion } from "./apsi-emotions";

export interface ApsiProps extends Omit<MascotProps, "state" | "emotion"> {
  emotion?: ApsiEmotion;
}

/** Public emotion-first Apsi API. */
export function Apsi({ emotion = "default", ...props }: ApsiProps) {
  return <Mascot emotion={emotion} {...props} />;
}