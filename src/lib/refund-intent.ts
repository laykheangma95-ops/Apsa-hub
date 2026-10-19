/**
 * Durable identity for ONE logical refund (CORRECTIONS.md, CORRECTION-005).
 *
 * A refund retried after a lost response must be the SAME refund: the server
 * replays a key it already committed, for the member who used it, and refunds
 * nothing twice. The key therefore has to outlive the request that minted it —
 * a remount, a full page reload, leaving the payment and coming back, a member
 * or organization switch in this tab — so it is kept here, in sessionStorage,
 * not in a component or a module variable.
 *
 * One record per member + organization + payment (never shared across
 * principals; another member in this tab never reads or uses it):
 *   pending       the refund the merchant last started and has not yet seen
 *                 succeed — its key, a fingerprint of what it asked for
 *                 (amount + reason, hashed: the reason text itself is never
 *                 stored), the amount, and when it was started;
 *   acknowledged  ids of refunds on this payment the merchant has SEEN: this
 *                 screen received their success, or the merchant reviewed them
 *                 and explicitly chose to refund beyond them.
 *
 * Retry vs. new refund. Submitting the same amount and reason while a refund
 * is pending reuses its key (a replay if it committed). Anything else gets a
 * new key, and the server refuses a new key that does not acknowledge every
 * refund already on the payment (refund_confirmation_required) — so when this
 * record is gone (another tab, another device, cleared storage, private
 * mode), the merchant is shown the existing refund and asked to confirm,
 * instead of a second refund happening silently. A refund the merchant saw
 * succeed is acknowledged automatically: a deliberate further refund needs no
 * extra step.
 *
 * Bounded: records untouched for 24 hours are dropped, and at most 50 are kept
 * per tab. Losing one is safe for the reason above. sessionStorage is this
 * tab's only and is cleared when the tab closes; where it cannot be used at
 * all, a page-lifetime copy stands in, and a write it refuses (quota) simply
 * remembers nothing.
 *
 * Never authority: a key here grants nothing — the server binds it to the
 * member who used it, the payment, the amount and the reason.
 */

export interface RefundIntentScope {
  userId: string;
  organizationId: string;
  paymentId: string;
}

export interface PendingRefund {
  key: string;
  fingerprint: string;
  amountMinor: number;
  startedAt: number;
}

export interface RefundIntentRecord {
  pending: PendingRefund | null;
  acknowledged: string[];
  updatedAt: number;
}

const STORAGE_ITEM = "apsa.refund-intent.v1";
export const REFUND_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const REFUND_INTENT_MAX_RECORDS = 50;

type Store = Record<string, RefundIntentRecord>;

/** Used only when sessionStorage is unavailable: lives as long as the page. */
let fallback: Store = {};

function scopeId(scope: RefundIntentScope): string {
  return JSON.stringify([scope.userId, scope.organizationId, scope.paymentId]);
}

/** This tab's sessionStorage, or null where it cannot be used (SSR, blocked). */
function tabStorage(): Storage | null {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return null;
    storage.getItem(STORAGE_ITEM);
    return storage;
  } catch {
    return null;
  }
}

function load(now: number): Store {
  const storage = tabStorage();
  let store: Store = fallback;
  if (storage) {
    // sessionStorage is the one source of truth wherever it works: an empty
    // or unreadable entry means nothing is remembered.
    try {
      const raw = storage.getItem(STORAGE_ITEM);
      store = raw ? (JSON.parse(raw) as Store) : {};
    } catch {
      store = {};
    }
  }
  const kept: Store = {};
  for (const [id, record] of Object.entries(store ?? {})) {
    if (record && now - record.updatedAt < REFUND_INTENT_TTL_MS) kept[id] = record;
  }
  return kept;
}

function save(store: Store): void {
  const newestFirst = Object.entries(store).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const bounded = Object.fromEntries(newestFirst.slice(0, REFUND_INTENT_MAX_RECORDS));
  const storage = tabStorage();
  if (!storage) {
    fallback = bounded;
    return;
  }
  try {
    storage.setItem(STORAGE_ITEM, JSON.stringify(bounded));
  } catch {
    // Quota exceeded: nothing is remembered for this refund. Safe — the server
    // asks the merchant to confirm before any refund beyond one already made.
  }
}

function update(
  scope: RefundIntentScope,
  change: (record: RefundIntentRecord) => RefundIntentRecord,
  now = Date.now(),
): RefundIntentRecord {
  const store = load(now);
  const id = scopeId(scope);
  const next = {
    ...change(store[id] ?? { pending: null, acknowledged: [], updatedAt: now }),
    updatedAt: now,
  };
  store[id] = next;
  save(store);
  return next;
}

/**
 * A stable, non-reversible-at-a-glance fingerprint of what a refund asks for
 * (cyrb53 over "amount|reason"). Equality only — it identifies the same
 * request again; it is not a secret and never leaves the browser.
 */
export function refundFingerprint(amountMinor: number, reason: string): string {
  const text = `${amountMinor}|${reason}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** This principal's record for this payment (empty when there is none). */
export function readRefundIntent(scope: RefundIntentScope, now = Date.now()): RefundIntentRecord {
  return load(now)[scopeId(scope)] ?? { pending: null, acknowledged: [], updatedAt: now };
}

/**
 * The key for a refund the merchant is submitting: the pending refund's key
 * when it asks for the same thing (a retry — replayed if it committed), else a
 * new one, which becomes the pending refund. Persisted BEFORE the request is
 * sent, so a reload mid-flight still finds it.
 */
export function beginRefund(
  scope: RefundIntentScope,
  amountMinor: number,
  reason: string,
  newKey: () => string = () => crypto.randomUUID(),
  now = Date.now(),
): PendingRefund {
  const fingerprint = refundFingerprint(amountMinor, reason);
  const record = update(
    scope,
    (current) =>
      current.pending && current.pending.fingerprint === fingerprint
        ? current
        : { ...current, pending: { key: newKey(), fingerprint, amountMinor, startedAt: now } },
    now,
  );
  return record.pending!;
}

/** The server accepted the pending refund: done, and now SEEN by the merchant. */
export function refundSucceeded(scope: RefundIntentScope, refundEventId: string | null): void {
  update(scope, (current) => ({
    pending: null,
    acknowledged:
      refundEventId && !current.acknowledged.includes(refundEventId)
        ? [...current.acknowledged, refundEventId]
        : current.acknowledged,
    updatedAt: current.updatedAt,
  }));
}

/** The merchant reviewed these refunds and chose to refund beyond them. */
export function acknowledgeRefunds(scope: RefundIntentScope, refundEventIds: string[]): void {
  update(scope, (current) => ({
    ...current,
    acknowledged: [...new Set([...current.acknowledged, ...refundEventIds])],
  }));
}

/** The merchant chose not to refund again: nothing is pending any more. */
export function abandonPendingRefund(scope: RefundIntentScope): void {
  update(scope, (current) => ({ ...current, pending: null }));
}
