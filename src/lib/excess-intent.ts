/**
 * Durable identity for "record a transfer above the total" (migration 068,
 * DRAFT) — the same pattern as src/lib/refund-intent.ts.
 *
 * A recording retried after a lost response must be the SAME recording: the
 * server replays a key it already committed (the original member's original
 * request) — before any balance rule, so also once the order owes nothing —
 * and records nothing twice. So the key outlives the request that minted it —
 * a remount, a reload, leaving the order and coming back — and is kept in this
 * tab's sessionStorage, not in the sheet.
 *
 * One record per member + organization + order + form purpose. It holds every
 * request whose outcome is still UNKNOWN (a lost response, a network or server
 * error): its key and a fingerprint of what was asked (method, amount,
 * reference, reason — hashed; the reference and reason text are never
 * stored). The same request again reuses its key. A different request gets a
 * new key and never displaces an unknown one, so a mistyped retry cannot lose
 * the key that would replay the original.
 *
 * An entry is settled — removed — when the server answers that request
 * conclusively: accepted (made now or replayed), or refused (a refusal means
 * that key wrote nothing). "Start over" clears the record. Bounded: 24 hours,
 * 5 unknown requests per order, 50 records per tab. Never authority.
 */
import { cyrb53 } from "@/lib/refund-intent";

export interface ExcessIntentScope {
  userId: string;
  organizationId: string;
  orderId: string;
}

export interface PendingExcessRecording {
  key: string;
  fingerprint: string;
  startedAt: number;
}

interface ExcessIntentRecord {
  pending: PendingExcessRecording[];
  updatedAt: number;
}

const STORAGE_ITEM = "apsa.excess-intent.v2";
const PURPOSE = "record_excess";
export const EXCESS_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const EXCESS_INTENT_MAX_RECORDS = 50;
export const EXCESS_INTENT_MAX_PENDING = 5;

type Store = Record<string, ExcessIntentRecord>;

let fallback: Store = {};

function scopeId(scope: ExcessIntentScope): string {
  return JSON.stringify([PURPOSE, scope.userId, scope.organizationId, scope.orderId]);
}

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
    try {
      const raw = storage.getItem(STORAGE_ITEM);
      store = raw ? (JSON.parse(raw) as Store) : {};
    } catch {
      store = {};
    }
  }
  const kept: Store = {};
  for (const [id, record] of Object.entries(store ?? {})) {
    if (
      record &&
      Array.isArray(record.pending) &&
      record.pending.length > 0 &&
      now - record.updatedAt < EXCESS_INTENT_TTL_MS
    ) {
      kept[id] = record;
    }
  }
  return kept;
}

function save(store: Store): void {
  const newestFirst = Object.entries(store).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const bounded = Object.fromEntries(newestFirst.slice(0, EXCESS_INTENT_MAX_RECORDS));
  const storage = tabStorage();
  if (!storage) {
    fallback = bounded;
    return;
  }
  try {
    storage.setItem(STORAGE_ITEM, JSON.stringify(bounded));
  } catch {
    // Quota: nothing remembered. Safe — the server refuses a second recording
    // of the same transfer reference.
  }
}

export function excessRecordingFingerprint(request: {
  method: string;
  amountMinor: number;
  reference: string;
  reason: string;
}): string {
  return cyrb53(
    `${PURPOSE}|${request.method}|${request.amountMinor}|${request.reference.trim()}|${request.reason.trim()}`,
  );
}

/** The newest request with an unknown outcome for this member, organization and order. */
export function readExcessIntent(
  scope: ExcessIntentScope,
  now = Date.now(),
): PendingExcessRecording | null {
  return load(now)[scopeId(scope)]?.pending.at(-1) ?? null;
}

/** Is a recording on this order still of unknown outcome (e.g. its response was lost)? */
export function hasPendingExcessRecording(scope: ExcessIntentScope, now = Date.now()): boolean {
  return readExcessIntent(scope, now) !== null;
}

/**
 * The key for the recording being submitted: an unknown request's key when it
 * asks for the same thing (a retry — replayed if it committed), else a new
 * one, added beside the others. Persisted BEFORE the request is sent, so a
 * reload mid-flight still finds it.
 */
export function beginExcessRecording(
  scope: ExcessIntentScope,
  fingerprint: string,
  newKey: () => string = () => crypto.randomUUID(),
  now = Date.now(),
): PendingExcessRecording {
  const store = load(now);
  const id = scopeId(scope);
  const pending = store[id]?.pending ?? [];
  const same = pending.find((entry) => entry.fingerprint === fingerprint);
  if (same) {
    store[id] = { pending, updatedAt: now };
    save(store);
    return same;
  }
  const entry = { key: newKey(), fingerprint, startedAt: now };
  store[id] = { pending: [...pending, entry].slice(-EXCESS_INTENT_MAX_PENDING), updatedAt: now };
  save(store);
  return entry;
}

/**
 * The server answered the request under this key conclusively — accepted, or
 * refused (so that key wrote nothing). Its entry is gone; the others stay.
 */
export function excessRecordingSettled(scope: ExcessIntentScope, key: string): void {
  const now = Date.now();
  const store = load(now);
  const id = scopeId(scope);
  const remaining = (store[id]?.pending ?? []).filter((entry) => entry.key !== key);
  if (remaining.length > 0) store[id] = { pending: remaining, updatedAt: now };
  else delete store[id];
  save(store);
}

/** The member explicitly started over: nothing is remembered for this order. */
export function resetExcessRecording(scope: ExcessIntentScope): void {
  const store = load(Date.now());
  delete store[scopeId(scope)];
  save(store);
}
