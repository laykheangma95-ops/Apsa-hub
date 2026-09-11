import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppHeader,
  BottomNav,
  ChannelBadge,
  ListSkeleton,
  ScreenBleed,
  StatusChip,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { CreateRealOrderSheet } from "@/components/orders/CreateRealOrderSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { listRealOrders } from "@/lib/api";
import { isChannelSource } from "@/lib/orders";
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
        {order.source && isChannelSource(order.source) ? (
          <ChannelBadge channel={order.source} withLabel />
        ) : (
          <span className="text-caption text-text-secondary">{t("order.sourceManual")}</span>
        )}
        <span className="text-caption min-w-0 flex-1 truncate text-text-muted">
          {order.customerId ? t("orderList.hasCustomer") : t("orderList.noCustomer")}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(order.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {order.lifecycleStatus ? <StatusChip status={order.lifecycleStatus} /> : null}
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
  const [createOpen, setCreateOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const detailOpen = pathname !== "/app/orders" && pathname.startsWith("/app/orders/");

  // listOrders requires orders.read and createOrder requires orders.create,
  // both enforced in src/server/orders/service.ts. A member who reaches this
  // URL without them gets the denied state here and a 403 from the server.
  const canReadOrders = capabilities.can("orders.read");
  const canCreateOrder = capabilities.can("orders.create");

  const ordersQuery = useQuery({
    queryKey: ["orders", "real"],
    queryFn: listRealOrders,
    enabled: !detailOpen && canReadOrders,
  });
  const orders = ordersQuery.data ?? [];

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

        {canReadOrders ? (
          <div className="overflow-hidden rounded-2xl border border-border-default">
            {ordersQuery.isLoading ? <ListSkeleton rows={6} /> : null}

            {ordersQuery.isError ? (
              <OperationalState
                tone="danger"
                title={t("orderList.error.title")}
                body={t("orderList.error.body")}
                onRetry={() => void ordersQuery.refetch()}
                className="rounded-none border-0"
              />
            ) : null}

            {ordersQuery.isSuccess && orders.length === 0 ? (
              <OperationalState
                title={t("orderList.empty.title")}
                body={t("orderList.empty.body")}
                className="rounded-none border-0"
              />
            ) : null}

            {orders.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </div>
        ) : null}
      </main>

      <CreateRealOrderSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ["orders", "real"] });
        }}
      />

      <BottomNav />
    </ScreenBleed>
  );
}
