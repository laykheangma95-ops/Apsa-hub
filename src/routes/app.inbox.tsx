import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  AppHeader,
  BottomNav,
  BottomSheet,
  Chip,
  ChipRow,
  ConversationRow,
  EmptyState,
  ErrorState,
  ListSkeleton,
  SegmentedControl,
  type Segment,
} from "@/design-system";

import { getConversationCounts, getConversationPage, getCustomers, getStaff } from "@/api/inbox";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
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
type InboxTab = "messages" | "comments";

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

  const [tab, setTab] = useState<InboxTab>("messages");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [query, setQuery] = useState("");
  const [channelSheetOpen, setChannelSheetOpen] = useState(false);

  const conversationsQuery = useInfiniteQuery({
    queryKey: ["conversations", status, channel, query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getConversationPage({ status, channel, query, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const countsQuery = useQuery({
    queryKey: ["conversation-counts"],
    queryFn: getConversationCounts,
  });
  const customersQuery = useQuery({ queryKey: ["customers"], queryFn: getCustomers });
  const staffQuery = useQuery({ queryKey: ["staff"], queryFn: getStaff });

  const refresh = useCallback(async () => {
    await Promise.all([conversationsQuery.refetch(), countsQuery.refetch()]);
  }, [conversationsQuery, countsQuery]);

  const { containerRef, pull, refreshing, threshold } = usePullToRefresh(refresh);

  const loadMore = useCallback(() => {
    void conversationsQuery.fetchNextPage();
  }, [conversationsQuery]);

  const sentinelRef = useInfiniteScroll({
    hasMore: conversationsQuery.hasNextPage,
    loading: conversationsQuery.isFetchingNextPage,
    onLoadMore: loadMore,
  });

  const conversations = useMemo(
    () => [
      ...new Map(
        (conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? []).map((row) => [
          row.id,
          row,
        ]),
      ).values(),
    ],
    [conversationsQuery.data],
  );
  const counts = countsQuery.data ?? {};
  const unreadTotal = typeof counts["unread"] === "number" ? counts["unread"] : 0;

  const tabSegments: Segment<InboxTab>[] = [
    { value: "messages", label: t("inbox.tabs.messages") },
    { value: "comments", label: t("inbox.tabs.comments") },
  ];

  const filtersActive = (status !== "all" ? 1 : 0) + (channel !== "all" ? 1 : 0);

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader
        title={t("inbox.title")}
        subtitle={t("inbox.subtitle")}
        notificationCount={unreadTotal}
      />

      <div ref={containerRef} className="scroll-pane min-h-0 flex-1">
        {/*
         * Tabs and search scroll away with the list. Only the filter strip
         * below stays pinned — the state a merchant needs while scrolling —
         * so the chrome that used to hold a quarter of the phone now costs
         * one line.
         */}
        <div className="screen-gutter space-y-2 pt-2 pb-2">
          <SegmentedControl
            as="tabs"
            segments={tabSegments}
            value={tab}
            onChange={setTab}
            label={t("inbox.title")}
          />

          {tab === "messages" ? (
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                placeholder={t("inbox.searchPlaceholder")}
                aria-label={t("common.search")}
                className="h-11 rounded-full border-border-default bg-surface-primary pr-10 pl-9"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("inbox.clearSearch")}
                  className="press absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-text-muted"
                >
                  <X className="size-4" aria-hidden />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {tab === "comments" ? (
          <EmptyState
            pose="winking"
            title={t("inbox.comments.title")}
            body={t("inbox.comments.body")}
          />
        ) : (
          <>
            <div className="glass-bar sticky top-0 z-10 py-2">
              <ChipRow label={t("inbox.filters.all")} className="px-4">
                <button
                  type="button"
                  onClick={() => setChannelSheetOpen(true)}
                  aria-haspopup="dialog"
                  aria-label={
                    filtersActive > 0
                      ? t("common.filtersActive", { count: filtersActive })
                      : t("common.filters")
                  }
                  className={cn(
                    "press text-label inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5",
                    channel !== "all"
                      ? "border-action-primary-border bg-action-primary-soft text-status-info-text"
                      : "border-border-default bg-surface-primary text-text-secondary",
                  )}
                >
                  <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
                  <span className="chip-text">
                    {channel === "all" ? t("inbox.channels.all") : t(`channel.${channel}`)}
                  </span>
                </button>

                <span aria-hidden className="my-2 w-px shrink-0 bg-border-default" />

                {STATUS_FILTERS.map((value) => {
                  const count = value === "all" ? counts["all"] : counts[value];
                  return (
                    <Chip
                      key={value}
                      selected={status === value}
                      onClick={() => setStatus(value)}
                      count={typeof count === "number" ? count : undefined}
                    >
                      {value === "all" ? t("inbox.filters.all") : t(`status.${value}`)}
                    </Chip>
                  );
                })}
              </ChipRow>
            </div>

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

            <ul className="list-enter">
              {conversations.map((conversation) => {
                const customer = customersQuery.data?.find((c) => c.id === conversation.customerId);
                // Production conversations resolve their customer via the real
                // Customer domain server-side (conversation.customerName) rather
                // than this mock lookup — see src/lib/api/index.ts#getConversations.
                const customerName = customer
                  ? localName(customer, language)
                  : (conversation.customerName ?? "—");
                const assigned = staffQuery.data?.find(
                  (s) => s.id === conversation.assignedStaffId,
                );
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
                        customerName={customerName}
                        companion={customer?.companion ?? "nilo"}
                        assignedStaff={assigned}
                        className={active ? "bg-surface-secondary" : undefined}
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>

            {/* Pages arrive as the merchant reaches them — no "load more" tap. */}
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {conversationsQuery.isFetchingNextPage ? (
              <p
                role="status"
                className="text-caption py-4 text-center text-text-muted"
                aria-live="polite"
              >
                {t("inbox.loadingMore")}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col bg-surface-primary lg:flex-row">
      <div
        className={cn(
          "min-h-0 flex-col bg-surface-primary lg:flex lg:w-[380px] lg:shrink-0 lg:border-r lg:border-border-default",
          threadOpen ? "hidden lg:flex" : "flex",
        )}
      >
        {listPane}
        {!threadOpen ? (
          <div className="h-[var(--nav-clearance)] shrink-0 lg:hidden" aria-hidden />
        ) : null}
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

      {!threadOpen ? (
        <BottomNav
          workspace="business"
          {...(unreadTotal > 0 ? { badges: { inbox: unreadTotal } } : {})}
        />
      ) : null}

      <BottomSheet
        open={channelSheetOpen}
        onOpenChange={setChannelSheetOpen}
        title={t("inbox.channels.title")}
        description={t("inbox.channels.description")}
        snap="peek"
      >
        <ul className="space-y-2">
          {CHANNEL_FILTERS.map((value) => {
            const selected = channel === value;
            return (
              <li key={value}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setChannel(value);
                    setChannelSheetOpen(false);
                  }}
                  className={cn(
                    "press tap-target text-body flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left",
                    selected
                      ? "border-action-primary-border bg-action-primary-soft text-status-info-text"
                      : "border-border-default bg-surface-primary text-text-primary",
                  )}
                >
                  <span className="min-w-0">
                    {value === "all" ? t("inbox.channels.all") : t(`channel.${value}`)}
                  </span>
                  {selected ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </BottomSheet>
    </div>
  );
}
