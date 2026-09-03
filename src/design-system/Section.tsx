import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  /** Quiet label above the surface. Typography carries the hierarchy, not a border. */
  title?: string | undefined;
  action?: ReactNode;
  /** "card" wraps content in one surface; "plain" keeps it borderless. */
  variant?: "card" | "plain";
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * One section rhythm for every operational screen: a quiet label, then a single
 * surface. Nested cards are replaced by divider-separated rows inside one card.
 */
export function Section({
  title,
  action,
  variant = "card",
  children,
  className,
  bodyClassName,
}: SectionProps) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title || action ? (
        <div className="flex min-w-0 items-center justify-between gap-3 px-1">
          {title ? (
            <h2 className="text-label min-w-0 text-text-secondary">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      <div
        className={cn(
          variant === "card"
            ? "elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card"
            : undefined,
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Divider-separated rows inside a single Section card — never a nested card. */
export function SectionRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("divide-y divide-border-default", className)}>{children}</div>
  );
}

export function SectionRow({
  label,
  value,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0",
        className,
      )}
    >
      <span className="text-body-sm min-w-0 text-text-secondary">{label}</span>
      <span className="text-body min-w-0 text-right text-text-primary">{value}</span>
    </div>
  );
}
