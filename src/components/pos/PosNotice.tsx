import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PosNoticeProps {
  title: string;
  body?: string;
  action?: ReactNode;
  tone?: "neutral" | "warning";
  className?: string;
}

/**
 * Plain state block for active POS surfaces.
 * Apsi never appears while a merchant is ringing up a sale.
 */
export function PosNotice({ title, body, action, tone = "neutral", className }: PosNoticeProps) {
  return (
    <div
      className={cn("flex flex-col items-center px-6 py-10 text-center", className)}
      role={tone === "warning" ? "alert" : undefined}
    >
      <h3
        className={cn(
          "text-h3",
          tone === "warning" ? "text-status-warning-text" : "text-text-primary",
        )}
      >
        {title}
      </h3>
      {body ? <p className="text-body mt-1 max-w-xs text-text-secondary">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
