import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  BottomNav,
  ChannelBadge,
  ListSkeleton,
  ScreenBleed,
  StatusBadge,
  StatusChip,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { CreateRealOrderSheet } from "@/components/orders/CreateRealOrderSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { listRealOrdersPage } from "@/lib/api";
import {
  classifyOrderError,
  isOrderListPrincipalChanged,
  presentOrderSource,
  type OrderListCursor,
} from "@/lib/orders";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { ordersKeys } from "@/lib/orders-query";
import { customerKeys } from "@/lib/customers-query";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { Order } from "@/types";

export const Route = createFileRoute("/app/orders")({
  head: () => ({
    meta: [
      { title: "Orders — APSA" },
      {
        name: "description",
        content: "Every order in one list — status, payment, fulfilment and total at a glance.",
      },
      { property: "og:title", content: "Orders — APSA" },
      { property: "og:description", content: "Every order, newest first." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OrderListScreen,
});

/**
 * One order, scanned in two seconds: what it is worth and what state it is in.
 * The total sits on the first line beside the code, where the eye already is,
 * rather than in a right-hand column that competes with the status chips.
 */
function OrderRow({ order }: { order: Order }) {
  const { t } = useTranslation();

  return (
    <Link
      to="/app/orders/$id"
      params={{ id: order.id }}
      className="press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
          {order.code}
        </span>
        <span className="text-financial shrink-0 text-text-primary">
          {formatMoney(order.total)}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        {/*
         * One shared decision (presentOrderSource) drives both Order
         * surfaces: a known channel badges itself, an unrecognised source
         * badges as generic "other", and ONLY an explicitly MANUAL order
         * reads "Entered by hand". An order with no recorded source claims
         * nothing at all rather than inventing provenance.
         */}
        {(() => {
          const presented = presentOrderSource(order.source);
          if (presented.kind === "channel")
            return <ChannelBadge channel={presented.channel} withLabel />;
          if (presented.kind === "manual")
            return (
              <span className="text-caption text-text-secondary">{t("order.sourceManual")}</span>
            );
          return null;
        })()}
        <span className="text-caption min-w-0 flex-1 truncate text-text-muted">
          {order.customerId ? t("orderList.hasCustomer") : t("orderList.noCustomer")}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(order.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/*
         * The lifecycle axis gets the liquid-glass StatusBadge; payment and
         * fulfilment remain their own StatusChip facts — three axes, never
         * merged. All four OrderLifecycleStatus values are direct members of
         * the StatusBadge vocabulary, so the mapping is the identity.
         */}
        {order.lifecycleStatus ? <StatusBadge status={order.lifecycleStatus} size="sm" /> : null}
        <StatusChip status={order.paymentStatus} />
        <StatusChip status={order.fulfillmentStatus} />
      </div>
    </Link>
  );
}

function OrderListScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  /*
   * Cache identity comes from the /app route guard's server-derived context
   * (validated session + active membership row), never from the capability
   * snapshot and never from the URL. It partitions this list so a previous
   * principal's orders — customer names, codes, money — cannot be served back
   * to whoever mounts this screen next in the same tab. It authorizes nothing:
   * listOrdersPage() re-checks orders.read against the membership the SERVER
   * resolved, on every call.
   */
  const { session, organizationId: routeOrganizationId } = Route.useRouteContext();
  const userId = session.userId;
  const listKey = ordersKeys.list(session.userId, routeOrganizationId);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const detailOpen = pathname !== "/app/orders" && pathname.startsWith("/app/orders/");

  // listOrdersPage requires orders.read and createOrder requires orders.create,
  // both enforced in src/server/orders/service.ts. A member who reaches this
  // URL without them gets the denied state here and a 403 from the server.
  const canReadOrders = capabilities.can("orders.read");
  const canCreateOrder = capabilities.can("orders.create");

  /*
   * The whole list, a page at a time. Each page continues from the exact
   * (created_at, id) position the previous one ended on, so an order created
   * while the merchant pages appears at the top on the next refresh instead of
   * pushing a row from one page onto the next.
   *
   * The key carries the principal, and so does every request: a page answered
   * for anyone other than this key's member and organization is refused before
   * it is stored (listRealOrdersPage).
   */
  const ordersQuery = useInfiniteQuery({
    queryKey: ordersKeys.listPages(userId, routeOrganizationId),
    queryFn: ({ pageParam }) =>
      listRealOrdersPage({
        before: pageParam,
        expected: { userId, organizationId: routeOrganizationId },
      }),
    initialPageParam: null as OrderListCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    /*
     * A dropped connection is worth two quiet retries; an answer about WHO is
     * asking never is. Signed out, refused or answered for another principal
     * surfaces at once instead of after three backed-off retries of a request
     * that cannot succeed.
     */
    retry: (failureCount, error) =>
      failureCount < 2 &&
      !isOrderListPrincipalChanged(error) &&
      classifyOrderError(error) === "server_error",
    enabled: !detailOpen && canReadOrders,
  });

  // Keyed by id across pages. A cursor cannot hand back a row twice, but a
  // repeated React key would silently drop or reuse a row on screen.
  const orders = useMemo(() => {
    const seen = new Set<string>();
    const list: Order[] = [];
    for (const page of ordersQuery.data?.pages ?? []) {
      for (const order of page.orders) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        list.push(order);
      }
    }
    return list;
  }, [ordersQuery.data]);

  const listError = ordersQuery.isError ? ordersQuery.error : null;
  const principalChanged = isOrderListPrincipalChanged(listError);
  const errorKind = listError && !principalChanged ? classifyOrderError(listError) : null;
  /*
   * Rows already on screen stay only while the server would still hand them
   * over. Signed out, refused (orders.read revoked) or answered for another
   * principal: every loaded page leaves the screen, not just the failed one.
   */
  const blocked = principalChanged || errorKind === "unauthorized" || errorKind === "forbidden";
  const hasPages = Boolean(ordersQuery.data) && !blocked;
  const firstLoadFailed = Boolean(listError) && !blocked && !ordersQuery.data;
  const moreFailed = ordersQuery.isFetchNextPageError && !blocked;
  const refreshFailed = ordersQuery.isRefetchError && hasPages;
  const reachedEnd = hasPages && !ordersQuery.hasNextPage && orders.length > 0;

  useEffect(() => {
    if (errorKind === "unauthorized") void navigate({ to: "/sign-in" });
  }, [errorKind, navigate]);

  /*
   * One request per page, however fast the taps. The ref closes the gap
   * between a tap and the re-render that marks the button busy; cancelRefetch
   * false makes a call during any fetch join it rather than restart it.
   */
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const focusEndWhenDone = useRef(false);
  const busy = ordersQuery.isFetching;
  function loadMore() {
    if (loadingMore.current || ordersQuery.isFetching || !ordersQuery.hasNextPage) return;
    loadingMore.current = true;
    focusEndWhenDone.current = document.activeElement === loadMoreRef.current;
    void ordersQuery.fetchNextPage({ cancelRefetch: false }).finally(() => {
      loadingMore.current = false;
    });
  }
  // The Load more button leaves when the last page arrives; keyboard focus
  // moves to the end-of-list message instead of falling back to the page.
  useEffect(() => {
    if (reachedEnd && focusEndWhenDone.current) {
      focusEndWhenDone.current = false;
      endRef.current?.focus();
    }
  }, [reachedEnd]);

  /*
   * /app/orders/$id is a child of this route, so without an Outlet the detail
   * screen never rendered at all — tapping an order left the merchant on the
   * list. Order detail is a full screen rather than a split pane, so the list
   * steps aside entirely while a child route is open.
   */
  if (detailOpen) return <Outlet />;

  return (
    <ScreenBleed bottom="nav" surface="raised">
      {/*
       * "New order" is the screen's one action, so it lives in the pinned bar
       * rather than on a row of its own — that row cost a full list item of
       * vertical space on every phone and put the action out of thumb reach.
       */}
      <AppHeader
        title={t("orderList.title")}
        subtitle={t("orderList.subtitle")}
        {...(canCreateOrder
          ? {
              action: (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  aria-label={t("orderList.newOrder")}
                  className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full bg-action-primary text-text-on-action"
                >
                  <Plus className="size-5" aria-hidden />
                </button>
              ),
            }
          : {})}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        {!canReadOrders ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canReadOrders && refreshFailed ? (
          <div
            role="status"
            className="text-caption mb-3 flex items-start gap-2 rounded-xl bg-status-warning-soft px-3 py-2 text-status-warning-text"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t("orderList.refreshError")}</span>
            <button
              type="button"
              onClick={() => void ordersQuery.refetch()}
              className="press tap-target -my-2 shrink-0 rounded-lg px-2 font-medium underline underline-offset-2"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}

        {canReadOrders ? (
          <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
            {ordersQuery.isLoading ? <ListSkeleton rows={6} /> : null}

            {principalChanged ? (
              <OperationalState
                tone="danger"
                title={t("orderList.principalChanged.title")}
                body={t("orderList.principalChanged.body")}
                action={
                  <Button className="tap-target h-12" onClick={() => window.location.reload()}>
                    {t("orderList.principalChanged.reload")}
                  </Button>
                }
                className="rounded-none border-0"
              />
            ) : null}

            {errorKind === "forbidden" ? (
              <OperationalState
                title={t("orderList.denied")}
                body={t("orderList.deniedBody")}
                className="rounded-none border-0"
              />
            ) : null}

            {firstLoadFailed ? (
              <OperationalState
                tone="danger"
                title={t("orderList.error.title")}
                body={t("orderList.error.body")}
                onRetry={() => void ordersQuery.refetch()}
                className="rounded-none border-0"
              />
            ) : null}

            {/* Empty only when the first page was READ and held nothing. */}
            {hasPages && orders.length === 0 && !ordersQuery.hasNextPage ? (
              <OperationalState
                title={t("orderList.empty.title")}
                body={t("orderList.empty.body")}
                className="rounded-none border-0"
              />
            ) : null}

            {hasPages ? orders.map((order) => <OrderRow key={order.id} order={order} />) : null}
          </div>
        ) : null}

        {canReadOrders && hasPages && orders.length > 0 ? (
          <div className="mt-3 flex flex-col items-stretch gap-2 pb-2">
            {moreFailed ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-2 text-status-danger-text"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="text-label">{t("orderList.moreError.title")}</p>
                  <p className="text-caption">{t("orderList.moreError.body")}</p>
                </div>
              </div>
            ) : null}

            {ordersQuery.hasNextPage ? (
              /*
               * aria-disabled rather than disabled: a disabled button drops
               * keyboard focus mid-load. loadMore() refuses while busy.
               */
              <Button
                ref={loadMoreRef}
                variant={moreFailed ? "default" : "ghost"}
                className="tap-target h-auto min-h-12 w-full whitespace-normal py-2 aria-disabled:opacity-70"
                aria-disabled={busy}
                aria-describedby="order-list-progress"
                onClick={loadMore}
              >
                {ordersQuery.isFetchingNextPage
                  ? t("orderList.loadingMore")
                  : moreFailed
                    ? t("common.retry")
                    : t("orderList.loadMore")}
              </Button>
            ) : null}

            {reachedEnd ? (
              <div ref={endRef} tabIndex={-1} className="rounded-xl px-3 py-2 text-center">
                <p className="text-label text-text-primary">{t("orderList.end.title")}</p>
                <p className="text-caption mt-0.5 text-text-muted">
                  {t("orderList.end.body", { count: orders.length })}
                </p>
              </div>
            ) : null}

            {/* Spoken progress: what is loading, then how many are on screen. */}
            <p
              id="order-list-progress"
              role="status"
              aria-live="polite"
              className={reachedEnd ? "sr-only" : "text-caption text-center text-text-muted tnum"}
            >
              {ordersQuery.isFetchingNextPage ? (
                t("orderList.loadingMore")
              ) : reachedEnd ? (
                // Two spans, not one joined sentence: Khmer and English end a
                // sentence differently, and each string already carries its own.
                <>
                  <span>{t("orderList.end.title")}</span>{" "}
                  <span>{t("orderList.end.body", { count: orders.length })}</span>
                </>
              ) : (
                t("orderList.showing", { count: orders.length })
              )}
            </p>
          </div>
        ) : null}
      </main>

      <CreateRealOrderSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        userId={session.userId}
        organizationId={routeOrganizationId}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: listKey });
          // A new order is new outstanding work, so Home's attention counts
          // move with it rather than waiting for their own refetch.
          void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
          // An order attached to a customer changes that customer's order
          // history. This principal's customer partition only.
          void queryClient.invalidateQueries({
            queryKey: customerKeys.principal(session.userId, routeOrganizationId),
          });
        }}
      />

      <BottomNav />
    </ScreenBleed>
  );
}
