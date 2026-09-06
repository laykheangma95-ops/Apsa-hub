import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Apsi, type ApsiEmotion } from "./mascot";
import type { ApsiPose } from "./ApsiIllustration";

interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
  emotion?: ApsiEmotion;
  /** Legacy compatibility. Prefer `emotion` in new work. */
  pose?: ApsiPose;
  className?: string;
}

const POSE_EMOTION: Record<ApsiPose, ApsiEmotion> = {
  default: "default",
  waving: "waving",
  winking: "winking",
  typing: "typing",
  merging: "merge",
};

export function EmptyState({ title, body, action, emotion, pose, className }: EmptyStateProps) {
  const resolvedEmotion = emotion ?? (pose ? POSE_EMOTION[pose] : "sleepy");

  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      <Apsi emotion={resolvedEmotion} size="md" />
      <h3 className="text-h3 mt-4 text-text-primary">{title}</h3>
      <p className="text-body mt-1 max-w-xs text-text-secondary">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
