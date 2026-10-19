/**
 * The retry identity (idempotency key) of a submitted payment whose outcome is
 * not yet known, kept for as long as the app's QueryClient lives — not for as
 * long as the screen that submitted it.
 *
 * Order detail used to hold this in component refs. Unmounting the route (the
 * merchant navigates away, another member's screen mounts, they come back)
 * destroyed it, and the merchant's re-entry of the SAME payment went out under
 * a new key: the server recorded a second pending payment, a second `created`
 * event and a second payments.record audit.
 *
 * Rules:
 *
 *   - Partitioned by the initiating user, organization and order. A member is
 *     (user, organization), and record_payment_v2 (migration 062) binds a
 *     replay to exactly those plus the order, so no separate membership id is
 *     needed. Another principal's lookup never reaches this one's identities.
 *   - Bound to the canonical payload: method, amount (integer minor units),
 *     currency and reference. Only the same logical payment reuses a key; a
 *     changed financial field gets a key of its own and never silently rides
 *     an earlier one. Several unresolved payments can coexist.
 *   - Retired only by a known outcome — the server answered with the payment.
 *     An error, a lost response or a timeout is not an outcome: the identity
 *     stays, with no eviction and no expiry, so the retry replays. A retry of a
 *     request the server refused simply replays a key nothing was written
 *     under.
 *   - A sheet opened while a payment was unresolved is a retry of it: the
 *     opening keeps a snapshot of the scope's unresolved identities, so the
 *     original's success landing while the merchant re-enters it still
 *     replays (one payment), while a sheet opened after a known success gets
 *     a new key for a legitimate new payment.
 *   - No draft is kept and nothing reaches browser storage. The merchant
 *     re-enters the payment; only its key is handed back.
 *
 * Lifetime: the QueryClient (src/router.tsx makes one per app load). It covers
 * a route remount, including one through another member's screen, and
 * survives Settings' sign-out `queryClient.clear()`, which empties the cache
 * but not this map (the partition keeps another member out). It does NOT
 * survive a page reload: there the server's duplicate detection (migration
 * 043) is the remaining guard.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Currency, PaymentMethod } from "@/types";

/** Who started the payment, and on which order. */
export interface PaymentReplayScope {
  userId: string;
  organizationId: string;
  orderId: string;
}

/** Every financially relevant field the request carries. */
export interface PaymentReplayPayload {
  method: PaymentMethod;
  amountMinor: number;
  currency: Currency;
  reference: string | undefined;
}

interface ScopeIdentities {
  /** payload fingerprint → its unresolved key */
  unresolved: Map<string, string>;
  /** Every key ever bound in this scope, so none is bound to two payloads. */
  bound: Set<string>;
}

const IDENTITIES = new WeakMap<QueryClient, Map<string, ScopeIdentities>>();

const scopeTag = ({ userId, organizationId, orderId }: PaymentReplayScope) =>
  `${userId}\u0000${organizationId}\u0000${orderId}`;

const fingerprintOf = ({ method, amountMinor, currency, reference }: PaymentReplayPayload) =>
  JSON.stringify([method, amountMinor, currency, reference?.trim() || null]);

function identitiesOf(queryClient: QueryClient, scope: PaymentReplayScope): ScopeIdentities {
  let scopes = IDENTITIES.get(queryClient);
  if (!scopes) {
    scopes = new Map();
    IDENTITIES.set(queryClient, scopes);
  }
  const tag = scopeTag(scope);
  let identities = scopes.get(tag);
  if (!identities) {
    identities = { unresolved: new Map(), bound: new Set() };
    scopes.set(tag, identities);
  }
  return identities;
}

let fallbackSeq = 0;
function mintKey(base: string): string {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  fallbackSeq += 1;
  return `${base}.${fallbackSeq}`;
}

/** What was unresolved in one scope when a Record payment sheet was opened. */
export interface PaymentReplayOpening {
  readonly scope: string;
  readonly candidates: ReadonlyMap<string, string>;
}

/** Called when the sheet opens: the identities a submit from it may replay. */
export function openPaymentReplay(
  queryClient: QueryClient,
  scope: PaymentReplayScope,
): PaymentReplayOpening {
  return {
    scope: scopeTag(scope),
    candidates: new Map(identitiesOf(queryClient, scope).unresolved),
  };
}

/**
 * The key to submit this payment under: the unresolved key of the same logical
 * payment if there is one — now, or when this sheet was opened — else
 * `freshKey` (the sheet's own) bound to it, or a newly minted key when
 * `freshKey` already belongs to another payload.
 */
export function paymentReplayKeyFor(
  queryClient: QueryClient,
  scope: PaymentReplayScope,
  payload: PaymentReplayPayload,
  freshKey: string,
  opening: PaymentReplayOpening | null,
): string {
  const identities = identitiesOf(queryClient, scope);
  const fingerprint = fingerprintOf(payload);
  const existing =
    identities.unresolved.get(fingerprint) ??
    (opening?.scope === scopeTag(scope) ? opening.candidates.get(fingerprint) : undefined);
  if (existing) return existing;
  const key = identities.bound.has(freshKey) ? mintKey(freshKey) : freshKey;
  identities.unresolved.set(fingerprint, key);
  identities.bound.add(key);
  return key;
}

/** The server answered with the payment: nothing is left to replay under `key`. */
export function resolvePaymentReplay(
  queryClient: QueryClient,
  scope: PaymentReplayScope,
  key: string,
): void {
  const unresolved = IDENTITIES.get(queryClient)?.get(scopeTag(scope))?.unresolved;
  if (!unresolved) return;
  for (const [fingerprint, candidate] of unresolved) {
    if (candidate === key) unresolved.delete(fingerprint);
  }
}
