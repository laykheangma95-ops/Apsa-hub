/**
 * /app/payments — the merchant's payments operations screen.
 *
 * Answers, in this order and on a 320px phone: what needs my attention, which
 * order is this for, is it actually paid, was anything refunded, and what am I
 * allowed to do about it.
 *
 * ── WHERE THE DATA COMES FROM ────────────────────────────────────────────────
 *
 * Every row is an authoritative Payment record read through
 * listRealPayments -> listPaymentsFn -> src/server/payments/service.ts#listPayments.
 * The organization is resolved from the caller's own DB membership inside that
 * handler and payments.read is required there, so the capability checks on
 * this screen decide what is OFFERED, never what is ALLOWED. There is no mock
 * fallback anywhere in this path: a failure shows as a failure, because
 * inventing a payment row would be inventing money.
 *
 * ── WHAT THIS SCREEN NEVER DOES ──────────────────────────────────────────────
 *
 * It computes no financial fact. It does not sum amounts, does not add USD to
 * KHR, does not derive "paid", and does not infer a refund total. The
 * attention band is the server's own per-currency reconciliation aggregate
 * (payment_reconciliation_summary, migration 034), rendered one currency at a
 * time.
 *
 * Filters are server filters: `status` and `verificationState` are the two
 * dimensions listPaymentsFn accepts, both applied in SQL across the whole
 * organization — never a narrowing of the rows already on screen. See
 * PAYMENT_FILTERS in src/lib/payments.ts for why there is no single
 * "needs review" chip.
 */
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppHeader, BottomNav, Chip, ChipRow, ListSkeleton, ScreenBleed } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import {
  PaymentMethodChip,
  PaymentReviewChip,
  PaymentStatusChip,
  PaymentVerificationChip,
} from "@/components/payments/PaymentStateChips";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getRealPaymentReconciliation, listRealPayments } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import {
  classifyPaymentError,
  findPaymentFilter,
  isFullyRefundedUiPayment,
  paymentAccessDenied,
  paymentNeedsReview,
  PAYMENT_FILTERS,
  reconciliationIsQuiet,
  visiblePaymentRows,
  type PaymentFilterId,
  type UiPayment,
  type UiPaymentReconciliation,
} from "@/lib/payments";

export const Route = createFileRoute("/app/payments")({
  head: () => ({
    meta: [
      { title: "Payments — APSA" },
      {
        name: "description",
        content:
          "Every payment claim in one list — what settled, what was verified, what was refunded and what still needs a decision.",
      },
      { property: "og:title", content: "Payments — APSA" },
      {
        property: "og:description",
        content: "Settlement, verification and refunds for every payment, newest first.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PaymentsListScreen,
});

/** One request per page. The server caps at 200; this stays well inside it. */
const PAGE_SIZE = 30;

/**
 * One payment, scannable in two seconds: how much and in what currency, which
 * order, and its three axes as three separate chips that never merge into one
 * verdict.
 */
function PaymentRow({ payment }: { payment: UiPayment }) {
  const { t } = useTranslation();
  const needsReview = paymentNeedsReview(payment);

  return (
    <Link
      to="/app/payments/$id"
      params={{ id: payment.id }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {/*
         * Amount and currency together, always. $12.50 and 12,500៛ are
         * different amounts and this list mixes both.
         */}
        <span className="text-financial tnum min-w-0 flex-1 text-text-primary">
          {formatMoney(payment.amount)}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(payment.updatedAt)}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="text-caption tnum min-w-0 flex-1 truncate text-text-secondary">
          {t("payments.row.order", { id: payment.orderId.slice(0, 8) })}
        </span>
        <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <PaymentStatusChip status={payment.status} />
        <PaymentVerificationChip state={payment.verificationState} />
        <PaymentMethodChip method={payment.method} />
        {/*
         * `refunded` is the status the ledger sets once the cumulative refund
         * equals the principal, so it means fully refunded and nothing else.
         * A partly refunded payment stays `paid` and is NOT marked here — the
         * list carries no refund total and must not guess. Its detail screen
         * shows every refund event.
         */}
        {isFullyRefundedUiPayment(payment) ? (
          <span className="text-label inline-flex max-w-full items-center rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary">
            <span className="chip-text">{t("payments.row.fullyRefunded")}</span>
          </span>
        ) : null}
        {needsReview ? <PaymentReviewChip /> : null}
      </div>
    </Link>
  );
}

/**
 * The server's own attention aggregate, one band per currency.
 *
 * USD and KHR are never added together — the server returns them as separate
 * entries precisely because APSA has no implicit exchange rate, and this
 * renders them the same way. Only shown to a member with payments.reconcile,
 * which is the permission getPaymentReconciliationFn requires.
 */
function AttentionBand({ summary }: { summary: UiPaymentReconciliation }) {
  const { t } = useTranslation();

  if (reconciliationIsQuiet(summary)) return null;

  const entries: Array<{ key: string; label: string; count: number; amount: string }> = [];
  if (summary.needsReview.count > 0) {
    entries.push({
      key: "needsReview",
      label: t("payments.attention.needsReview"),
      count: summary.needsReview.count,
      amount: formatMoney(summary.needsReview.amount),
    });
  }
  if (summary.mismatch.count > 0) {
    entries.push({
      key: "mismatch",
      label: t("payments.verification.mismatch"),
      count: summary.mismatch.count,
      amount: formatMoney(summary.mismatch.amount),
    });
  }
  if (summary.duplicateSuspected.count > 0) {
    entries.push({
      key: "duplicate",
      label: t("payments.verification.duplicate_suspected"),
      count: summary.duplicateSuspected.count,
      amount: formatMoney(summary.duplicateSuspected.amount),
    });
  }
  if (summary.codUnsettled.count > 0) {
    entries.push({
      key: "cod",
      label: t("payments.attention.codUnsettled"),
      count: summary.codUnsettled.count,
      amount: formatMoney(summary.codUnsettled.amount),
    });
  }

  return (
    <section
      className="rounded-2xl border border-border-default bg-surface-primary px-4 py-3"
      aria-label={t("payments.attention.currencyLabel", { currency: summary.currency })}
    >
      <h2 className="text-label flex items-center gap-1.5 text-text-secondary">
        <AlertTriangle className="size-3.5 shrink-0 text-status-warning-text" aria-hidden />
        <span className="chip-text">
          {t("payments.attention.currencyLabel", { currency: summary.currency })}
        </span>
      </h2>
      <dl className="mt-2 flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={entry.key} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="text-body-sm min-w-0 text-text-secondary">
              <span className="chip-text">{entry.label}</span>
            </dt>
            <dd className="text-body-sm tnum shrink-0 text-text-primary">
              {t("payments.attention.entry", { count: entry.count, amount: entry.amount })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PaymentsListScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const detailOpen = pathname !== "/app/payments" && pathname.startsWith("/app/payments/");

  /*
   * Identity for the payments cache comes from the /app route guard's own
   * server-derived context (validated session + DB membership), never from
   * the capability snapshot, which is presentation data fetched on a separate
   * request. It must include the user and not only the organization: two
   * members of the same organization can hold different payments.* grants
   * (payments.view_provider_reference in particular changes what the SERVER
   * returns in `reference` and `note`), so an organization-only key would let
   * one member's cached payment rows be read back for the next member who
   * signs in to the same tab.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Fail closed rather than key a request under a shared placeholder: if the
   * route's identity is incomplete, or the capability snapshot's resolved
   * organization has diverged from the route's (a stale snapshot mid an
   * organization switch), nothing is fetched and nothing is offered.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  // listPayments requires payments.read; getReconciliationSummary requires
  // payments.reconcile (src/server/payments/service.ts, reconciliation.ts).
  const canReadPayments = identityOk && capabilities.can("payments.read");
  // Reconciliation amounts are a disclosure in themselves, so they ride on
  // canSensitive: never drawn from a snapshot the server has not just
  // confirmed (see CapabilityView.canSensitive).
  const canReconcile = identityOk && capabilities.canSensitive("payments.reconcile");

  const [filterId, setFilterId] = useState<PaymentFilterId>("all");
  const activeFilter = findPaymentFilter(filterId);

  const paymentsQuery = useInfiniteQuery({
    queryKey: [
      "payments",
      userId,
      routeOrganizationId,
      "list",
      activeFilter.status ?? null,
      activeFilter.verificationState ?? null,
    ],
    queryFn: ({ pageParam }) =>
      listRealPayments({
        status: activeFilter.status,
        verificationState: activeFilter.verificationState,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((total, page) => total + page.items.length, 0) : undefined,
    enabled: !detailOpen && canReadPayments,
  });

  const reconciliationQuery = useQuery({
    queryKey: ["payments", userId, routeOrganizationId, "reconciliation"],
    queryFn: () => getRealPaymentReconciliation(),
    enabled: !detailOpen && canReconcile,
  });

  const errorKind = paymentsQuery.isError ? classifyPaymentError(paymentsQuery.error) : null;

  /*
   * Cached rows are read through visiblePaymentRows, never off
   * paymentsQuery.data directly.
   *
   * React Query retains the last successful pages when a refetch fails, which
   * is right for a blip and wrong for a 403: a member whose payments.read was
   * revoked, whose membership ended, or whose session died would otherwise go
   * on reading real amounts, order ids and verification states under a
   * "you don't have access" panel until something invalidated the cache. The
   * mask is synchronous — it takes effect on this render, with no refetch and
   * no invalidation — and it is narrow: only forbidden and unauthorized
   * withhold, so an ordinary transient failure still shows the rows the
   * server really did send alongside its retry affordance.
   */
  const listDenied = paymentAccessDenied(errorKind);

  const items = useMemo(
    () =>
      visiblePaymentRows(
        paymentsQuery.data?.pages.flatMap((page) => page.items),
        errorKind,
      ),
    [paymentsQuery.data, errorKind],
  );

  /*
   * Reconciliation is a separate request with a separate permission
   * (payments.reconcile) and so a separate denial: its aggregate amounts are
   * a disclosure in their own right and are withheld on their own 403, even
   * while the list itself is still readable.
   */
  const reconciliationErrorKind = reconciliationQuery.isError
    ? classifyPaymentError(reconciliationQuery.error)
    : null;

  useEffect(() => {
    if (errorKind === "unauthorized") void navigate({ to: "/sign-in" });
  }, [errorKind, navigate]);

  if (detailOpen) return <Outlet />;

  /*
   * No payments.read: the screen shows only that the member does not have it.
   * Not the filters, not a count, not the attention band — a denial must not
   * describe the data behind it.
   */
  if (!canReadPayments) {
    return (
      <ScreenBleed bottom="nav" surface="raised">
        <AppHeader title={t("payments.list.title")} subtitle={t("payments.list.subtitle")} />
        <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
          <CapabilityDeniedState capabilities={capabilities} />
        </main>
        <BottomNav />
      </ScreenBleed>
    );
  }

  if (errorKind === "unauthorized") return null; // redirecting, see the effect above

  const showEmpty = paymentsQuery.isSuccess && items.length === 0;
  const summaries = visiblePaymentRows(reconciliationQuery.data, reconciliationErrorKind);
  const loudSummaries = summaries.filter((summary) => !reconciliationIsQuiet(summary));

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("payments.list.title")} subtitle={t("payments.list.subtitle")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <div className="flex flex-col gap-3">
          {canReconcile && loudSummaries.length > 0 ? (
            <div className="flex flex-col gap-2">
              {loudSummaries.map((summary) => (
                <AttentionBand key={summary.currency} summary={summary} />
              ))}
              <p className="text-caption px-1 text-text-secondary">
                {t("payments.attention.separateCurrencies")}
              </p>
            </div>
          ) : null}

          <ChipRow label={t("payments.filters.label")} role="tablist">
            {PAYMENT_FILTERS.map((filter) => (
              <Chip
                key={filter.id}
                role="tab"
                selected={filter.id === filterId}
                onClick={() => setFilterId(filter.id)}
              >
                {t(filter.labelKey)}
              </Chip>
            ))}
          </ChipRow>

          {/*
           * Said plainly: these chips are server filters over the whole
           * organization, and there is no combined "needs review" chip
           * because the list endpoint cannot express that union.
           */}
          <p className="text-caption px-1 text-text-secondary" role="note">
            {t("payments.list.filterScope")}
          </p>

          <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
            {paymentsQuery.isLoading ? <ListSkeleton rows={6} /> : null}

            {errorKind ? (
              <OperationalState
                tone="danger"
                title={
                  errorKind === "forbidden"
                    ? t("payments.list.forbidden.title")
                    : t("payments.list.error.title")
                }
                body={
                  errorKind === "forbidden"
                    ? t("payments.list.forbidden.body")
                    : t("payments.list.error.body")
                }
                {...(errorKind === "forbidden"
                  ? {}
                  : { onRetry: () => void paymentsQuery.refetch() })}
                className="rounded-none border-0"
              />
            ) : null}

            {showEmpty ? (
              <OperationalState
                title={
                  filterId === "all"
                    ? t("payments.list.empty.title")
                    : t("payments.list.emptyFilter.title")
                }
                body={
                  filterId === "all"
                    ? t("payments.list.empty.body")
                    : t("payments.list.emptyFilter.body")
                }
                className="rounded-none border-0"
              />
            ) : null}

            {items.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </div>

          {/*
           * The list is never silently capped: while another page exists the
           * merchant is told so and can load it, and when the button is gone
           * the list really is the end of the filtered set.
           */}
          {paymentsQuery.hasNextPage && !listDenied ? (
            <Button
              variant="ghost"
              className="tap-target h-11 w-full"
              disabled={paymentsQuery.isFetchingNextPage}
              onClick={() => void paymentsQuery.fetchNextPage()}
            >
              {paymentsQuery.isFetchingNextPage
                ? t("payments.list.loadingMore")
                : t("payments.list.loadMore")}
            </Button>
          ) : null}

          {items.length > 0 ? (
            <p className="text-caption px-1 pb-2 text-text-secondary" role="note">
              {t("payments.list.partialRefundNote")}
            </p>
          ) : null}
        </div>
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
