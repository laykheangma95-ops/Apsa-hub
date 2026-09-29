/**
 * APSA QR payloads — the tiny, stable strings an APSA QR encodes.
 *
 * A QR on a product label or a parcel resolves INTERNALLY to an APSA identity
 * and nothing more (session scope §4, §19). The payload therefore carries only
 * an opaque APSA reference. It never carries:
 *
 *   - price or stock as authority   (those live in the catalog/ledger, server-side)
 *   - a secret or auth token        (a printed label is not a bearer credential)
 *   - customer information / PII     (a QR is scanned in the open)
 *
 * Because the payload is just a reference, scanning it does not by itself
 * disclose anything: opening the referenced record still goes through APSA's
 * authenticated, org-scoped reads. There is no public/unauthenticated tracking
 * endpoint in V1, so these must not be treated as public URLs.
 *
 * Format: a custom `apsa:` URI with a type and an id. Stable and minimal, so the
 * QR stays low-version (small, robust) and a future in-app scanner can route on
 * the type without guessing.
 */

export const APSA_QR_SCHEME = "apsa";

export type ApsaQrKind = "variant" | "order";

export interface ApsaQrRef {
  kind: ApsaQrKind;
  id: string;
}

/** UUIDs only — the ids APSA uses. Rejects anything else so a payload can never smuggle content. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Product/variant QR payload — resolves to a sellable stock unit (the variant),
 * matching the rule that a scan identifies the exact variant, not just the
 * product. `apsa:variant/<uuid>`.
 */
export function variantQrPayload(variantId: string): string {
  if (!UUID_RE.test(variantId)) {
    throw new Error("variantQrPayload: variantId must be a UUID");
  }
  return `${APSA_QR_SCHEME}:variant/${variantId.toLowerCase()}`;
}

/**
 * Parcel / order QR payload — resolves to an order for in-app lookup only.
 * `apsa:order/<uuid>`. This is the order's real id, not its human code; it is an
 * internal reference with no authority and no PII, and resolving it still
 * requires an authenticated, org-scoped read.
 */
export function orderQrPayload(orderId: string): string {
  if (!UUID_RE.test(orderId)) {
    throw new Error("orderQrPayload: orderId must be a UUID");
  }
  return `${APSA_QR_SCHEME}:order/${orderId.toLowerCase()}`;
}

/**
 * Parse an APSA QR payload back into a typed reference, or null if it is not a
 * well-formed APSA payload. A future in-app scanner uses this to route; it never
 * trusts the parsed id as authorization (the read that follows is org-scoped).
 */
export function parseApsaQrPayload(payload: string): ApsaQrRef | null {
  if (typeof payload !== "string") return null;
  const prefix = `${APSA_QR_SCHEME}:`;
  if (!payload.startsWith(prefix)) return null;
  const rest = payload.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (kind !== "variant" && kind !== "order") return null;
  if (!UUID_RE.test(id)) return null;
  return { kind, id: id.toLowerCase() };
}
