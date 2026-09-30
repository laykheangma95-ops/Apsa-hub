/**
 * Server ingestion for browser navigation timing — staging/development
 * diagnostics ONLY. Called by recordNavigationTimingFn (src/api/perf-telemetry.ts).
 *
 * Gate: the same as server perf instrumentation (perf.ts) — OFF unless
 * APSA_PERF_INSTRUMENTATION=true, and always OFF when VERCEL_ENV=production.
 * When OFF, the body is not even parsed and nothing is logged.
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
import { serverLog } from "./logger";
import { isPerfInstrumentationEnabled } from "./perf";

type Env = Record<string, string | undefined>;

export const NAVIGATION_LOG_EVENT = "perf.navigation";

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

/** Returns true when a line was logged. Never throws. */
export function ingestNavigationTelemetry(input: unknown, env?: Env): boolean {
  try {
    if (!isPerfInstrumentationEnabled(env)) return false;
    const record = parseNavigationTelemetry(input);
    if (!record) return false;
    serverLog.info(NAVIGATION_LOG_EVENT, buildNavigationLogFields(record));
    return true;
  } catch {
    // Diagnostics must never surface an error to the caller.
    return false;
  }
}
