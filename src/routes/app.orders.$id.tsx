import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  ChannelBadge,
  DetailSkeleton,
  InlineAction,
  Money as MoneyText,
  Screen,
  SecondaryAction,
  Section,
  SectionRow,
  SectionRows,
  Spinner,
  StatusChip,
  StatusHero,
  StickyActionBar,
  Timeline,
  type TimelineItem,
} from "@/design-system";

import { OperationalState } from "@/components/common/OperationalState";
import { CancelOrderSheet } from "@/components/orders/CancelOrderSheet";
import {
  RecordOrderPaymentSheet,
  type RecordOrderPaymentSubmit,
} from "@/components/orders/RecordOrderPaymentSheet";
import { CreateDeliverySheet } from "@/components/delivery/CreateDeliverySheet";
import {
  PaymentMethodChip,
  PaymentReviewChip,
  PaymentStatusChip,
  PaymentVerificationChip,
} from "@/components/payments/PaymentStateChips";
import {
  ArrangeDeliverySheet,
  RecordPaymentSheet,
  RefundSheet,
  ReturnSheet,
} from "@/components/orders/OrderActionSheets";
import {
  arrangeDelivery,
  cancelRealOrder,
  confirmRealOrder,
  createRefund,
  createReturn,
  getCouriers,
  getOrderDetail,
  getRealOrderDetail,
  getRealOrderSettlement,
  isProductionId,
  listRealDeliveriesForOrder,
  listRealPayments,
  recordPayment,
  recordRealPayment,
  PERMISSION_DENIED,
} from "@/lib/api";
import {
  canCancelOrder,
  canConfirmOrder,
  classifyOrderError,
  isChannelSource,
  totalStockUnits,
  type OrderErrorKind,
} from "@/lib/orders";
import { canCreateDeliveryForOrder, isActiveDeliveryStatus } from "@/lib/deliveries";
import {
  classifyPaymentError,
  paymentErrorKey,
  paymentNeedsReview,
  type UiPayment,
  type UiOrderSettlement,
} from "@/lib/payments";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { fullTimestamp, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { addMoney, formatMoney, subtractMoney, usd } from "@/lib/money";
import { useCapabilities } from "@/hooks/use-capabilities";
import { cn } from "@/lib/utils";
import type { OrderEvent, PaymentRecord } from "@/types";

export const Route = createFileRoute("/app/orders/$id")({
  head: () => ({
    meta: [
      { title: "Order detail — APSA" },
      {
        name: "description",
        content:
          "See the full story of one order: items, money, payment, delivery and every step that happened.",
      },
      { property: "og:title", content: "Order detail — APSA" },
      {
        property: "og:description",
        content: "Items, payment, delivery and history for a single order.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OrderDetailRoute,
});

/**
 * Boundary between the two Order UIs. Production orders (real UUIDs, created
 * via createRealOrder / the production Order domain) render RealOrderDetailScreen.
 * Everything else (mock ids like "ord-1" from the Inbox/POS mock flows) keeps
 * the existing mock-backed screen exactly as it was — see the mock boundary
 * note on isProductionId in src/lib/api/index.ts.
 */
function OrderDetailRoute() {
  const { id } = Route.useParams();
  return isProductionId(id) ? <RealOrderDetailScreen id={id} /> : <MockOrderDetailScreen id={id} />;
}

/** Translated title/body for one classified order error. Never surfaces err.message. */
function useOrderErrorCopy() {
  const { t } = useTranslation();
  return (kind: OrderErrorKind): { title: string; body: string } => {
    switch (kind) {
      case "forbidden":
        return { title: t("order.denied"), body: t("order.deniedBody") };
      case "not_found":
        return { title: t("order.notFound"), body: t("order.notFoundBody") };
      case "stale":
        return { title: t("order.error.stale.title"), body: t("order.error.stale.body") };
      case "invalid":
        return { title: t("order.error.invalid.title"), body: t("order.error.invalid.body") };
      default:
        // "unauthorized" redirects to sign-in before this is ever rendered;
        // "server_error" (and any unclassified case) gets the generic copy —
        // never the raw error message.
        return { title: t("error.title"), body: t("error.body") };
    }
  };
}

/**
 * One page of this order's payments. A real order accrues a handful of them at
 * most (a deposit, a balance, a correction), so one page is normally the whole
 * truth — and when it is not, `hasMore` is said out loud rather than presenting
 * a capped list as complete.
 */
const PAYMENTS_PER_ORDER = 20;

/**
 * One payment claim against this order, as a link into the Payments workspace
 * where it is confirmed, verified, refunded or reversed.
 *
 * Three chips, never one verdict: settlement status, verification state and
 * method stay separate axes exactly as they do on /app/payments. This row
 * derives nothing — every value is the server's.
 */
function OrderPaymentRow({ payment }: { payment: UiPayment }) {
  const { t } = useTranslation();

  return (
    <Link
      to="/app/payments/$id"
      params={{ id: payment.id }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default py-2.5 text-left last:border-b-0 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {/* Amount and currency together, always: $12.50 and 12,500៛ differ. */}
        <span className="text-financial tnum min-w-0 flex-1 text-text-primary">
          {formatMoney(payment.amount)}
        </span>
        <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <PaymentStatusChip status={payment.status} />
        <PaymentVerificationChip state={payment.verificationState} />
        <PaymentMethodChip method={payment.method} />
        {paymentNeedsReview(payment) ? <PaymentReviewChip /> : null}
      </div>
      <span className="text-caption tnum text-text-muted">{fullTimestamp(payment.createdAt)}</span>
    </Link>
  );
}

/**
 * The order's ledger-derived settlement, rendered one server figure at a time.
 *
 * Nothing on this screen computes any of it: received, refunded and net all
 * come from order_payment_totals (migration 040). An overpayment is shown as
 * the reviewable fact the server calls it, never silently clamped to the total.
 */
function OrderSettlementRows({ settlement }: { settlement: UiOrderSettlement }) {
  const { t } = useTranslation();

  return (
    <dl className="mt-3 space-y-1.5 border-t border-border-default pt-3">
      {(
        [
          ["order.settlement.received", settlement.received],
          ["order.settlement.refunded", settlement.refunded],
          ["order.settlement.net", settlement.net],
        ] as const
      ).map(([labelKey, value]) => (
        <div key={labelKey} className="flex items-baseline justify-between gap-3">
          <dt className="text-body-sm min-w-0 text-text-secondary">{t(labelKey)}</dt>
          <dd className="text-financial tnum shrink-0 text-text-primary">{formatMoney(value)}</dd>
        </div>
      ))}
      {settlement.overpaid && settlement.overpaidAmount ? (
        <p className="text-body-sm text-status-warning-text" role="status">
          {t("order.settlement.overpaid", { amount: formatMoney(settlement.overpaidAmount) })}
        </p>
      ) : null}
    </dl>
  );
}

function RealOrderDetailScreen({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorCopy = useOrderErrorCopy();
  const capabilities = useCapabilities();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [createDeliveryOpen, setCreateDeliveryOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Identity for the Payment caches on this screen comes from the /app route
   * guard's own server-derived context (validated session + DB membership),
   * never from the capability snapshot. It must include the user and not only
   * the organization: two members of the same organization can hold different
   * payments.* grants, and payments.view_provider_reference in particular
   * changes what the SERVER puts in `reference`. This is the same partition
   * /app/payments uses, so the two screens share one correctly scoped cache
   * rather than each inventing its own.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  /*
   * Fail closed rather than key a request under a placeholder: if the route's
   * identity is incomplete, or the capability snapshot's resolved organization
   * has diverged from the route's (a stale snapshot mid organization switch),
   * no payment data is fetched and no payment action is offered.
   */
  const identityOk =
    Boolean(userId) &&
    Boolean(routeOrganizationId) &&
    (capabilities.state !== "ready" || capabilities.organizationId === routeOrganizationId);

  /*
   * Each key is the permission the matching server function already requires:
   * listPayments -> payments.read, getOrderSettlement -> payments.reconcile,
   * recordPayment -> payments.record (or payments.mark_cod for COD). Hiding a
   * control here decides what is OFFERED, never what is ALLOWED.
   *
   * Settlement figures ride on canSensitive, like the Payments screen's own
   * reconciliation band: the received/refunded/net amounts are a disclosure in
   * themselves and may not be drawn from a retained snapshot whose latest
   * refresh failed.
   */
  const canReadPayments = identityOk && capabilities.can("payments.read");
  const canReconcile = identityOk && capabilities.canSensitive("payments.reconcile");
  const canRecordPayment = identityOk && capabilities.can("payments.record");
  const canMarkCod = identityOk && capabilities.can("payments.mark_cod");
  const canReadCustomers = identityOk && capabilities.can("customers.read");

  const queryKey = ["order", "real", id];
  const query = useQuery({ queryKey, queryFn: () => getRealOrderDetail(id) });

  const deliveriesQueryKey = ["order", "real", id, "deliveries"];
  const deliveriesQuery = useQuery({
    queryKey: deliveriesQueryKey,
    queryFn: () => listRealDeliveriesForOrder(id),
    enabled: query.isSuccess,
  });

  /*
   * This order's own payments, filtered in SQL by the server (listPaymentsFn
   * accepts orderId) — never the whole organization's list narrowed here.
   * PAYMENTS_PER_ORDER is a page size, not a claim about how many exist:
   * `hasMore` is reported to the merchant rather than silently capping.
   */
  const paymentsQueryKey = ["payments", userId, routeOrganizationId, "order", id];
  const paymentsQuery = useQuery({
    queryKey: paymentsQueryKey,
    queryFn: () => listRealPayments({ orderId: id, limit: PAYMENTS_PER_ORDER }),
    enabled: query.isSuccess && canReadPayments,
  });

  /*
   * The authoritative received/refunded/net figures for this order, derived in
   * SQL from the immutable payment ledger (order_payment_totals, migration
   * 040). This screen never adds a payment amount to another one, and never
   * subtracts received from total — both would be re-deriving settlement in
   * the browser over a possibly partial page.
   */
  const settlementQueryKey = ["payments", userId, routeOrganizationId, "settlement", id];
  const settlementQuery = useQuery({
    queryKey: settlementQueryKey,
    queryFn: () => getRealOrderSettlement(id),
    enabled: query.isSuccess && canReconcile,
  });

  // A session that expires mid-view is the one case with no useful inline
  // message — send the merchant back through the same gate /app already
  // enforces on entry (src/routes/app.tsx).
  useEffect(() => {
    if (query.isError && classifyOrderError(query.error) === "unauthorized") {
      void navigate({ to: "/sign-in" });
    }
  }, [query.isError, query.error, navigate]);

  const confirmMutation = useMutation({
    mutationFn: () => confirmRealOrder(id),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKey, detail);
      setNotice(t("order.confirmedNotice"));
    },
    onError: (error) => {
      if (classifyOrderError(error) === "stale") void query.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelRealOrder(id, reason || undefined),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKey, detail);
      setCancelOpen(false);
      setNotice(t("order.cancelledNotice"));
    },
    onError: (error) => {
      if (classifyOrderError(error) === "stale") void query.refetch();
    },
  });

  /**
   * Everything a recorded payment makes stale, and nothing more.
   *
   * The RPC derives the Order's own payment and refund axes inside the same
   * transaction (migration 040), so the order itself is re-read rather than
   * patched from the payment response. The Payments root for THIS principal
   * covers the organization list, the reconciliation band, this order's
   * payments and its settlement in one call, without reaching into another
   * principal's entries. Home's attention count moves too — a newly recorded,
   * still-unverified payment is by definition review work.
   *
   * Deliberately narrow: no queryClient.clear(), no cross-principal keys.
   */
  function invalidateAfterPayment() {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({
      queryKey: ["payments", userId, routeOrganizationId],
    });
    void queryClient.invalidateQueries({ queryKey: ["orders", "real"] });
    void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
  }

  const recordPaymentMutation = useMutation({
    mutationFn: (submit: RecordOrderPaymentSubmit) =>
      recordRealPayment({
        orderId: id,
        method: submit.method,
        amountMinor: submit.amountMinor,
        ...(submit.reference ? { reference: submit.reference } : {}),
        idempotencyKey: submit.idempotencyKey,
      }),
    onSuccess: () => {
      setRecordPaymentOpen(false);
      invalidateAfterPayment();
      /*
       * Never "Paid". record_payment_v1 writes the row as pending/unverified
       * for every method, cash included, and only verification settles it —
       * so the confirmation says a claim was recorded and points at the step
       * that is still outstanding.
       */
      setNotice(t("order.paymentRecordedNotice"));
    },
  });

  const back = () => navigate({ to: "/app/orders" });

  if (query.isLoading) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("order.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    const kind = classifyOrderError(query.error);
    if (kind === "unauthorized") return null; // redirecting, see the effect above
    const copy = errorCopy(kind);
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("order.title")} onBack={back} />
        <OperationalState
          tone="danger"
          title={copy.title}
          body={copy.body}
          onRetry={() => query.refetch()}
        />
      </Screen>
    );
  }

  const { order } = query.data!;
  const items = order.items;
  // State says the transition is possible; the capability snapshot says this
  // member may ask for it. Both must hold for the control to appear, and the
  // server checks the permission again on the transition itself
  // (src/server/orders/state-machine.ts).
  const canConfirm = canConfirmOrder(order.lifecycleStatus) && capabilities.can("orders.confirm");
  const canCancel = canCancelOrder(order.lifecycleStatus) && capabilities.can("orders.cancel");
  const stockUnits = totalStockUnits(items);
  const showStockConsequence = stockUnits > 0 && order.lifecycleStatus !== "draft";

  // Newest first (src/server/deliveries/repository.ts listDeliveries ordering).
  const deliveries = deliveriesQuery.data ?? [];
  const activeDelivery = deliveries.find((d) => isActiveDeliveryStatus(d.status)) ?? null;
  const latestDelivery = deliveries[0] ?? null;
  const canCreateDelivery =
    !activeDelivery &&
    canCreateDeliveryForOrder({
      lifecycleStatus: order.lifecycleStatus,
      fulfillmentStatus: order.fulfillmentStatus,
    });
  const isReplacementDelivery = canCreateDelivery && latestDelivery !== null;

  const payments = paymentsQuery.data?.items ?? [];
  /*
   * Fail closed on the CAPABILITY, not just on the query.
   *
   * `enabled: canReconcile` stops the next fetch, but a disabled TanStack query
   * keeps serving whatever is already in its cache — so a snapshot loaded while
   * the member still held payments.reconcile would go on rendering after the
   * grant was revoked, or after a failed refresh made the snapshot unconfirmed
   * (canSensitive is false for BOTH; see CapabilityView.canSensitive). Reading
   * the capability here is what makes the figures disappear rather than linger.
   *
   * Denied is null, never zero: a withheld figure must not be presented as a
   * settled amount of nothing. The cache entry itself is left alone — this is a
   * presentation gate, not a cache eviction, so no other principal's entries
   * are touched and the partitioned keys keep doing their own job.
   *
   * Same gate the sibling Payments screens already apply to these figures
   * (app.payments.tsx, app.payments.$id.tsx).
   */
  const settlement = canReconcile ? (settlementQuery.data ?? null) : null;
  /*
   * Recording money against a cancelled order is not a thing the merchant can
   * usefully do, and a draft order is not yet an agreement to pay. Both are
   * re-checked server-side; this only decides whether to offer the control.
   */
  const orderAcceptsPayment =
    order.lifecycleStatus !== "cancelled" && order.lifecycleStatus !== "draft";
  const showRecordPayment = orderAcceptsPayment && (canRecordPayment || canMarkCod);
  const paymentsErrorKind = paymentsQuery.isError
    ? classifyPaymentError(paymentsQuery.error)
    : null;
  const recordPaymentError = recordPaymentMutation.error
    ? t(paymentErrorKey(classifyPaymentError(recordPaymentMutation.error)))
    : null;

  const historyItems: TimelineItem[] = [...(order.statusHistory ?? [])]
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
    .map((entry) => ({
      id: entry.id,
      title: t("order.historyEntry", {
        axis: t(`order.axis.${entry.axis}`),
        status: t(`status.${entry.toStatus}`),
      }),
      ...(entry.reason ? { detail: entry.reason } : {}),
      meta: fullTimestamp(entry.changedAt),
      tone:
        entry.toStatus === "cancelled"
          ? "danger"
          : ["confirmed", "completed", "paid", "fulfilled"].includes(entry.toStatus)
            ? "success"
            : "default",
    }));

  const mutationErrorBanner = (() => {
    const err = confirmMutation.error ?? cancelMutation.error;
    if (!err) return null;
    const copy = errorCopy(classifyOrderError(err));
    return <OperationalState tone="danger" title={copy.title} body={copy.body} className="mt-3" />;
  })();

  const hasActions = canConfirm || canCancel;

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={order.code} subtitle={fullTimestamp(order.createdAt)} onBack={back} />

      <div
        className={cn(
          "content-in stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
          "pb-[var(--space-screen-bottom)]",
        )}
      >
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-2xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        {/*
         * One hero, one dominant reading: the money, then the lifecycle state
         * the merchant is asked about, then payment and fulfilment demoted to
         * supporting chips.
         */}
        <StatusHero
          eyebrow={
            order.source && isChannelSource(order.source) ? (
              <ChannelBadge channel={order.source} withLabel />
            ) : (
              t("order.sourceManual")
            )
          }
          headline={<MoneyText value={order.total} showSecondary size="lg" />}
          {...(order.lifecycleStatus ? { primaryStatus: order.lifecycleStatus } : {})}
          secondaryStatuses={[order.paymentStatus, order.fulfillmentStatus]}
          {...(showStockConsequence
            ? { nextStep: t("order.stockConsequence", { count: stockUnits }) }
            : {})}
        />

        <Section title={t("order.items")}>
          <ul className="divide-y divide-border-default">
            {items.map((item, index) => (
              <li
                key={`${item.productId}-${index}`}
                className="flex items-start gap-3 py-2.5 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-text-primary">{item.nameEn}</p>
                  <p className="text-caption text-text-muted">
                    {[item.variant, item.sku ?? undefined, t("order.qty", { count: item.quantity })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className="text-financial shrink-0 text-text-primary">
                  {formatMoney(
                    item.lineTotal ?? {
                      amount: item.unitPrice.amount * item.quantity,
                      currency: item.unitPrice.currency,
                    },
                  )}
                </span>
              </li>
            ))}
          </ul>

          <dl className="mt-3 space-y-1.5 border-t border-border-default pt-3">
            {[
              [t("order.subtotal"), order.subtotal],
              [t("order.discount"), order.discount],
              [t("order.deliveryFee"), order.deliveryFee],
            ].map(([label, value]) => (
              <div key={label as string} className="flex items-center justify-between gap-3">
                <dt className="text-body-sm min-w-0 text-text-secondary">{label as string}</dt>
                <dd className="text-financial text-text-primary">{formatMoney(value as never)}</dd>
              </div>
            ))}
            <div className="flex items-start justify-between gap-3 pt-1">
              <dt className="text-label text-text-primary">{t("order.total")}</dt>
              <dd>
                <MoneyText value={order.total} showSecondary className="items-end" />
              </dd>
            </div>
          </dl>
        </Section>

        {/*
         * Who this order is for. The name and contact details are NOT fetched
         * here: Customer 360 is the one screen authorized to disclose them
         * (customers.view_sensitive is enforced inside getCustomer360), so
         * this is a handoff into that screen rather than a second, weaker
         * identity surface. An order with no linked customer says so instead
         * of offering a link to nothing.
         */}
        <Section title={t("order.customer")}>
          {order.customerId ? (
            canReadCustomers ? (
              <Link
                to="/app/customers/$id"
                params={{ id: order.customerId }}
                className="press tap-target text-label flex w-full items-center justify-between gap-2 py-1 text-action-primary"
              >
                <span className="min-w-0">{t("order.viewCustomer")}</span>
                <ChevronRight className="size-4 shrink-0" aria-hidden />
              </Link>
            ) : (
              <p className="text-body-sm text-text-secondary">{t("order.customerRestricted")}</p>
            )
          ) : (
            <p className="text-body-sm text-text-secondary">{t("order.noCustomerBody")}</p>
          )}
        </Section>

        {/*
         * Payment, as its own axis and its own domain.
         *
         * Recording money here creates a PENDING claim — record_payment_v1
         * writes status 'pending' / verification 'unverified' for every method,
         * cash included — and settling it happens on the payment itself, in the
         * Payments workspace each row links to. Nothing on this screen marks an
         * order paid, infers paid from a method (COD least of all), or infers
         * it from a delivery.
         */}
        <Section
          title={t("order.payment")}
          action={
            payments.length > 0 && canReadPayments ? (
              <InlineAction onClick={() => void navigate({ to: "/app/payments" })}>
                {t("order.openPayments")}
              </InlineAction>
            ) : null
          }
        >
          {!canReadPayments ? (
            <p className="text-body-sm text-text-secondary">{t("order.paymentsRestricted")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-caption text-text-secondary">{t("order.axis.payment")}</span>
                <StatusChip status={order.paymentStatus} />
                {/*
                 * The refund axis is shown beside the payment axis, never
                 * folded into it: a refunded order stays `paid` and reports
                 * `partial`/`full` here (CORRECTIONS.md, approved financial
                 * semantics). Absent when nothing has been refunded.
                 */}
                {order.refundStatus && order.refundStatus !== "none" ? (
                  <>
                    <span className="text-caption text-text-secondary">
                      {t("order.axis.refund")}
                    </span>
                    <StatusChip
                      status={order.refundStatus === "full" ? "refunded" : "partially_refunded"}
                    />
                  </>
                ) : null}
              </div>

              {paymentsQuery.isLoading ? (
                <p className="text-body-sm mt-3 text-text-secondary" role="status">
                  {t("order.paymentsLoading")}
                </p>
              ) : null}

              {paymentsErrorKind ? (
                <OperationalState
                  tone="danger"
                  title={t("order.paymentsError.title")}
                  body={t("order.paymentsError.body")}
                  {...(paymentsErrorKind === "forbidden"
                    ? {}
                    : { onRetry: () => void paymentsQuery.refetch() })}
                  className="mt-3 rounded-xl"
                />
              ) : null}

              {paymentsQuery.isSuccess && payments.length === 0 ? (
                <p className="text-body-sm mt-3 text-text-secondary">{t("order.noPayments")}</p>
              ) : null}

              {payments.length > 0 ? (
                <ul className="mt-3 divide-y divide-border-default">
                  {payments.map((payment) => (
                    <li key={payment.id}>
                      <OrderPaymentRow payment={payment} />
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* A capped page is never presented as the whole record. */}
              {paymentsQuery.data?.hasMore ? (
                <p className="text-caption mt-2 text-text-secondary" role="note">
                  {t("order.paymentsTruncated")}
                </p>
              ) : null}

              {settlement ? <OrderSettlementRows settlement={settlement} /> : null}

              {showRecordPayment ? (
                <Button
                  variant="ghost"
                  className="tap-target text-label mt-3 h-11 w-full text-action-primary"
                  onClick={() => setRecordPaymentOpen(true)}
                >
                  {t("order.recordPayment")}
                </Button>
              ) : null}
            </>
          )}
        </Section>

        <Section
          title={t("order.delivery")}
          action={
            latestDelivery ? (
              <InlineAction
                onClick={() =>
                  navigate({ to: "/app/deliveries/$id", params: { id: latestDelivery.id } })
                }
              >
                {t("order.viewDelivery")}
              </InlineAction>
            ) : null
          }
        >
          {latestDelivery ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm min-w-0 text-text-primary">
                  {latestDelivery.providerName}
                </span>
                <StatusChip status={latestDelivery.status} />
              </div>
              {latestDelivery.externalTrackingNumber ? (
                <p className="text-caption tnum text-text-muted">
                  {t("delivery.tracking")}: {latestDelivery.externalTrackingNumber}
                </p>
              ) : null}
              {latestDelivery.codAmount ? (
                <p className="text-body-sm text-status-warning-text">{t("order.codNote")}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-body-sm text-text-secondary">{t("order.noDeliveryBody")}</p>
          )}
          {canCreateDelivery ? (
            <Button
              variant="ghost"
              className="tap-target text-label mt-3 h-11 w-full text-action-primary"
              onClick={() => setCreateDeliveryOpen(true)}
            >
              {isReplacementDelivery
                ? t("order.createReplacementDelivery")
                : t("order.arrangeDelivery")}
            </Button>
          ) : null}
        </Section>

        <Section title={t("order.history")}>
          {historyItems.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("customer360.noTimelineBody")}</p>
          ) : (
            <Timeline items={historyItems} />
          )}
        </Section>

        {mutationErrorBanner}
      </div>

      {hasActions ? (
        <StickyActionBar
          {...(canCancel
            ? {
                secondary: (
                  <SecondaryAction tone="danger" onClick={() => setCancelOpen(true)}>
                    {t("order.cancel")}
                  </SecondaryAction>
                ),
              }
            : {})}
        >
          {canConfirm ? (
            <Button
              className="press-tactile tap-target elevation-action h-12 w-full rounded-2xl"
              disabled={confirmMutation.isPending}
              aria-busy={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate()}
            >
              {confirmMutation.isPending ? <Spinner /> : null}
              {confirmMutation.isPending ? t("order.confirming") : t("order.confirmOrder")}
            </Button>
          ) : null}
        </StickyActionBar>
      ) : null}

      <CancelOrderSheet
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        pending={cancelMutation.isPending}
        onConfirm={(reason) => cancelMutation.mutate(reason)}
      />
      <CreateDeliverySheet
        open={createDeliveryOpen}
        onOpenChange={setCreateDeliveryOpen}
        orderId={order.id}
        onCreated={(detail) => {
          void queryClient.invalidateQueries({ queryKey: deliveriesQueryKey });
          void navigate({ to: "/app/deliveries/$id", params: { id: detail.id } });
        }}
      />
      <RecordOrderPaymentSheet
        open={recordPaymentOpen}
        onOpenChange={(next) => {
          setRecordPaymentOpen(next);
          /*
           * A failure's error belongs to the attempt that produced it. Without
           * this reset, closing the sheet after a failed record and reopening
           * it for a fresh attempt showed the previous attempt's error over an
           * empty form — a contradictory state saying something went wrong
           * before anything had been sent.
           */
          if (!next) recordPaymentMutation.reset();
        }}
        orderTotal={order.total}
        canRecord={canRecordPayment}
        canMarkCod={canMarkCod}
        pending={recordPaymentMutation.isPending}
        error={recordPaymentError}
        onConfirm={(submit) => recordPaymentMutation.mutate(submit)}
      />
    </div>
  );
}

const EVENT_TONE: Record<string, TimelineItem["tone"]> = {
  payment_confirmed: "success",
  delivered: "success",
  payment_failed: "danger",
  cancelled: "danger",
  returned: "warning",
  refunded: "warning",
};

function MockOrderDetailScreen({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useLanguage();
  const capabilities = useCapabilities();

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [extraEvents, setExtraEvents] = useState<OrderEvent[]>([]);
  const [extraPayments, setExtraPayments] = useState<PaymentRecord[]>([]);

  const query = useQuery({ queryKey: ["order", id], queryFn: () => getOrderDetail(id) });
  const couriersQuery = useQuery({ queryKey: ["couriers"], queryFn: getCouriers });

  const paymentMutation = useMutation({
    mutationFn: recordPayment,
    onSuccess: (payment) => {
      setExtraPayments((p) => [...p, payment]);
      setExtraEvents((e) => [
        {
          id: payment.id,
          kind: "payment_confirmed",
          at: payment.at,
          actor: payment.confirmedManuallyBy ?? "",
        },
        ...e,
      ]);
      setPaymentOpen(false);
      setNotice(t("order.paymentSheet.done"));
    },
  });

  const returnMutation = useMutation({
    mutationFn: createReturn,
    onSuccess: (event) => {
      setExtraEvents((e) => [event, ...e]);
      setReturnOpen(false);
      setNotice(t("order.returnSheet.done"));
    },
  });

  const refundMutation = useMutation({
    mutationFn: createRefund,
    onSuccess: (payment) => {
      setExtraPayments((p) => [...p, payment]);
      setExtraEvents((e) => [
        {
          id: payment.id,
          kind: "refunded",
          at: payment.at,
          actor: payment.confirmedManuallyBy ?? "",
        },
        ...e,
      ]);
      setRefundOpen(false);
      setRefundError(null);
      setNotice(t("order.refundSheet.done"));
    },
    onError: () => setRefundError(t("order.refundSheet.invalid")),
  });

  const deliveryMutation = useMutation({
    mutationFn: arrangeDelivery,
    onSuccess: () => {
      setDeliveryOpen(false);
      setNotice(t("order.deliverySheet.done"));
    },
  });

  const back = () => navigate({ to: "/app/inbox" });

  if (query.isLoading) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("order.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    const denied = (query.error as Error).message === PERMISSION_DENIED;
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("order.title")} onBack={back} />
        {denied ? (
          <OperationalState title={t("order.denied")} body={t("order.deniedBody")} />
        ) : (
          <OperationalState
            title={t("order.notFound")}
            body={t("order.notFoundBody")}
            onRetry={() => query.refetch()}
          />
        )}
      </Screen>
    );
  }

  const detail = query.data!;
  const { order, customer, delivery, staffName } = detail;
  const events = [...extraEvents, ...detail.events].sort((a, b) => b.at.localeCompare(a.at));
  const payments = [...detail.payments, ...extraPayments];

  const paid = payments
    .filter((p) => p.status === "paid" || p.status === "partially_paid")
    .reduce((sum, p) => addMoney(sum, p.amount), usd(0));
  const balance = subtractMoney(order.total, paid);

  const CHANNEL_KEYS = ["facebook", "instagram", "telegram", "pos"];
  const METHOD_KEYS = ["cash", "khqr", "bank_transfer", "cod"];
  const eventDetail = (context?: string) => {
    if (!context) return undefined;
    if (CHANNEL_KEYS.includes(context)) return t(`channel.${context}`);
    if (METHOD_KEYS.includes(context)) return t(`pos.method.${context}`);
    return context;
  };

  const timelineItems: TimelineItem[] = events.map((event) => ({
    id: event.id,
    title: t(`order.event.${event.kind}`),
    detail: eventDetail(event.context),
    meta: [fullTimestamp(event.at), event.actor].filter(Boolean).join(" · "),
    tone: EVENT_TONE[event.kind] ?? "default",
  }));

  const canPay = balance.amount > 0 && order.fulfillmentStatus !== "cancelled";
  const canDeliver =
    !delivery && order.fulfillmentStatus !== "cancelled" && order.deliveryFee.amount > 0;
  const canReturn = order.fulfillmentStatus === "delivered";
  const canRefund = capabilities.can("payments.refund") && paid.amount > 0;

  /** Exactly one dominant action: the next step the merchant actually owes. */
  const actions = [
    canPay
      ? { key: "pay", label: t("order.recordPayment"), open: () => setPaymentOpen(true) }
      : null,
    canDeliver
      ? { key: "deliver", label: t("order.arrangeDelivery"), open: () => setDeliveryOpen(true) }
      : null,
    canReturn
      ? { key: "return", label: t("order.startReturn"), open: () => setReturnOpen(true) }
      : null,
    canRefund ? { key: "refund", label: t("order.refund"), open: () => setRefundOpen(true) } : null,
  ].filter(Boolean) as { key: string; label: string; open: () => void }[];
  const [primaryAction, ...secondaryActions] = actions;

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={order.code} subtitle={fullTimestamp(order.createdAt)} onBack={back} />

      <div
        className={cn(
          "content-in stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
          "pb-[var(--space-screen-bottom)]",
        )}
      >
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-2xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        {/* One hero number, then quiet supporting facts. */}
        <StatusHero
          eyebrow={<ChannelBadge channel={order.channel} withLabel />}
          headline={<MoneyText value={order.total} showSecondary size="lg" />}
          primaryStatus={order.paymentStatus}
          secondaryStatuses={[order.fulfillmentStatus]}
          {...(balance.amount > 0
            ? { nextStep: t("order.balanceDue", { amount: formatMoney(balance) }) }
            : {})}
        />

        <Section variant="plain">
          <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
            <SectionRows>
              <SectionRow label={t("order.placedBy")} value={staffName ?? "—"} />
            </SectionRows>
          </div>
        </Section>

        <Section
          title={t("order.customer")}
          action={
            customer ? (
              <InlineAction
                onClick={() => navigate({ to: "/app/customers/$id", params: { id: customer.id } })}
              >
                {t("order.viewCustomer")}
              </InlineAction>
            ) : null
          }
          variant={customer ? "card" : "plain"}
        >
          {customer ? (
            <div className="min-w-0">
              <p className="text-body text-text-primary">{localName(customer, language)}</p>
              <p className="text-body-sm tnum text-text-secondary">
                {capabilities.can("customers.view_sensitive")
                  ? customer.phone
                  : t("customer360.hidden")}
              </p>
            </div>
          ) : (
            <OperationalState
              title={t("order.customerMissing")}
              body={t("order.customerMissingBody")}
            />
          )}
        </Section>

        <Section title={t("order.items")}>
          <ul className="divide-y divide-border-default">
            {order.items.map((item, index) => (
              <li
                key={`${item.productId}-${index}`}
                className="flex items-start gap-3 py-2.5 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-text-primary">{localName(item, language)}</p>
                  <p className="text-caption text-text-muted">
                    {[item.variant, t("order.qty", { count: item.quantity })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className="text-financial shrink-0 text-text-primary">
                  {formatMoney({
                    amount: item.unitPrice.amount * item.quantity,
                    currency: item.unitPrice.currency,
                  })}
                </span>
              </li>
            ))}
          </ul>

          <dl className="mt-3 space-y-1.5 border-t border-border-default pt-3">
            {[
              [t("order.subtotal"), order.subtotal],
              [t("order.discount"), order.discount],
              [t("order.deliveryFee"), order.deliveryFee],
            ].map(([label, value]) => (
              <div key={label as string} className="flex items-center justify-between gap-3">
                <dt className="text-body-sm min-w-0 text-text-secondary">{label as string}</dt>
                <dd className="text-financial text-text-primary">{formatMoney(value as never)}</dd>
              </div>
            ))}
            <div className="flex items-start justify-between gap-3 pt-1">
              <dt className="text-label text-text-primary">{t("order.total")}</dt>
              <dd>
                <MoneyText value={order.total} showSecondary className="items-end" />
              </dd>
            </div>
          </dl>
        </Section>

        <Section title={t("order.payment")}>
          {payments.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("order.noPayments")}</p>
          ) : (
            <ul className="divide-y divide-border-default">
              {payments.map((payment) => (
                <li key={payment.id} className="py-2.5 first:pt-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-body-sm min-w-0 text-text-primary">
                      {t(`pos.method.${payment.method}`)}
                    </span>
                    <span className="text-financial shrink-0 text-text-primary">
                      {formatMoney(payment.amount)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusChip status={payment.status} />
                    {payment.reference ? (
                      <span className="text-caption tnum text-text-muted">
                        {t("order.reference")}: {payment.reference}
                      </span>
                    ) : null}
                  </div>
                  {payment.confirmedManuallyBy ? (
                    <p className="text-caption mt-1 text-text-muted">
                      {t("order.paymentManual", { name: payment.confirmedManuallyBy })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <dl className="mt-3 space-y-1.5 border-t border-border-default pt-3">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-body-sm text-text-secondary">{t("order.paid")}</dt>
              <dd className="text-financial text-text-primary">{formatMoney(paid)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-body-sm text-text-secondary">{t("order.balance")}</dt>
              <dd
                className={cn(
                  "text-financial",
                  balance.amount > 0 ? "text-status-warning-text" : "text-text-primary",
                )}
              >
                {formatMoney(balance)}
              </dd>
            </div>
          </dl>
        </Section>

        <Section
          title={t("order.delivery")}
          action={
            delivery ? (
              <InlineAction
                onClick={() => navigate({ to: "/app/deliveries/$id", params: { id: delivery.id } })}
              >
                {t("order.viewDelivery")}
              </InlineAction>
            ) : null
          }
        >
          {delivery ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm min-w-0 text-text-primary">
                  {delivery.courierName}
                </span>
                <StatusChip status={delivery.status} />
              </div>
              <p className="text-caption tnum text-text-muted">
                {t("delivery.tracking")}: {delivery.trackingNumber}
              </p>
              {delivery.codAmount ? (
                <p className="text-body-sm text-status-warning-text">{t("order.codNote")}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-body-sm text-text-secondary">{t("order.noDeliveryBody")}</p>
          )}
        </Section>

        <Section title={t("order.history")}>
          {timelineItems.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("customer360.noTimelineBody")}</p>
          ) : (
            <Timeline items={timelineItems} />
          )}
        </Section>
      </div>

      {primaryAction ? (
        <StickyActionBar
          {...(secondaryActions.length > 0
            ? {
                secondary: secondaryActions.map((action) => (
                  <SecondaryAction key={action.key} onClick={action.open}>
                    {action.label}
                  </SecondaryAction>
                )),
              }
            : {})}
        >
          <Button
            className="press-tactile tap-target elevation-action h-12 w-full rounded-2xl"
            onClick={primaryAction.open}
          >
            {primaryAction.label}
          </Button>
        </StickyActionBar>
      ) : null}

      <RecordPaymentSheet
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        balance={balance}
        pending={paymentMutation.isPending}
        onConfirm={({ method, amountCents, reference }) =>
          paymentMutation.mutate({
            orderId: order.id,
            method,
            amount: usd(amountCents),
            ...(reference ? { reference } : {}),
          })
        }
      />
      <ReturnSheet
        open={returnOpen}
        onOpenChange={setReturnOpen}
        pending={returnMutation.isPending}
        onConfirm={({ reason, restock }) =>
          returnMutation.mutate({ orderId: order.id, reason, restock })
        }
      />
      <RefundSheet
        open={refundOpen}
        onOpenChange={setRefundOpen}
        total={order.total}
        pending={refundMutation.isPending}
        error={refundError}
        onConfirm={({ amountCents, method, reason }) =>
          refundMutation.mutate({ orderId: order.id, amount: usd(amountCents), method, reason })
        }
      />
      <ArrangeDeliverySheet
        open={deliveryOpen}
        onOpenChange={setDeliveryOpen}
        couriers={couriersQuery.data ?? []}
        pending={deliveryMutation.isPending}
        onConfirm={(courierId) => deliveryMutation.mutate({ orderId: order.id, courierId })}
      />
    </div>
  );
}
