/**
 * Server ingestion for browser navigation timing — staging/development
 * diagnostics ONLY. Called by recordNavigationTimingFn (src/api/perf-telemetry.ts).
 *
 * Gate: the same as server perf instrumentation (perf.ts) — OFF unless
 * APSA_PERF_INSTRUMENTATION=true AND APSA_RUNTIME_ENV=staging.
 * When OFF, the body is not even parsed and nothing is logged.
 *
 * Abuse bound: when ON, every request (valid or not) first passes the durable
 * limiter (src/server/rate-limit, PR #79) — a per-client-IP bucket, keyed only
 * from the operator-trusted RATE_LIMIT_CLIENT_IP_HEADER and skipped when the
 * IP is unknown, plus a global backstop bucket that needs no header. A refused
 * request is dropped exactly like an invalid one: no per-request log line, no
 * error, nothing for the caller to see or retry; one throttled
 * `perf.navigation.rate_limited` line per instance per minute records that
 * drops happened. The IP is only an HMAC bucket-key input — never logged or
 * stored, and never added to the telemetry line. A limiter failure also drops
 * the record (fail safe). When OFF the limiter is not consulted at all.
 *
 * Body size: the 512-character ceiling (MAX_PAYLOAD_CHARS) applies after the
 * framework parsed the body; the platform's own request-body cap bounds the
 * raw request. For a staging-only diagnostic that is off by default, the
 * limiter (bounds how many bodies are parsed) plus the strict schema (bounds
 * what is logged) is the proportionate control — no custom body parser.
 *
 * When ON, a payload that fails the allowlist schema
 * (src/lib/perf/navigation-telemetry.ts) is dropped silently: no log line, no
 * echo, no error for the caller. A valid one becomes exactly one
 * `perf.navigation` log line holding only the schema's fields — no user,
 * organization, session, IP or user-agent field is ever added here.
 *
 * Log field names: `contentMs` is written as `readyMs` because the redacting
 * logger masks any key with a `content` segment, and weakening redaction for a
 * diagnostic is not an option.
 *
 * Server-only (imports perf.ts → request-context.ts → node:async_hooks).
 */
import {
  parseNavigationTelemetry,
  type NavigationTelemetry,
} from "@/lib/perf/navigation-telemetry";
import { currentClientIp } from "@/server/rate-limit/client-ip";
import { checkRateLimits } from "@/server/rate-limit/limiter";
import { BACKEND_FAILURE_POLICY, RATE_LIMITS } from "@/server/rate-limit/policies";
import { serverLog } from "./logger";
import { isPerfInstrumentationEnabled } from "./perf";

type Env = Record<string, string | undefined>;

export const NAVIGATION_LOG_EVENT = "perf.navigation";
export const NAVIGATION_RATE_LIMITED_EVENT = "perf.navigation.rate_limited";

const RATE_LIMITED_LOG_INTERVAL_MS = 60_000;
let lastRateLimitedLogAt = 0;

/** Test hook: forget when the last rate-limited summary was logged. */
export function resetNavigationTelemetryRateLimitLog(): void {
  lastRateLimitedLogAt = 0;
}

export interface NavigationTelemetryIngestOptions {
  /** Request source for the IP bucket. Default: currentClientIp() (trusted header only). */
  clientIp?: () => Promise<string | null>;
  nowMs?: number;
}

/** True when this request may be logged; false drops it. Throws only on limiter bugs. */
async function withinTelemetryRateLimit(
  options: NavigationTelemetryIngestOptions,
): Promise<boolean> {
  const ip = await (options.clientIp ?? currentClientIp)();
  const decision = await checkRateLimits(
    [
      { rule: RATE_LIMITS.perfTelemetryIp, parts: [ip] },
      { rule: RATE_LIMITS.perfTelemetryGlobal, parts: ["all"] },
    ],
    options.nowMs,
    { onBackendFailure: BACKEND_FAILURE_POLICY.perfTelemetry, logExceeded: false },
  );
  if (decision.allowed) return true;
  const now = options.nowMs ?? Date.now();
  if (now - lastRateLimitedLogAt >= RATE_LIMITED_LOG_INTERVAL_MS) {
    lastRateLimitedLogAt = now;
    serverLog.warn(NAVIGATION_RATE_LIMITED_EVENT, { ruleId: decision.blockedBy ?? "unknown" });
  }
  return false;
}

/** Validated record → log fields. Pure — exported for tests. */
export function buildNavigationLogFields(
  record: NavigationTelemetry,
): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {
    from: record.from,
    to: record.to,
    tracked: record.tracked,
  };
  if (record.navigateMs !== undefined) fields["navigateMs"] = record.navigateMs;
  if (record.pendingMs !== undefined) fields["pendingMs"] = record.pendingMs;
  if (record.loadedMs !== undefined) fields["loadedMs"] = record.loadedMs;
  if (record.renderedMs !== undefined) fields["renderedMs"] = record.renderedMs;
  if (record.contentMs !== undefined) fields["readyMs"] = record.contentMs;
  if (record.viewport !== undefined) fields["viewport"] = record.viewport;
  if (record.locale !== undefined) fields["locale"] = record.locale;
  if (record.clientTs !== undefined) fields["clientTs"] = record.clientTs;
  return fields;
}

/** Resolves true when a line was logged. Never rejects. */
export async function ingestNavigationTelemetry(
  input: unknown,
  env?: Env,
  options: NavigationTelemetryIngestOptions = {},
): Promise<boolean> {
  try {
    if (!isPerfInstrumentationEnabled(env)) return false;
    if (!(await withinTelemetryRateLimit(options))) return false;
    const record = parseNavigationTelemetry(input);
    if (!record) return false;
    serverLog.info(NAVIGATION_LOG_EVENT, buildNavigationLogFields(record));
    return true;
  } catch {
    // Diagnostics must never surface an error to the caller.
    return false;
  }
}
