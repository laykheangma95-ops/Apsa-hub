/**
 * Order detail — Smart Next Action.
 *
 * Pure: no I/O, no React, no clock. Given the order's three authoritative axes
 * (lifecycle / payment / fulfillment, plus the independent refund axis), the
 * deliveries and packed state the screen has already read, and the member's
 * capability snapshot, it answers ONE question for the merchant: what happens
 * next on this order, and can I do it?
 *
 * This is a VIEW, never a status. It invents no order state and no transition:
 * every executable action it returns is backed by a server path that already
 * exists and re-checks both the permission and the state under lock —
 *
 *   confirm_order     transitionOrderLifecycleFn  draft → confirmed      orders.confirm
 *   complete_order    transitionOrderLifecycleFn  confirmed → completed  orders.update
 *                     (the DB refuses unless payment = paid AND fulfillment = fulfilled)
 *   cancel_order      transitionOrderLifecycleFn  → cancelled            orders.cancel
 *   record_payment    recordPaymentFn                                    payments.record | payments.mark_cod
 *   review_payment    /app/payments/$id (verifyPaymentFn)                payments.manual_confirm | payments.verify
 *   pack_order        /app/pack/$orderId (markOrderPacked)               orders.read + delivery.handoff
 *   arrange_delivery  createDeliveryFn                                   delivery.create
 *   courier_handoff   /app/handoff/$parcelCode (confirmHandoff)          delivery.handoff
 *   track_delivery    /app/deliveries/$id (transitionDeliveryFn)         delivery.read (update to move it)
 *   start_return      /app/returns/new (requestCustomerReturn)           orders.return
 *   open_payments     /app/payments                                      payments.read
 *
 * What it deliberately does NOT offer (see the PR's audit):
 *   - a "hand to customer" action for counter / pickup orders: the fulfillment
 *     move exists server-side but has no guard against an active delivery, so
 *     it is not exposed until that guard exists;
 *   - Cancel once the goods have left the shop (fulfilled, a delivery in
 *     transit or delivered): the server would accept it and restock units the
 *     customer already holds. Hiding it here is a presentation mitigation only;
 *     the server-side fix is a separate, security-reviewed change.
 *
 * Money never enters this function. It reads statuses only, so a USD order and
 * a KHR order derive identically and no amount is ever added, converted or
 * compared here.
 *
 * Fail closed on identity: if the capability snapshot or the order data does
 * not belong to the route's principal (a stale snapshot mid organization
 * switch, a late response for the previous principal), nothing is offered.
 */
import type { CapabilityView, UiPermissionKey } from "@/lib/capabilities";
import type { RealDeliveryStatus } from "@/lib/deliveries";
import type {
  FulfillmentStatus,
  OrderLifecycleStatus,
  OrderRefundStatus,
  PaymentStatus,
} from "@/types";

export type OrderActionId =
  | "confirm_order"
  | "complete_order"
  | "cancel_order"
  | "record_payment"
  | "review_payment"
  | "pack_order"
  | "arrange_delivery"
  | "courier_handoff"
  | "track_delivery"
  | "start_return"
  | "open_payments";

/** Where a navigating action goes. In-screen actions (sheets, mutations) have none. */
export type OrderActionDestination =
  | { to: "/app/pack/$orderId"; params: { orderId: string } }
  | { to: "/app/handoff/$parcelCode"; params: { parcelCode: string } }
  | { to: "/app/deliveries/$id"; params: { id: string } }
  | { to: "/app/payments/$id"; params: { id: string } }
  | { to: "/app/payments" }
  | { to: "/app/returns/new" };

export interface OrderActionItem {
  id: OrderActionId;
  destination: OrderActionDestination | null;
}

/**
 *   available  the member can take the primary action now
 *   waiting    the next step belongs to someone else (another role, the courier)
 *   blocked    something must be resolved first (parcel missing, delivery not ready)
 *   loading    an input the decision depends on has not arrived yet
 *   completed  the order is done
 *   closed     the order was cancelled
 */
export type NextActionStatus =
  "available" | "waiting" | "blocked" | "loading" | "completed" | "closed";

export type WorkflowStepKey = "order" | "payment" | "packing" | "handoff";

/**
 *   done      the step is finished
 *   current   the step the order is on
 *   upcoming  not reached yet
 *   cancelled the order was cancelled before the step finished
 */
export type WorkflowStepState = "done" | "current" | "upcoming" | "cancelled";

export interface WorkflowStep {
  key: WorkflowStepKey;
  state: WorkflowStepState;
  /** i18n key for the step's own status line. */
  detailKey: string;
}

export interface OrderNextAction {
  status: NextActionStatus;
  /** i18n key: the human-readable explanation. */
  reasonKey: string;
  /** i18n key: a payment remark that applies alongside a fulfillment step (COD, outstanding). */
  paymentNoteKey: string | null;
  primary: OrderActionItem | null;
  secondary: OrderActionItem[];
  steps: WorkflowStep[];
  /** A read this decision depends on failed; re-reading it may resolve the block. */
  retryable: boolean;
}

export interface NextActionOrder {
  id: string;
  lifecycleStatus: OrderLifecycleStatus | undefined;
  paymentStatus: PaymentStatus;
  refundStatus: OrderRefundStatus | undefined;
  fulfillmentStatus: FulfillmentStatus;
}

export type NextActionCapabilities = Pick<CapabilityView, "state" | "organizationId" | "can">;

export interface NextActionPrincipal {
  userId: string;
  organizationId: string;
}

export interface NextActionDeliveries {
  /** Newest delivery for this order, if any. */
  latestId: string | null;
  latestStatus: RealDeliveryStatus | null;
  /** The non-terminal delivery, if any (at most one per order). */
  activeId: string | null;
  activeStatus: RealDeliveryStatus | null;
  /** Any delivery for this order reached `delivered` (returns require one). */
  anyDelivered: boolean;
  /** The latest delivery carries a COD amount for the courier to collect. */
  latestHasCod: boolean;
}

export interface NextActionContext {
  /** The route's server-derived principal. */
  principal: NextActionPrincipal;
  /** The principal the order data was fetched for (its query partition). */
  dataPrincipal: NextActionPrincipal;
  /** Confirmed, but its APSA Parcel was never created. */
  parcelMissing: boolean;
  /** null until the deliveries read succeeds. */
  deliveries: NextActionDeliveries | null;
  /** The deliveries read failed (deliveries is then null). */
  deliveriesUnavailable: boolean;
  /** The server's packed state; "loading" until read, "unavailable" if the read failed. */
  packed: boolean | "loading" | "unavailable";
  /** Returned only to members holding delivery.handoff. */
  parcelCode: string | null;
  /** The newest still-unsettled payment on this order, when the payments read is available. */
  pendingPaymentId: string | null;
}

const NO_ACTION: Pick<OrderNextAction, "primary" | "secondary" | "paymentNoteKey" | "retryable"> = {
  primary: null,
  secondary: [],
  paymentNoteKey: null,
  retryable: false,
};

function samePrincipal(a: NextActionPrincipal, b: NextActionPrincipal): boolean {
  return a.userId === b.userId && a.organizationId === b.organizationId;
}

function goodsHaveLeft(order: NextActionOrder, deliveries: NextActionDeliveries): boolean {
  return (
    order.fulfillmentStatus === "fulfilled" ||
    deliveries.anyDelivered ||
    deliveries.activeStatus === "in_transit"
  );
}

/** The steps strip, derived from the axes alone (no permission involved). */
export function deriveWorkflowSteps(
  order: NextActionOrder,
  context: Pick<NextActionContext, "deliveries" | "packed">,
): WorkflowStep[] {
  const lifecycle = order.lifecycleStatus;
  const cancelled = lifecycle === "cancelled";
  const completed = lifecycle === "completed";
  const paid = order.paymentStatus === "paid";
  const fulfilled = order.fulfillmentStatus === "fulfilled" || completed;
  const packed = context.packed === true;
  const deliveryStatus = context.deliveries?.activeStatus ?? context.deliveries?.latestStatus;

  const orderStep: WorkflowStep = {
    key: "order",
    state: cancelled ? "cancelled" : lifecycle === "draft" ? "current" : "done",
    detailKey: cancelled
      ? "order.next.step.orderCancelled"
      : lifecycle === "draft"
        ? "order.next.step.orderDraft"
        : completed
          ? "order.next.step.orderCompleted"
          : "order.next.step.orderConfirmed",
  };

  const unfinished = (current: boolean): WorkflowStepState =>
    cancelled ? "cancelled" : current ? "current" : "upcoming";
  const live = lifecycle === "confirmed";

  const paymentStep: WorkflowStep = {
    key: "payment",
    state: paid ? "done" : unfinished(live),
    detailKey: paid
      ? "order.next.step.paymentPaid"
      : order.paymentStatus === "pending"
        ? "order.next.step.paymentPending"
        : order.paymentStatus === "failed"
          ? "order.next.step.paymentFailed"
          : context.deliveries?.latestHasCod
            ? "order.next.step.paymentCod"
            : "order.next.step.paymentUnpaid",
  };

  const packingDone = fulfilled || packed || deliveryStatus === "in_transit";
  const packingStep: WorkflowStep = {
    key: "packing",
    state: packingDone ? "done" : unfinished(live),
    detailKey: packingDone ? "order.next.step.packed" : "order.next.step.notPacked",
  };

  const handoffStep: WorkflowStep = {
    key: "handoff",
    state: fulfilled ? "done" : unfinished(live && packingDone),
    detailKey: fulfilled
      ? "order.next.step.handedOver"
      : deliveryStatus === "in_transit"
        ? "order.next.step.inTransit"
        : deliveryStatus === "ready"
          ? "order.next.step.readyForCourier"
          : deliveryStatus === "pending" || deliveryStatus === "preparing"
            ? "order.next.step.deliveryArranged"
            : deliveryStatus === "failed"
              ? "order.next.step.deliveryFailed"
              : "order.next.step.notHandedOver",
  };

  return [orderStep, paymentStep, packingStep, handoffStep];
}

/** The payment step's action, if this member may take one. */
function paymentAction(
  order: NextActionOrder,
  can: (key: UiPermissionKey) => boolean,
  context: NextActionContext,
): OrderActionItem | null {
  if (order.paymentStatus === "pending") {
    if (!can("payments.manual_confirm") && !can("payments.verify")) return null;
    return {
      id: "review_payment",
      destination: context.pendingPaymentId
        ? { to: "/app/payments/$id", params: { id: context.pendingPaymentId } }
        : { to: "/app/payments" },
    };
  }
  if (can("payments.record") || can("payments.mark_cod")) {
    return { id: "record_payment", destination: null };
  }
  return null;
}

/** Payment remark shown beside a fulfillment step: packing never waits for money (COD). */
function paymentNote(order: NextActionOrder, deliveries: NextActionDeliveries | null) {
  if (order.paymentStatus === "paid") return null;
  if (order.paymentStatus === "pending") return "order.next.note.paymentPending";
  if (deliveries?.latestHasCod) return "order.next.note.cod";
  return "order.next.note.paymentOutstanding";
}

export function deriveOrderNextAction(
  order: NextActionOrder,
  capabilities: NextActionCapabilities,
  context: NextActionContext,
): OrderNextAction {
  const steps = deriveWorkflowSteps(order, context);

  // ── Identity: fail closed before reading a single permission ──────────────
  if (
    !context.principal.userId ||
    !context.principal.organizationId ||
    !samePrincipal(context.principal, context.dataPrincipal)
  ) {
    return { status: "blocked", reasonKey: "order.next.reason.identity", steps, ...NO_ACTION };
  }
  if (capabilities.state === "pending") {
    return { status: "loading", reasonKey: "order.next.reason.loading", steps, ...NO_ACTION };
  }
  if (
    capabilities.state !== "ready" ||
    capabilities.organizationId !== context.principal.organizationId
  ) {
    return { status: "blocked", reasonKey: "order.next.reason.identity", steps, ...NO_ACTION };
  }
  const can = (key: UiPermissionKey) => capabilities.can(key);

  const lifecycle = order.lifecycleStatus;
  const deliveries = context.deliveries;

  // ── Terminal lifecycles ──────────────────────────────────────────────────
  if (lifecycle === "cancelled") {
    const refundOpen = order.paymentStatus === "paid" && order.refundStatus !== "full";
    return {
      status: "closed",
      reasonKey: refundOpen ? "order.next.reason.cancelledPaid" : "order.next.reason.cancelled",
      paymentNoteKey: null,
      primary: null,
      retryable: false,
      secondary:
        refundOpen && can("payments.read")
          ? [{ id: "open_payments", destination: { to: "/app/payments" } }]
          : [],
      steps,
    };
  }

  if (lifecycle === "completed") {
    return {
      status: "completed",
      reasonKey:
        order.refundStatus === "full"
          ? "order.next.reason.completedRefunded"
          : order.refundStatus === "partial"
            ? "order.next.reason.completedPartRefunded"
            : "order.next.reason.completed",
      paymentNoteKey: null,
      primary: null,
      retryable: false,
      // Returns require a delivered delivery (migration 056); counter / pickup
      // orders cannot be returned yet, so the action is not offered for them.
      secondary:
        deliveries?.anyDelivered && can("orders.return")
          ? [{ id: "start_return", destination: { to: "/app/returns/new" } }]
          : [],
      steps,
    };
  }

  if (lifecycle === "draft") {
    const cancel: OrderActionItem[] = can("orders.cancel")
      ? [{ id: "cancel_order", destination: null }]
      : [];
    return can("orders.confirm")
      ? {
          status: "available",
          reasonKey: "order.next.reason.draft",
          paymentNoteKey: null,
          primary: { id: "confirm_order", destination: null },
          secondary: cancel,
          steps,
          retryable: false,
        }
      : {
          status: "waiting",
          reasonKey: "order.next.reason.draftNoPermission",
          paymentNoteKey: null,
          primary: null,
          secondary: cancel,
          steps,
          retryable: false,
        };
  }

  if (lifecycle !== "confirmed") {
    return { status: "blocked", reasonKey: "order.next.reason.unknown", steps, ...NO_ACTION };
  }

  // ── Confirmed: payment, packing and hand-over are independent axes ─────────

  // Cancel is offered only while the goods are provably still in the shop. An
  // unread deliveries list is not proof, so it waits for the read.
  const secondary: OrderActionItem[] =
    can("orders.cancel") &&
    deliveries !== null &&
    (order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "processing") &&
    !goodsHaveLeft(order, deliveries)
      ? [{ id: "cancel_order", destination: null }]
      : [];

  const result = (
    status: NextActionStatus,
    reasonKey: string,
    primary: OrderActionItem | null,
    extra: {
      paymentNoteKey?: string | null;
      secondary?: OrderActionItem[];
      retryable?: boolean;
    } = {},
  ): OrderNextAction => ({
    status,
    reasonKey,
    paymentNoteKey: extra.paymentNoteKey ?? null,
    primary,
    secondary: [...(extra.secondary ?? []), ...secondary],
    steps,
    retryable: extra.retryable ?? false,
  });

  if (context.parcelMissing) {
    return result("blocked", "order.next.reason.parcelMissing", null);
  }

  // Goods with the customer: only money (and closing the order) remains.
  if (order.fulfillmentStatus === "fulfilled") {
    if (order.paymentStatus === "paid") {
      return can("orders.update")
        ? result("available", "order.next.reason.readyToComplete", {
            id: "complete_order",
            destination: null,
          })
        : result("waiting", "order.next.reason.readyToCompleteNoPermission", null);
    }
    const pay = paymentAction(order, can, context);
    const reasonKey =
      order.paymentStatus === "pending"
        ? "order.next.reason.deliveredPaymentPending"
        : "order.next.reason.deliveredUnpaid";
    return pay
      ? result("available", reasonKey, pay)
      : result("waiting", `${reasonKey}NoPermission`, null);
  }

  if (order.fulfillmentStatus === "cancelled") {
    // Only reachable through a cancellation, which also cancels the lifecycle.
    return result("blocked", "order.next.reason.unknown", null);
  }

  if (deliveries === null) {
    return context.deliveriesUnavailable
      ? result("blocked", "order.next.reason.deliveriesUnavailable", null, { retryable: true })
      : result("loading", "order.next.reason.loading", null);
  }

  const note = paymentNote(order, deliveries);
  const trackDelivery = (id: string | null): OrderActionItem | null =>
    id && can("delivery.read")
      ? { id: "track_delivery", destination: { to: "/app/deliveries/$id", params: { id } } }
      : null;

  // With the courier: the delivery screen records the outcome.
  if (deliveries.activeStatus === "in_transit") {
    const track = trackDelivery(deliveries.activeId);
    return track && can("delivery.update")
      ? result("available", "order.next.reason.inTransit", track, { paymentNoteKey: note })
      : result("waiting", "order.next.reason.inTransitNoPermission", null, {
          paymentNoteKey: note,
          ...(track ? { secondary: [track] } : {}),
        });
  }

  if (context.packed === "loading") {
    return result("loading", "order.next.reason.loading", null, { paymentNoteKey: note });
  }
  if (context.packed === "unavailable") {
    return result("blocked", "order.next.reason.packStateUnavailable", null, {
      paymentNoteKey: note,
      retryable: true,
    });
  }

  if (!context.packed) {
    // Mark Packed requires orders.read + delivery.handoff (packing/service.ts).
    return can("orders.read") && can("delivery.handoff")
      ? result(
          "available",
          "order.next.reason.readyToPack",
          {
            id: "pack_order",
            destination: { to: "/app/pack/$orderId", params: { orderId: order.id } },
          },
          { paymentNoteKey: note },
        )
      : result("waiting", "order.next.reason.readyToPackNoPermission", null, {
          paymentNoteKey: note,
        });
  }

  // Packed.
  if (deliveries.activeStatus === "ready") {
    return can("delivery.handoff") && context.parcelCode
      ? result(
          "available",
          "order.next.reason.readyForCourier",
          {
            id: "courier_handoff",
            destination: {
              to: "/app/handoff/$parcelCode",
              params: { parcelCode: context.parcelCode },
            },
          },
          { paymentNoteKey: note },
        )
      : result("waiting", "order.next.reason.readyForCourierNoPermission", null, {
          paymentNoteKey: note,
        });
  }

  if (deliveries.activeStatus === "pending" || deliveries.activeStatus === "preparing") {
    // Packed but its delivery never became ready: the Fulfillment section's
    // "Retry delivery ready" recovers it (delivery.handoff).
    return result("blocked", "order.next.reason.deliveryNotReady", null, {
      paymentNoteKey: note,
    });
  }

  // Packed, no active delivery.
  const reasonKey =
    deliveries.latestStatus === "failed"
      ? "order.next.reason.deliveryFailed"
      : deliveries.latestStatus === "cancelled"
        ? "order.next.reason.deliveryCancelled"
        : "order.next.reason.packedNoDelivery";
  return can("delivery.create")
    ? result(
        "available",
        reasonKey,
        { id: "arrange_delivery", destination: null },
        {
          paymentNoteKey: note,
        },
      )
    : result("waiting", `${reasonKey}NoPermission`, null, { paymentNoteKey: note });
}
