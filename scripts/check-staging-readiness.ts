/**
 * APSA — Staging Readiness Check (offline, deterministic)
 *
 * Answers one question and no other: is this checkout in a state where a
 * staging verification could be attempted, and exactly what is missing if not?
 *
 * It does NOT connect to Supabase, does NOT apply migrations, and does NOT
 * prove anything about a live project. scripts/verify-staging.ts does the
 * hosted half of the work, and only when staging credentials are configured.
 *
 * Checks:
 *   1. Local migration inventory — ordering, malformed names, duplicate
 *      numbers (blocking), numbering gaps (informational).
 *   2. Hosted parity — which local migrations are recorded as applied in
 *      supabase/hosted-migrations.lock.json, which are pending, and whether
 *      any hosted migration has been deleted, edited, or applied out of order.
 *   3. Generated Supabase type freshness — every table the migrations create
 *      must be present in src/lib/supabase/types.ts.
 *   4. Staging environment presence — names only, never values.
 *
 * Reporting contract:
 *   Every check reports exactly one of PASS / FAIL / PENDING / NOT CONFIGURED.
 *   "NOT CONFIGURED" is never counted as a pass, and a FAIL is never downgraded
 *   to a skip.
 *
 * Usage:
 *   bun run scripts/check-staging-readiness.ts
 *   bun run scripts/check-staging-readiness.ts --require-staging-env
 *   bun run scripts/check-staging-readiness.ts --require-parity
 *
 * Exit codes:
 *   0 — no blocking findings
 *   1 — one or more blocking findings
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  buildMigrationInventory,
  compareHostedParity,
  collectMigrationTables,
  collectTypeTables,
  compareTypeFreshness,
  checkEnvPresence,
  envValuesMatch,
  attributeTablesToMigrations,
  classifyStaleTables,
} from "./lib/staging-readiness.ts";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const LOCK_FILE = path.join(ROOT, "supabase/hosted-migrations.lock.json");
const TYPES_FILE = path.join(ROOT, "src/lib/supabase/types.ts");

const args = process.argv.slice(2);
/** Fail the run when staging credentials are absent (fail closed). */
const requireStagingEnv = args.includes("--require-staging-env");
/** Fail the run when any local migration is not yet applied to hosted. */
const requireParity = args.includes("--require-parity");

let blocking = 0;
let pending = 0;
let notConfigured = 0;

const pass = (m: string) => console.log(`  PASS   ${m}`);
const fail = (m: string) => {
  console.error(`  FAIL   ${m}`);
  blocking++;
};
const pendingNote = (m: string) => {
  console.log(`  PENDING  ${m}`);
  pending++;
};
const unconfigured = (m: string) => {
  console.log(`  NOT CONFIGURED  ${m}`);
  notConfigured++;
};
const info = (m: string) => console.log(`  ·      ${m}`);
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

console.log("APSA — staging readiness check (offline; no database connection)");

// ── 1. Local migration inventory ─────────────────────────────────────────────

section("1. Local migration inventory");

if (!fs.existsSync(MIGRATIONS_DIR)) {
  fail("supabase/migrations does not exist — nothing to verify.");
  process.exit(1);
}

const fileNames = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
const inventory = buildMigrationInventory(fileNames);

for (const bad of inventory.malformed) {
  fail(`Migration file does not follow NNN_description.sql: ${bad}`);
}
for (const dup of inventory.duplicates) {
  fail(
    `Migration number ${dup.prefix} is used by ${dup.files.length} files: ${dup.files.join(", ")}`,
  );
}
if (inventory.malformed.length === 0 && inventory.duplicates.length === 0) {
  const first = inventory.entries[0];
  const last = inventory.entries[inventory.entries.length - 1];
  pass(
    `${inventory.entries.length} migrations, well-formed and uniquely numbered` +
      (first && last ? ` (${first.prefix} … ${last.prefix})` : ""),
  );
}
if (inventory.gaps.length > 0) {
  info(
    `Numbering gap(s) at ${inventory.gaps.join(", ")} — informational. A gap is only a problem ` +
      `if a migration was deleted; check git history before treating it as one.`,
  );
}

// ── 2. Hosted parity ─────────────────────────────────────────────────────────

section("2. Hosted migration parity");

const localHashes: Record<string, string> = {};
for (const entry of inventory.entries) {
  localHashes[entry.file] = createHash("sha256")
    .update(fs.readFileSync(path.join(MIGRATIONS_DIR, entry.file)))
    .digest("hex");
}

/** Migrations recorded as applied to hosted, populated by section 2. */
let appliedMigrations: string[] = [];
/** True when hosted parity could not be determined at all. */
let parityUnknown = false;

if (!fs.existsSync(LOCK_FILE)) {
  parityUnknown = true;
  fail(
    "supabase/hosted-migrations.lock.json is missing — hosted parity cannot be determined. " +
      "This check fails closed rather than assuming the hosted project is up to date.",
  );
} else {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as {
    hosted?: Record<string, string>;
    last_verified?: string;
  };
  const hosted = lock.hosted ?? {};
  const parity = compareHostedParity(inventory, hosted, localHashes);
  appliedMigrations = parity.applied;

  for (const f of parity.missingLocally) {
    fail(
      `${f} is recorded as applied to hosted Supabase but is missing locally — never delete a hosted migration.`,
    );
  }
  for (const f of parity.hashMismatch) {
    fail(
      `${f} is recorded as applied to hosted Supabase but its content has changed — hosted migrations are immutable; write a new migration.`,
    );
  }
  for (const f of parity.outOfOrder) {
    fail(
      `${f} is recorded as applied, but an earlier-numbered migration is still pending — the hosted project was advanced out of order.`,
    );
  }

  if (parity.pending.length === 0) {
    pass(
      `All ${parity.applied.length} local migrations are recorded as applied to hosted Supabase.`,
    );
  } else {
    const handler = requireParity ? fail : pendingNote;
    handler(
      `${parity.pending.length} of ${inventory.entries.length} local migrations are NOT recorded as applied to hosted Supabase.`,
    );
    info(`Applied (${parity.applied.length}): ${parity.applied.join(", ") || "none"}`);
    info(`Pending (${parity.pending.length}): ${parity.pending.join(", ")}`);
    info(
      "Pending migrations are NOT applied by this tool. See docs/STAGING_VERIFICATION.md " +
        "for the review-and-apply procedure, which requires explicit owner approval.",
    );
  }
  if (lock.last_verified) info(`Lock file last verified against hosted: ${lock.last_verified}`);
}

// ── 3. Generated Supabase type freshness ─────────────────────────────────────

section("3. Generated Supabase type freshness");

if (!fs.existsSync(TYPES_FILE)) {
  fail("src/lib/supabase/types.ts is missing.");
} else {
  const migrationTables = collectMigrationTables(
    inventory.entries.map((e) => fs.readFileSync(path.join(MIGRATIONS_DIR, e.file), "utf8")),
  );
  const typeTables = collectTypeTables(fs.readFileSync(TYPES_FILE, "utf8"));
  const freshness = compareTypeFreshness(migrationTables, typeTables);
  const tableOwner = attributeTablesToMigrations(
    inventory.entries.map((e) => e.file),
    inventory.entries.map((e) => fs.readFileSync(path.join(MIGRATIONS_DIR, e.file), "utf8")),
  );

  if (typeTables.length === 0) {
    fail("Could not parse any table from the Tables block of src/lib/supabase/types.ts.");
  } else if (freshness.fresh) {
    pass(`Generated types cover all ${migrationTables.length} migration tables.`);
  } else {
    // A table whose migration is not yet hosted CANNOT be in generated types —
    // the schema it describes does not exist on the project types are generated
    // from. That is pending work. A table from an already-applied migration is
    // genuinely stale and fixable today, so it blocks.
    // When hosted parity is unknown, every owning migration is treated as
    // applied so that every missing table reports as blocking-stale. That is
    // the fail-closed direction: an unknown hosted state must never let a
    // stale type slip through as merely "pending".
    const treatAsApplied = parityUnknown
      ? [...new Set(Object.values(tableOwner))]
      : appliedMigrations;
    const { stale, awaitingApply } = classifyStaleTables(
      freshness.missingFromTypes,
      tableOwner,
      treatAsApplied,
    );

    if (stale.length > 0) {
      fail(
        `Generated types are stale — ${stale.length} table(s) from migrations already applied to ` +
          `hosted Supabase are absent from src/lib/supabase/types.ts: ${stale.join(", ")}`,
      );
      info(
        "Regenerate: supabase gen types typescript --project-id <ref> --schema public > src/lib/supabase/types.ts",
      );
    }
    if (awaitingApply.length > 0) {
      pendingNote(
        `${awaitingApply.length} table(s) are defined only by migrations that are not yet applied to ` +
          `hosted Supabase, so generated types cannot cover them yet: ${awaitingApply.join(", ")}`,
      );
      info(
        "These become blocking once the owning migrations are applied and types are not regenerated.",
      );
    }
    if (freshness.absentFromMigrations.length > 0) {
      fail(
        `Generated types declare ${freshness.absentFromMigrations.length} table(s) that no migration ` +
          `creates: ${freshness.absentFromMigrations.join(", ")}`,
      );
    }
    if (stale.length === 0 && freshness.absentFromMigrations.length === 0) {
      pass(
        `Generated types cover every table from the ${appliedMigrations.length} migration(s) already applied to hosted Supabase.`,
      );
    }
  }
}

// ── 4. Staging environment presence ──────────────────────────────────────────

section("4. Staging environment (names only — no values are read out)");

const STAGING_VARS = [
  "STAGING_SUPABASE_URL",
  "STAGING_SUPABASE_ANON_KEY",
  "STAGING_SUPABASE_SERVICE_ROLE_KEY",
];
const presence = checkEnvPresence(process.env, STAGING_VARS);
const missing = presence.filter((p) => !p.present).map((p) => p.name);

for (const p of presence) {
  if (p.present) pass(`${p.name} is set`);
}

if (missing.length === 0) {
  if (envValuesMatch(process.env, "STAGING_SUPABASE_URL", "VITE_SUPABASE_URL")) {
    fail(
      "STAGING_SUPABASE_URL is identical to VITE_SUPABASE_URL — staging must be a separate " +
        "Supabase project. Refusing to treat the production project as staging.",
    );
  } else {
    pass("Staging project URL is distinct from the configured production URL.");
  }
  if (
    envValuesMatch(process.env, "STAGING_SUPABASE_ANON_KEY", "STAGING_SUPABASE_SERVICE_ROLE_KEY")
  ) {
    fail(
      "STAGING_SUPABASE_ANON_KEY and STAGING_SUPABASE_SERVICE_ROLE_KEY hold the same value — they must be different keys.",
    );
  }
} else if (requireStagingEnv) {
  fail(
    `Staging credentials required but not set: ${missing.join(", ")}. ` +
      "Failing closed — a missing prerequisite is not a pass.",
  );
} else {
  unconfigured(
    `${missing.join(", ")} not set — hosted staging verification cannot run. ` +
      "This is NOT a pass; see docs/STAGING_VERIFICATION.md for what the owner must provide.",
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log(`  ${blocking} blocking, ${pending} pending, ${notConfigured} not configured.`);
console.log("═".repeat(64));

if (notConfigured > 0 || pending > 0) {
  console.log(
    "\n  Staging verification has NOT been performed. Offline readiness only.\n" +
      "  Run scripts/verify-staging.ts with STAGING_* credentials to verify hosted behavior.",
  );
}

if (blocking > 0) {
  console.error(
    `\n  ${blocking} blocking finding(s) — resolve before attempting staging verification.\n`,
  );
  process.exit(1);
}
console.log("\n  No blocking findings.\n");
