import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ApsiIllustration, type ApsiPose } from "./ApsiIllustration";

interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
  pose?: ApsiPose;
  className?: string;
}

export function EmptyState({ title, body, action, pose = "waving", className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      <ApsiIllustration pose={pose} size={96} />
      <h3 className="text-h3 mt-4 text-text-primary">{title}</h3>
      <p className="text-body mt-1 max-w-xs text-text-secondary">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
