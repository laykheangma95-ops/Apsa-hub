/**
 * APSA — migration HISTORY proof (pure functions; no I/O).
 *
 * Question answered: "has the hosted database applied EVERY migration in this
 * checkout — 001, 002, …, 045 — with none missing, none out of order and none
 * unknown?"
 *
 * Why not object evidence alone (scripts/lib/migration-level.ts)? Because an
 * ALTER-only migration (a column, a constraint, a policy, a grant) leaves no
 * table or RPC behind: a database can expose every object the latest
 * migration creates while an earlier ALTER-only migration never ran. Object
 * evidence cannot see that gap; a ledger can.
 *
 * The ledger is the Supabase CLI's own supabase_migrations.schema_migrations,
 * written by `supabase db push` / `supabase migration up` as each file is
 * applied (version = the file's numeric prefix). It is read over the service
 * role through apsa_migration_history() (migration 045). No historical
 * migration file records itself and nothing is back-filled, so the history is
 * exactly as truthful as the tool that applied the files.
 *
 * Verdict rules — READY only when ALL hold:
 *   - the ledger exists ("available": true)       else history_unavailable
 *   - every repository version is recorded        else behind / out_of_order
 *   - no recorded version is unknown to the repo  else unknown_versions
 * "out_of_order": a version is missing while a LATER one is recorded — the
 * contiguous chain is broken below the latest applied migration.
 * "behind": the recorded versions are exactly a prefix of the repository's.
 */

const MIGRATION_FILE_RE = /^(\d+)_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;

/** Repository migration versions in application order ("001", "002", …). */
export function repositoryMigrationVersions(files: readonly string[]): string[] {
  const versions = files
    .map((file) => MIGRATION_FILE_RE.exec(file)?.[1])
    .filter((v): v is string => Boolean(v));
  const unique = new Set(versions);
  if (unique.size !== versions.length) {
    throw new Error("Duplicate migration version prefix in supabase/migrations.");
  }
  return versions.sort((a, b) => Number(a) - Number(b));
}

export interface MigrationHistory {
  available: boolean;
  versions: string[];
}

/** Validates the apsa_migration_history() payload; null when malformed. */
export function parseMigrationHistory(payload: unknown): MigrationHistory | null {
  if (payload == null || typeof payload !== "object") return null;
  const { available, versions } = payload as { available?: unknown; versions?: unknown };
  if (typeof available !== "boolean" || !Array.isArray(versions)) return null;
  if (!versions.every((v) => typeof v === "string" && /^\d{1,14}$/.test(v))) return null;
  return { available, versions: versions as string[] };
}

export type MigrationHistoryReason =
  "complete" | "malformed" | "history_unavailable" | "behind" | "out_of_order" | "unknown_versions";

export interface MigrationHistoryReport {
  ready: boolean;
  /** Every failed rule (empty when ready). "complete" only when ready. */
  reasons: MigrationHistoryReason[];
  expectedLatest: string | null;
  /** Last version of the unbroken 001…N prefix that is recorded; null if none. */
  contiguousThrough: string | null;
  /** Repository versions the ledger does not record, in order. */
  missing: string[];
  /** Recorded versions AFTER the first missing one — applied out of order. */
  presentAfterGap: string[];
  /** Recorded versions that this checkout has no file for. */
  unknown: string[];
}

export function evaluateMigrationHistory(
  expectedVersions: readonly string[],
  payload: unknown,
): MigrationHistoryReport {
  const expectedLatest = expectedVersions.at(-1) ?? null;
  const history = parseMigrationHistory(payload);
  const empty = { missing: [], presentAfterGap: [], unknown: [], contiguousThrough: null };
  if (!history) return { ready: false, reasons: ["malformed"], expectedLatest, ...empty };
  if (!history.available) {
    return {
      ready: false,
      reasons: ["history_unavailable"],
      expectedLatest,
      ...empty,
      missing: [...expectedVersions],
    };
  }

  const recorded = new Set(history.versions);
  const expected = new Set(expectedVersions);
  const missing = expectedVersions.filter((v) => !recorded.has(v));
  const firstGap = expectedVersions.findIndex((v) => !recorded.has(v));
  const presentAfterGap =
    firstGap < 0 ? [] : expectedVersions.slice(firstGap + 1).filter((v) => recorded.has(v));
  const unknown = [...recorded]
    .filter((v) => !expected.has(v))
    .sort((a, b) => Number(a) - Number(b));
  const contiguousThrough =
    firstGap < 0 ? expectedLatest : firstGap === 0 ? null : expectedVersions[firstGap - 1]!;

  const reasons: MigrationHistoryReason[] = [];
  if (presentAfterGap.length > 0) reasons.push("out_of_order");
  else if (missing.length > 0) reasons.push("behind");
  if (unknown.length > 0) reasons.push("unknown_versions");

  const ready = reasons.length === 0 && expectedVersions.length > 0;
  return {
    ready,
    reasons: ready ? ["complete"] : reasons,
    expectedLatest,
    contiguousThrough,
    missing,
    presentAfterGap,
    unknown,
  };
}

export interface CombinedMigrationEvidence {
  /** The ledger verdict — REQUIRED. */
  history: MigrationHistoryReport;
  /** Object evidence (migration-level.ts): latest observable footprint present. */
  objectsAtExpected: boolean;
  /** Object evidence: objects of migrations after the first object gap exist. */
  objectsOutOfOrder: boolean;
}

/**
 * The migration part of readiness. The history is the proof; object evidence
 * is a cross-check that can only VETO (a ledger claiming a migration whose
 * objects are absent), never stand in for a missing or incomplete history.
 */
export function migrationsReady(evidence: CombinedMigrationEvidence): boolean {
  return evidence.history.ready && evidence.objectsAtExpected && !evidence.objectsOutOfOrder;
}
