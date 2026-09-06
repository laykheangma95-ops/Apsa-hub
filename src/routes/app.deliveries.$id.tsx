import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  DetailSkeleton,
  InlineAction,
  Screen,
  SecondaryAction,
  Section,
  SectionRow,
  SectionRows,
  StatusChip,
  StatusHero,
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
import { cn } from "@/lib/utils";
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
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    const kind = classifyDeliveryError(query.error);
    if (kind === "unauthorized") return null; // redirecting, see the effect above
    const copy = errorCopy(kind);
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <OperationalState
          tone="danger"
          title={copy.title}
          body={copy.body}
          onRetry={() => query.refetch()}
        />
      </Screen>
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

  /*
   * A delivery has exactly one forward move at a time — the state machine says
   * so. The old bar stacked up to four equally loud full-width buttons and left
   * the merchant to work out which one was next; the transition that is legal
   * now becomes the primary action, and the ways out stay quiet.
   */
  const advanceAction = canStartPreparingDelivery(d.status)
    ? { label: t("delivery.startPreparing"), run: () => startPreparingMutation.mutate() }
    : canMarkDeliveryReady(d.status)
      ? { label: t("delivery.markReady"), run: () => markReadyMutation.mutate() }
      : canMarkDeliveryInTransit(d.status)
        ? { label: t("delivery.markInTransit"), run: () => markInTransitMutation.mutate() }
        : canMarkDeliveryDelivered(d.status)
          ? { label: t("delivery.markDelivered"), run: () => markDeliveredMutation.mutate() }
          : null;

  const exitActions = [
    canMarkDeliveryFailed(d.status)
      ? { key: "failed", label: t("delivery.markFailed"), open: () => setFailOpen(true) }
      : null,
    canCancelDelivery(d.status)
      ? { key: "cancel", label: t("delivery.cancel"), open: () => setCancelOpen(true) }
      : null,
  ].filter(Boolean) as { key: string; label: string; open: () => void }[];

  const hasActions = Boolean(advanceAction) || exitActions.length > 0;

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader
        title={t("delivery.title")}
        subtitle={d.externalTrackingNumber ?? undefined}
        onBack={back}
      />

      <div
        className={cn(
          "stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
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
         * Courier and state read first; the details and COD blocks below stay
         * quiet and secondary. The hero deliberately carries no COD figure —
         * COD is an operational amount to collect, never a payment signal, and
         * it keeps its own labelled section so it cannot be read as one.
         */}
        <StatusHero
          eyebrow={t("delivery.courier")}
          headline={<p className="text-h1 truncate text-text-primary">{d.providerName}</p>}
          support={
            d.externalTrackingNumber ? (
              <span className="tnum">
                {t("delivery.tracking")}: {d.externalTrackingNumber}
              </span>
            ) : (
              t("delivery.noTracking")
            )
          }
          primaryStatus={d.status}
        />

        <Section title={t("delivery.detailsTitle")}>
          <SectionRows>
            {order ? (
              <SectionRow
                label={t("delivery.viewOrder")}
                value={
                  <InlineAction
                    numeric
                    onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
                  >
                    {order.code}
                  </InlineAction>
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

      {hasActions ? (
        <StickyActionBar
          {...(exitActions.length > 0
            ? {
                secondary: exitActions.map((action) => (
                  <SecondaryAction
                    key={action.key}
                    tone="danger"
                    disabled={anyPending}
                    onClick={action.open}
                  >
                    {action.label}
                  </SecondaryAction>
                )),
              }
            : {})}
        >
          {advanceAction ? (
            <Button
              className="press-tactile tap-target elevation-action h-12 w-full rounded-2xl"
              disabled={anyPending}
              onClick={advanceAction.run}
            >
              {anyPending ? t("common.loading") : advanceAction.label}
            </Button>
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
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("delivery.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    const denied = (query.error as Error).message === PERMISSION_DENIED;
    return (
      <Screen bottom="none" contentClassName="!px-0">
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
      </Screen>
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
        event.status === "delivered" ? "success" : event.status === "failed" ? "danger" : "default",
    }));

  const showActions = failed || status === "in_transit";

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={t("delivery.title")} subtitle={delivery.trackingNumber} onBack={back} />

      <div
        className={cn(
          "stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
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

        <StatusHero
          eyebrow={t("delivery.courier")}
          headline={<p className="text-h1 truncate text-text-primary">{delivery.courierName}</p>}
          support={
            <span className="tnum">
              {t("delivery.tracking")}: {delivery.trackingNumber}
            </span>
          }
          primaryStatus={status}
          {...(delivery.codAmount
            ? { nextStep: t("delivery.codDue", { amount: formatMoney(delivery.codAmount) }) }
            : {})}
        />

        <Section title={t("delivery.progress")}>
          <DeliveryProgress status={status} />
        </Section>

        {failed ? (
          <div
            role="alert"
            className="rounded-2xl border border-status-danger-soft bg-status-danger-soft px-4 py-3"
          >
            <p className="text-label text-status-danger-text">{t("delivery.failed")}</p>
            {delivery.failureReason ? (
              <p className="text-body-sm mt-0.5 text-status-danger-text">
                {t(`delivery.failReason.${delivery.failureReason}`)}
              </p>
            ) : null}
          </div>
        ) : null}

        <Section title={t("delivery.detailsTitle")}>
          <SectionRows>
            <SectionRow label={t("delivery.fee")} value={formatMoney(delivery.fee)} />
            {order ? (
              <SectionRow
                label={t("delivery.viewOrder")}
                value={
                  <InlineAction
                    numeric
                    onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
                  >
                    {order.code}
                  </InlineAction>
                }
              />
            ) : null}
          </SectionRows>
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
        <StickyActionBar
          {...(failed
            ? {
                secondary: (
                  <>
                    <SecondaryAction
                      disabled={actionMutation.isPending}
                      onClick={() => actionMutation.mutate("reschedule")}
                    >
                      {t("delivery.reschedule")}
                    </SecondaryAction>
                    <SecondaryAction
                      disabled={actionMutation.isPending}
                      onClick={() => actionMutation.mutate("return_to_shop")}
                    >
                      {t("delivery.returnToShop")}
                    </SecondaryAction>
                  </>
                ),
              }
            : {})}
        >
          <Button
            className="press-tactile tap-target elevation-action h-12 w-full rounded-2xl"
            disabled={actionMutation.isPending}
            onClick={() => actionMutation.mutate(failed ? "retry" : "mark_delivered")}
          >
            {actionMutation.isPending
              ? t("common.loading")
              : failed
                ? t("delivery.retry")
                : t("delivery.markDelivered")}
          </Button>
        </StickyActionBar>
      ) : null}
    </div>
  );
}
