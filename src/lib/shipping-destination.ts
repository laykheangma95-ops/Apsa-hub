/**
 * Pure helpers for the order shipping-destination snapshot (client-safe).
 *
 * No React, no server imports — just the value shape a shipping form holds and
 * the trivial transforms that turn it into the payload the API expects. The
 * SERVER owns validation and normalization (src/server/orders/service.ts); this
 * only decides "was anything entered?" and trims what to send.
 */

export interface ShippingDestinationValue {
  name: string;
  phone: string;
  address: string;
}

export const EMPTY_SHIPPING_DESTINATION: ShippingDestinationValue = {
  name: "",
  phone: "",
  address: "",
};

/** True once the merchant has typed anything at all — i.e. a destination is intended. */
export function shippingDestinationTouched(v: ShippingDestinationValue): boolean {
  return v.name.trim().length > 0 || v.phone.trim().length > 0 || v.address.trim().length > 0;
}

/** The trimmed snapshot to send, or null when nothing was entered (pickup order). */
export function shippingDestinationPayload(
  v: ShippingDestinationValue,
): { name: string; phone: string | null; address: string } | null {
  if (!shippingDestinationTouched(v)) return null;
  return {
    name: v.name.trim(),
    phone: v.phone.trim() || null,
    address: v.address.trim(),
  };
}

/**
 * The destination to send with a NEW order — only when the merchant explicitly
 * chose to ship it.
 *
 * Shipping is an explicit intent, never inferred from which fields happen to be
 * filled: a customer's name/phone are prefilled as a convenience, and that
 * alone must not turn an in-store pickup into a shipment. With `intent` false
 * this is always null, whatever the fields hold.
 */
export function orderShippingPayload(
  intent: boolean,
  v: ShippingDestinationValue,
): { name: string; phone: string | null; address: string } | null {
  return intent ? shippingDestinationPayload(v) : null;
}

/** A shipping order needs a recipient name and an address; pickup needs nothing. */
export function shippingIntentReady(intent: boolean, v: ShippingDestinationValue): boolean {
  return !intent || (v.name.trim().length > 0 && v.address.trim().length > 0);
}
