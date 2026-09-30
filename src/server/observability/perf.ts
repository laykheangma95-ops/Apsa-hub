/**
 * Server latency instrumentation — staging/development diagnostics ONLY.
 *
 * Purpose: measure where a server-function call spends its time (session
 * validation, active-organization resolution, membership/role/permission
 * lookups, and everything else) before any auth or guard behavior is changed
 * for speed. It observes; it never decides anything.
 *
 * Gate: ON only when the server environment sets BOTH
 * APSA_PERF_INSTRUMENTATION=true AND APSA_RUNTIME_ENV=staging (exact values).
 * Anything else — either variable missing, empty or any other value — is OFF.
 * VERCEL_ENV is deliberately not consulted: the dedicated staging project runs
 * in Vercel's Production slot (VERCEL_ENV=production), and the real production
 * project stays OFF because it never sets APSA_RUNTIME_ENV=staging. There is
 * no default runtime value and no hostname/branch detection. Both variables
 * are deliberately NOT `VITE_`-prefixed: they are server-only configuration
 * and must never be inlined into a browser bundle.
 *
 * When OFF, `timePhase` returns `fn()` itself — the very same promise, no
 * wrapper, no clock read — and the server-function boundary opens no collector.
 * When ON, a phase's return value and any thrown error pass through untouched;
 * only its duration is recorded.
 *
 * What a `perf.server_function` line carries: the request ID, the server
 * function name and its API domain, integer-ish millisecond durations, per-
 * phase call counts and an ok/error outcome. Never a user ID, organization ID,
 * email, phone, name, token, key, SQL text or error message. The line still
 * goes through the redacting logger (src/server/observability/logger.ts), and
 * every field name below is chosen so redaction leaves it readable.
 *
 * Server-only. Never import this from browser-bundled code (it reaches
 * node:async_hooks through request-context.ts); files that are also bundled
 * for the browser import it dynamically inside server handlers.
 */
import { currentRequestContext } from "./request-context";
import { serverLog } from "./logger";

export const PERF_FLAG = "APSA_PERF_INSTRUMENTATION";
/** Server-only runtime marker; instrumentation requires exactly STAGING_RUNTIME. */
export const RUNTIME_ENV_VAR = "APSA_RUNTIME_ENV";
export const STAGING_RUNTIME = "staging";

/**
 * Every phase that can be timed. The value is the log field its total lands
 * in (`<field>Ms`, plus `<field>Count` when it ran more than once).
 */
export const PERF_PHASES = {
  /** getSessionFn end to end: cookie read, getUser, optional refresh. */
  "session.total": "identity",
  /** Supabase auth.getUser() — the access-token validation round trip. */
  "session.getUser": "getUser",
  /** Supabase auth.refreshSession() when the access token had expired. */
  "session.refresh": "refresh",
  /** /app guard: the memberships read that picks the active organization. */
  "guard.memberships": "guardMemberships",
  /** resolveActiveOrganizationId (src/server/auth/active-organization.ts). */
  "authz.activeOrganization": "activeOrg",
  /** verifyActiveMembership end to end (src/server/auth/membership.ts). */
  "authz.verifyMembership": "membership",
  /** verifyActiveMembership: the memberships row read. */
  "authz.membershipRow": "membershipRow",
  /** verifyActiveMembership: the roles read. */
  "authz.roles": "roles",
  /** verifyActiveMembership: the role_permissions read. */
  "authz.rolePermissions": "rolePermissions",
  /** verifyActiveMembership: the permissions read. */
  "authz.permissions": "permissions",
} as const;

export type PerfPhase = keyof typeof PERF_PHASES;

/**
 * Phases that together are "authorization" for a server-function call. Sub-
 * phases (getUser, roles, …) are nested inside these and are NOT added again.
 */
const AUTHZ_TOP_LEVEL: readonly PerfPhase[] = [
  "session.total",
  "guard.memberships",
  "authz.activeOrganization",
  "authz.verifyMembership",
];

export interface PerfCollector {
  readonly startedAt: number;
  readonly phases: Map<PerfPhase, { ms: number; count: number }>;
}

type Env = Record<string, string | undefined>;

function defaultEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** True only when explicitly enabled on an explicitly staging runtime. */
export function isPerfInstrumentationEnabled(env: Env = defaultEnv()): boolean {
  return env[PERF_FLAG] === "true" && env[RUNTIME_ENV_VAR] === STAGING_RUNTIME;
}

function now(): number {
  return performance.now();
}

export function createPerfCollector(): PerfCollector {
  return { startedAt: now(), phases: new Map() };
}

function record(collector: PerfCollector, phase: PerfPhase, ms: number): void {
  const entry = collector.phases.get(phase);
  if (entry) {
    entry.ms += ms;
    entry.count += 1;
  } else {
    collector.phases.set(phase, { ms, count: 1 });
  }
}

/**
 * Time one phase of the current server-function call.
 *
 * Without an active collector (instrumentation off, or outside a server-
 * function boundary) this is exactly `fn()`. With one, the result or error of
 * `fn()` is passed through unchanged; recording can never throw into it.
 */
export function timePhase<T>(phase: PerfPhase, fn: () => Promise<T>): Promise<T> {
  const collector = currentRequestContext()?.perf;
  if (!collector) return fn();
  const started = now();
  const stop = () => {
    try {
      record(collector, phase, now() - started);
    } catch {
      // Measuring must never change the outcome it measures.
    }
  };
  return fn().then(
    (value) => {
      stop();
      return value;
    },
    (error: unknown) => {
      stop();
      throw error;
    },
  );
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** The log fields for one finished call. Pure — exported for tests. */
export function buildPerfFields(
  collector: PerfCollector,
  outcome: "ok" | "error",
  endedAt: number = now(),
): Record<string, string | number> {
  const totalMs = Math.max(0, endedAt - collector.startedAt);
  const fields: Record<string, string | number> = {};

  let authzMs = 0;
  for (const [phase, { ms, count }] of collector.phases) {
    const field = PERF_PHASES[phase];
    fields[`${field}Ms`] = round(ms);
    if (count > 1) fields[`${field}Count`] = count;
    if (AUTHZ_TOP_LEVEL.includes(phase)) authzMs += ms;
  }

  fields["authzMs"] = round(authzMs);
  // Everything outside the measured authorization chain: the domain queries,
  // plus module loading and serialization inside the handler.
  fields["queryMs"] = round(Math.max(0, totalMs - authzMs));
  fields["totalMs"] = round(totalMs);
  fields["outcome"] = outcome;
  return fields;
}

/**
 * Run a server function's body under an already-open collector and write one
 * `perf.server_function` line when it settles. The body's value or error is
 * returned/rethrown unchanged.
 */
export async function measureServerFn<T>(
  collector: PerfCollector,
  next: () => Promise<T>,
): Promise<T> {
  let outcome: "ok" | "error" = "error";
  try {
    const value = await next();
    outcome = "ok";
    return value;
  } finally {
    emitServerFnPerf(collector, outcome);
  }
}

function emitServerFnPerf(collector: PerfCollector, outcome: "ok" | "error"): void {
  try {
    const context = currentRequestContext();
    const route =
      context?.domain && context.operation
        ? `${context.domain}.${context.operation}`
        : (context?.operation ?? "unknown");
    serverLog.info("perf.server_function", { route, ...buildPerfFields(collector, outcome) });
  } catch {
    // Logging must never break the operation it describes.
  }
}
