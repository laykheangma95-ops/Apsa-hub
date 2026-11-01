/**
 * Durable identity for ONE "record a transfer above the total" (migration 068,
 * DRAFT) — the same pattern as src/lib/refund-intent.ts.
 *
 * A recording retried after a lost response must be the SAME recording: the
 * server replays a key it already committed (the original member's original
 * request) and records nothing twice. So the key outlives the request that
 * minted it — a remount, a reload, leaving the order and coming back — and is
 * kept in this tab's sessionStorage, not in the sheet.
 *
 * One record per member + organization + order + form purpose. It holds only
 * the key and a fingerprint of what was asked (method, amount, reference,
 * reason — hashed; the reference and reason text are never stored). The same
 * request again reuses the key; anything else gets a new key — and the server
 * then refuses a second recording of the same transfer reference
 * (duplicate_transfer_reference), so a lost key can never double-record.
 *
 * Cleared on a conclusive success, or when the member explicitly starts over.
 * Bounded like refund intents: 24 hours, 50 records per tab. Never authority.
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
  pending: PendingExcessRecording | null;
  updatedAt: number;
}

const STORAGE_ITEM = "apsa.excess-intent.v1";
const PURPOSE = "record_excess";
export const EXCESS_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const EXCESS_INTENT_MAX_RECORDS = 50;

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
    if (record && now - record.updatedAt < EXCESS_INTENT_TTL_MS) kept[id] = record;
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

/** The pending recording for this member, organization and order, if any. */
export function readExcessIntent(
  scope: ExcessIntentScope,
  now = Date.now(),
): PendingExcessRecording | null {
  return load(now)[scopeId(scope)]?.pending ?? null;
}

/**
 * The key for the recording being submitted: the pending one's when it asks
 * for the same thing (a retry — replayed if it committed), else a new one.
 * Persisted BEFORE the request is sent, so a reload mid-flight still finds it.
 */
export function beginExcessRecording(
  scope: ExcessIntentScope,
  fingerprint: string,
  newKey: () => string = () => crypto.randomUUID(),
  now = Date.now(),
): PendingExcessRecording {
  const store = load(now);
  const id = scopeId(scope);
  const current = store[id]?.pending ?? null;
  const pending =
    current && current.fingerprint === fingerprint
      ? current
      : { key: newKey(), fingerprint, startedAt: now };
  store[id] = { pending, updatedAt: now };
  save(store);
  return pending;
}

/** The server accepted it (made now or replayed): the next recording is a new one. */
export function excessRecordingSucceeded(scope: ExcessIntentScope): void {
  const now = Date.now();
  const store = load(now);
  delete store[scopeId(scope)];
  save(store);
}

/** The member explicitly started over. */
export const resetExcessRecording = excessRecordingSucceeded;
