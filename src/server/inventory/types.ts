/**
 * Raw DB row types for the Inventory domain.
 * These match the columns in migration 021 exactly.
 * Never used in UI — mapped to domain types by the service layer.
 */

export type InventoryMovementTypeDb =
  | "initial"
  | "sale"
  | "return"
  | "manual_adjustment"
  | "restock";

export const INVENTORY_MOVEMENT_TYPES: readonly InventoryMovementTypeDb[] = [
  "initial",
  "sale",
  "return",
  "manual_adjustment",
  "restock",
];

export interface InventoryMovementRow {
  id: string;
  organization_id: string;
  product_id: string;
  variant_id: string;
  location_id: string | null;
  quantity_delta: number;
  movement_type: InventoryMovementTypeDb;
  reference_type: string | null;
  reference_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/** Row shape of the `inventory_stock` derived view (migration 021). */
export interface InventoryStockRow {
  organization_id: string;
  product_id: string;
  variant_id: string;
  location_id: string | null;
  quantity_on_hand: number;
  last_movement_at: string | null;
}

/** Input for recording a movement (server-validated, org from auth context). */
export interface CreateMovementInput {
  product_id: string;
  variant_id: string;
  location_id?: string | null | undefined;
  quantity_delta: number;
  movement_type: InventoryMovementTypeDb;
  reference_type?: string | null | undefined;
  reference_id?: string | null | undefined;
  reason?: string | null | undefined;
  created_by?: string | null | undefined;
}

/** Filter options for listing movement history. */
export interface ListMovementsOptions {
  variant_id?: string | undefined;
  product_id?: string | undefined;
  location_id?: string | null | undefined;
  movement_type?: InventoryMovementTypeDb | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
