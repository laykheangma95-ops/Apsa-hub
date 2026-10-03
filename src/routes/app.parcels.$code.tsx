import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Package,
  ShoppingCart,
  User,
  Truck,
  MapPin,
  MessageCircle,
  CreditCard,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
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
import { resolveParcelIdentityFn } from "@/api/parcel-resolution";
import { findCustomerConversationFn } from "@/api/customer-conversation";
import { isProductionId } from "@/lib/api";
import { fullTimestamp } from "@/lib/format";
import { parcelStatusChipKey } from "@/lib/parcel-status";
import { cn } from "@/lib/utils";
import type { StatusKey } from "@/types";

export const Route = createFileRoute("/app/parcels/$code")({
  head: () => ({
    meta: [
      { title: "Parcel Investigation — APSA" },
      {
        name: "description",
        content:
          "Scan result: parcel identity, order, customer, delivery and shipping at a glance.",
      },
      { property: "og:title", content: "Parcel Investigation — APSA" },
      {
        property: "og:description",
        content: "One-page operational summary after scanning a parcel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ParcelInvestigationScreen,
});

function ParcelInvestigationScreen() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const query = useQuery({
    queryKey: ["parcel-investigation", code],
    queryFn: () => resolveParcelIdentityFn({ data: { parcelCode: code } }),
    retry: false,
  });

  const customerId = query.data?.customer?.id ?? null;
  const conversationQuery = useQuery({
    queryKey: ["customer-conversation", customerId],
    queryFn: () => findCustomerConversationFn({ data: { customerId: customerId! } }),
    enabled: Boolean(customerId) && isProductionId(customerId ?? ""),
  });
  const activeConversationId = conversationQuery.data?.conversationId ?? null;

  const back = () => navigate({ to: "/app" });

  if (query.isLoading) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("parcelInvestigation.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    const errorMessage = (query.error as Error | undefined)?.message ?? "";
    const isDenied =
      errorMessage.includes("Not authenticated") ||
      errorMessage.includes("Forbidden") ||
      errorMessage.includes("No active organization");

    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("parcelInvestigation.title")} onBack={back} />
        <OperationalState
          tone="danger"
          title={
            isDenied ? t("parcelInvestigation.denied.title") : t("parcelInvestigation.error.title")
          }
          body={
            isDenied ? t("parcelInvestigation.denied.body") : t("parcelInvestigation.error.body")
          }
          {...(isDenied ? {} : { onRetry: () => query.refetch() })}
        />
      </Screen>
    );
  }

  const result = query.data;

  if (!result) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("parcelInvestigation.title")} onBack={back} />
        <OperationalState
          title={t("parcelInvestigation.notFound.title")}
          body={t("parcelInvestigation.notFound.body")}
        />
      </Screen>
    );
  }

  const isVoid = result.parcel.status === "void";

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader
        title={t("parcelInvestigation.title")}
        subtitle={result.parcel.parcelCode}
        onBack={back}
      />

      <div
        className={cn(
          "content-in stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 lg:max-w-[var(--screen-max-wide)]",
          "pb-[var(--space-screen-bottom)]",
        )}
      >
        {isVoid ? (
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
                  {t("parcelInvestigation.void.title")}
                </p>
                <p className="text-body-sm mt-0.5 text-text-secondary">
                  {t("parcelInvestigation.void.body")}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <Section title={t("parcelInvestigation.parcel")}>
          <SectionRows>
            <SectionRow
              label={t("parcelInvestigation.parcelCode")}
              value={result.parcel.parcelCode}
            />
            <SectionRow
              label={t("parcelInvestigation.parcelStatus")}
              value={
                // Parcel status is its own domain (created | void), not a
                // StatusKey. Anything outside it — even a string that happens
                // to be another domain's StatusKey — renders "unknown status".
                <StatusChip status={parcelStatusChipKey(result.parcel.status)} />
              }
            />
            <SectionRow
              label={t("parcelInvestigation.created")}
              value={fullTimestamp(result.parcel.createdAt)}
            />
          </SectionRows>
        </Section>

        <Section title={t("parcelInvestigation.order")}>
          <SectionRows>
            <SectionRow
              label={t("parcelInvestigation.orderNumber")}
              value={result.order.orderNumber}
            />
            <SectionRow
              label={t("parcelInvestigation.lifecycle")}
              value={<StatusChip status={result.order.lifecycleStatus as StatusKey} />}
            />
            <SectionRow
              label={t("parcelInvestigation.fulfillment")}
              value={<StatusChip status={result.order.fulfillmentStatus as StatusKey} />}
            />
            <SectionRow
              label={t("parcelInvestigation.payment")}
              value={<StatusChip status={result.order.paymentStatus as StatusKey} />}
            />
          </SectionRows>
        </Section>

        <Section title={t("parcelInvestigation.customer")}>
          {result.customer ? (
            <SectionRows>
              <SectionRow label="ID" value={result.customer.id} />
            </SectionRows>
          ) : (
            <p className="text-body-sm text-text-secondary">
              {t("parcelInvestigation.noCustomer")}
            </p>
          )}
        </Section>

        <Section title={t("parcelInvestigation.delivery")}>
          {result.delivery ? (
            <SectionRows>
              <SectionRow
                label={t("parcelInvestigation.parcelStatus")}
                value={<StatusChip status={result.delivery.status as StatusKey} />}
              />
              <SectionRow
                label={t("parcelInvestigation.provider")}
                value={result.delivery.providerName}
              />
              {result.delivery.externalTrackingNumber ? (
                <SectionRow
                  label={t("parcelInvestigation.tracking")}
                  value={result.delivery.externalTrackingNumber}
                />
              ) : null}
            </SectionRows>
          ) : (
            <p className="text-body-sm text-text-secondary">
              {t("parcelInvestigation.noDelivery")}
            </p>
          )}
        </Section>

        <Section title={t("parcelInvestigation.shippingSnapshot")}>
          <SectionRows>
            <SectionRow
              label={t("parcelInvestigation.hasName")}
              value={<ShippingPresenceIndicator present={result.shippingSnapshot.hasName} />}
            />
            <SectionRow
              label={t("parcelInvestigation.hasPhone")}
              value={<ShippingPresenceIndicator present={result.shippingSnapshot.hasPhone} />}
            />
            <SectionRow
              label={t("parcelInvestigation.hasAddress")}
              value={<ShippingPresenceIndicator present={result.shippingSnapshot.hasAddress} />}
            />
          </SectionRows>
        </Section>

        <Section title={t("parcelInvestigation.navigation")}>
          <nav aria-label={t("parcelInvestigation.navigation")}>
            <ul className="divide-y divide-border-default">
              <QuickNavItem
                to="/app/orders/$id"
                params={{ id: result.order.id }}
                icon={<ShoppingCart className="size-5" aria-hidden />}
                label={t("parcelInvestigation.viewOrder")}
              />

              {result.customer ? (
                <QuickNavItem
                  to="/app/customers/$id"
                  params={{ id: result.customer.id }}
                  icon={<User className="size-5" aria-hidden />}
                  label={t("parcelInvestigation.viewCustomer")}
                />
              ) : null}

              {result.delivery ? (
                <QuickNavItem
                  to="/app/deliveries/$id"
                  params={{ id: result.delivery.id }}
                  icon={<Truck className="size-5" aria-hidden />}
                  label={t("parcelInvestigation.viewDelivery")}
                />
              ) : null}

              {activeConversationId ? (
                <QuickNavItem
                  to="/app/inbox/$id"
                  params={{ id: activeConversationId }}
                  icon={<MessageCircle className="size-5" aria-hidden />}
                  label={t("parcelInvestigation.openConversation")}
                />
              ) : result.customer ? (
                <PlaceholderNavItem
                  icon={<MessageCircle className="size-5" aria-hidden />}
                  label={t("parcelInvestigation.conversation")}
                  hint={t("parcelInvestigation.noConversation")}
                />
              ) : null}

              <PlaceholderNavItem
                icon={<CreditCard className="size-5" aria-hidden />}
                label={t("parcelInvestigation.paymentAction")}
                hint={t("parcelInvestigation.paymentPlaceholder")}
              />
            </ul>
          </nav>
        </Section>
      </div>
    </div>
  );
}

function ShippingPresenceIndicator({ present }: { present: boolean }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        present ? "text-status-success-text" : "text-status-warning-text",
      )}
    >
      {present ? (
        <CheckCircle2 className="size-3.5" aria-hidden />
      ) : (
        <XCircle className="size-3.5" aria-hidden />
      )}
      <span className="text-body-sm">
        {present ? t("parcelInvestigation.present") : t("parcelInvestigation.missing")}
      </span>
    </span>
  );
}

function QuickNavItem({
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
        <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
      </Link>
    </li>
  );
}

function PlaceholderNavItem({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <li>
      <div className="flex items-center gap-3 py-3 opacity-50" aria-disabled>
        <span className="text-text-muted">{icon}</span>
        <span className="text-label min-w-0 flex-1 text-text-muted">{label}</span>
        <span className="text-caption shrink-0 text-text-muted">{hint}</span>
      </div>
    </li>
  );
}
