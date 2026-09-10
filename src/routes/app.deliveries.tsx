import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
  filterDeliveryListBySearch,
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

function DeliveryListScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const detailOpen = pathname !== "/app/deliveries" && pathname.startsWith("/app/deliveries/");

  const [filterId, setFilterId] = useState<FilterId>("all");
  const [search, setSearch] = useState("");
  const activeFilter = FILTER_CHIPS.find((c) => c.id === filterId) ?? FILTER_CHIPS[0]!;

  const deliveriesQuery = useQuery({
    queryKey: ["deliveries", "real", activeFilter.scope ?? null, activeFilter.status ?? null],
    queryFn: () => listRealDeliveries({ scope: activeFilter.scope, status: activeFilter.status }),
    enabled: !detailOpen,
  });
  const deliveries = useMemo(() => deliveriesQuery.data ?? [], [deliveriesQuery.data]);
  const filtered = useMemo(
    () => filterDeliveryListBySearch(deliveries, search),
    [deliveries, search],
  );

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

        <ChipRow label={t("deliveryList.filtersLabel")} role="tablist" className="mb-3">
          {FILTER_CHIPS.map((chip) => (
            <Chip
              key={chip.id}
              role="tab"
              selected={chip.id === filterId}
              onClick={() => setFilterId(chip.id)}
            >
              {t(chip.labelKey)}
            </Chip>
          ))}
        </ChipRow>

        <div className="overflow-hidden rounded-2xl border border-border-default">
          {deliveriesQuery.isLoading ? <ListSkeleton rows={6} /> : null}

          {errorKind ? (
            <OperationalState
              tone="danger"
              title={
                errorKind === "forbidden" ? t("deliveryList.denied") : t("deliveryList.error.title")
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

          {deliveriesQuery.isSuccess && deliveries.length === 0 ? (
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

          {deliveriesQuery.isSuccess && deliveries.length > 0 && filtered.length === 0 ? (
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

          {filtered.map((item) => (
            <DeliveryRow key={item.id} item={item} />
          ))}
        </div>
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
