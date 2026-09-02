import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BottomSheet, CustomerSummaryCard, ErrorState, SkeletonBlock, StatusChip } from "@/design-system";
import { getCustomerOrders } from "@/lib/api";
import { fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { Customer } from "@/types";

interface CustomerDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
  displayName: string;
}

export function CustomerDetailSheet({
  open,
  onOpenChange,
  customer,
  displayName,
}: CustomerDetailSheetProps) {
  const { t } = useTranslation();
  const ordersQuery = useQuery({
    queryKey: ["customer-orders", customer.id],
    queryFn: () => getCustomerOrders(customer.id),
    enabled: open,
  });

  const orders = ordersQuery.data ?? [];

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} snap="half" className="lg:max-w-[520px]">
      <div className="space-y-5 pb-2">
        <CustomerSummaryCard customer={customer} displayName={displayName} />

        <section aria-labelledby="recent-orders-heading">
          <h3 id="recent-orders-heading" className="text-h3 text-text-primary">
            {t("conversation.customer.recentOrders")}
          </h3>
          {ordersQuery.isPending ? (
            <div className="mt-2 space-y-2">
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-14 w-full" />
            </div>
          ) : null}
          {ordersQuery.isError ? (
            <ErrorState onRetry={() => void ordersQuery.refetch()} className="py-6" />
          ) : null}
          {ordersQuery.isSuccess && orders.length === 0 ? (
            <p className="text-body-sm mt-2 text-text-secondary">
              {t("conversation.customer.noOrders")}
            </p>
          ) : null}
          <ul className="mt-2 space-y-2">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex items-center gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-label tnum block text-text-primary">{order.code}</span>
                  <span className="text-caption block truncate text-text-secondary">
                    {order.items.map((i) => `${i.quantity}× ${i.nameEn}`).join(", ")}
                  </span>
                </span>
                <StatusChip status={order.fulfillmentStatus} />
                <span className="text-financial shrink-0 text-text-primary">
                  {formatMoney(order.total)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="timeline-heading">
          <h3 id="timeline-heading" className="text-h3 text-text-primary">
            {t("conversation.customer.timeline")}
          </h3>
          <ol className="mt-2 space-y-3 border-l border-border-default pl-4">
            {orders.slice(0, 4).map((order) => (
              <li key={`tl-${order.id}`} className="relative">
                <span
                  aria-hidden
                  className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-action-primary"
                />
                <p className="text-body-sm text-text-primary">
                  {t(
                    order.fulfillmentStatus === "delivered"
                      ? "conversation.timeline.delivered"
                      : order.paymentStatus === "paid"
                        ? "conversation.timeline.paid"
                        : "conversation.timeline.created",
                    { code: order.code },
                  )}
                </p>
                <p className="text-caption text-text-muted">{fullTimestamp(order.createdAt)}</p>
              </li>
            ))}
          </ol>
        </section>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="tap-target text-label w-full rounded-xl border border-border-default text-action-primary"
        >
          {t("customer.viewProfile")}
        </button>
      </div>
    </BottomSheet>
  );
}
