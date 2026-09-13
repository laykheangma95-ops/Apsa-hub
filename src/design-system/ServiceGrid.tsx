import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { HubTileConfig } from "./app-nav-config";

interface ServiceGridProps {
  tiles: readonly HubTileConfig[];
  onOpen: (tile: HubTileConfig) => void;
  className?: string;
}

/**
 * The hub grid: three columns of large, evenly weighted tiles.
 *
 * Borrowed from the service grids Cambodian merchants already use every day in
 * ABA, Wing and Alipay — a shape they can read without being taught. Every
 * tile is the same size on purpose: this is a menu of destinations, not a
 * ranking, and making one tile bigger would be a claim about their business we
 * have no right to make.
 *
 * Tiles that are here as part of the map but have no screen yet say so in one
 * quiet line. That is different from a tile this member cannot access — those
 * are not rendered at all, because a greyed-out "Payments" tells a cashier
 * exactly what the owner can see.
 */
export function ServiceGrid({ tiles, onOpen, className }: ServiceGridProps) {
  const { t } = useTranslation();

  return (
    <ul className={cn("list-enter grid grid-cols-3 gap-2", className)}>
      {tiles.map((tile) => {
        const planned = tile.availability === "planned";
        return (
          <li key={tile.id}>
            <button
              type="button"
              onClick={() => onOpen(tile)}
              aria-disabled={planned}
              className={cn(
                "press-tactile flex min-h-[96px] w-full flex-col items-center justify-center gap-2 rounded-2xl border px-2 py-3 text-center",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]",
                planned
                  ? "border-border-default bg-surface-secondary/70 text-text-muted"
                  : "border-border-default bg-surface-primary text-text-primary hover:bg-surface-secondary",
              )}
            >
              <span
                className={cn(
                  // 48px: the tap target the tile promises, drawn rather than
                  // implied, so the icon is never a 20px dot in a big box.
                  "flex size-12 shrink-0 items-center justify-center rounded-2xl",
                  planned
                    ? "bg-surface-primary text-text-muted"
                    : "bg-action-primary-soft text-action-primary",
                )}
              >
                <tile.icon className="size-6" aria-hidden />
              </span>
              <span className="chip-text text-label block max-w-full leading-tight">
                {t(tile.labelKey)}
              </span>
              {planned ? (
                <span className="chip-text text-caption block text-text-muted">
                  {t("appNav.notBuiltYet")}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
