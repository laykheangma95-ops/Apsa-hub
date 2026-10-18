import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonBlock } from "@/design-system";
import type { HomeFinanceAccess } from "@/lib/home-query";
import type { HomeSummaryView } from "@/lib/home-summary-view";
import { formatMoney } from "@/lib/money";

interface TodaySalesCardProps {
  /** Today's view from resolveHomeSummaryView — the only gate on what may show. */
  view: HomeSummaryView;
  /**
   * resolveHomeFinanceAccess — whether money the summary carries may be drawn
   * NOW. The server's section status says what it returned; this says whether
   * access is still confirmed. Both must hold.
   */
  financeAccess: HomeFinanceAccess;
  /**
   * The server's first confirmation of a seeded snapshot is still on its way
   * (useSensitiveCapabilityFreshness → "confirming"): no money yet, but a
   * placeholder rather than "unavailable".
   */
  financeConfirming?: boolean;
  onRetry: () => void;
  /** analytics.read — Week and Month live on Analytics, not here. */
  analyticsAvailable: boolean;
}

/**
 * Today, at a glance: what was collected and how many orders came in.
 *
 * The amount is Home's existing figure, unchanged — net collected for orders
 * CREATED today (getNetCollectedForCreatedOrders), behind the same finance
 * gate (orders.read AND payments.reconcile, enforced by the server; a member
 * without it gets permission_denied, never a number). The caption under it
 * says exactly that, so "sales" is never read as something it is not.
 *
 * One line per currency, each formatted in its own minor units: USD and KHR
 * are never added together or converted here.
 *
 * Every state keeps the same three rows — label, value, caption — so the card
 * is the same height loading as loaded, and the tiles under it never jump.
 */
export function TodaySalesCard({
  view,
  financeAccess,
  financeConfirming = false,
  onRetry,
  analyticsAvailable,
}: TodaySalesCardProps) {
  const { t } = useTranslation();
  const summary = view.kind === "ready" ? view.summary : null;
  const finance = summary && financeAccess === "granted" ? summary.finance : null;
  const financeShown = finance?.status === "available";

  return (
    <section
      aria-labelledby="today-heading"
      aria-busy={view.kind === "loading" ? true : undefined}
      className="summary-glass rounded-2xl px-4 pt-2.5 pb-3"
    >
      <div className="flex min-h-9 items-center gap-2">
        <h2 id="today-heading" className="text-label min-w-0 flex-1 text-text-secondary">
          {t("home.today.title")}
        </h2>
        {analyticsAvailable ? (
          <Link
            to="/app/analytics"
            aria-label={t("home.today.analyticsLabel")}
            className="press tap-target text-label -my-1.5 -mr-2 inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 text-action-primary"
          >
            {t("home.today.analytics")}
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/*
         * A zero-width strut: the row is always one money line tall, in either
         * script. -mr-3 cancels the row's column gap after it, so the amount
         * lines up with the card's label instead of starting 12px in.
         */}
        <span aria-hidden className="text-financial-lg invisible -mr-3 w-0 overflow-hidden">
          0
        </span>

        {view.kind === "loading" ? (
          <>
            <SkeletonBlock className="h-7 w-32 rounded-lg" />
            <span className="flex-1" />
            <SkeletonBlock className="h-6 w-16 rounded-full" />
          </>
        ) : null}

        {view.kind === "error" ? (
          <div role="status" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
            <p className="text-body-sm min-w-0 flex-1 text-text-secondary">
              {t("home.error.title")}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="press tap-target text-label -my-1.5 shrink-0 rounded-full px-3 text-action-primary underline underline-offset-2"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}

        {summary ? (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
              {finance?.status === "available" ? (
                finance.data.netCollectedForCreatedOrders.length > 0 ? (
                  finance.data.netCollectedForCreatedOrders.map((amount) => (
                    <p key={amount.currency} className="text-financial-lg text-text-primary">
                      {formatMoney(amount)}
                    </p>
                  ))
                ) : (
                  <p className="text-body-sm text-text-secondary">{t("home.today.none")}</p>
                )
              ) : financeConfirming ? (
                <SkeletonBlock className="h-7 w-32 rounded-lg" />
              ) : (
                <p className="text-body-sm text-text-secondary">
                  {t(
                    financeAccess === "denied" || summary.finance.status === "permission_denied"
                      ? "home.financialsUnavailable"
                      : "home.financialsError",
                  )}
                </p>
              )}
            </div>
            {summary.orders.status === "available" ? (
              <p className="text-label tnum shrink-0 rounded-full bg-action-primary-soft px-2.5 py-1 text-action-primary">
                {t("home.today.orders", { count: summary.orders.data.periodCount })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {/* The definition of the number — shown with the number, held in place otherwise. */}
      <p
        aria-hidden={financeShown ? undefined : true}
        className={
          financeShown
            ? "text-caption mt-0.5 text-text-muted"
            : "text-caption invisible mt-0.5 text-text-muted"
        }
      >
        {t("home.today.definition")}
      </p>
    </section>
  );
}
