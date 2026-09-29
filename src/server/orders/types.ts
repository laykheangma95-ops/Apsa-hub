/**
 * Raw DB row types for the Order domain.
 * These match the columns in migrations 023–024 exactly.
 * Never used in UI — mapped to domain types by the service layer.
 *
 * Money fields are `number` holding an INTEGER MINOR UNIT. They are BIGINT in
 * Postgres, which PostgREST serialises as a JSON number; every realistic order
 * total is far inside Number.MAX_SAFE_INTEGER (that is ~90 trillion USD in
 * cents), so no bigint handling is needed here. There is no float money.
 */

import type {
  OrderLifecycleStatus,
  OrderPaymentStatus,
  OrderRefundStatus,
  OrderFulfillmentStatus,
  OrderStatusAxis,
} from "./state-machine";

export type { OrderLifecycleStatus, OrderPaymentStatus, OrderFulfillmentStatus, OrderStatusAxis };

/** Matches the order_source enum in migration 023. */
export type OrderSourceDb = "POS" | "FACEBOOK" | "INSTAGRAM" | "TELEGRAM" | "MANUAL";

export const ORDER_SOURCES: readonly OrderSourceDb[] = [
  "POS",
  "FACEBOOK",
  "INSTAGRAM",
  "TELEGRAM",
  "MANUAL",
];

export type OrderCurrency = "USD" | "KHR";

export interface OrderRow {
  id: string;
  organization_id: string;
  order_number: string;
  customer_id: string | null;
  location_id: string | null;
  source: OrderSourceDb;
  currency: OrderCurrency;
  subtotal_minor: number;
  discount_minor: number;
  delivery_minor: number;
  total_minor: number;
  lifecycle_status: OrderLifecycleStatus;
  payment_status: OrderPaymentStatus;
  refund_status: OrderRefundStatus;
  fulfillment_status: OrderFulfillmentStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Opaque provenance only — see migration 030. Never a Conversation FK. */
  source_conversation_ref: string | null;
  /**
   * Order shipping destination SNAPSHOT (migration 047). Captured at creation
   * and editable before fulfillment; order-authoritative and independent of the
   * customer profile. All three are NULL for a pickup / no-delivery order and
   * for any order created before migration 047 (no snapshot). This is
   * fulfillment PII — never mapped into the general OrderSummary/OrderDetail
   * (which need only orders.read); it is read solely through the fulfillment
   * label path, which gates on fulfillment.print_label.
   */
  shipping_name: string | null;
  shipping_phone: string | null;
  shipping_address: string | null;
}

/**
 * Order shipping destination snapshot as it crosses the domain boundary. Each
 * field is optional/nullable; an order with no destination (pickup) omits all
 * three. Normalized and validated by the service before it reaches the RPC.
 */
export interface OrderShippingSnapshotInput {
  name?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
}

export interface OrderItemRow {
  id: string;
  organization_id: string;
  order_id: string;
  product_id: string;
  variant_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  sku_snapshot: string | null;
  unit_price_minor: number;
  quantity: number;
  line_total_minor: number;
  created_at: string;
}

export interface OrderStatusHistoryRow {
  id: string;
  organization_id: string;
  order_id: string;
  axis: OrderStatusAxis;
  from_status: string;
  to_status: string;
  changed_by: string | null;
  reason: string | null;
  changed_at: string;
}

/**
 * One requested line. Note what is ABSENT: no price, no line total, no
 * currency. The server reads pricing from product_variants — a caller has no
 * way to state what something costs.
 *
 * `product_id` is an optional cross-check only. The authoritative product for a
 * line is the variant's own product_id.
 */
export interface CreateOrderLineInput {
  variant_id: string;
  quantity: number;
  product_id?: string | undefined;
}

/** Create-order input as it reaches the repository. organization_id is not here — it is a separate, server-supplied argument. */
export interface CreateOrderInput {
  source: OrderSourceDb;
  items: CreateOrderLineInput[];
  customer_id?: string | null | undefined;
  location_id?: string | null | undefined;
  discount_minor?: number | undefined;
  /**
   * Opaque provenance identifier for the conversation this order came from
   * (see migration 030). Never a Conversation FK — no production Conversation
   * table exists yet. Never the conversation content.
   */
  source_conversation_ref?: string | null | undefined;
  /**
   * Delivery fee the merchant charges the customer, integer minor units in the
   * order's (= organization's) currency. Bounded and added into the total by
   * create_order_v2 (migration 044) — never the courier's cost.
   */
  delivery_minor?: number | undefined;
  /** One logical creation attempt. Required by create_order_v2. */
  idempotency_key: string;
  /**
   * Optional order shipping destination snapshot, written atomically with the
   * order by create_order_v3 (migration 047) and folded into the idempotency
   * fingerprint. Absent/blank for a pickup order.
   */
  shipping?: OrderShippingSnapshotInput | undefined;
}

/** Result envelope returned by the update_order_shipping_v1 RPC (migration 047). Presence booleans only — never raw PII. */
export interface UpdateOrderShippingRpcResult {
  status: string;
  order_id?: string;
  had_name?: boolean;
  had_phone?: boolean;
  had_address?: boolean;
  has_name?: boolean;
  has_phone?: boolean;
  has_address?: boolean;
}

/** Result envelope returned by the create_order_v2 RPC (migration 044). */
export interface CreateOrderRpcResult {
  status: string;
  order_id?: string;
  order_number?: string;
  variant_id?: string;
  /** true when an earlier request with the same key created this order. */
  replayed?: boolean;
}

/** Result envelope returned by the transition_order_status_v1 RPC. */
export interface TransitionRpcResult {
  status: string;
  current?: string;
  lifecycle?: string;
  payment?: string;
  fulfillment?: string;
  axis?: string;
  from?: string;
  to?: string;
  /**
   * How many inventory_movements rows the transition wrote in its own
   * transaction (migration 026). Non-zero only for the two stock transitions:
   * draft -> confirmed ('sale' per line) and confirmed -> cancelled ('return'
   * per previously consumed line). Reported for the audit trail — it is an
   * OUTCOME of the transaction, not an instruction to it, and nothing in
   * TypeScript can influence it.
   */
  stock_movements?: number;
}

/** Filter/pagination options for listing orders. All optional; all org-scoped by the repository. */
export interface ListOrdersOptions {
  customer_id?: string | undefined;
  lifecycle_status?: OrderLifecycleStatus | undefined;
  payment_status?: OrderPaymentStatus | undefined;
  fulfillment_status?: OrderFulfillmentStatus | undefined;
  /**
   * Match any of several fulfillment statuses (`fulfillment_status IN (...)`).
   * Used by the Ready-to-Pack queue, which spans `unfulfilled` + `processing`.
   * Ignored when empty; combined with `fulfillment_status` it further narrows,
   * so callers pass one or the other.
   */
  fulfillment_statuses?: readonly OrderFulfillmentStatus[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
