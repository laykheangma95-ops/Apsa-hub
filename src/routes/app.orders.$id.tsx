import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  ChannelBadge,
  ListSkeleton,
  Money as MoneyText,
  Section,
  SectionRow,
  SectionRows,
  StatusChip,
  StickyActionBar,
  Timeline,
  type TimelineItem,
} from "@/design-system";

import { OperationalState } from "@/components/common/OperationalState";
import { CancelOrderSheet } from "@/components/orders/CancelOrderSheet";
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
  currentRole,
  getCouriers,
  getOrderDetail,
  getRealOrderDetail,
  isProductionId,
  recordPayment,
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
import { fullTimestamp, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { addMoney, formatMoney, subtractMoney, usd } from "@/lib/money";
import { permissionsFor } from "@/lib/permissions";
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

function RealOrderDetailScreen({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorCopy = useOrderErrorCopy();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const queryKey = ["order", "real", id];
  const query = useQuery({ queryKey, queryFn: () => getRealOrderDetail(id) });

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

  const back = () => navigate({ to: "/app/orders" });

  if (query.isLoading) {
    return (
      <div className="min-h-dvh bg-surface-page pb-24">
        <AppHeader title={t("order.title")} onBack={back} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (query.isError) {
    const kind = classifyOrderError(query.error);
    if (kind === "unauthorized") return null; // redirecting, see the effect above
    const copy = errorCopy(kind);
    return (
      <div className="min-h-dvh bg-surface-page pb-24">
        <AppHeader title={t("order.title")} onBack={back} />
        <OperationalState
          tone="danger"
          title={copy.title}
          body={copy.body}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const { order } = query.data!;
  const items = order.items;
  const canConfirm = canConfirmOrder(order.lifecycleStatus);
  const canCancel = canCancelOrder(order.lifecycleStatus);
  const stockUnits = totalStockUnits(items);
  const showStockConsequence = stockUnits > 0 && order.lifecycleStatus !== "draft";

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

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={order.code} subtitle={fullTimestamp(order.createdAt)} onBack={back} />

      <div className="stack-section mx-auto max-w-[560px] px-4 py-5 pb-[var(--space-screen-bottom)] lg:max-w-[880px]">
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        <Section variant="plain">
          <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
            <MoneyText value={order.total} showSecondary size="lg" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {order.lifecycleStatus ? (
                <StatusChip status={order.lifecycleStatus} size="md" />
              ) : null}
              <StatusChip status={order.paymentStatus} size="md" />
              <StatusChip status={order.fulfillmentStatus} size="md" />
            </div>
            <SectionRows className="mt-3 border-t border-border-default pt-2">
              <SectionRow
                label={t("order.source")}
                value={
                  order.source && isChannelSource(order.source) ? (
                    <ChannelBadge channel={order.source} withLabel />
                  ) : (
                    t("order.sourceManual")
                  )
                }
              />
            </SectionRows>
          </div>
        </Section>

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

          {showStockConsequence ? (
            <p className="text-caption mt-3 border-t border-border-default pt-3 text-text-muted">
              {t("order.stockConsequence", { count: stockUnits })}
            </p>
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

      {canConfirm || canCancel ? (
        <StickyActionBar aboveNav>
          {canConfirm ? (
            <Button
              className="tap-target h-12 w-full"
              disabled={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate()}
            >
              {confirmMutation.isPending ? t("order.confirming") : t("order.confirmOrder")}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="ghost"
              className="tap-target text-label h-11 w-full text-text-secondary"
              onClick={() => setCancelOpen(true)}
            >
              {t("order.cancel")}
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
  const permissions = permissionsFor(currentRole);

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
      <div className="min-h-dvh bg-surface-page pb-24">
        <AppHeader title={t("order.title")} onBack={back} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (query.isError) {
    const denied = (query.error as Error).message === PERMISSION_DENIED;
    return (
      <div className="min-h-dvh bg-surface-page pb-24">
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
      </div>
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
  const canRefund = permissions.refund && paid.amount > 0;

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

      <div className="stack-section mx-auto max-w-[560px] px-4 py-5 pb-[var(--space-screen-bottom)] lg:max-w-[880px]">
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        {/* One hero number, then quiet supporting facts. */}
        <Section variant="plain">
          <div className="elevation-1 rounded-2xl border border-border-default bg-surface-primary pad-card">
            <MoneyText value={order.total} showSecondary size="lg" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip status={order.paymentStatus} size="md" />
              <StatusChip status={order.fulfillmentStatus} size="md" />
            </div>
            <SectionRows className="mt-3 border-t border-border-default pt-2">
              <SectionRow
                label={t("order.source")}
                value={<ChannelBadge channel={order.channel} withLabel />}
              />
              <SectionRow label={t("order.placedBy")} value={staffName ?? "—"} />
            </SectionRows>
          </div>
        </Section>

        <Section
          title={t("order.customer")}
          action={
            customer ? (
              <button
                type="button"
                onClick={() => navigate({ to: "/app/customers/$id", params: { id: customer.id } })}
                className="text-label rounded-full px-1 py-2 text-action-primary"
              >
                {t("order.viewCustomer")}
              </button>
            ) : null
          }
          variant={customer ? "card" : "plain"}
        >
          {customer ? (
            <div className="min-w-0">
              <p className="text-body text-text-primary">{localName(customer, language)}</p>
              <p className="text-body-sm tnum text-text-secondary">
                {permissions.viewCustomerPhone ? customer.phone : t("customer360.hidden")}
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
              <button
                type="button"
                onClick={() => navigate({ to: "/app/deliveries/$id", params: { id: delivery.id } })}
                className="text-label rounded-full px-1 py-2 text-action-primary"
              >
                {t("order.viewDelivery")}
              </button>
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
        <StickyActionBar aboveNav>
          <Button className="tap-target h-12 w-full" onClick={primaryAction.open}>
            {primaryAction.label}
          </Button>
          {secondaryActions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {secondaryActions.map((action) => (
                <Button
                  key={action.key}
                  variant="ghost"
                  className="tap-target text-label h-11 flex-1 text-text-secondary"
                  onClick={action.open}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
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
