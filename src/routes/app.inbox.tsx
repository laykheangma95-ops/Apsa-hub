import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  AppHeader,
  BottomNav,
  ConversationRow,
  EmptyState,
  ErrorState,
  ListSkeleton,
} from "@/design-system";
import { getConversationCounts, getConversations, getCustomers, getStaff } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { cn } from "@/lib/utils";
import type { Channel, ConversationStatus } from "@/types";

export const Route = createFileRoute("/app/inbox")({
  head: () => ({
    meta: [
      { title: "Unified Inbox — APSA" },
      {
        name: "description",
        content:
          "Facebook, Instagram and Telegram conversations in one list, with follow-up status on every thread.",
      },
      { property: "og:title", content: "Unified Inbox — APSA" },
      {
        property: "og:description",
        content: "One inbox for every channel, with follow-up status so nothing goes quiet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InboxLayout,
});

type StatusFilter = ConversationStatus | "all";
type ChannelFilter = Channel | "all";

const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "unread",
  "needs_reply",
  "follow_up",
  "waiting_customer",
  "order_created",
];

const CHANNEL_FILTERS: ChannelFilter[] = ["all", "facebook", "instagram", "telegram"];

function InboxLayout() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const threadOpen = pathname.startsWith("/app/inbox/");

  const [tab, setTab] = useState<"messages" | "comments">("messages");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [query, setQuery] = useState("");

  const conversationsQuery = useQuery({
    queryKey: ["conversations", status, channel, query],
    queryFn: () => getConversations({ status, channel, query }),
  });
  const countsQuery = useQuery({ queryKey: ["conversation-counts"], queryFn: getConversationCounts });
  const customersQuery = useQuery({ queryKey: ["customers"], queryFn: getCustomers });
  const staffQuery = useQuery({ queryKey: ["staff"], queryFn: getStaff });

  const refresh = useCallback(async () => {
    await Promise.all([conversationsQuery.refetch(), countsQuery.refetch()]);
  }, [conversationsQuery, countsQuery]);

  const { containerRef, pull, refreshing, threshold } = usePullToRefresh(refresh);

  const conversations = conversationsQuery.data ?? [];
  const counts = countsQuery.data ?? {};

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} notificationCount={3}>
        <div className="space-y-3">
          <div
            role="tablist"
            aria-label={t("inbox.title")}
            className="flex rounded-full border border-border-default bg-surface-secondary p-0.5"
          >
            {(["messages", "comments"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  "tap-target text-label flex-1 rounded-full",
                  tab === key
                    ? "bg-surface-primary text-text-primary"
                    : "text-text-secondary",
                )}
              >
                {t(`inbox.tabs.${key}`)}
              </button>
            ))}
          </div>

          {tab === "messages" ? (
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("inbox.searchPlaceholder")}
                  aria-label={t("common.search")}
                  className="h-12 pl-9"
                />
              </div>

              <div
                role="group"
                aria-label={t("inbox.filters.all")}
                className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
              >
                {STATUS_FILTERS.map((value) => {
                  const count = value === "all" ? counts["all"] : counts[value];
                  const active = status === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setStatus(value)}
                      className={cn(
                        "tap-target text-caption shrink-0 rounded-full border px-3 whitespace-nowrap",
                        active
                          ? "border-action-primary bg-action-primary text-text-on-action"
                          : "border-border-default bg-surface-primary text-text-secondary",
                      )}
                    >
                      <span className="chip-text">
                        {value === "all" ? t("inbox.filters.all") : t(`status.${value}`)}
                        {typeof count === "number" ? ` · ${count}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                role="group"
                aria-label={t("inbox.channels.all")}
                className="-mx-4 flex gap-2 overflow-x-auto px-4"
              >
                {CHANNEL_FILTERS.map((value) => {
                  const active = channel === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setChannel(value)}
                      className={cn(
                        "tap-target text-caption shrink-0 rounded-full border px-3 whitespace-nowrap",
                        active
                          ? "border-border-strong bg-surface-secondary text-text-primary"
                          : "border-border-default bg-surface-primary text-text-secondary",
                      )}
                    >
                      <span className="chip-text">
                        {value === "all" ? t("inbox.channels.all") : t(`channel.${value}`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </AppHeader>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {tab === "comments" ? (
          <EmptyState
            pose="winking"
            title={t("inbox.comments.title")}
            body={t("inbox.comments.body")}
          />
        ) : (
          <>
            <div
              aria-live="polite"
              className="text-caption flex items-center justify-center overflow-hidden text-text-muted"
              style={{ height: refreshing ? 36 : pull }}
            >
              {refreshing
                ? t("inbox.refreshing")
                : pull >= threshold
                  ? t("inbox.releaseToRefresh")
                  : pull > 0
                    ? t("inbox.pullToRefresh")
                    : null}
            </div>

            {conversationsQuery.isPending ? <ListSkeleton rows={6} /> : null}

            {conversationsQuery.isError ? (
              <ErrorState
                title={t("inbox.error.title")}
                body={t("inbox.error.body")}
                onRetry={() => void conversationsQuery.refetch()}
              />
            ) : null}

            {conversationsQuery.isSuccess && conversations.length === 0 ? (
              <EmptyState
                title={t(query ? "inbox.emptySearch.title" : "inbox.empty.title")}
                body={t(query ? "inbox.emptySearch.body" : "inbox.empty.body")}
              />
            ) : null}

            <ul>
              {conversations.map((conversation) => {
                const customer = customersQuery.data?.find((c) => c.id === conversation.customerId);
                const assigned = staffQuery.data?.find((s) => s.id === conversation.assignedStaffId);
                const active = pathname === `/app/inbox/${conversation.id}`;
                return (
                  <li key={conversation.id}>
                    <Link
                      to="/app/inbox/$id"
                      params={{ id: conversation.id }}
                      className="block"
                      aria-current={active ? "page" : undefined}
                    >
                      <ConversationRow
                        conversation={conversation}
                        customerName={customer ? localName(customer, language) : "—"}
                        companion={customer?.companion ?? "nilo"}
                        assignedStaff={assigned}
                        className={active ? "bg-surface-secondary" : undefined}
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col bg-surface-secondary lg:flex-row">
      <div
        className={cn(
          "min-h-0 flex-col bg-surface-primary lg:flex lg:w-[380px] lg:shrink-0 lg:border-r lg:border-border-default",
          threadOpen ? "hidden lg:flex" : "flex",
        )}
      >
        {listPane}
        {!threadOpen ? <div className="h-20 shrink-0 lg:hidden" aria-hidden /> : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 items-stretch",
          threadOpen ? "flex" : "hidden lg:flex lg:items-center lg:justify-center",
        )}
      >
        <Outlet />
        {!threadOpen ? (
          <EmptyState
            pose="waving"
            title={t("inbox.selectPrompt.title")}
            body={t("inbox.selectPrompt.body")}
          />
        ) : null}
      </div>

      {!threadOpen ? <BottomNav workspace="business" /> : null}
    </div>
  );
}

