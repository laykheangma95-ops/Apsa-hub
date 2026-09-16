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

/**
 * Writable provenance only. "other" is deliberately absent: it is a
 * display-only bucket for sources we could not identify, and there is no DB
 * enum member that honestly means "unclassified". Mapping it to MANUAL would
 * persist a fabricated claim that a human keyed the order in by hand, so
 * `channelToSourceDb` refuses it instead (returns null) and the caller
 * decides — it never silently invents manual intent.
 */
const CHANNEL_TO_SOURCE_DB: Record<Exclude<Channel, "other">, OrderSourceDb> = {
  pos: "POS",
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  telegram: "TELEGRAM",
};

/**
 * Normalises a raw DB source into the UI vocabulary.
 *
 * Typed as OrderSourceDb, but the value genuinely arrives from the database,
 * so legacy rows, a widened server enum, or malformed data can all reach here
 * as something outside the union. Anything unrecognised becomes "other" — the
 * generic, honest bucket — and never "manual": an order whose provenance we
 * cannot identify was NOT necessarily entered by hand, and saying so in the UI
 * is a false statement about how the business took the order.
 */
export function sourceDbToOrderSource(source: OrderSourceDb): OrderSource {
  return SOURCE_TO_ORDER_SOURCE[source] ?? "other";
}

/**
 * Maps a UI channel to the DB source to persist, or null when the channel
 * carries no honest provenance ("other"). Callers must handle null rather
 * than defaulting — see CHANNEL_TO_SOURCE_DB above.
 */
export function channelToSourceDb(channel: Channel): OrderSourceDb | null {
  return channel === "other" ? null : CHANNEL_TO_SOURCE_DB[channel];
}

/**
 * True when a source is a Channel that ChannelBadge can render (every Channel
 * except "manual", which is not a Channel at all). The check is an explicit
 * membership test — not `source !== "manual"` — so untyped data that slips
 * past the OrderSource union (legacy rows, future API values, "POS"-style DB
 * casing) is rejected here instead of crashing ChannelBadge's icon lookup
 * later. A value this accepts is guaranteed to exist in ChannelBadge's ICONS.
 */
const RENDERABLE_CHANNELS: readonly Channel[] = [
  "facebook",
  "instagram",
  "telegram",
  "pos",
  "other",
];

export function isChannelSource(source: OrderSource): source is Channel {
  return (RENDERABLE_CHANNELS as readonly string[]).includes(source);
}

/**
 * How an order's provenance should be presented — the single decision both
 * Order surfaces (list and detail) share, so neither grows its own fallback.
 *
 * Three genuinely different facts, never collapsed into one another:
 *   - "channel": we know which channel it came from → ChannelBadge.
 *   - "manual":  the order is explicitly MANUAL → "Entered by hand".
 *   - "absent":  no source was recorded at all → assert nothing.
 *
 * An unrecognised value is "channel"/"other", never "manual" and never
 * "absent": we know the order came from somewhere, we just cannot name it.
 */
export type OrderSourcePresentation =
  { kind: "channel"; channel: Channel } | { kind: "manual" } | { kind: "absent" };

export function presentOrderSource(
  source: OrderSource | null | undefined,
): OrderSourcePresentation {
  // Only a genuinely missing value is "absent". An empty string is a broken
  // stored value, not an absence, so it falls through to the generic bucket.
  if (source === null || source === undefined) return { kind: "absent" };
  if (source === "manual") return { kind: "manual" };
  return { kind: "channel", channel: isChannelSource(source) ? source : "other" };
}

// ── Server → UI mapping ───────────────────────────────────────────────────────

/** Maps one server order-summary row to the UI's `Order` shape (no line items). */
export function mapOrderSummaryToUi(row: ServerOrderSummary): Order {
  const source = sourceDbToOrderSource(row.source);
  return {
    id: row.id,
    code: row.orderNumber,
    customerId: row.customerId,
    // Derived display channel for surfaces that badge a Channel directly.
    // "manual" is not a Channel, so it shows as the generic "other" here;
    // surfaces that must tell manual apart read `source` through
    // presentOrderSource() rather than this field.
    channel: isChannelSource(source) ? source : "other",
    items: [],
    subtotal: row.subtotal,
    discount: row.discount,
    deliveryFee: row.delivery,
    total: row.total,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    lifecycleStatus: row.lifecycleStatus,
    // The refund axis is carried through, never merged into paymentStatus:
    // a refunded order stays `paid` and says `partial`/`full` separately
    // (CORRECTIONS.md, "Approved financial semantics"). Dropping it here left
    // the production Order UI unable to show that a refund had happened at all.
    refundStatus: row.refundStatus,
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

// ── Prepare-Order checkout routing ────────────────────────────────────────────

/** A real, DB-backed id — the only thing a real order line or customer accepts. */
const PRODUCTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One prepared line, reduced to the only two things the routing decision needs. */
export interface PreparedOrderLine {
  productId: string;
  variantId?: string | null | undefined;
}

export interface PreparedOrderInput {
  channel: Channel;
  customerId: string;
  lines: readonly PreparedOrderLine[];
}

/**
 * Which order-creation path a prepared conversation order is allowed to use.
 *
 *   production — a writable channel, a real customer, and every line backed by
 *                a real product AND a real variant. Goes to the authoritative
 *                Order domain via createRealOrder().
 *   prototype  — nothing production is involved at all: a fixture customer and
 *                only fixture products (the `/design` catalog). The Order that
 *                the local path returns is a prop, not a record.
 *   unsellable — anything else, and this is the case that matters.
 *
 * This mirrors classifyCheckout() in src/lib/pos-cart.ts, and exists for the
 * same reason. PrepareOrderSheet used to ask a single two-way question —
 * "is this fully production?" — and on `false` ran the LOCAL path, which mints
 * an `APSA-00NN` code and reports "Order created" to the merchant while
 * persisting nothing. Two ordinary production situations took that branch:
 *
 *   - a real conversation whose channel is "other" (channelToSourceDb returns
 *     null, because no DB enum member honestly means "unclassified"), and
 *   - a real catalog product with no ACTIVE variant, which
 *     mapServerProductToUi leaves without a variantId.
 *
 * In both, a merchant with a real customer and real goods was shown an order
 * code, and a system message was appended to the real conversation saying the
 * order existed. It did not. There is no honest third path: an order APSA
 * cannot actually create must be refused with a reason, never fabricated.
 */
export type PreparedOrderKind = "production" | "prototype" | "unsellable";

export function classifyPreparedOrder(input: PreparedOrderInput): PreparedOrderKind {
  const { channel, customerId, lines } = input;
  if (lines.length === 0) return "unsellable";

  const customerIsProduction = PRODUCTION_ID_RE.test(customerId);
  const channelIsWritable = channelToSourceDb(channel) !== null;
  const productionLines = lines.filter(
    (line) => PRODUCTION_ID_RE.test(line.productId) && PRODUCTION_ID_RE.test(line.variantId ?? ""),
  ).length;

  if (channelIsWritable && customerIsProduction && productionLines === lines.length) {
    return "production";
  }

  // Not "everything else is prototype" by elimination. A real product with no
  // variant, a real customer on an unwritable channel, or a cart mixing real
  // and fixture goods are all real data that cannot become a real order — they
  // belong in `unsellable`, not in a fabricated receipt.
  const prototypeLines = lines.filter((line) => !PRODUCTION_ID_RE.test(line.productId)).length;
  if (!customerIsProduction && prototypeLines === lines.length) return "prototype";

  return "unsellable";
}

/**
 * Why a prepared order was refused, so the sheet can tell the merchant the one
 * thing they can actually act on rather than a generic failure.
 */
export type PreparedOrderBlocker = "no-variant" | "unwritable-channel" | "mixed";

export function explainUnsellablePreparedOrder(input: PreparedOrderInput): PreparedOrderBlocker {
  const hasVariantlessRealLine = input.lines.some(
    (line) => PRODUCTION_ID_RE.test(line.productId) && !PRODUCTION_ID_RE.test(line.variantId ?? ""),
  );
  if (hasVariantlessRealLine) return "no-variant";
  if (channelToSourceDb(input.channel) === null) return "unwritable-channel";
  return "mixed";
}
