/**
 * Parcel service — create and resolve parcel identities.
 *
 * A parcel identity is a permanent, opaque code (APSA:PCL:v1:<token>) assigned
 * to a physical package. Creating one is idempotent: if the order already has an
 * active parcel, the existing identity is returned. The code is generated
 * server-side from crypto randomness and never changes.
 *
 * Resolving a parcel code is tenant-isolated: scanning a code from Org A in
 * Org B returns null (opaque not-found). The resolver returns a minimal summary
 * safe for the current PR; full investigation context is deferred.
 *
 * Never import this file from browser-bundled code.
 */
import { randomBytes } from "node:crypto";
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { isValidParcelCode, PARCEL_CODE_PREFIX } from "@/lib/barcode/parcel-code";
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

function generateParcelCode(): string {
  const token = randomBytes(16).toString("base64url");
  return `${PARCEL_CODE_PREFIX}${token}`;
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
 * The order must exist in the caller's organization and be in a confirmed
 * lifecycle state (a draft or terminal order cannot be packed).
 */
export async function createParcelForOrder(
  ctx: AuthorizationContext,
  orderId: string,
): Promise<Parcel> {
  ctx.require("fulfillment.create_parcel");

  const order = await ordersRepo.findOrderById(ctx.organizationId, orderId);
  if (!order) throw publicError("Order not found", 404);

  if (order.lifecycle_status !== "confirmed") {
    throw publicError("A parcel identity can only be created for a confirmed order", 409);
  }

  return ensureParcelForOrder(ctx.organizationId, ctx.userId, orderId);
}

/**
 * Return the order's active parcel identity, creating it exactly once.
 *
 * INTERNAL — performs no capability check. The caller must already have
 * authorized the operation and verified the order belongs to `organizationId`
 * (Delivery arrangement under `delivery.create`; createParcelForOrder under
 * `fulfillment.create_parcel`). The partial unique index
 * uniq_parcels_org_order_active keeps one active identity per order even when
 * two requests race; the loser reads and returns the winner.
 */
export async function ensureParcelForOrder(
  organizationId: string,
  userId: string | null,
  orderId: string,
): Promise<Parcel> {
  const existing = await repo.findActiveParcelByOrder(organizationId, orderId);
  if (existing) return rowToParcel(existing);

  const parcelCode = generateParcelCode();

  try {
    const row = await repo.insertParcel(organizationId, orderId, parcelCode, userId);
    return rowToParcel(row);
  } catch (err: unknown) {
    // Race: another request created the parcel between our check and insert.
    // The unique index (org, order, status<>void) rejects the duplicate. Read
    // and return the winner.
    const msg = (err as { message?: string })?.message ?? "";
    if (msg.includes("uniq_parcels_org_order_active") || msg.includes("duplicate")) {
      const retry = await repo.findActiveParcelByOrder(organizationId, orderId);
      if (retry) return rowToParcel(retry);
    }
    throw err;
  }
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
