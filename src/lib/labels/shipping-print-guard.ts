/**
 * Shipping label — pre-print validation and authoritative verification
 * (CORRECTION-003). Pure and client-safe.
 *
 * A shipping label goes to the printer only when:
 *   1. it is COMPLETE — APSA Parcel ID, its QR, a carrier shipment, a tracking
 *      number and a renderable tracking Code 128 are all present
 *      (shippingLabelIssues). Nothing missing is ever papered over with a
 *      placeholder on a printed label;
 *   2. it is CURRENT — label data is re-fetched from the server immediately
 *      before printing and must match what the merchant is looking at: same
 *      parcel, same shipment (a replaced shipment has a new id), same tracking,
 *      same payment state and COD amount (verifyFreshLabels);
 *   3. it is STILL WANTED by the same person — the dialog is open, for the same
 *      user, organization and orders it was started for (createPrintGuard).
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { buildParcelLabel, type ParcelLabelInput } from "./parcel-label";

/**
 * The pre-print read: a BRAND-NEW request to the server, never an earlier one.
 *
 * `queryClient.fetchQuery` de-duplicates: with a background refetch already in
 * flight for the key it returns THAT request's promise, so a response the
 * server produced before a payment / shipment change could be "verified" and
 * printed. Here the exact label query is cancelled first (its late response is
 * discarded and can never be written back to the cache), and `read` is then
 * invoked directly, outside the query's de-duplication.
 *
 * Rejects when the cancel or the read fails — the caller fails closed. The
 * caller decides, after re-running its identity guard, whether the result may
 * be shown (setQueryData) or printed.
 */
export async function fetchAuthoritative<T>(
  queryClient: Pick<QueryClient, "cancelQueries">,
  queryKey: QueryKey,
  read: () => Promise<T>,
): Promise<T> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  return read();
}

export type ShippingLabelIssue =
  "no_parcel" | "no_parcel_code" | "no_shipment" | "no_tracking" | "tracking_unrenderable";

/** Every reason this label must not print; empty when it is complete. */
export function shippingLabelIssues(input: ParcelLabelInput): ShippingLabelIssue[] {
  const vm = buildParcelLabel(input);
  const issues: ShippingLabelIssue[] = [];
  if (!vm.parcelCode) issues.push("no_parcel");
  else if (!vm.apsaQr) issues.push("no_parcel_code");
  if (!input.delivery) {
    issues.push("no_shipment");
  } else if (!input.delivery.trackingNumber?.trim()) {
    issues.push("no_tracking");
  } else if (!vm.trackingCode128) {
    issues.push("tracking_unrenderable");
  }
  return issues;
}

/**
 * Everything that must not change between what was shown and what prints:
 * the parcel, the shipment's identity and tracking, and the payment decision
 * (state, COD amount + currency, partial flag, check reason).
 */
export function shippingLabelFingerprint(input: ParcelLabelInput): string {
  const p = input.payment;
  const d = input.delivery;
  return JSON.stringify([
    input.order.id,
    input.parcelCode ?? null,
    d ? [d.id ?? null, d.providerName, d.trackingNumber ?? null, d.status] : null,
    p.state,
    p.collect ? [p.collect.amount, p.collect.currency] : null,
    p.partial === true,
    p.checkReason ?? null,
  ]);
}

export type FreshLabelVerdict =
  | { kind: "ok" }
  /** The server's data differs from what was shown: review before printing. */
  | { kind: "changed" }
  /** The fresh data is incomplete: printing is not allowed. */
  | { kind: "invalid" };

export function verifyFreshLabels(
  displayed: readonly ParcelLabelInput[],
  fresh: readonly ParcelLabelInput[],
): FreshLabelVerdict {
  if (displayed.length === 0 || displayed.length !== fresh.length) return { kind: "changed" };
  for (let i = 0; i < fresh.length; i++) {
    if (shippingLabelFingerprint(displayed[i]!) !== shippingLabelFingerprint(fresh[i]!)) {
      return { kind: "changed" };
    }
  }
  if (fresh.some((label) => shippingLabelIssues(label).length > 0)) return { kind: "invalid" };
  return { kind: "ok" };
}

/**
 * Guards one print attempt across its awaits. The context (who, which orders,
 * whether the dialog is open) is refreshed on every render; any change — the
 * dialog closing or unmounting, a different user or organization, a different
 * batch of orders — or a newer attempt retires the attempt in flight.
 */
export interface PrintGuard {
  setContext(identity: string, open: boolean): void;
  retire(): void;
  begin(): () => boolean;
}

export function createPrintGuard(): PrintGuard {
  let identity = "";
  let open = false;
  let generation = 0;
  return {
    setContext(nextIdentity, nextOpen) {
      if (nextIdentity !== identity || nextOpen !== open) generation += 1;
      identity = nextIdentity;
      open = nextOpen;
    },
    retire() {
      open = false;
      generation += 1;
    },
    begin() {
      generation += 1;
      const started = generation;
      return () => open && generation === started;
    },
  };
}

/** The identity a print attempt is bound to. */
export function printIdentity(
  userId: string,
  organizationId: string,
  orderIds: readonly string[],
): string {
  return [userId, organizationId, ...orderIds].join("\u0000");
}
