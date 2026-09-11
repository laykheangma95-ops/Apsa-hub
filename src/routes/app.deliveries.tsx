import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  BottomNav,
  Chip,
  ChipRow,
  ListSkeleton,
  ScreenBleed,
  StatusChip,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { listRealDeliveries } from "@/lib/api";
import {
  classifyDeliveryError,
  type RealDeliveryListItem,
  type RealDeliveryStatus,
} from "@/lib/deliveries";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";

export const Route = createFileRoute("/app/deliveries")({
  head: () => ({
    meta: [
      { title: "Deliveries — APSA" },
      {
        name: "description",
        content: "Every delivery in one list — status, courier and what needs your attention.",
      },
      { property: "og:title", content: "Deliveries — APSA" },
      { property: "og:description", content: "Every delivery, newest first." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DeliveryListScreen,
});

type FilterId = "all" | "active" | "completed" | `status:${RealDeliveryStatus}`;

interface FilterChipDef {
  id: FilterId;
  labelKey: string;
  scope?: "active" | "completed";
  status?: RealDeliveryStatus;
}

const FILTER_CHIPS: readonly FilterChipDef[] = [
  { id: "all", labelKey: "deliveryList.filters.all" },
  { id: "active", labelKey: "deliveryList.filters.active", scope: "active" },
  { id: "completed", labelKey: "deliveryList.filters.completed", scope: "completed" },
  { id: "status:pending", labelKey: "status.pending", status: "pending" },
  { id: "status:preparing", labelKey: "status.preparing", status: "preparing" },
  { id: "status:ready", labelKey: "status.ready", status: "ready" },
  { id: "status:in_transit", labelKey: "status.in_transit", status: "in_transit" },
  { id: "status:delivered", labelKey: "status.delivered", status: "delivered" },
  { id: "status:failed", labelKey: "status.failed", status: "failed" },
  { id: "status:cancelled", labelKey: "status.cancelled", status: "cancelled" },
];

/**
 * One delivery, one order, scanned in two seconds: who it is for, who is
 * carrying it, and whether the merchant needs to do anything. COD sits as a
 * quiet operational note, never styled like a payment confirmation — the
 * Payment domain remains the only authority on whether an order is paid.
 */
function DeliveryRow({ item }: { item: RealDeliveryListItem }) {
  const { t } = useTranslation();

  return (
    <Link
      to="/app/deliveries/$id"
      params={{ id: item.id }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
          {item.orderCode ?? t("deliveryList.unknownOrder")}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(item.updatedAt)}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="text-caption min-w-0 flex-1 truncate text-text-secondary">
          {item.providerName}
        </span>
        <span className="text-caption min-w-0 shrink-0 truncate text-text-muted">
          {item.hasCustomer
            ? (item.customerName ?? t("orderList.hasCustomer"))
            : t("orderList.noCustomer")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={item.status} />
        {item.codAmount ? (
          <span className="text-caption tnum rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary">
            {t("deliveryList.codBadge", { amount: formatMoney(item.codAmount) })}
          </span>
        ) : null}
        {item.actionNeeded ? (
          <span className="text-caption inline-flex items-center gap-1 rounded-full bg-status-danger-soft px-2 py-0.5 text-status-danger-text">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {t("deliveryList.actionNeeded")}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/** One page of derived (latest-per-order) results per request. */
const PAGE_SIZE = 50;
/** Long enough that a fast typist issues one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

function DeliveryListScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const detailOpen = pathname !== "/app/deliveries" && pathname.startsWith("/app/deliveries/");

  const [filterId, setFilterId] = useState<FilterId>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const activeFilter = FILTER_CHIPS.find((c) => c.id === filterId) ?? FILTER_CHIPS[0]!;

  // The search term goes to the server rather than narrowing the rows already
  // on screen: a delivery two pages down still has to be findable, and only
  // the server can see the complete authorized set.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const deliveriesQuery = useInfiniteQuery({
    queryKey: [
      "deliveries",
      "real",
      activeFilter.scope ?? null,
      activeFilter.status ?? null,
      debouncedSearch || null,
    ],
    queryFn: ({ pageParam }) =>
      listRealDeliveries({
        scope: activeFilter.scope,
        status: activeFilter.status,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((total, page) => total + page.items.length, 0) : undefined,
    enabled: !detailOpen,
  });

  const items = useMemo(
    () => deliveriesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [deliveriesQuery.data],
  );
  // Any page that hit the server's scan ceiling makes the whole list partial.
  const truncated = deliveriesQuery.data?.pages.some((page) => page.truncated) ?? false;
  const searching = debouncedSearch.length > 0;

  useEffect(() => {
    if (
      deliveriesQuery.isError &&
      classifyDeliveryError(deliveriesQuery.error) === "unauthorized"
    ) {
      void navigate({ to: "/sign-in" });
    }
  }, [deliveriesQuery.isError, deliveriesQuery.error, navigate]);

  if (detailOpen) return <Outlet />;

  const errorKind = deliveriesQuery.isError ? classifyDeliveryError(deliveriesQuery.error) : null;
  if (errorKind === "unauthorized") return null; // redirecting, see the effect above

  // An empty result is now a statement of fact, not an artefact of a capped
  // read — unless the scan was truncated, which gets its own honest copy.
  const showEmpty = deliveriesQuery.isSuccess && items.length === 0 && !truncated;
  // A truncated scan with nothing to show is explained by the notice above, so
  // the list panel would otherwise render as a bare 1px border.
  const showListPanel =
    deliveriesQuery.isLoading || Boolean(errorKind) || showEmpty || items.length > 0;

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("deliveryList.title")} subtitle={t("deliveryList.subtitle")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        <div className="relative mb-3">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("deliveryList.searchPlaceholder")}
            aria-label={t("deliveryList.searchPlaceholder")}
            className="h-11 pl-9"
          />
        </div>

        <ChipRow label={t("deliveryList.filtersLabel")} className="mb-3">
          {FILTER_CHIPS.map((chip) => (
            <Chip
              key={chip.id}
              selected={chip.id === filterId}
              onClick={() => setFilterId(chip.id)}
            >
              {t(chip.labelKey)}
            </Chip>
          ))}
        </ChipRow>

        {truncated ? (
          <div
            role="status"
            className="text-caption mb-3 flex items-start gap-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t("deliveryList.partial")}</span>
          </div>
        ) : null}

        {showListPanel ? (
          <div className="overflow-hidden rounded-2xl border border-border-default">
            {deliveriesQuery.isLoading ? <ListSkeleton rows={6} /> : null}

            {errorKind ? (
              <OperationalState
                tone="danger"
                title={
                  errorKind === "forbidden"
                    ? t("deliveryList.denied")
                    : t("deliveryList.error.title")
                }
                body={
                  errorKind === "forbidden"
                    ? t("deliveryList.deniedBody")
                    : t("deliveryList.error.body")
                }
                {...(errorKind === "forbidden"
                  ? {}
                  : { onRetry: () => void deliveriesQuery.refetch() })}
                className="rounded-none border-0"
              />
            ) : null}

            {showEmpty && searching ? (
              <OperationalState
                title={t("deliveryList.noResults.title")}
                body={t("deliveryList.noResults.body")}
                action={
                  <Button variant="ghost" className="tap-target h-11" onClick={() => setSearch("")}>
                    {t("deliveryList.noResults.clear")}
                  </Button>
                }
                className="rounded-none border-0"
              />
            ) : null}

            {showEmpty && !searching ? (
              <OperationalState
                title={
                  filterId === "all"
                    ? t("deliveryList.empty.title")
                    : t("deliveryList.emptyFilter.title")
                }
                body={
                  filterId === "all"
                    ? t("deliveryList.empty.body")
                    : t("deliveryList.emptyFilter.body")
                }
                className="rounded-none border-0"
              />
            ) : null}

            {items.map((item) => (
              <DeliveryRow key={item.id} item={item} />
            ))}
          </div>
        ) : null}

        {deliveriesQuery.hasNextPage ? (
          <Button
            variant="ghost"
            className="tap-target mt-3 h-11 w-full"
            disabled={deliveriesQuery.isFetchingNextPage}
            onClick={() => void deliveriesQuery.fetchNextPage()}
          >
            {deliveriesQuery.isFetchingNextPage
              ? t("deliveryList.loadingMore")
              : t("deliveryList.loadMore")}
          </Button>
        ) : null}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
