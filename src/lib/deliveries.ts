/**
 * Pure helpers for the production Delivery domain UI: mapping server shapes
 * to the UI's shapes, transition-visibility rules, and error classification.
 *
 * No React, no fetching, no server imports at runtime — only `import type`
 * (erased at compile time, never bundled), matching src/lib/orders.ts. The
 * DELIVERY_TRANSITIONS table below is a deliberate, pure, client-side READ of
 * "what button to show" — a duplicate of src/server/deliveries/state-machine.ts,
 * never a substitute for server authorization (ARCHITECTURE.md: "Service/
 * application layer is authoritative for authorization"). Every transition
 * here still goes through the server functions in src/api/deliveries.ts.
 */
import type {
  DeliveryDetail as ServerDeliveryDetail,
  DeliveryHistoryEntry as ServerDeliveryHistoryEntry,
  DeliverySummary as ServerDeliverySummary,
} from "@/server/deliveries/service";
import type { DeliveryStatus as RealDeliveryStatus } from "@/server/deliveries/state-machine";
import type { FulfillmentStatus, Money, OrderLifecycleStatus } from "@/types";

// Re-exported so callers (e.g. src/routes/app.deliveries.$id.tsx) never need
// their own import of the server-only state-machine module — this file's
// `import type` (erased at compile time) is the only place that touches it.
export type { RealDeliveryStatus };

// ── Server → UI mapping ───────────────────────────────────────────────────────

export interface RealDelivery {
  id: string;
  orderId: string;
  locationId: string | null;
  providerId: string | null;
  providerKey: string | null;
  providerName: string;
  externalTrackingNumber: string | null;
  /** Operational COD reference only — never a signal that the order is paid. */
  codAmount: Money | null;
  status: RealDeliveryStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RealDeliveryHistoryEntry {
  id: string;
  fromStatus: RealDeliveryStatus | null;
  toStatus: RealDeliveryStatus;
  changedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RealDeliveryDetail extends RealDelivery {
  history: RealDeliveryHistoryEntry[];
}

export function mapDeliverySummaryToUi(row: ServerDeliverySummary): RealDelivery {
  return {
    id: row.id,
    orderId: row.orderId,
    locationId: row.locationId,
    providerId: row.providerId,
    providerKey: row.providerKey,
    providerName: row.providerName,
    externalTrackingNumber: row.externalTrackingNumber,
    codAmount: row.codAmount,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapHistoryEntry(row: ServerDeliveryHistoryEntry): RealDeliveryHistoryEntry {
  return {
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    changedBy: row.changedBy,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

export function mapDeliveryDetailToUi(detail: ServerDeliveryDetail): RealDeliveryDetail {
  return {
    ...mapDeliverySummaryToUi(detail),
    history: detail.history.map(mapHistoryEntry),
  };
}

// ── Transition-visibility rules (mirrors src/server/deliveries/state-machine.ts) ──

const DELIVERY_TRANSITIONS: Readonly<Record<RealDeliveryStatus, readonly RealDeliveryStatus[]>> = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["in_transit", "cancelled"],
  in_transit: ["delivered", "failed"],
  delivered: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_DELIVERY_STATUSES: readonly RealDeliveryStatus[] = ["delivered", "failed", "cancelled"];

export function isValidDeliveryTransition(from: RealDeliveryStatus, to: RealDeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isTerminalDeliveryStatus(status: RealDeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

export const canStartPreparingDelivery = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "preparing");
export const canMarkDeliveryReady = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "ready");
export const canMarkDeliveryInTransit = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "in_transit");
export const canMarkDeliveryDelivered = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "delivered");
export const canMarkDeliveryFailed = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "failed");
export const canCancelDelivery = (status: RealDeliveryStatus): boolean =>
  isValidDeliveryTransition(status, "cancelled");

/**
 * Client-side READ of whether a confirmed order can accept a new delivery —
 * mirrors the eligibility checks at the top of createDelivery()
 * (src/server/deliveries/service.ts). The server re-validates independently
 * (lifecycle, fulfillment, and any existing active delivery) and is the only
 * place a creation is actually accepted.
 */
export function canCreateDeliveryForOrder(order: {
  lifecycleStatus: OrderLifecycleStatus | undefined;
  fulfillmentStatus: FulfillmentStatus | undefined;
}): boolean {
  return (
    order.lifecycleStatus === "confirmed" &&
    order.fulfillmentStatus !== "fulfilled" &&
    order.fulfillmentStatus !== "cancelled"
  );
}

/** True when a delivery for the order is still open (not terminal) — i.e. blocks a new one. */
export function isActiveDeliveryStatus(status: RealDeliveryStatus): boolean {
  return !isTerminalDeliveryStatus(status);
}

// ── Error classification ──────────────────────────────────────────────────────
//
// src/server/deliveries/service.ts throws Error instances carrying a
// `statusCode` own property (400/401/403/404/409) with a clean, human-authored
// message — never raw SQL/PostgREST text for these mapped cases. This mirrors
// classifyOrderError in src/lib/orders.ts. Never surfaces err.message directly
// to the merchant.

export type DeliveryErrorKind =
  "unauthorized" | "forbidden" | "not_found" | "stale" | "invalid" | "server_error";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

function statusCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

export function classifyDeliveryError(err: unknown): DeliveryErrorKind {
  const code = statusCodeOf(err);
  const message = messageOf(err);

  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 404) return "not_found";
  if (code === 409) {
    return /changed concurrently/i.test(message) ? "stale" : "invalid";
  }
  if (code === 400) return "invalid";

  // Fallback for the rare case a statusCode does not survive the RPC
  // boundary: pattern-match service.ts's own crafted message text.
  if (/not authenticated|no active organization membership/i.test(message)) return "unauthorized";
  if (/missing permission/i.test(message)) return "forbidden";
  if (/not found/i.test(message)) return "not_found";
  if (/changed concurrently/i.test(message)) return "stale";
  if (
    /cannot move delivery|already in that status|terminal|transition is not allowed|already has an active delivery|only be created for a confirmed order|fulfillment is already terminal|provider is inactive|provider name is required|non-negative integer|reason is required/i.test(
      message,
    )
  ) {
    return "invalid";
  }
  return "server_error";
}
