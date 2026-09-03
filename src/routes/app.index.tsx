import { createFileRoute } from "@tanstack/react-router";
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
  Sparkline,
} from "@/design-system";
import { WorkspaceSwitcherSheet } from "@/components/team/WorkspaceSwitcherSheet";
import type { MetricRange } from "@/types";

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
        content: "Revenue, attention items, quick actions and metrics in one Khmer-first home screen.",
      },
    ],
  }),
  component: BusinessHome,
});

const RANGES: MetricRange[] = ["today", "week", "month"];

function BusinessHome() {
  const { t } = useTranslation();
  const { language } = useLanguage();
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
  const isEmpty = summary && summary.revenue.amount === 0;

  return (
    <div className="min-h-screen bg-surface-page pb-28">
      <AppHeader
        title={shopQuery.data ? localName(shopQuery.data, language) : t("brand.name")}
        subtitle={shopQuery.data?.city}
        onShopSwitch={() => setSwitcherOpen(true)}
        notificationCount={3}
        variant="plain"
      >
        <div>
          <p className="text-h2">{t("home.greeting", { name: summary?.greetingName ?? "" })}</p>
          <p className="text-body-sm text-text-secondary">{t("home.subtitle")}</p>
        </div>
      </AppHeader>

      <main className="mx-auto max-w-[560px]">
        {homeQuery.isPending ? <HomeSkeleton /> : null}

        {homeQuery.isError ? (
          <ErrorState
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
              <Button className="tap-target" onClick={() => setCreateOpen(true)}>
                {t("home.empty.action")}
              </Button>
            }
          />
        ) : null}

        {summary && !isEmpty ? (
          <div className="stack-section px-4 py-5 pb-[var(--space-screen-bottom)]">
            <section className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
              <p className="text-label text-text-secondary">{t("home.revenue")}</p>
              <p className="text-financial-lg mt-1 text-text-primary">
                {formatMoney(summary.revenue)}
              </p>
              <Sparkline series={summary.revenueSeries} tone="success" />
            </section>


            {/* Needs attention comes before metrics, always. */}
            <section aria-labelledby="attention-heading">
              <h2 id="attention-heading" className="text-h3 text-text-primary">
                {t("home.attention")}
              </h2>
              <p className="text-body-sm text-text-secondary">{t("home.attentionSubtitle")}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {summary.attention.map((item) => (
                  <AttentionCard key={item.id} item={item} />
                ))}
              </div>
            </section>

            <section aria-labelledby="actions-heading">
              <h2 id="actions-heading" className="text-h3 mb-3 text-text-primary">
                {t("home.quickActions")}
              </h2>
              <QuickActionGrid onAction={() => setCreateOpen(true)} />
            </section>

            <section aria-labelledby="overview-heading">
              <div className="flex items-center gap-2">
                <h2 id="overview-heading" className="text-h3 flex-1 text-text-primary">
                  {t("home.overview")}
                </h2>
                <div
                  role="group"
                  aria-label={t("home.overview")}
                  className="flex rounded-full border border-border-default bg-surface-primary p-0.5"
                >
                  {RANGES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={range === value}
                      onClick={() => setRange(value)}
                      className={`text-caption chip-text rounded-full px-3 py-1.5 ${
                        range === value
                          ? "bg-action-primary text-text-on-action"
                          : "text-text-secondary"
                      }`}
                    >
                      {t(`home.range.${value}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
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

            {!insightDismissed ? (
              <ApsiInsightCard
                title={t("home.apsi.title")}
                body={t("home.apsi.body")}
                onDismiss={() => setInsightDismissed(true)}
              />
            ) : null}
          </div>
        ) : null}
      </main>

      <WorkspaceSwitcherSheet open={switcherOpen} onOpenChange={setSwitcherOpen} />
      <BottomNav workspace="business" onCreate={() => setCreateOpen(true)} />

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
                className="tap-target w-full rounded-xl border border-border-default px-4 text-left text-body"
              >
                {t(`nav.${key}`)}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </div>
  );
}
