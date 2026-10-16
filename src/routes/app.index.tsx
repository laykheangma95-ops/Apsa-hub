import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getOrganizationProfileFn } from "@/api/org";
import { getHomeSummary, lookupVariantByBarcode } from "@/lib/api";
import { notifyInfo } from "@/lib/feedback";
import { CameraScanSheet } from "@/components/barcode/CameraScanSheet";
import { CreateRealOrderSheet } from "@/components/orders/CreateRealOrderSheet";
import { HomeHeader } from "@/components/home/HomeHeader";
import { HomeQuickActions } from "@/components/home/HomeQuickActions";
import { TodaySalesCard } from "@/components/home/TodaySalesCard";
import { customerKeys } from "@/lib/customers-query";
import { HOME_QUERY_PREFIX, homeQueryKey } from "@/lib/home-query";
import {
  attentionDestination,
  attentionItems,
  attentionNoticeKey,
  attentionSummary,
  attentionSummaryKey,
} from "@/lib/home-attention";
import { homeQuickActions, type HomeQuickActionState } from "@/lib/home-quick-actions";
import { resolveHomeSummaryView } from "@/lib/home-summary-view";
import { ordersKeys } from "@/lib/orders-query";
import { ORGANIZATION_PROFILE_QUERY_KEY } from "@/lib/settings-view";
import { resolveTeamIdentityView } from "@/lib/team-view";
import { AttentionCard, BottomNav, Disclosure, ScreenBleed, SkeletonBlock } from "@/design-system";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useHeldTileSize } from "@/hooks/use-held-tile-size";
import type { MetricRange } from "@/types";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Business Home — APSA" },
      {
        name: "description",
        content: "What needs attention now across orders, payments, stock, and delivery.",
      },
      { property: "og:title", content: "Business Home — APSA" },
      {
        property: "og:description",
        content: "A permission-aware command center for current business work.",
      },
    ],
  }),
  component: BusinessHome,
});

/**
 * Home always shows Today. Week and Month are Analytics' screen (same
 * net-collected definition, its own range control), linked from the Today card.
 */
const HOME_RANGE: MetricRange = "today";

function BusinessHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const tiles = useHeldTileSize();

  const homeQuery = useQuery({
    queryKey: homeQueryKey(session.userId, organizationId, HOME_RANGE),
    queryFn: () => getHomeSummary(HOME_RANGE),
  });

  // The one place allowed to decide whether fetched data may be shown as
  // Today's numbers — see src/lib/home-summary-view.ts.
  const view = resolveHomeSummaryView({
    range: HOME_RANGE,
    data: homeQuery.data,
    isError: homeQuery.isError,
  });
  const summary = view.kind === "ready" ? view.summary : undefined;
  const attention = summary ? attentionItems(summary) : [];
  // An empty attention list is only reassuring when Home actually knows the
  // list is empty. Anything less says so rather than implying a settled zero.
  const noticeKey = summary ? attentionNoticeKey(summary, attention.length) : null;
  // The collapsed row: kinds of work waiting, never a sum of overlapping counts.
  const collapsed = attentionSummary(view, attention.length);

  /*
   * The business name in the header comes from the real Organization profile —
   * the same read, cache entry and organization.read gate as Team's header and
   * Settings' Business row. Anything short of a successful read shows no name.
   */
  const canReadOrganization = capabilities.can("organization.read");
  const organizationQuery = useQuery({
    queryKey: ORGANIZATION_PROFILE_QUERY_KEY,
    queryFn: () => getOrganizationProfileFn(),
    retry: false,
    enabled: canReadOrganization,
  });
  const identity = resolveTeamIdentityView(canReadOrganization, organizationQuery);
  const businessName = identity.kind === "ready" ? identity.organizationName : null;

  /*
   * Each card is keyed to the permission its destination actually requires
   * server-side (src/lib/home-quick-actions.ts). A card the member cannot use
   * keeps its place and says so; it is never a button into a refusal.
   */
  const quickActions = homeQuickActions((key) => capabilities.can(key));
  const canCreateOrder = capabilities.can("orders.create");

  function handleQuickAction(action: HomeQuickActionState) {
    if (action.target.kind === "createOrderSheet") {
      setCreateOrderOpen(true);
      return;
    }
    void navigate({ to: action.target.to });
  }

  function toggleAttention(next: boolean) {
    // Measured in the tap, before the list takes any height from the tiles.
    if (next) tiles.hold();
    else tiles.release();
    setAttentionOpen(next);
  }

  /*
   * Camera scanning resolves exactly as Inventory's scanner does — the same
   * org-scoped lookupVariantByBarcode, behind the same two read grants — and
   * opens the scanned item's stock page.
   */
  const canScan = capabilities.can("inventory.read") && capabilities.can("products.read");

  function resolveScan(code: string) {
    void (async () => {
      try {
        const result = await lookupVariantByBarcode(code.trim());
        if (result) {
          void navigate({
            to: "/app/inventory/$variantId",
            params: { variantId: result.variant.id },
          });
          return;
        }
      } catch {
        // A failed lookup is reported the same way as a miss: nothing opened.
      }
      notifyInfo(t("inventory.scanNotFound"));
    })();
  }

  return (
    <ScreenBleed bottom="nav" contentClassName="home-column">
      <HomeHeader
        businessName={businessName}
        onScan={canScan ? () => setCameraOpen(true) : undefined}
      />

      {/* .home-main: header-sized rows, then the rest of the screen for the tiles. */}
      <main className="home-main screen-gutter mx-auto w-full max-w-[var(--screen-max)] pt-2.5">
        <TodaySalesCard
          view={view}
          onRetry={() => void homeQuery.refetch()}
          analyticsAvailable={capabilities.can("analytics.read")}
        />

        <Disclosure
          id="home-attention"
          title={t("home.attention")}
          summary={t(
            attentionSummaryKey(collapsed),
            collapsed.kind === "count" ? { count: collapsed.rows } : {},
          )}
          badge={
            collapsed.kind === "count" ? (
              // The summary line already says the number; this is its marker.
              <span
                aria-hidden
                className="text-label tnum flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-status-warning-soft px-2 text-status-warning-text"
              >
                {collapsed.rows}
              </span>
            ) : null
          }
          open={attentionOpen}
          onOpenChange={toggleAttention}
        >
          <div className="space-y-2 px-3 pt-0.5 pb-3">
            {summary ? (
              <>
                {attention.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {attention.map((item) => {
                      /*
                       * A row is a link only when something owns that work AND
                       * this member may enter the screen that does. capabilities
                       * .can is fail-closed, so an unresolved snapshot renders a
                       * plain card rather than a link into a refusal. A row
                       * whose count one Orders filter selects exactly opens on
                       * that filter (see home-attention.ts).
                       */
                      const destination = attentionDestination(item.id, (key) =>
                        capabilities.can(key),
                      );
                      return (
                        <AttentionCard
                          key={item.id}
                          item={item}
                          onClick={destination ? () => void navigate(destination) : undefined}
                        />
                      );
                    })}
                  </div>
                ) : null}
                {noticeKey ? (
                  <p className="px-1 text-body-sm text-text-secondary">{t(noticeKey)}</p>
                ) : null}
                <div className="space-y-1 px-1" aria-live="polite">
                  {(["orders", "payments", "inventory", "delivery"] as const).map((domain) => {
                    const status = summary[domain].status;
                    if (status === "available") return null;
                    return (
                      <p key={domain} className="text-caption text-text-secondary">
                        {t(`home.sectionState.${status}`, {
                          domain: t(`home.domains.${domain}`),
                        })}
                      </p>
                    );
                  })}
                </div>
              </>
            ) : view.kind === "loading" ? (
              <div className="grid gap-2" aria-hidden="true">
                <SkeletonBlock className="h-[62px] w-full rounded-2xl" />
                <SkeletonBlock className="h-[62px] w-full rounded-2xl" />
              </div>
            ) : (
              // Nothing for Today to fall back to: say so, and offer the retry.
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
                <p className="text-body-sm min-w-0 flex-1 text-text-secondary">
                  {t("home.error.body")}
                </p>
                <button
                  type="button"
                  onClick={() => void homeQuery.refetch()}
                  className="press tap-target text-label shrink-0 rounded-full px-3 text-action-primary underline underline-offset-2"
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          </div>
        </Disclosure>

        <HomeQuickActions
          actions={quickActions}
          onAction={handleQuickAction}
          gridRef={tiles.gridRef}
          heldSize={tiles.heldSize}
        />
      </main>

      <BottomNav workspace="business" />

      {/*
       * The manual Create Order flow itself — the same sheet, gate and cache
       * effects as the Orders list's "+" (src/routes/app.orders.tsx).
       */}
      {canCreateOrder ? (
        <CreateRealOrderSheet
          open={createOrderOpen}
          onOpenChange={setCreateOrderOpen}
          userId={session.userId}
          organizationId={organizationId}
          onCreated={() => {
            void queryClient.invalidateQueries({
              queryKey: ordersKeys.list(session.userId, organizationId),
            });
            // A new order is new outstanding work: Home's counts move with it.
            void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
            void queryClient.invalidateQueries({
              queryKey: customerKeys.principal(session.userId, organizationId),
            });
          }}
        />
      ) : null}

      {canScan ? (
        <CameraScanSheet open={cameraOpen} onOpenChange={setCameraOpen} onCode={resolveScan} />
      ) : null}
    </ScreenBleed>
  );
}
