import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, Screen } from "@/design-system";
import {
  BUSINESS_GROUPS,
  visibleHubGroups,
  type AppNavRoute,
  type HubTileConfig,
} from "@/design-system/app-nav-config";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useTabScrollMemory } from "@/hooks/use-tab-memory";
import { notifyInfo } from "@/lib/feedback";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/business")({
  head: () => ({
    meta: [
      { title: "Business — APSA" },
      {
        name: "description",
        content: "Catalogue, people, insights and system settings for the whole business.",
      },
      { property: "og:title", content: "Business — APSA" },
      { property: "og:description", content: "The management side of APSA, grouped by intent." },
    ],
  }),
  component: BusinessHub,
});

/**
 * Business — the "I am running this place" hub.
 *
 * A grouped list rather than a second grid, and that difference is the point.
 * Sales is a grid because its tiles are things a merchant does dozens of times
 * a day and reaches for by muscle memory. Business is a list because its items
 * are visited occasionally and deliberately, and a named group ("People",
 * "System") tells you where to look in a way a wall of nine icons cannot.
 */
function BusinessHub() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();

  useTabScrollMemory("business");

  /*
   * Hidden, never disabled. A greyed-out "Team" row would tell a cashier that
   * team management exists and is being kept from them; an absent row tells
   * them nothing about anyone else's access. Groups left empty disappear with
   * their heading.
   */
  const groups = useMemo(() => visibleHubGroups(BUSINESS_GROUPS, capabilities), [capabilities]);

  function openTile(tile: HubTileConfig) {
    if (tile.to) {
      void navigate({ to: tile.to as AppNavRoute });
      return;
    }
    notifyInfo(t("appNav.notBuiltYet"), t(`appNav.planned.${tile.id}`));
  }

  return (
    <Screen bottom="nav">
      <AppHeader title={t("appNav.business.title")} action={null}>
        <div className="pb-1">
          <h1 className="text-h1 text-text-primary">{t("appNav.business.title")}</h1>
          <p className="text-body-sm text-text-secondary">{t("appNav.business.subtitle")}</p>
        </div>
      </AppHeader>

      <main className="stack-section pt-4">
        {groups.length === 0 ? (
          <p className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-5 text-text-secondary">
            {t("appNav.business.nothingAvailable")}
          </p>
        ) : null}

        {groups.map((group) => (
          <section
            key={group.id}
            aria-labelledby={`business-${group.id}`}
            className="flex flex-col gap-2"
          >
            <h2 id={`business-${group.id}`} className="text-label px-1 text-text-secondary">
              {t(group.titleKey)}
            </h2>
            <ul className="list-enter overflow-hidden rounded-2xl border border-border-default bg-surface-primary">
              {group.tiles.map((tile) => {
                const planned = tile.availability === "planned";
                return (
                  <li key={tile.id}>
                    <button
                      type="button"
                      onClick={() => openTile(tile)}
                      aria-disabled={planned}
                      className="press flex min-h-[64px] w-full items-center gap-3 border-b border-border-default px-4 py-3 text-left last:border-b-0"
                    >
                      <span
                        className={cn(
                          "flex size-10 shrink-0 items-center justify-center rounded-2xl",
                          planned
                            ? "bg-surface-secondary text-text-muted"
                            : "bg-action-primary-soft text-action-primary",
                        )}
                      >
                        <tile.icon className="size-5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "chip-text text-body block",
                            planned ? "text-text-muted" : "text-text-primary",
                          )}
                        >
                          {t(tile.labelKey)}
                        </span>
                        {planned ? (
                          <span className="chip-text text-caption block text-text-muted">
                            {t("appNav.notBuiltYet")}
                          </span>
                        ) : null}
                      </span>
                      {planned ? null : (
                        <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </main>

      <BottomNav />
    </Screen>
  );
}
