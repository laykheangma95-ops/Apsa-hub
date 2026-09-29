import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppHeader, BottomNav, ListSkeleton, ScreenBleed } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { OperationalState } from "@/components/common/OperationalState";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { ParcelLabelDialog } from "@/components/labels/ParcelLabelDialog";
import { useCapabilities } from "@/hooks/use-capabilities";
import { listReadyToPack, type ReadyToPackRow } from "@/lib/api";
import { fulfillmentKeys } from "@/lib/fulfillment-query";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";

export const Route = createFileRoute("/app/pack")({
  head: () => ({
    meta: [
      { title: "Ready to Pack — APSA" },
      {
        name: "description",
        content: "Confirmed orders waiting to be packed — print parcel labels and get them moving.",
      },
    ],
  }),
  component: PackScreen,
});

function PaymentTag({ row }: { row: ReadyToPackRow }) {
  const { t } = useTranslation();
  // Status is never colour-only: PAID / COD are words with a tint, not a tint
  // alone (CLAUDE.md).
  if (row.paid) {
    return (
      <span className="text-caption rounded-full bg-status-success-soft px-2 py-0.5 text-status-success-text">
        {t("pack.paid")}
      </span>
    );
  }
  return (
    <span className="text-caption tnum rounded-full bg-status-warning-soft px-2 py-0.5 text-status-warning-text">
      {t("pack.codCollect", { amount: formatMoney(row.collect) })}
    </span>
  );
}

function PackCard({
  row,
  selected,
  onToggle,
  onPrint,
  canPrint,
}: {
  row: ReadyToPackRow;
  selected: boolean;
  onToggle: (checked: boolean) => void;
  onPrint: () => void;
  canPrint: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 border-b border-border-default bg-surface-primary px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        {canPrint ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(c) => onToggle(c === true)}
            aria-label={t("pack.selectOrder", { code: row.orderNumber })}
            className="mt-1"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-label tnum min-w-0 flex-1 truncate text-text-primary">
              {row.orderNumber}
            </span>
            <span className="text-caption tnum shrink-0 text-text-muted">
              {shortTime(row.createdAt)}
            </span>
          </div>
          <p className="text-body-sm truncate text-text-secondary">
            {row.customerName ?? t("pack.noCustomer")}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-caption text-text-muted">
              {t("pack.itemCount", { count: row.itemCount })}
            </span>
            <PaymentTag row={row} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Link
          to="/app/orders/$id"
          params={{ id: row.orderId }}
          className="press text-label tap-target flex items-center rounded-xl border border-border-default px-3 text-text-primary"
        >
          {t("pack.view")}
        </Link>
        {canPrint ? (
          <Button
            type="button"
            variant="outline"
            className="tap-target h-10 gap-2 rounded-xl"
            onClick={onPrint}
          >
            <Printer className="size-4" aria-hidden />
            {t("pack.printParcel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function PackScreen() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const { session, organizationId } = Route.useRouteContext();

  const canRead = capabilities.can("orders.read");
  // Parcel labels expose customer name/phone/address, so printing is gated on the
  // narrow fulfillment.print_label capability the server enforces (§14, §20),
  // read fail-closed (canSensitive). Without it the queue is still readable.
  const canPrint = capabilities.canSensitive("fulfillment.print_label");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printIds, setPrintIds] = useState<string[] | null>(null);

  const query = useQuery({
    queryKey: fulfillmentKeys.readyToPack(session.userId, organizationId),
    queryFn: () => listReadyToPack(),
    enabled: canRead,
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);

  // The set of order ids currently in the queue — the only ids a selection may
  // legitimately contain right now.
  const eligibleIds = useMemo(() => new Set(rows.map((r) => r.orderId)), [rows]);

  /*
   * Reconcile stale bulk selections (§18/§10). The queue refreshes on its own
   * (refetch, another packer shipping an order, a cancellation), and a selected
   * id can silently become one that is no longer eligible — cancelled, already
   * fulfilled, or gone from this principal's view. Prune the selection down to
   * what is actually in the queue now, so a bulk print can never carry a stale
   * or now-ineligible order. The server still revalidates each order on print
   * (getParcelLabelData's lifecycle + permission guards) — this keeps the client
   * from even asking. Also drop everything if the print capability is lost.
   */
  useEffect(() => {
    if (!canPrint) {
      setSelected((prev) => (prev.size === 0 ? prev : new Set()));
      setPrintIds(null);
      return;
    }
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => eligibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [canPrint, eligibleIds]);

  // Never trust the raw selection for an action — always intersect with the
  // current queue at the moment it is read.
  const validSelected = useMemo(
    () => [...selected].filter((id) => eligibleIds.has(id)),
    [selected, eligibleIds],
  );

  function toggle(orderId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
  }

  return (
    <ScreenBleed bottom="nav" surface="raised">
      <AppHeader title={t("pack.title")} subtitle={t("pack.subtitle")} />

      <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3 lg:max-w-[var(--screen-max-wide)]">
        {!canRead ? <CapabilityDeniedState capabilities={capabilities} /> : null}

        {canRead ? (
          <>
            {canPrint && validSelected.length > 0 ? (
              <div className="glass-bar sticky top-2 z-10 mb-3 flex items-center justify-between gap-3 rounded-2xl border border-border-default px-4 py-2.5">
                <span className="text-label text-text-primary">
                  {t("pack.selectedCount", { count: validSelected.length })}
                </span>
                <Button
                  type="button"
                  className="tap-target h-10 gap-2 rounded-xl"
                  onClick={() => setPrintIds(validSelected)}
                >
                  <Printer className="size-4" aria-hidden />
                  {t("pack.printSelected", { count: validSelected.length })}
                </Button>
              </div>
            ) : null}

            <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
              {query.isLoading ? <ListSkeleton rows={6} /> : null}

              {query.isError ? (
                <OperationalState
                  tone="danger"
                  title={t("pack.error.title")}
                  body={t("pack.error.body")}
                  onRetry={() => void query.refetch()}
                  className="rounded-none border-0"
                />
              ) : null}

              {query.isSuccess && rows.length === 0 ? (
                <OperationalState
                  title={t("pack.empty.title")}
                  body={t("pack.empty.body")}
                  className="rounded-none border-0"
                />
              ) : null}

              {rows.map((row) => (
                <PackCard
                  key={row.orderId}
                  row={row}
                  selected={selected.has(row.orderId) && eligibleIds.has(row.orderId)}
                  onToggle={(c) => toggle(row.orderId, c)}
                  onPrint={() => setPrintIds([row.orderId])}
                  canPrint={canPrint}
                />
              ))}
            </div>
          </>
        ) : null}
      </main>

      <ParcelLabelDialog
        open={printIds !== null}
        onClose={() => setPrintIds(null)}
        orderIds={printIds ?? []}
        userId={session.userId}
        organizationId={organizationId}
      />

      <BottomNav />
    </ScreenBleed>
  );
}
