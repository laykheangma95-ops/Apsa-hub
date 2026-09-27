/**
 * Client lifecycle for order-creation idempotency keys (migration 044).
 *
 * The SERVER is the authority: create_order_v2 refuses a second order under
 * one key, replays the first one to the same member for the same request, and
 * answers a different request under that key with a conflict. This module only
 * decides WHICH key a given attempt sends, so that:
 *
 *   - a retry of the same attempt (network failure, lost response, double tap
 *     that slipped past the submitting guard) sends the SAME key, and the
 *     server hands back the order it already created instead of a second one;
 *   - a genuinely different order — the merchant changed the basket, customer,
 *     discount or delivery fee after a failure — gets a NEW key, because it is
 *     a different request and must not collide with the old one;
 *   - once an order has been created, the next order starts with a NEW key
 *     even if its basket is identical (two identical sales are two sales).
 *
 * Keys are random UUIDs with no meaning of their own: no tenant, member,
 * amount or timestamp is encoded in them.
 */

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface IdempotencyKeyHolder {
  /**
   * The key for an attempt whose request is described by `requestFingerprint`.
   * Returns the held key when the fingerprint matches the attempt it was
   * issued for; otherwise issues and holds a new one.
   */
  keyFor(requestFingerprint: string): string;
  /** Forget the held key — call once the order has been created. */
  release(): void;
}

export function createIdempotencyKeyHolder(
  generate: () => string = newIdempotencyKey,
): IdempotencyKeyHolder {
  let held: { key: string; fingerprint: string } | null = null;
  return {
    keyFor(requestFingerprint) {
      if (held && held.fingerprint === requestFingerprint) return held.key;
      held = { key: generate(), fingerprint: requestFingerprint };
      return held.key;
    },
    release() {
      held = null;
    },
  };
}

/**
 * A stable description of an order request, for keyFor(). Plain JSON of the
 * exact input sent to the server (minus the key itself): if anything that
 * would change the created order changes, so does this string.
 */
export function orderRequestFingerprint(input: unknown): string {
  return JSON.stringify(input);
}
