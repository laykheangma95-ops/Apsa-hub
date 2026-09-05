/** Authoritative Delivery lifecycle. Kept separate from the coarse Order fulfillment axis. */
export const DELIVERY_STATUSES = [
  "pending",
  "preparing",
  "ready",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["in_transit", "cancelled"],
  in_transit: ["delivered", "failed"],
  delivered: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "delivered",
  "failed",
  "cancelled",
];

export type DeliveryOrderFulfillment = "unfulfilled" | "processing" | "fulfilled" | "cancelled";

/** The only mapping used when a Delivery transition drives its parent Order. */
export const DELIVERY_TO_ORDER_FULFILLMENT: Readonly<
  Record<DeliveryStatus, DeliveryOrderFulfillment>
> = {
  pending: "processing",
  preparing: "processing",
  ready: "processing",
  in_transit: "processing",
  delivered: "fulfilled",
  failed: "unfulfilled",
  cancelled: "unfulfilled",
};

export function isValidDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}
