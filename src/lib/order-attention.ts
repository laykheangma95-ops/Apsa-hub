/**
 * Orders attention views — what one row says about waiting time and the next
 * step. Pure and safe to bundle: no I/O, no clock (the caller passes `now`).
 *
 * The next step here is a HINT on a list row, never an action: the row opens
 * Order detail, whose Smart Next Action (src/lib/order-next-action.ts) decides
 * and executes, re-checked by the server. The hint reuses that panel's action
 * labels (order.next.action.*) and follows the same rules for the one view it
 * describes:
 *
 *   awaiting_payment  draft → Confirm order (a draft is confirmed first);
 *                     pending (awaiting confirmation, or part paid) → Confirm
 *                     payment; unpaid / failed → Record payment.
 *   to_pack           Pack order (the database listed it as not packed).
 *   packed_needs_delivery
 *                     Packed, nothing ready or out. As Next Action: a pending /
 *                     preparing delivery was never readied → "Retry delivery
 *                     ready" on Order detail (no list action); otherwise
 *                     Arrange delivery, with the reason (none arranged, last
 *                     failed, last cancelled). Without delivery.read the
 *                     delivery is unknown, so no reason or action is guessed.
 *   waiting_pickup    Hand to courier.
 *
 * When the member lacks the grant the step needs, the hint says a teammate
 * must do it instead of naming an action they cannot take.
 */
import type { UiPermissionKey } from "@/lib/capabilities";
import type { OrderAttentionFilter } from "@/lib/order-list-filters";
import type { OrderLifecycleStatus, PaymentStatus } from "@/types";

export type AttentionNextStep =
  { kind: "action"; actionKey: string } | { kind: "teammate" } | { kind: "none" };

/**
 * The reason line for a packed order with no delivery ready or out — Next
 * Action's own reason key (order.next.reason.*). null when the member cannot
 * see the delivery, so nothing is claimed about it.
 */
export function packedDeliveryReasonKey(delivery: { status: string | null } | null): string | null {
  if (!delivery) return null;
  switch (delivery.status) {
    case "pending":
    case "preparing":
      return "order.next.reason.deliveryNotReady";
    case "failed":
      return "order.next.reason.deliveryFailed";
    case "cancelled":
      return "order.next.reason.deliveryCancelled";
    default:
      return "order.next.reason.packedNoDelivery";
  }
}

export function attentionNextStep(
  view: OrderAttentionFilter,
  order: { lifecycleStatus?: OrderLifecycleStatus | undefined; paymentStatus: PaymentStatus },
  /** The row's delivery facts; null when the member may not read deliveries. */
  delivery: { status: string | null } | null,
  can: (key: UiPermissionKey) => boolean,
): AttentionNextStep {
  const action = (id: string, allowed: boolean): AttentionNextStep =>
    allowed ? { kind: "action", actionKey: `order.next.action.${id}` } : { kind: "teammate" };

  switch (view) {
    case "awaiting_payment":
      if (order.lifecycleStatus === "draft") return action("confirm_order", can("orders.confirm"));
      if (order.paymentStatus === "pending") {
        return action("review_payment", can("payments.manual_confirm") || can("payments.verify"));
      }
      if (order.paymentStatus === "unpaid" || order.paymentStatus === "failed") {
        return action("record_payment", can("payments.record") || can("payments.mark_cod"));
      }
      return { kind: "none" };
    case "to_pack":
      return action("pack_order", can("orders.read") && can("delivery.handoff"));
    case "packed_needs_delivery":
      if (!delivery) return { kind: "none" };
      if (delivery.status === "pending" || delivery.status === "preparing") return { kind: "none" };
      return action("arrange_delivery", can("delivery.create"));
    case "waiting_pickup":
      return action("courier_handoff", can("delivery.handoff"));
  }
}

export type WaitingDuration =
  | { unit: "minutes"; count: number }
  | { unit: "hours"; count: number }
  | { unit: "days"; count: number };

/**
 * Whole minutes, hours or days since `sinceIso`, rounded down. A time in the
 * future (clock skew between phone and server) reads as 0 minutes, never as a
 * negative wait. null when the timestamp cannot be read.
 */
export function waitingDuration(sinceIso: string, nowMs: number): WaitingDuration | null {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - since) / 60_000));
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
