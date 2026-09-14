import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  BottomSheet,
  CustomerSummaryCard,
  ErrorState,
  SkeletonBlock,
  StatusChip,
} from "@/design-system";
import { getCustomerOrders, isProductionId } from "@/lib/api";
import { customerKeys, visibleCustomerPhone } from "@/lib/customers-query";
import { useCapabilities } from "@/hooks/use-capabilities";
import { fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { Customer } from "@/types";

interface CustomerDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
  displayName: string;
  /** From the /app route guard's server-derived context — cache identity only. */
  userId: string;
  /** From the /app route guard's server-derived context — cache identity only. */
  organizationId: string;
}

export function CustomerDetailSheet({
  open,
  onOpenChange,
  customer,
  displayName,
  userId,
  organizationId,
}: CustomerDetailSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();

  /*
   * Real order history, from the production Order domain (listOrdersFn filters
   * by customerId in SQL). This used to read the in-memory `orders` fixture,
   * so a live conversation showed invented order codes and totals next to a
   * real customer.
   *
   * The key is partitioned by the server-derived principal, so one tab cannot
   * serve Organization A's order history to Organization B — and it sits under
   * this customer's own detail key, so a customer purge takes it with it.
   *
   * `isProductionId` gates the fetch rather than the server rejecting it: a
   * non-UUID id is a pre-production mock id with no production meaning, and
   * getCustomerOrders() refuses it outright rather than falling back to
   * fixtures.
   */
  const ordersQuery = useQuery({
    queryKey: customerKeys.orders(userId, organizationId, customer.id),
    queryFn: () => getCustomerOrders(customer.id),
    enabled: open && isProductionId(customer.id) && capabilities.can("orders.read"),
  });

  const orders = ordersQuery.data ?? [];
  const historyUnavailable =
    open && !(isProductionId(customer.id) && capabilities.can("orders.read"));

  /*
   * The phone is masked against the CURRENT capability answer, not against
   * whatever the cached customer payload happens to carry: a profile fetched
   * while customers.view_sensitive held stays in the cache after the grant is
   * revoked, and nothing refetches it on its own.
   */
  const maskedCustomer: Customer = {
    ...customer,
    phone: visibleCustomerPhone(customer, capabilities.canSensitive("customers.view_sensitive")),
  };

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} snap="half" className="lg:max-w-[520px]">
      <div className="space-y-5 pb-2">
        <CustomerSummaryCard customer={maskedCustomer} displayName={displayName} />

        <section aria-labelledby="recent-orders-heading">
          <h3 id="recent-orders-heading" className="text-h3 text-text-primary">
            {t("conversation.customer.recentOrders")}
          </h3>
          {!historyUnavailable && ordersQuery.isPending ? (
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
          {/*
           * Neither loading, nor failed, nor an answer: the history was never
           * asked for, because this member lacks orders.read or the customer
           * has no production id. Saying "no orders" here would be a claim the
           * screen cannot make.
           */}
          {historyUnavailable ? (
            <p className="text-body-sm mt-2 text-text-secondary">
              {t("conversation.customer.ordersUnavailable")}
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
                  {/*
                   * A production order SUMMARY carries no lines (the server
                   * sends them only with the detail), so this renders nothing
                   * rather than an empty line pretending to be a line list.
                   */}
                  {order.items.length > 0 ? (
                    <span className="text-caption block truncate text-text-secondary">
                      {order.items.map((i) => `${i.quantity}× ${i.nameEn}`).join(", ")}
                    </span>
                  ) : null}
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
          onClick={() => {
            onOpenChange(false);
            void navigate({ to: "/app/customers/$id", params: { id: customer.id } });
          }}
          className="tap-target text-label w-full rounded-xl border border-border-default text-action-primary"
        >
          {t("customer.viewProfile")}
        </button>
      </div>
    </BottomSheet>
  );
}
