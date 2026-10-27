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
 *   to_pack           Pack order — unless the packed rule says the order is
 *                     already packed (packedReview): then Arrange delivery,
 *                     as Next Action does for a packed order without one.
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

export function attentionNextStep(
  view: OrderAttentionFilter,
  order: { lifecycleStatus?: OrderLifecycleStatus | undefined; paymentStatus: PaymentStatus },
  packedReview: boolean,
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
      return packedReview
        ? action("arrange_delivery", can("delivery.create"))
        : action("pack_order", can("orders.read") && can("delivery.handoff"));
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
