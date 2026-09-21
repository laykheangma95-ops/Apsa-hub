import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useCapabilities } from "@/hooks/use-capabilities";
import { addCustomerNote, getCustomer360, getCustomerOrders, isProductionId } from "@/lib/api";
import { customerKeys, customerSensitiveVisible } from "@/lib/customers-query";
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
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  /*
   * Cache identity from the /app route guard's server-derived context. This is
   * the most sensitive payload the app caches — a phone number, a delivery
   * address, lifetime spend — and it was keyed on the customer id alone, so it
   * survived a sign-out in the same tab and could be read straight back by the
   * next principal to open the same URL.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;

  const [tab, setTab] = useState<Tab>("overview");
  const [noteDraft, setNoteDraft] = useState("");
  const [newNotes, setNewNotes] = useState<CustomerNote[]>([]);

  const detailKey = customerKeys.detail(userId, routeOrganizationId, id);
  const query = useQuery({ queryKey: detailKey, queryFn: () => getCustomer360(id) });

  /*
   * A production customer and a pre-production mock id are two different
   * sources here, and conflating them is what made this screen lie.
   *
   * getCustomer360() answers a UUID from the server, which returns `orders: []`
   * STRUCTURALLY — "Orders and events remain empty until their domains are
   * productionized" (src/server/customers/service.ts) — not because the
   * customer has none. Rendering that as "No orders yet" told the merchant
   * something the screen had never asked the server. It also contradicted
   * CustomerDetailSheet, which shows the same customer's real history.
   *
   * The real history comes from the same production read that sheet uses:
   * getCustomerOrders() -> listOrdersFn, which filters by customerId in SQL
   * and is scoped by the server to the organization it resolved from the
   * caller's membership. No new backend, no parallel endpoint, and the key is
   * this customer's own `orders` sub-key so a customer purge takes it along.
   *
   * A non-UUID mock id keeps its existing in-memory path untouched — that
   * branch really does carry fixture orders, counts and spend.
   */
  const isRealCustomer = isProductionId(id);
  // listOrders requires orders.read server-side; without it there is no
  // honest version of this tab, so say so rather than imply "none".
  const canReadOrders = capabilities.can("orders.read");

  const ordersQuery = useQuery({
    queryKey: customerKeys.orders(userId, routeOrganizationId, id),
    queryFn: () => getCustomerOrders(id),
    enabled: isRealCustomer && canReadOrders,
  });

  const noteMutation = useMutation({
    mutationFn: (body: string) => addCustomerNote(id, body),
    onSuccess: (note) => {
      setNewNotes((n) => [note, ...n]);
      setNoteDraft("");
      /*
       * Refresh this customer's own cached profile — and only this principal's
       * copy of it. The optimistic prepend above keeps the new note on screen
       * meanwhile; the invalidation is what reconciles it with the server's
       * authored/authored-by values. The refetched payload will include this
       * SAME note (same id), which is why `notes` below dedupes rather than
       * concatenating the two sources outright.
       */
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });
  const noteSaveFailed = noteMutation.isError;

  /*
   * Both answers must say yes, and this is why:
   *
   *   1. `customers.view_sensitive` as it stands RIGHT NOW. `canSensitive`,
   *      not `can` — a phone number's mere display is the disclosure, so it
   *      must not ride on a capability snapshot whose latest refresh failed.
   *   2. What the SERVER decided when it built this payload
   *      (`sensitiveVisible`), which is authoritative and is never overridden
   *      by a client-side read.
   *
   * Reading (2) alone — which is what this screen did — is the same
   * stale-cache class PR #59 found in Payments: a profile fetched while the
   * grant held keeps saying `sensitiveVisible: true` forever, and nothing
   * purges or refetches it when the grant is revoked mid-session, because
   * capabilities and customer data are two independent queries. With (1) in
   * front, the phone, address and spend disappear on the very next render.
   */
  const sensitiveVisible = customerSensitiveVisible(
    query.data?.customer,
    capabilities.canSensitive("customers.view_sensitive"),
  );

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

  const { customer, events, activeConversationId } = query.data!;
  const serverNoteIds = new Set(query.data!.notes.map((n) => n.id));
  const notes = [...newNotes.filter((n) => !serverNoteIds.has(n.id)), ...query.data!.notes];
  const displayName = localName(customer, language);

  /*
   * Real customers read their history from the Order domain above; the mock
   * branch keeps the fixture list the payload carries.
   */
  const orders = isRealCustomer ? (ordersQuery.data ?? []) : query.data!.orders;
  const ordersUnavailable = isRealCustomer && !canReadOrders;

  /*
   * `orderCount` and `lifetimeSpend` are hardcoded to zero by the server for
   * every production customer, alongside the structural `orders: []`. They are
   * placeholders, not measurements, so this screen must not print them as
   * figures — "Orders 0" and "Spend $0.00" above a non-empty order list is the
   * same false claim in a different place.
   *
   * They are also not derivable here: the history above is capped at
   * CUSTOMER_ORDER_HISTORY_LIMIT rows, so counting or summing it would invent
   * a lifetime total out of one page. Deriving a wrong number is not an
   * improvement on withholding one, so these show an explicit "—" until the
   * server computes them.
   */
  const metricsAuthoritative = !isRealCustomer;
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
                {!metricsAuthoritative
                  ? "—"
                  : sensitiveVisible
                    ? formatMoney(customer.lifetimeSpend)
                    : t("customer360.hidden")}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-caption text-text-muted">{t("customer.orders")}</dt>
              <dd className="text-h2 tnum truncate text-text-primary">
                {metricsAuthoritative ? customer.orderCount : "—"}
              </dd>
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
                value={
                  !metricsAuthoritative
                    ? "—"
                    : sensitiveVisible
                      ? formatMoney(average)
                      : t("customer360.hidden")
                }
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

        {/*
         * Order of these branches is the whole point. "No orders yet" is an
         * affirmative claim about this customer, so it may only render once
         * the real query has actually SUCCEEDED and come back empty. Never
         * asked (no orders.read), still loading, or failed each get their own
         * honest state instead.
         */}
        {tab === "orders" ? (
          ordersUnavailable ? (
            <OperationalState
              title={t("customer360.ordersUnavailable")}
              body={t("customer360.ordersUnavailableBody")}
            />
          ) : isRealCustomer && ordersQuery.isPending ? (
            <DetailSkeleton />
          ) : isRealCustomer && ordersQuery.isError ? (
            <OperationalState
              tone="danger"
              title={t("customer360.ordersError")}
              body={t("customer360.ordersErrorBody")}
              onRetry={() => void ordersQuery.refetch()}
            />
          ) : orders.length === 0 ? (
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
              {noteSaveFailed ? (
                <p role="alert" className="text-body-sm text-status-danger-text">
                  {t("customer360.saveNoteError")}
                </p>
              ) : null}
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
