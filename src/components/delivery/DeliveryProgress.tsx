import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { DeliveryStatus } from "@/types";

const STEPS: DeliveryStatus[] = ["requested", "accepted", "picked_up", "in_transit", "delivered"];

/** Progress is never colour alone — the reached steps carry a tick and a label. */
export function DeliveryProgress({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation();
  const failed = status === "failed" || status === "cancelled";
  const index = STEPS.indexOf(status);

  return (
    <ol className="flex items-start gap-1">
      {STEPS.map((step, i) => {
        const reached = !failed && index >= i;
        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border",
                reached
                  ? "border-status-success bg-status-success text-text-inverse"
                  : "border-border-strong bg-surface-secondary text-text-muted",
              )}
            >
              {reached ? <Check className="size-3.5" aria-hidden /> : null}
              <span className="sr-only">{reached ? "✓" : "—"}</span>
            </span>
            <span
              className={cn(
                "text-caption chip-text text-center leading-tight",
                reached ? "text-text-primary" : "text-text-muted",
              )}
            >
              {t(`status.${step}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
