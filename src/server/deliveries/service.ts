import type { Money } from "@/types";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as repo from "./repository";
import {
  isTerminalDeliveryStatus,
  isValidDeliveryTransition,
  type DeliveryStatus,
} from "./state-machine";
import type {
  DeliveryRow,
  DeliveryStatusHistoryRow,
  ListDeliveriesOptions,
  OrderRefRow,
} from "./types";

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
// attempts exist, show current unresolved delivery state truthfully."
//
// Correctness rests on one DB invariant: uniq_deliveries_active_order
// (supabase/migrations/027_delivery_fulfillment_domain.sql) is UNIQUE
// (organization_id, order_id) WHERE status IN ('pending','preparing','ready',
// 'in_transit'), and create_delivery_v1 takes a FOR UPDATE lock on the parent
// order. So attempts for one order are strictly serialised: a new attempt can
// only exist once the previous one is terminal. The newest row per order_id is
// therefore always that order's true current delivery state.
//
// COMPLETENESS. An earlier revision of this list read a single capped window
// of raw rows and *then* deduped and filtered. That lost completeness before
// truth was derived: any order whose latest attempt fell outside that window
// vanished, and a status filter could report zero while hundreds of matching
// orders existed. The scan below inverts the order — it resolves
// latest-per-order over the whole stream and only then filters and paginates,
// so a result of zero means zero.

const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "pending",
  "preparing",
  "ready",
  "in_transit",
];
const COMPLETED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "failed", "cancelled"];

/** Rows pulled per scan round trip. Sized so the overwhelming majority of pages resolve in one. */
const SCAN_WINDOW = 500;
/**
 * Upper bound on rows examined for a single request. This is a safety valve,
 * not a correctness boundary: the scan is complete below it, and when it does
 * stop a scan early the result says so (`truncated`) instead of silently
 * presenting a short list as the whole truth.
 */
const SCAN_SAFETY_LIMIT = 10_000;
/** Orders per latest-attempt resolution round trip (see repo.listDeliveryAttemptRefsForOrders). */
const LATEST_ATTEMPT_CHUNK = 50;

const MERCHANT_LIST_DEFAULT_LIMIT = 50;
const MERCHANT_LIST_MAX_LIMIT = 200;

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
  /** True when the delivery's current status is 'failed' — the one status that always needs merchant action. */
  actionNeeded: boolean;
}

/**
 * One truthful page of the Deliveries list.
 *
 * `hasMore` is probe-derived (the scan resolves one item past the page before
 * answering), so it is never a guess. `truncated` is the honest signal that
 * SCAN_SAFETY_LIMIT stopped the scan before the source was exhausted — the
 * only circumstance in which this list is knowingly incomplete.
 */
export interface DeliveryListPage {
  items: DeliveryListItem[];
  hasMore: boolean;
  truncated: boolean;
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
 * The statuses a row must carry to be a candidate for this request, or null to
 * scan every status. Pushing this into the query is what keeps a rare-status
 * filter (say "failed" across a year of history) to a small, selective read
 * instead of a full-table walk — the filter still applies to each order's
 * *latest* attempt, because every candidate is verified below.
 */
function candidateStatuses(
  options: ListDeliveriesForMerchantOptions,
): readonly DeliveryStatus[] | null {
  if (options.status) return [options.status];
  if (options.scope === "active") return ACTIVE_DELIVERY_STATUSES;
  if (options.scope === "completed") return COMPLETED_DELIVERY_STATUSES;
  return null;
}

/**
 * Whether a candidate row could be superseded by a newer attempt.
 *
 * No, in two cases:
 *  - An unfiltered scan walks every row newest-first, so the first row seen for
 *    an order is by construction its latest.
 *  - A row in an *active* status is always its order's latest: while it is
 *    active, uniq_deliveries_active_order forbids a second active row and
 *    create_delivery_v1 refuses to open a new attempt, so nothing newer can
 *    exist. It stops being active only by transitioning in place.
 *
 * Terminal candidates are the real case: an old `failed` row is only this
 * order's current state if no retry has superseded it.
 */
function needsLatestAttemptCheck(statuses: readonly DeliveryStatus[] | null): boolean {
  if (statuses === null) return false;
  return statuses.some((status) => !ACTIVE_DELIVERY_STATUSES.includes(status));
}

interface LatestAttemptVerification {
  /** Candidates verified either latest (kept) or genuinely superseded (dropped). */
  kept: DeliveryRow[];
  /**
   * True when at least one candidate's order returned no ref from
   * repo.listDeliveryAttemptRefsForOrders — an absence that cannot happen
   * from a PostgREST row cap (that read is bounded to one row per order) but
   * could still reflect a race outside this domain's control. An absent ref
   * is UNKNOWN, never treated as FALSE (superseded): the candidate is kept
   * rather than silently dropped, and the caller must surface this as
   * incompleteness rather than presenting the page as certain.
   */
  unresolved: boolean;
}

/**
 * Keeps only those candidates that really are their order's latest attempt,
 * preserving the caller's newest-first ordering. Exact, not heuristic: for
 * each order it reads the one row repo.listDeliveryAttemptRefsForOrders
 * proves is that order's latest (see that function for why the read is
 * bounded and therefore complete) and compares ids.
 */
async function keepOnlyLatestAttempts(
  organizationId: string,
  candidates: DeliveryRow[],
): Promise<LatestAttemptVerification> {
  if (candidates.length === 0) return { kept: [], unresolved: false };
  const kept: DeliveryRow[] = [];
  let unresolved = false;
  for (let i = 0; i < candidates.length; i += LATEST_ATTEMPT_CHUNK) {
    const chunk = candidates.slice(i, i + LATEST_ATTEMPT_CHUNK);
    const refs = await repo.listDeliveryAttemptRefsForOrders(
      organizationId,
      chunk.map((row) => row.order_id),
    );
    // Each order contributes at most one ref (see repo.listDeliveryAttemptRefsForOrders) —
    // it is that order's sole, provably-authoritative latest row.
    const latestIdByOrder = new Map<string, string>();
    for (const ref of refs) latestIdByOrder.set(ref.order_id, ref.id);
    for (const row of chunk) {
      const latestId = latestIdByOrder.get(row.order_id);
      if (latestId === undefined) {
        // VERIFIED-SUPERSEDED is not provable here — admit UNRESOLVED rather
        // than guess, and never drop the candidate on the strength of a guess.
        unresolved = true;
        kept.push(row);
        continue;
      }
      if (latestId === row.id) kept.push(row); // VERIFIED-LATEST
      // else: VERIFIED-SUPERSEDED — correctly excluded.
    }
  }
  return { kept, unresolved };
}

/**
 * Deliveries newest-attempt-first, one row per order, enriched with the order
 * code and (permission-gated) customer name for the Deliveries list screen.
 *
 * Tenant isolation: every read below is scoped to ctx.organizationId, so a
 * delivery/order/customer belonging to another organization can never appear
 * — it is filtered out at the query, not redacted after the fact.
 *
 * Shape of the scan, in the order the requirement demands:
 *   A. resolve each order's latest attempt authoritatively (candidate window →
 *      first-per-order → latest-attempt check where it can matter),
 *   B. apply the requested status/scope (and search) to that derived set,
 *   C. paginate the derived results,
 *   D. enrich only what the answer needs.
 */
export async function listDeliveriesForMerchant(
  ctx: AuthorizationContext,
  options: ListDeliveriesForMerchantOptions = {},
): Promise<DeliveryListPage> {
  ctx.require("delivery.read");

  const limit = Math.min(
    Math.max(options.limit ?? MERCHANT_LIST_DEFAULT_LIMIT, 1),
    MERCHANT_LIST_MAX_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const needle = options.search?.trim().toLowerCase() || null;
  const statuses = candidateStatuses(options);
  const verifyLatest = needsLatestAttemptCheck(statuses);

  // Resolve one item past the page so hasMore is observed, never estimated.
  const wanted = offset + limit + 1;

  const canViewCustomers = ctx.can("customers.read");
  const orderRefCache = new Map<string, OrderRefRow | null>();
  const customerNameCache = new Map<string, string | null>();

  /**
   * Enrichment for a batch of rows, memoised across the scan. When a search is
   * running this necessarily touches every scanned batch (a customer name is
   * searchable), so the page slice at the end costs no further round trip.
   */
  async function enrich(rows: DeliveryRow[]): Promise<DeliveryListItem[]> {
    const missingOrderIds = [
      ...new Set(rows.map((row) => row.order_id).filter((id) => !orderRefCache.has(id))),
    ];
    if (missingOrderIds.length > 0) {
      const refs = await repo.listOrderRefsForOrg(ctx.organizationId, missingOrderIds);
      const byId = new Map(refs.map((ref) => [ref.id, ref]));
      // A miss is cached as null: a cross-org or deleted order resolves to
      // nothing exactly once, and never re-queries.
      for (const id of missingOrderIds) orderRefCache.set(id, byId.get(id) ?? null);
    }

    if (canViewCustomers) {
      const missingCustomerIds = [
        ...new Set(
          rows
            .map((row) => orderRefCache.get(row.order_id)?.customer_id ?? null)
            .filter((id): id is string => Boolean(id) && !customerNameCache.has(id as string)),
        ),
      ];
      if (missingCustomerIds.length > 0) {
        const customers = await repo.listCustomerRefsForOrg(ctx.organizationId, missingCustomerIds);
        const byId = new Map(customers.map((c) => [c.id, c.display_name]));
        for (const id of missingCustomerIds) customerNameCache.set(id, byId.get(id) ?? null);
      }
    }

    return rows.map((row) => {
      const orderRef = orderRefCache.get(row.order_id) ?? null;
      const customerId = orderRef?.customer_id ?? null;
      return {
        ...mapDelivery(row),
        orderCode: orderRef?.order_number ?? null,
        customerName:
          canViewCustomers && customerId ? (customerNameCache.get(customerId) ?? null) : null,
        hasCustomer: Boolean(customerId),
        // COD is never a payment signal (ARCHITECTURE.md) — "failed" is the only
        // status that always needs merchant action; the rest are steady-state.
        actionNeeded: row.status === "failed",
      };
    });
  }

  // Residual concurrency risk, documented precisely: the scan below pages the
  // raw stream by offset. A concurrent INSERT at the head is benign — windows
  // are contiguous, so a shift-down just re-reads a row already recorded in
  // seenOrderIds. The real risk is a row LEAVING the current candidate set
  // between two windows of the SAME request (e.g. an in_transit delivery
  // transitions to delivered while an "active" scope scan is mid-flight):
  // every row after it shifts up by one, and the row that shifts past the
  // window boundary is skipped for this request, with no signal. It is not
  // detected as truncated because the scan does reach the end of the stream —
  // it simply reads a version of it that changed underneath it. Only
  // reachable when a single request needs more than one SCAN_WINDOW to
  // answer (order count in the active candidate set exceeds SCAN_WINDOW), and
  // self-corrects on the next fetch. Same offset-paging class as the existing
  // Orders list. A keyset cursor on (created_at, id) would remove this; not
  // done here to keep this fix narrowly scoped to the verification defect.
  const resolved: DeliveryRow[] = [];
  const seenOrderIds = new Set<string>();
  let scanned = 0;
  let exhausted = false;
  let truncated = false;

  while (resolved.length < wanted && !exhausted) {
    if (scanned >= SCAN_SAFETY_LIMIT) {
      truncated = true;
      break;
    }
    const window = Math.min(SCAN_WINDOW, SCAN_SAFETY_LIMIT - scanned);
    const rows = await repo.scanDeliveries(ctx.organizationId, {
      statuses: statuses ? [...statuses] : undefined,
      offset: scanned,
      limit: window,
    });
    scanned += rows.length;
    if (rows.length < window) exhausted = true;

    // Rows arrive newest-first, so the first row seen for an order is that
    // order's newest *candidate* attempt. Later rows for the same order are
    // superseded history and are dropped here, before any filtering — a
    // resolved failure can therefore never resurface under a status filter.
    const firstPerOrder: DeliveryRow[] = [];
    for (const row of rows) {
      if (seenOrderIds.has(row.order_id)) continue;
      seenOrderIds.add(row.order_id);
      firstPerOrder.push(row);
    }

    let batch = firstPerOrder;
    if (verifyLatest) {
      const verification = await keepOnlyLatestAttempts(ctx.organizationId, firstPerOrder);
      batch = verification.kept;
      // An order whose latest-attempt verification could not be resolved
      // makes this page's answer provably incomplete, same as the scan
      // safety valve below — never presented as a certain "zero" or "done".
      if (verification.unresolved) truncated = true;
    }

    if (needle && batch.length > 0) {
      const enriched = await enrich(batch);
      const matchedIds = new Set(
        enriched.filter((item) => matchesSearch(item, needle)).map((item) => item.id),
      );
      batch = batch.filter((row) => matchedIds.has(row.id));
    }

    resolved.push(...batch);
  }

  const hasMore = resolved.length > offset + limit;
  const pageRows = resolved.slice(offset, offset + limit);
  return { items: await enrich(pageRows), hasMore, truncated };
}
