/**
 * Pure helpers for the production Order domain UI: mapping server shapes to
 * the UI's `Order` type, lifecycle-transition rules, and error classification.
 *
 * No React, no fetching, no server imports at runtime — only `import type`
 * (erased at compile time, never bundled) so this file stays as testable and
 * as boundary-safe as src/lib/order-draft.ts.
 */
import type {
  OrderSummary as ServerOrderSummary,
  OrderDetail as ServerOrderDetail,
  OrderLineDetail as ServerOrderLineDetail,
} from "@/server/orders/service";
import type { OrderSourceDb } from "@/server/orders/types";
import type { Channel, Order, OrderItem, OrderLifecycleStatus, OrderSource } from "@/types";

// ── Source / channel mapping ──────────────────────────────────────────────────
//
// The production Order domain speaks OrderSourceDb (uppercase, includes
// MANUAL). The UI's Channel type is the social-channel vocabulary used by
// ChannelBadge and has no "manual" member — MANUAL orders render a plain
// label (order.sourceManual) instead of a channel badge. Callers should
// branch on `source` (below), not force `channel` through ChannelBadge.

const SOURCE_TO_ORDER_SOURCE: Record<OrderSourceDb, OrderSource> = {
  POS: "pos",
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
  MANUAL: "manual",
};

const CHANNEL_TO_SOURCE_DB: Record<Channel, OrderSourceDb> = {
  pos: "POS",
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  telegram: "TELEGRAM",
};

export function sourceDbToOrderSource(source: OrderSourceDb): OrderSource {
  return SOURCE_TO_ORDER_SOURCE[source];
}

export function channelToSourceDb(channel: Channel): OrderSourceDb {
  return CHANNEL_TO_SOURCE_DB[channel];
}

/** True when a source maps to a renderable ChannelBadge Channel (i.e. not "manual"). */
export function isChannelSource(source: OrderSource): source is Channel {
  return source !== "manual";
}

// ── Server → UI mapping ───────────────────────────────────────────────────────

/** Maps one server order-summary row to the UI's `Order` shape (no line items). */
export function mapOrderSummaryToUi(row: ServerOrderSummary): Order {
  const source = sourceDbToOrderSource(row.source);
  return {
    id: row.id,
    code: row.orderNumber,
    customerId: row.customerId,
    // Vestigial for real orders — real rendering reads `source`, never `channel`,
    // because Channel has no "manual" member. Kept only so `Order` stays one type.
    channel: isChannelSource(source) ? source : "pos",
    items: [],
    subtotal: row.subtotal,
    discount: row.discount,
    deliveryFee: row.delivery,
    total: row.total,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    lifecycleStatus: row.lifecycleStatus,
    createdAt: row.createdAt,
    source,
    locationId: row.locationId,
  };
}

/**
 * Maps one server order line to the UI's `OrderItem`.
 *
 * The server snapshots a single product name at sale time (no separate
 * km/en columns — see src/server/orders/types.ts OrderItemRow). Both mock
 * name fields are set to that one snapshot so `localName()` renders it
 * identically regardless of the active language, rather than fabricating a
 * translation that was never recorded.
 */
export function mapOrderLineToUi(line: ServerOrderLineDetail): OrderItem {
  const item: OrderItem = {
    productId: line.productId,
    nameKm: line.productName,
    nameEn: line.productName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    variantId: line.variantId,
    sku: line.sku,
    lineTotal: line.lineTotal,
  };
  if (line.variantName) item.variant = line.variantName;
  return item;
}

export interface RealOrderDetail {
  order: Order;
  items: OrderItem[];
}

/** Maps one server order detail (order + lines + status history) to the UI shape. */
export function mapOrderDetailToUi(detail: ServerOrderDetail): RealOrderDetail {
  const items = detail.items.map(mapOrderLineToUi);
  return {
    order: { ...mapOrderSummaryToUi(detail), items, statusHistory: detail.statusHistory },
    items,
  };
}

// ── Lifecycle-transition rules (mirrors src/server/orders/state-machine.ts) ───
//
// Duplicated here deliberately as a pure, client-side READ of "what button to
// show" — never as a substitute for server authorization. The server is the
// only place a transition is actually accepted or refused (ARCHITECTURE.md:
// "Service/application layer is authoritative for authorization").

export function canConfirmOrder(lifecycleStatus: OrderLifecycleStatus | undefined): boolean {
  return lifecycleStatus === "draft";
}

export function canCancelOrder(lifecycleStatus: OrderLifecycleStatus | undefined): boolean {
  return lifecycleStatus === "draft" || lifecycleStatus === "confirmed";
}

/** Total units across every line — the exact quantity the DB ledger moves on confirm/cancel. */
export function totalStockUnits(items: Pick<OrderItem, "quantity">[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

// ── Error classification ──────────────────────────────────────────────────────
//
// The service layer (src/server/orders/service.ts) throws Error instances
// carrying a `statusCode` own property (400/401/403/404/409) with a clean,
// human-authored message — never raw SQL/PostgREST text for these mapped
// cases. This classifier is a best-effort read of that shape for the UI to
// pick a translated, generic message; it never surfaces `err.message`
// directly to the merchant (see the various order.error.* / order.notFound /
// order.denied copy used by callers instead).

export type OrderErrorKind =
  "unauthorized" | "forbidden" | "not_found" | "stale" | "invalid" | "server_error";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

function statusCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

export function classifyOrderError(err: unknown): OrderErrorKind {
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
  // boundary: pattern-match the service's own crafted message text. These
  // strings are service.ts's own copy (never raw SQL), so matching on them
  // does not risk leaking anything the caller could not already see.
  if (/not authenticated|no active organization membership/i.test(message)) return "unauthorized";
  if (/missing permission/i.test(message)) return "forbidden";
  if (/order not found/i.test(message)) return "not_found";
  if (/changed concurrently/i.test(message)) return "stale";
  if (
    /cannot move (order lifecycle|payment status|fulfillment status)|already in that status|terminal state|must contain at least one item|positive integer|non-negative integer|discount cannot exceed/i.test(
      message,
    )
  ) {
    return "invalid";
  }
  return "server_error";
}
