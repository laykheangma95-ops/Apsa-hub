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
  /**
   * True while the holder holds a key: one was issued to an attempt (it may
   * have reached the server — committed, rejected, or lost in flight) and the
   * result has not been ACCEPTED, i.e. no owning claim has retire()d it and
   * nothing has release()d it. That key is the only thing that makes a retry
   * a replay instead of a second order, so the holder must not be discarded.
   *
   * False (idle) when no key was ever issued, or the last one was retired /
   * released. An idle holder carries no state at all: replacing it with a
   * fresh holder is indistinguishable from keeping it.
   *
   * A superseded claim's retire() is a no-op, so a stale callback can never
   * flip a live holder to idle.
   */
  hasUnresolvedKey(): boolean;
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
    hasUnresolvedKey() {
      return held !== null;
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
 * or be readable by another origin script. Bounded — see "Capacity" below.
 */
export interface IdempotencyScope {
  userId: string;
  organizationId: string;
  /** The flow, e.g. "inbox-prepare-order". */
  flow: string;
  /** What the flow is about, e.g. the conversation id. */
  subject: string;
}

/*
 * ── Capacity: bounded, but never at the cost of a replay key ─────────────
 *
 * The registry is bounded so a long session does not accumulate one holder
 * per conversation ever opened. But a holder with an UNRESOLVED key
 * (hasUnresolvedKey) is not cache: it is the only thing that turns a retry of
 * a possibly-committed create into a replay rather than a second order. The
 * first version evicted the least-recently-used holder unconditionally, so
 * "lost response in A → visit enough other conversations → back to A →
 * retry" got a fresh key and create_order_v3 persisted a duplicate.
 *
 * Policy, applied after every lookup:
 *   - only IDLE holders (no unresolved key) are ever evicted, least recently
 *     used first — an idle holder is stateless, so dropping it loses nothing;
 *   - the holder being returned is never evicted by its own lookup;
 *   - an UNRESOLVED holder is never evicted for capacity. If every candidate
 *     is unresolved, the registry temporarily exceeds the nominal limit
 *     (one small key + fingerprint per unresolved create the merchant made);
 *   - as holders retire (their create is accepted) they become idle and the
 *     next lookup compacts the registry back down to the limit.
 *
 * Correctness over a hard memory count: an overflow costs a few bytes per
 * outstanding create; an eviction costs a duplicate order.
 */
export const SHARED_IDEMPOTENCY_HOLDER_LIMIT = 200;
const sharedHolders = new Map<string, IdempotencyKeyHolder>();

/** Evict idle holders, least recently used first, down to the limit — never `keep`. */
function compactSharedHolders(keep: string) {
  if (sharedHolders.size <= SHARED_IDEMPOTENCY_HOLDER_LIMIT) return;
  for (const [id, holder] of sharedHolders) {
    if (sharedHolders.size <= SHARED_IDEMPOTENCY_HOLDER_LIMIT) return;
    if (id !== keep && !holder.hasUnresolvedKey()) sharedHolders.delete(id);
  }
}

/** The page-lifetime holder for one scope — the same instance on every call. */
export function sharedIdempotencyHolder(scope: IdempotencyScope): IdempotencyKeyHolder {
  const id = JSON.stringify([scope.userId, scope.organizationId, scope.flow, scope.subject]);
  const holder = sharedHolders.get(id) ?? createIdempotencyKeyHolder();
  sharedHolders.delete(id); // (re)inserted last: most recently used
  sharedHolders.set(id, holder);
  compactSharedHolders(id);
  return holder;
}

/** How many holders the registry currently keeps (diagnostics and tests). */
export function sharedIdempotencyHolderCount(): number {
  return sharedHolders.size;
}
