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
  limit?: number | undefined;
  offset?: number | undefined;
}
