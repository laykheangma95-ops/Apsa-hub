/**
 * Payments → "Excess to return" (migration 068, DRAFT).
 *
 * Every confirmed payment recorded with excess that still has something to
 * return, every pending one (awaiting confirmation — nothing can be returned
 * yet), and every legacy order holding more than its total. All figures are
 * the server's: list_excess_to_return_v1 computes them with the same rule the
 * return itself applies, counts them exactly, and pages them deterministically.
 *
 * Shown only to a member holding payments.reconcile (canSensitive); the server
 * refuses everyone else.
 */
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { PaymentMethodChip } from "@/components/payments/PaymentStateChips";
import { listRealExcessToReturn } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { classifyPaymentError, type UiExcessToReturnItem } from "@/lib/payments";

const PAGE_SIZE = 25;

function ExcessRow({ item }: { item: UiExcessToReturnItem }) {
  const { t } = useTranslation();
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-financial tnum min-w-0 flex-1 text-text-primary">
          {t(`payments.excessToReturn.amount.${item.kind}`, { amount: formatMoney(item.excess) })}
        </span>
        <span className="text-caption tnum shrink-0 text-text-muted">
          {shortTime(item.occurredAt)}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-caption tnum min-w-0 flex-1 truncate text-text-secondary">
          {item.customerName
            ? t("payments.excessToReturn.orderWithCustomer", {
                number: item.orderNumber,
                customer: item.customerName,
              })
            : t("payments.excessToReturn.order", { number: item.orderNumber })}
        </span>
        <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* The state is a label, never a colour alone. */}
        <span className="text-label inline-flex max-w-full items-center rounded-full border border-border-default px-2 py-0.5 text-text-secondary">
          <span className="chip-text">{t(`payments.excessToReturn.kind.${item.kind}`)}</span>
        </span>
        {item.method ? <PaymentMethodChip method={item.method} /> : null}
        {item.amount ? (
          <span className="text-caption tnum text-text-muted">
            {t("payments.excessToReturn.received", { amount: formatMoney(item.amount) })}
          </span>
        ) : null}
      </div>
    </>
  );
  const className =
    "press flex w-full flex-col gap-1.5 border-b border-border-default bg-surface-primary px-4 py-3 text-left last:border-b-0 hover:bg-surface-secondary";
  return item.paymentId ? (
    <Link to="/app/payments/$id" params={{ id: item.paymentId }} className={className}>
      {body}
    </Link>
  ) : (
    <Link to="/app/orders/$id" params={{ id: item.orderId }} className={className}>
      {body}
    </Link>
  );
}

export function ExcessToReturnList({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}) {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ["payments", userId, organizationId, "excess-to-return"],
    queryFn: ({ pageParam }) => listRealExcessToReturn({ limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.items.length;
      return lastPage.items.length > 0 && next < lastPage.total ? next : undefined;
    },
  });
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  // The newest page's count: exact at the moment it was read.
  const total = query.data?.pages.at(-1)?.total ?? null;
  const errorKind = query.isError ? classifyPaymentError(query.error) : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption px-1 text-text-secondary" role="note">
        {t("payments.excessToReturn.note")}
      </p>
      {total !== null ? (
        <p className="text-body-sm px-1 text-text-primary" role="status">
          {t("payments.excessToReturn.count", { count: total })}
        </p>
      ) : null}
      <div className="list-enter overflow-hidden rounded-2xl border border-border-default">
        {query.isLoading ? <ListSkeleton rows={4} /> : null}
        {errorKind ? (
          <OperationalState
            tone="danger"
            title={
              errorKind === "forbidden"
                ? t("payments.list.forbidden.title")
                : t("payments.list.error.title")
            }
            body={
              errorKind === "forbidden"
                ? t("payments.list.forbidden.body")
                : t("payments.list.error.body")
            }
            {...(errorKind === "forbidden" ? {} : { onRetry: () => void query.refetch() })}
            className="rounded-none border-0"
          />
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <OperationalState
            title={t("payments.excessToReturn.empty.title")}
            body={t("payments.excessToReturn.empty.body")}
            className="rounded-none border-0"
          />
        ) : null}
        {items.map((item) => (
          <ExcessRow key={`${item.kind}:${item.paymentId ?? item.orderId}`} item={item} />
        ))}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          className="tap-target h-11 w-full"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? t("payments.list.loadingMore") : t("payments.list.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
