import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TimelineItem {
  id: string;
  title: string;
  meta?: string | undefined;
  detail?: string | undefined;
  icon?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}

const DOT_TONE: Record<NonNullable<TimelineItem["tone"]>, string> = {
  default: "bg-border-strong",
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
};

/** Business-language history. Never machine event names. */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn("relative space-y-4 pl-5", className)}>
      <span
        aria-hidden
        className="absolute top-1.5 bottom-1.5 left-[5px] w-px bg-border-default"
      />
      {items.map((item) => (
        <li key={item.id} className="relative">
          <span
            aria-hidden
            className={cn(
              "absolute top-1.5 -left-5 size-2.5 rounded-full ring-2 ring-surface-primary",
              DOT_TONE[item.tone ?? "default"],
            )}
          />
          <p className="text-body-sm text-text-primary">{item.title}</p>
          {item.detail ? (
            <p className="text-body-sm text-text-secondary">{item.detail}</p>
          ) : null}
          {item.meta ? <p className="text-caption text-text-muted">{item.meta}</p> : null}
        </li>
      ))}
    </ol>
  );
}
