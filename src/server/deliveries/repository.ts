/** Server-only Delivery persistence. Mutations are transactional RPCs only. */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  CreateDeliveryInput,
  CreateDeliveryRpcResult,
  DeliveryProviderRow,
  DeliveryRow,
  DeliveryStatus,
  DeliveryStatusHistoryRow,
  ListDeliveriesOptions,
  TransitionDeliveryRpcResult,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setDeliveryRepositoryDbForTests(testDb: unknown): () => void {
  const previous = db;
  db = testDb;
  return () => {
    db = previous;
  };
}

const PGRST_NO_ROW = "PGRST116";
const message = (error: unknown): string =>
  (error as { message?: string })?.message ?? "unknown error";

export async function createDelivery(
  organizationId: string,
  createdBy: string | null,
  input: CreateDeliveryInput,
): Promise<CreateDeliveryRpcResult> {
  const { data, error } = await db.rpc("create_delivery_v1", {
    p_organization_id: organizationId,
    p_order_id: input.order_id,
    p_created_by: createdBy,
    p_location_id: input.location_id ?? null,
    p_provider_id: input.provider_id ?? null,
    p_provider_key: input.provider_key ?? null,
    p_provider_name: input.provider_name ?? null,
    p_external_tracking_number: input.external_tracking_number ?? null,
    p_cod_amount_minor: input.cod_amount_minor ?? null,
  });
  if (error) throw new Error(`createDelivery: ${message(error)}`);
  return data as CreateDeliveryRpcResult;
}

export async function transitionDelivery(
  organizationId: string,
  deliveryId: string,
  expectedFrom: DeliveryStatus,
  to: DeliveryStatus,
  changedBy: string | null,
  reason: string | null,
): Promise<TransitionDeliveryRpcResult> {
  const { data, error } = await db.rpc("transition_delivery_status_v1", {
    p_organization_id: organizationId,
    p_delivery_id: deliveryId,
    p_expected_from: expectedFrom,
    p_to: to,
    p_changed_by: changedBy,
    p_reason: reason,
  });
  if (error) throw new Error(`transitionDelivery: ${message(error)}`);
  return data as TransitionDeliveryRpcResult;
}

export async function findDeliveryById(
  organizationId: string,
  deliveryId: string,
): Promise<DeliveryRow | null> {
  const { data, error } = await db
    .from("deliveries")
    .select("*")
    .eq("id", deliveryId)
    .eq("organization_id", organizationId)
    .single();
  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findDeliveryById: ${message(error)}`);
  }
  return (data ?? null) as DeliveryRow | null;
}

export async function findActiveDeliveryForOrder(
  organizationId: string,
  orderId: string,
): Promise<DeliveryRow | null> {
  const { data, error } = await db
    .from("deliveries")
    .select("*")
    .eq("order_id", orderId)
    .eq("organization_id", organizationId)
    .in("status", ["pending", "preparing", "ready", "in_transit"])
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findActiveDeliveryForOrder: ${message(error)}`);
  return (data ?? null) as DeliveryRow | null;
}

export async function listDeliveries(
  organizationId: string,
  options: ListDeliveriesOptions = {},
): Promise<DeliveryRow[]> {
  let query = db
    .from("deliveries")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (options.order_id) query = query.eq("order_id", options.order_id);
  if (options.status) query = query.eq("status", options.status);
  if (options.limit) query = query.limit(options.limit);
  if (options.offset && options.limit) {
    query = query.range(options.offset, options.offset + options.limit - 1);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listDeliveries: ${message(error)}`);
  return (data ?? []) as DeliveryRow[];
}

export async function listDeliveryHistory(
  organizationId: string,
  deliveryId: string,
): Promise<DeliveryStatusHistoryRow[]> {
  const { data, error } = await db
    .from("delivery_status_history")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`listDeliveryHistory: ${message(error)}`);
  return (data ?? []) as DeliveryStatusHistoryRow[];
}

export async function findOrderForOrg(
  organizationId: string,
  orderId: string,
): Promise<{
  id: string;
  organization_id: string;
  location_id: string | null;
  currency: "USD" | "KHR";
  lifecycle_status: string;
  fulfillment_status: string;
} | null> {
  const { data, error } = await db
    .from("orders")
    .select("id, organization_id, location_id, currency, lifecycle_status, fulfillment_status")
    .eq("id", orderId)
    .eq("organization_id", organizationId)
    .single();
  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findOrderForOrg: ${message(error)}`);
  }
  return data ?? null;
}

export async function findLocationForOrg(
  organizationId: string,
  locationId: string,
): Promise<{ id: string; organization_id: string } | null> {
  const { data, error } = await db
    .from("locations")
    .select("id, organization_id")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .single();
  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findLocationForOrg: ${message(error)}`);
  }
  return data ?? null;
}

export async function findProviderForOrg(
  organizationId: string,
  providerId: string,
): Promise<DeliveryProviderRow | null> {
  const { data, error } = await db
    .from("delivery_providers")
    .select("*")
    .eq("id", providerId)
    .eq("organization_id", organizationId)
    .single();
  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findProviderForOrg: ${message(error)}`);
  }
  return (data ?? null) as DeliveryProviderRow | null;
}
