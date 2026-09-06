import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AppHeader,
  ChannelBadge,
  DetailSkeleton,
  Screen,
  SecondaryAction,
  Section,
  SectionRow,
  SectionRows,
  SegmentedControl,
  StatusChip,
  StickyActionBar,
  Timeline,
  type Segment,
  type TimelineItem,
} from "@/design-system";

import { OperationalState } from "@/components/common/OperationalState";
import { addCustomerNote, getCustomer360 } from "@/lib/api";
import { fullTimestamp, initials, localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, usd } from "@/lib/money";
import type { CompanionColor, CustomerNote } from "@/types";

export const Route = createFileRoute("/app/customers/$id")({
  head: () => ({
    meta: [
      { title: "Customer 360 — APSA" },
      {
        name: "description",
        content:
          "Everything about one customer: contact details, orders, spending, history and team notes.",
      },
      { property: "og:title", content: "Customer 360 — APSA" },
      {
        property: "og:description",
        content: "Contact, orders, history and notes for a single customer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Customer360Screen,
});

const COMPANION_VAR: Record<CompanionColor, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

const TABS = ["overview", "orders", "timeline", "notes"] as const;
type Tab = (typeof TABS)[number];

function Customer360Screen() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [tab, setTab] = useState<Tab>("overview");
  const [noteDraft, setNoteDraft] = useState("");
  const [newNotes, setNewNotes] = useState<CustomerNote[]>([]);

  const query = useQuery({ queryKey: ["customer360", id], queryFn: () => getCustomer360(id) });

  const noteMutation = useMutation({
    mutationFn: (body: string) => addCustomerNote(id, body),
    onSuccess: (note) => {
      setNewNotes((n) => [note, ...n]);
      setNoteDraft("");
    },
  });

  // sensitiveVisible is server-authoritative: true = caller has customers.view_sensitive.
  // undefined on the mock data path — treat as visible (mock data is development-only).
  // Never use a hardcoded client-side role to decide this.
  const sensitiveVisible = query.data?.customer.sensitiveVisible !== false;

  const back = () => navigate({ to: "/app/inbox" });

  if (query.isLoading) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("customer360.title")} onBack={back} />
        <DetailSkeleton />
      </Screen>
    );
  }

  if (query.isError) {
    return (
      <Screen bottom="none" contentClassName="!px-0">
        <AppHeader title={t("customer360.title")} onBack={back} />
        <OperationalState
          title={t("customer360.notFound")}
          body={t("customer360.notFoundBody")}
          onRetry={() => query.refetch()}
        />
      </Screen>
    );
  }

  const { customer, orders, events, activeConversationId } = query.data!;
  const notes = [...newNotes, ...query.data!.notes];
  const displayName = localName(customer, language);
  const average =
    customer.orderCount > 0
      ? usd(Math.round(customer.lifetimeSpend.amount / customer.orderCount))
      : usd(0);

  const tabSegments: Segment<Tab>[] = TABS.map((key) => ({
    value: key,
    label: t(`customer360.${key}`),
    ...(key === "orders" && orders.length > 0 ? { count: orders.length } : {}),
    ...(key === "notes" && notes.length > 0 ? { count: notes.length } : {}),
  }));

  const timelineItems: TimelineItem[] = events.map((event) => ({
    id: event.id,
    title: t(`customer360.event.${event.kind}`),
    detail:
      event.context && ["facebook", "instagram", "telegram", "pos"].includes(event.context)
        ? t(`channel.${event.context}`)
        : (event.context ?? undefined),
    meta: fullTimestamp(event.at),
    tone: event.kind === "payment_confirmed" || event.kind === "delivered" ? "success" : "default",
  }));

  return (
    <div className="min-h-dvh bg-surface-page">
      <AppHeader title={displayName} subtitle={t("customer360.title")} onBack={back} />

      <div className="stack-section mx-auto max-w-[var(--screen-max)] px-4 pt-4 pb-[var(--space-screen-bottom)] lg:max-w-[var(--screen-max-wide)]">
        {/*
         * Identity first, then the two numbers that decide how to treat this
         * customer. Everything else is behind a tab — a phone screen of equally
         * weighted CRM fields tells a merchant nothing.
         */}
        <section className="elevation-2 rounded-[26px] border border-action-primary-border bg-[linear-gradient(168deg,rgba(255,255,255,0.98)_0%,rgba(234,242,254,0.92)_100%)] px-4 py-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="text-h3 flex size-14 shrink-0 items-center justify-center rounded-full text-text-inverse"
              style={{ backgroundColor: COMPANION_VAR[customer.companion] }}
            >
              {initials(displayName)}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-h1 truncate text-text-primary">{displayName}</h1>
              <p className="text-body-sm tnum text-text-secondary">
                {sensitiveVisible ? customer.phone || "—" : t("customer360.hidden")}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {customer.identities.map((identity) => (
                  <ChannelBadge key={identity.channel} channel={identity.channel} withLabel />
                ))}
              </div>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-action-primary-border/70 pt-3">
            <div className="min-w-0">
              <dt className="text-caption text-text-muted">{t("customer.spend")}</dt>
              <dd className="text-h2 tnum truncate text-text-primary">
                {sensitiveVisible ? formatMoney(customer.lifetimeSpend) : t("customer360.hidden")}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-caption text-text-muted">{t("customer.orders")}</dt>
              <dd className="text-h2 tnum truncate text-text-primary">{customer.orderCount}</dd>
            </div>
          </dl>
        </section>

        <SegmentedControl
          as="tabs"
          segments={tabSegments}
          value={tab}
          onChange={setTab}
          label={t("customer360.title")}
        />

        {tab === "overview" ? (
          <Section title={t("customer360.overview")}>
            <SectionRows>
              <SectionRow
                label={t("customer360.averageOrder")}
                value={sensitiveVisible ? formatMoney(average) : t("customer360.hidden")}
              />
              <SectionRow
                label={t("customer.lastPurchase")}
                value={customer.lastPurchaseAt ? fullTimestamp(customer.lastPurchaseAt) : "—"}
              />
              <SectionRow
                label={t("delivery.address")}
                value={
                  sensitiveVisible && customer.address
                    ? [
                        customer.address.houseNo,
                        customer.address.street,
                        customer.address.sangkat,
                        customer.address.khan,
                        customer.address.city,
                      ].join(", ")
                    : sensitiveVisible
                      ? t("delivery.noAddress")
                      : t("customer360.hidden")
                }
              />
            </SectionRows>

            {customer.tags.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border-default pt-3">
                {customer.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-caption chip-text rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </Section>
        ) : null}

        {tab === "orders" ? (
          orders.length === 0 ? (
            <OperationalState
              title={t("customer360.noOrders")}
              body={t("customer360.noOrdersBody")}
            />
          ) : (
            <Section title={t("customer360.orders")} bodyClassName="!px-0">
              <ul className="divide-y divide-border-default">
                {orders.map((order) => (
                  <li key={order.id}>
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/app/orders/$id", params: { id: order.id } })}
                      className="tap-target flex w-full items-start gap-3 px-4 py-3 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-body-sm tnum text-text-primary">{order.code}</p>
                        <p className="text-caption text-text-muted">
                          {fullTimestamp(order.createdAt)}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <StatusChip status={order.paymentStatus} />
                          <StatusChip status={order.fulfillmentStatus} />
                        </div>
                      </div>
                      <span className="text-financial shrink-0 text-text-primary">
                        {formatMoney(order.total)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )
        ) : null}

        {tab === "timeline" ? (
          timelineItems.length === 0 ? (
            <OperationalState
              title={t("customer360.noTimeline")}
              body={t("customer360.noTimelineBody")}
            />
          ) : (
            <Section title={t("customer360.timeline")}>
              <Timeline items={timelineItems} />
            </Section>
          )
        ) : null}

        {tab === "notes" ? (
          <Section title={t("customer360.notes")}>
            <div className="flex flex-col gap-2">
              <Input
                aria-label={t("customer360.addNote")}
                placeholder={t("customer360.notePlaceholder")}
                className="h-12 rounded-2xl border-border-default"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
              <Button
                className="press tap-target h-12 w-full rounded-2xl"
                disabled={!noteDraft.trim() || noteMutation.isPending}
                onClick={() => noteMutation.mutate(noteDraft.trim())}
              >
                {noteMutation.isPending ? t("common.loading") : t("customer360.saveNote")}
              </Button>
            </div>

            {notes.length === 0 ? (
              <p className="text-body-sm mt-3 text-text-secondary">
                {t("customer360.noNotesBody")}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-xl bg-surface-secondary px-3 py-2">
                    <p className="text-body-sm text-text-primary">{note.body}</p>
                    <p className="text-caption mt-1 text-text-muted">
                      {note.staffName} · {fullTimestamp(note.at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}
      </div>

      <StickyActionBar
        {...(activeConversationId
          ? {
              secondary: (
                <SecondaryAction onClick={() => navigate({ to: "/app/pos" })}>
                  {t("customer360.createOrder")}
                </SecondaryAction>
              ),
            }
          : {})}
      >
        <Button
          className="press-tactile tap-target elevation-action h-12 w-full rounded-2xl"
          onClick={() =>
            activeConversationId
              ? navigate({ to: "/app/inbox/$id", params: { id: activeConversationId } })
              : navigate({ to: "/app/pos" })
          }
        >
          {activeConversationId ? t("customer360.openConversation") : t("customer360.createOrder")}
        </Button>
      </StickyActionBar>
    </div>
  );
}
