/**
 * Rate limiter — the one entry point server code uses.
 *
 *   await enforceRateLimits([
 *     { rule: RATE_LIMITS.orderCreateMember, parts: [orgId, userId] },
 *     { rule: RATE_LIMITS.orderCreateOrganization, parts: [orgId] },
 *   ]);
 *
 * Checks run in order and stop at the first bucket that is full. A check whose
 * parts are missing (e.g. no client IP could be determined) is skipped, never
 * pooled into a shared bucket.
 *
 * Backend: PostgreSQL (consume_rate_limit, migration 045) — shared by every
 * instance. What happens when that call fails (network, migration 045 not
 * applied, missing server env) is the caller's explicit BackendFailurePolicy
 * (policies.ts#BACKEND_FAILURE_POLICY):
 *
 *   memory_fallback (default; auth, order creation, routine payments) — the
 *     limiter DEGRADES to a per-process memory store for that hit and logs
 *     `rate_limit.backend_degraded`: a database blip must not lock merchants
 *     out of sign-in or the POS.
 *   fail_closed (refund / reversal / correction) — the limiter throws
 *     RateLimitUnavailableError (public 503) before the caller mutates
 *     anything, logs `rate_limit.backend_unavailable_fail_closed`, and never
 *     consults the memory store.
 *
 * Readiness (scripts/verify-readiness.ts) fails while consume_rate_limit is
 * absent, so a degraded limiter is never mistaken for a working one.
 *
 * Server-only.
 */
import { serverLog } from "@/server/observability/logger";
import { RateLimitedError, RateLimitUnavailableError } from "./errors";
import { bucketKey } from "./keys";
import type { BackendFailurePolicy, RateLimitRule } from "./policies";
import {
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  RateLimitBackendError,
  type RateLimitStore,
} from "./store";

export interface RateLimitCheck {
  rule: RateLimitRule;
  /** Scope of the bucket. Any empty/null part skips this check. */
  parts: ReadonlyArray<string | null | undefined>;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the blocking bucket resets; 0 when allowed. */
  retryAfterSeconds: number;
  /** Rule id of the bucket that refused, when not allowed. */
  blockedBy?: string;
  /** True when at least one check fell back to the per-process store. */
  degraded: boolean;
}

let primaryStore: RateLimitStore = new PostgresRateLimitStore();
const fallbackStore = new MemoryRateLimitStore();

/** Test hook: swap the primary store. Returns a restore function. */
export function setPrimaryRateLimitStore(store: RateLimitStore): () => void {
  const previous = primaryStore;
  primaryStore = store;
  return () => {
    primaryStore = previous;
  };
}

const DEGRADED_LOG_INTERVAL_MS = 60_000;
let lastDegradedLogAt = 0;

/** Test hook: forget every hit recorded by the per-process fallback store. */
export function resetRateLimitFallbackStore(): void {
  fallbackStore.clear();
  lastDegradedLogAt = 0;
}

function logDegraded(error: unknown, ruleId: string): void {
  const now = Date.now();
  if (now - lastDegradedLogAt < DEGRADED_LOG_INTERVAL_MS) return;
  lastDegradedLogAt = now;
  serverLog.warn("rate_limit.backend_degraded", {
    ruleId,
    backend: "memory",
    reason: error instanceof RateLimitBackendError ? error.reason : "backend_error",
  });
}

export interface RateLimitOptions {
  /** What to do when the durable backend fails. Default: memory_fallback. */
  onBackendFailure?: BackendFailurePolicy;
  /**
   * Log `rate_limit.exceeded` for every refused hit. Default true. A caller
   * whose refusals are themselves the flood (perf telemetry) turns it off and
   * logs its own throttled summary.
   */
  logExceeded?: boolean;
}

export async function checkRateLimits(
  checks: readonly RateLimitCheck[],
  nowMs?: number,
  options: RateLimitOptions = {},
): Promise<RateLimitDecision> {
  const policy = options.onBackendFailure ?? "memory_fallback";
  let degraded = false;
  for (const check of checks) {
    if (check.parts.length === 0 || check.parts.some((part) => !part)) continue;
    const key = await bucketKey(check.rule.id, check.parts as readonly string[]);

    let hit;
    try {
      hit = await primaryStore.hit(key, check.rule, nowMs);
    } catch (error) {
      if (policy === "fail_closed") {
        serverLog.error("rate_limit.backend_unavailable_fail_closed", {
          ruleId: check.rule.id,
          reason: error instanceof RateLimitBackendError ? error.reason : "backend_error",
        });
        throw new RateLimitUnavailableError();
      }
      degraded = true;
      logDegraded(error, check.rule.id);
      hit = await fallbackStore.hit(key, check.rule, nowMs);
    }

    if (!hit.allowed) {
      if (options.logExceeded !== false) {
        serverLog.warn("rate_limit.exceeded", {
          ruleId: check.rule.id,
          limit: check.rule.limit,
          windowSeconds: check.rule.windowSeconds,
          retryAfterSeconds: hit.retryAfterSeconds,
          degraded,
        });
      }
      return {
        allowed: false,
        retryAfterSeconds: hit.retryAfterSeconds,
        blockedBy: check.rule.id,
        degraded,
      };
    }
  }
  return { allowed: true, retryAfterSeconds: 0, degraded };
}

/**
 * Throws RateLimitedError (429) when any bucket is full, and
 * RateLimitUnavailableError (503) when the backend is down under fail_closed.
 */
export async function enforceRateLimits(
  checks: readonly RateLimitCheck[],
  nowMs?: number,
  options: RateLimitOptions = {},
): Promise<void> {
  const decision = await checkRateLimits(checks, nowMs, options);
  if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
}
