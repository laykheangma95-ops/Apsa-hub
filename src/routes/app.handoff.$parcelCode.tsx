import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, ShoppingCart, Truck, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  DetailSkeleton,
  Screen,
  Section,
  SectionRow,
  SectionRows,
  StatusChip,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { HandoffPreviewAccess } from "@/components/handoff/HandoffPreviewAccess";
import { Button } from "@/components/ui/button";
import { useCapabilities, useSensitiveCapabilityRevalidation } from "@/hooks/use-capabilities";
import { getHandoffPreviewFn, confirmHandoffFn } from "@/api/handoff";
import {
  canConfirmHandoff,
  isAlreadyHandedOff,
  handoffErrorMessage,
  handoffReasonMessage,
} from "@/lib/handoff";
import type { HandoffResult, HandoffPreview as HandoffPreviewType } from "@/lib/handoff";
import { handoffKeys, syncHandoffResultCaches } from "@/lib/handoff-query";
import { fullTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { StatusKey } from "@/types";

export const Route = createFileRoute("/app/handoff/$parcelCode")({
  head: () => ({
    meta: [
      { title: "Courier Handoff — APSA" },
      {
        name: "description",
        content: "Confirm parcel handoff to courier.",
      },
    ],
  }),
  component: CourierHandoffScreen,
});

function CourierHandoffScreen() {
  const { parcelCode } = Route.useParams();
  const { session, organizationId } = Route.useRouteContext();
  const navigate = useNavigate();

  return (
    <CourierHandoffIdentityBoundary
      userId={session.userId}
      organizationId={organizationId}
      parcelCode={parcelCode}
      onBack={() => navigate({ to: "/app" })}
    />
  );
}

interface CourierHandoffIdentityProps {
  userId: string;
  organizationId: string;
  parcelCode: string;
  onBack: () => void;
}

/**
 * React preserves hook state while a component type stays in the same tree.
 * Key the stateful operation by every identity dimension so a parcel, account,
 * or organization change mounts a clean mutation/result state before paint.
 */
export function CourierHandoffIdentityBoundary(props: CourierHandoffIdentityProps) {
  const identity = `${props.userId}\u0000${props.organizationId}\u0000${props.parcelCode}`;
  return <CourierHandoffOperation key={identity} {...props} />;
}

export function CourierHandoffOperation({
  userId,
  organizationId,
  parcelCode,
  onBack,
}: CourierHandoffIdentityProps) {
  const capabilities = useCapabilities();
  const canHandoff = capabilities.canSensitive("delivery.handoff");

  // staleTime never initiates a refresh by itself. Keep the production
  // capability query polling for the entire time this operational screen is
  // mounted, including while a confirmation is in flight.
  useSensitiveCapabilityRevalidation(userId, organizationId, true);

  // A capability change also remounts the stateful layer. Revocation therefore
  // drops any success, failure, or pending mutation before a later re-grant can
  // render, while the capability revalidator above remains mounted.
  return (
    <CourierHandoffState
      key={canHandoff ? "allowed" : "denied"}
      userId={userId}
      organizationId={organizationId}
      parcelCode={parcelCode}
      onBack={onBack}
      canHandoff={canHandoff}
    />
  );
}

function CourierHandoffState({
  userId,
  organizationId,
  parcelCode,
  onBack,
  canHandoff,
}: CourierHandoffIdentityProps & { canHandoff: boolean }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [handoffResult, setHandoffResult] = useState<HandoffResult | null>(null);

  const previewQuery = useQuery({
    queryKey: handoffKeys.preview(userId, organizationId, parcelCode),
    queryFn: () => getHandoffPreviewFn({ data: { parcelCode } }),
    enabled: canHandoff,
    retry: false,
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmHandoffFn({ data: { parcelCode } }),
    onSuccess: (result) => {
      setHandoffResult(result);
      void syncHandoffResultCaches(queryClient, userId, organizationId, parcelCode, result);
    },
  });

  const denied = (
    <Screen bottom="none" contentClassName="!px-0">
      <AppHeader title={t("courierHandoff.title")} onBack={onBack} />
      <OperationalState
        tone="danger"
        title={t("courierHandoff.denied.title")}
        body={t("courierHandoff.denied.body")}
      />
    </Screen>
  );

  const renderAuthorizedState = () => {
    if (previewQuery.isLoading) {
      return (
        <Screen bottom="none" contentClassName="!px-0">
          <AppHeader title={t("courierHandoff.title")} onBack={onBack} />
          <DetailSkeleton />
        </Screen>
      );
    }

    if (previewQuery.isError) {
      const errorMessage = (previewQuery.error as Error | undefined)?.message ?? "";
      const isDenied =
        errorMessage.includes("Not authenticated") ||
        errorMessage.includes("Forbidden") ||
        errorMessage.includes("No active organization");

      return (
        <Screen bottom="none" contentClassName="!px-0">
          <AppHeader title={t("courierHandoff.title")} onBack={onBack} />
          <OperationalState
            tone="danger"
            title={isDenied ? t("courierHandoff.denied.title") : t("courierHandoff.error.title")}
            body={isDenied ? t("courierHandoff.denied.body") : t("courierHandoff.error.body")}
            {...(isDenied ? {} : { onRetry: () => previewQuery.refetch() })}
          />
        </Screen>
      );
    }

    const preview = previewQuery.data;

    if (!preview) {
      return (
        <Screen bottom="none" contentClassName="!px-0">
          <AppHeader title={t("courierHandoff.title")} onBack={onBack} />
          <OperationalState
            title={t("courierHandoff.notFound.title")}
            body={t("courierHandoff.notFound.body")}
          />
        </Screen>
      );
    }

    if (handoffResult?.kind === "success") {
      return <HandoffSuccess handoff={handoffResult.handoff} onBack={onBack} />;
    }

    return (
      <HandoffPreviewView
        preview={preview}
        canHandoff={canHandoff}
        confirming={confirmMutation.isPending}
        error={
          handoffResult
            ? handoffErrorMessage(handoffResult, t)
            : confirmMutation.isError
              ? t("courierHandoff.error.body")
              : null
        }
        onConfirm={() => confirmMutation.mutate()}
        onBack={onBack}
      />
    );
  };

  return (
    <HandoffPreviewAccess
      userId={userId}
      organizationId={organizationId}
      allowed={canHandoff}
      denied={denied}
    >
      {renderAuthorizedState}
    </HandoffPreviewAccess>
  );
}

function HandoffPreviewView({
  preview,
  canHandoff,
  confirming,
  error,
  onConfirm,
  onBack,
}: {
  preview: HandoffPreviewType;
  canHandoff: boolean;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const eligible = canHandoff && canConfirmHandoff(preview);
  const alreadyDone = isAlreadyHandedOff(preview);

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader
        title={t("courierHandoff.title")}
        subtitle={t("courierHandoff.subtitle")}
        onBack={onBack}
      />

      <div
        className={cn(
          "content-in stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
          "pb-[var(--space-screen-bottom)]",
        )}
      >
        {!eligible && preview.reason ? (
          <div
            role="alert"
            className="rounded-2xl border border-status-warning-border bg-status-warning-soft px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-status-warning-text"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-label text-status-warning-text">
                  {alreadyDone
                    ? t("courierHandoff.duplicateHandoff.title")
                    : t("courierHandoff.notEligible")}
                </p>
                <p className="text-body-sm mt-0.5 text-text-secondary">
                  {handoffReasonMessage(preview.reason, t)}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-status-danger-border bg-status-danger-soft px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-status-danger-text"
                aria-hidden
              />
              <p className="text-body-sm text-status-danger-text">{error}</p>
            </div>
          </div>
        ) : null}

        <Section title={t("courierHandoff.parcel")}>
          <SectionRows>
            <SectionRow label={t("courierHandoff.parcelCode")} value={preview.parcelCode} />
            <SectionRow
              label={t("courierHandoff.handoffStatus")}
              value={
                <StatusChip
                  status={
                    (eligible ? "ready" : alreadyDone ? "in_transit" : "pending") as StatusKey
                  }
                />
              }
            />
          </SectionRows>
        </Section>

        <Section title={t("courierHandoff.order")}>
          <SectionRows>
            <SectionRow label={t("courierHandoff.orderNumber")} value={preview.orderNumber} />
          </SectionRows>
        </Section>

        <Section title={t("courierHandoff.courier")}>
          <SectionRows>
            <SectionRow
              label={t("courierHandoff.providerName")}
              value={preview.providerName || "—"}
            />
            <SectionRow
              label={t("courierHandoff.trackingNumber")}
              value={preview.externalTrackingNumber || t("courierHandoff.noTrackingNumber")}
            />
            <SectionRow
              label={t("courierHandoff.deliveryStatus")}
              value={<StatusChip status={preview.deliveryStatus as StatusKey} />}
            />
          </SectionRows>
        </Section>

        {eligible ? (
          <div className="pt-2">
            <Button className="tap-target h-12 w-full" onClick={onConfirm} disabled={confirming}>
              {confirming ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t("courierHandoff.confirming")}
                </span>
              ) : (
                t("courierHandoff.confirm")
              )}
            </Button>
          </div>
        ) : null}

        {preview.orderId ? (
          <Section title="">
            <nav>
              <ul className="divide-y divide-border-default">
                <NavItem
                  to="/app/orders/$id"
                  params={{ id: preview.orderId }}
                  icon={<ShoppingCart className="size-5" aria-hidden />}
                  label={t("courierHandoff.viewOrder")}
                />
                {preview.deliveryId ? (
                  <NavItem
                    to="/app/deliveries/$id"
                    params={{ id: preview.deliveryId }}
                    icon={<Truck className="size-5" aria-hidden />}
                    label={t("courierHandoff.viewDelivery")}
                  />
                ) : null}
              </ul>
            </nav>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function HandoffSuccess({
  handoff,
  onBack,
}: {
  handoff: {
    parcelCode: string;
    orderNumber: string;
    providerName: string;
    externalTrackingNumber: string | null;
    handedOffAt: string;
    orderId: string;
    deliveryId: string;
  };
  onBack: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={t("courierHandoff.title")} onBack={onBack} />

      <div
        className={cn(
          "content-in stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
          "pb-[var(--space-screen-bottom)]",
        )}
      >
        <div className="rounded-2xl border border-status-success-border bg-status-success-soft px-4 py-5 text-center">
          <CheckCircle2 className="mx-auto mb-2 size-8 text-status-success-text" aria-hidden />
          <h3 className="text-h3 text-status-success-text">{t("courierHandoff.success.title")}</h3>
          <p className="text-body-sm mt-1 text-text-secondary">
            {t("courierHandoff.success.body")}
          </p>
        </div>

        <Section title={t("courierHandoff.parcel")}>
          <SectionRows>
            <SectionRow label={t("courierHandoff.parcelCode")} value={handoff.parcelCode} />
            <SectionRow label={t("courierHandoff.orderNumber")} value={handoff.orderNumber} />
            <SectionRow label={t("courierHandoff.providerName")} value={handoff.providerName} />
            {handoff.externalTrackingNumber ? (
              <SectionRow
                label={t("courierHandoff.trackingNumber")}
                value={handoff.externalTrackingNumber}
              />
            ) : null}
            <SectionRow
              label={t("courierHandoff.handoffTime")}
              value={fullTimestamp(handoff.handedOffAt)}
            />
          </SectionRows>
        </Section>

        <Section title="">
          <nav>
            <ul className="divide-y divide-border-default">
              <NavItem
                to="/app/orders/$id"
                params={{ id: handoff.orderId }}
                icon={<ShoppingCart className="size-5" aria-hidden />}
                label={t("courierHandoff.viewOrder")}
              />
              <NavItem
                to="/app/deliveries/$id"
                params={{ id: handoff.deliveryId }}
                icon={<Truck className="size-5" aria-hidden />}
                label={t("courierHandoff.viewDelivery")}
              />
            </ul>
          </nav>
        </Section>

        <div className="pt-2">
          <Button variant="outline" className="tap-target h-12 w-full" onClick={onBack}>
            {t("courierHandoff.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  to,
  params,
  icon,
  label,
}: {
  to: string;
  params: Record<string, string>;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <Link
        to={to as never}
        params={params as never}
        className="press tap-target flex w-full items-center gap-3 py-3 text-left"
      >
        <span className="text-text-secondary">{icon}</span>
        <span className="text-label min-w-0 flex-1 text-action-primary">{label}</span>
        <Package className="size-4 shrink-0 text-text-muted" aria-hidden />
      </Link>
    </li>
  );
}
