/**
 * POS barcode scan → cart, with no React in it.
 *
 * The route supplies the lookup, the cart's LATEST state and the cart dispatch;
 * this decides what happened. Acceptance is never assumed from having
 * dispatched: proposeAddOne runs the real cart reducer first, and only an add
 * that grows the scanned line by exactly one is committed and confirmed with a
 * sound. A refused add changes nothing and stays silent.
 *
 * `readCart` must return the cart as it is NOW, including adds committed by
 * scans that finished earlier in the same tick — not a render snapshot taken
 * before this scan's lookup started. The check and the dispatch run in one
 * synchronous step after the lookup, so concurrent scans cannot both pass the
 * same last unit of stock.
 */
import type { BarcodeLookupResult } from "@/lib/api";
import {
  availableStock,
  lineKey,
  proposeAddOne,
  type CartLine,
  type PosCartAction,
  type PosCartState,
} from "@/lib/pos-cart";

export type PosScanResult =
  | { kind: "added"; label: string }
  | { kind: "limit"; label: string }
  | { kind: "notFound" }
  | { kind: "error" };

export interface PosScanDeps {
  lookup: (code: string) => Promise<BarcodeLookupResult | null>;
  readCart: () => PosCartState;
  dispatch: (action: PosCartAction) => void;
  /** The accepted-scan sound. Called once per committed unit, never otherwise. */
  playAccepted: () => void;
}

/** The cart line a resolved barcode adds: the EXACT variant, at its own price. */
export function scannedCartLine({ product, variant }: BarcodeLookupResult): CartLine {
  return {
    key: lineKey(product.id, variant.id),
    productId: product.id,
    variantId: variant.id,
    nameKm: product.nameKm,
    nameEn: product.nameEn,
    sku: variant.sku || product.sku,
    ...(variant.name ? { variant: variant.name } : {}),
    quantity: 1,
    unitPrice: variant.price,
    stock: availableStock(product),
  };
}

export async function resolvePosScan(code: string, deps: PosScanDeps): Promise<PosScanResult> {
  let result: BarcodeLookupResult | null;
  try {
    result = await deps.lookup(code.trim());
  } catch {
    return { kind: "error" };
  }
  if (!result) return { kind: "notFound" };

  const label = result.product.nameEn || result.product.nameKm;
  const outcome = proposeAddOne(deps.readCart(), scannedCartLine(result));
  if (outcome.kind === "refused") return { kind: "limit", label };

  deps.dispatch(outcome.action);
  deps.playAccepted();
  return { kind: "added", label };
}
