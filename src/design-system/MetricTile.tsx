import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { percent } from "@/lib/format";
import type { MetricPoint } from "@/types";

interface MetricTileProps {
  label: string;
  value: string;
  deltaPercent?: number;
  series?: MetricPoint[];
  className?: string;
}

export function Sparkline({ series, tone = "info" }: { series: MetricPoint[]; tone?: "info" | "success" | "danger" }) {
  if (series.length < 2) return null;
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`)
    .join(" ");
  const stroke =
    tone === "success"
      ? "var(--status-success)"
      : tone === "danger"
        ? "var(--status-danger)"
        : "var(--action-primary)";

  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MetricTile({ label, value, deltaPercent, series, className }: MetricTileProps) {
  const up = (deltaPercent ?? 0) >= 0;
  const Arrow = up ? TrendingUp : TrendingDown;

  return (
    <div
      className={cn(
        "elevation-1 flex flex-col gap-1.5 rounded-2xl border border-border-default bg-surface-primary p-4",
        className,
      )}
    >
      <span className="text-label text-text-secondary">{label}</span>
      <span className="text-financial-lg text-text-primary">{value}</span>
      {deltaPercent !== undefined ? (
        <span
          className={cn(
            "text-caption tnum inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5",
            up
              ? "bg-status-success-soft text-status-success-text"
              : "bg-status-danger-soft text-status-danger-text",
          )}
        >
          <Arrow className="size-3" aria-hidden />
          {percent(deltaPercent)}
        </span>
      ) : null}
      {series ? <Sparkline series={series} tone={up ? "info" : "danger"} /> : null}
    </div>
  );
}
