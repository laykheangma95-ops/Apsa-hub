/**
 * Parcel service — create and resolve parcel identities.
 *
 * A parcel identity is a permanent, opaque code (APSA:PCL:v1:<token>) assigned
 * to a physical package. Creating one is idempotent: if the order already has an
 * active parcel, the existing identity is returned. The code is generated in
 * the database (new_apsa_parcel_code_v1, migration 057) and never changes.
 *
 * Resolving a parcel code is tenant-isolated: scanning a code from Org A in
 * Org B returns null (opaque not-found). The resolver returns a minimal summary
 * safe for the current PR; full investigation context is deferred.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";
import * as ordersRepo from "@/server/orders/repository";
import * as repo from "./repository";

export interface Parcel {
  id: string;
  parcelCode: string;
  orderId: string;
  status: string;
  createdAt: string;
}

export interface ParcelResolution {
  parcelId: string;
  parcelCode: string;
  orderId: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  itemCount: number;
}

function rowToParcel(row: repo.ParcelRow): Parcel {
  return {
    id: row.id,
    parcelCode: row.parcel_code,
    orderId: row.order_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Create or retrieve the parcel identity for an order.
 *
 * Idempotent: if the order already has an active parcel, it is returned without
 * creating a new one. A new parcel is only created when none exists.
 *
 * The order must exist in the caller's organization and be confirmed. That
 * check and the parcel write are ONE atomic database decision under the order
 * row lock (migration 059, recover_order_parcel_v1) — never "read lifecycle,
 * then insert", which let a cancellation committing in between give a
 * cancelled order an active parcel.
 */
export async function createParcelForOrder(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<Parcel> {
  ctx.require("fulfillment.create_parcel");

  const result = await ordersRepo.recoverOrderParcel(ctx.organizationId, orderId, ctx.userId);
  if (result.status === "not_found") throw publicError("Order not found", 404);
  if (result.status === "not_confirmed") {
    throw publicError("A parcel identity can only be created for a confirmed order", 409);
  }

  const row = await repo.findActiveParcelByOrder(ctx.organizationId, orderId);
  if (!row) throw publicError("The order's parcel changed concurrently — re-read and retry", 409);
  return rowToParcel(row);
}

/**
 * Resolve a scanned parcel code to its summary within the caller's org.
 *
 * Returns null when the code does not match any parcel in this org — no
 * distinction between "wrong org" and "doesn't exist" (opaque not-found).
 */
export async function resolveParcelCode(
  ctx: AuthorizationContext,
  code: string,
): Promise<ParcelResolution | null> {
  ctx.require("fulfillment.scan_parcel");

  if (!isValidParcelCode(code)) return null;

  const row = await repo.findParcelWithOrder(ctx.organizationId, code);
  if (!row) return null;

  const itemCount = await repo.countOrderItems(ctx.organizationId, row.order_id);

  return {
    parcelId: row.id,
    parcelCode: row.parcel_code,
    orderId: row.order_id,
    orderNumber: row.order_number,
    status: row.status,
    createdAt: row.created_at,
    itemCount,
  };
}

/**
 * Look up the active parcel code for an order, if one exists.
 * Used by the label service to include the parcel code on the label.
 */
export async function getParcelCodeForOrder(
  organizationId: string,
  orderId: string,
): Promise<string | null> {
  const row = await repo.findActiveParcelByOrder(organizationId, orderId);
  return row?.parcel_code ?? null;
}
