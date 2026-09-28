/**
 * Rate-limit counter stores.
 *
 * Window semantics (identical in both stores): a bucket's window starts at its
 * FIRST hit and lasts `windowSeconds`. Every hit inside the window increments
 * the count; the first hit at or after the window's end starts a new window
 * with count 1. A hit is allowed while count ≤ limit. Denied hits still count
 * but never extend the window, so a blocked caller is released on schedule.
 *
 *   PostgresRateLimitStore — THE production store. One atomic
 *     INSERT … ON CONFLICT DO UPDATE per hit inside consume_rate_limit()
 *     (migration 045). Correct across any number of serverless instances,
 *     cold starts and concurrent requests: the row lock serializes hits on
 *     one bucket, and every instance sees the same counter.
 *
 *   MemoryRateLimitStore — per-process only. Used (a) by tests and (b) as the
 *     DEGRADED fallback when the database store is unreachable or migration
 *     045 is not applied. It is NOT a distributed limiter: under N instances
 *     the effective limit is up to N × limit, and a cold start resets it.
 *     Every fallback use is logged as `rate_limit.backend_degraded`.
 *
 * Server-only.
 */
import type { RateLimitRule } from "./policies";

export interface RateLimitHit {
  allowed: boolean;
  count: number;
  /** Seconds until this bucket's window ends (≥ 1 when denied). */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  readonly name: "postgres" | "memory";
  hit(key: string, rule: RateLimitRule, nowMs?: number): Promise<RateLimitHit>;
}

// ── Memory ────────────────────────────────────────────────────────────────────

const MEMORY_MAX_BUCKETS = 10_000;

export class MemoryRateLimitStore implements RateLimitStore {
  readonly name = "memory" as const;
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async hit(key: string, rule: RateLimitRule, nowMs: number = Date.now()): Promise<RateLimitHit> {
    const windowMs = rule.windowSeconds * 1000;
    const existing = this.buckets.get(key);
    let bucket: { count: number; expiresAt: number };
    if (!existing || nowMs >= existing.expiresAt) {
      bucket = { count: 1, expiresAt: nowMs + windowMs };
      this.buckets.delete(key);
      this.prune(nowMs);
      this.buckets.set(key, bucket);
    } else {
      existing.count += 1;
      bucket = existing;
    }
    const allowed = bucket.count <= rule.limit;
    return {
      allowed,
      count: bucket.count,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - nowMs) / 1000)),
    };
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(nowMs: number): void {
    if (this.buckets.size < MEMORY_MAX_BUCKETS) return;
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.expiresAt) this.buckets.delete(key);
    }
    while (this.buckets.size >= MEMORY_MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────

interface ConsumeRateLimitResult {
  allowed?: unknown;
  hit_count?: unknown;
  retry_after_seconds?: unknown;
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export class RateLimitBackendError extends Error {
  constructor(readonly reason: string) {
    super(`rate limit backend unavailable: ${reason}`);
    this.name = "RateLimitBackendError";
  }
}

/**
 * Upper bound on one limiter round-trip. A slow database must not stall
 * sign-in or checkout behind the limiter: past this, the hit degrades to the
 * memory store (and is logged as such).
 */
export const POSTGRES_RATE_LIMIT_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new RateLimitBackendError("timeout")), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class PostgresRateLimitStore implements RateLimitStore {
  readonly name = "postgres" as const;

  constructor(
    private readonly client?: RpcClient,
    private readonly timeoutMs: number = POSTGRES_RATE_LIMIT_TIMEOUT_MS,
  ) {}

  private async resolveClient(): Promise<RpcClient> {
    if (this.client) return this.client;
    // Dynamic import: the service-role client never enters any browser chunk.
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    const candidate = supabaseAdmin as unknown as Partial<RpcClient>;
    if (typeof candidate.rpc !== "function") throw new RateLimitBackendError("no_rpc_client");
    return candidate as RpcClient;
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitHit> {
    const client = await this.resolveClient();
    const { data, error } = await withTimeout(
      client.rpc("consume_rate_limit", {
        p_bucket_key: key,
        p_rule_id: rule.id,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      }),
      this.timeoutMs,
    );
    if (error) {
      // Code only — never the message (it can quote the call).
      throw new RateLimitBackendError(error.code || "rpc_error");
    }
    const result = (data ?? {}) as ConsumeRateLimitResult;
    if (
      typeof result.allowed !== "boolean" ||
      typeof result.hit_count !== "number" ||
      typeof result.retry_after_seconds !== "number"
    ) {
      throw new RateLimitBackendError("malformed_result");
    }
    return {
      allowed: result.allowed,
      count: result.hit_count,
      retryAfterSeconds: Math.max(1, Math.ceil(result.retry_after_seconds)),
    };
  }
}
