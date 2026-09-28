/**
 * APSA — migration LEVEL evidence (pure functions; no I/O).
 *
 * Question answered: "which repository migration has the hosted database
 * demonstrably reached?" — reported as
 *
 *   EXPECTED: 045 (045_operability_rate_limits_webhooks.sql)
 *   HOSTED:   008 (008_audit_logs.sql)
 *
 * Supabase does not reliably expose its migration history over REST, and a
 * project whose migrations were applied through the SQL editor has none. So the
 * hosted level is derived from EVIDENCE instead: each migration's observable
 * footprint (the public tables and callable functions it creates) is checked
 * against the surface the hosted PostgREST API actually exposes. The hosted
 * level is the last migration, in order, whose whole footprint is present.
 *
 * Honest limits, reported rather than hidden:
 *   - A migration that only ALTERs (adds a column, a constraint, a policy) has
 *     no observable footprint here. It is listed as `unobservable` and neither
 *     raises nor lowers the level on its own.
 *   - Presence proves an object exists, not that its body matches this
 *     checkout. Body parity is what supabase/hosted-migrations.lock.json and
 *     scripts/check-migration-safety.ts are for.
 */

const MIGRATION_FILE_RE = /^(\d+)_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const DROP_TABLE_RE =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const CREATE_FUNCTION_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const DROP_FUNCTION_RE =
  /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function isPublic(schema: string | undefined): boolean {
  return schema === undefined || schema.toLowerCase() === "public";
}

export interface MigrationFootprint {
  file: string;
  number: number;
  /** Public tables this migration creates (and no later migration drops). */
  tables: string[];
  /** Public, non-trigger functions this migration creates (and none later drops). */
  functions: string[];
}

/**
 * Footprints for every migration, supplied in application order. Trigger
 * functions are excluded: PostgREST never exposes them as RPCs.
 */
export function collectMigrationFootprints(
  files: readonly string[],
  contents: readonly string[],
): MigrationFootprint[] {
  const footprints: MigrationFootprint[] = [];
  const tableOwner = new Map<string, MigrationFootprint>();
  const functionOwner = new Map<string, MigrationFootprint>();

  files.forEach((file, index) => {
    const match = MIGRATION_FILE_RE.exec(file);
    const sql = stripSqlComments(contents[index] ?? "");
    const footprint: MigrationFootprint = {
      file,
      number: match?.[1] ? Number(match[1]) : Number.NaN,
      tables: [],
      functions: [],
    };

    for (const m of sql.matchAll(DROP_TABLE_RE)) {
      const name = m[2]?.toLowerCase();
      if (!name || !isPublic(m[1])) continue;
      const owner = tableOwner.get(name);
      if (owner) owner.tables = owner.tables.filter((t) => t !== name);
      tableOwner.delete(name);
    }
    for (const m of sql.matchAll(DROP_FUNCTION_RE)) {
      const name = m[2]?.toLowerCase();
      if (!name || !isPublic(m[1])) continue;
      const owner = functionOwner.get(name);
      if (owner) owner.functions = owner.functions.filter((f) => f !== name);
      functionOwner.delete(name);
    }
    for (const m of sql.matchAll(CREATE_TABLE_RE)) {
      const name = m[2]?.toLowerCase();
      if (!name || !isPublic(m[1]) || tableOwner.has(name)) continue;
      footprint.tables.push(name);
      tableOwner.set(name, footprint);
    }
    for (const m of sql.matchAll(CREATE_FUNCTION_RE)) {
      const name = m[2]?.toLowerCase();
      if (!name || !isPublic(m[1]) || functionOwner.has(name)) continue;
      // The RETURNS clause follows the parameter list; look ahead to the body.
      const rest = sql.slice((m.index ?? 0) + m[0].length);
      const bodyStart = rest.search(/\bAS\s+\$|\$\$/i);
      const header = bodyStart >= 0 ? rest.slice(0, bodyStart) : rest.slice(0, 2000);
      if (/RETURNS\s+(?:SETOF\s+)?TRIGGER\b/i.test(header)) continue;
      footprint.functions.push(name);
      functionOwner.set(name, footprint);
    }
    footprints.push(footprint);
  });

  return footprints;
}

export interface HostedSurface {
  tables: ReadonlySet<string>;
  functions: ReadonlySet<string>;
}

/**
 * The tables and RPCs a PostgREST OpenAPI document (GET /rest/v1/ with the
 * service-role key) exposes. Paths look like "/orders" and "/rpc/create_order_v2".
 */
export function parseOpenApiSurface(document: unknown): HostedSurface {
  const tables = new Set<string>();
  const functions = new Set<string>();
  const paths =
    document && typeof document === "object" && "paths" in document
      ? (document as { paths?: Record<string, unknown> }).paths
      : undefined;
  for (const key of Object.keys(paths ?? {})) {
    const rpc = /^\/rpc\/([a-z_][a-z0-9_]*)$/i.exec(key);
    if (rpc?.[1]) functions.add(rpc[1].toLowerCase());
    else {
      const table = /^\/([a-z_][a-z0-9_]*)$/i.exec(key);
      if (table?.[1]) tables.add(table[1].toLowerCase());
    }
  }
  return { tables, functions };
}

export interface MissingObject {
  file: string;
  kind: "table" | "function";
  name: string;
}

export interface MigrationLevelReport {
  expected: { number: number; file: string } | null;
  /** Last migration whose whole footprint is present; null when not even the first is. */
  hosted: { number: number; file: string } | null;
  /** True when hosted has reached the expected (latest observable) migration. */
  atExpected: boolean;
  /** The first object that is missing, in migration order. */
  firstMissing: MissingObject | null;
  /** Migrations with no observable footprint (ALTER-only). */
  unobservable: string[];
  /** Migrations AFTER the first gap whose footprint is (partly) present — out-of-order apply. */
  presentBeyondGap: string[];
}

export function computeMigrationLevel(
  footprints: readonly MigrationFootprint[],
  surface: HostedSurface,
): MigrationLevelReport {
  const numbered = footprints.filter((f) => Number.isFinite(f.number));
  const observable = numbered.filter((f) => f.tables.length + f.functions.length > 0);
  const lastObservable = observable.at(-1);
  const last = numbered.at(-1);
  const expected = last ? { number: last.number, file: last.file } : null;

  let hosted: MigrationLevelReport["hosted"] = null;
  let firstMissing: MissingObject | null = null;
  const presentBeyondGap: string[] = [];

  for (const footprint of observable) {
    const missingTable = footprint.tables.find((t) => !surface.tables.has(t));
    const missingFunction = footprint.functions.find((f) => !surface.functions.has(f));
    const complete = !missingTable && !missingFunction;

    if (firstMissing) {
      const anyPresent =
        footprint.tables.some((t) => surface.tables.has(t)) ||
        footprint.functions.some((f) => surface.functions.has(f));
      if (anyPresent) presentBeyondGap.push(footprint.file);
      continue;
    }
    if (complete) {
      hosted = { number: footprint.number, file: footprint.file };
      continue;
    }
    firstMissing = missingTable
      ? { file: footprint.file, kind: "table", name: missingTable }
      : { file: footprint.file, kind: "function", name: missingFunction! };
  }

  return {
    expected,
    hosted,
    atExpected: Boolean(lastObservable && hosted && hosted.number === lastObservable.number),
    firstMissing,
    unobservable: numbered
      .filter((f) => f.tables.length + f.functions.length === 0)
      .map((f) => f.file),
    presentBeyondGap,
  };
}

export function formatMigrationNumber(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value).padStart(3, "0")
    : "none";
}

/** Every RPC name the application calls: `.rpc("name"` across the given sources. */
export function collectCalledRpcs(sources: readonly string[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/\.rpc\(\s*["']([a-z_][a-z0-9_]*)["']/g)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names].sort();
}
