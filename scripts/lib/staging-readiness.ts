/**
 * APSA — Staging readiness: pure analysis functions.
 *
 * This module is deliberately free of I/O, network access and process exit
 * handling so that every rule below can be unit-tested directly. The CLI
 * wrapper (scripts/check-staging-readiness.ts) reads files and prints; this
 * module only decides.
 *
 * Nothing here reads or returns a secret value. Environment handling is
 * presence-only by construction: checkEnvPresence() returns booleans, never
 * the values it inspected.
 */

// ── Migration inventory ──────────────────────────────────────────────────────

export interface MigrationEntry {
  /** File name, e.g. "023_orders.sql". */
  file: string;
  /** Leading numeric prefix as written, e.g. "023". */
  prefix: string;
  /** Numeric value of the prefix, e.g. 23. */
  number: number;
}

export interface MigrationInventory {
  /** Well-formed migrations, ordered by number then file name. */
  entries: MigrationEntry[];
  /** Files that do not follow the NNN_description.sql convention. */
  malformed: string[];
  /** Numbers used by more than one file — always a blocking condition. */
  duplicates: Array<{ prefix: string; files: string[] }>;
  /** Numbers absent from an otherwise contiguous range (informational). */
  gaps: number[];
}

const MIGRATION_NAME_RE = /^(\d+)_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;

/**
 * Build the ordered local migration inventory from a list of file names.
 *
 * Ordering is numeric, not lexicographic: "9_x.sql" sorts before "10_x.sql".
 * A gap in the numbering is reported but is NOT an error — APSA's history
 * contains a real, deliberate gap (028/029 were never authored), and failing
 * on it would make the check permanently red for no safety benefit.
 */
export function buildMigrationInventory(fileNames: string[]): MigrationInventory {
  const entries: MigrationEntry[] = [];
  const malformed: string[] = [];

  for (const file of fileNames) {
    if (!file.endsWith(".sql")) continue;
    const match = MIGRATION_NAME_RE.exec(file);
    if (!match || match[1] === undefined) {
      malformed.push(file);
      continue;
    }
    entries.push({ file, prefix: match[1], number: Number(match[1]) });
  }

  entries.sort((a, b) =>
    a.number === b.number ? a.file.localeCompare(b.file) : a.number - b.number,
  );

  const byPrefix = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byPrefix.get(entry.prefix) ?? [];
    list.push(entry.file);
    byPrefix.set(entry.prefix, list);
  }
  const duplicates = [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files }));

  const gaps: number[] = [];
  const seen = new Set(entries.map((e) => e.number));
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first !== undefined && last !== undefined) {
    for (let n = first.number; n <= last.number; n++) {
      if (!seen.has(n)) gaps.push(n);
    }
  }

  return { entries, malformed, duplicates, gaps };
}

// ── Hosted parity ────────────────────────────────────────────────────────────

export interface HostedParityResult {
  /** Migrations recorded as hosted whose local content still matches. */
  applied: string[];
  /** Local migrations NOT recorded as applied to the hosted project. */
  pending: string[];
  /** Recorded as hosted but no longer present locally — always blocking. */
  missingLocally: string[];
  /** Recorded as hosted but local content has changed — always blocking. */
  hashMismatch: string[];
  /**
   * Recorded hosted migrations that appear AFTER an un-applied local
   * migration in numeric order. This means the hosted project was advanced
   * out of order and applying the pending set would run migrations whose
   * dependencies are already past — always blocking.
   */
  outOfOrder: string[];
}

/**
 * Compare the local migration inventory against the hosted lock file.
 *
 * `hostedHashes` maps file name → recorded sha256 of the file content as it
 * was when applied. `localHashes` maps file name → current sha256.
 */
export function compareHostedParity(
  inventory: MigrationInventory,
  hostedHashes: Record<string, string>,
  localHashes: Record<string, string>,
): HostedParityResult {
  const applied: string[] = [];
  const pending: string[] = [];
  const missingLocally: string[] = [];
  const hashMismatch: string[] = [];

  const localFiles = new Set(inventory.entries.map((e) => e.file));

  for (const [file, expected] of Object.entries(hostedHashes)) {
    if (!localFiles.has(file)) {
      missingLocally.push(file);
      continue;
    }
    if (localHashes[file] !== expected) {
      hashMismatch.push(file);
      continue;
    }
    applied.push(file);
  }

  const appliedSet = new Set([...applied, ...hashMismatch]);
  for (const entry of inventory.entries) {
    if (!appliedSet.has(entry.file) && !(entry.file in hostedHashes)) {
      pending.push(entry.file);
    }
  }

  // Out-of-order detection: find the lowest pending number, then flag any
  // hosted migration numbered above it.
  const outOfOrder: string[] = [];
  const pendingNumbers = inventory.entries
    .filter((e) => pending.includes(e.file))
    .map((e) => e.number);
  const lowestPending = pendingNumbers.length > 0 ? Math.min(...pendingNumbers) : undefined;
  if (lowestPending !== undefined) {
    for (const entry of inventory.entries) {
      if (appliedSet.has(entry.file) && entry.number > lowestPending) {
        outOfOrder.push(entry.file);
      }
    }
  }

  return { applied, pending, missingLocally, hashMismatch, outOfOrder };
}

// ── Generated-type freshness ─────────────────────────────────────────────────

const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Collect the set of public tables the migration set is expected to leave
 * behind: every CREATE TABLE, minus anything a later migration drops.
 *
 * `contents` must be supplied in application order so that a DROP in a later
 * migration wins over the earlier CREATE.
 */
export function collectMigrationTables(contents: string[]): string[] {
  const tables = new Set<string>();
  for (const sql of contents) {
    const stripped = stripSqlComments(sql);
    CREATE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE_RE.exec(stripped)) !== null) {
      if (m[1] !== undefined) tables.add(m[1]);
    }
    DROP_TABLE_RE.lastIndex = 0;
    while ((m = DROP_TABLE_RE.exec(stripped)) !== null) {
      if (m[1] !== undefined) tables.delete(m[1]);
    }
  }
  return [...tables].sort();
}

/**
 * Extract the table names declared in the `Tables: { ... }` block of a
 * Supabase-style generated types module.
 *
 * The parser tracks brace depth from the opening of the Tables block so that
 * only its direct children are treated as table names — nested Row/Insert/
 * Update members are ignored.
 */
export function collectTypeTables(typesSource: string): string[] {
  const start = typesSource.search(/\bTables\s*:\s*\{/);
  if (start === -1) return [];
  const open = typesSource.indexOf("{", start);
  if (open === -1) return [];

  const names: string[] = [];
  let depth = 0;
  let i = open;
  let lineStart = open;

  for (; i < typesSource.length; i++) {
    const ch = typesSource[i];
    if (ch === "{") {
      if (depth === 1) {
        // The identifier immediately before this brace is a table name.
        const header = typesSource.slice(lineStart, i);
        const name = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/.exec(header);
        if (name && name[1] !== undefined) names.push(name[1]);
      }
      depth++;
      lineStart = i + 1;
    } else if (ch === "}") {
      depth--;
      lineStart = i + 1;
      if (depth === 0) break;
    } else if (ch === "\n" || ch === ";" || ch === ",") {
      lineStart = i + 1;
    }
  }

  return [...new Set(names)].sort();
}

export interface TypeFreshnessResult {
  /** Tables created by migrations but absent from the generated types. */
  missingFromTypes: string[];
  /** Tables present in the generated types but created by no migration. */
  absentFromMigrations: string[];
  fresh: boolean;
}

export function compareTypeFreshness(
  migrationTables: string[],
  typeTables: string[],
): TypeFreshnessResult {
  const typeSet = new Set(typeTables);
  const migrationSet = new Set(migrationTables);
  const missingFromTypes = migrationTables.filter((t) => !typeSet.has(t)).sort();
  const absentFromMigrations = typeTables.filter((t) => !migrationSet.has(t)).sort();
  return {
    missingFromTypes,
    absentFromMigrations,
    fresh: missingFromTypes.length === 0 && absentFromMigrations.length === 0,
  };
}

// ── Environment presence (never values) ──────────────────────────────────────

export interface EnvPresence {
  name: string;
  present: boolean;
}

/**
 * Report which of the named environment variables are set to a non-empty
 * value. Only the variable NAME and a boolean leave this function — the value
 * itself is never returned, logged or included in any result.
 */
export function checkEnvPresence(
  env: Record<string, string | undefined>,
  names: string[],
): EnvPresence[] {
  return names.map((name) => ({ name, present: (env[name] ?? "").trim().length > 0 }));
}

/**
 * True when two environment variables hold the same non-empty value.
 *
 * Used to catch a staging configuration that actually points at the
 * production project. Returns a boolean only; neither value is disclosed.
 */
export function envValuesMatch(
  env: Record<string, string | undefined>,
  a: string,
  b: string,
): boolean {
  const left = (env[a] ?? "").trim();
  const right = (env[b] ?? "").trim();
  return left.length > 0 && left === right;
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Remove -- line comments and block comments so they cannot match a rule. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

// ── Table → migration attribution ────────────────────────────────────────────

/**
 * Map each table to the migration file that creates it, given migration
 * contents supplied in application order. A later DROP removes the mapping,
 * matching collectMigrationTables().
 */
export function attributeTablesToMigrations(
  files: string[],
  contents: string[],
): Record<string, string> {
  const owner: Record<string, string> = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sql = contents[i];
    if (file === undefined || sql === undefined) continue;
    const stripped = stripSqlComments(sql);

    CREATE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE_RE.exec(stripped)) !== null) {
      if (m[1] !== undefined && owner[m[1]] === undefined) owner[m[1]] = file;
    }
    DROP_TABLE_RE.lastIndex = 0;
    while ((m = DROP_TABLE_RE.exec(stripped)) !== null) {
      if (m[1] !== undefined) delete owner[m[1]];
    }
  }
  return owner;
}

/**
 * Split stale tables by whether the migration that creates them is already
 * applied to the hosted project.
 *
 * A table from an APPLIED migration that is missing from the generated types
 * is genuinely stale and fixable now — blocking. A table from a PENDING
 * migration cannot be in generated types yet, because the schema it describes
 * does not exist hosted — that is pending work, not a defect.
 */
export function classifyStaleTables(
  missingFromTypes: string[],
  tableOwner: Record<string, string>,
  appliedMigrations: string[],
): { stale: string[]; awaitingApply: string[] } {
  const applied = new Set(appliedMigrations);
  const stale: string[] = [];
  const awaitingApply: string[] = [];
  for (const table of missingFromTypes) {
    const file = tableOwner[table];
    if (file !== undefined && !applied.has(file)) awaitingApply.push(table);
    else stale.push(table);
  }
  return { stale: stale.sort(), awaitingApply: awaitingApply.sort() };
}

// ── RPC surface ──────────────────────────────────────────────────────────────

const GRANT_EXECUTE_RE = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]*?)\s+TO\s+([a-z_,\s]+);/gi;
const FN_NAME_RE = /public\.([a-z_][a-z0-9_]*)\s*\(/gi;

/**
 * Collect the names of public functions the migrations expose to the
 * `authenticated` role — i.e. the RPC surface a signed-in browser client can
 * reach directly, and therefore the surface a staging check must probe for
 * unauthenticated and cross-tenant access.
 *
 * A single GRANT may list several comma-separated signatures, so every
 * public.<name>( occurrence in the grant body is collected.
 */
export function collectAuthenticatedRpcs(contents: string[]): string[] {
  const names = new Set<string>();
  for (const sql of contents) {
    const stripped = stripSqlComments(sql);
    GRANT_EXECUTE_RE.lastIndex = 0;
    let grant: RegExpExecArray | null;
    while ((grant = GRANT_EXECUTE_RE.exec(stripped)) !== null) {
      const body = grant[1];
      const grantees = (grant[2] ?? "").toLowerCase();
      if (body === undefined) continue;
      if (!/\bauthenticated\b/.test(grantees)) continue;
      FN_NAME_RE.lastIndex = 0;
      let fn: RegExpExecArray | null;
      while ((fn = FN_NAME_RE.exec(body)) !== null) {
        if (fn[1] !== undefined) names.add(fn[1]);
      }
    }
  }
  return [...names].sort();
}
