import type { Money } from "@/types";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as repo from "./repository";
import {
  isTerminalDeliveryStatus,
  isValidDeliveryTransition,
  type DeliveryStatus,
} from "./state-machine";
import type { DeliveryRow, DeliveryStatusHistoryRow, ListDeliveriesOptions } from "./types";

export interface DeliverySummary {
  id: string;
  organizationId: string;
  orderId: string;
  locationId: string | null;
  providerId: string | null;
  providerKey: string | null;
  providerName: string;
  externalTrackingNumber: string | null;
  codAmount: Money | null;
  status: DeliveryStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryHistoryEntry {
  id: string;
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus;
  changedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface DeliveryDetail extends DeliverySummary {
  history: DeliveryHistoryEntry[];
}

export interface CreateDeliveryServiceInput {
  orderId: string;
  locationId?: string | null;
  providerId?: string | null;
  providerKey?: string | null;
  providerName?: string | null;
  externalTrackingNumber?: string | null;
  /** Operational collection reference only; never marks an Order paid. */
  codAmountMinor?: number | null;
}

const badRequest = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 400 });
const notFound = (message: string): Error => Object.assign(new Error(message), { statusCode: 404 });
const conflict = (message: string): Error => Object.assign(new Error(message), { statusCode: 409 });

function mapDelivery(row: DeliveryRow): DeliverySummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    orderId: row.order_id,
    locationId: row.location_id,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    providerName: row.provider_name,
    externalTrackingNumber: row.external_tracking_number,
    codAmount:
      row.cod_amount_minor !== null && row.cod_currency !== null
        ? { amount: row.cod_amount_minor, currency: row.cod_currency }
        : null,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistory(row: DeliveryStatusHistoryRow): DeliveryHistoryEntry {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedBy: row.changed_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

async function loadDetail(
  organizationId: string,
  deliveryId: string,
): Promise<DeliveryDetail | null> {
  const delivery = await repo.findDeliveryById(organizationId, deliveryId);
  if (!delivery) return null;
  const history = await repo.listDeliveryHistory(organizationId, deliveryId);
  return { ...mapDelivery(delivery), history: history.map(mapHistory) };
}

async function requireDetail(organizationId: string, deliveryId: string): Promise<DeliveryDetail> {
  const detail = await loadDetail(organizationId, deliveryId);
  if (!detail) throw notFound("Delivery not found");
  return detail;
}

function createFailure(status: string): Error {
  switch (status) {
    case "order_not_found":
      return notFound("Order not found");
    case "location_not_found":
      return notFound("Location not found");
    case "provider_not_found":
      return notFound("Delivery provider not found");
    case "provider_inactive":
      return conflict("Delivery provider is inactive");
    case "order_not_confirmed":
      return conflict("Delivery can only be created for a confirmed order");
    case "order_fulfillment_terminal":
      return conflict("Order fulfillment is already terminal");
    case "duplicate_active":
      return conflict("Order already has an active delivery");
    case "provider_required":
      return badRequest("A provider name is required for manual delivery");
    case "invalid_cod_amount":
      return badRequest("COD amount must be a non-negative integer minor amount");
    default:
      return new Error(`Delivery creation failed: ${status}`);
  }
}

export async function createDelivery(
  ctx: AuthorizationContext,
  input: CreateDeliveryServiceInput,
): Promise<DeliveryDetail> {
  ctx.require("delivery.create");

  const order = await repo.findOrderForOrg(ctx.organizationId, input.orderId);
  if (!order) throw notFound("Order not found");
  if (order.lifecycle_status !== "confirmed") {
    throw conflict("Delivery can only be created for a confirmed order");
  }
  if (order.fulfillment_status === "fulfilled" || order.fulfillment_status === "cancelled") {
    throw conflict("Order fulfillment is already terminal");
  }

  const locationId = input.locationId ?? order.location_id;
  if (locationId && !(await repo.findLocationForOrg(ctx.organizationId, locationId))) {
    throw notFound("Location not found");
  }

  let providerName = input.providerName?.trim() || null;
  let providerKey = input.providerKey?.trim() || null;
  if (input.providerId) {
    const provider = await repo.findProviderForOrg(ctx.organizationId, input.providerId);
    if (!provider) throw notFound("Delivery provider not found");
    if (!provider.active) throw conflict("Delivery provider is inactive");
    providerName = provider.name;
    providerKey = provider.provider_key;
  } else if (!providerName) {
    throw badRequest("A provider name is required for manual delivery");
  }

  const codAmountMinor = input.codAmountMinor ?? null;
  if (codAmountMinor !== null && (!Number.isInteger(codAmountMinor) || codAmountMinor < 0)) {
    throw badRequest("COD amount must be a non-negative integer minor amount");
  }

  if (await repo.findActiveDeliveryForOrder(ctx.organizationId, input.orderId)) {
    throw conflict("Order already has an active delivery");
  }

  const result = await repo.createDelivery(ctx.organizationId, ctx.userId, {
    order_id: input.orderId,
    location_id: locationId,
    provider_id: input.providerId ?? null,
    provider_key: providerKey,
    provider_name: providerName,
    external_tracking_number: input.externalTrackingNumber?.trim() || null,
    cod_amount_minor: codAmountMinor,
  });
  if (result.status !== "success" || !result.delivery_id) throw createFailure(result.status);
  return requireDetail(ctx.organizationId, result.delivery_id);
}

function transitionFailure(status: string, current?: string): Error {
  switch (status) {
    case "not_found":
      return notFound("Delivery not found");
    case "stale":
      return conflict(
        `Delivery changed concurrently (now ${current ?? "unknown"}) — re-read and retry`,
      );
    case "no_change":
      return conflict("Delivery is already in that status");
    case "terminal":
      return conflict("Delivery is terminal and can no longer be modified");
    case "invalid_transition":
      return conflict("Delivery transition is not allowed");
    case "order_terminal":
      return conflict("Order is terminal and its delivery can no longer be modified");
    case "order_fulfillment_terminal":
      return conflict("Order fulfillment conflicts with this delivery transition");
    default:
      return new Error(`Delivery transition failed: ${status}`);
  }
}

async function transition(
  ctx: AuthorizationContext,
  deliveryId: string,
  to: DeliveryStatus,
  reason?: string | null,
): Promise<DeliveryDetail> {
  ctx.require("delivery.update");
  const delivery = await repo.findDeliveryById(ctx.organizationId, deliveryId);
  if (!delivery) throw notFound("Delivery not found");
  if (isTerminalDeliveryStatus(delivery.status)) {
    throw conflict("Delivery is terminal and can no longer be modified");
  }
  if (!isValidDeliveryTransition(delivery.status, to)) {
    throw conflict(`Cannot move delivery from '${delivery.status}' to '${to}'`);
  }
  const result = await repo.transitionDelivery(
    ctx.organizationId,
    deliveryId,
    delivery.status,
    to,
    ctx.userId,
    reason?.trim() || null,
  );
  if (result.status !== "success") throw transitionFailure(result.status, result.current);
  return requireDetail(ctx.organizationId, deliveryId);
}

export const startPreparingDelivery = (
  ctx: AuthorizationContext,
  deliveryId: string,
  reason?: string | null,
): Promise<DeliveryDetail> => transition(ctx, deliveryId, "preparing", reason);

export const markDeliveryReady = (
  ctx: AuthorizationContext,
  deliveryId: string,
  reason?: string | null,
): Promise<DeliveryDetail> => transition(ctx, deliveryId, "ready", reason);

export const markDeliveryInTransit = (
  ctx: AuthorizationContext,
  deliveryId: string,
  reason?: string | null,
): Promise<DeliveryDetail> => transition(ctx, deliveryId, "in_transit", reason);

export const markDeliveryDelivered = (
  ctx: AuthorizationContext,
  deliveryId: string,
  reason?: string | null,
): Promise<DeliveryDetail> => transition(ctx, deliveryId, "delivered", reason);

export function markDeliveryFailed(
  ctx: AuthorizationContext,
  deliveryId: string,
  reason: string,
): Promise<DeliveryDetail> {
  if (!reason.trim()) throw badRequest("A failure reason is required");
  return transition(ctx, deliveryId, "failed", reason);
}

export function cancelDelivery(
  ctx: AuthorizationContext,
  deliveryId: string,
  reason: string,
): Promise<DeliveryDetail> {
  if (!reason.trim()) throw badRequest("A cancellation reason is required");
  return transition(ctx, deliveryId, "cancelled", reason);
}

export async function getDeliveryById(
  ctx: AuthorizationContext,
  deliveryId: string,
): Promise<DeliveryDetail> {
  ctx.require("delivery.read");
  return requireDetail(ctx.organizationId, deliveryId);
}

export async function listDeliveries(
  ctx: AuthorizationContext,
  options: ListDeliveriesOptions = {},
): Promise<DeliverySummary[]> {
  ctx.require("delivery.read");
  return (await repo.listDeliveries(ctx.organizationId, options)).map(mapDelivery);
}

// ── Merchant Deliveries list (src/routes/app.deliveries.tsx) ──────────────────
//
// A merchant-facing, one-row-per-order view — distinct from listDeliveries()
// above (which returns every delivery row, e.g. all attempts for one order,
// for the Order detail screen's own history read). Requirement: "Do not
// mislead merchants with old resolved delivery failures. Where multiple
// attempts exist, show current unresolved delivery state truthfully." A new
// delivery can only be created once the previous one for that order is
// terminal (see createDelivery's duplicate-active check and the DB's
// uniq_deliveries_active_order constraint), so the most recent row per
// order_id is always that order's true current delivery state — the same
// `deliveries[0]` convention src/routes/app.orders.$id.tsx already uses for
// its own "latest delivery" read.

const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "pending",
  "preparing",
  "ready",
  "in_transit",
];
const COMPLETED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "failed", "cancelled"];

/** Bounded raw fetch used to compute the latest-per-order list below (server-enforced max, src/api/deliveries.ts). */
const MERCHANT_LIST_RAW_FETCH_LIMIT = 200;
const MERCHANT_LIST_DEFAULT_LIMIT = 50;

export type DeliveryListScope = "active" | "completed";

export interface ListDeliveriesForMerchantOptions {
  status?: DeliveryStatus | undefined;
  scope?: DeliveryListScope | undefined;
  /** Case-insensitive match against order code, courier, tracking number, or (when visible) customer name. */
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface DeliveryListItem extends DeliverySummary {
  orderCode: string | null;
  /** Null when the order has no customer, or the caller lacks customers.read — never guessed, never leaked. */
  customerName: string | null;
  /** Safe to show even when customerName is redacted — mirrors orderList.hasCustomer/noCustomer. */
  hasCustomer: boolean;
  /** True when the delivery needs the merchant's attention: failed, or stalled non-terminal. */
  actionNeeded: boolean;
}

function matchesSearch(item: DeliveryListItem, needle: string): boolean {
  const haystack = [
    item.orderCode,
    item.providerName,
    item.externalTrackingNumber,
    item.customerName,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Deliveries newest-attempt-first, one row per order, enriched with the order
 * code and (permission-gated) customer name for the Deliveries list screen.
 *
 * Tenant isolation: every read below is scoped to ctx.organizationId, so a
 * delivery/order/customer belonging to another organization can never appear
 * — it is filtered out at the query, not redacted after the fact.
 */
export async function listDeliveriesForMerchant(
  ctx: AuthorizationContext,
  options: ListDeliveriesForMerchantOptions = {},
): Promise<DeliveryListItem[]> {
  ctx.require("delivery.read");

  const rawRows = await repo.listDeliveries(ctx.organizationId, {
    limit: MERCHANT_LIST_RAW_FETCH_LIMIT,
  });

  // Dedup to the latest attempt per order — rows are already newest-first.
  const latestByOrder = new Map<string, DeliveryRow>();
  for (const row of rawRows) {
    if (!latestByOrder.has(row.order_id)) latestByOrder.set(row.order_id, row);
  }
  let rows = [...latestByOrder.values()];

  // Status/scope filter applies to each order's CURRENT delivery only — never
  // resurfaces a superseded attempt just because an old row matched.
  if (options.status) {
    rows = rows.filter((row) => row.status === options.status);
  } else if (options.scope === "active") {
    rows = rows.filter((row) => ACTIVE_DELIVERY_STATUSES.includes(row.status));
  } else if (options.scope === "completed") {
    rows = rows.filter((row) => COMPLETED_DELIVERY_STATUSES.includes(row.status));
  }

  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const orderRefs = await repo.listOrderRefsForOrg(ctx.organizationId, orderIds);
  const orderById = new Map(orderRefs.map((o) => [o.id, o]));

  const canViewCustomers = ctx.can("customers.read");
  const customerNameById = new Map<string, string>();
  if (canViewCustomers) {
    const customerIds = [
      ...new Set(orderRefs.map((o) => o.customer_id).filter((id): id is string => Boolean(id))),
    ];
    const customers = await repo.listCustomerRefsForOrg(ctx.organizationId, customerIds);
    for (const c of customers) customerNameById.set(c.id, c.display_name);
  }

  let items: DeliveryListItem[] = rows.map((row) => {
    const summary = mapDelivery(row);
    const orderRef = orderById.get(row.order_id) ?? null;
    const customerId = orderRef?.customer_id ?? null;
    return {
      ...summary,
      orderCode: orderRef?.order_number ?? null,
      customerName: customerId ? (customerNameById.get(customerId) ?? null) : null,
      hasCustomer: Boolean(customerId),
      // COD is never a payment signal (ARCHITECTURE.md) — "failed" is the only
      // status that always needs merchant action; the rest are steady-state.
      actionNeeded: row.status === "failed",
    };
  });

  const needle = options.search?.trim().toLowerCase();
  if (needle) items = items.filter((item) => matchesSearch(item, needle));

  const offset = options.offset ?? 0;
  const limit = options.limit ?? MERCHANT_LIST_DEFAULT_LIMIT;
  return items.slice(offset, offset + limit);
}
