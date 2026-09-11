/** Server-only Delivery persistence. Mutations are transactional RPCs only. */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  CreateDeliveryInput,
  CreateDeliveryRpcResult,
  CustomerRefRow,
  DeliveryAttemptRef,
  DeliveryProviderRow,
  DeliveryRow,
  DeliveryStatus,
  DeliveryStatusHistoryRow,
  ListDeliveriesOptions,
  OrderRefRow,
  ScanDeliveriesOptions,
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
  else if (options.statuses && options.statuses.length > 0) {
    query = query.in("status", options.statuses);
  }
  if (options.limit) query = query.limit(options.limit);
  if (options.offset && options.limit) {
    query = query.range(options.offset, options.offset + options.limit - 1);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listDeliveries: ${message(error)}`);
  return (data ?? []) as DeliveryRow[];
}

/**
 * One deterministic window of the org's raw delivery stream, newest attempt
 * first. This is the scan primitive behind listDeliveriesForMerchant: the
 * service walks these windows until it has resolved enough latest-per-order
 * rows to answer the requested page, so completeness is never traded away up
 * front by a single capped read.
 *
 * `created_at DESC, id DESC` is a total order even when two attempts share a
 * timestamp, so consecutive windows can neither repeat nor skip a row.
 */
export async function scanDeliveries(
  organizationId: string,
  options: ScanDeliveriesOptions,
): Promise<DeliveryRow[]> {
  let query = db
    .from("deliveries")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (options.statuses && options.statuses.length > 0) {
    query = query.in("status", options.statuses);
  }
  query = query.range(options.offset, options.offset + options.limit - 1);
  const { data, error } = await query;
  if (error) throw new Error(`scanDeliveries: ${message(error)}`);
  return (data ?? []) as DeliveryRow[];
}

/**
 * The authoritative latest attempt for a bounded set of orders — at most one
 * row per order, each fetched as its own `.limit(1)` read, org-scoped and
 * projected down to the three columns needed to pick that order's latest.
 *
 * WHY PER-ORDER, NOT A SINGLE `.in("order_id", orderIds)` READ: an order's
 * attempt history has no bound the caller controls (a retried order can carry
 * hundreds of superseded rows), so a single fan-out read has no bound either.
 * PostgREST enforces its own response ceiling (`db-max-rows`, commonly 1000
 * on a hosted Supabase project) independently of anything this code requests,
 * and a capped response comes back as `error: null` — indistinguishable from
 * a complete one. One retried order's history alone can consume that ceiling,
 * silently returning zero rows for every *other* order in the same chunk.
 * The caller previously read "no ref for this order" as "superseded"; under a
 * capped read that is UNKNOWN, not FALSE — this was the P1 defect that let 49
 * genuinely current failed deliveries collapse to zero while `truncated`
 * stayed false.
 *
 * A `.limit(1)` read cannot be capped by any `db-max-rows` >= 1 — the only
 * value under which the API is functional at all — so this shape is complete
 * by construction, not by an assumption about a dashboard setting that could
 * change under this code without warning. The cost is one round trip per
 * distinct order rather than one per chunk; LATEST_ATTEMPT_CHUNK (see
 * service.ts) bounds how many run in parallel per verification pass.
 */
export async function listDeliveryAttemptRefsForOrders(
  organizationId: string,
  orderIds: string[],
): Promise<DeliveryAttemptRef[]> {
  const uniqueOrderIds = [...new Set(orderIds)];
  if (uniqueOrderIds.length === 0) return [];
  const perOrder = await Promise.all(
    uniqueOrderIds.map(async (orderId) => {
      const { data, error } = await db
        .from("deliveries")
        .select("id, order_id, created_at")
        .eq("organization_id", organizationId)
        .eq("order_id", orderId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1);
      if (error) throw new Error(`listDeliveryAttemptRefsForOrders: ${message(error)}`);
      return (data ?? []) as DeliveryAttemptRef[];
    }),
  );
  return perOrder.flat();
}

/**
 * Order references for a set of order ids, org-scoped. Read-only display join
 * for the Deliveries list (order code + which customer, if any) — never a new
 * domain, mirrors the existing findOrderForOrg above which already reads the
 * orders table directly from this file.
 */
export async function listOrderRefsForOrg(
  organizationId: string,
  orderIds: string[],
): Promise<OrderRefRow[]> {
  if (orderIds.length === 0) return [];
  const { data, error } = await db
    .from("orders")
    .select("id, order_number, customer_id")
    .eq("organization_id", organizationId)
    .in("id", orderIds);
  if (error) throw new Error(`listOrderRefsForOrg: ${message(error)}`);
  return (data ?? []) as OrderRefRow[];
}

/**
 * Customer display names for a set of customer ids, org-scoped. The caller
 * (service layer) must gate this behind `customers.read` — this function
 * itself performs no authorization, matching every other repository function.
 */
export async function listCustomerRefsForOrg(
  organizationId: string,
  customerIds: string[],
): Promise<CustomerRefRow[]> {
  if (customerIds.length === 0) return [];
  const { data, error } = await db
    .from("customers")
    .select("id, display_name")
    .eq("organization_id", organizationId)
    .in("id", customerIds);
  if (error) throw new Error(`listCustomerRefsForOrg: ${message(error)}`);
  return (data ?? []) as CustomerRefRow[];
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
