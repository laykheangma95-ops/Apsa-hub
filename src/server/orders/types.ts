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
  fulfillment_status: OrderFulfillmentStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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
}

/** Result envelope returned by the create_order_v1 RPC. */
export interface CreateOrderRpcResult {
  status: string;
  order_id?: string;
  order_number?: string;
  variant_id?: string;
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
}

/** Filter/pagination options for listing orders. All optional; all org-scoped by the repository. */
export interface ListOrdersOptions {
  customer_id?: string | undefined;
  lifecycle_status?: OrderLifecycleStatus | undefined;
  payment_status?: OrderPaymentStatus | undefined;
  fulfillment_status?: OrderFulfillmentStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
