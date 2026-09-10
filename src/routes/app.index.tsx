import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getActiveShop, getHomeSummary } from "@/lib/api";
import { localName } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { useLanguage } from "@/lib/i18n";
import {
  AppHeader,
  ApsiInsightCard,
  AttentionCard,
  BottomNav,
  BottomSheet,
  EmptyState,
  ErrorState,
  HomeSkeleton,
  MetricTile,
  QuickActionGrid,
  ScreenBleed,
  SegmentedControl,
  type QuickActionId,
  type Segment,
} from "@/design-system";
import { WorkspaceSwitcherSheet } from "@/components/team/WorkspaceSwitcherSheet";
import type { AttentionItem, MetricRange } from "@/types";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Business Home — APSA" },
      {
        name: "description",
        content:
          "Today's revenue, what needs attention, quick actions and business metrics for your shop.",
      },
      { property: "og:title", content: "Business Home — APSA" },
      {
        property: "og:description",
        content:
          "Revenue, attention items, quick actions and metrics in one Khmer-first home screen.",
      },
    ],
  }),
  component: BusinessHome,
});

const RANGES: MetricRange[] = ["today", "week", "month"];

/**
 * Where an attention row goes. Only the destinations that exist today are
 * listed — a row with no route stays a plain, honest count rather than a
 * button that leads nowhere.
 */
const ATTENTION_ROUTE: Partial<Record<AttentionItem["id"], "/app/inbox" | "/app/orders">> = {
  unread_conversations: "/app/inbox",
  awaiting_payment: "/app/orders",
  awaiting_delivery: "/app/orders",
  orders_needing_action: "/app/orders",
};

function BusinessHome() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const [range, setRange] = useState<MetricRange>("today");
  const [createOpen, setCreateOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [insightDismissed, setInsightDismissed] = useState(false);

  const shopQuery = useQuery({ queryKey: ["shop"], queryFn: getActiveShop });
  const homeQuery = useQuery({
    queryKey: ["home", range],
    queryFn: () => getHomeSummary(range),
  });

  const summary = homeQuery.data;
  const isEmpty = summary && !summary.hasActivity;
  const unread = summary?.attention.find((item) => item.id === "unread_conversations")?.count ?? 0;

  const rangeSegments: Segment<MetricRange>[] = RANGES.map((value) => ({
    value,
    label: t(`home.range.${value}`),
  }));

  function handleQuickAction(id: QuickActionId) {
    // Only two of the four have a real destination today. The rest open the
    // create sheet, which says plainly what is and is not built yet.
    if (id === "newOrder") {
      void navigate({ to: "/app/orders" });
      return;
    }
    if (id === "receivePayment") {
      void navigate({ to: "/app/pos" });
      return;
    }
    setCreateOpen(true);
  }

  return (
    <ScreenBleed bottom="nav">
      <AppHeader
        title={shopQuery.data ? localName(shopQuery.data, language) : t("brand.name")}
        subtitle={shopQuery.data?.city}
        onShopSwitch={() => setSwitcherOpen(true)}
        notificationCount={unread}
      >
        {/* Greeting scrolls away with the page — only the bar stays pinned. */}
        <div className="pb-1">
          <h1 className="text-h1 text-text-primary">
            {t("home.greeting", { name: summary?.greetingName ?? "" })}
          </h1>
          <p className="text-body-sm text-text-secondary">{t("home.subtitle")}</p>
        </div>
      </AppHeader>

      <main className="mx-auto max-w-[var(--screen-max)]">
        {homeQuery.isPending ? <HomeSkeleton /> : null}

        {homeQuery.isError ? (
          <ErrorState
            showApsi
            title={t("home.error.title")}
            body={t("home.error.body")}
            onRetry={() => void homeQuery.refetch()}
          />
        ) : null}

        {summary && isEmpty ? (
          <EmptyState
            title={t("home.empty.title")}
            body={t("home.empty.body")}
            action={
              <Button className="press tap-target h-12 px-6" onClick={() => setCreateOpen(true)}>
                {t("home.empty.action")}
              </Button>
            }
          />
        ) : null}

        {summary && !isEmpty ? (
          <div className="stack-section screen-gutter pt-4">
            {/*
             * What needs doing comes before what already happened. On a phone
             * the merchant sees roughly one screen before scrolling, and that
             * screen should be work, not a report.
             */}
            {summary.attention.length > 0 ? (
              <section aria-labelledby="attention-heading">
                <h2 id="attention-heading" className="text-label px-1 text-text-secondary">
                  {t("home.attention")}
                </h2>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {summary.attention.map((item) => {
                    const to = ATTENTION_ROUTE[item.id];
                    return (
                      <AttentionCard
                        key={item.id}
                        item={item}
                        onClick={to ? () => void navigate({ to }) : undefined}
                      />
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section aria-labelledby="overview-heading" className="stack-group">
              <div className="flex min-w-0 items-center justify-between gap-3 px-1">
                <h2 id="overview-heading" className="text-label min-w-0 text-text-secondary">
                  {t("home.overview")}
                </h2>
              </div>

              <SegmentedControl
                segments={rangeSegments}
                value={range}
                onChange={setRange}
                label={t("home.overview")}
              />

              {summary.financialsAvailable ? (
                <section className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
                  <p className="text-label text-text-secondary">{t("home.revenue")}</p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {summary.revenues.length > 0 ? (
                      summary.revenues.map((revenue) => (
                        <p
                          key={revenue.currency}
                          className="text-financial-lg min-w-0 text-text-primary"
                        >
                          {formatMoney(revenue)}
                        </p>
                      ))
                    ) : (
                      <p className="text-body-sm text-text-secondary">{t("home.noSettledSales")}</p>
                    )}
                  </div>
                </section>
              ) : (
                <p className="px-1 text-body-sm text-text-secondary">
                  {t("home.financialsUnavailable")}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                {summary.metrics.map((metric) => (
                  <MetricTile
                    key={metric.id}
                    label={t(`home.metrics.${metric.id}`)}
                    value={metric.value}
                    deltaPercent={metric.deltaPercent}
                    series={metric.series}
                  />
                ))}
              </div>
            </section>

            <section aria-labelledby="actions-heading" className="stack-group">
              <h2 id="actions-heading" className="text-label px-1 text-text-secondary">
                {t("home.quickActions")}
              </h2>
              <QuickActionGrid onAction={handleQuickAction} />
            </section>

            {!insightDismissed ? (
              <ApsiInsightCard
                emotion="thinking"
                title={t("home.apsi.title")}
                body={t("home.apsi.body")}
                onDismiss={() => setInsightDismissed(true)}
              />
            ) : null}
          </div>
        ) : null}
      </main>

      <WorkspaceSwitcherSheet open={switcherOpen} onOpenChange={setSwitcherOpen} />
      <BottomNav
        workspace="business"
        onCreate={() => setCreateOpen(true)}
        {...(unread > 0 ? { badges: { inbox: unread } } : {})}
      />

      <BottomSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t("nav.create")}
        snap="peek"
      >
        <ul className="space-y-2">
          {(["newSale", "newOrder", "addProduct", "scanBarcode"] as const).map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="press tap-target text-body flex w-full items-center rounded-2xl border border-border-default bg-surface-primary px-4 py-3 text-left"
              >
                {t(`nav.${key}`)}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </ScreenBleed>
  );
}
