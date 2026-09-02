import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface OperationalStateProps {
  title: string;
  body: string;
  tone?: "neutral" | "danger";
  action?: ReactNode;
  onRetry?: () => void;
  className?: string;
}

/**
 * Apsi never appears on operational screens — orders, deliveries and customer
 * records use plain, quiet states instead.
 */
export function OperationalState({
  title,
  body,
  tone = "neutral",
  action,
  onRetry,
  className,
}: OperationalStateProps) {
  const { t } = useTranslation();

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-2xl border border-border-default bg-surface-primary px-5 py-6 text-center",
        className,
      )}
    >
      <h3
        className={cn(
          "text-h3",
          tone === "danger" ? "text-status-danger-text" : "text-text-primary",
        )}
      >
        {title}
      </h3>
      <p className="text-body mt-1 text-text-secondary">{body}</p>
      {onRetry ? (
        <Button className="tap-target mt-4 h-12" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
