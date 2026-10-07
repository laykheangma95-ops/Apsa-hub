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

/**
 * One logical attempt's claim on the holder's key.
 *
 * Release by key equality is not enough to protect replay. Attempt A takes
 * key-1 and is still pending; the merchant closes and reopens checkout, and an
 * identical Attempt B takes key-1 too (same request, same key — exactly what
 * replay needs). If A's late response could then release "key-1", it would
 * drop the key B is relying on: B's lost-response retry would mint key-2, and
 * the server would create a second order.
 *
 * So the key is OWNED by the most recent claim that took it, and only that
 * owner can retire it. A claim that was superseded — even by an identical
 * request holding the same key — retires nothing.
 */
export interface IdempotencyClaim {
  /**
   * This attempt's key for the request described by `requestFingerprint`: the
   * held key when the fingerprint matches (a retry of the same request), else
   * a new one. Either way this claim becomes the key's owner.
   */
  keyFor(requestFingerprint: string): string;
  /**
   * Retire the key — call only once the caller has ACCEPTED this attempt's
   * result as the current one. A no-op unless this claim still owns the key.
   */
  retire(): void;
}

export interface IdempotencyKeyHolder {
  /**
   * The key for an attempt whose request is described by `requestFingerprint`.
   * Returns the held key when the fingerprint matches the attempt it was
   * issued for; otherwise issues and holds a new one.
   */
  keyFor(requestFingerprint: string): string;
  /**
   * Forget the held key — call once the result has been recorded.
   *
   * Pass the key the finished request used to release ONLY that key; with no
   * argument, releases whatever is held. Flows with overlapping attempts use
   * claim() instead, whose retire() is ownership-checked.
   */
  release(key?: string): void;
  /** A new attempt's claim on this holder's key (see IdempotencyClaim). */
  claim(): IdempotencyClaim;
}

export function createIdempotencyKeyHolder(
  generate: () => string = newIdempotencyKey,
): IdempotencyKeyHolder {
  // `owner` is the claim that last took the key; null for a plain keyFor().
  let held: { key: string; fingerprint: string; owner: object | null } | null = null;
  function take(requestFingerprint: string, owner: object | null): string {
    if (held && held.fingerprint === requestFingerprint) {
      held.owner = owner;
      return held.key;
    }
    held = { key: generate(), fingerprint: requestFingerprint, owner };
    return held.key;
  }
  return {
    keyFor(requestFingerprint) {
      return take(requestFingerprint, null);
    },
    release(key) {
      if (key !== undefined && held?.key !== key) return;
      held = null;
    },
    claim() {
      const claim: IdempotencyClaim = {
        keyFor: (requestFingerprint) => take(requestFingerprint, claim),
        retire() {
          if (held?.owner === claim) held = null;
        },
      };
      return claim;
    },
  };
}

export function isIdempotencyKeyHolder(
  value: IdempotencyKeyHolder | IdempotencyClaim,
): value is IdempotencyKeyHolder {
  return typeof (value as Partial<IdempotencyKeyHolder>).claim === "function";
}

/**
 * A stable description of an order request, for keyFor(). Plain JSON of the
 * exact input sent to the server (minus the key itself): if anything that
 * would change the created order changes, so does this string.
 */
export function orderRequestFingerprint(input: unknown): string {
  return JSON.stringify(input);
}

/* ── Holders that outlive a component ─────────────────────────────────────
 *
 * A holder kept in a component (useRef) dies with that component. The Inbox
 * conversation route deliberately remounts its order sheet when the
 * conversation, member or organization changes, so a create whose outcome
 * was still unknown — pending, or committed with the response lost — lost
 * its key on "navigate away and back", the retry minted a new key, and the
 * server correctly created a SECOND identical order.
 *
 * So the replay identity of such a flow is owned here, for the lifetime of
 * the page, under a scope the caller names:
 *
 *   member + organization + flow + subject (e.g. the conversation id)
 *
 * A different member or organization gets a different holder — the previous
 * one's key is unreachable from it — and one conversation's key is never
 * offered to another's request. Within a scope the ordinary rules apply
 * unchanged: same request → same key, changed request → new key, and only
 * the claim that owns the key (and whose result was accepted) retires it.
 *
 * Memory only, never Web Storage: a key plus the request fingerprint it was
 * issued for (which can include a shipping address) must not outlive the tab
 * or be readable by another origin script. Bounded, least-recently-used out.
 */
export interface IdempotencyScope {
  userId: string;
  organizationId: string;
  /** The flow, e.g. "inbox-prepare-order". */
  flow: string;
  /** What the flow is about, e.g. the conversation id. */
  subject: string;
}

const SHARED_HOLDER_LIMIT = 200;
const sharedHolders = new Map<string, IdempotencyKeyHolder>();

/** The page-lifetime holder for one scope — the same instance on every call. */
export function sharedIdempotencyHolder(scope: IdempotencyScope): IdempotencyKeyHolder {
  const id = JSON.stringify([scope.userId, scope.organizationId, scope.flow, scope.subject]);
  let holder = sharedHolders.get(id);
  if (holder) {
    sharedHolders.delete(id); // re-inserted below: most recently used last
  } else {
    holder = createIdempotencyKeyHolder();
    if (sharedHolders.size >= SHARED_HOLDER_LIMIT) {
      sharedHolders.delete(sharedHolders.keys().next().value!);
    }
  }
  sharedHolders.set(id, holder);
  return holder;
}
