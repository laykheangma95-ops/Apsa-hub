import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  ListSkeleton,
  Section,
  SectionRow,
  SectionRows,
  StatusChip,
  StickyActionBar,
  Timeline,
  type TimelineItem,
} from "@/design-system";

import { OperationalState } from "@/components/common/OperationalState";
import { DeliveryProgress } from "@/components/delivery/DeliveryProgress";
import { DeliveryReasonSheet } from "@/components/delivery/DeliveryReasonSheet";
import {
  applyDeliveryAction,
  cancelRealDelivery,
  getDeliveryDetail,
  getRealDeliveryDetail,
  getRealOrderDetail,
  isProductionId,
  markRealDeliveryDelivered,
  markRealDeliveryFailed,
  markRealDeliveryInTransit,
  markRealDeliveryReady,
  PERMISSION_DENIED,
  startPreparingRealDelivery,
} from "@/lib/api";
import {
  canCancelDelivery,
  canMarkDeliveryDelivered,
  canMarkDeliveryFailed,
  canMarkDeliveryInTransit,
  canMarkDeliveryReady,
  canStartPreparingDelivery,
  classifyDeliveryError,
  type DeliveryErrorKind,
  type RealDeliveryStatus,
} from "@/lib/deliveries";
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
  component: DeliveryDetailRoute,
});

/**
 * Boundary between the two Delivery UIs, mirroring src/routes/app.orders.$id.tsx's
 * isProductionId split. Production deliveries (real UUIDs, created via the
 * production Delivery domain in src/server/deliveries) render
 * RealDeliveryDetailScreen. Everything else (mock ids/tracking numbers from
 * the Inbox/POS mock flows) keeps the existing mock-backed screen exactly as
 * it was.
 */
function DeliveryDetailRoute() {
  const { id } = Route.useParams();
  return isProductionId(id) ? (
    <RealDeliveryDetailScreen id={id} />
  ) : (
    <MockDeliveryDetailScreen id={id} />
  );
}

/** Translated title/body for one classified delivery error. Never surfaces err.message. */
function useDeliveryErrorCopy() {
  const { t } = useTranslation();
  return (kind: DeliveryErrorKind): { title: string; body: string } => {
    switch (kind) {
      case "forbidden":
        return { title: t("delivery.denied"), body: t("delivery.deniedBody") };
      case "not_found":
        return { title: t("delivery.notFound"), body: t("delivery.notFoundBody") };
      case "stale":
        return { title: t("delivery.error.stale.title"), body: t("delivery.error.stale.body") };
      case "invalid":
        return { title: t("delivery.error.invalid.title"), body: t("delivery.error.invalid.body") };
      default:
        // "unauthorized" redirects to sign-in before this is ever rendered;
        // "server_error" (and any unclassified case) gets the generic copy —
        // never the raw error message.
        return { title: t("error.title"), body: t("error.body") };
    }
  };
}

const HISTORY_TONE: Record<RealDeliveryStatus, NonNullable<TimelineItem["tone"]>> = {
  pending: "default",
  preparing: "default",
  ready: "default",
  in_transit: "default",
  delivered: "success",
  failed: "danger",
  cancelled: "danger",
};

function RealDeliveryDetailScreen({ id }: { id: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorCopy = useDeliveryErrorCopy();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [failOpen, setFailOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const queryKey = ["delivery", "real", id];
  const query = useQuery({ queryKey, queryFn: () => getRealDeliveryDetail(id) });
  const delivery = query.data;

  const orderQueryKey = ["order", "real", delivery?.orderId];
  const orderQuery = useQuery({
    queryKey: orderQueryKey,
    queryFn: () => getRealOrderDetail(delivery!.orderId),
    enabled: Boolean(delivery?.orderId),
  });

  // A session that expires mid-view is the one case with no useful inline
  // message — send the merchant back through the same gate /app already
  // enforces on entry (src/routes/app.tsx).
  useEffect(() => {
    if (query.isError && classifyDeliveryError(query.error) === "unauthorized") {
      void navigate({ to: "/sign-in" });
    }
  }, [query.isError, query.error, navigate]);

  function onTransitionSuccess(detail: typeof delivery) {
    queryClient.setQueryData(queryKey, detail);
    setNotice(t("delivery.actionDone"));
    void queryClient.invalidateQueries({ queryKey: ["order", "real", detail?.orderId] });
  }

  function onTransitionError(error: unknown) {
    if (classifyDeliveryError(error) === "stale") void query.refetch();
  }

  const startPreparingMutation = useMutation({
    mutationFn: () => startPreparingRealDelivery(id),
    onSuccess: onTransitionSuccess,
    onError: onTransitionError,
  });
  const markReadyMutation = useMutation({
    mutationFn: () => markRealDeliveryReady(id),
    onSuccess: onTransitionSuccess,
    onError: onTransitionError,
  });
  const markInTransitMutation = useMutation({
    mutationFn: () => markRealDeliveryInTransit(id),
    onSuccess: onTransitionSuccess,
    onError: onTransitionError,
  });
  const markDeliveredMutation = useMutation({
    mutationFn: () => markRealDeliveryDelivered(id),
    onSuccess: onTransitionSuccess,
    onError: onTransitionError,
  });
  const markFailedMutation = useMutation({
    mutationFn: (reason: string) => markRealDeliveryFailed(id, reason),
    onSuccess: (detail) => {
      onTransitionSuccess(detail);
      setFailOpen(false);
    },
    onError: onTransitionError,
  });
  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelRealDelivery(id, reason),
    onSuccess: (detail) => {
      onTransitionSuccess(detail);
      setCancelOpen(false);
    },
    onError: onTransitionError,
  });

  const anyPending =
    startPreparingMutation.isPending ||
    markReadyMutation.isPending ||
    markInTransitMutation.isPending ||
    markDeliveredMutation.isPending;

  const back = () =>
    navigate(
      delivery
        ? { to: "/app/orders/$id", params: { id: delivery.orderId } }
        : { to: "/app/orders" },
    );

  if (query.isLoading) {
    return (
      <div className="min-h-dvh bg-surface-page">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (query.isError) {
    const kind = classifyDeliveryError(query.error);
    if (kind === "unauthorized") return null; // redirecting, see the effect above
    const copy = errorCopy(kind);
    return (
      <div className="min-h-dvh bg-surface-page">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <OperationalState
          tone="danger"
          title={copy.title}
          body={copy.body}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const d = delivery!;
  const order = orderQuery.data?.order ?? null;

  const historyItems: TimelineItem[] = [...d.history]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => ({
      id: entry.id,
      title: t(`status.${entry.toStatus}`),
      ...(entry.reason ? { detail: entry.reason } : {}),
      meta: fullTimestamp(entry.createdAt),
      tone: HISTORY_TONE[entry.toStatus],
    }));

  const mutationError =
    startPreparingMutation.error ??
    markReadyMutation.error ??
    markInTransitMutation.error ??
    markDeliveredMutation.error;
  const mutationErrorBanner = (() => {
    if (!mutationError) return null;
    const kind = classifyDeliveryError(mutationError);
    if (kind === "stale") return null; // already refetching — no need to also show a banner
    const copy = errorCopy(kind);
    return <OperationalState tone="danger" title={copy.title} body={copy.body} className="mt-3" />;
  })();

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader
        title={t("delivery.title")}
        subtitle={d.externalTrackingNumber ?? undefined}
        onBack={back}
      />

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
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-caption text-text-muted">{t("delivery.courier")}</p>
                <p className="text-h3 truncate text-text-primary">{d.providerName}</p>
              </div>
              <StatusChip status={d.status} size="md" />
            </div>

            <SectionRows className="mt-3 border-t border-border-default pt-2">
              <SectionRow
                label={t("delivery.tracking")}
                value={
                  <span className="tnum">{d.externalTrackingNumber ?? t("delivery.noTracking")}</span>
                }
              />
              {order ? (
                <SectionRow
                  label={t("delivery.viewOrder")}
                  value={
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
                      className="text-label tnum text-action-primary"
                    >
                      {order.code}
                    </button>
                  }
                />
              ) : null}
              {order ? (
                <SectionRow
                  label={t("delivery.orderFulfillment")}
                  value={<StatusChip status={order.fulfillmentStatus} />}
                />
              ) : null}
              <SectionRow label={t("delivery.created")} value={fullTimestamp(d.createdAt)} />
              <SectionRow label={t("delivery.updated")} value={fullTimestamp(d.updatedAt)} />
            </SectionRows>
          </div>
        </Section>

        {d.codAmount ? (
          <Section title={t("delivery.cod")}>
            <p className="text-financial-lg text-text-primary">{formatMoney(d.codAmount)}</p>
            <p className="text-body-sm mt-1 text-text-secondary">{t("delivery.create.codHint")}</p>
          </Section>
        ) : null}

        {mutationErrorBanner}

        <Section title={t("delivery.history")}>
          {historyItems.length === 0 ? (
            <p className="text-body-sm text-text-secondary">{t("customer360.noTimelineBody")}</p>
          ) : (
            <Timeline items={historyItems} />
          )}
        </Section>
      </div>

      {canStartPreparingDelivery(d.status) ||
      canMarkDeliveryReady(d.status) ||
      canMarkDeliveryInTransit(d.status) ||
      canMarkDeliveryDelivered(d.status) ||
      canCancelDelivery(d.status) ? (
        <StickyActionBar aboveNav>
          {canStartPreparingDelivery(d.status) ? (
            <Button
              className="tap-target h-12 w-full"
              disabled={anyPending}
              onClick={() => startPreparingMutation.mutate()}
            >
              {t("delivery.startPreparing")}
            </Button>
          ) : null}
          {canMarkDeliveryReady(d.status) ? (
            <Button
              className="tap-target h-12 w-full"
              disabled={anyPending}
              onClick={() => markReadyMutation.mutate()}
            >
              {t("delivery.markReady")}
            </Button>
          ) : null}
          {canMarkDeliveryInTransit(d.status) ? (
            <Button
              className="tap-target h-12 w-full"
              disabled={anyPending}
              onClick={() => markInTransitMutation.mutate()}
            >
              {t("delivery.markInTransit")}
            </Button>
          ) : null}
          {canMarkDeliveryDelivered(d.status) ? (
            <Button
              className="tap-target h-12 w-full"
              disabled={anyPending}
              onClick={() => markDeliveredMutation.mutate()}
            >
              {t("delivery.markDelivered")}
            </Button>
          ) : null}
          {canMarkDeliveryFailed(d.status) || canCancelDelivery(d.status) ? (
            <div className="flex gap-2">
              {canMarkDeliveryFailed(d.status) ? (
                <Button
                  variant="ghost"
                  className="tap-target text-label h-11 flex-1 text-text-secondary"
                  onClick={() => setFailOpen(true)}
                >
                  {t("delivery.markFailed")}
                </Button>
              ) : null}
              {canCancelDelivery(d.status) ? (
                <Button
                  variant="ghost"
                  className="tap-target text-label h-11 flex-1 text-text-secondary"
                  onClick={() => setCancelOpen(true)}
                >
                  {t("delivery.cancelDelivery")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </StickyActionBar>
      ) : null}

      <DeliveryReasonSheet
        open={failOpen}
        onOpenChange={setFailOpen}
        pending={markFailedMutation.isPending}
        title={t("delivery.failSheet.title")}
        body={t("delivery.failSheet.body")}
        reasonLabel={t("delivery.failSheet.reason")}
        submitLabel={t("delivery.failSheet.submit")}
        onConfirm={(reason) => markFailedMutation.mutate(reason)}
      />
      <DeliveryReasonSheet
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        pending={cancelMutation.isPending}
        title={t("delivery.cancelSheet.title")}
        body={t("delivery.cancelSheet.body")}
        reasonLabel={t("delivery.cancelSheet.reason")}
        submitLabel={t("delivery.cancelSheet.submit")}
        onConfirm={(reason) => cancelMutation.mutate(reason)}
      />
    </div>
  );
}

function MockDeliveryDetailScreen({ id }: { id: string }) {
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

  const showActions = failed || status === "in_transit";

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={t("delivery.title")} subtitle={delivery.trackingNumber} onBack={back} />

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
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-caption text-text-muted">{t("delivery.courier")}</p>
                <p className="text-h3 text-text-primary">{delivery.courierName}</p>
              </div>
              <StatusChip status={status} size="md" />
            </div>

            <div className="mt-3 border-t border-border-default pt-3">
              <DeliveryProgress status={status} />
            </div>

            {failed ? (
              <div className="mt-3 rounded-xl bg-status-danger-soft px-3 py-2">
                <p className="text-body-sm text-status-danger-text">{t("delivery.failed")}</p>
                {delivery.failureReason ? (
                  <p className="text-caption text-status-danger-text">
                    {t(`delivery.failReason.${delivery.failureReason}`)}
                  </p>
                ) : null}
              </div>
            ) : null}

            <SectionRows className="mt-3 border-t border-border-default pt-2">
              <SectionRow
                label={t("delivery.tracking")}
                value={<span className="tnum">{delivery.trackingNumber}</span>}
              />
              <SectionRow label={t("delivery.fee")} value={formatMoney(delivery.fee)} />
              {order ? (
                <SectionRow
                  label={t("delivery.viewOrder")}
                  value={
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
                      className="text-label tnum text-action-primary"
                    >
                      {order.code}
                    </button>
                  }
                />
              ) : null}
            </SectionRows>
          </div>
        </Section>

        {delivery.codAmount ? (
          <Section title={t("delivery.cod")}>
            <p className="text-financial-lg text-text-primary">{formatMoney(delivery.codAmount)}</p>
            <p className="text-body-sm mt-1 text-text-secondary">
              {delivery.codCollected ? t("delivery.codCollected") : t("delivery.codNotCollected")}
            </p>
            {delivery.settlementPending ? (
              <p className="text-body-sm mt-1 text-status-warning-text">
                {t("delivery.settlementPending")}
              </p>
            ) : null}
          </Section>
        ) : null}

        <Section title={t("delivery.address")}>
          {customer ? (
            <p className="text-body text-text-primary">{localName(customer, language)}</p>
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
        </Section>

        <Section title={t("delivery.history")}>
          <Timeline items={timelineItems} />
        </Section>
      </div>

      {showActions ? (
        <StickyActionBar aboveNav>
          {failed ? (
            <>
              <Button
                className="tap-target h-12 w-full"
                disabled={actionMutation.isPending}
                onClick={() => actionMutation.mutate("retry")}
              >
                {t("delivery.retry")}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="tap-target text-label h-11 flex-1 text-text-secondary"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate("reschedule")}
                >
                  {t("delivery.reschedule")}
                </Button>
                <Button
                  variant="ghost"
                  className="tap-target text-label h-11 flex-1 text-text-secondary"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate("return_to_shop")}
                >
                  {t("delivery.returnToShop")}
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="tap-target h-12 w-full"
              disabled={actionMutation.isPending}
              onClick={() => actionMutation.mutate("mark_delivered")}
            >
              {t("delivery.markDelivered")}
            </Button>
          )}
        </StickyActionBar>
      ) : null}
    </div>
  );
}
