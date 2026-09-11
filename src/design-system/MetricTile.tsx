import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { percent } from "@/lib/format";
import type { MetricPoint } from "@/types";

interface MetricTileProps {
  label: string;
  value: string;
  deltaPercent?: number | null;
  series?: MetricPoint[];
  className?: string;
}

export function Sparkline({
  series,
  tone = "info",
}: {
  series: MetricPoint[];
  tone?: "info" | "success" | "danger";
}) {
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
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="mt-2 h-7 w-full"
      role="presentation"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * One number in a two-up grid.
 *
 * Sized for the narrowest phone: at 320px each tile has ~140px of usable
 * width, so the value drops to h2 rather than the 28px financial display —
 * a large price at display size wrapped mid-number and read as two figures.
 */
export function MetricTile({ label, value, deltaPercent, series, className }: MetricTileProps) {
  const up = (deltaPercent ?? 0) >= 0;
  const Arrow = up ? TrendingUp : TrendingDown;

  return (
    <div
      className={cn(
        "elevation-1 flex min-w-0 flex-col rounded-2xl border border-border-default bg-surface-primary px-3 py-3",
        className,
      )}
    >
      <span className="text-caption chip-text text-text-secondary">{label}</span>
      <span className="text-h2 tnum mt-0.5 truncate text-text-primary">{value}</span>
      {typeof deltaPercent === "number" ? (
        <span
          className={cn(
            "text-caption tnum mt-1.5 inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5",
            up
              ? "bg-status-success-soft text-status-success-text"
              : "bg-status-danger-soft text-status-danger-text",
          )}
        >
          <Arrow className="size-3 shrink-0" aria-hidden />
          {percent(deltaPercent)}
        </span>
      ) : null}
      {series ? <Sparkline series={series} tone={up ? "info" : "danger"} /> : null}
    </div>
  );
}
