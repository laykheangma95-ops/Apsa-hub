/**
 * Inventory service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Validate that referenced product/variant/location belong to the caller's org.
 *   4. Delegate raw DB operations to the repository.
 *   5. Map DB rows to domain API shapes.
 *
 * ARCHITECTURE INVARIANT: inventory_movements is append-only. There is no
 * updateStock() or setStock() function anywhere in this file — every stock
 * change is recordMovement() creating a new immutable row. Current stock is
 * always derived by summing the ledger (see getVariantStock / repository's
 * inventory_stock view), never read from or written to a mutable counter.
 *
 * Permission mapping by movement_type (PERMISSIONS_MATRIX.md §13):
 *   initial, restock  -> inventory.receive_stock
 *   manual_adjustment -> inventory.adjust (mandatory audit — see audit.ts)
 *   sale, return      -> inventory.adjust, and that is now the CORRECT answer
 *                        rather than a placeholder. Order-driven sales and
 *                        releases do not come through this function at all:
 *                        transition_order_status_v1 (migration 026) writes them
 *                        inside the order's own transaction, authorized by
 *                        orders.confirm / orders.cancel. So anything reaching
 *                        recordMovement() with 'sale' or 'return' is a HUMAN
 *                        editing the ledger by hand, outside an order — which
 *                        is exactly the authority inventory.adjust names.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { auditLogRequired } from "@/server/auth/audit";
import * as repo from "./repository";
import type {
  InventoryMovementRow,
  InventoryStockRow,
  CreateMovementInput,
  ListMovementsOptions,
  ListOrgStockOptions,
  InventoryMovementTypeDb,
} from "./types";
import { INVENTORY_MOVEMENT_TYPES } from "./types";

// ── Exported domain types ─────────────────────────────────────────────────────

export interface InventoryMovementDetail {
  id: string;
  organizationId: string;
  productId: string;
  variantId: string;
  locationId: string | null;
  quantityDelta: number;
  movementType: InventoryMovementTypeDb;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface VariantStockDetail {
  variantId: string;
  productId: string;
  /** Total on-hand quantity across all locations. */
  quantityOnHand: number;
  /** Per-location breakdown. Empty when the variant has no locations recorded yet. */
  byLocation: Array<{
    locationId: string | null;
    quantityOnHand: number;
    lastMovementAt: string | null;
  }>;
}

/**
 * One active variant's on-hand quantity, for the org-wide Inventory workspace.
 *
 * Carries variant IDENTITY ONLY — no name, no SKU, no price, no cost. Those
 * belong to the Product domain and are read (and authorized) there. This shape
 * exists so the Inventory domain stays the single authority on quantity while
 * the Product domain stays the single authority on what a variant IS.
 */
export interface OrgStockEntry {
  variantId: string;
  productId: string;
  /**
   * Summed across every location, exactly as the ledger says — including a
   * negative total. 0 here means "the ledger nets to zero for this variant",
   * which is also the honest answer for a variant with no movements at all.
   */
  quantityOnHand: number;
  lastMovementAt: string | null;
}

export interface OrgStockList {
  entries: OrgStockEntry[];
  /**
   * True when this organization has more active variants (or more per-location
   * ledger rows) than this read covered. Never silently dropped: a caller that
   * renders a quantity for a variant outside `entries` would be inventing it.
   */
  truncated: boolean;
}

export interface InventoryLocationSummary {
  id: string;
  name: string;
  status: string;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapMovement(row: InventoryMovementRow): InventoryMovementDetail {
  return {
    id: row.id,
    organizationId: row.organization_id,
    productId: row.product_id,
    variantId: row.variant_id,
    locationId: row.location_id,
    quantityDelta: row.quantity_delta,
    movementType: row.movement_type,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapStock(
  variantId: string,
  productId: string,
  rows: InventoryStockRow[],
): VariantStockDetail {
  return {
    variantId,
    productId,
    quantityOnHand: rows.reduce((sum, r) => sum + r.quantity_on_hand, 0),
    byLocation: rows.map((r) => ({
      locationId: r.location_id,
      quantityOnHand: r.quantity_on_hand,
      lastMovementAt: r.last_movement_at,
    })),
  };
}

// ── Permission mapping ────────────────────────────────────────────────────────

function requiredPermissionFor(movementType: InventoryMovementTypeDb): string {
  switch (movementType) {
    case "initial":
    case "restock":
      return "inventory.receive_stock";
    case "manual_adjustment":
      return "inventory.adjust";
    case "sale":
    case "return":
      return "inventory.adjust";
  }
}

// ── Service functions ─────────────────────────────────────────────────────────

export interface RecordMovementInput {
  productId: string;
  variantId: string;
  locationId?: string | null | undefined;
  quantityDelta: number;
  movementType: InventoryMovementTypeDb;
  /**
   * reference_type + reference_id identify the SOURCE RECORD this movement came
   * from (e.g. "order" + the order's uuid) — not the event. movementType is the
   * event. Idempotency is keyed on (variant, movementType, reference), so a
   * replayed 'sale' for order X is rejected while a later 'return' for order X
   * is accepted. See migration 021's uniq_inventory_movements_reference.
   */
  referenceType?: string | null | undefined;
  referenceId?: string | null | undefined;
  reason?: string | null | undefined;
}

/**
 * Record a single inventory movement. This is the ONLY way stock ever changes.
 *
 * Validation order:
 *   1. Movement type must be a known V1 type.
 *   2. Quantity delta must be a non-zero integer.
 *   3. Caller must hold the permission required for this movement_type.
 *   4. The referenced variant (and product, and location if given) must belong
 *      to the caller's organization — guessed cross-org IDs are rejected here,
 *      before ever reaching the DB trigger that would also reject them.
 *   5. manual_adjustment requires a reason and is mandatorily audited
 *      (auditLogRequired — the operation is blocked if the audit write fails).
 */
export async function recordMovement(
  ctx: AuthorizationContext,
  input: RecordMovementInput,
): Promise<InventoryMovementDetail> {
  if (!INVENTORY_MOVEMENT_TYPES.includes(input.movementType)) {
    throw Object.assign(new Error(`Invalid movement_type: ${String(input.movementType)}`), {
      statusCode: 400,
    });
  }

  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    throw Object.assign(new Error("quantity_delta must be a non-zero integer"), {
      statusCode: 400,
    });
  }

  ctx.require(requiredPermissionFor(input.movementType));

  if (input.movementType === "manual_adjustment" && !input.reason?.trim()) {
    throw Object.assign(new Error("reason is required for manual_adjustment movements"), {
      statusCode: 400,
    });
  }

  // Tenant ownership: reject guessed/cross-org product, variant, location IDs
  // before touching the ledger. This is defense-in-depth ahead of the DB trigger.
  const variant = await repo.findVariantForOrg(ctx.organizationId, input.variantId);
  if (!variant) {
    throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
  }
  if (variant.product_id !== input.productId) {
    throw Object.assign(new Error("variant_id does not belong to the given product_id"), {
      statusCode: 400,
    });
  }

  if (input.locationId != null) {
    const location = await repo.findLocationForOrg(ctx.organizationId, input.locationId);
    if (!location) {
      throw Object.assign(new Error("Location not found"), { statusCode: 404 });
    }
  }

  const movementInput: CreateMovementInput = {
    product_id: input.productId,
    variant_id: input.variantId,
    location_id: input.locationId ?? null,
    quantity_delta: input.quantityDelta,
    movement_type: input.movementType,
    reference_type: input.referenceType ?? null,
    reference_id: input.referenceId ?? null,
    reason: input.reason ?? null,
    created_by: ctx.userId,
  };

  // manual_adjustment is a mandatory-audit action (audit.ts MANDATORY_AUDIT_ACTIONS).
  // Audit is written BEFORE the mutation: if the audit record cannot be persisted,
  // the adjustment must not happen — never allow an unaudited high-risk stock change.
  if (input.movementType === "manual_adjustment") {
    // input.reason is guaranteed non-empty here (validated above).
    await auditLogRequired(ctx, {
      action: "inventory.adjust",
      resourceType: "inventory_movements",
      resourceId: input.variantId,
      afterJson: {
        product_id: input.productId,
        variant_id: input.variantId,
        location_id: input.locationId ?? null,
        quantity_delta: input.quantityDelta,
      },
      reason: input.reason!.trim(),
    });
  }

  let movement: InventoryMovementRow;
  try {
    movement = await repo.insertMovement(ctx.organizationId, movementInput);
  } catch (err) {
    if (repo.isDuplicateReferenceError(err)) {
      throw Object.assign(
        new Error("A movement for this reference already exists (idempotent duplicate)"),
        { statusCode: 409 },
      );
    }
    throw err;
  }

  return mapMovement(movement);
}

/** Current stock for a single variant, aggregated across all locations. */
export async function getVariantStock(
  ctx: AuthorizationContext,
  variantId: string,
): Promise<VariantStockDetail> {
  ctx.require("inventory.read");

  const variant = await repo.findVariantForOrg(ctx.organizationId, variantId);
  if (!variant) {
    throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
  }

  const rows = await repo.getVariantStockRows(ctx.organizationId, variantId);
  return mapStock(variantId, variant.product_id, rows);
}

/** Movement history, newest first, optionally filtered by variant/product/location/type. */
export async function listMovementHistory(
  ctx: AuthorizationContext,
  opts: ListMovementsOptions = {},
): Promise<InventoryMovementDetail[]> {
  ctx.require("inventory.view_movements");

  const rows = await repo.listMovements(ctx.organizationId, opts);
  return rows.map(mapMovement);
}

// ── Org-wide stock list (read-side only) ──────────────────────────────────────

/** Default active-variant coverage for one org-wide stock read. */
export const INVENTORY_STOCK_DEFAULT_LIMIT = 500;
/** Hard ceiling a caller may ask for. Above this the read reports truncation. */
export const INVENTORY_STOCK_MAX_LIMIT = 1000;

/**
 * On-hand quantity for every ACTIVE variant in the caller's organization.
 *
 * This is the read the Inventory workspace needs and the only thing added to
 * this domain for it. It does NOT give the Product domain a stock field, and it
 * does not give the Inventory domain product names: it answers exactly one
 * question — "how much of each active variant does the ledger say we hold?"
 *
 * Two queries (plus one per extra 100-variant chunk), never one per variant:
 *   1. which variants are active in this organization (identity only);
 *   2. their ledger balances from the inventory_stock view.
 *
 * A variant with NO movement history is returned with quantityOnHand 0. That is
 * a deliberate, checked answer rather than an omission: "no movements recorded"
 * and "nothing on hand" are the same operational fact, and leaving the variant
 * out would make the workspace look like it does not exist.
 *
 * Negative balances are returned exactly as the ledger computed them. Clamping
 * a negative on-hand figure to zero would hide a real operational problem
 * (oversold stock) behind a number that looks fine.
 *
 * organizationId comes from the AuthorizationContext only — never from input.
 */
export async function listOrganizationStock(
  ctx: AuthorizationContext,
  opts: ListOrgStockOptions = {},
): Promise<OrgStockList> {
  ctx.require("inventory.read");

  const requested = opts.limit ?? INVENTORY_STOCK_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.trunc(requested)), INVENTORY_STOCK_MAX_LIMIT);

  // limit + 1: one row past the page tells us there is more, without a count().
  const variants = await repo.listActiveVariantsForOrg(ctx.organizationId, limit + 1);
  const overLimit = variants.length > limit;
  const page = overLimit ? variants.slice(0, limit) : variants;

  if (page.length === 0) return { entries: [], truncated: false };

  const variantIds = page.map((variant) => variant.id);
  const { rows, truncated: stockTruncated } = await repo.listStockRowsForVariants(
    ctx.organizationId,
    variantIds,
  );

  // Sum the per-location rows down to one total per variant. The view already
  // nets each (variant, location) pair; this nets across locations.
  const totals = new Map<string, { quantity: number; lastMovementAt: string | null }>();
  for (const row of rows) {
    const current = totals.get(row.variant_id) ?? { quantity: 0, lastMovementAt: null };
    current.quantity += row.quantity_on_hand;
    if (
      row.last_movement_at !== null &&
      (current.lastMovementAt === null || row.last_movement_at > current.lastMovementAt)
    ) {
      current.lastMovementAt = row.last_movement_at;
    }
    totals.set(row.variant_id, current);
  }

  return {
    entries: page.map((variant) => {
      const total = totals.get(variant.id);
      return {
        variantId: variant.id,
        productId: variant.product_id,
        // No ledger rows at all -> 0, stated rather than implied.
        quantityOnHand: total?.quantity ?? 0,
        lastMovementAt: total?.lastMovementAt ?? null,
      };
    }),
    truncated: overLimit || stockTruncated,
  };
}

/**
 * Locations in the caller's organization — id, name, status.
 *
 * Read-only and deliberately narrow: Inventory needs a human-readable label for
 * a per-location stock row and a destination when receiving stock. There is no
 * Location CRUD here, no migration behind it, and nothing beyond those three
 * fields is exposed. If a dedicated Locations domain is built later, this
 * helper is the piece it replaces.
 *
 * Gated on inventory.read — the same key that lets a member see stock at all.
 */
export async function listInventoryLocations(
  ctx: AuthorizationContext,
): Promise<InventoryLocationSummary[]> {
  ctx.require("inventory.read");

  const rows = await repo.listLocationsForOrg(ctx.organizationId);
  return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
}
