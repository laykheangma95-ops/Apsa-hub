import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  BottomNav,
  BottomSheet,
  ListSkeleton,
  Screen,
  ServiceGrid,
  StatusChip,
} from "@/design-system";
import {
  SALES_TILES,
  defaultSalesTileOrder,
  visibleHubTiles,
  type AppNavRoute,
  type HubTileConfig,
  type HubTilePreference,
} from "@/design-system/app-nav-config";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useTabScrollMemory } from "@/hooks/use-tab-memory";
import { listRealOrders } from "@/lib/api";
import { notifyInfo } from "@/lib/feedback";
import { formatMoney } from "@/lib/money";
import { moveTile, readSalesTilePreference, writeSalesTilePreference } from "@/lib/hub-preferences";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/sales")({
  head: () => ({
    meta: [
      { title: "Sales — APSA" },
      {
        name: "description",
        content: "Point of sale, orders, payments and delivery in one operational hub.",
      },
      { property: "og:title", content: "Sales — APSA" },
      { property: "og:description", content: "Everything that moves money today, in one place." },
    ],
  }),
  component: SalesHub,
});

const RECENT_ORDER_LIMIT = 5;

/**
 * Sales — the "I am selling right now" hub.
 *
 * A tab root, so it is a full screen rather than a sheet: this is where a
 * merchant lands and decides what to do next, and deciding needs the whole
 * screen. Everything *inside* a decision — picking a variant, taking a
 * payment, arranging the grid — is a sheet.
 */
function SalesHub() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();
  const [arrangeOpen, setArrangeOpen] = useState(false);

  useTabScrollMemory("sales");

  const [preference, setPreference] = useState<HubTilePreference | undefined>(undefined);

  /*
   * Read after mount, never during render: localStorage does not exist on the
   * server, and reading it in render would make the first client paint differ
   * from the markup the server sent.
   */
  useEffect(() => {
    setPreference(readSalesTilePreference(session.userId, organizationId));
  }, [session.userId, organizationId]);

  const canReadOrders = capabilities.can("orders.read");

  /*
   * Capability first, preference second. `visibleHubTiles` drops everything
   * this member has no server-supported access to before any arrangement is
   * applied, so no arrangement — theirs or a stale one from another role — can
   * put back a tile the server would refuse.
   */
  const effectivePreference = useMemo<HubTilePreference & { order: readonly string[] }>(
    () => ({
      order: preference?.order ?? defaultSalesTileOrder(capabilities),
      ...(preference?.hidden ? { hidden: preference.hidden } : {}),
    }),
    [preference, capabilities],
  );

  const tiles = useMemo(
    () => visibleHubTiles(SALES_TILES, capabilities, effectivePreference),
    [capabilities, effectivePreference],
  );

  /** Every tile this member may see, ignoring their hide list — the arrange sheet's universe. */
  const arrangeableTiles = useMemo(
    () => visibleHubTiles(SALES_TILES, capabilities, { order: effectivePreference.order }),
    [capabilities, effectivePreference.order],
  );

  const ordersQuery = useQuery({
    queryKey: ["orders", "real"],
    queryFn: listRealOrders,
    enabled: canReadOrders,
  });
  const recentOrders = (ordersQuery.data ?? []).slice(0, RECENT_ORDER_LIMIT);

  const persist = useCallback(
    (next: HubTilePreference) => {
      setPreference(next);
      writeSalesTilePreference(session.userId, organizationId, next);
    },
    [session.userId, organizationId],
  );

  function openTile(tile: HubTileConfig) {
    if (tile.to) {
      void navigate({ to: tile.to as AppNavRoute });
      return;
    }
    // A tile that is part of the map but has no screen yet says so plainly.
    // It is never dressed up as working, and never as a permission problem.
    notifyInfo(t("appNav.notBuiltYet"), t(`appNav.planned.${tile.id}`));
  }

  const hidden = new Set(effectivePreference.hidden ?? []);

  return (
    <Screen bottom="nav">
      <AppHeader title={t("appNav.sales.title")} action={null}>
        <div className="flex items-end justify-between gap-2 pb-1">
          <div className="min-w-0">
            <h1 className="text-h1 text-text-primary">{t("appNav.sales.title")}</h1>
            <p className="text-body-sm text-text-secondary">{salesSubtitle(capabilities, t)}</p>
          </div>
          <button
            type="button"
            onClick={() => setArrangeOpen(true)}
            aria-label={t("appNav.arrange.open")}
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full border border-border-default text-text-secondary"
          >
            <SlidersHorizontal className="size-5" aria-hidden />
          </button>
        </div>
      </AppHeader>

      <main className="stack-section pt-4">
        {tiles.length > 0 ? (
          <ServiceGrid tiles={tiles} onOpen={openTile} />
        ) : (
          <p className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-5 text-text-secondary">
            {t("appNav.sales.nothingAvailable")}
          </p>
        )}

        {canReadOrders ? (
          <section aria-labelledby="sales-recent-heading" className="stack-group">
            <h2 id="sales-recent-heading" className="text-label px-1 text-text-secondary">
              {t("appNav.sales.recent")}
            </h2>

            {ordersQuery.isPending ? <ListSkeleton rows={3} /> : null}

            {ordersQuery.isError ? (
              <button
                type="button"
                onClick={() => void ordersQuery.refetch()}
                className="press tap-target text-body-sm rounded-2xl border border-border-default px-4 py-3 text-left text-action-primary"
              >
                {t("appNav.sales.recentRetry")}
              </button>
            ) : null}

            {!ordersQuery.isPending && !ordersQuery.isError && recentOrders.length === 0 ? (
              <p className="text-body-sm rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary">
                {t("appNav.sales.recentEmpty")}
              </p>
            ) : null}

            {recentOrders.length > 0 ? (
              <ul className="list-enter overflow-hidden rounded-2xl border border-border-default bg-surface-primary">
                {recentOrders.map((order) => (
                  <li key={order.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({ to: "/app/orders/$id", params: { id: order.id } })
                      }
                      /* ~68px: compact enough that four orders fit on a 390px
                         phone above the fold, tall enough to stay tappable. */
                      className="press flex min-h-[68px] w-full items-center gap-3 border-b border-border-default px-4 py-2.5 text-left last:border-b-0"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="text-label tnum block truncate text-text-primary">
                          {order.code}
                        </span>
                        <span className="text-caption block truncate text-text-muted">
                          {order.customerId
                            ? t("orderList.hasCustomer")
                            : t("orderList.noCustomer")}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <StatusChip status={order.paymentStatus} />
                        </span>
                      </span>
                      <span className="text-financial shrink-0 text-text-primary">
                        {formatMoney(order.total)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </main>

      <BottomNav />

      <BottomSheet
        open={arrangeOpen}
        onOpenChange={setArrangeOpen}
        title={t("appNav.arrange.title")}
        description={t("appNav.arrange.lead")}
        snap="half"
      >
        <ul className="flex flex-col gap-2">
          {arrangeableTiles.map((tile, index) => {
            const isHidden = hidden.has(tile.id);
            return (
              <li
                key={tile.id}
                className="flex items-center gap-2 rounded-2xl border border-border-default bg-surface-primary px-3 py-2"
              >
                <tile.icon className="size-5 shrink-0 text-text-secondary" aria-hidden />
                <span
                  className={cn(
                    "chip-text text-body min-w-0 flex-1",
                    isHidden ? "text-text-muted" : "text-text-primary",
                  )}
                >
                  {t(tile.labelKey)}
                </span>
                <ArrangeButton
                  label={t("appNav.arrange.moveUp", { tile: t(tile.labelKey) })}
                  disabled={index === 0}
                  onClick={() =>
                    persist({
                      ...effectivePreference,
                      order: moveTile(
                        arrangeableTiles.map((entry) => entry.id),
                        tile.id,
                        -1,
                      ),
                    })
                  }
                >
                  <ArrowUp className="size-4" aria-hidden />
                </ArrangeButton>
                <ArrangeButton
                  label={t("appNav.arrange.moveDown", { tile: t(tile.labelKey) })}
                  disabled={index === arrangeableTiles.length - 1}
                  onClick={() =>
                    persist({
                      ...effectivePreference,
                      order: moveTile(
                        arrangeableTiles.map((entry) => entry.id),
                        tile.id,
                        1,
                      ),
                    })
                  }
                >
                  <ArrowDown className="size-4" aria-hidden />
                </ArrangeButton>
                <ArrangeButton
                  label={t(isHidden ? "appNav.arrange.show" : "appNav.arrange.hide", {
                    tile: t(tile.labelKey),
                  })}
                  onClick={() => {
                    const next = new Set(hidden);
                    if (isHidden) next.delete(tile.id);
                    else next.add(tile.id);
                    persist({ ...effectivePreference, hidden: [...next] });
                  }}
                >
                  {isHidden ? (
                    <EyeOff className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </ArrangeButton>
              </li>
            );
          })}
        </ul>
      </BottomSheet>
    </Screen>
  );
}

function ArrangeButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="press tap-target flex size-11 shrink-0 items-center justify-center rounded-full text-text-secondary disabled:opacity-35"
    >
      {children}
    </button>
  );
}

/**
 * One line under the title, chosen by what this member can actually do.
 *
 * Derived from permissions, never from a role name: the same person's job
 * changes when their permissions change, and the copy should follow the
 * permissions rather than a label that may be out of date.
 */
function salesSubtitle(
  capabilities: ReturnType<typeof useCapabilities>,
  t: (key: string) => string,
): string {
  if (capabilities.can("orders.create")) return t("appNav.sales.subtitleSelling");
  if (capabilities.can("orders.read")) return t("appNav.sales.subtitleQueue");
  return t("appNav.sales.subtitleLimited");
}
