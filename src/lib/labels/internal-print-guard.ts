/**
 * Internal APSA Parcel label — pre-print revalidation (CORRECTION-003).
 *
 * The internal label follows the SAME security model as the shipping label:
 * nothing prints from cache. Immediately before printing:
 *
 *   1. a FRESH authoritative read — the label query is cancelled and a
 *      brand-new request is made (fetchAuthoritative). The server re-checks
 *      orders.read + fulfillment.print_label and the order lifecycle on that
 *      read, so a revoked permission or a cancelled order is a refusal;
 *   2. the fresh labels must be the ones on screen — same orders, same APSA
 *      parcel codes — and every one must carry a valid code;
 *   3. the print capability is re-authorized server-side;
 *   4. the attempt must still belong to the same open dialog, user,
 *      organization and orders after every await (the identity guard).
 *
 * Anything else — a refused or failed read, a denial, a retired attempt, a
 * difference — does not print. Pure and client-safe.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";
import type { InternalParcelLabelInput } from "./internal-parcel-label";
import { fetchAuthoritative } from "./shipping-print-guard";

/** What must not change between the label shown and the label printed. */
export function internalLabelFingerprint(input: InternalParcelLabelInput): string {
  return JSON.stringify([input.order.id, input.order.orderNumber, input.parcelCode ?? null]);
}

/** True when this label carries a valid, printable APSA parcel code. */
export function internalLabelPrintable(input: InternalParcelLabelInput): boolean {
  return !!input.parcelCode && isValidParcelCode(input.parcelCode);
}

export type InternalPrePrintResult =
  /** Fresh, verified, authorized and still wanted: print. */
  | "ok"
  /** The dialog closed, or the user / organization / orders changed. */
  | "retired"
  /** The server no longer grants the print capability. */
  | "denied"
  /** The fresh read failed or was refused (e.g. the order was cancelled). */
  | "refreshFailed"
  /** The server's labels differ from the ones shown: review first. */
  | "changed"
  /** A label (shown or fresh) has no valid parcel code. */
  | "invalid";

export interface InternalPrePrintOptions {
  /** The labels on screen when Print was pressed. */
  displayed: readonly InternalParcelLabelInput[];
  queryClient: Pick<QueryClient, "cancelQueries" | "setQueryData">;
  /** The exact internal-label query key for this principal and these orders. */
  queryKey: QueryKey;
  /** One brand-new authoritative server read of every label in the batch. */
  read: () => Promise<InternalParcelLabelInput[]>;
  /** The identity guard for this attempt (createPrintGuard().begin()). */
  live: () => boolean;
  /** Server-side re-authorization of fulfillment.print_label. Fails closed. */
  reauthorize: () => Promise<boolean>;
  /**
   * Receives the fresh, verified labels — called only when the result is "ok",
   * so the print target is generated from validated data, never the preview.
   */
  onVerified?: (fresh: InternalParcelLabelInput[]) => void;
}

/**
 * Decide whether the internal label may print. Only "ok" prints; every other
 * result is a refusal. Never throws.
 */
export async function runInternalPrePrint(
  options: InternalPrePrintOptions,
): Promise<InternalPrePrintResult> {
  const { displayed, queryClient, queryKey, read, live, reauthorize } = options;
  if (displayed.length === 0 || !displayed.every(internalLabelPrintable)) return "invalid";

  let fresh: InternalParcelLabelInput[];
  try {
    fresh = await fetchAuthoritative(queryClient, queryKey, read);
  } catch {
    // A refused read may be a revoked grant: re-authorize so a denial is
    // reported as one. Either way nothing prints.
    let stillAllowed = false;
    try {
      stillAllowed = await reauthorize();
    } catch {
      stillAllowed = false;
    }
    if (!live()) return "retired";
    return stillAllowed ? "refreshFailed" : "denied";
  }
  if (!live()) return "retired";

  if (
    fresh.length !== displayed.length ||
    fresh.some(
      (label, i) => internalLabelFingerprint(label) !== internalLabelFingerprint(displayed[i]!),
    )
  ) {
    // Same open dialog and principal: show the server's labels for review.
    queryClient.setQueryData(queryKey, fresh);
    return "changed";
  }
  if (!fresh.every(internalLabelPrintable)) return "invalid";

  let allowed = false;
  try {
    allowed = await reauthorize();
  } catch {
    allowed = false;
  }
  if (!live()) return "retired";
  if (!allowed) return "denied";
  options.onVerified?.(fresh);
  return "ok";
}
