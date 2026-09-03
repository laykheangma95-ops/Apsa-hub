import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  ListSkeleton,
  StatusChip,
  Timeline,
  type TimelineItem,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { DeliveryProgress } from "@/components/delivery/DeliveryProgress";
import { applyDeliveryAction, getDeliveryDetail, PERMISSION_DENIED } from "@/lib/api";
import { fullTimestamp, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { currentRole } from "@/lib/api";
import { permissionsFor } from "@/lib/permissions";
import type { DeliveryAction } from "@/lib/api";
import type { DeliveryStatus } from "@/types";

export const Route = createFileRoute("/app/deliveries/$id")({
  head: () => ({
    meta: [
      { title: "Delivery tracking — APSA" },
      {
        name: "description",
        content:
          "Track one parcel: courier, tracking number, progress, cash on delivery and what to do when it fails.",
      },
      { property: "og:title", content: "Delivery tracking — APSA" },
      {
        property: "og:description",
        content: "Courier progress, COD status and recovery actions for one delivery.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DeliveryScreen,
});

function DeliveryScreen() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useLanguage();
  const permissions = permissionsFor(currentRole);

  const [statusOverride, setStatusOverride] = useState<DeliveryStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["delivery", id], queryFn: () => getDeliveryDetail(id) });

  const actionMutation = useMutation({
    mutationFn: (action: DeliveryAction) => applyDeliveryAction(id, action),
    onSuccess: (status) => {
      setStatusOverride(status);
      setNotice(t("delivery.actionDone"));
    },
  });

  const back = () => navigate({ to: "/app/inbox" });

  if (query.isLoading) {
    return (
      <div className="min-h-dvh bg-surface-page">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (query.isError) {
    const denied = (query.error as Error).message === PERMISSION_DENIED;
    return (
      <div className="min-h-dvh bg-surface-page">
        <AppHeader title={t("delivery.title")} onBack={back} />
        {denied ? (
          <OperationalState title={t("delivery.denied")} body={t("delivery.deniedBody")} />
        ) : (
          <OperationalState
            title={t("delivery.notFound")}
            body={t("delivery.notFoundBody")}
            onRetry={() => query.refetch()}
          />
        )}
      </div>
    );
  }

  const { delivery, order, customer } = query.data!;
  const status = statusOverride ?? delivery.status;
  const failed = status === "failed";

  const timelineItems: TimelineItem[] = [...delivery.events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((event) => ({
      id: event.id,
      title: t(`status.${event.status}`),
      detail: event.context ?? undefined,
      meta: fullTimestamp(event.at),
      tone:
        event.status === "delivered"
          ? "success"
          : event.status === "failed"
            ? "danger"
            : "default",
    }));

  return (
    <div className="min-h-dvh bg-surface-page pb-24">
      <AppHeader title={t("delivery.title")} subtitle={delivery.trackingNumber} onBack={back} />

      <div className="mx-auto max-w-[560px] space-y-3 px-4 py-4 lg:max-w-[880px]">
        {notice ? (
          <p
            role="status"
            className="text-body-sm rounded-xl bg-status-success-soft px-4 py-3 text-status-success-text"
          >
            {notice}
          </p>
        ) : null}

        <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-caption text-text-muted">{t("delivery.courier")}</p>
              <p className="text-body text-text-primary">{delivery.courierName}</p>
            </div>
            <StatusChip status={status} size="md" />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-caption text-text-muted">{t("delivery.tracking")}</dt>
              <dd className="text-data tnum text-text-primary">{delivery.trackingNumber}</dd>
            </div>
            <div>
              <dt className="text-caption text-text-muted">{t("delivery.fee")}</dt>
              <dd className="text-financial text-text-primary">{formatMoney(delivery.fee)}</dd>
            </div>
          </dl>
          {order ? (
            <button
              type="button"
              onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
              className="tap-target text-label mt-2 inline-flex text-action-primary"
            >
              {t("delivery.viewOrder")} · {order.code}
            </button>
          ) : null}
        </section>

        <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
          <h2 className="text-h3 text-text-primary">{t("delivery.progress")}</h2>
          <div className="mt-3">
            <DeliveryProgress status={status} />
          </div>
          {failed ? (
            <div className="mt-4 rounded-xl bg-status-danger-soft px-3 py-2">
              <p className="text-body-sm text-status-danger-text">{t("delivery.failed")}</p>
              {delivery.failureReason ? (
                <p className="text-caption text-status-danger-text">
                  {t(`delivery.failReason.${delivery.failureReason}`)}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {delivery.codAmount ? (
          <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
            <h2 className="text-h3 text-text-primary">{t("delivery.cod")}</h2>
            <p className="text-financial-lg mt-2 text-text-primary">
              {formatMoney(delivery.codAmount)}
            </p>
            <p className="text-body-sm mt-1 text-text-secondary">
              {delivery.codCollected ? t("delivery.codCollected") : t("delivery.codNotCollected")}
            </p>
            {delivery.settlementPending ? (
              <p className="text-body-sm mt-1 text-status-warning-text">
                {t("delivery.settlementPending")}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
          <h2 className="text-h3 text-text-primary">{t("delivery.address")}</h2>
          {customer ? (
            <p className="text-body-sm mt-2 text-text-primary">{localName(customer, language)}</p>
          ) : null}
          <p className="text-body-sm mt-1 text-text-secondary">
            {!permissions.viewCustomerAddress
              ? t("customer360.hidden")
              : customer?.address
                ? [
                    customer.address.houseNo,
                    customer.address.street,
                    customer.address.sangkat,
                    customer.address.khan,
                    customer.address.city,
                  ].join(", ")
                : t("delivery.noAddress")}
          </p>
        </section>

        <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
          <h2 className="text-h3 text-text-primary">{t("delivery.history")}</h2>
          <div className="mt-3">
            <Timeline items={timelineItems} />
          </div>
        </section>

        {failed || status === "in_transit" ? (
          <section className="rounded-2xl border border-border-default bg-surface-primary p-4">
            <h2 className="text-h3 text-text-primary">{t("order.actions")}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {failed ? (
                <>
                  <Button
                    className="tap-target h-12"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("retry")}
                  >
                    {t("delivery.retry")}
                  </Button>
                  <Button
                    variant="outline"
                    className="tap-target h-12"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("reschedule")}
                  >
                    {t("delivery.reschedule")}
                  </Button>
                  <Button
                    variant="outline"
                    className="tap-target h-12"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("return_to_shop")}
                  >
                    {t("delivery.returnToShop")}
                  </Button>
                </>
              ) : (
                <Button
                  className="tap-target h-12"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate("mark_delivered")}
                >
                  {t("delivery.markDelivered")}
                </Button>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
