/**
 * Fulfillment repository — the cross-domain reads the packing queue and parcel
 * label need, each org-scoped and service-role.
 *
 * These are minimal local lookups (org display name, customer contact, default
 * address, latest delivery, per-order item counts) rather than importing the
 * Customer / Delivery / Org repositories wholesale — the same approach the Order
 * repository already takes for its ownership checks. Every query filters by
 * organization_id so RLS and the application layer are both layered.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

/** Test-only override for exercising these reads against a mocked query chain. */
export function setFulfillmentRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

const PGRST_NO_ROW = "PGRST116";

function errMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

/** Sum of line quantities per order, for a set of orders. */
export async function itemCountsByOrder(
  organizationId: string,
  orderIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (orderIds.length === 0) return counts;

  const { data, error } = await db
    .from("order_items")
    .select("order_id, quantity")
    .eq("organization_id", organizationId)
    .in("order_id", orderIds);

  if (error) throw new Error(`itemCountsByOrder: ${errMessage(error)}`);
  for (const row of (data ?? []) as Array<{ order_id: string; quantity: number }>) {
    counts.set(row.order_id, (counts.get(row.order_id) ?? 0) + row.quantity);
  }
  return counts;
}

/** Display names for a set of customers, org-scoped. Name is not PII-gated. */
export async function customerNamesByIds(
  organizationId: string,
  customerIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (customerIds.length === 0) return names;

  const { data, error } = await db
    .from("customers")
    .select("id, display_name")
    .eq("organization_id", organizationId)
    .in("id", customerIds);

  if (error) throw new Error(`customerNamesByIds: ${errMessage(error)}`);
  for (const row of (data ?? []) as Array<{ id: string; display_name: string }>) {
    names.set(row.id, row.display_name);
  }
  return names;
}

export interface CustomerContactRow {
  display_name: string;
  primary_phone: string | null;
}

/** One customer's contact (name + phone), org-scoped. Null when not found in this org. */
export async function customerContact(
  organizationId: string,
  customerId: string,
): Promise<CustomerContactRow | null> {
  const { data, error } = await db
    .from("customers")
    .select("display_name, primary_phone")
    .eq("organization_id", organizationId)
    .eq("id", customerId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`customerContact: ${errMessage(error)}`);
  }
  return (data ?? null) as CustomerContactRow | null;
}

export interface CustomerAddressRow {
  house_no: string | null;
  street: string | null;
  sangkat: string | null;
  khan: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  landmark: string | null;
  is_default: boolean;
}

/** The customer's default delivery address (or the most recent), org-scoped. */
export async function customerDefaultAddress(
  organizationId: string,
  customerId: string,
): Promise<CustomerAddressRow | null> {
  const { data, error } = await db
    .from("customer_addresses")
    .select("house_no, street, sangkat, khan, city, province, country, landmark, is_default")
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`customerDefaultAddress: ${errMessage(error)}`);
  const rows = (data ?? []) as CustomerAddressRow[];
  return rows[0] ?? null;
}

/** The organization's display name — used as the merchant name on labels. */
export async function organizationName(organizationId: string): Promise<string | null> {
  const { data, error } = await db
    .from("organizations")
    .select("display_name")
    .eq("id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`organizationName: ${errMessage(error)}`);
  }
  return (data as { display_name: string } | null)?.display_name ?? null;
}

export interface LatestDeliveryRow {
  provider_name: string;
  external_tracking_number: string | null;
  status: string;
}

/** The most recent delivery attempt for an order, org-scoped, or null. */
export async function latestDeliveryForOrder(
  organizationId: string,
  orderId: string,
): Promise<LatestDeliveryRow | null> {
  const { data, error } = await db
    .from("deliveries")
    .select("provider_name, external_tracking_number, status, created_at")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`latestDeliveryForOrder: ${errMessage(error)}`);
  const rows = (data ?? []) as LatestDeliveryRow[];
  return rows[0] ?? null;
}

/**
 * One order's ledger-derived settlement totals, read from the Payment domain's
 * authoritative `order_payment_totals` view (migration 040).
 *
 * The COD amount printed on a label is NOT `payment_status != paid ? total : 0`
 * — a partially paid or partly refunded order would show the wrong figure. It
 * is the real OUTSTANDING balance, and this view is the one place APSA derives
 * received/refunded/net per order. Reading the view here (rather than importing
 * the Payment service) is the same cross-domain read pattern this repository
 * already uses for customers/deliveries/organizations, and it copies NO
 * settlement logic: the SQL view owns that; the service only subtracts
 * net_minor from total_minor to get "amount left to collect".
 */
export interface OrderPaymentTotalsRow {
  order_id: string;
  total_minor: number;
  received_minor: number;
  refunded_minor: number;
  net_minor: number;
  currency: string;
  payment_status: string;
  refund_status: string;
}

/** Settlement totals for one order, org-scoped. Null when not found in this org. */
export async function orderPaymentTotals(
  organizationId: string,
  orderId: string,
): Promise<OrderPaymentTotalsRow | null> {
  const { data, error } = await db
    .from("order_payment_totals")
    .select(
      "order_id, total_minor, received_minor, refunded_minor, net_minor, currency, payment_status, refund_status",
    )
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`orderPaymentTotals: ${errMessage(error)}`);
  }
  return (data ?? null) as OrderPaymentTotalsRow | null;
}

/** Settlement totals for a set of orders, org-scoped (queue rollup). */
export async function orderPaymentTotalsByIds(
  organizationId: string,
  orderIds: string[],
): Promise<Map<string, OrderPaymentTotalsRow>> {
  const totals = new Map<string, OrderPaymentTotalsRow>();
  if (orderIds.length === 0) return totals;

  const { data, error } = await db
    .from("order_payment_totals")
    .select(
      "order_id, total_minor, received_minor, refunded_minor, net_minor, currency, payment_status, refund_status",
    )
    .eq("organization_id", organizationId)
    .in("order_id", orderIds);

  if (error) throw new Error(`orderPaymentTotalsByIds: ${errMessage(error)}`);
  for (const row of (data ?? []) as OrderPaymentTotalsRow[]) {
    totals.set(row.order_id, row);
  }
  return totals;
}

/** Latest delivery status per order, for a set of orders (queue rollup). */
export async function latestDeliveryStatusByOrder(
  organizationId: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  if (orderIds.length === 0) return statuses;

  const { data, error } = await db
    .from("deliveries")
    .select("order_id, status, created_at")
    .eq("organization_id", organizationId)
    .in("order_id", orderIds)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`latestDeliveryStatusByOrder: ${errMessage(error)}`);
  // Rows are newest-first; keep the first status seen per order.
  for (const row of (data ?? []) as Array<{ order_id: string; status: string }>) {
    if (!statuses.has(row.order_id)) statuses.set(row.order_id, row.status);
  }
  return statuses;
}
