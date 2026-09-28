/**
 * The status facts on one Customer 360 order-history row — lifecycle via the
 * StatusBadge (as the Orders list shows it), payment, refund and fulfilment as
 * their own StatusChips. Which facts appear, and in which order, is decided by
 * customerOrderStatusFacts (src/lib/customers-view.ts).
 */
import { StatusBadge, StatusChip } from "@/design-system";
import { customerOrderStatusFacts } from "@/lib/customers-view";
import type { Order } from "@/types";

export function CustomerOrderStatuses({
  order,
}: {
  order: Pick<Order, "lifecycleStatus" | "paymentStatus" | "fulfillmentStatus" | "refundStatus">;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {customerOrderStatusFacts(order).map((fact) =>
        fact.axis === "lifecycle" ? (
          <StatusBadge key={fact.axis} status={fact.status} size="sm" />
        ) : (
          <StatusChip key={fact.axis} status={fact.status} />
        ),
      )}
    </div>
  );
}
