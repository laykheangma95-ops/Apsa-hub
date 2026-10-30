/**
 * Order work queues — what needs doing next, in three lists.
 *
 * Safe to bundle for the browser, and imported by the server: the browser names
 * a queue, the server decides which orders belong to it
 * (list_order_work_queue_v1, migration 065). Nothing here filters rows.
 *
 *   payment_due       confirmed orders whose money has not settled — unpaid,
 *                     awaiting review, or failed. COD orders are included and
 *                     labelled as COD (the courier collects on delivery).
 *   not_prepared      confirmed orders not yet packed and not with a courier —
 *                     including an order whose delivery was arranged before
 *                     packing (its fulfillment is already 'processing', so the
 *                     Orders screen's "To pack" filter cannot see it).
 *   awaiting_handoff  packed parcels waiting for the courier, oldest first,
 *                     with the shelf / bin they wait on.
 *
 * Each row carries three separate facts — payment, preparation, parcel — and
 * the views below are pure functions of the row; they never merge them into one
 * status and never infer one from another (packing never means paid).
 */
import type { Currency, Money } from "@/types";

export const ORDER_WORK_QUEUES = ["payment_due", "not_prepared", "awaiting_handoff"] as const;
export type OrderWorkQueue = (typeof ORDER_WORK_QUEUES)[number];
export const DEFAULT_ORDER_WORK_QUEUE: OrderWorkQueue = "not_prepared";

export function isOrderWorkQueue(value: unknown): value is OrderWorkQueue {
  return typeof value === "string" && (ORDER_WORK_QUEUES as readonly string[]).includes(value);
}

/** A queue from the URL: anything unrecognised is the default, never an error. */
export function parseOrderWorkQueue(value: unknown): OrderWorkQueue {
  return isOrderWorkQueue(value) ? value : DEFAULT_ORDER_WORK_QUEUE;
}

/** Most rows a queue returns (the RPC caps at 200; oldest first, so nothing old is hidden). */
export const ORDER_WORK_QUEUE_LIMIT = 100;

export interface OrderWorkQueueEntry {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  customerName: string | null;
  currency: Currency;
  total: Money;
  /** Outstanding balance from the Payment ledger; zero when settled. */
  due: Money;
  lifecycleStatus: "draft" | "confirmed" | "completed" | "cancelled";
  paymentStatus: "unpaid" | "pending" | "paid" | "failed";
  refundStatus: "none" | "partial" | "full";
  fulfillmentStatus: "unfulfilled" | "processing" | "fulfilled" | "cancelled";
  packed: boolean;
  activeDeliveryId: string | null;
  activeDeliveryStatus: string | null;
  latestDeliveryStatus: string | null;
  anyDelivered: boolean;
  /** The latest delivery carries a COD amount for the courier to collect. */
  cod: boolean;
  /** Returned only to members holding delivery.handoff. */
  parcelCode: string | null;
  /** Present only while the order is currently packed. */
  packDetails: ParcelPackDetails | null;
}

export interface ParcelPackDetails {
  packageCount: number;
  weightGrams: number | null;
  storageLocation: string | null;
  recordedAt: string;
}

// ── The three facts each row shows ──────────────────────────────────────────

export type PaymentFact = "paid" | "cod_due" | "due" | "review" | "failed";
export type PreparationFact = "not_prepared" | "packed";
export type ParcelFact = "on_bench" | "waiting_for_courier" | "with_courier" | "delivered";

export function paymentFactOf(
  row: Pick<OrderWorkQueueEntry, "paymentStatus" | "cod">,
): PaymentFact {
  switch (row.paymentStatus) {
    case "paid":
      return "paid";
    case "pending":
      return "review";
    case "failed":
      return "failed";
    default:
      return row.cod ? "cod_due" : "due";
  }
}

export function preparationFactOf(row: Pick<OrderWorkQueueEntry, "packed">): PreparationFact {
  return row.packed ? "packed" : "not_prepared";
}

export function parcelFactOf(
  row: Pick<
    OrderWorkQueueEntry,
    "packed" | "activeDeliveryStatus" | "anyDelivered" | "fulfillmentStatus"
  >,
): ParcelFact {
  if (row.fulfillmentStatus === "fulfilled" || row.anyDelivered) return "delivered";
  if (row.activeDeliveryStatus === "in_transit") return "with_courier";
  return row.packed ? "waiting_for_courier" : "on_bench";
}

// ── Parcel details entered at Mark Packed ───────────────────────────────────

export const PACKAGE_COUNT_MAX = 50;
export const WEIGHT_GRAMS_MAX = 100_000;
export const STORAGE_LOCATION_MAX = 40;

export interface PackDetailsInput {
  packageCount: number;
  weightGrams: number | null;
  storageLocation: string | null;
}

/**
 * The details as the database will store them, or null when invalid. Shared by
 * the Pack screen (to disable Mark Packed) and the server (the authority).
 */
export function normalizePackDetails(input: {
  packageCount: unknown;
  weightGrams?: unknown;
  storageLocation?: unknown;
}): PackDetailsInput | null {
  const count = input.packageCount;
  if (typeof count !== "number" || !Number.isInteger(count)) return null;
  if (count < 1 || count > PACKAGE_COUNT_MAX) return null;

  const weight = input.weightGrams ?? null;
  if (weight !== null) {
    if (typeof weight !== "number" || !Number.isInteger(weight)) return null;
    if (weight < 1 || weight > WEIGHT_GRAMS_MAX) return null;
  }

  const raw = input.storageLocation ?? null;
  if (raw !== null && typeof raw !== "string") return null;
  const location = raw === null ? null : raw.trim() || null;
  if (location !== null && location.length > STORAGE_LOCATION_MAX) return null;

  return { packageCount: count, weightGrams: weight, storageLocation: location };
}

// ── Staff reasons (Undo packing, Cancel order) ─────────────────────────────

export const STAFF_REASON_MIN = 3;
export const STAFF_REASON_MAX = 500;

export function isValidStaffReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= STAFF_REASON_MIN && trimmed.length <= STAFF_REASON_MAX;
}

export type UndoPackingResult =
  | { kind: "undone"; cancelledDeliveryId: string | null }
  | { kind: "handed_off" }
  | { kind: "not_packed" }
  | { kind: "invalid_order" }
  | { kind: "reason_required" }
  | { kind: "retry" };
