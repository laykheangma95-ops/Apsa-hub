import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppHeader, BottomNav, ChannelBadge, ListSkeleton, StatusChip } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { CreateRealOrderSheet } from "@/components/orders/CreateRealOrderSheet";
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

function OrderRow({ order }: { order: Order }) {
  const { t } = useTranslation();

  return (
    <Link
      to="/app/orders/$id"
      params={{ id: order.id }}
      className="press flex w-full items-start gap-3 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-label tnum truncate text-text-primary">{order.code}</span>
          <span className="text-caption tnum shrink-0 text-text-muted">
            {shortTime(order.createdAt)}
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2">
          {order.source && isChannelSource(order.source) ? (
            <ChannelBadge channel={order.source} withLabel />
          ) : (
            <span className="text-caption text-text-secondary">{t("order.sourceManual")}</span>
          )}
          <span className="text-caption text-text-muted">
            {order.customerId ? t("orderList.hasCustomer") : t("orderList.noCustomer")}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {order.lifecycleStatus ? <StatusChip status={order.lifecycleStatus} /> : null}
          <StatusChip status={order.paymentStatus} />
          <StatusChip status={order.fulfillmentStatus} />
        </div>
      </div>

      <span className="text-financial shrink-0 text-text-primary">{formatMoney(order.total)}</span>
    </Link>
  );
}

function OrderListScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const ordersQuery = useQuery({ queryKey: ["orders", "real"], queryFn: listRealOrders });
  const orders = ordersQuery.data ?? [];

  return (
    <div className="min-h-dvh bg-surface-secondary pb-28">
      <AppHeader title={t("orderList.title")} subtitle={t("orderList.subtitle")} />

      <main className="mx-auto w-full max-w-[560px] px-4 py-4 lg:max-w-[880px]">
        <div className="flex items-center justify-end">
          <Button className="tap-target h-11" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden />
            <span>{t("orderList.newOrder")}</span>
          </Button>
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-border-default">
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
      </main>

      <CreateRealOrderSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ["orders", "real"] });
        }}
      />

      <BottomNav />
    </div>
  );
}
