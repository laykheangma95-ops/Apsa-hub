import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getHomeSummary } from "@/lib/api";
import { homeQueryKey } from "@/lib/home-query";
import { attentionNoticeKey, homeAttentionItems } from "@/lib/home-attention";
import { formatMoney } from "@/lib/money";
import {
  AppHeader,
  AttentionCard,
  BottomNav,
  BottomSheet,
  ErrorState,
  HomeSkeleton,
  MetricTile,
  QuickActionGrid,
  visibleQuickActions,
  ScreenBleed,
  SegmentedControl,
  type QuickActionId,
  type Segment,
} from "@/design-system";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useTabScrollMemory, useTabState } from "@/hooks/use-tab-memory";
import { todayLabel } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import type { UiPermissionKey } from "@/lib/capabilities";
import type { AttentionItem, HomeSummary, Metric, MetricRange } from "@/types";

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

const RANGES: MetricRange[] = ["today", "week", "month"];

const ATTENTION_ROUTE: Partial<
  Record<AttentionItem["id"], "/app/inbox" | "/app/orders" | "/app/deliveries">
> = {
  unread_conversations: "/app/inbox",
  awaiting_payment: "/app/orders",
  payments_needing_review: "/app/orders",
  awaiting_delivery: "/app/deliveries",
  orders_needing_action: "/app/orders",
};

/**
 * The permission each attention destination needs — the same key its screen
 * and its server functions require. A member without it still sees the count
 * (it is their own organization's work), but the row stops pretending to be a
 * link to somewhere they cannot go.
 */
const ATTENTION_PERMISSION: Record<
  "/app/inbox" | "/app/orders" | "/app/deliveries",
  UiPermissionKey
> = {
  "/app/inbox": "messages.read",
  "/app/orders": "orders.read",
  "/app/deliveries": "orders.read",
};

function metricItems(summary: HomeSummary): Metric[] {
  const metrics: Metric[] = [];
  if (summary.orders.status === "available") {
    metrics.push(
      {
        id: "orders",
        value: String(summary.orders.data.periodCount),
        deltaPercent: null,
        series: [],
      },
      {
        id: "awaiting_payment",
        value: String(summary.orders.data.awaitingPaymentCount),
        deltaPercent: null,
        series: [],
      },
    );
  }
  if (summary.payments.status === "available") {
    metrics.push({
      id: "payments_needing_review",
      value: String(summary.payments.data.needsReviewCount),
      deltaPercent: null,
      series: [],
    });
  }
  if (summary.delivery.status === "available") {
    metrics.push({
      id: "delivery_actions",
      value: String(summary.delivery.data.actionCount),
      deltaPercent: null,
      series: [],
    });
  }
  if (summary.inventory.status === "available") {
    metrics.push({
      id: "low_stock",
      value: String(summary.inventory.data.outOfStockVariantCount),
      deltaPercent: null,
      series: [],
    });
  }
  return metrics;
}

function BusinessHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const { language } = useLanguage();
  const { session, organizationId } = Route.useRouteContext();
  /* The chosen period survives a trip to another tab — see src/lib/tab-memory.ts. */
  const [range, setRange] = useTabState<MetricRange>("home", "range", "today");
  const [createOpen, setCreateOpen] = useState(false);

  useTabScrollMemory("home");

  /*
   * The date comes from the merchant's own clock, so it is rendered after
   * mount rather than during SSR — the server sits in a different timezone,
   * and a date is exactly the kind of string that would hydrate wrong on the
   * one night of the year it matters.
   */
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => setToday(todayLabel(language)), [language]);

  const homeQuery = useQuery({
    queryKey: homeQueryKey(session.userId, organizationId, range),
    queryFn: () => getHomeSummary(range),
  });

  const summary = homeQuery.data;
  const attention = summary ? homeAttentionItems(summary) : [];
  const metrics = summary ? metricItems(summary) : [];
  // An empty attention list is only reassuring when Home actually knows the
  // list is empty. Anything less says so rather than implying a settled zero.
  const noticeKey = summary ? attentionNoticeKey(summary, attention.length) : null;

  const rangeSegments: Segment<MetricRange>[] = RANGES.map((value) => ({
    value,
    label: t(`home.range.${value}`),
  }));

  /*
   * Each starting point is keyed to the permission its destination actually
   * needs server-side. "Send invoice" has no backend yet and opens an honest
   * "not built" sheet for everyone, so there is no permission to key it to.
   */
  const quickActionsAvailable: Partial<Record<QuickActionId, boolean>> = {
    receivePayment: capabilities.can("orders.create"),
    newOrder: capabilities.can("orders.read"),
    addProduct: capabilities.can("products.create"),
  };

  // A heading with nothing under it is worse than no section.
  const hasQuickActions = visibleQuickActions(quickActionsAvailable).length > 0;

  function handleQuickAction(id: QuickActionId) {
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
      <AppHeader title={t("brand.name")} action={null}>
        <div className="pb-1">
          <h1 className="text-h1 text-text-primary">{t("home.greeting")}</h1>
          <p className="text-body-sm text-text-secondary">
            {today ? `${today} · ` : ""}
            {t("home.subtitle")}
          </p>
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

        {summary ? (
          <div className="content-in stack-section screen-gutter pt-4">
            <section aria-labelledby="attention-heading">
              <h2 id="attention-heading" className="text-label px-1 text-text-secondary">
                {t("home.attention")}
              </h2>
              {attention.length > 0 ? (
                <div className="list-enter mt-2 grid gap-2 sm:grid-cols-2">
                  {attention.map((item) => {
                    const route = ATTENTION_ROUTE[item.id];
                    const to =
                      route && capabilities.can(ATTENTION_PERMISSION[route]) ? route : undefined;
                    return (
                      <AttentionCard
                        key={item.id}
                        item={item}
                        onClick={to ? () => void navigate({ to }) : undefined}
                      />
                    );
                  })}
                </div>
              ) : null}
              {noticeKey ? (
                <p className="mt-2 px-1 text-body-sm text-text-secondary">{t(noticeKey)}</p>
              ) : null}
            </section>

            <section aria-labelledby="overview-heading" className="stack-group">
              <h2 id="overview-heading" className="text-label px-1 text-text-secondary">
                {t("home.overview")}
              </h2>

              <SegmentedControl
                segments={rangeSegments}
                value={range}
                onChange={setRange}
                label={t("home.overview")}
              />

              {summary.finance.status === "available" ? (
                <section className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
                  <p className="text-label text-text-secondary">{t("home.revenue")}</p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {summary.finance.data.netCollectedForCreatedOrders.length > 0 ? (
                      summary.finance.data.netCollectedForCreatedOrders.map((amount) => (
                        <p
                          key={amount.currency}
                          className="text-financial-lg min-w-0 text-text-primary"
                        >
                          {formatMoney(amount)}
                        </p>
                      ))
                    ) : (
                      <p className="text-body-sm text-text-secondary">{t("home.noSettledSales")}</p>
                    )}
                  </div>
                </section>
              ) : (
                <p className="px-1 text-body-sm text-text-secondary">
                  {t(
                    summary.finance.status === "permission_denied"
                      ? "home.financialsUnavailable"
                      : "home.financialsError",
                  )}
                </p>
              )}

              {metrics.length > 0 ? (
                <div className="list-enter grid grid-cols-2 gap-2">
                  {metrics.map((metric) => (
                    <MetricTile
                      key={metric.id}
                      label={t(`home.metrics.${metric.id}`)}
                      value={metric.value}
                      deltaPercent={metric.deltaPercent}
                      series={metric.series}
                    />
                  ))}
                </div>
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
            </section>

            {hasQuickActions ? (
              <section aria-labelledby="actions-heading" className="stack-group">
                <h2 id="actions-heading" className="text-label px-1 text-text-secondary">
                  {t("home.quickActions")}
                </h2>
                <QuickActionGrid onAction={handleQuickAction} available={quickActionsAvailable} />
              </section>
            ) : null}
          </div>
        ) : null}
      </main>

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
