import { RATE_LIMITED_PREFIX } from "@/lib/public-error";

/**
 * A rate-limit refusal. 429 with a service-authored message, so the
 * server-function boundary passes it through; the message starts with
 * RATE_LIMITED_PREFIX so the browser can recognise it (only the message
 * survives the server-function wire). It names no rule, bucket or identity.
 */
export class RateLimitedError extends Error {
  readonly statusCode = 429;
  readonly code = "rate_limited";

  constructor(readonly retryAfterSeconds: number) {
    super(`${RATE_LIMITED_PREFIX} Too many requests. Try again in ${retryAfterSeconds} seconds.`);
    this.name = "RateLimitedError";
  }
}
