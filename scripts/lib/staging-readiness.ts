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
  /**
   * Migration numbers used by more than one file — always a blocking condition.
   *
   * Grouping is by the PARSED NUMBER, not the raw prefix string, because the
   * database applies migrations by ordinal: "09_a.sql" and "9_b.sql" are both
   * migration 9 and collide on the hosted project even though their prefix
   * strings differ. `prefix` is the canonical decimal form of that number, and
   * `rawPrefixes` preserves the differing spellings actually on disk.
   */
  duplicates: Array<{ number: number; prefix: string; rawPrefixes: string[]; files: string[] }>;
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

  // Group by parsed number, never by the raw prefix string: "09_a.sql" and
  // "9_b.sql" are the same migration ordinal and must collide.
  const byNumber = new Map<number, MigrationEntry[]>();
  for (const entry of entries) {
    const list = byNumber.get(entry.number) ?? [];
    list.push(entry);
    byNumber.set(entry.number, list);
  }
  const duplicates = [...byNumber.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([number, group]) => ({
      number,
      prefix: String(number),
      rawPrefixes: [...new Set(group.map((e) => e.prefix))],
      files: group.map((e) => e.file),
    }));

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

// ── Project URL identity ─────────────────────────────────────────────────────

/**
 * Reduce a Supabase project URL to a comparable identity.
 *
 * Two spellings of the same project must never read as two different projects,
 * or the "staging is not production" guard can be walked around by appending a
 * slash or changing the case of the host. Normalization lower-cases the scheme
 * and host, drops the default port, strips a trailing slash and discards query
 * and fragment. A value that is not a parseable absolute URL is lower-cased and
 * trailing-slash-stripped so it still compares stably rather than silently
 * becoming "different from everything".
 *
 * Returns "" for an absent or whitespace-only value. Nothing secret passes
 * through here — a project URL is not a credential — but the result is still
 * only ever used for comparison, never printed alongside a key.
 */
export function normalizeSupabaseUrl(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return "";
  try {
    const url = new URL(raw);
    const scheme = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    const defaultPort =
      (scheme === "https:" && url.port === "443") || (scheme === "http:" && url.port === "80");
    const port = url.port.length > 0 && !defaultPort ? `:${url.port}` : "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${scheme}//${host}${port}${pathname}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

/** True when two URLs denote the same Supabase project after normalization. */
export function sameSupabaseProject(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeSupabaseUrl(a);
  const right = normalizeSupabaseUrl(b);
  return left.length > 0 && left === right;
}

// ── Key role identification (never discloses key material) ───────────────────

export type KeyRole = "anon" | "service_role" | "publishable" | "secret" | "unknown";

/**
 * Identify what role a Supabase key claims, WITHOUT returning, logging or
 * echoing any part of the key.
 *
 * Legacy keys are unsigned-inspectable JWTs whose payload carries a `role`
 * claim; current keys are prefixed (`sb_publishable_…`, `sb_secret_…`). Only
 * the role word leaves this function. No signature is verified and no network
 * call is made — this is a cheap confusion check ("is the service-role key in
 * the anon slot?"), not authentication.
 */
export function describeKeyRole(key: string | undefined): KeyRole {
  const raw = (key ?? "").trim();
  if (raw.length === 0) return "unknown";
  if (raw.startsWith("sb_publishable_")) return "publishable";
  if (raw.startsWith("sb_secret_")) return "secret";

  const parts = raw.split(".");
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (payload === undefined || payload.length === 0) return "unknown";
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as { role?: unknown };
    const role = typeof claims.role === "string" ? claims.role.toLowerCase() : "";
    if (role === "anon") return "anon";
    if (role === "service_role") return "service_role";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** True when a key's claimed role is a privileged, server-only one. */
export function isPrivilegedKeyRole(role: KeyRole): boolean {
  return role === "service_role" || role === "secret";
}

/** True when a key's claimed role is a browser-safe, public one. */
export function isPublicKeyRole(role: KeyRole): boolean {
  return role === "anon" || role === "publishable";
}

// ── Hosted-probe safety gate (fail closed) ───────────────────────────────────

export interface ProbeGateInput {
  stagingUrl: string | undefined;
  /**
   * The production URL witness. A hosted probe is only allowed once the runner
   * has stated which project is production, so that "is this staging?" is a
   * question that was actually answered rather than skipped.
   */
  productionUrlWitness: string | undefined;
  anonKey: string | undefined;
  serviceKey: string | undefined;
  orgAId?: string | undefined;
  orgBId?: string | undefined;
}

export interface ProbeGateResult {
  /** True only when every refusal condition is clear. */
  allowed: boolean;
  /** Stable machine codes for the conditions that blocked the run. */
  refusals: string[];
  /** Operator-facing reasons, in the same order. Never contains a key value. */
  messages: string[];
}

/**
 * Decide whether ANY hosted probe may run.
 *
 * This is fail-closed by construction: the result is `allowed` only when every
 * condition below is affirmatively clear, so a missing variable refuses rather
 * than skipping a comparison. In particular an absent production URL witness is
 * a refusal, not a pass — the earlier "refuse when staging === production"
 * shape silently allowed every hosted probe whenever the production URL simply
 * was not set in the shell.
 *
 * This gate takes no opinion on write probes and reads no flag: it must be
 * evaluated before any client is constructed, so that no command-line option
 * can be positioned to bypass it.
 */
export function evaluateProbeGate(input: ProbeGateInput): ProbeGateResult {
  const refusals: string[] = [];
  const messages: string[] = [];
  const refuse = (code: string, message: string) => {
    refusals.push(code);
    messages.push(message);
  };

  const staging = normalizeSupabaseUrl(input.stagingUrl);
  const production = normalizeSupabaseUrl(input.productionUrlWitness);
  const anon = (input.anonKey ?? "").trim();
  const service = (input.serviceKey ?? "").trim();

  if (staging.length === 0) {
    refuse(
      "staging_url_missing",
      "STAGING_SUPABASE_URL is not set — there is no project to probe.",
    );
  }
  if (anon.length === 0) {
    refuse("anon_key_missing", "STAGING_SUPABASE_ANON_KEY is not set.");
  }
  if (service.length === 0) {
    refuse("service_key_missing", "STAGING_SUPABASE_SERVICE_ROLE_KEY is not set.");
  }

  if (production.length === 0) {
    refuse(
      "production_witness_missing",
      "No production URL witness is set (VITE_SUPABASE_URL or PRODUCTION_SUPABASE_URL). " +
        "Without it, 'staging is not production' cannot be checked at all, so no hosted probe may run.",
    );
  } else if (staging.length > 0 && staging === production) {
    refuse(
      "staging_is_production",
      "STAGING_SUPABASE_URL and the production URL witness resolve to the SAME project after " +
        "normalization — refusing to probe the production project.",
    );
  }

  if (anon.length > 0 && anon === service) {
    refuse("keys_identical", "The anon key and the service-role key hold the same value.");
  }

  const anonRole = describeKeyRole(anon);
  const serviceRole = describeKeyRole(service);
  if (anon.length > 0 && isPrivilegedKeyRole(anonRole)) {
    refuse(
      "anon_slot_privileged",
      `STAGING_SUPABASE_ANON_KEY carries a privileged role ("${anonRole}") — the keys are swapped. ` +
        "Probing with a privileged key in the anonymous slot would report false RLS passes.",
    );
  }
  if (service.length > 0 && isPublicKeyRole(serviceRole)) {
    refuse(
      "service_slot_public",
      `STAGING_SUPABASE_SERVICE_ROLE_KEY carries a public role ("${serviceRole}") — the keys are swapped.`,
    );
  }

  const orgA = (input.orgAId ?? "").trim();
  const orgB = (input.orgBId ?? "").trim();
  if (orgA.length > 0 && orgB.length > 0 && orgA.toLowerCase() === orgB.toLowerCase()) {
    refuse(
      "org_ids_identical",
      "STAGING_ORG_A_ID and STAGING_ORG_B_ID are the same organization — cross-tenant isolation " +
        "cannot be proven by reading one organization against itself.",
    );
  }

  return { allowed: refusals.length === 0, refusals, messages };
}

// ── Probe verdicts ───────────────────────────────────────────────────────────

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** Postgres/PostgREST codes that mean "refused by authorization", and nothing else. */
export const AUTHORIZATION_DENIAL_CODES = ["42501", "PGRST301", "PGRST302"] as const;

/**
 * True only for a code that positively means the request was refused because
 * the caller was not authorized. Any other error — a malformed id (22P02), a
 * trigger or check violation, a validation failure, a missing function — is a
 * refusal for some other reason and must never be read as proof of security.
 */
export function isAuthorizationDenial(code: string | undefined | null): boolean {
  if (typeof code !== "string") return false;
  return (AUTHORIZATION_DENIAL_CODES as readonly string[]).includes(code);
}

export interface RlsObservation {
  /** Error code returned to the anonymous client, if it was refused. */
  errorCode?: string | null;
  /** Rows the anonymous client actually received. */
  anonRowCount: number;
  /**
   * Rows the SERVICE-ROLE client counts in the same table, or null when the
   * count could not be obtained. This is what separates "RLS held" from "the
   * table simply had nothing in it".
   */
  adminRowCount: number | null;
}

export interface VerdictResult {
  verdict: Verdict;
  /** Stable machine reason code. */
  reason: string;
}

/**
 * Decide what an anonymous read actually proved about RLS.
 *
 * The critical case is the empty table. A zero-row anonymous read of a table
 * that is itself empty distinguishes nothing: an unprotected empty table and a
 * perfectly protected empty table return exactly the same thing. That is
 * INCONCLUSIVE and must never be counted toward an RLS-proven total. Only a
 * table the service role can see rows in, which the anonymous client reads zero
 * of, proves that RLS is doing the work.
 */
export function classifyRlsObservation(observation: RlsObservation): VerdictResult {
  const { errorCode, anonRowCount, adminRowCount } = observation;

  if (typeof errorCode === "string" && errorCode.length > 0) {
    if (isAuthorizationDenial(errorCode)) {
      return { verdict: "PASS", reason: "authorization_denial" };
    }
    return { verdict: "INCONCLUSIVE", reason: "refused_for_other_reason" };
  }

  if (anonRowCount > 0) {
    return { verdict: "FAIL", reason: "rows_exposed_to_anonymous" };
  }

  if (adminRowCount === null) {
    return { verdict: "INCONCLUSIVE", reason: "admin_count_unavailable" };
  }
  if (adminRowCount === 0) {
    return { verdict: "INCONCLUSIVE", reason: "table_empty" };
  }
  return { verdict: "PASS", reason: "rows_exist_but_anonymous_read_none" };
}

/**
 * Decide what a write probe proved.
 *
 * A write that is not refused is a tenant-isolation failure. A write refused
 * with an authorization code is the only successful proof. Everything else —
 * a malformed uuid, a trigger raising, a check constraint, a not-null
 * violation — means the request never reached the authorization decision, so it
 * proves nothing and must not be recorded as a refusal.
 */
export function classifyWriteProbe(error: { code?: string | null } | null): VerdictResult {
  if (error === null || error === undefined) {
    return { verdict: "FAIL", reason: "write_accepted" };
  }
  if (isAuthorizationDenial(error.code)) {
    return { verdict: "PASS", reason: "authorization_denial" };
  }
  return { verdict: "INCONCLUSIVE", reason: "refused_for_other_reason" };
}

/**
 * Decide what an RPC probe proved.
 *
 * PGRST202 (function not found in the schema cache for this role) and PGRST203
 * (ambiguous overload) are explicitly INCONCLUSIVE: the call never reached an
 * authorization decision, so neither can stand in for "the anonymous caller was
 * denied".
 */
export function classifyRpcProbe(error: { code?: string | null } | null): VerdictResult {
  if (error === null || error === undefined) {
    return { verdict: "FAIL", reason: "executed_for_anonymous_caller" };
  }
  if (isAuthorizationDenial(error.code)) {
    return { verdict: "PASS", reason: "authorization_denial" };
  }
  if (error.code === "PGRST202" || error.code === "PGRST203") {
    return { verdict: "INCONCLUSIVE", reason: "not_resolvable_for_role" };
  }
  return { verdict: "INCONCLUSIVE", reason: "refused_for_other_reason" };
}

// ── RPC signatures, volatility and safe dummy arguments ──────────────────────

export interface RpcParameter {
  /** Declared parameter name, or undefined for a positional-only parameter. */
  name?: string;
  /** Declared SQL type, lower-cased. */
  type: string;
  /** True when the parameter declares a DEFAULT and may be omitted. */
  hasDefault: boolean;
  /** True for OUT parameters, which a caller never supplies. */
  isOut: boolean;
}

export interface RpcSignature {
  name: string;
  parameters: RpcParameter[];
  /**
   * True unless the function is provably read-only. A function is treated as
   * mutating when its body contains a write statement OR it is not declared
   * STABLE/IMMUTABLE — the conservative direction, so an unparseable or
   * unusual definition is never assumed safe to invoke.
   */
  mutating: boolean;
  /** True when declared STABLE or IMMUTABLE. */
  readOnlyDeclared: boolean;
}

const WRITE_STATEMENT_RE =
  /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_"]|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY\s+|CREATE\s+(?:TABLE|INDEX|SEQUENCE|TYPE)|ALTER\s+(?:TABLE|SEQUENCE|TYPE)|DROP\s+(?:TABLE|INDEX|SEQUENCE|TYPE)|NEXTVAL|SETVAL)\b/i;

/**
 * Split a SQL argument list on top-level commas, ignoring commas nested inside
 * parentheses (numeric(10,2)) or inside a quoted default.
 */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i] as string;
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseParameter(raw: string): RpcParameter | undefined {
  const hasDefault = /\bDEFAULT\b/i.test(raw) || /(^|[^:!<>=])=\s*[^=]/.test(raw);
  let text = raw.replace(/\s+DEFAULT\s+[\s\S]*$/i, "").trim();
  text = text.replace(/\s*(?<![:!<>=])=\s*[^=][\s\S]*$/, "").trim();
  if (text.length === 0) return undefined;

  let isOut = false;
  const modeMatch = /^(IN|OUT|INOUT|VARIADIC)\s+/i.exec(text);
  if (modeMatch && modeMatch[1] !== undefined) {
    const mode = modeMatch[1].toUpperCase();
    isOut = mode === "OUT";
    text = text.slice(modeMatch[0].length).trim();
  }

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) {
    return { type: (tokens[0] as string).toLowerCase(), hasDefault, isOut };
  }
  const name = (tokens[0] as string).replace(/^"|"$/g, "");
  const type = tokens.slice(1).join(" ").toLowerCase();
  return { name, type, hasDefault, isOut };
}

/**
 * Extract the declared signature of every public function the migrations
 * create, together with a conservative read-only/mutating classification.
 *
 * Only the declaration is parsed; nothing is executed and nothing is connected
 * to. The result is what lets a hosted probe be BOTH safe (never invoke a
 * mutating function speculatively) and meaningful (call with arguments that
 * actually bind, instead of always bouncing off PGRST202).
 */
export function collectRpcSignatures(contents: string[]): RpcSignature[] {
  const byName = new Map<string, RpcSignature>();
  const header =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;

  for (const sql of contents) {
    const stripped = stripSqlComments(sql);
    header.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = header.exec(stripped)) !== null) {
      const name = match[1];
      if (name === undefined) continue;

      // Balanced scan of the argument list.
      let depth = 1;
      let i = header.lastIndex;
      let quote: string | undefined;
      for (; i < stripped.length && depth > 0; i++) {
        const ch = stripped[i];
        if (quote !== undefined) {
          if (ch === quote) quote = undefined;
          continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      const args = stripped.slice(header.lastIndex, Math.max(header.lastIndex, i - 1));
      const parameters = splitTopLevel(args)
        .map(parseParameter)
        .filter((p): p is RpcParameter => p !== undefined);

      // Everything between the argument list and the function body carries the
      // volatility declaration; the body carries the statements.
      const rest = stripped.slice(i);
      const dollar = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      const preamble = dollar ? rest.slice(0, dollar.index) : rest.slice(0, 400);
      let body = "";
      if (dollar) {
        const tag = dollar[0];
        const bodyStart = dollar.index + tag.length;
        const close = rest.indexOf(tag, bodyStart);
        body = close === -1 ? rest.slice(bodyStart) : rest.slice(bodyStart, close);
      }

      const readOnlyDeclared = /\b(?:STABLE|IMMUTABLE)\b/i.test(preamble);
      const writes = WRITE_STATEMENT_RE.test(body);
      const signature: RpcSignature = {
        name,
        parameters,
        readOnlyDeclared,
        mutating: writes || !readOnlyDeclared,
      };

      // A later CREATE OR REPLACE wins; a name that is mutating in ANY
      // definition stays mutating, so an overload cannot launder it.
      const existing = byName.get(name);
      byName.set(
        name,
        existing === undefined
          ? signature
          : { ...signature, mutating: signature.mutating || existing.mutating },
      );
      header.lastIndex = i;
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a type-correct, inert argument object for an RPC probe.
 *
 * PostgREST resolves an RPC by the named arguments supplied, so probing every
 * function with `{}` makes any function that has required parameters answer
 * PGRST202 ("not found") regardless of how its permissions are configured —
 * which reads as inconclusive forever and hides a genuinely exposed function.
 * Supplying a correctly-typed placeholder for each required parameter lets the
 * call reach the authorization decision.
 *
 * Values are deliberately inert: the nil UUID, empty string, zero, false, the
 * epoch. They identify no real row.
 */
export function rpcDummyArgs(signature: RpcSignature): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const parameter of signature.parameters) {
    if (parameter.isOut) continue;
    if (parameter.name === undefined) continue;
    if (parameter.hasDefault) continue;
    args[parameter.name] = dummyValueForType(parameter.type);
  }
  return args;
}

/** Map a declared SQL type to an inert placeholder value of that type. */
export function dummyValueForType(sqlType: string): unknown {
  const type = sqlType.toLowerCase().trim();
  if (/\[\]$/.test(type) || /^_/.test(type)) return [];
  if (/\buuid\b/.test(type)) return "00000000-0000-0000-0000-000000000000";
  if (/\bbool(ean)?\b/.test(type)) return false;
  if (/\b(jsonb|json)\b/.test(type)) return {};
  if (
    /\b(smallint|integer|int2|int4|int8|int|bigint|numeric|decimal|real|double\s+precision|float)\b/.test(
      type,
    )
  ) {
    return 0;
  }
  if (/\b(timestamptz|timestamp|date)\b/.test(type)) return "1970-01-01T00:00:00Z";
  if (/\btime\b/.test(type)) return "00:00:00";
  if (/\b(text|varchar|character\s+varying|char|citext|name)\b/.test(type)) return "";
  // Enums and domain types are text over the wire; an empty string is inert.
  return "";
}

// ── Trigger-protected tables ─────────────────────────────────────────────────

const CREATE_TRIGGER_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[a-z_][a-z0-9_]*\s+[\s\S]*?\bON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Collect tables that carry a trigger.
 *
 * A write probe against a trigger-protected table is worthless as a security
 * proof: the trigger can raise before the authorization decision is reached, so
 * the refusal that comes back says nothing about tenant isolation. These tables
 * are excluded from write-probe target selection.
 */
export function collectTriggerProtectedTables(contents: string[]): string[] {
  const tables = new Set<string>();
  for (const sql of contents) {
    const stripped = stripSqlComments(sql);
    CREATE_TRIGGER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TRIGGER_RE.exec(stripped)) !== null) {
      if (m[1] !== undefined) tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

/**
 * Pick a write-probe target: tenant-scoped, present on the hosted project, and
 * not trigger-protected. Returns undefined when no such table exists, which the
 * caller must report as NOT CONFIGURED rather than inventing a target.
 */
export function selectWriteProbeTarget(
  tenantScopedTables: string[],
  triggerProtectedTables: string[],
): string | undefined {
  const protectedSet = new Set(triggerProtectedTables);
  return [...tenantScopedTables].sort().find((t) => !protectedSet.has(t));
}

// ── Bounded execution ────────────────────────────────────────────────────────

/**
 * Resolve a promise, or reject once `ms` have passed.
 *
 * Every hosted call is wrapped in this so that an unreachable or hanging
 * staging project ends the run with a reported timeout instead of holding the
 * process open forever.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms: ${label}`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface Deadline {
  /** True once the overall budget is spent. */
  expired(): boolean;
  /** Milliseconds left, never negative. */
  remaining(): number;
}

/** A monotonic overall budget for a whole verification run. */
export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
  const start = now();
  return {
    expired: () => now() - start >= totalMs,
    remaining: () => Math.max(0, totalMs - (now() - start)),
  };
}

/** Read a positive integer from the environment, falling back to a default. */
export function readTimeoutMs(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = (env[name] ?? "").trim();
  if (raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
