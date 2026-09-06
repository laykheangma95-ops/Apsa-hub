/**
 * APSA — Migration Safety Check (static analysis only)
 *
 * This script does NOT connect to any database and does NOT prove a live
 * Supabase project is safe. It only checks the SQL files in
 * supabase/migrations/ for structural mistakes that are cheap to catch
 * before review:
 *
 *   1. Duplicate/colliding leading migration numbers (e.g. two 030_*.sql files).
 *   2. Modification of a migration already recorded as applied/hosted in
 *      supabase/hosted-migrations.lock.json (hosted migrations are immutable —
 *      a fix must be a new migration).
 *   3. SECURITY DEFINER functions that have no matching REVOKE EXECUTE ...
 *      FROM PUBLIC/anon statement in the same file (they default to PUBLIC
 *      EXECUTE, which is very rarely what a SECURITY DEFINER function wants).
 *   4. Ambiguous references to overloaded function names — a COMMENT ON
 *      FUNCTION / GRANT / REVOKE that names a function with more than one
 *      signature in supabase/migrations/ without qualifying which overload
 *      (see migration 030 in PR #32 for a real example of this bug).
 *
 * Baseline vs. changed-file enforcement:
 *   Checks 3 and 4 run in two modes. Given a --base=<git-ref>, any migration
 *   file that is NEW or MODIFIED relative to that ref is checked strictly
 *   (a finding fails the run). Every other migration file — the pre-existing
 *   baseline, already reviewed and in some cases already hosted — is only
 *   reported as a warning, because this script must not become a
 *   permanently-failing gate over code this governance change is not
 *   allowed to touch. Checks 1 and 2 always fail the run: they already pass
 *   cleanly against the current baseline, so there is no baseline exception
 *   to make for them.
 *   Without --base, every file is treated as baseline (warning-only) unless
 *   --strict is also passed, which enforces checks 3 and 4 against every file.
 *
 * Usage:
 *   bun run scripts/check-migration-safety.ts
 *   bun run scripts/check-migration-safety.ts --base=origin/main
 *   bun run scripts/check-migration-safety.ts --strict
 *
 * Exit codes:
 *   0 — no blocking findings
 *   1 — one or more blocking findings (see checks above)
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const LOCK_FILE = path.join(ROOT, "supabase/hosted-migrations.lock.json");

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith("--base="));
const baseRef = baseArg ? baseArg.slice("--base=".length) : undefined;
const strict = args.includes("--strict");

let blocking = 0;
let warnings = 0;

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
  blocking++;
}

function warn(msg: string): void {
  console.warn(`  ⚠ ${msg}`);
  warnings++;
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

console.log("APSA migration safety check\n");

if (!fs.existsSync(MIGRATIONS_DIR)) {
  console.log("No supabase/migrations directory found — nothing to check.");
  process.exit(0);
}

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// ── Determine which migration files changed relative to --base ──────────────

let changedFiles: Set<string> | undefined;
if (baseRef) {
  try {
    const diffOut = execSync(`git diff --name-only ${baseRef}...HEAD -- supabase/migrations`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    changedFiles = new Set(
      diffOut
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => path.basename(l)),
    );
    console.log(`Diffing against ${baseRef}: ${changedFiles.size} changed migration file(s).\n`);
  } catch (e) {
    warn(
      `Could not compute git diff against ${baseRef} (${(e as Error).message.split("\n")[0]}); treating all migrations as baseline.`,
    );
  }
}

function isEnforced(file: string): boolean {
  if (strict) return true;
  if (changedFiles) return changedFiles.has(file);
  return false;
}

// ── 1. Duplicate / colliding migration numbers ───────────────────────────────

console.log("1. Migration numbering collisions");
const numberToFiles = new Map<string, string[]>();
for (const f of files) {
  const m = f.match(/^(\d+)_/);
  if (!m) {
    warn(`File does not follow the NNN_description.sql convention: ${f}`);
    continue;
  }
  const num = m[1];
  const list = numberToFiles.get(num) ?? [];
  list.push(f);
  numberToFiles.set(num, list);
}
let hadDuplicate = false;
for (const [num, list] of numberToFiles) {
  if (list.length > 1) {
    hadDuplicate = true;
    fail(`Migration number ${num} is used by ${list.length} files: ${list.join(", ")}`);
  }
}
if (!hadDuplicate) ok(`No duplicate migration numbers across ${files.length} files.`);
console.log("");

// ── 2. Hosted/applied migrations must not be modified ────────────────────────

console.log("2. Hosted/applied migration immutability");
if (fs.existsSync(LOCK_FILE)) {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { hosted: Record<string, string> };
  for (const [file, expectedHash] of Object.entries(lock.hosted)) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(filePath)) {
      fail(
        `Hosted migration ${file} is recorded as applied to production but is missing from supabase/migrations/. Hosted migrations must never be deleted.`,
      );
      continue;
    }
    const hash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (hash !== expectedHash) {
      fail(
        `Hosted migration ${file} has changed since it was applied to production Supabase (expected sha256 ${expectedHash}, got ${hash}). Hosted migrations are immutable — write a new migration instead of editing this one.`,
      );
    }
  }
  if (blocking === 0)
    ok(`All ${Object.keys(lock.hosted).length} hosted migrations match their recorded hash.`);
} else {
  warn(
    "No supabase/hosted-migrations.lock.json found — skipping hosted-migration immutability check.",
  );
}
console.log("");

// ── Parse function definitions across all migration files ───────────────────

interface FunctionDef {
  name: string;
  args: string;
  file: string;
  isSecurityDefiner: boolean;
}

const functionDefs: FunctionDef[] = [];
const fileContents = new Map<string, string>();

const CREATE_FN_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)/gi;

for (const f of files) {
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
  fileContents.set(f, content);

  let match: RegExpExecArray | null;
  CREATE_FN_RE.lastIndex = 0;
  while ((match = CREATE_FN_RE.exec(content)) !== null) {
    const name = match[1];
    const args = match[2].replace(/\s+/g, " ").trim();
    // Look at the ~600 chars after the closing paren for a SECURITY DEFINER
    // clause, stopping early if we hit the next CREATE FUNCTION.
    const tailStart = match.index + match[0].length;
    const nextCreate = content.slice(tailStart).search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
    const tailEnd =
      nextCreate === -1
        ? Math.min(content.length, tailStart + 600)
        : tailStart + Math.min(nextCreate, 600);
    const tail = content.slice(tailStart, tailEnd);
    const isSecurityDefiner = /SECURITY\s+DEFINER/i.test(tail);
    functionDefs.push({ name, args, file: f, isSecurityDefiner });
  }
}

// ── 3. SECURITY DEFINER functions lacking a REVOKE FROM PUBLIC/anon ─────────

console.log("3. SECURITY DEFINER functions without an explicit PUBLIC/anon revoke");
let anySecurityDefinerFinding = false;
for (const fn of functionDefs) {
  if (!fn.isSecurityDefiner) continue;
  const content = fileContents.get(fn.file)!;
  const revokeRe = new RegExp(
    `REVOKE[\\s\\S]{0,40}ON\\s+FUNCTION\\s+public\\.${fn.name}\\s*\\([\\s\\S]*?\\)[\\s\\S]{0,80}FROM[\\s\\S]{0,80}(PUBLIC|anon)`,
    "i",
  );
  if (!revokeRe.test(content)) {
    const msg = `${fn.file}: SECURITY DEFINER function public.${fn.name}(${fn.args}) has no "REVOKE ... FROM PUBLIC/anon" in the same file — it defaults to PUBLIC EXECUTE. If this is an internal trigger/RLS helper never meant to be called directly, add an explicit REVOKE to document and enforce that.`;
    anySecurityDefinerFinding = true;
    if (isEnforced(fn.file)) {
      fail(msg);
    } else {
      warn(`[baseline] ${msg}`);
    }
  }
}
if (!anySecurityDefinerFinding)
  ok("Every SECURITY DEFINER function has a matching PUBLIC/anon revoke.");
console.log("");

// ── 4. Ambiguous references to overloaded function names ────────────────────

console.log("4. Ambiguous overloaded function references");
const nameToSignatures = new Map<string, Set<string>>();
for (const fn of functionDefs) {
  const set = nameToSignatures.get(fn.name) ?? new Set<string>();
  set.add(fn.args);
  nameToSignatures.set(fn.name, set);
}
const overloadedNames = new Set(
  [...nameToSignatures.entries()].filter(([, sigs]) => sigs.size > 1).map(([name]) => name),
);

let anyAmbiguousFinding = false;
if (overloadedNames.size > 0) {
  // An unqualified reference is COMMENT/GRANT/REVOKE naming the function
  // with no parenthesised argument list immediately after — Postgres then
  // has to guess, and errors out or picks the wrong overload.
  const UNQUALIFIED_RE =
    /(COMMENT\s+ON\s+FUNCTION|GRANT\s+EXECUTE\s+ON\s+FUNCTION|REVOKE[\s\S]{0,40}ON\s+FUNCTION)\s+public\.(\w+)\s*(IS|;|FROM|TO)/gi;
  for (const f of files) {
    const content = fileContents.get(f)!;
    let match: RegExpExecArray | null;
    UNQUALIFIED_RE.lastIndex = 0;
    while ((match = UNQUALIFIED_RE.exec(content)) !== null) {
      const name = match[2];
      if (overloadedNames.has(name)) {
        anyAmbiguousFinding = true;
        const msg = `${f}: unqualified reference to public.${name} (no argument list) is ambiguous — ${nameToSignatures.get(name)!.size} overloads exist across the migrations directory. Qualify with the exact signature, e.g. public.${name}(${[...nameToSignatures.get(name)!][0]}).`;
        if (isEnforced(f)) {
          fail(msg);
        } else {
          warn(`[baseline] ${msg}`);
        }
      }
    }
  }
  if (!anyAmbiguousFinding) {
    ok(
      `${overloadedNames.size} overloaded function name(s) found, but every reference is signature-qualified.`,
    );
  }
} else {
  ok("No overloaded public.* function names found across migrations.");
}
console.log("");

// ── Summary ───────────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log(`${blocking} blocking finding(s), ${warnings} warning(s).`);
if (!baseRef && !strict) {
  console.log(
    "Note: run with --base=origin/main (as CI does on pull requests) to enforce checks 3 and 4 against changed migration files, or --strict to enforce them against every migration file.",
  );
}
console.log(
  "This is static SQL analysis only — it does not prove a live Supabase project is configured safely.",
);

process.exit(blocking > 0 ? 1 : 0);
