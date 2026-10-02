/**
 * Receiving Inventory — the browser-side boundary for /app/inventory/receive.
 *
 * Thin wrappers over src/api/receiving.ts plus pure presentation helpers.
 * Nothing here decides access or computes stock: the server resolves the
 * scanned product inside the caller's organization, appends the ledger
 * movement, and reports the balance it derived from the ledger.
 *
 * Duplicate safety on the client side is one rule: a receipt keeps ONE
 * receipt key across every retry of the same request (see
 * createIdempotencyKeyHolder), and gets a new key once it was recorded or the
 * request changed. The server is still the authority — it replays a repeated
 * key and refuses a reused one — so a client bug here can never add stock
 * twice, only produce a conflict message.
 *
 * Safe to bundle for the browser: no Supabase, no server imports, no secrets.
 */
import { parseQuantity } from "@/lib/inventory";

// ── Shapes returned by the server (src/server/inventory/receiving.ts) ────────

export interface ReceivingProduct {
  variantId: string;
  productId: string;
  productNameKm: string;
  productNameEn: string | null;
  variantName: string;
  sku: string | null;
  barcode: string | null;
  quantityOnHand: number | null;
}

export type ReceivingScanResult =
  | { kind: "product"; product: ReceivingProduct }
  | { kind: "not_found" }
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
      replayed: boolean;
      quantityOnHand: number | null;
    }
  | { kind: "variant_not_found" }
  | { kind: "location_not_found" }
  | { kind: "receipt_conflict" };

export interface ReceiveInventoryRequest {
  variantId: string;
  quantity: number;
  locationId: string | null;
  supplierName: string | null;
}

// ── Limits (mirrors src/server/inventory/receiving.ts; the server re-checks) ──

export const MAX_RECEIVE_QUANTITY = 100_000;
export const MAX_SUPPLIER_NAME_LENGTH = 120;

// ── Pure rules ───────────────────────────────────────────────────────────────

/** The quantity to send, or null when the typed text is not a receivable quantity. */
export function parseReceiveQuantity(text: string): number | null {
  const quantity = parseQuantity(text, false);
  if (quantity === null || quantity <= 0 || quantity > MAX_RECEIVE_QUANTITY) return null;
  return quantity;
}

/** The supplier label as the server will store it: trimmed, null when blank. */
export function normalizeSupplierInput(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export function isSupplierInputValid(text: string): boolean {
  return text.trim().length <= MAX_SUPPLIER_NAME_LENGTH;
}

/**
 * The request a receipt key is held for. Any change to what would be recorded
 * changes this string, so a changed request never reuses an old key.
 */
export function receiptRequestFingerprint(request: ReceiveInventoryRequest): string {
  return JSON.stringify([
    request.variantId,
    request.quantity,
    request.locationId,
    request.supplierName,
  ]);
}

/** i18n key for a scan outcome the merchant must act on (null for a product). */
export function receivingScanMessageKey(result: ReceivingScanResult): string | null {
  switch (result.kind) {
    case "product":
      return null;
    case "not_found":
      return "receiving.scan.notFound";
    case "not_a_product":
      return "receiving.scan.notAProduct";
  }
}

/** i18n key for a non-success receive outcome (null when received). */
export function receiveResultMessageKey(result: ReceiveInventoryResult): string | null {
  switch (result.kind) {
    case "received":
      return null;
    case "variant_not_found":
      return "receiving.error.variantNotFound";
    case "location_not_found":
      return "receiving.error.locationNotFound";
    case "receipt_conflict":
      return "receiving.error.receiptConflict";
  }
}

export type ReceivingErrorKind = "denied" | "invalid" | "generic";

/**
 * Classify a thrown server error. Presentation only — the server has already
 * refused the action before this runs.
 */
export function classifyReceivingError(err: unknown): ReceivingErrorKind {
  const message = err instanceof Error ? err.message : "";
  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated"
  ) {
    return "denied";
  }
  if (
    message.includes("quantity must") ||
    message.includes("supplier_name must") ||
    message.includes("receipt_key must")
  ) {
    return "invalid";
  }
  return "generic";
}

export function receivingErrorKey(kind: ReceivingErrorKind): string {
  return `receiving.error.${kind}`;
}

// ── Server function wrappers ─────────────────────────────────────────────────

export async function resolveReceivingScan(raw: string): Promise<ReceivingScanResult> {
  const { resolveReceivingScanFn } = await import("@/api/receiving");
  const result = await resolveReceivingScanFn({ data: { raw } });
  return result as unknown as ReceivingScanResult;
}

export async function receiveInventory(
  receiptKey: string,
  request: ReceiveInventoryRequest,
): Promise<ReceiveInventoryResult> {
  const { receiveInventoryFn } = await import("@/api/receiving");
  const result = await receiveInventoryFn({
    data: {
      receiptKey,
      variantId: request.variantId,
      quantity: request.quantity,
      locationId: request.locationId,
      supplierName: request.supplierName,
    },
  });
  return result as unknown as ReceiveInventoryResult;
}
