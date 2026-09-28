/**
 * Request / correlation IDs.
 *
 * A request ID is 80 bits from the platform CSPRNG, rendered as
 * `req_` + 20 lowercase hex characters. It carries NO information: no
 * timestamp, tenant, member, email or sequence is encoded in it, so showing it
 * to a merchant or pasting it into a support chat leaks nothing.
 *
 * It is a correlation handle ONLY. It is never an authentication or
 * authorization input: knowing a request ID grants nothing, and no code path
 * may look anything up "by request ID" on behalf of a caller.
 */

const REQUEST_ID_RE = /^req_[0-9a-f]{20}$/;

export function newRequestId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `req_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}
