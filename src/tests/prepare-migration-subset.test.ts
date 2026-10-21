/**
 * scripts/prepare-migration-subset.ts builds the working directory from which
 * `supabase db push` can apply only 061 while 062–064 are also in the
 * repository (docs/RELEASE_CHECKLIST.md §8b). The dry run against a ledger
 * ending at 060 was exercised with the real CLI (PR #135); these tests pin the
 * subset itself.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { selectSubset, writeSubset } from "../../scripts/prepare-migration-subset";

const SOURCE = "supabase/migrations";
const all = readdirSync(SOURCE)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("prepare-migration-subset", () => {
  it("061: every migration up to and including 061, nothing later", () => {
    const subset = selectSubset(SOURCE, "061");
    expect(subset.included.map((f) => f.file)).toEqual(all.filter((f) => f.slice(0, 3) <= "061"));
    expect(subset.included.at(-1)!.file).toBe("061_browser_table_authority_hardening.sql");
    expect(subset.excluded).toEqual(all.filter((f) => f.slice(0, 3) > "061"));
    expect(subset.excluded).toContain("064_telegram_channel.sql");
  });

  it("writes byte-identical copies and only them", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "apsa-subset-")), "work");
    const subset = writeSubset(SOURCE, "061", out);
    const dir = path.join(out, "supabase", "migrations");
    expect(readdirSync(dir).sort()).toEqual(subset.included.map((f) => f.file));
    for (const f of subset.included) {
      expect(sha(path.join(dir, f.file))).toBe(f.sha256);
      expect(f.sha256).toBe(sha(path.join(SOURCE, f.file)));
    }
  });

  it("refuses an existing output directory", () => {
    const out = mkdtempSync(path.join(tmpdir(), "apsa-subset-"));
    expect(() => writeSubset(SOURCE, "061", out)).toThrow(/already exists/);
  });

  it("refuses a malformed or missing version", () => {
    expect(() => selectSubset(SOURCE, "61")).toThrow(/three digits/);
    expect(() => selectSubset(SOURCE, "028")).toThrow(/no migration file for version 028/);
  });

  it("refuses duplicate version numbers", () => {
    const src = mkdtempSync(path.join(tmpdir(), "apsa-subset-src-"));
    writeFileSync(path.join(src, "001_a.sql"), "select 1;");
    writeFileSync(path.join(src, "001_b.sql"), "select 1;");
    expect(() => selectSubset(src, "001")).toThrow(/duplicate migration version 001/);
  });

  it("CLI: prints the manifest and the stop rule, exits 1 on refusal", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "apsa-subset-")), "work");
    const ok = spawnSync(
      process.execPath,
      ["run", "scripts/prepare-migration-subset.ts", "--through=061", `--out=${out}`],
      { encoding: "utf8" },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("061_browser_table_authority_hardening.sql");
    expect(ok.stdout).toContain(
      "STOP unless it lists exactly 061_browser_table_authority_hardening.sql",
    );
    expect(ok.stdout).toMatch(/Excluded \d+ later file\(s\): 062_/);
    mkdirSync(path.join(out, "x"), { recursive: true });
    const refused = spawnSync(
      process.execPath,
      ["run", "scripts/prepare-migration-subset.ts", "--through=061", `--out=${out}`],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("already exists");
  });
});
