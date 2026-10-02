/**
 * Receiving Inventory — server-authoritative stock receipts.
 *
 * Flow: (optional supplier label) → scan or type a product barcode → confirm a
 * quantity → ONE `restock` movement is appended to the inventory ledger. Stock
 * is never written as a number; the balance is re-derived from the ledger
 * (migration 021's inventory_stock view), exactly as for every other movement.
 *
 * Security:
 *   - inventory.receive_stock (OWNER + MANAGER, migration 022) gates BOTH the
 *     scan resolution and the receipt, checked before any lookup. products.read
 *     is required as well to identify the scanned product.
 *   - Tenant isolation: the organization comes from the AuthorizationContext
 *     only. A barcode, variant id or location id belonging to another
 *     organization resolves exactly like one that does not exist.
 *   - The client never states a quantity on hand, a movement type or a product
 *     id: the server derives the product from the variant and always records
 *     `restock` with a positive whole quantity.
 *
 * Duplicate safety:
 *   Each confirmed receipt carries a client-generated receipt key (UUID). It is
 *   stored as reference_type 'inventory_receipt' / reference_id <key>, and
 *   migration 052's uniq_inventory_movements_receipt_key allows exactly one
 *   movement per key per organization. A retry of the same receipt (lost
 *   response, double tap, replayed request) gets the ORIGINAL movement back
 *   with `replayed: true` and adds no stock. The same key presented with a
 *   different request — another variant, quantity, location, supplier or
 *   member — is refused as a conflict and also adds no stock. The database
 *   index is the authority; the pre-read below only spares a failed insert.
 *
 * Not built here (by instruction): purchase orders, supplier management,
 * batch receiving, warehouse zones, stock counts, returns.
 *
 * Never import this file from browser-bundled code.
 */
import { publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { classifyScan } from "@/lib/barcode/scan-router";
import { normalizeScanInput } from "@/lib/barcode/normalize";
import * as repo from "./repository";
import type { InventoryMovementRow } from "./types";

// ── Limits ────────────────────────────────────────────────────────────────────

/** Largest single receipt. Guards against a scanner burst landing in the quantity field. */
export const MAX_RECEIVE_QUANTITY = 100_000;
/** Matches migration 052's inventory_movements_supplier_name_valid. */
export const MAX_SUPPLIER_NAME_LENGTH = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Result shapes ─────────────────────────────────────────────────────────────

/** The product a scanned code resolved to. Identity only — no price, no cost. */
export interface ReceivingProduct {
  variantId: string;
  productId: string;
  productNameKm: string;
  productNameEn: string | null;
  variantName: string;
  sku: string | null;
  barcode: string | null;
  /** Ledger balance across all locations; null when the caller lacks inventory.read. */
  quantityOnHand: number | null;
}

export type ReceivingScanResult =
  | { kind: "product"; product: ReceivingProduct }
  /** Nothing receivable in this organization (unknown, other tenant's, or archived). */
  | { kind: "not_found" }
  /** A valid APSA code, but for a parcel or an order — not something to receive. */
  | { kind: "not_a_product" };

export interface InventoryReceipt {
  movementId: string;
  receiptKey: string;
  variantId: string;
  productId: string;
  quantity: number;
  locationId: string | null;
  supplierName: string | null;
  receivedAt: string;
}

export type ReceiveInventoryResult =
  | {
      kind: "received";
      receipt: InventoryReceipt;
      /** True when this request repeated an already-recorded receipt; no stock was added. */
      replayed: boolean;
      /** Ledger balance after the receipt; null when the caller lacks inventory.read. */
      quantityOnHand: number | null;
    }
  | { kind: "variant_not_found" }
  | { kind: "location_not_found" }
  /** The receipt key was already spent on a different request. Nothing was written. */
  | { kind: "receipt_conflict" };

export interface ReceiveInventoryInput {
  receiptKey: string;
  variantId: string;
  quantity: number;
  locationId?: string | null | undefined;
  supplierName?: string | null | undefined;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * The supplier label as stored: trimmed, null when blank. Throws a public 400
 * when it is longer than the ledger accepts — never silently truncated, since a
 * cut-off name is a different name.
 */
export function normalizeSupplierName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_SUPPLIER_NAME_LENGTH) {
    throw publicError(`supplier_name must be at most ${MAX_SUPPLIER_NAME_LENGTH} characters`, 400);
  }
  return trimmed;
}

function assertReceiveQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_RECEIVE_QUANTITY) {
    throw publicError(`quantity must be a whole number between 1 and ${MAX_RECEIVE_QUANTITY}`, 400);
  }
}

function toReceipt(row: InventoryMovementRow): InventoryReceipt {
  return {
    movementId: row.id,
    receiptKey: row.reference_id ?? "",
    variantId: row.variant_id,
    productId: row.product_id,
    quantity: row.quantity_delta,
    locationId: row.location_id,
    supplierName: row.supplier_name ?? null,
    receivedAt: row.created_at,
  };
}

/** Whether a recorded receipt movement is exactly the request now being made. */
function isSameReceipt(
  row: InventoryMovementRow,
  ctx: AuthorizationContext,
  request: {
    variantId: string;
    quantity: number;
    locationId: string | null;
    supplierName: string | null;
  },
): boolean {
  return (
    row.movement_type === "restock" &&
    row.variant_id === request.variantId &&
    row.quantity_delta === request.quantity &&
    (row.location_id ?? null) === request.locationId &&
    (row.supplier_name ?? null) === request.supplierName &&
    row.created_by === ctx.userId
  );
}

async function quantityOnHandIfReadable(
  ctx: AuthorizationContext,
  variantId: string,
): Promise<number | null> {
  if (!ctx.can("inventory.read")) return null;
  const rows = await repo.getVariantStockRows(ctx.organizationId, variantId);
  return rows.reduce((sum, row) => sum + row.quantity_on_hand, 0);
}

// ── Scan resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a scanned or typed code to the product variant that will be received.
 *
 * Reuses the one scan identity router (src/server/scan/service.ts) for the
 * barcode lookup itself, including its UPC-A ⇄ EAN-13 fallbacks. Parcel and
 * order codes are recognised structurally and refused without a lookup.
 *
 * Read-only: nothing here touches the ledger.
 */
export async function resolveReceivingScan(
  ctx: AuthorizationContext,
  raw: string,
): Promise<ReceivingScanResult> {
  ctx.require("inventory.receive_stock");
  ctx.require("products.read");

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

  const productsRepo = await import("@/server/products/repository");
  const variant = await productsRepo.findVariantById(
    ctx.organizationId,
    resolution.metadata.variantId,
  );
  // Archived variants are not receivable: the barcode lookup already skips
  // them, and an APSA variant QR must not be a way around that.
  if (!variant || variant.status !== "ACTIVE") return { kind: "not_found" };

  const product = await productsRepo.findProductById(ctx.organizationId, variant.product_id);
  if (!product) return { kind: "not_found" };

  return {
    kind: "product",
    product: {
      variantId: variant.id,
      productId: product.id,
      productNameKm: product.name_km,
      productNameEn: product.name_en,
      variantName: variant.name,
      sku: variant.sku,
      barcode: variant.barcode,
      quantityOnHand: await quantityOnHandIfReadable(ctx, variant.id),
    },
  };
}

// ── Receipt ───────────────────────────────────────────────────────────────────

/**
 * Receive stock: append one `restock` movement for a positive quantity.
 *
 * Validation order:
 *   1. inventory.receive_stock — before anything is read.
 *   2. Receipt key, quantity and supplier label shape.
 *   3. A recorded receipt under this key → replay or conflict (no write).
 *   4. The variant exists in the caller's organization and is ACTIVE.
 *   5. The location (if any) exists in the caller's organization.
 *   6. Insert. A unique violation on the receipt key (a concurrent duplicate
 *      that won the race) is resolved exactly like step 3.
 */
export async function receiveInventory(
  ctx: AuthorizationContext,
  input: ReceiveInventoryInput,
): Promise<ReceiveInventoryResult> {
  ctx.require("inventory.receive_stock");

  if (typeof input.receiptKey !== "string" || !UUID_RE.test(input.receiptKey)) {
    throw publicError("receipt_key must be a UUID", 400);
  }
  assertReceiveQuantity(input.quantity);
  const supplierName = normalizeSupplierName(input.supplierName);
  const locationId = input.locationId ?? null;
  const request = {
    variantId: input.variantId,
    quantity: input.quantity,
    locationId,
    supplierName,
  };

  async function settleExisting(existing: InventoryMovementRow): Promise<ReceiveInventoryResult> {
    if (!isSameReceipt(existing, ctx, request)) return { kind: "receipt_conflict" };
    return {
      kind: "received",
      receipt: toReceipt(existing),
      replayed: true,
      quantityOnHand: await quantityOnHandIfReadable(ctx, existing.variant_id),
    };
  }

  const prior = await repo.findReceiptMovement(ctx.organizationId, input.receiptKey);
  if (prior) return settleExisting(prior);

  const variant = await repo.findVariantForOrg(ctx.organizationId, input.variantId);
  if (!variant || variant.status !== "ACTIVE") return { kind: "variant_not_found" };

  if (locationId !== null) {
    const location = await repo.findLocationForOrg(ctx.organizationId, locationId);
    if (!location) return { kind: "location_not_found" };
  }

  let movement: InventoryMovementRow;
  try {
    movement = await repo.insertMovement(ctx.organizationId, {
      product_id: variant.product_id,
      variant_id: variant.id,
      location_id: locationId,
      quantity_delta: input.quantity,
      movement_type: "restock",
      reference_type: repo.RECEIPT_REFERENCE_TYPE,
      reference_id: input.receiptKey,
      reason: null,
      supplier_name: supplierName,
      created_by: ctx.userId,
    });
  } catch (err) {
    if (repo.isDuplicateReferenceError(err)) {
      const winner = await repo.findReceiptMovement(ctx.organizationId, input.receiptKey);
      if (winner) return settleExisting(winner);
    }
    throw err;
  }

  return {
    kind: "received",
    receipt: toReceipt(movement),
    replayed: false,
    quantityOnHand: await quantityOnHandIfReadable(ctx, movement.variant_id),
  };
}
