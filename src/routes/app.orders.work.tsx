import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Banknote,
  Check,
  CheckCheck,
  Clock,
  Hourglass,
  MapPin,
  Package,
  PackageCheck,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, Chip, ChipRow, ListSkeleton, ScreenBleed } from "@/design-system";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { deriveOrderNextAction, type OrderActionItem } from "@/lib/order-next-action";
import {
  ORDER_WORK_QUEUE_LIMIT,
  ORDER_WORK_QUEUES,
  parcelFactOf,
  parseOrderWorkQueue,
  paymentFactOf,
  preparationFactOf,
  type OrderWorkQueue,
  type OrderWorkQueueEntry,
  type ParcelFact,
  type PaymentFact,
  type PreparationFact,
} from "@/lib/order-work-queue";
import type { RealDeliveryStatus } from "@/lib/deliveries";
import { ordersKeys } from "@/lib/orders-query";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Order work — three queues staff work through: payment due, not prepared, and
 * packed parcels waiting for a courier. The queue lives in the URL
 * (`?queue=awaiting_handoff`), so Back, a refresh and Order detail's Back all
 * return here. This screen only reads: every action opens the screen that owns
 * it (Pack, Courier hand-off, Order detail), where the server re-checks it.
 *
 * `queue` is declared on the parent /app/orders route so it survives the trip
 * into Order detail and back.
 */
export const Route = createFileRoute("/app/orders/work")({
  head: () => ({
    meta: [
      { title: "Order work — APSA" },
      {
        name: "description",
        content: "Orders with payment due, orders to prepare and parcels waiting for a courier.",
      },
    ],
  }),
  component: OrderWorkScreen,
});

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  info: "bg-status-info-soft text-status-info-text",
  success: "bg-status-success-soft text-status-success-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  danger: "bg-status-danger-soft text-status-danger-text",
  neutral: "bg-surface-secondary text-text-secondary",
};

const PAYMENT_LOOK: Record<PaymentFact, { tone: Tone; icon: LucideIcon }> = {
  paid: { tone: "success", icon: CheckCheck },
  cod_due: { tone: "warning", icon: Banknote },
  due: { tone: "warning", icon: Banknote },
  review: { tone: "info", icon: Hourglass },
  failed: { tone: "danger", icon: X },
};
const PREPARATION_LOOK: Record<PreparationFact, { tone: Tone; icon: LucideIcon }> = {
  not_prepared: { tone: "neutral", icon: Package },
  packed: { tone: "success", icon: PackageCheck },
};
const PARCEL_LOOK: Record<ParcelFact, { tone: Tone; icon: LucideIcon }> = {
  on_bench: { tone: "neutral", icon: Archive },
  waiting_for_courier: { tone: "info", icon: Clock },
  with_courier: { tone: "info", icon: Truck },
  delivered: { tone: "success", icon: Check },
};

/** One labelled fact. Status is a word plus an icon, never colour alone; Khmer wraps, never clips. */
function Fact({
  label,
  text,
  tone,
  icon: Icon,
}: {
  label: string;
  text: string;
  tone: Tone;
  icon: LucideIcon;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd>
        <span
          className={cn(
            "text-label inline-flex max-w-full items-start gap-1.5 rounded-xl px-2 py-1",
            TONE_CLASS[tone],
          )}
        >
          <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{text}</span>
        </span>
      </dd>
    </div>
  );
}

const ACTION_BUTTON =
  "press tap-target text-label inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40";

function NextActionLink({
  row,
  queue,
  action,
}: {
  row: OrderWorkQueueEntry;
  queue: OrderWorkQueue;
  action: OrderActionItem | null;
}) {
  const { t } = useTranslation();
  const primary = cn(ACTION_BUTTON, "bg-action-primary text-text-on-action");
  const quiet = cn(ACTION_BUTTON, "border border-border-default text-text-primary");
  const destination = action?.destination ?? null;
  const label = action ? t(`orderWork.next.${action.id}`) : t("orderWork.next.open");

  // Navigating actions go straight to the screen that owns them.
  if (destination?.to === "/app/pack/$orderId") {
    return (
      <Link to={destination.to} params={destination.params} className={primary}>
        {label}
      </Link>
    );
  }
  if (destination?.to === "/app/handoff/$parcelCode") {
    return (
      <Link to={destination.to} params={destination.params} className={primary}>
        {label}
      </Link>
    );
  }
  if (destination?.to === "/app/deliveries/$id" || destination?.to === "/app/payments/$id") {
    return (
      <Link to={destination.to} params={destination.params} className={primary}>
        {label}
      </Link>
    );
  }
  // In-screen actions (record payment, arrange delivery, …) live on Order detail.
  return (
    <Link
      to="/app/orders/$id"
      params={{ id: row.orderId }}
      search={{ queue }}
      className={action ? primary : quiet}
    >
      {label}
    </Link>
  );
}

function WorkRow({
  row,
  queue,
  principal,
}: {
  row: OrderWorkQueueEntry;
  queue: OrderWorkQueue;
  principal: { userId: string; organizationId: string };
}) {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const payment = paymentFactOf(row);
  const preparation = preparationFactOf(row);
  const parcel = parcelFactOf(row);

  // The same decision Order detail makes, so leaving and returning never
  // shows a different next step for the same saved state.
  const next = deriveOrderNextAction(
    {
      id: row.orderId,
      lifecycleStatus: row.lifecycleStatus,
      paymentStatus: row.paymentStatus,
      refundStatus: row.refundStatus,
      fulfillmentStatus: row.fulfillmentStatus,
    },
    capabilities,
    {
      principal,
      dataPrincipal: principal,
      parcelMissing: false,
      deliveries: {
        latestId: null,
        latestStatus: row.latestDeliveryStatus as RealDeliveryStatus | null,
        activeId: row.activeDeliveryId,
        activeStatus: row.activeDeliveryStatus as RealDeliveryStatus | null,
        anyDelivered: row.anyDelivered,
        latestHasCod: row.cod,
      },
      deliveriesUnavailable: false,
      packed: row.packed,
      parcelCode: row.parcelCode,
      pendingPaymentId: null,
    },
  );

  return (
    <li className="flex flex-col gap-3 border-b border-border-default bg-surface-primary px-4 py-3 last:border-b-0">
      <Link
        to="/app/orders/$id"
        params={{ id: row.orderId }}
        search={{ queue }}
        className="press -mx-1 flex min-w-0 flex-col gap-1 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
            {row.orderNumber}
          </span>
          <span className="text-financial shrink-0 text-text-primary">
            {formatMoney(row.total)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-caption min-w-0 flex-1 truncate text-text-secondary">
            {row.customerName ?? t("orderWork.noCustomer")}
          </span>
          <span className="text-caption tnum shrink-0 text-text-muted">
            {shortTime(row.createdAt)}
          </span>
        </span>
      </Link>

      <dl className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
        <Fact
          label={t("orderWork.facts.payment")}
          text={t(`orderWork.payment.${payment}`, { amount: formatMoney(row.due) })}
          {...PAYMENT_LOOK[payment]}
        />
        <Fact
          label={t("orderWork.facts.preparation")}
          text={t(`orderWork.preparation.${preparation}`)}
          {...PREPARATION_LOOK[preparation]}
        />
        <Fact
          label={t("orderWork.facts.parcel")}
          text={t(`orderWork.parcel.${parcel}`)}
          {...PARCEL_LOOK[parcel]}
        />
      </dl>

      {row.packDetails ? (
        <p className="text-body-sm flex flex-wrap items-center gap-x-3 gap-y-1 text-text-secondary">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-4 shrink-0 text-text-muted" aria-hidden />
            {row.packDetails.storageLocation
              ? t("orderWork.shelf", { location: row.packDetails.storageLocation })
              : t("orderWork.noShelf")}
          </span>
          <span>{t("orderWork.packages", { count: row.packDetails.packageCount })}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-caption min-w-0 text-text-secondary">
          {next.status === "waiting" ? t("orderWork.waiting") : t(next.reasonKey)}
          {next.paymentNoteKey ? <> · {t(next.paymentNoteKey)}</> : null}
        </p>
        <NextActionLink row={row} queue={queue} action={next.primary} />
      </div>
    </li>
  );
}

function OrderWorkScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();
  const userId = session.userId;
  const queue = parseOrderWorkQueue(Route.useSearch().queue);
  const canRead = capabilities.can("orders.read");

  const query = useQuery({
    queryKey: ordersKeys.workQueue(userId, organizationId, queue),
    queryFn: async () => {
      const { listOrderWorkQueueFn } = await import("@/api/packing");
      return listOrderWorkQueueFn({ data: { queue } });
    },
    enabled: canRead,
  });
  const rows = query.data ?? [];

  function selectQueue(next: OrderWorkQueue) {
    if (next === queue) return;
    void navigate({ to: "/app/orders/work", search: { queue: next }, replace: true });
  }

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader
        title={t("orderWork.title")}
        subtitle={t("orderWork.subtitle")}
        // Navigation only: nothing is saved, cancelled or undone by leaving.
        onBack={() => void navigate({ to: "/app/orders" })}
      />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 pb-6 lg:max-w-[var(--screen-max-wide)]">
        {!canRead ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canRead ? (
          <>
            <ChipRow role="group" label={t("orderWork.queuesLabel")} className="mb-2 py-0.5">
              {ORDER_WORK_QUEUES.map((option) => (
                <Chip
                  key={option}
                  selected={option === queue}
                  onClick={() => selectQueue(option)}
                  icon={option === queue ? <Check className="size-4" aria-hidden /> : undefined}
                >
                  {t(`orderWork.queues.${option}`)}
                </Chip>
              ))}
            </ChipRow>
            <p className="text-caption mb-3 text-text-secondary">
              {t(`orderWork.queueHint.${queue}`)}
            </p>

            <div className="overflow-hidden rounded-2xl border border-border-default">
              {query.isLoading ? <ListSkeleton rows={4} /> : null}
              {query.isError ? (
                <OperationalState
                  tone="danger"
                  title={t("orderWork.error.title")}
                  body={t("orderWork.error.body")}
                  onRetry={() => void query.refetch()}
                  className="rounded-none border-0"
                />
              ) : null}
              {query.isSuccess && rows.length === 0 ? (
                <OperationalState
                  title={t(`orderWork.empty.${queue}.title`)}
                  body={t(`orderWork.empty.${queue}.body`)}
                  action={
                    <Button asChild variant="ghost" className="tap-target h-auto min-h-11 py-2">
                      <Link to="/app/orders">{t("orderWork.backToOrders")}</Link>
                    </Button>
                  }
                  className="rounded-none border-0"
                />
              ) : null}
              {rows.length > 0 ? (
                <ul aria-label={t(`orderWork.queues.${queue}`)}>
                  {rows.map((row) => (
                    <WorkRow
                      key={row.orderId}
                      row={row}
                      queue={queue}
                      principal={{ userId, organizationId }}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
            {rows.length >= ORDER_WORK_QUEUE_LIMIT ? (
              <p className="text-caption mt-3 text-center text-text-muted" role="status">
                {t("orderWork.limitNote", { count: rows.length })}
              </p>
            ) : null}
          </>
        ) : null}
      </main>

      <BottomNav />
    </ScreenBleed>
  );
}
