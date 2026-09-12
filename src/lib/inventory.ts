/**
 * Inventory — the browser-side boundary for the merchant stock workspace.
 *
 * Every function here is a thin call into an existing server function in
 * `@/api/inventory`, which resolves the session and the organization from the
 * DB and re-authorizes the action (src/server/inventory/service.ts). Nothing in
 * this module decides access, and nothing in it talks to Supabase: the server
 * functions are imported dynamically inside the call bodies so no server-only
 * module can be pulled into the browser bundle through this file.
 *
 * There is deliberately NO mock/demo fallback here. Stock is a production
 * surface: a failure must surface as a failure, never as an invented quantity.
 * A merchant who acts on a fabricated stock figure oversells real goods.
 *
 * THE LEDGER IS THE ONLY AUTHORITY. There is no setStock, no quantity write,
 * and no browser-side stock computation in this file. `recordInventoryMovement`
 * is the single mutation and it appends a movement — the server derives every
 * balance from the ledger (the `inventory_stock` view over
 * `inventory_movements`). Quantities that arrive here are already computed and
 * are only ever rendered, never recomputed or corrected.
 *
 * Negative quantities are real. Nothing in this file clamps, floors, or
 * absolute-values a quantity: -3 on hand means three units were sold that the
 * ledger says were never received, and hiding that behind a 0 hides the
 * problem rather than the number.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { CatalogProduct } from "@/lib/catalog";

// ── Shapes returned by the server (src/server/inventory/service.ts) ──────────

/** The V1 movement taxonomy — migration 021's enum, exactly. */
export const INVENTORY_MOVEMENT_TYPES = [
  "initial",
  "sale",
  "return",
  "manual_adjustment",
  "restock",
] as const;

export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

/**
 * Movement types a human may record from this UI, and the permission the
 * server requires for each (src/server/inventory/service.ts#requiredPermissionFor).
 *
 * 'sale' and 'return' are absent on purpose: order-driven stock movement is
 * written inside the order's own transaction (migration 026), not from here.
 */
export const RECEIVE_MOVEMENT_TYPES = ["restock", "initial"] as const;
export type ReceiveMovementType = (typeof RECEIVE_MOVEMENT_TYPES)[number];

export interface InventoryMovement {
  id: string;
  organizationId: string;
  productId: string;
  variantId: string;
  locationId: string | null;
  quantityDelta: number;
  movementType: InventoryMovementType;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface VariantStock {
  variantId: string;
  productId: string;
  quantityOnHand: number;
  byLocation: Array<{
    locationId: string | null;
    quantityOnHand: number;
    lastMovementAt: string | null;
  }>;
}

export interface OrgStockEntry {
  variantId: string;
  productId: string;
  quantityOnHand: number;
  lastMovementAt: string | null;
}

export interface OrgStockList {
  entries: OrgStockEntry[];
  /** The server covered fewer variants than the organization holds. */
  truncated: boolean;
}

export interface InventoryLocation {
  id: string;
  name: string;
  status: string;
}

// ── Identity ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for the id shape the inventory server functions accept.
 *
 * A screen uses this to show an honest "not found" for a hand-typed or stale
 * URL instead of firing a request the Zod validator would reject anyway. It is
 * not a security check: an id that passes here is still only ever resolved
 * inside the caller's own organization, server-side. A variant id belonging to
 * another organization looks exactly like this one and comes back not-found.
 */
export function isInventoryId(id: string): boolean {
  return UUID_RE.test(id);
}

// ── React Query cache identity ───────────────────────────────────────────────
//
// Partitioned by BOTH the authenticated user AND the organization the server
// resolved for them — never by organization alone. Two members of the same
// organization hold different inventory permissions: inventory.view_movements
// is Owner/Manager only while inventory.read reaches Cashier and Sales
// (migration 022). An organization-only key would let a Manager's cached
// movement history — who adjusted what, why, and when — be read back for a
// Cashier who signs in after them in the same browser tab.
//
// Both values must come from the server-derived route context (/app's
// beforeLoad guard, via Route.useRouteContext()) — never from the capability
// snapshot (which is presentation data, fetched separately, and not the
// identity boundary) and never from client input.

export const INVENTORY_QUERY_ROOT = "inventory";

/** Active variants covered by one stock-list read. The server clamps to 1000. */
export const INVENTORY_LIST_LIMIT = 500;

/** One page of movement history. The server caps a single request at 500. */
export const MOVEMENT_PAGE_SIZE = 20;

/** Key segment for movement history, so it can be purged on its own. */
const MOVEMENTS_SEGMENT = "movements";

export const inventoryKeys = {
  stockList: (userId: string, organizationId: string) =>
    [INVENTORY_QUERY_ROOT, userId, organizationId, "stock-list"] as const,
  variantStock: (userId: string, organizationId: string, variantId: string) =>
    [INVENTORY_QUERY_ROOT, userId, organizationId, "variant-stock", variantId] as const,
  movements: (userId: string, organizationId: string, variantId: string) =>
    [INVENTORY_QUERY_ROOT, userId, organizationId, MOVEMENTS_SEGMENT, variantId] as const,
  locations: (userId: string, organizationId: string) =>
    [INVENTORY_QUERY_ROOT, userId, organizationId, "locations"] as const,
};

/** Every inventory cache entry lives under this prefix, in any tab. */
const INVENTORY_QUERY_PREFIX = [INVENTORY_QUERY_ROOT] as const;

/**
 * The principal (userId + organizationId) whose inventory data this tab's cache
 * currently holds. Keyed by QueryClient, not component state, so it survives
 * the unmount/remount cycle of a client-side sign-out then sign-in — the case
 * where one tab serves two different members of the same organization.
 */
const LAST_INVENTORY_PRINCIPAL = new WeakMap<QueryClient, string>();

/**
 * Drop every inventory cache entry, for every principal, in this tab.
 *
 * `removeQueries` (not `invalidateQueries`) is deliberate: invalidation leaves
 * the previous principal's payload — movement history included — readable in
 * the cache until a refetch resolves, which is exactly the window a departed
 * member's data must not survive into. Mirrors clearCatalogQueries in
 * src/lib/catalog.ts, which this module deliberately parallels.
 *
 * Never throws. Nothing here may block navigation or sign-out.
 */
export function clearInventoryQueries(queryClient: QueryClient): void {
  try {
    queryClient.removeQueries({ queryKey: INVENTORY_QUERY_PREFIX });
  } catch {
    // A cache that cannot be pruned must never keep stale data readable by
    // pretending the clear succeeded silently — but it also must never throw
    // and block whatever the caller is doing (navigating, signing out).
  } finally {
    try {
      LAST_INVENTORY_PRINCIPAL.delete(queryClient);
    } catch {
      // Ignore — nothing here may block the caller.
    }
  }
}

/**
 * Drop cached movement history only, for every principal, in this tab.
 *
 * Movement history is the one inventory payload whose mere display is a
 * disclosure: it names who adjusted stock, by how much, and why. inventory.read
 * and inventory.view_movements are separate grants, so a member can legitimately
 * keep seeing quantities after losing the right to see the history behind them.
 *
 * When that happens mid-session — a revocation, or a capability snapshot whose
 * latest refresh failed — the quantities may stay cached but the history must
 * not: `removeQueries` evicts it immediately rather than leaving it readable
 * until something happens to refetch. Quantities are left alone so losing this
 * one grant does not blank the whole workspace.
 */
export function clearInventoryMovementQueries(queryClient: QueryClient): void {
  try {
    queryClient.removeQueries({
      predicate: (query) => {
        const key = query.queryKey;
        return (
          Array.isArray(key) && key[0] === INVENTORY_QUERY_ROOT && key[3] === MOVEMENTS_SEGMENT
        );
      },
    });
  } catch {
    // Never throw: this runs during render and must not break the screen.
  }
}

/**
 * Drop the inventory cache whenever the authenticated principal differs from
 * the one it was filled for, and leave it alone otherwise so ordinary caching
 * still works within one member's session.
 *
 * This is independent, defense-in-depth isolation: it does not replace
 * queryClient.clear() on an explicit sign-out (src/routes/app.settings.tsx),
 * it covers the same case Home's enforceHomeCachePrincipal and the catalog's
 * enforceCatalogCachePrincipal cover — the global clear failing partway, or a
 * future client-side account switch that does not go through Settings.
 *
 * `userId` and `organizationId` must come from the server-derived route
 * context, never from the capability snapshot or client input — they are a
 * cache partition only, never an authorization claim.
 */
export function enforceInventoryCachePrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  // "/" cannot appear in a UUID, so no two principals can produce one string.
  const principal = `${userId}/${organizationId}`;
  if (LAST_INVENTORY_PRINCIPAL.get(queryClient) === principal) return;
  clearInventoryQueries(queryClient);
  LAST_INVENTORY_PRINCIPAL.set(queryClient, principal);
}

/**
 * Evict cached movement history the moment this member may no longer see it.
 *
 * Called on every render of a screen that shows history, with the CURRENT
 * capability answer. A no-op while the grant holds; an immediate eviction the
 * first render after it stops holding, without waiting for a refetch, an
 * invalidation, or a navigation.
 *
 * `canViewMovements` must already be fail-closed (false in every capability
 * state other than a confirmed "ready"), which is what
 * `capabilities.canSensitive("inventory.view_movements")` gives every caller.
 */
export function enforceMovementHistoryCapability(
  queryClient: QueryClient,
  canViewMovements: boolean,
): void {
  if (canViewMovements) return;
  clearInventoryMovementQueries(queryClient);
}

// ── Stock presentation (pure) ────────────────────────────────────────────────

/**
 * How a quantity reads operationally. Three states, not a threshold model:
 * there is no configurable low-stock level in this phase and none is implied
 * here — `negative` and `zero` are facts about the ledger, not forecasts.
 */
export type StockState = "negative" | "zero" | "positive";

export function stockState(quantityOnHand: number): StockState {
  if (quantityOnHand < 0) return "negative";
  if (quantityOnHand === 0) return "zero";
  return "positive";
}

/**
 * The exact quantity, as text, sign included.
 *
 * Never clamped and never absolute-valued: -3 renders as "-3". A negative
 * on-hand figure is valid operational truth (more sold than the ledger says was
 * received) and the merchant needs the real number to fix it.
 */
export function formatQuantity(quantityOnHand: number): string {
  return String(quantityOnHand);
}

/** i18n key for a movement type, in merchant language — never the enum value. */
export function movementTypeLabelKey(movementType: InventoryMovementType): string {
  return `movementHistory.type.${movementType}`;
}

/** Positive deltas are shown with an explicit "+" so direction is never guessed. */
export function formatMovementDelta(quantityDelta: number): string {
  return quantityDelta > 0 ? `+${quantityDelta}` : String(quantityDelta);
}

// ── Product × Inventory join (pure) ──────────────────────────────────────────

/**
 * One line of the Inventory workspace.
 *
 * Identity (names, SKU, statuses) comes from the Product domain's own read;
 * `quantityOnHand` comes from the Inventory domain and nowhere else. The
 * Product domain's `stock` field is always null by design and is never read
 * here — if these two ever disagreed, the ledger is right.
 */
export interface InventoryRow {
  variantId: string;
  productId: string;
  productNameKm: string;
  productNameEn: string | null;
  variantName: string;
  sku: string | null;
  productStatus: string;
  variantStatus: string;
  /**
   * null ONLY when the inventory read was truncated and did not cover this
   * variant. Never a stand-in for zero: a variant the ledger has no movements
   * for is a real 0, and showing "unknown" for it would be as wrong as showing
   * 0 for a quantity that was never read.
   */
  quantityOnHand: number | null;
  lastMovementAt: string | null;
}

/**
 * Join the catalog's product/variant identity to the ledger's quantities.
 *
 * Both inputs are already tenant-scoped server-side and cached under the same
 * principal-partitioned key space, so this is a presentation join and nothing
 * more. It carries no cost: `CatalogVariant.cost` is deliberately not read
 * here, so a member with products.view_cost cannot leak a cost onto a stock
 * screen that has no cost requirement.
 *
 * A variant absent from `stock.entries` is 0 when the read covered the whole
 * organization, and unknown (null) only when the server reported truncation.
 */
export function buildInventoryRows(
  products: readonly CatalogProduct[],
  stock: OrgStockList | undefined,
): InventoryRow[] {
  const byVariant = new Map<string, OrgStockEntry>();
  for (const entry of stock?.entries ?? []) byVariant.set(entry.variantId, entry);
  const truncated = stock?.truncated ?? false;

  const rows: InventoryRow[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      const entry = byVariant.get(variant.id);
      rows.push({
        variantId: variant.id,
        productId: product.id,
        productNameKm: product.nameKm,
        productNameEn: product.nameEn,
        variantName: variant.name,
        sku: variant.sku,
        productStatus: product.status,
        variantStatus: variant.status,
        quantityOnHand: entry ? entry.quantityOnHand : truncated ? null : 0,
        lastMovementAt: entry?.lastMovementAt ?? null,
      });
    }
  }
  return rows;
}

/**
 * Search the inventory rows already loaded into this page — nothing more.
 *
 * This is NOT server search. It cannot see a variant outside the page the
 * server returned, and the screen says so next to the field rather than
 * implying the whole catalogue was searched.
 */
export function searchLoadedInventory(
  rows: readonly InventoryRow[],
  query: string,
): InventoryRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];

  return rows.filter(
    (row) =>
      row.productNameKm.toLowerCase().includes(needle) ||
      (row.productNameEn ?? "").toLowerCase().includes(needle) ||
      row.variantName.toLowerCase().includes(needle) ||
      (row.sku ?? "").toLowerCase().includes(needle),
  );
}

/** The location's own name, or the honest label for a movement with no location. */
export function locationName(
  locationId: string | null,
  locations: readonly InventoryLocation[],
): string | null {
  if (locationId === null) return null;
  return locations.find((location) => location.id === locationId)?.name ?? null;
}

// ── Server error classification ──────────────────────────────────────────────

export type InventoryErrorKind =
  | "denied"
  | "not_found"
  | "location_not_found"
  | "reason_required"
  | "invalid_quantity"
  | "duplicate"
  | "audit_blocked"
  | "generic";

/**
 * Classify a thrown inventory server error into a copy key.
 *
 * Best-effort presentation only. Authorization, tenant scoping, the mandatory
 * audit and the idempotency 409 are all decided server-side; misreading one
 * here picks the wrong sentence, it never lets an action through. In particular
 * a "denied" classification is a message, not a decision — the action already
 * failed on the server before this ran.
 */
export function classifyInventoryError(err: unknown): InventoryErrorKind {
  const message = err instanceof Error ? err.message : "";

  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated" ||
    message === "Owner access required"
  ) {
    return "denied";
  }
  // The audit branch must be read BEFORE the generic branches: a blocked
  // adjustment is not a failed adjustment the merchant should simply retry,
  // it is a refusal to act without an audit trail, and it says so.
  if (message.includes("Audit record could not be persisted")) return "audit_blocked";
  if (message === "Location not found") return "location_not_found";
  if (/^(Variant|Product) not found$/.test(message)) return "not_found";
  if (message.includes("reason is required")) return "reason_required";
  if (
    message.includes("quantity_delta must") ||
    message.includes("must not be zero") ||
    message.includes("Invalid movement_type")
  ) {
    return "invalid_quantity";
  }
  if (message.includes("idempotent duplicate")) return "duplicate";
  return "generic";
}

/** i18n key for a classified inventory failure. Every kind has Khmer and English copy. */
export function inventoryErrorKey(kind: InventoryErrorKind): string {
  return `inventory.error.${kind}`;
}

// ── Server function wrappers ─────────────────────────────────────────────────
//
// Each one dynamically imports the API module so the server-function bundle is
// pulled in only by the screens that use it, and every call keeps its
// organization scope on the server where it belongs.

export async function listOrganizationStock(limit = INVENTORY_LIST_LIMIT): Promise<OrgStockList> {
  const { listOrganizationStockFn } = await import("@/api/inventory");
  const result = await listOrganizationStockFn({ data: { limit } });
  return result as unknown as OrgStockList;
}

export async function getVariantStock(variantId: string): Promise<VariantStock> {
  const { getVariantStockFn } = await import("@/api/inventory");
  const result = await getVariantStockFn({ data: { variantId } });
  return result as unknown as VariantStock;
}

export interface ListMovementsInput {
  variantId: string;
  limit: number;
  offset: number;
}

/**
 * One page of movement history, newest first.
 *
 * Paginated on the SERVER (limit/offset reach `listMovements`' own `.range()`),
 * not by slicing a big client-side array: the ledger grows without bound and
 * pulling all of it to filter in the browser would be both slow and a larger
 * disclosure than the screen needs.
 */
export async function listMovementHistory(input: ListMovementsInput): Promise<InventoryMovement[]> {
  const { listMovementHistoryFn } = await import("@/api/inventory");
  const result = await listMovementHistoryFn({
    data: { variantId: input.variantId, limit: input.limit, offset: input.offset },
  });
  return result as unknown as InventoryMovement[];
}

export async function listInventoryLocations(): Promise<InventoryLocation[]> {
  const { listInventoryLocationsFn } = await import("@/api/inventory");
  const result = await listInventoryLocationsFn();
  return result as unknown as InventoryLocation[];
}

export interface RecordMovementInput {
  productId: string;
  variantId: string;
  locationId: string | null;
  /** Signed. The server rejects 0 and any non-integer. */
  quantityDelta: number;
  movementType: InventoryMovementType;
  reason: string | null;
}

/**
 * Append one movement to the ledger. The ONLY stock mutation this UI performs.
 *
 * There is no sibling function that writes a quantity: receiving stock and
 * adjusting stock both come through here, and the server derives every balance
 * from the resulting ledger row. The permission the server demands depends on
 * the movement type (receive_stock for initial/restock, adjust for
 * manual_adjustment), and a manual_adjustment is refused outright unless its
 * mandatory audit record was persisted first.
 */
export async function recordInventoryMovement(
  input: RecordMovementInput,
): Promise<InventoryMovement> {
  const { recordMovementFn } = await import("@/api/inventory");
  const result = await recordMovementFn({
    data: {
      productId: input.productId,
      variantId: input.variantId,
      locationId: input.locationId,
      quantityDelta: input.quantityDelta,
      movementType: input.movementType,
      reason: input.reason,
    },
  });
  return result as unknown as InventoryMovement;
}

// ── Quantity parsing (integers only) ─────────────────────────────────────────

/**
 * Parse a typed whole-unit quantity, or null when it is not one.
 *
 * Stock is counted in whole units: there is no fractional quantity anywhere in
 * the ledger (migration 021's quantity_delta is INTEGER) and no floating-point
 * arithmetic is performed on one here. `allowNegative` exists because a manual
 * adjustment is a signed delta while a receipt is not.
 */
export function parseQuantity(input: string, allowNegative: boolean): number | null {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return null;

  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(text)) return null;

  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : null;
}

// ── Form submit rules (pure) ─────────────────────────────────────────────────

/**
 * May a receipt be submitted?
 *
 * A whole number above zero. Receiving a negative quantity would be a
 * correction, and a correction is an adjustment — with a reason attached.
 */
export function canSubmitReceipt(quantityText: string): boolean {
  const quantity = parseQuantity(quantityText, false);
  return quantity !== null && quantity > 0;
}

/**
 * May a manual adjustment be submitted?
 *
 * A non-zero signed delta AND a non-blank reason. The reason is not a
 * nicety: recordMovement() refuses a manual_adjustment without one, and writes
 * a mandatory audit record (auditLogRequired) before it inserts anything — if
 * that audit write fails, the adjustment is blocked. This function only stops
 * the merchant discovering that after a round trip; it is not the check that
 * matters, and nothing in the UI can bypass the server's own.
 *
 * Whitespace is not a reason: "   " is blank.
 */
export function canSubmitAdjustment(deltaText: string, reason: string): boolean {
  const delta = parseQuantity(deltaText, true);
  return delta !== null && delta !== 0 && reason.trim() !== "";
}
