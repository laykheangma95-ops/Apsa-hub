import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  ChannelBadge,
  ListSkeleton,
  Money as MoneyText,
  StatusChip,
  Timeline,
  type TimelineItem,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import {
  ArrangeDeliverySheet,
  RecordPaymentSheet,
  RefundSheet,
  ReturnSheet,
} from "@/components/orders/OrderActionSheets";
import {
  arrangeDelivery,
  createRefund,
  createReturn,
  currentRole,
  getCouriers,
  getOrderDetail,
  recordPayment,
  PERMISSION_DENIED,
} from "@/lib/api";
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
  component: OrderDetailScreen,
});

const EVENT_TONE: Record<string, TimelineItem["tone"]> = {
  payment_confirmed: "success",
  delivered: "success",
  payment_failed: "danger",
  cancelled: "danger",
  returned: "warning",
  refunded: "warning",
};

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-h3 text-text-primary">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function OrderDetailScreen() {
  const { id } = Route.useParams();
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
        { id: payment.id, kind: "payment_confirmed", at: payment.at, actor: payment.confirmedManuallyBy ?? "" },
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
        { id: payment.id, kind: "refunded", at: payment.at, actor: payment.confirmedManuallyBy ?? "" },
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
      <div className="min-h-dvh bg-surface-canvas pb-24">
        <AppHeader title={t("order.title")} onBack={back} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (query.isError) {
    const denied = (query.error as Error).message === PERMISSION_DENIED;
    return (
      <div className="min-h-dvh bg-surface-canvas pb-24">
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
  const canDeliver = !delivery && order.fulfillmentStatus !== "cancelled" && order.deliveryFee.amount > 0;
  const canReturn = order.fulfillmentStatus === "delivered";
  const canRefund = permissions.refund && paid.amount > 0;

  return (
    <div className="min-h-dvh bg-surface-canvas pb-28">
      <AppHeader title={order.code} subtitle={fullTimestamp(order.createdAt)} onBack={back} />

      <div className="mx-auto max-w-[560px] space-y-3 px-4 py-4 lg:max-w-[880px]">
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        <Section title={t("order.title")}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={order.paymentStatus} size="md" />
            <StatusChip status={order.fulfillmentStatus} size="md" />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-caption text-text-muted">{t("order.source")}</dt>
              <dd className="mt-0.5">
                <ChannelBadge channel={order.channel} withLabel />
              </dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">{t("order.placedBy")}</dt>
              <dd className="text-body-sm text-text-primary">{staffName ?? "—"}</dd>
            </div>
          </dl>
        </Section>

        <Section
          title={t("order.customer")}
          action={
            customer ? (
              <button
                type="button"
                onClick={() => navigate({ to: "/app/customers/$id", params: { id: customer.id } })}
                className="tap-target text-label text-action-primary"
              >
                {t("order.viewCustomer")}
              </button>
            ) : null
          }
        >
          {customer ? (
            <div>
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
              <li key={`${item.productId}-${index}`} className="flex items-start gap-3 py-2.5">
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
              <div key={label as string} className="flex items-center justify-between">
                <dt className="text-body-sm text-text-secondary">{label as string}</dt>
                <dd className="text-financial text-text-primary">{formatMoney(value as never)}</dd>
              </div>
            ))}
            <div className="flex items-start justify-between pt-1">
              <dt className="text-label text-text-primary">{t("order.total")}</dt>
              <dd>
                <MoneyText value={order.total} showSecondary size="lg" className="items-end" />
              </dd>
            </div>
          </dl>
        </Section>

        <Section title={t("order.payment")}>
          {payments.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("order.noPayments")}</p>
          ) : (
            <ul className="space-y-2">
              {payments.map((payment) => (
                <li key={payment.id} className="rounded-xl bg-surface-secondary px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-body-sm text-text-primary">
                      {t(`pos.method.${payment.method}`)}
                    </span>
                    <span className="text-financial text-text-primary">
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
            <div className="flex items-center justify-between">
              <dt className="text-body-sm text-text-secondary">{t("order.paid")}</dt>
              <dd className="text-financial text-text-primary">{formatMoney(paid)}</dd>
            </div>
            <div className="flex items-center justify-between">
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
                className="tap-target text-label text-action-primary"
              >
                {t("order.viewDelivery")}
              </button>
            ) : null
          }
        >
          {delivery ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm text-text-primary">{delivery.courierName}</span>
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

        <Section title={t("order.actions")}>
          <div className="flex flex-wrap gap-2">
            {canPay ? (
              <Button className="tap-target h-12" onClick={() => setPaymentOpen(true)}>
                {t("order.recordPayment")}
              </Button>
            ) : null}
            {canDeliver ? (
              <Button variant="outline" className="tap-target h-12" onClick={() => setDeliveryOpen(true)}>
                {t("order.arrangeDelivery")}
              </Button>
            ) : null}
            {canReturn ? (
              <Button variant="outline" className="tap-target h-12" onClick={() => setReturnOpen(true)}>
                {t("order.startReturn")}
              </Button>
            ) : null}
            {canRefund ? (
              <Button variant="outline" className="tap-target h-12" onClick={() => setRefundOpen(true)}>
                {t("order.refund")}
              </Button>
            ) : null}
          </div>
        </Section>
      </div>

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
