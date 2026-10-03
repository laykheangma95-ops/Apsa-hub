/**
 * Customer Returns — the browser-side boundary for /app/returns, plus the pure
 * rules the server uses too.
 *
 *   Delivered order → Request → Receive → Inspect (resellable / damaged per
 *   line) → Complete
 *
 * Thin wrappers over src/api/returns.ts plus pure presentation helpers.
 * Nothing here decides access or writes stock: the server resolves the order
 * inside the caller's organization, checks it was delivered, derives every
 * returnable quantity from the database, and — on completion — appends the
 * ledger movements itself (migration 056's complete_customer_return_v1).
 *
 * Duplicate safety on the client side is one rule, the same as receiving and
 * stock counts: a return request keeps ONE request key across every retry of
 * the same request (createIdempotencyKeyHolder) and gets a new key once it was
 * recorded or the request changed. Receive / inspect / complete need no key:
 * the server treats a repeated step as a replay. The server is the authority
 * either way, so a client bug here can never restock twice.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { CapabilityView } from "@/lib/capabilities";
import { parseQuantity } from "@/lib/inventory";
import { looksLikeParcelCode } from "@/lib/barcode/parcel-code";

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const RETURN_STATUSES = ["requested", "received", "inspected", "completed"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export function isReturnStatus(value: unknown): value is ReturnStatus {
  return typeof value === "string" && (RETURN_STATUSES as readonly string[]).includes(value);
}

/** The one step a merchant can take next from a status (null once completed). */
export type ReturnAction = "receive" | "inspect" | "complete";

export function nextReturnAction(status: ReturnStatus): ReturnAction | null {
  switch (status) {
    case "requested":
      return "receive";
    case "received":
      return "inspect";
    case "inspected":
      return "complete";
    case "completed":
      return null;
  }
}

// ── Shapes returned by the server (src/server/returns/service.ts) ────────────

export interface ReturnSummary {
  returnId: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  /** Units being returned, across all lines. */
  quantity: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReturnLine {
  returnItemId: string;
  orderItemId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  /** null until inspected. */
  damagedQuantity: number | null;
  /** null until inspected; always quantity − damagedQuantity. */
  resellableQuantity: number | null;
  /** Set once completed. */
  returnMovementId: string | null;
  damageMovementId: string | null;
}

export interface ReturnEvent {
  fromStatus: ReturnStatus | null;
  toStatus: ReturnStatus;
  at: string;
}

export interface ReturnTotals {
  quantity: number;
  /** null until every line is inspected. */
  resellable: number | null;
  damaged: number | null;
}

export interface ReturnDetail {
  returnId: string;
  orderId: string;
  orderNumber: string;
  status: ReturnStatus;
  createdAt: string;
  updatedAt: string;
  lines: ReturnLine[];
  history: ReturnEvent[];
  totals: ReturnTotals;
}

export type ReturnDetailResult =
  { kind: "return"; detail: ReturnDetail } | { kind: "return_not_found" };

export interface ReturnableLine {
  orderItemId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  orderedQuantity: number;
  /** Already requested in earlier returns (any status). */
  alreadyReturned: number;
  returnableQuantity: number;
}

export interface ReturnableOrder {
  orderId: string;
  orderNumber: string;
  lines: ReturnableLine[];
}

export type ReturnableOrderResult =
  | { kind: "order"; order: ReturnableOrder }
  | { kind: "order_not_found" }
  | { kind: "order_not_returnable" }
  | { kind: "order_not_delivered" };

export type RequestReturnResult =
  | { kind: "requested"; returnId: string; replayed: boolean }
  | { kind: "request_conflict" }
  | { kind: "invalid_items" }
  | { kind: "order_not_found" }
  | { kind: "order_not_returnable" }
  | { kind: "order_not_delivered" }
  | { kind: "item_not_in_order" }
  | { kind: "item_not_returnable" }
  | { kind: "quantity_exceeds_remaining"; remaining: number };

/** Outcome of receive / inspect / complete. */
export type ReturnStepResult =
  | { kind: "ok"; detail: ReturnDetail; replayed: boolean }
  | { kind: "return_not_found" }
  | { kind: "not_received" }
  | { kind: "not_inspected" }
  | { kind: "already_completed" }
  /** The inspection changed since it was shown; nothing was written. */
  | { kind: "stale"; detail: ReturnDetail }
  | { kind: "invalid_lines" }
  | { kind: "order_not_returnable" };

export interface ReturnRequestLine {
  orderItemId: string;
  quantity: number;
}

export interface InspectionLine {
  returnItemId: string;
  damagedQuantity: number;
}

// ── Limits (mirrored by the server and migration 056; the server re-checks) ──

export const MAX_RETURN_QUANTITY = 100_000;
export const MAX_RETURN_LINES = 100;
export const MAX_ORDER_NUMBER_LENGTH = 64;

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Totals for a set of lines. Integer arithmetic only. Resellable/damaged stay
 * null until every line has been inspected.
 */
export function returnTotals(
  lines: ReadonlyArray<{ quantity: number; damagedQuantity: number | null }>,
): ReturnTotals {
  let quantity = 0;
  let damaged = 0;
  let inspected = lines.length > 0;
  for (const line of lines) {
    quantity += line.quantity;
    if (line.damagedQuantity === null) inspected = false;
    else damaged += line.damagedQuantity;
  }
  return inspected
    ? { quantity, resellable: quantity - damaged, damaged }
    : { quantity, resellable: null, damaged: null };
}

/**
 * What completing a line does to the ledger: a `return` of +quantity, then a
 * `damage` of −damaged when some units are damaged. Sellable stock grows by
 * the resellable units only.
 */
export function ledgerEffect(quantity: number, damagedQuantity: number) {
  return {
    returnDelta: quantity,
    damageDelta: damagedQuantity > 0 ? -damagedQuantity : 0,
    sellableChange: quantity - damagedQuantity,
  };
}

/** The quantity to request for one line, or null when the typed text is not valid. 0 means "skip this line". */
export function parseReturnQuantity(text: string, max: number): number | null {
  if (text.trim() === "") return 0;
  const quantity = parseQuantity(text, false);
  if (quantity === null || quantity < 0 || quantity > max || quantity > MAX_RETURN_QUANTITY) {
    return null;
  }
  return quantity;
}

/** The order number to look up, or null when it cannot be one. */
export function normalizeOrderNumber(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ORDER_NUMBER_LENGTH) return null;
  return trimmed;
}

/** The request lines for the chosen quantities (lines left at 0 are skipped). */
export function buildReturnRequest(
  order: ReturnableOrder,
  quantities: Readonly<Record<string, number>>,
): ReturnRequestLine[] | null {
  const request: ReturnRequestLine[] = [];
  for (const line of order.lines) {
    const quantity = quantities[line.orderItemId] ?? 0;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > line.returnableQuantity) {
      return null;
    }
    if (quantity > 0) request.push({ orderItemId: line.orderItemId, quantity });
  }
  return request.length > 0 ? request : null;
}

/**
 * The request a request key is held for. Any change to what would be
 * requested changes this string, so a changed request never reuses an old key.
 */
export function returnRequestFingerprint(orderId: string, lines: ReturnRequestLine[]): string {
  const sorted = [...lines].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
  return JSON.stringify([orderId, sorted.map((line) => [line.orderItemId, line.quantity])]);
}

/** The inspection a return currently carries, in the shape complete expects (null if not inspected). */
export function currentInspection(detail: ReturnDetail): InspectionLine[] | null {
  const lines: InspectionLine[] = [];
  for (const line of detail.lines) {
    if (line.damagedQuantity === null) return null;
    lines.push({ returnItemId: line.returnItemId, damagedQuantity: line.damagedQuantity });
  }
  return lines;
}

/** Validate an inspection draft against the return: every line, 0 ≤ damaged ≤ quantity. */
export function buildInspection(
  detail: ReturnDetail,
  damaged: Readonly<Record<string, number>>,
): InspectionLine[] | null {
  const lines: InspectionLine[] = [];
  for (const line of detail.lines) {
    const value = damaged[line.returnItemId];
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > line.quantity) {
      return null;
    }
    lines.push({ returnItemId: line.returnItemId, damagedQuantity: value });
  }
  return lines.length > 0 ? lines : null;
}

// ── i18n keys (status is never conveyed by color alone) ─────────────────────

export function returnStatusLabelKey(status: ReturnStatus): string {
  return `returns.status.${status}`;
}

export function returnActionLabelKey(action: ReturnAction): string {
  return `returns.action.${action}`;
}

/** i18n key for a non-success lookup (null for an order). */
export function returnableOrderMessageKey(result: ReturnableOrderResult): string | null {
  switch (result.kind) {
    case "order":
      return null;
    case "order_not_found":
      return "returns.error.orderNotFound";
    case "order_not_returnable":
      return "returns.error.orderNotReturnable";
    case "order_not_delivered":
      return "returns.error.orderNotDelivered";
  }
}

/** i18n key for a non-success request (null when requested). */
export function requestReturnMessageKey(result: RequestReturnResult): string | null {
  switch (result.kind) {
    case "requested":
      return null;
    case "request_conflict":
      return "returns.error.requestConflict";
    case "invalid_items":
    case "item_not_in_order":
    case "item_not_returnable":
      return "returns.error.invalidItems";
    case "order_not_found":
      return "returns.error.orderNotFound";
    case "order_not_returnable":
      return "returns.error.orderNotReturnable";
    case "order_not_delivered":
      return "returns.error.orderNotDelivered";
    case "quantity_exceeds_remaining":
      return "returns.error.quantityExceedsRemaining";
  }
}

/** i18n key for a non-success step (null when it went through). */
export function returnStepMessageKey(result: ReturnStepResult): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "return_not_found":
      return "returns.error.returnNotFound";
    case "not_received":
      return "returns.error.notReceived";
    case "not_inspected":
      return "returns.error.notInspected";
    case "already_completed":
      return "returns.error.alreadyCompleted";
    case "stale":
      return "returns.error.stale";
    case "invalid_lines":
      return "returns.error.invalidLines";
    case "order_not_returnable":
      return "returns.error.orderNotReturnable";
  }
}

export type ReturnErrorKind = "denied" | "invalid" | "generic";

/**
 * Classify a thrown server error. Presentation only — the server has already
 * refused the action before this runs.
 */
export function classifyReturnError(err: unknown): ReturnErrorKind {
  const message = err instanceof Error ? err.message : "";
  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated"
  ) {
    return "denied";
  }
  if (message.includes("request_key must") || message.includes("quantity must")) {
    return "invalid";
  }
  return "generic";
}

export function returnErrorKey(kind: ReturnErrorKind): string {
  return `returns.error.${kind}`;
}

// ── React Query keys (partitioned by principal) ──────────────────────────────

export const RETURNS_QUERY_ROOT = "customer-returns";

export const returnsKeys = {
  principal: (userId: string, organizationId: string) =>
    [RETURNS_QUERY_ROOT, userId, organizationId] as const,
  list: (userId: string, organizationId: string) =>
    [RETURNS_QUERY_ROOT, userId, organizationId, "list"] as const,
  detail: (userId: string, organizationId: string, returnId: string) =>
    [RETURNS_QUERY_ROOT, userId, organizationId, "detail", returnId] as const,
};

/**
 * May this screen show returns for `organizationId`? Presentation only — every
 * returns call re-checks orders.return + orders.read server-side. Uses the
 * SENSITIVE reader: a return names an order, so a snapshot the server has not
 * just confirmed (a failed refresh) does not count as granted.
 */
export function canAccessReturns(capabilities: CapabilityView, organizationId: string): boolean {
  return (
    Boolean(organizationId) &&
    capabilities.organizationId === organizationId &&
    capabilities.canSensitive("orders.return") &&
    capabilities.canSensitive("orders.read")
  );
}

/** The last returns grant observed per QueryClient and principal. */
const LAST_RETURNS_GRANT = new WeakMap<QueryClient, Map<string, boolean>>();

/**
 * Evict every cached return of a principal the moment the screen observes it
 * may not see returns (and on the first denied observation, so data retained
 * from an earlier grant fails closed). In-flight reads are cancelled before
 * the synchronous removal so they cannot write the payload back.
 *
 * Call during render, BEFORE anything reads the cache — the returns screens
 * call it from ReturnsAccess, which renders nothing cached when denied.
 */
export function enforceReturnsCapabilityCache(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  allowed: boolean,
): void {
  try {
    let record = LAST_RETURNS_GRANT.get(queryClient);
    if (!record) {
      record = new Map();
      LAST_RETURNS_GRANT.set(queryClient, record);
    }
    const principal = `${userId}\u0000${organizationId}`;
    const previous = record.get(principal);
    record.set(principal, allowed);
    if (allowed || previous === false) return;

    const queryKey = returnsKeys.principal(userId, organizationId);
    void queryClient.cancelQueries({ queryKey }).catch(() => undefined);
    queryClient.removeQueries({ queryKey });
  } catch {
    // Never block rendering. ReturnsAccess still refuses the subtree.
  }
}

// ── Late responses ───────────────────────────────────────────────────────────

/**
 * Tells an async callback whether the screen that started it is still the
 * screen it would update. A guard belongs to ONE mounted identity — the
 * returns screens key their stateful layer by user, organization, return and
 * grant, so sign-out, an organization switch, a permission change or leaving
 * the screen unmounts it and retires every operation it started.
 *
 * begin() is called when an operation starts; the function it returns is true
 * only while that same mounted generation is live. A retired response must not
 * set state, write or invalidate the cache, or navigate.
 */
export interface OperationGuard {
  activate(): void;
  retire(): void;
  begin(): () => boolean;
}

export function createOperationGuard(): OperationGuard {
  let generation = 0;
  let active = false;
  return {
    activate() {
      active = true;
      generation += 1;
    },
    retire() {
      active = false;
      generation += 1;
    },
    begin() {
      const started = generation;
      return () => active && generation === started;
    },
  };
}

// ── Server function wrappers ─────────────────────────────────────────────────

export interface ReturnListResult {
  returns: ReturnSummary[];
  /** More (older) returns exist than this list shows. */
  truncated: boolean;
}

export async function listCustomerReturns(): Promise<ReturnListResult> {
  const { listCustomerReturnsFn } = await import("@/api/returns");
  const result = await listCustomerReturnsFn();
  return result as unknown as ReturnListResult;
}

export async function getCustomerReturn(returnId: string): Promise<ReturnDetailResult> {
  const { getCustomerReturnFn } = await import("@/api/returns");
  const result = await getCustomerReturnFn({ data: { returnId } });
  return result as unknown as ReturnDetailResult;
}

export async function findReturnableOrder(orderNumber: string): Promise<ReturnableOrderResult> {
  const { findReturnableOrderFn } = await import("@/api/returns");
  const result = await findReturnableOrderFn({ data: { orderNumber } });
  return result as unknown as ReturnableOrderResult;
}

/** Start a return from a scanned APSA Parcel QR (resolved server-side, org-scoped). */
export async function findReturnableOrderByParcel(
  parcelCode: string,
): Promise<ReturnableOrderResult> {
  const { findReturnableOrderByParcelFn } = await import("@/api/returns");
  const result = await findReturnableOrderByParcelFn({ data: { parcelCode } });
  return result as unknown as ReturnableOrderResult;
}

/**
 * The returns search field takes an order number OR an APSA Parcel code (typed
 * or scanned). A value carrying the APSA parcel prefix is a parcel lookup.
 */
export function returnLookupFor(
  text: string,
): { kind: "parcel"; parcelCode: string } | { kind: "order"; orderNumber: string } | null {
  const trimmed = text.trim();
  if (looksLikeParcelCode(trimmed)) return { kind: "parcel", parcelCode: trimmed };
  const orderNumber = normalizeOrderNumber(trimmed);
  return orderNumber === null ? null : { kind: "order", orderNumber };
}

export async function requestCustomerReturn(
  requestKey: string,
  orderId: string,
  lines: ReturnRequestLine[],
): Promise<RequestReturnResult> {
  const { requestCustomerReturnFn } = await import("@/api/returns");
  const result = await requestCustomerReturnFn({ data: { requestKey, orderId, lines } });
  return result as unknown as RequestReturnResult;
}

export async function receiveCustomerReturn(returnId: string): Promise<ReturnStepResult> {
  const { receiveCustomerReturnFn } = await import("@/api/returns");
  const result = await receiveCustomerReturnFn({ data: { returnId } });
  return result as unknown as ReturnStepResult;
}

export async function inspectCustomerReturn(
  returnId: string,
  lines: InspectionLine[],
): Promise<ReturnStepResult> {
  const { inspectCustomerReturnFn } = await import("@/api/returns");
  const result = await inspectCustomerReturnFn({ data: { returnId, lines } });
  return result as unknown as ReturnStepResult;
}

export async function completeCustomerReturn(
  returnId: string,
  expected: InspectionLine[],
): Promise<ReturnStepResult> {
  const { completeCustomerReturnFn } = await import("@/api/returns");
  const result = await completeCustomerReturnFn({ data: { returnId, expected } });
  return result as unknown as ReturnStepResult;
}
