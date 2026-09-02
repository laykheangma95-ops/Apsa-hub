import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  className?: string;
}

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 999,
  className,
}: QuantityStepperProps) {
  const { t } = useTranslation();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const step = useCallback(
    (delta: number) => {
      const next = Math.min(max, Math.max(min, latest.current + delta));
      if (next !== latest.current) onChange(next);
    },
    [max, min, onChange],
  );

  const startRepeat = (delta: number) => {
    stop();
    timer.current = setInterval(() => step(delta), 120);
  };

  const buttonClass =
    "tap-target flex items-center justify-center rounded-lg border border-border-strong bg-surface-primary text-text-primary transition-colors hover:bg-surface-secondary disabled:opacity-40";

  return (
    <div className={cn("inline-flex items-center gap-2", className)} role="group">
      <button
        type="button"
        className={buttonClass}
        aria-label={t("common.decrease")}
        disabled={value <= min}
        onClick={() => step(-1)}
        onPointerDown={() => startRepeat(-1)}
        onPointerUp={stop}
        onPointerLeave={stop}
      >
        <Minus className="size-4" aria-hidden />
      </button>
      <output className="text-financial min-w-10 text-center" aria-label={t("common.quantity")}>
        {value}
      </output>
      <button
        type="button"
        className={buttonClass}
        aria-label={t("common.increase")}
        disabled={value >= max}
        onClick={() => step(1)}
        onPointerDown={() => startRepeat(1)}
        onPointerUp={stop}
        onPointerLeave={stop}
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}
