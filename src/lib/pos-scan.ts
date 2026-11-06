/**
 * POS barcode scan → cart, with no React in it.
 *
 * The route supplies the lookup, the cart's LATEST state, the cart dispatch,
 * the sound, and the sale it belongs to; this decides what happened.
 *
 * Two guards sit between the asynchronous lookup and the commit, and both are
 * checked here — in the one synchronous step that also commits and plays the
 * sound — so a caller cannot skip them:
 *
 * 1. Sale boundary. `saleGeneration()` is read when the scan starts and again
 *    after the lookup. The route moves it on at every sale boundary (Reset, a
 *    completed checkout, a principal/organization change, unmount) and never
 *    for ordinary cart edits. A lookup that outlived its sale is `stale`: no
 *    cart change, no notice, no sound — it cannot reach the next sale.
 *    `isLive()` must also still be true (the screen is mounted).
 *
 * 2. Acceptance. proposeAddOne runs the real cart reducer first; only an add
 *    that grows the scanned line by exactly one is committed and confirmed
 *    with a sound. `readCart` must return the cart as it is NOW, including adds
 *    committed by scans that finished earlier in the same tick, so concurrent
 *    scans cannot both pass the same last unit of stock.
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
  | { kind: "error" }
  /** The sale (or screen) this scan belonged to is gone. Show nothing. */
  | { kind: "stale" };

export interface PosScanDeps {
  lookup: (code: string) => Promise<BarcodeLookupResult | null>;
  readCart: () => PosCartState;
  dispatch: (action: PosCartAction) => void;
  /** The accepted-scan sound. Called once per committed unit, never otherwise. */
  playAccepted: () => void;
  /** The active sale's generation; it changes at every sale boundary. */
  saleGeneration: () => number;
  /** False once the screen that started the scan is gone. */
  isLive: () => boolean;
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
  const generation = deps.saleGeneration();
  const current = () => deps.isLive() && deps.saleGeneration() === generation;

  let result: BarcodeLookupResult | null;
  try {
    result = await deps.lookup(code.trim());
  } catch {
    return current() ? { kind: "error" } : { kind: "stale" };
  }
  // Checked before anything reads or touches the cart, and with no await
  // between this check and the commit + sound below.
  if (!current()) return { kind: "stale" };
  if (!result) return { kind: "notFound" };

  const label = result.product.nameEn || result.product.nameKm;
  const outcome = proposeAddOne(deps.readCart(), scannedCartLine(result));
  if (outcome.kind === "refused") return { kind: "limit", label };
  // A cart the reducer could not have produced: confirm nothing, change nothing.
  if (outcome.kind === "invalid") return { kind: "error" };

  deps.dispatch(outcome.action);
  try {
    deps.playAccepted();
  } catch {
    // Optional feedback: the unit is already in the cart either way.
  }
  return { kind: "added", label };
}
