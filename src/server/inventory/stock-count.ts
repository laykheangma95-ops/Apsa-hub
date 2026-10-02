/**
 * Stock Count — server-authoritative physical counts, reconciled through the
 * inventory ledger.
 *
 * Flow: choose a location → scan a barcode (or search by name/SKU) → enter the
 * counted quantity → preview system vs counted → confirm → migration 053's
 * record_stock_count_v1 stores the count and, when it differs, appends ONE
 * `manual_adjustment` movement of (counted − system). Stock is never written as
 * a number; the balance stays SUM(inventory_movements).
 *
 * Security:
 *   - A count is a stock adjustment, so inventory.adjust (OWNER + MANAGER,
 *     migration 022) gates every step, checked before any lookup.
 *     inventory.read is required too, because every step shows the ledger's
 *     quantity; products.read is required to identify a product.
 *   - Tenant isolation: the organization comes from the AuthorizationContext
 *     only. A barcode, variant id or location id belonging to another
 *     organization resolves exactly like one that does not exist, here and
 *     again inside the RPC.
 *   - The client never states a movement type, a delta, a product id or a new
 *     balance. It states what it counted and which system quantity it was
 *     shown; the server derives everything else.
 *   - The mandatory inventory.adjust audit row is written by the RPC in the
 *     same transaction as the movement — neither can exist without the other.
 *
 * Duplicate and race safety (enforced in SQL, see migration 053):
 *   - one count key per confirmed count; a retry replays, a reused key for a
 *     different request is a conflict;
 *   - the system quantity is re-derived under a lock at confirm time; if the
 *     ledger moved since the preview the count is refused as `stale` and the
 *     merchant sees the new figure before anything is written.
 *
 * Not built here (by instruction): cycle counting, warehouse zones, offline
 * mode, multi-user counting, batch counting, variance approval.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { classifyScan } from "@/lib/barcode/scan-router";
import { normalizeScanInput } from "@/lib/barcode/normalize";
import {
  MAX_COUNTED_QUANTITY,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  compareStockCount,
  type RecordStockCountResult,
  type StockCountItem,
  type StockCountItemResult,
  type StockCountPreviewResult,
  type StockCountRecord,
  type StockCountScanResult,
  type StockCountSearchHit,
} from "@/lib/stock-count";
import * as repo from "./repository";

export { MAX_COUNTED_QUANTITY };

/** Most results one manual search returns. */
export const STOCK_COUNT_SEARCH_LIMIT = 20;

/** The ledger sums into a Postgres INTEGER. */
const PG_INT_MAX = 2_147_483_647;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordStockCountInput {
  countKey: string;
  variantId: string;
  locationId?: string | null | undefined;
  countedQuantity: number;
  expectedSystemQuantity: number;
}

// ── Guards ────────────────────────────────────────────────────────────────────

/** Every stock count step: adjust authority, and the right to see the ledger figure. */
function requireCountAccess(ctx: AuthorizationContext): void {
  ctx.require("inventory.adjust");
  ctx.require("inventory.read");
}

function assertCountedQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_COUNTED_QUANTITY) {
    throw publicError(
      `counted_quantity must be a whole number between 0 and ${MAX_COUNTED_QUANTITY}`,
      400,
    );
  }
}

/** The location scope is real and this organization's (null = no location). */
async function locationInOrg(ctx: AuthorizationContext, locationId: string | null) {
  if (locationId === null) return true;
  return (await repo.findLocationForOrg(ctx.organizationId, locationId)) !== null;
}

// ── Item (identity + system quantity at one scope) ────────────────────────────

/**
 * The variant as it will be counted: identity from the Product domain, system
 * quantity from the ledger for exactly (variant, location). ACTIVE variants
 * only — an archived variant is not counted, exactly as it is not received.
 */
async function buildItem(
  ctx: AuthorizationContext,
  variantId: string,
  locationId: string | null,
): Promise<StockCountItem | null> {
  const productsRepo = await import("@/server/products/repository");
  const variant = await productsRepo.findVariantById(ctx.organizationId, variantId);
  if (!variant || variant.status !== "ACTIVE") return null;

  const product = await productsRepo.findProductById(ctx.organizationId, variant.product_id);
  if (!product) return null;

  return {
    variantId: variant.id,
    productId: product.id,
    productNameKm: product.name_km,
    productNameEn: product.name_en,
    variantName: variant.name,
    sku: variant.sku,
    barcode: variant.barcode,
    locationId,
    systemQuantity: await repo.getScopedStockQuantity(ctx.organizationId, variant.id, locationId),
  };
}

/** Look up the variant chosen from a manual search result, at the chosen location. */
export async function getStockCountItem(
  ctx: AuthorizationContext,
  variantId: string,
  locationId: string | null,
): Promise<StockCountItemResult> {
  requireCountAccess(ctx);
  ctx.require("products.read");

  if (!UUID_RE.test(variantId)) return { kind: "variant_not_found" };
  if (!(await locationInOrg(ctx, locationId))) return { kind: "location_not_found" };

  const item = await buildItem(ctx, variantId, locationId);
  return item ? { kind: "item", item } : { kind: "variant_not_found" };
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a scanned or typed code to the variant being counted.
 *
 * Reuses the one scan identity router (src/server/scan/service.ts), including
 * its UPC-A ⇄ EAN-13 fallbacks. Parcel and order codes are recognised
 * structurally and refused without a lookup. Read-only.
 */
export async function resolveStockCountScan(
  ctx: AuthorizationContext,
  raw: string,
  locationId: string | null,
): Promise<StockCountScanResult> {
  requireCountAccess(ctx);
  ctx.require("products.read");

  if (!(await locationInOrg(ctx, locationId))) return { kind: "location_not_found" };

  const normalized = normalizeScanInput(raw);
  if (normalized === null) return { kind: "not_found" };

  const identity = classifyScan(normalized);
  if (identity.kind === "apsa-parcel" || identity.kind === "apsa-order") {
    return { kind: "not_a_product" };
  }
  if (identity.kind === "unknown") return { kind: "not_found" };

  const { resolveScan } = await import("@/server/scan/service");
  const resolution = await resolveScan(ctx, normalized);
  if (resolution.type !== "product" && resolution.type !== "variant") {
    return { kind: "not_found" };
  }

  const item = await buildItem(ctx, resolution.metadata.variantId, locationId);
  return item ? { kind: "item", item } : { kind: "not_found" };
}

// ── Manual search ─────────────────────────────────────────────────────────────

/**
 * Manual fallback when a code cannot be scanned: active variants matching a
 * product name (Khmer or English), variant name, SKU or barcode. Identity only;
 * the quantity is read when the merchant picks a result (getStockCountItem).
 */
export async function searchStockCountProducts(
  ctx: AuthorizationContext,
  query: string,
): Promise<{ results: StockCountSearchHit[] }> {
  requireCountAccess(ctx);
  ctx.require("products.read");

  const trimmed = query.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH || trimmed.length > MAX_SEARCH_LENGTH) {
    return { results: [] };
  }

  const rows = await repo.searchStockCountVariants(
    ctx.organizationId,
    trimmed,
    STOCK_COUNT_SEARCH_LIMIT,
  );
  return {
    results: rows.map((row) => ({
      variantId: row.variant_id,
      productId: row.product_id,
      productNameKm: row.product_name_km,
      productNameEn: row.product_name_en,
      variantName: row.variant_name,
      sku: row.sku,
      barcode: row.barcode,
    })),
  };
}

// ── Preview ───────────────────────────────────────────────────────────────────

/**
 * Compare the ledger with a physical count, without writing anything.
 *
 * The system quantity is read fresh from the ledger. The merchant confirms
 * against THIS figure; recordStockCount refuses if it has moved since.
 */
export async function previewStockCount(
  ctx: AuthorizationContext,
  input: { variantId: string; locationId: string | null; countedQuantity: number },
): Promise<StockCountPreviewResult> {
  requireCountAccess(ctx);
  assertCountedQuantity(input.countedQuantity);

  const variant = await repo.findVariantForOrg(ctx.organizationId, input.variantId);
  if (!variant || variant.status !== "ACTIVE") return { kind: "variant_not_found" };
  if (!(await locationInOrg(ctx, input.locationId))) return { kind: "location_not_found" };

  const systemQuantity = await repo.getScopedStockQuantity(
    ctx.organizationId,
    variant.id,
    input.locationId,
  );
  return { kind: "preview", preview: compareStockCount(systemQuantity, input.countedQuantity) };
}

// ── Record ────────────────────────────────────────────────────────────────────

function toRecord(row: repo.RecordStockCountRpcResult): StockCountRecord {
  return {
    countId: row.id ?? "",
    countKey: row.count_key ?? "",
    variantId: row.variant_id ?? "",
    productId: row.product_id ?? "",
    locationId: row.location_id ?? null,
    systemQuantity: row.system_quantity ?? 0,
    countedQuantity: row.counted_quantity ?? 0,
    difference: row.difference ?? 0,
    movementId: row.movement_id ?? null,
    countedAt: row.created_at ?? "",
  };
}

/**
 * Confirm a count: store it, and when it differs from the ledger append one
 * audited `manual_adjustment` of (counted − system) — all in one transaction.
 *
 * Validation order:
 *   1. inventory.adjust + inventory.read — before anything is read.
 *   2. Count key, counted quantity and expected system quantity shape.
 *   3. Everything else is decided atomically by record_stock_count_v1:
 *      key replay/conflict → variant and location ownership → stale check →
 *      count row + movement + audit.
 */
export async function recordStockCount(
  ctx: AuthorizationContext,
  input: RecordStockCountInput,
): Promise<RecordStockCountResult> {
  requireCountAccess(ctx);

  if (typeof input.countKey !== "string" || !UUID_RE.test(input.countKey)) {
    throw publicError("count_key must be a UUID", 400);
  }
  assertCountedQuantity(input.countedQuantity);
  if (
    !Number.isInteger(input.expectedSystemQuantity) ||
    Math.abs(input.expectedSystemQuantity) > PG_INT_MAX
  ) {
    throw publicError("expected_system_quantity must be a whole number", 400);
  }
  if (typeof input.variantId !== "string" || !UUID_RE.test(input.variantId)) {
    return { kind: "variant_not_found" };
  }
  const locationId = input.locationId ?? null;
  if (locationId !== null && !UUID_RE.test(locationId)) return { kind: "location_not_found" };

  const result = await repo.recordStockCount(ctx.organizationId, ctx.userId, {
    count_key: input.countKey,
    variant_id: input.variantId,
    location_id: locationId,
    counted_quantity: input.countedQuantity,
    expected_system_quantity: input.expectedSystemQuantity,
  });

  switch (result.status) {
    case "recorded":
      return { kind: "recorded", count: toRecord(result), replayed: false };
    case "replayed":
      return { kind: "recorded", count: toRecord(result), replayed: true };
    case "stale":
      return { kind: "stale", systemQuantity: result.system_quantity ?? 0 };
    case "count_conflict":
      return { kind: "count_conflict" };
    case "variant_not_found":
      return { kind: "variant_not_found" };
    case "location_not_found":
      return { kind: "location_not_found" };
  }
}
