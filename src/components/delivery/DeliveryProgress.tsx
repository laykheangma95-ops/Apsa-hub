import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StatusKey } from "@/types";

/** The courier-facing flow used by the mock/prototype delivery screen. */
export const TRACKING_STEPS: readonly StatusKey[] = [
  "requested",
  "accepted",
  "picked_up",
  "in_transit",
  "delivered",
];

/** The production Delivery domain's own flow (src/server/deliveries/state-machine.ts). */
export const FULFILMENT_STEPS: readonly StatusKey[] = [
  "pending",
  "preparing",
  "ready",
  "in_transit",
  "delivered",
];

const STOPPED: readonly StatusKey[] = ["failed", "cancelled"];

interface DeliveryProgressProps {
  status: StatusKey;
  /** Defaults to the courier tracking flow. */
  steps?: readonly StatusKey[];
}

/**
 * Where the parcel is, as a rail.
 *
 * Five labels across a 320px phone gave each step ~60px; "កំពុងដឹកជញ្ជូន"
 * wrapped to four lines and the component became unreadable in the default
 * language. The rail carries the position and only the step the merchant is
 * actually on is named — every step keeps its name for screen readers, and in
 * the history timeline below.
 *
 * Progress is never colour alone: reached steps carry a tick, the current step
 * is named in words, and a stopped delivery says so.
 */
export function DeliveryProgress({ status, steps = TRACKING_STEPS }: DeliveryProgressProps) {
  const { t } = useTranslation();
  const stopped = STOPPED.includes(status);
  const index = steps.indexOf(status);
  const reachedCount = stopped ? 0 : index + 1;

  return (
    <div>
      <ol
        className="flex items-center gap-1"
        aria-label={t("delivery.progressLabel", {
          step: Math.max(reachedCount, 1),
          total: steps.length,
          status: t(`status.${status}`),
        })}
      >
        {steps.map((step, i) => {
          const reached = !stopped && index >= i;
          const current = !stopped && index === i;
          return (
            <li
              key={step}
              className={cn("flex min-w-0 items-center", i < steps.length - 1 && "flex-1")}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-[var(--dur-base)]",
                  stopped
                    ? "border-status-danger bg-status-danger-soft text-status-danger-text"
                    : reached
                      ? "border-status-success bg-status-success text-text-inverse"
                      : "border-border-strong bg-surface-secondary text-text-muted",
                  current && !stopped && "ring-2 ring-[color:var(--status-success)]/25",
                )}
              >
                {stopped && i === 0 ? (
                  <X className="size-3.5" aria-hidden />
                ) : reached ? (
                  <Check className="size-3.5" aria-hidden />
                ) : null}
                <span className="sr-only">{t(`status.${step}`)}</span>
              </span>
              {i < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    "mx-1 h-0.5 min-w-2 flex-1 rounded-full",
                    !stopped && index > i ? "bg-status-success" : "bg-border-strong",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="text-label mt-2 text-text-primary">
        {stopped
          ? t(`status.${status}`)
          : t("delivery.progressStep", {
              step: Math.max(reachedCount, 1),
              total: steps.length,
              status: t(`status.${status}`),
            })}
      </p>
    </div>
  );
}
