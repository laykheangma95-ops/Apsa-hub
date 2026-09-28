import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  BottomNav,
  ErrorState,
  ScreenBleed,
  Section,
  SectionRow,
  SectionRows,
  SegmentedControl,
  SkeletonBlock,
  type Segment,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  getAnalyticsBusinessSummary,
  getAnalyticsCustomerSummary,
  getAnalyticsTopSellers,
} from "@/lib/api";
import { analyticsKeys } from "@/lib/analytics-query";
import {
  ANALYTICS_RANGES,
  ANALYTICS_TOP_SELLER_LIMIT,
  averageOrderValue,
  analyticsPeriodDays,
  financeUnavailableKey,
  isEmptyPeriod,
  repeatRatePercent,
  resolveAnalyticsSection,
  type CalendarDay,
} from "@/lib/analytics-view";
import { formatMoney } from "@/lib/money";
import type { MetricRange, Money } from "@/types";

export const Route = createFileRoute("/app/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — APSA" },
      {
        name: "description",
        content: "Sales, collection, top sellers and customers for today, this week or this month.",
      },
      { property: "og:title", content: "Analytics — APSA" },
      { property: "og:description", content: "How the business is doing, in plain numbers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalyticsScreen,
});

/**
 * One amount per currency, never summed across currencies — the server keeps
 * USD and KHR apart (no FX anywhere in Analytics), and so does the screen.
 */
function MoneyLines({ amounts }: { amounts: readonly Money[] }) {
  if (amounts.length === 0) return <span className="tnum">—</span>;
  return (
    <span className="flex flex-col items-end">
      {amounts.map((amount) => (
        <span key={amount.currency} className="text-financial tnum">
          {formatMoney(amount)}
        </span>
      ))}
    </span>
  );
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="text-caption mt-3 text-text-secondary">{children}</p>;
}

function SectionSkeleton() {
  return (
    <div aria-hidden className="space-y-2">
      <SkeletonBlock className="h-5 w-2/3" />
      <SkeletonBlock className="h-5 w-1/2" />
      <SkeletonBlock className="h-5 w-3/5" />
    </div>
  );
}

function AnalyticsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();

  /*
   * Cache identity from the /app route guard's server-derived context. The
   * keys live under Home's root (src/lib/analytics-query.ts), so a change of
   * signed-in member or organization drops them before this screen renders,
   * and every commerce write that refreshes Home refreshes these too.
   */
  const { session, organizationId } = Route.useRouteContext();
  const userId = session.userId;

  // Every src/server/analytics/service.ts export requires analytics.read.
  const canRead = capabilities.can("analytics.read");
  const [range, setRange] = useState<MetricRange>("today");

  const summaryQuery = useQuery({
    queryKey: analyticsKeys.summary(userId, organizationId, range),
    queryFn: () => getAnalyticsBusinessSummary(range),
    enabled: canRead,
  });
  const topSellersQuery = useQuery({
    queryKey: analyticsKeys.topSellers(userId, organizationId, range, ANALYTICS_TOP_SELLER_LIMIT),
    queryFn: () => getAnalyticsTopSellers(range, ANALYTICS_TOP_SELLER_LIMIT),
    enabled: canRead,
  });
  const customersQuery = useQuery({
    queryKey: analyticsKeys.customers(userId, organizationId, range),
    queryFn: () => getAnalyticsCustomerSummary(range),
    enabled: canRead,
  });

  // Only data fetched FOR the selected range is ever shown under its label.
  const summaryView = resolveAnalyticsSection({
    range,
    data: summaryQuery.data,
    isError: summaryQuery.isError,
    error: summaryQuery.error,
  });
  const topSellersView = resolveAnalyticsSection({
    range,
    data: topSellersQuery.data,
    isError: topSellersQuery.isError,
    error: topSellersQuery.error,
  });
  const customersView = resolveAnalyticsSection({
    range,
    data: customersQuery.data,
    isError: customersQuery.isError,
    error: customersQuery.error,
  });

  const unauthorized = [summaryView, topSellersView, customersView].some(
    (view) => view.kind === "error" && view.error === "unauthorized",
  );
  useEffect(() => {
    if (unauthorized) void navigate({ to: "/sign-in" });
  }, [unauthorized, navigate]);

  const header = <AppHeader title={t("analytics.title")} subtitle={t("analytics.subtitle")} />;
  const shell = (content: ReactNode) => (
    <ScreenBleed bottom="nav" surface="raised">
      {header}
      <main className="mx-auto w-full max-w-[var(--screen-max)] space-y-4 px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {content}
      </main>
      <BottomNav />
    </ScreenBleed>
  );

  if (capabilities.state === "pending") return shell(<SectionSkeleton />);
  if (!canRead) return shell(<CapabilityDeniedState capabilities={capabilities} />);
  if (unauthorized) return null; // redirecting, see the effect above

  const rangeSegments: Segment<MetricRange>[] = ANALYTICS_RANGES.map((value) => ({
    value,
    label: t(`analytics.range.${value}`),
  }));
  const formatDay = (date: CalendarDay) =>
    t("analytics.date", {
      day: date.day,
      month: t(`analytics.months.${date.month}`),
      year: date.year,
    });
  const periodText = (from: string, until: string) => {
    const { first, last } = analyticsPeriodDays(from, until);
    return last ? `${formatDay(first)} – ${formatDay(last)}` : formatDay(first);
  };

  let body: ReactNode;
  if (summaryView.kind === "loading") {
    body = (
      <div aria-hidden className="space-y-3">
        <SkeletonBlock className="h-[132px] w-full rounded-2xl" />
        <SkeletonBlock className="h-[132px] w-full rounded-2xl" />
      </div>
    );
  } else if (summaryView.kind === "error") {
    body =
      summaryView.error === "forbidden" ? (
        <OperationalState title={t("capability.denied.title")} body={t("capability.denied.body")} />
      ) : (
        <ErrorState
          title={t("analytics.error.title")}
          body={t("analytics.error.body")}
          onRetry={() => void summaryQuery.refetch()}
        />
      );
  } else if (isEmptyPeriod(summaryView)) {
    body = <OperationalState title={t("analytics.empty.title")} body={t("analytics.empty.body")} />;
  } else {
    const summary = summaryView.data;
    const finance = summary.finance;
    const average = averageOrderValue(summary);

    body = (
      <>
        <Section title={t("analytics.sales.title")}>
          <SectionRows>
            <SectionRow
              label={t("analytics.sales.orders")}
              value={<span className="text-financial tnum">{summary.orderCount}</span>}
            />
            <SectionRow
              label={t("analytics.sales.gross")}
              value={
                finance.status === "available" ? (
                  <MoneyLines amounts={finance.data.orderedGross} />
                ) : (
                  <span className="text-body-sm text-text-secondary">
                    {t(financeUnavailableKey(finance.status))}
                  </span>
                )
              }
            />
            {finance.status === "available" ? (
              <SectionRow
                label={t("analytics.sales.average")}
                value={
                  average ? (
                    <span className="text-financial tnum">{formatMoney(average)}</span>
                  ) : (
                    <span className="text-body-sm text-text-secondary">
                      {t("analytics.sales.averageMixed")}
                    </span>
                  )
                }
              />
            ) : null}
          </SectionRows>
          <Footnote>{t("analytics.sales.note")}</Footnote>
        </Section>

        <Section title={t("analytics.collection.title")}>
          {finance.status === "available" ? (
            <>
              <SectionRows>
                <SectionRow
                  label={t("analytics.collection.collected")}
                  value={<MoneyLines amounts={finance.data.collectedGross} />}
                />
                <SectionRow
                  label={t("analytics.collection.outstanding")}
                  value={<MoneyLines amounts={finance.data.outstandingAmount} />}
                />
                <SectionRow
                  label={t("analytics.collection.refunded")}
                  value={<MoneyLines amounts={finance.data.refundedAmount} />}
                />
              </SectionRows>
              <Footnote>{t("analytics.collection.note")}</Footnote>
            </>
          ) : (
            <p className="text-body-sm text-text-secondary">
              {t(financeUnavailableKey(finance.status))}
            </p>
          )}
        </Section>

        <Section title={t("analytics.topSellers.title")}>
          {topSellersView.kind === "loading" ? (
            <SectionSkeleton />
          ) : topSellersView.kind === "error" ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-body-sm text-status-danger-text">
                {topSellersView.error === "forbidden"
                  ? t("capability.denied.title")
                  : t("analytics.sectionError")}
              </p>
              {topSellersView.error === "forbidden" ? null : (
                <button
                  type="button"
                  className="text-label tap-target text-action-primary"
                  onClick={() => void topSellersQuery.refetch()}
                >
                  {t("common.retry")}
                </button>
              )}
            </div>
          ) : topSellersView.data.items.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("analytics.topSellers.empty")}</p>
          ) : (
            <>
              <ol className="divide-y divide-border-default">
                {topSellersView.data.items.map((item, index) => (
                  <li
                    key={`${item.productId}:${item.variantId}:${item.currency}`}
                    className="flex min-w-0 items-start gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="text-label tnum w-5 shrink-0 text-text-muted">
                      {index + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body-sm min-w-0 break-words text-text-primary">
                        {item.displayLabel}
                      </span>
                      <span className="text-caption tnum text-text-secondary">
                        {t("analytics.topSellers.sold", { count: item.quantitySold })}
                      </span>
                    </span>
                    {item.grossAmount !== null ? (
                      <span className="text-financial tnum shrink-0 text-text-primary">
                        {formatMoney({ amount: item.grossAmount, currency: item.currency })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
              <Footnote>{t("analytics.topSellers.note")}</Footnote>
            </>
          )}
        </Section>

        <Section title={t("analytics.customers.title")}>
          {customersView.kind === "loading" ? (
            <SectionSkeleton />
          ) : customersView.kind === "error" ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-body-sm text-status-danger-text">
                {customersView.error === "forbidden"
                  ? t("capability.denied.title")
                  : t("analytics.sectionError")}
              </p>
              {customersView.error === "forbidden" ? null : (
                <button
                  type="button"
                  className="text-label tap-target text-action-primary"
                  onClick={() => void customersQuery.refetch()}
                >
                  {t("common.retry")}
                </button>
              )}
            </div>
          ) : (
            <>
              <SectionRows>
                <SectionRow
                  label={t("analytics.customers.total")}
                  value={<span className="tnum">{customersView.data.totalCustomers}</span>}
                />
                <SectionRow
                  label={t("analytics.customers.new")}
                  value={<span className="tnum">{customersView.data.newCustomers}</span>}
                />
                <SectionRow
                  label={t("analytics.customers.returning")}
                  value={<span className="tnum">{customersView.data.repeatCustomers}</span>}
                />
                <SectionRow
                  label={t("analytics.customers.repeatRate")}
                  value={
                    <span className="tnum">
                      {(() => {
                        const rate = repeatRatePercent(customersView.data.repeatOrderRate);
                        return rate === null
                          ? "—"
                          : t("analytics.customers.percent", { value: rate });
                      })()}
                    </span>
                  }
                />
                <SectionRow
                  label={t("analytics.customers.walkIn")}
                  value={<span className="tnum">{customersView.data.unattributedOrderCount}</span>}
                />
              </SectionRows>
              <Footnote>{t("analytics.customers.note")}</Footnote>
            </>
          )}
        </Section>
      </>
    );
  }

  return shell(
    <>
      <SegmentedControl
        segments={rangeSegments}
        value={range}
        onChange={setRange}
        label={t("analytics.range.label")}
      />
      <p className="text-caption px-1 text-text-secondary">
        {summaryView.kind === "ready"
          ? t("analytics.period", {
              period: periodText(summaryView.data.from, summaryView.data.until),
            })
          : t("analytics.periodPending")}
      </p>
      <div aria-live="polite" className="space-y-4">
        {body}
      </div>
    </>,
  );
}
