/**
 * Pack Order domain — client-side types and display logic.
 *
 * V1 fulfillment has ONE warehouse action: Pack Order. There is no separate
 * picking step. The merchant prints the parcel label, sticks it on the parcel,
 * then packs each item into it — confirming every unit by scanning (camera,
 * hardware scanner, typed code, product barcode or APSA variant QR) or, when a
 * product has no barcode, by tapping manual confirm on its line. When every
 * unit is accounted for, Mark Packed becomes available.
 *
 * VALIDATION IS SERVER-AUTHORITATIVE. Scan validation (product, variant,
 * parcel identity) and the Mark Packed transition are performed by
 * src/server/packing/service.ts. This module contains only:
 *   - Type definitions shared between client and server response shapes
 *   - Progress computation ("3 / 5 packed")
 *   - Line resolution, manual confirmation and duplicate detection
 *   - Manual search over the order's lines
 *   - canPackOrder display predicate for the order detail button
 *   - fulfillmentActions: the ordered Order detail fulfillment actions
 *
 * PACKED IS INDEPENDENT OF DELIVERY. Mark Packed never creates, assigns or
 * starts a delivery. The packed fact is recorded with PACK_ORDER_PACKED_REASON_CODE
 * on an append-only history row: the order fulfillment history when there is no
 * delivery yet, the delivery history when one is already arranged (which also
 * moves it to "ready" — the state Courier Handoff requires). Arranging a
 * delivery for an already-packed order moves the new delivery to "ready" the
 * same way, so Courier Handoff (ready → in_transit) is unchanged.
 *
 * PACKED IS CURRENT STATE, NOT "EVER PACKED". Reopening the order's fulfillment
 * (processing → unfulfilled) clears it and, in the same transaction, cancels a
 * 'ready' delivery: a delivery arranged afterwards stays pending until Pack
 * Order completes again (isOrderCurrentlyPacked). Readying a packed order's
 * delivery re-checks this under row locks (ready_packed_delivery_v1).
 *
 * TODO(APSA V2): a dedicated packing permission (e.g. fulfillment.mark_packed).
 * V1 keeps the existing model — Mark Packed requires delivery.handoff, the
 * operational grant the person at the packing bench already holds.
 *
 * INVENTORY IS NOT MUTATED. Packing verifies that the physical items match the
 * order; stock was consumed at order confirmation.
 */

/**
 * History reason recorded when an order is marked packed — on the order
 * fulfillment history and/or the delivery history (see the module comment).
 */
export const PACK_ORDER_PACKED_REASON_CODE = "pack_order_packed";

/**
 * Delivery history reason when a packed order's delivery is readied on its
 * behalf (Arrange Delivery auto-ready, Retry delivery ready). Deliberately NOT
 * the packed marker: readying a delivery is not packing and never recreates
 * Packed. Written only by ready_packed_delivery_v1 (migration 054); the
 * `system:` namespace is reserved from generic transition APIs.
 */
export const PACK_ORDER_DELIVERY_READY_REASON_CODE = "system:pack_order_delivery_ready";

/**
 * Delivery history reason when reopening the order's fulfillment cancels its
 * 'ready' delivery (reopen_order_fulfillment_v1, migration 054). Such a cancel
 * is part of the reopen, so it does not earn the "retired attempt" exemption.
 */
export const ORDER_FULFILLMENT_REOPENED_REASON_CODE = "system:order_fulfillment_reopened";

// ── Pack requirement (what the order needs) ─────────────────────────────────

export interface PackRequirement {
  orderItemId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  quantityRequired: number;
  siblingBarcodes: readonly string[];
}

// ── Pack session state (client-side tracking for UI progress) ──────────────

/** How a unit was confirmed: a server-validated scan or a manual tap. */
export type PackMethod = "scan" | "manual";

export interface PackedItem {
  orderItemId: string;
  variantId: string;
  method: PackMethod;
  scannedAt: number;
}

export type PackPhase = "packing" | "complete";

export interface PackSession {
  orderId: string;
  orderNumber: string;
  /** The parcel this order is packed into. Scanning its label is optional. */
  parcelCode: string;
  parcelVerified: boolean;
  requirements: readonly PackRequirement[];
  packed: readonly PackedItem[];
}

// ── Server result types (match server/packing/types.ts) ────────────────────

export type ServerParcelScanResult =
  | { kind: "parcel_accepted"; parcelCode: string }
  | { kind: "wrong_parcel"; scannedCode: string }
  | { kind: "invalid_order" };

export type ServerProductScanResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "wrong_product"; scannedBarcode: string }
  | { kind: "wrong_variant"; scannedBarcode: string; expectedVariantName: string | null }
  | { kind: "invalid_order" };

export type MarkPackedResult =
  | { kind: "packed"; deliveryId: string | null }
  | { kind: "already_packed"; deliveryId: string | null }
  | { kind: "incomplete" }
  | { kind: "no_parcel" }
  | { kind: "invalid_order" }
  | { kind: "transition_failed"; reason: string };

/** Delivery statuses at which the parcel has been packed (or gone further). */
export function isPackedDeliveryStatus(status: string | null | undefined): boolean {
  return status === "ready" || status === "in_transit";
}

/** One order fulfillment-axis or delivery history row, as the packed rule reads it. */
export interface PackHistoryEntry {
  toStatus: string;
  reason: string | null;
  /** changed_at (order history) or created_at (delivery history). */
  at: string;
}

/** Delivery statuses that retire an attempt; the RPC moves the order to unfulfilled with them. */
const RETIRED_DELIVERY_STATUSES: ReadonlySet<string> = new Set(["cancelled", "failed"]);

/**
 * Whether the order is CURRENTLY packed by Pack Order — not merely "was packed
 * once". The latest packing event on the order's timeline decides:
 *   - packed:  a history row carrying PACK_ORDER_PACKED_REASON_CODE (order
 *              fulfillment or delivery history; only Pack Order writes it)
 *   - cleared: the order fulfillment moving back to 'unfulfilled' — packing was
 *              reopened ("packing stopped; back in the queue"), so the order
 *              must go through Pack Order again
 * Two moves to 'unfulfilled' are not a clear:
 *   - Pack Order's own re-record step, which carries the packed reason
 *   - the move transition_delivery_status_v1 writes when a delivery attempt is
 *     cancelled or failed: that retires the attempt, not the packed parcel. The
 *     RPC writes it in the same transaction as the delivery's cancelled/failed
 *     row, so both share one timestamp. Callers cannot set that timestamp, so a
 *     generic API cannot forge the exemption. A delivery cancelled BY a reopen
 *     (ORDER_FULFILLMENT_REOPENED_REASON_CODE) does not count as retired.
 * A tie, or a row without a parseable time, fails closed (not packed).
 *
 * The authoritative twin of this rule runs inside ready_packed_delivery_v1
 * (migration 054) under row locks; this copy drives display and early returns.
 */
export function isOrderCurrentlyPacked(input: {
  orderFulfillmentHistory: readonly PackHistoryEntry[];
  deliveryHistory: readonly PackHistoryEntry[];
}): boolean {
  const time = (at: string): number => {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };

  let lastPacked = Number.NEGATIVE_INFINITY;
  for (const h of [...input.orderFulfillmentHistory, ...input.deliveryHistory]) {
    if (h.reason === PACK_ORDER_PACKED_REASON_CODE) lastPacked = Math.max(lastPacked, time(h.at));
  }
  if (lastPacked === Number.NEGATIVE_INFINITY) return false;

  const retiredAt = new Set(
    input.deliveryHistory
      .filter(
        (h) =>
          RETIRED_DELIVERY_STATUSES.has(h.toStatus) &&
          h.reason !== ORDER_FULFILLMENT_REOPENED_REASON_CODE,
      )
      .map((h) => time(h.at)),
  );
  let lastCleared = Number.NEGATIVE_INFINITY;
  for (const h of input.orderFulfillmentHistory) {
    if (h.toStatus !== "unfulfilled" || h.reason === PACK_ORDER_PACKED_REASON_CODE) continue;
    const at = time(h.at);
    if (!retiredAt.has(at)) lastCleared = Math.max(lastCleared, at);
  }
  return lastPacked > lastCleared;
}

/** Localized text for a history reason this module wrote; null for any other reason. */
export function packHistoryReasonMessage(
  reason: string | null,
  t: (key: string) => string,
): string | null {
  switch (reason) {
    case PACK_ORDER_PACKED_REASON_CODE:
      return t("packSession.history.packed");
    case PACK_ORDER_DELIVERY_READY_REASON_CODE:
      return t("packSession.history.deliveryReady");
    case ORDER_FULFILLMENT_REOPENED_REASON_CODE:
      return t("packSession.history.reopened");
    default:
      return null;
  }
}

/** Server response for the Order detail fulfillment section. */
export interface OrderPackState {
  packed: boolean;
  /** Only returned to members who may hand off (delivery.handoff); else null. */
  parcelCode: string | null;
}

// ── Order detail fulfillment actions ────────────────────────────────────────

export type FulfillmentActionKey =
  "print_label" | "pack" | "packed" | "arrange_delivery" | "retry_delivery_ready" | "handoff";

export interface FulfillmentAction {
  key: FulfillmentActionKey;
  /** Shown but not yet possible (e.g. handoff before the parcel is packed). */
  disabled: boolean;
}

/**
 * The Order detail fulfillment actions, in V1 workflow order:
 *   1. Print parcel label
 *   2. Pack order  (or a "Packed" status once packed)
 *   3. Arrange delivery  (only while there is no active delivery — optional)
 *   4. Retry delivery ready  (packed order whose delivery is still pending /
 *      preparing — readying it failed; recovers without repacking)
 *   5. Courier handoff  (only once a delivery exists; enabled when it is ready)
 *
 * Display only: every action is enforced again by the server.
 */
export function fulfillmentActions(input: {
  canPrintLabel: boolean;
  canPack: boolean;
  packed: boolean;
  canArrangeDelivery: boolean;
  activeDeliveryStatus: string | null;
  canHandoff: boolean;
  parcelCode: string | null;
}): FulfillmentAction[] {
  const actions: FulfillmentAction[] = [];
  if (input.canPrintLabel) actions.push({ key: "print_label", disabled: false });
  if (input.canPack) actions.push({ key: input.packed ? "packed" : "pack", disabled: false });
  if (input.canArrangeDelivery && input.activeDeliveryStatus === null) {
    actions.push({ key: "arrange_delivery", disabled: false });
  }
  if (
    input.canHandoff &&
    input.packed &&
    (input.activeDeliveryStatus === "pending" || input.activeDeliveryStatus === "preparing")
  ) {
    actions.push({ key: "retry_delivery_ready", disabled: false });
  }
  if (
    input.canHandoff &&
    input.parcelCode !== null &&
    input.activeDeliveryStatus !== null &&
    input.activeDeliveryStatus !== "in_transit"
  ) {
    actions.push({ key: "handoff", disabled: input.activeDeliveryStatus !== "ready" });
  }
  return actions;
}

// ── Progress ────────────────────────────────────────────────────────────────

export interface PackProgress {
  totalRequired: number;
  totalPacked: number;
  remaining: number;
  isComplete: boolean;
  lines: readonly PackLineProgress[];
}

export interface PackLineProgress {
  orderItemId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  quantityRequired: number;
  quantityPacked: number;
  isComplete: boolean;
}

// ── Pure functions ──────────────────────────────────────────────────────────

export function createPackSession(
  orderId: string,
  orderNumber: string,
  parcelCode: string,
  requirements: readonly PackRequirement[],
): PackSession {
  return {
    orderId,
    orderNumber,
    parcelCode,
    parcelVerified: false,
    requirements,
    packed: [],
  };
}

function packedCountForItem(packed: readonly PackedItem[], orderItemId: string): number {
  return packed.filter((p) => p.orderItemId === orderItemId).length;
}

export function computePackProgress(session: PackSession): PackProgress {
  const lines: PackLineProgress[] = session.requirements.map((req) => {
    const quantityPacked = packedCountForItem(session.packed, req.orderItemId);
    return {
      orderItemId: req.orderItemId,
      productName: req.productName,
      variantName: req.variantName,
      sku: req.sku,
      barcode: req.barcode,
      quantityRequired: req.quantityRequired,
      quantityPacked,
      isComplete: quantityPacked >= req.quantityRequired,
    };
  });

  const totalRequired = lines.reduce((sum, l) => sum + l.quantityRequired, 0);
  const totalPacked = lines.reduce(
    (sum, l) => sum + Math.min(l.quantityPacked, l.quantityRequired),
    0,
  );

  return {
    totalRequired,
    totalPacked,
    remaining: totalRequired - totalPacked,
    isComplete: totalPacked >= totalRequired,
    lines,
  };
}

export function getPackPhase(session: PackSession): PackPhase {
  return computePackProgress(session).isComplete ? "complete" : "packing";
}

/** Mark Packed is enabled only when every unit of every line is confirmed. */
export function canMarkPacked(session: PackSession): boolean {
  return session.requirements.length > 0 && computePackProgress(session).isComplete;
}

/**
 * Record that the parcel label scanned matches this order. Optional — the
 * merchant may pack without scanning the label. Only call after the server
 * returned parcel_accepted.
 */
export function applyServerParcelAccepted(session: PackSession): PackSession {
  return { ...session, parcelVerified: true };
}

/**
 * Pick the line a server-accepted variant should count against: the first line
 * for that variant that still needs units. An order can carry the same variant
 * on more than one line, so the server's orderItemId is only a hint. Returns
 * null when every line for the variant is already full (a duplicate scan).
 */
export function resolveAcceptedLine(session: PackSession, variantId: string): string | null {
  for (const req of session.requirements) {
    if (req.variantId !== variantId) continue;
    if (packedCountForItem(session.packed, req.orderItemId) < req.quantityRequired) {
      return req.orderItemId;
    }
  }
  return null;
}

/**
 * Apply a server-validated product acceptance to the local session.
 * Only call after the server returned accepted and resolveAcceptedLine found
 * a line with room.
 */
export function applyServerProductAccepted(
  session: PackSession,
  result: { orderItemId: string; variantId: string },
  method: PackMethod = "scan",
): PackSession {
  return {
    ...session,
    packed: [
      ...session.packed,
      {
        orderItemId: result.orderItemId,
        variantId: result.variantId,
        method,
        scannedAt: Date.now(),
      },
    ],
  };
}

/**
 * Whether one more unit for this line would exceed what the order needs.
 */
export function isLocalDuplicateScan(session: PackSession, orderItemId: string): boolean {
  const req = session.requirements.find((r) => r.orderItemId === orderItemId);
  if (!req) return false;
  return packedCountForItem(session.packed, orderItemId) >= req.quantityRequired;
}

export type ManualConfirmResult =
  | { kind: "accepted"; orderItemId: string; variantId: string; productName: string }
  | { kind: "duplicate_scan"; variantId: string; productName: string }
  | { kind: "unknown_line" };

/**
 * Confirm one unit of a line by hand — for a product with no barcode, or when
 * the barcode will not scan. The line is chosen from the order's own
 * requirements, so product and variant are correct by construction; only the
 * quantity needs guarding.
 */
export function confirmLineManually(
  session: PackSession,
  orderItemId: string,
): { session: PackSession; result: ManualConfirmResult } {
  const req = session.requirements.find((r) => r.orderItemId === orderItemId);
  if (!req) return { session, result: { kind: "unknown_line" } };

  if (isLocalDuplicateScan(session, orderItemId)) {
    return {
      session,
      result: { kind: "duplicate_scan", variantId: req.variantId, productName: req.productName },
    };
  }

  return {
    session: applyServerProductAccepted(
      session,
      { orderItemId, variantId: req.variantId },
      "manual",
    ),
    result: {
      kind: "accepted",
      orderItemId,
      variantId: req.variantId,
      productName: req.productName,
    },
  };
}

/** Per-line counts sent to the server with Mark Packed. */
export function buildPackedLines(
  session: PackSession,
): { orderItemId: string; quantity: number }[] {
  return session.requirements.map((req) => ({
    orderItemId: req.orderItemId,
    quantity: Math.min(packedCountForItem(session.packed, req.orderItemId), req.quantityRequired),
  }));
}

/**
 * Manual search over the order's lines — by product name, variant name, SKU or
 * barcode, case-insensitive. An empty query returns every line.
 */
export function filterPackLines<T extends PackLineProgress>(
  lines: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return lines;
  return lines.filter((line) =>
    [line.productName, line.variantName, line.sku, line.barcode].some(
      (field) => field !== null && field.toLocaleLowerCase().includes(needle),
    ),
  );
}

/**
 * Check whether an order is in a state where packing is allowed.
 * Display predicate for showing/hiding the "Pack order" button.
 * The server enforces the same check authoritatively.
 */
export function canPackOrder(order: {
  lifecycleStatus: string | undefined;
  fulfillmentStatus: string | undefined;
}): boolean {
  return (
    order.lifecycleStatus === "confirmed" &&
    (order.fulfillmentStatus === "processing" || order.fulfillmentStatus === "unfulfilled")
  );
}
