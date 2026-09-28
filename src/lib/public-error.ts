/**
 * The public shape of an unexpected server failure — shared by the server
 * boundary that produces it and the browser code that reads it.
 *
 * TanStack Start serializes only an Error's `message` across the
 * server-function wire (router-core ShallowErrorPlugin): `statusCode`, `code`
 * and every other own property are dropped. So the message IS the contract.
 *
 * For an unexpected failure (a database outage, a PostgREST error, a bug) the
 * server replaces the original message — which can quote SQL, table names,
 * constraint names or row values — with INTERNAL_ERROR_MESSAGE plus a support
 * reference:
 *
 *   "Something went wrong on the server. Please try again. [ref:req_0123456789abcdef0123]"
 *
 * Deliberately written so none of the existing UI classifiers
 * (src/lib/orders.ts, payments.ts, deliveries.ts, catalog.ts, inventory.ts,
 * customers-view.ts, team-errors.ts) match it as anything but their generic
 * "server error" kind.
 *
 * Domain errors (401/403/404/409/400 with a service-authored message) are NOT
 * rewritten — their messages are what those classifiers read.
 *
 * Safe for the browser bundle: no server imports.
 */

export const INTERNAL_ERROR_MESSAGE = "Something went wrong on the server. Please try again.";

const REFERENCE_RE = /\[ref:(req_[0-9a-f]{20})\]/;

/** Prefix of a rate-limit rejection message; see src/server/rate-limit/errors.ts. */
export const RATE_LIMITED_PREFIX = "rate_limited:";

export function formatInternalErrorMessage(requestId: string): string {
  return `${INTERNAL_ERROR_MESSAGE} [ref:${requestId}]`;
}

/**
 * The support reference carried by a sanitized server error, if any. Show it
 * to the merchant so support can find the matching server log line; it is an
 * opaque random ID and grants nothing.
 */
export function supportReferenceOf(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return REFERENCE_RE.exec(message)?.[1] ?? null;
}

/** True when the server refused the call because a rate limit was reached. */
export function isRateLimitedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return message.startsWith(RATE_LIMITED_PREFIX);
}
