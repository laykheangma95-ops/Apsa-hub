/**
 * Pack Order progress that survives leaving the screen.
 *
 * Packing is physical work, and a packer is often interrupted: they go back to
 * the order, answer a customer, the phone reloads the tab, or they press the
 * phone's own back button. Pack progress used to live only in the screen's
 * React state, so any of these threw away every scan and manual confirmation
 * and the whole parcel had to be checked again.
 *
 * One record per member + organization + order, in this tab's sessionStorage
 * (never shared across principals; another member or organization in this tab
 * reads a different record, so the identity isolation of the screen holds):
 *   parcelCode      the parcel the progress was recorded against;
 *   parcelVerified  its label was scanned and the server accepted it;
 *   packed          the confirmed units, by order line and variant only.
 * Product names, barcodes and quantities required are NOT stored: they always
 * come from the server's current pack requirements.
 *
 * Never authority: this is a working aid for the packer, exactly like a manual
 * confirmation. Mark Packed sends per-line counts and the server re-checks
 * completeness against the order itself (packing/service.ts, "incomplete"). On
 * restore, units for lines the order no longer has, or with another variant,
 * are dropped and each line is capped at what it requires; a parcel check is
 * kept only for the same parcel.
 *
 * Bounded: records untouched for 12 hours are dropped, and at most 30 are kept
 * per tab. Losing one is safe: the packer simply checks the items again.
 * Where sessionStorage cannot be used, a page-lifetime copy stands in, and a
 * write it refuses (quota) simply remembers nothing.
 */
import type { PackMethod, PackSession } from "@/lib/pack";

export interface PackProgressScope {
  userId: string;
  organizationId: string;
  orderId: string;
}

export interface SavedPackUnit {
  orderItemId: string;
  variantId: string;
  method: PackMethod;
  scannedAt: number;
}

export interface PackProgressRecord {
  parcelCode: string;
  parcelVerified: boolean;
  packed: SavedPackUnit[];
  updatedAt: number;
}

const STORAGE_ITEM = "apsa.pack-progress.v1";
export const PACK_PROGRESS_TTL_MS = 12 * 60 * 60 * 1000;
export const PACK_PROGRESS_MAX_RECORDS = 30;

type Store = Record<string, PackProgressRecord>;

/** Used only when sessionStorage is unavailable: lives as long as the page. */
let fallback: Store = {};

function scopeId(scope: PackProgressScope): string {
  return JSON.stringify([scope.userId, scope.organizationId, scope.orderId]);
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
    try {
      const raw = storage.getItem(STORAGE_ITEM);
      store = raw ? (JSON.parse(raw) as Store) : {};
    } catch {
      store = {};
    }
  }
  const kept: Store = {};
  for (const [id, record] of Object.entries(store ?? {})) {
    if (record && now - record.updatedAt < PACK_PROGRESS_TTL_MS) kept[id] = record;
  }
  return kept;
}

function save(store: Store): void {
  const newestFirst = Object.entries(store).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const bounded = Object.fromEntries(newestFirst.slice(0, PACK_PROGRESS_MAX_RECORDS));
  const storage = tabStorage();
  if (!storage) {
    fallback = bounded;
    return;
  }
  try {
    storage.setItem(STORAGE_ITEM, JSON.stringify(bounded));
  } catch {
    // Quota exceeded: this progress is not remembered. Safe — re-check the items.
  }
}

/** This principal's saved progress for this order, or null. */
export function readPackProgress(
  scope: PackProgressScope,
  now = Date.now(),
): PackProgressRecord | null {
  return load(now)[scopeId(scope)] ?? null;
}

/** Remember the session's progress; a session with nothing confirmed is forgotten. */
export function savePackProgress(
  scope: PackProgressScope,
  session: PackSession,
  now = Date.now(),
): void {
  const store = load(now);
  const id = scopeId(scope);
  if (session.packed.length === 0 && !session.parcelVerified) {
    delete store[id];
  } else {
    store[id] = {
      parcelCode: session.parcelCode,
      parcelVerified: session.parcelVerified,
      packed: session.packed.map(({ orderItemId, variantId, method, scannedAt }) => ({
        orderItemId,
        variantId,
        method,
        scannedAt,
      })),
      updatedAt: now,
    };
  }
  save(store);
}

/** Forget this principal's progress for this order (packed, or started over). */
export function clearPackProgress(scope: PackProgressScope, now = Date.now()): void {
  const store = load(now);
  delete store[scopeId(scope)];
  save(store);
}

/**
 * Apply saved progress to a fresh session built from the server's CURRENT
 * requirements. Only units for an existing line with the same variant are
 * kept, each line capped at its required quantity; the parcel check is kept
 * only for the same parcel. Pure.
 */
export function restorePackSession(
  fresh: PackSession,
  saved: PackProgressRecord | null,
): PackSession {
  if (!saved) return fresh;
  const remaining = new Map<string, number>();
  const variantOf = new Map<string, string>();
  for (const req of fresh.requirements) {
    remaining.set(req.orderItemId, req.quantityRequired);
    variantOf.set(req.orderItemId, req.variantId);
  }
  const packed = [];
  for (const unit of saved.packed ?? []) {
    const left = remaining.get(unit.orderItemId) ?? 0;
    if (left <= 0 || variantOf.get(unit.orderItemId) !== unit.variantId) continue;
    if (unit.method !== "scan" && unit.method !== "manual") continue;
    remaining.set(unit.orderItemId, left - 1);
    packed.push({
      orderItemId: unit.orderItemId,
      variantId: unit.variantId,
      method: unit.method,
      scannedAt: unit.scannedAt,
    });
  }
  return {
    ...fresh,
    parcelVerified: saved.parcelVerified === true && saved.parcelCode === fresh.parcelCode,
    packed,
  };
}
