import { RATE_LIMITED_PREFIX } from "@/lib/public-error";
import { markPublicDomainError } from "@/server/public-domain-error";

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
    markPublicDomainError(this);
  }
}

/**
 * The durable limiter could not be reached for an operation whose policy is
 * fail_closed (refund / reversal / correction). A public, retryable 503: the
 * operation was NOT performed and may be retried shortly. Names no rule,
 * bucket, backend or identity.
 */
export class RateLimitUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "rate_limit_unavailable";

  constructor() {
    super(
      "This action is temporarily unavailable and was not performed. Please try again in a moment.",
    );
    this.name = "RateLimitUnavailableError";
    markPublicDomainError(this);
  }
}
