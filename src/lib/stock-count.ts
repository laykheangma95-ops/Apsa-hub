/**
 * Stock Count — the browser-side boundary for /app/inventory/count, plus the
 * one pure comparison rule the server uses too.
 *
 * Thin wrappers over src/api/stock-count.ts plus pure presentation helpers.
 * Nothing here decides access or writes stock: the server resolves the product
 * inside the caller's organization, derives the system quantity from the
 * ledger, and — on confirm — re-derives it, refuses if it moved, and appends
 * the reconciling adjustment itself (migration 053's record_stock_count_v1).
 *
 * Duplicate safety on the client side is one rule, the same as receiving: a
 * confirmed count keeps ONE count key across every retry of the same request
 * (createIdempotencyKeyHolder) and gets a new key once it was recorded or the
 * request changed. The server is the authority — it replays a repeated key and
 * refuses a reused one — so a client bug here can never adjust stock twice.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import { parseQuantity } from "@/lib/inventory";

// ── Shapes returned by the server (src/server/inventory/stock-count.ts) ──────

/** One product variant being counted at one location. Identity only — no price, no cost. */
export interface StockCountItem {
  variantId: string;
  productId: string;
  productNameKm: string;
  productNameEn: string | null;
  variantName: string;
  sku: string | null;
  barcode: string | null;
  /** null = stock recorded without a location. */
  locationId: string | null;
  /** Ledger balance for exactly this (variant, location). May be negative. */
  systemQuantity: number;
}

export type StockCountScanResult =
  | { kind: "item"; item: StockCountItem }
  | { kind: "not_found" }
  | { kind: "not_a_product" }
  | { kind: "location_not_found" };

export interface StockCountSearchHit {
  variantId: string;
  productId: string;
  productNameKm: string;
  productNameEn: string | null;
  variantName: string;
  sku: string | null;
  barcode: string | null;
}

export type StockCountItemResult =
  | { kind: "item"; item: StockCountItem }
  | { kind: "variant_not_found" }
  | { kind: "location_not_found" };

export type StockAdjustmentDirection = "none" | "increase" | "decrease";

export interface StockCountComparison {
  systemQuantity: number;
  countedQuantity: number;
  /** counted − system: the adjustment that would be written. */
  difference: number;
  /** On-hand at this location after the adjustment (always the counted quantity). */
  resultingQuantity: number;
  direction: StockAdjustmentDirection;
}

export type StockCountPreviewResult =
  | { kind: "preview"; preview: StockCountComparison }
  | { kind: "variant_not_found" }
  | { kind: "location_not_found" };

export interface StockCountRecord {
  countId: string;
  countKey: string;
  variantId: string;
  productId: string;
  locationId: string | null;
  systemQuantity: number;
  countedQuantity: number;
  difference: number;
  /** The ledger adjustment; null when the count matched the ledger. */
  movementId: string | null;
  countedAt: string;
}

export type RecordStockCountResult =
  | { kind: "recorded"; count: StockCountRecord; replayed: boolean }
  /** The ledger moved since the preview; nothing was written. */
  | { kind: "stale"; systemQuantity: number }
  | { kind: "count_conflict" }
  | { kind: "variant_not_found" }
  | { kind: "location_not_found" };

export interface RecordStockCountRequest {
  variantId: string;
  locationId: string | null;
  countedQuantity: number;
  expectedSystemQuantity: number;
}

// ── Limits (mirrored by the server and migration 053; the server re-checks) ──

export const MAX_COUNTED_QUANTITY = 1_000_000;
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 100;

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Compare the ledger with a physical count. Integer arithmetic only.
 *
 * The adjustment is exactly counted − system, so the resulting on-hand is the
 * counted quantity — including when the system figure was negative.
 */
export function compareStockCount(
  systemQuantity: number,
  countedQuantity: number,
): StockCountComparison {
  const difference = countedQuantity - systemQuantity;
  return {
    systemQuantity,
    countedQuantity,
    difference,
    resultingQuantity: systemQuantity + difference,
    direction: difference === 0 ? "none" : difference > 0 ? "increase" : "decrease",
  };
}

/** The counted quantity to send, or null when the typed text is not a countable quantity. 0 is valid. */
export function parseCountedQuantity(text: string): number | null {
  const quantity = parseQuantity(text, false);
  if (quantity === null || quantity < 0 || quantity > MAX_COUNTED_QUANTITY) return null;
  return quantity;
}

/** The search text to send, or null when it is too short or too long to search. */
export function normalizeSearchQuery(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH || trimmed.length > MAX_SEARCH_LENGTH) return null;
  return trimmed;
}

/**
 * The request a count key is held for. Any change to what would be recorded —
 * including a refreshed system quantity after a stale refusal — changes this
 * string, so a changed request never reuses an old key.
 */
export function stockCountRequestFingerprint(request: RecordStockCountRequest): string {
  return JSON.stringify([
    request.variantId,
    request.locationId,
    request.countedQuantity,
    request.expectedSystemQuantity,
  ]);
}

/** Signed difference, "+" made explicit so direction is never guessed. */
export function formatDifference(difference: number): string {
  return difference > 0 ? `+${difference}` : String(difference);
}

/** i18n key naming the direction of an adjustment — never conveyed by color alone. */
export function directionLabelKey(direction: StockAdjustmentDirection): string {
  return `stockCount.direction.${direction}`;
}

/** i18n key for a scan outcome the merchant must act on (null for an item). */
export function stockCountScanMessageKey(result: StockCountScanResult): string | null {
  switch (result.kind) {
    case "item":
      return null;
    case "not_found":
      return "stockCount.scan.notFound";
    case "not_a_product":
      return "stockCount.scan.notAProduct";
    case "location_not_found":
      return "stockCount.error.locationNotFound";
  }
}

/** i18n key for a non-success outcome of item lookup, preview or record (null on success). */
export function stockCountResultMessageKey(
  result: StockCountItemResult | StockCountPreviewResult | RecordStockCountResult,
): string | null {
  switch (result.kind) {
    case "item":
    case "preview":
    case "recorded":
      return null;
    case "stale":
      return "stockCount.error.stale";
    case "count_conflict":
      return "stockCount.error.countConflict";
    case "variant_not_found":
      return "stockCount.error.variantNotFound";
    case "location_not_found":
      return "stockCount.error.locationNotFound";
  }
}

export type StockCountErrorKind = "denied" | "invalid" | "generic";

/**
 * Classify a thrown server error. Presentation only — the server has already
 * refused the action before this runs.
 */
export function classifyStockCountError(err: unknown): StockCountErrorKind {
  const message = err instanceof Error ? err.message : "";
  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated"
  ) {
    return "denied";
  }
  if (
    message.includes("counted_quantity must") ||
    message.includes("count_key must") ||
    message.includes("expected_system_quantity must")
  ) {
    return "invalid";
  }
  return "generic";
}

export function stockCountErrorKey(kind: StockCountErrorKind): string {
  return `stockCount.error.${kind}`;
}

// ── Server function wrappers ─────────────────────────────────────────────────

export async function resolveStockCountScan(
  raw: string,
  locationId: string | null,
): Promise<StockCountScanResult> {
  const { resolveStockCountScanFn } = await import("@/api/stock-count");
  const result = await resolveStockCountScanFn({ data: { raw, locationId } });
  return result as unknown as StockCountScanResult;
}

export async function searchStockCountProducts(query: string): Promise<StockCountSearchHit[]> {
  const { searchStockCountProductsFn } = await import("@/api/stock-count");
  const result = await searchStockCountProductsFn({ data: { query } });
  return (result as unknown as { results: StockCountSearchHit[] }).results;
}

export async function getStockCountItem(
  variantId: string,
  locationId: string | null,
): Promise<StockCountItemResult> {
  const { getStockCountItemFn } = await import("@/api/stock-count");
  const result = await getStockCountItemFn({ data: { variantId, locationId } });
  return result as unknown as StockCountItemResult;
}

export async function previewStockCount(input: {
  variantId: string;
  locationId: string | null;
  countedQuantity: number;
}): Promise<StockCountPreviewResult> {
  const { previewStockCountFn } = await import("@/api/stock-count");
  const result = await previewStockCountFn({ data: input });
  return result as unknown as StockCountPreviewResult;
}

export async function recordStockCount(
  countKey: string,
  request: RecordStockCountRequest,
): Promise<RecordStockCountResult> {
  const { recordStockCountFn } = await import("@/api/stock-count");
  const result = await recordStockCountFn({
    data: {
      countKey,
      variantId: request.variantId,
      locationId: request.locationId,
      countedQuantity: request.countedQuantity,
      expectedSystemQuantity: request.expectedSystemQuantity,
    },
  });
  return result as unknown as RecordStockCountResult;
}
