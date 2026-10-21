/**
 * Reconciliation timing — the numbers migration 064 §2a's SQL and
 * reconcile.ts use, in one dependency-free module so docs and tests can
 * reason about them (the SQL suite checks these mirrors against the real
 * functions). These are TARGETS under stated conditions, never a worst-case
 * bound: see the timing note in reconcile.ts.
 */

/** The schedule this design assumes (configured outside the app). */
export const RECONCILE_RUN_INTERVAL_MS = 5 * 60 * 1000;
export const RECONCILE_BATCH_LIMIT = 25;
export const RECONCILE_RUN_BUDGET_MS = 45_000;
/** Consecutive failed checks from which every run raises an operator alert. */
export const RECONCILE_ALERT_AFTER = 3;

// Mirrors of migration 064 §2a's SQL timing, used by docs and tests (the
// tests check them against the real functions).
/** Healthy re-check interval (record_channel_reconcile). */
export const RECONCILE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** How long one run's claim owns a row (claim_channel_reconcile_batch). */
export const RECONCILE_CLAIM_MS = 2 * 60 * 1000;
export const RECONCILE_BACKOFF_CAP_MS = 60 * 60 * 1000;

/** Delay before the next check after a failure, given failures recorded BEFORE it. */
export function reconcileBackoffMs(failuresBefore: number): number {
  return Math.min(RECONCILE_BACKOFF_CAP_MS, 60_000 * 2 ** Math.min(Math.max(failuresBefore, 0), 6));
}

/** Runs needed to check N connections that are all due, at full per-run capacity. */
export function backlogRuns(dueConnections: number): number {
  return Math.ceil(Math.max(dueConnections, 0) / RECONCILE_BATCH_LIMIT);
}

/**
 * The effective re-check interval for N live connections at full capacity:
 * the healthy interval, or longer when one interval's worth of runs cannot
 * cover them all.
 */
export function steadyStateCheckIntervalMs(liveConnections: number): number {
  return Math.max(
    RECONCILE_CHECK_INTERVAL_MS,
    backlogRuns(liveConnections) * RECONCILE_RUN_INTERVAL_MS,
  );
}
