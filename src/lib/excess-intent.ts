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
 * request whose outcome is still UNKNOWN: its key, a fingerprint of what was
 * asked (method, amount, reference, reason — hashed), and, so the member can
 * recognise it, its method, amount and start time. The reference and reason
 * text are never stored.
 *
 * ── Settlement: when an entry is removed ────────────────────────────────────
 *   * the server answered the request under its key with a payment (made now,
 *     or a replay of the committed one);
 *   * the server answered with one of EXCESS_RECORDING_WRITE_FREE_REFUSALS,
 *     identified by its structured code or its EXACT message
 *     (excessRecordingOutcomeOf below) — the database reaches those only
 *     after answering a replay, so the key never wrote anything;
 *   * the member forgets that one attempt, or starts over, explicitly.
 *   Nothing else removes one: not a network error, a timeout, a malformed or
 *   unknown response, a refusal raised before the database, a different
 *   payload, activity on other orders, or time.
 *
 * ── Capacity: refused, never evicted ────────────────────────────────────────
 *   At most EXCESS_INTENT_MAX_PENDING unknown requests per order and
 *   EXCESS_INTENT_MAX_SCOPES orders/members per tab. When a NEW request would
 *   exceed either, it is refused ("capacity") and every existing key is kept;
 *   the member checks an existing one (the same details replay) or forgets
 *   one they have confirmed was not recorded. A write that storage refuses
 *   (quota) is refused the same way ("not_remembered"): nothing is sent that
 *   could not be replayed after a reload.
 *
 * ── Limits that remain ──────────────────────────────────────────────────────
 *   sessionStorage is this tab's only: closing the tab, clearing site data, or
 *   another tab or device loses the keys. Then the order's own payment list
 *   (and Payments → "Excess to return") shows what was recorded, and the
 *   server refuses a second recording of the same transfer reference
 *   (duplicate_transfer_reference) — never a double recording. There is no
 *   expiry: an entry lives until it is settled or the tab's storage goes.
 *
 * Never authority: a key grants nothing — the server binds it to the member,
 * the order and the request.
 */
import { cyrb53 } from "@/lib/refund-intent";
import {
  EXCESS_RECORDING_WRITE_FREE_REFUSALS,
  paymentRefusalByCode,
  paymentRefusalByExactMessage,
} from "@/lib/payment-refusals";

export interface ExcessIntentScope {
  userId: string;
  organizationId: string;
  orderId: string;
}

export interface PendingExcessRecording {
  key: string;
  fingerprint: string;
  startedAt: number;
  /** For the member to recognise the attempt — never the reference or reason. */
  method: string;
  amountMinor: number;
}

interface ExcessIntentRecord {
  pending: PendingExcessRecording[];
  updatedAt: number;
}

const STORAGE_ITEM = "apsa.excess-intent.v3";
const PURPOSE = "record_excess";
export const EXCESS_INTENT_MAX_PENDING = 5;
export const EXCESS_INTENT_MAX_SCOPES = 50;

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

function load(): Store {
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
    if (record && Array.isArray(record.pending) && record.pending.length > 0) kept[id] = record;
  }
  return kept;
}

/** Persist the whole store — never truncated. false when storage refused it. */
function save(store: Store): boolean {
  const storage = tabStorage();
  if (!storage) {
    fallback = store;
    return true;
  }
  try {
    storage.setItem(STORAGE_ITEM, JSON.stringify(store));
    return true;
  } catch {
    return false;
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

/** Every request with an unknown outcome for this member, organization and order, oldest first. */
export function readExcessIntents(scope: ExcessIntentScope): PendingExcessRecording[] {
  return load()[scopeId(scope)]?.pending ?? [];
}

/** The newest request with an unknown outcome, if any. */
export function readExcessIntent(scope: ExcessIntentScope): PendingExcessRecording | null {
  return readExcessIntents(scope).at(-1) ?? null;
}

/** Is a recording on this order still of unknown outcome (e.g. its response was lost)? */
export function hasPendingExcessRecording(scope: ExcessIntentScope): boolean {
  return readExcessIntents(scope).length > 0;
}

export type BeginExcessRecordingResult =
  | { status: "ready"; entry: PendingExcessRecording }
  /** This order already has the maximum of unknown requests; all are kept. */
  | { status: "capacity"; pending: PendingExcessRecording[] }
  /** This tab already remembers the maximum of orders/members; all are kept. */
  | { status: "tab_capacity" }
  /** Storage refused the write: nothing may be sent that could not be replayed. */
  | { status: "not_remembered" };

/**
 * The key for the recording being submitted: an unknown request's key when it
 * asks for the same thing (a retry — replayed if it committed), else a new
 * one, added beside the others — or a refusal, keeping every existing key,
 * when there is no room. Persisted BEFORE the request is sent.
 */
export function beginExcessRecording(
  scope: ExcessIntentScope,
  request: { fingerprint: string; method: string; amountMinor: number },
  newKey: () => string = () => crypto.randomUUID(),
  now = Date.now(),
): BeginExcessRecordingResult {
  const store = load();
  const id = scopeId(scope);
  const pending = store[id]?.pending ?? [];
  const same = pending.find((entry) => entry.fingerprint === request.fingerprint);
  if (same) return { status: "ready", entry: same };
  if (pending.length >= EXCESS_INTENT_MAX_PENDING) return { status: "capacity", pending };
  if (!store[id] && Object.keys(store).length >= EXCESS_INTENT_MAX_SCOPES) {
    return { status: "tab_capacity" };
  }
  const entry: PendingExcessRecording = {
    key: newKey(),
    fingerprint: request.fingerprint,
    startedAt: now,
    method: request.method,
    amountMinor: request.amountMinor,
  };
  store[id] = { pending: [...pending, entry], updatedAt: now };
  return save(store) ? { status: "ready", entry } : { status: "not_remembered" };
}

/** Remove exactly this entry (a settled request, or the member's explicit choice). */
export function excessRecordingSettled(scope: ExcessIntentScope, key: string): void {
  const store = load();
  const id = scopeId(scope);
  const remaining = (store[id]?.pending ?? []).filter((entry) => entry.key !== key);
  if (remaining.length > 0) store[id] = { pending: remaining, updatedAt: Date.now() };
  else delete store[id];
  save(store);
}

/** The member explicitly forgets ONE attempt they confirmed was not recorded. */
export const forgetExcessRecording = excessRecordingSettled;

/** The member explicitly started over: nothing is remembered for this order. */
export function resetExcessRecording(scope: ExcessIntentScope): void {
  const store = load();
  delete store[scopeId(scope)];
  save(store);
}

/**
 * What a failed "record with excess" request proves about its key:
 *   write_free — one of EXCESS_RECORDING_WRITE_FREE_REFUSALS, by its structured
 *                code or its EXACT message: the key wrote nothing; settle it;
 *   uncertain  — anything else (network error, timeout, malformed or unknown
 *                response, a refusal raised before the database): keep it.
 * Separate from what is SHOWN to the member (paymentErrorMessageKey).
 */
export function excessRecordingOutcomeOf(err: unknown): "write_free" | "uncertain" {
  const byCode = paymentRefusalByCode((err as { code?: unknown } | null)?.code);
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  const refusal =
    byCode ??
    (err instanceof Error && (statusCode === undefined || statusCode === 409)
      ? paymentRefusalByExactMessage(err.message)
      : null);
  return refusal && EXCESS_RECORDING_WRITE_FREE_REFUSALS.has(refusal) ? "write_free" : "uncertain";
}
