/**
 * Parcel repository — org-scoped reads and writes through service_role.
 *
 * Same pattern as src/server/fulfillment/repository.ts: minimal, org-filtered
 * queries via supabaseAdmin. Never import from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setParcelRepositoryDbForTests(testDb: unknown): () => void {
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

export interface ParcelRow {
  id: string;
  organization_id: string;
  order_id: string;
  parcel_code: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function findActiveParcelByOrder(
  organizationId: string,
  orderId: string,
): Promise<ParcelRow | null> {
  const { data, error } = await db
    .from("parcels")
    .select(
      "id, organization_id, order_id, parcel_code, status, created_by, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .neq("status", "void")
    .limit(1);

  if (error) throw new Error(`findActiveParcelByOrder: ${errMessage(error)}`);
  const rows = (data ?? []) as ParcelRow[];
  return rows[0] ?? null;
}

export async function findParcelByCode(
  organizationId: string,
  parcelCode: string,
): Promise<ParcelRow | null> {
  const { data, error } = await db
    .from("parcels")
    .select(
      "id, organization_id, order_id, parcel_code, status, created_by, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("parcel_code", parcelCode)
    .limit(1);

  if (error) throw new Error(`findParcelByCode: ${errMessage(error)}`);
  const rows = (data ?? []) as ParcelRow[];
  return rows[0] ?? null;
}

export async function insertParcel(
  organizationId: string,
  orderId: string,
  parcelCode: string,
  createdBy: string | null,
): Promise<ParcelRow> {
  const { data, error } = await db
    .from("parcels")
    .insert({
      organization_id: organizationId,
      order_id: orderId,
      parcel_code: parcelCode,
      status: "created",
      created_by: createdBy,
    })
    .select(
      "id, organization_id, order_id, parcel_code, status, created_by, created_at, updated_at",
    )
    .single();

  if (error) throw new Error(`insertParcel: ${errMessage(error)}`);
  return data as ParcelRow;
}

export interface ParcelWithOrderRow {
  id: string;
  parcel_code: string;
  order_id: string;
  status: string;
  created_at: string;
  order_number: string;
}

export async function findParcelWithOrder(
  organizationId: string,
  parcelCode: string,
): Promise<ParcelWithOrderRow | null> {
  const { data, error } = await db
    .from("parcels")
    .select("id, parcel_code, order_id, status, created_at, orders(order_number)")
    .eq("organization_id", organizationId)
    .eq("parcel_code", parcelCode)
    .limit(1);

  if (error) throw new Error(`findParcelWithOrder: ${errMessage(error)}`);
  const rows = (data ?? []) as Array<{
    id: string;
    parcel_code: string;
    order_id: string;
    status: string;
    created_at: string;
    orders: { order_number: string } | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    parcel_code: row.parcel_code,
    order_id: row.order_id,
    status: row.status,
    created_at: row.created_at,
    order_number: row.orders?.order_number ?? "",
  };
}

export async function countOrderItems(organizationId: string, orderId: string): Promise<number> {
  const { data, error } = await db
    .from("order_items")
    .select("quantity")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId);

  if (error) throw new Error(`countOrderItems: ${errMessage(error)}`);
  let count = 0;
  for (const row of (data ?? []) as Array<{ quantity: number }>) {
    count += row.quantity;
  }
  return count;
}
