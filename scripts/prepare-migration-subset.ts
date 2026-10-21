/**
 * APSA — Prepare a migration subset for a controlled `supabase db push`
 * (offline, deterministic; docs/RELEASE_CHECKLIST.md §8b).
 *
 * `supabase db push` applies EVERY local migration the target's ledger has not
 * recorded. To apply one migration while later ones are also pending in the
 * repository (e.g. 061 while 062–064 are on main), push from a separate
 * working directory that contains only the migrations up to and including
 * the target. This script builds that directory and nothing else:
 *
 *   <out>/supabase/migrations/<every NNN_*.sql with NNN <= --through>
 *
 * The files are byte-for-byte copies; the manifest it prints (version, file,
 * sha256) and the excluded later files are what the operator compares with
 * the dry run. It never connects to a database and never runs the CLI.
 *
 * Usage:
 *   bun run scripts/prepare-migration-subset.ts --through=061 --out=<new dir>
 *   then, from <out>:  supabase db push --db-url "$STAGING_DB_URL" --dry-run
 *   STOP unless the dry run lists exactly the --through migration.
 *
 * Refuses (exit 1): a missing or malformed --through, a --through with no
 * migration file, duplicate version numbers, or an --out that already exists.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface SubsetFile {
  version: string;
  file: string;
  sha256: string;
}

export interface Subset {
  included: SubsetFile[];
  excluded: string[];
}

const MIGRATION = /^(\d{3})_[a-z0-9_]+\.sql$/;

/** The migrations a push from the subset may apply, and the later ones it leaves out. */
export function selectSubset(sourceDir: string, through: string): Subset {
  if (!/^\d{3}$/.test(through)) throw new Error(`--through must be three digits, got "${through}"`);
  const files = readdirSync(sourceDir)
    .filter((f) => MIGRATION.test(f))
    .sort();
  const versions = files.map((f) => f.slice(0, 3));
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) throw new Error(`duplicate migration version ${duplicate}`);
  if (!versions.includes(through)) throw new Error(`no migration file for version ${through}`);
  const included = files
    .filter((f) => f.slice(0, 3) <= through)
    .map((file) => ({
      version: file.slice(0, 3),
      file,
      sha256: createHash("sha256")
        .update(readFileSync(path.join(sourceDir, file)))
        .digest("hex"),
    }));
  return { included, excluded: files.filter((f) => f.slice(0, 3) > through) };
}

/** Writes <out>/supabase/migrations with exactly the included files. */
export function writeSubset(sourceDir: string, through: string, out: string): Subset {
  if (existsSync(out)) throw new Error(`--out ${out} already exists; use a new, empty path`);
  const subset = selectSubset(sourceDir, through);
  const target = path.join(out, "supabase", "migrations");
  mkdirSync(target, { recursive: true });
  for (const f of subset.included)
    copyFileSync(path.join(sourceDir, f.file), path.join(target, f.file));
  return subset;
}

if (import.meta.main) {
  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const through = arg("through");
  const out = arg("out");
  const source = arg("source") ?? "supabase/migrations";
  try {
    if (!through || !out) throw new Error("usage: --through=NNN --out=<new dir> [--source=<dir>]");
    const subset = writeSubset(source, through, path.resolve(out));
    console.log(`Subset written to ${path.resolve(out)}/supabase/migrations`);
    console.log(
      `Included ${subset.included.length} file(s), last ${subset.included.at(-1)!.file}:`,
    );
    for (const f of subset.included) console.log(`  ${f.version}  ${f.sha256}  ${f.file}`);
    console.log(
      `Excluded ${subset.excluded.length} later file(s): ${subset.excluded.join(", ") || "none"}`,
    );
    console.log(
      `Next (from ${path.resolve(out)}): supabase db push --db-url "$DB_URL" --dry-run — STOP unless it lists exactly ${subset.included.at(-1)!.file}.`,
    );
  } catch (error) {
    console.error(`prepare-migration-subset: ${(error as Error).message}`);
    process.exit(1);
  }
}
