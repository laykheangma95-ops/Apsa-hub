import type { DeliveryStatus } from "./state-machine";

export type { DeliveryStatus };

export interface DeliveryProviderRow {
  id: string;
  organization_id: string;
  provider_key: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  organization_id: string;
  order_id: string;
  location_id: string | null;
  provider_id: string | null;
  provider_key: string | null;
  provider_name: string;
  external_tracking_number: string | null;
  /** Operational COD reference only. Payment truth does not live in Delivery. */
  cod_amount_minor: number | null;
  cod_currency: "USD" | "KHR" | null;
  status: DeliveryStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryStatusHistoryRow {
  id: string;
  organization_id: string;
  delivery_id: string;
  from_status: DeliveryStatus | null;
  to_status: DeliveryStatus;
  changed_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface CreateDeliveryInput {
  order_id: string;
  location_id?: string | null;
  provider_id?: string | null;
  provider_key?: string | null;
  provider_name?: string | null;
  external_tracking_number?: string | null;
  cod_amount_minor?: number | null;
}

export interface CreateDeliveryRpcResult {
  status: string;
  delivery_id?: string;
}

export interface TransitionDeliveryRpcResult {
  status: string;
  current?: string;
  from?: string;
  to?: string;
  order_fulfillment?: string;
}

export interface ListDeliveriesOptions {
  order_id?: string | undefined;
  status?: DeliveryStatus | undefined;
  /** Alternative to `status`: matches any status in the list. Mutually exclusive with `status`. */
  statuses?: DeliveryStatus[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * One deterministic window of the raw delivery stream, used by the
 * latest-per-order scan in the service layer. Ordering is always
 * `created_at DESC, id DESC` — the id keeps the order total even when two
 * rows share a timestamp, so a window boundary can never duplicate or drop a
 * row within a single scan.
 */
export interface ScanDeliveriesOptions {
  /** Restricts the scan to candidate rows. Omitted/undefined scans every status. */
  statuses?: DeliveryStatus[] | undefined;
  offset: number;
  limit: number;
}

/**
 * Just enough of a delivery row to decide which attempt is an order's latest.
 * Deliberately not the full row — this read fans out across a page of orders,
 * so it stays a three-column projection.
 */
export interface DeliveryAttemptRef {
  id: string;
  order_id: string;
  created_at: string;
}

/** Minimal org-scoped order reference used to enrich a delivery list row. Never the full Order domain shape. */
export interface OrderRefRow {
  id: string;
  order_number: string;
  customer_id: string | null;
}

/** Minimal org-scoped customer reference — a display name only, never phone/address. */
export interface CustomerRefRow {
  id: string;
  display_name: string;
}
