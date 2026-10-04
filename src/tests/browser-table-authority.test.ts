/**
 * Migration 061: browser roles hold no direct authority over APSA relations.
 *
 * Two layers:
 *   1. STATIC — 061's REVOKE statements must cover EXACTLY the reviewed
 *      relation list (src/tests/helpers/browser-authority-matrix.ts), each from
 *      exactly PUBLIC, anon and authenticated; the file must never GRANT, never
 *      touch service_role or function EXECUTE, never name a version-specific
 *      privilege keyword, and never alter RLS. No later migration may hand a
 *      table privilege back to a browser role. The analyser is itself tested
 *      against bad fixtures, so these assertions demonstrably fail on regression.
 *   2. RUNTIME — browser-table-authority.runtime.ts applies every migration to
 *      a real PostgreSQL (PGlite) under a permissive and a restricted baseline
 *      and proves the resulting privilege catalog, the attacks, the server
 *      workflows and the negative variants. Spawned here so it stays isolated.
 *
 * Limitation: PGlite is real PostgreSQL 17 but not a Supabase project. It
 * proves 061's effect from the two baselines; it does not prove a specific
 * hosted project's live ACLs (production needs its own read-only snapshot).
 *
 * Run: bun test src/tests/browser-table-authority.test.ts
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import { APSA_PUBLIC_RELATIONS } from "./helpers/browser-authority-matrix";

const DIR = path.join(import.meta.dir, "..", "..", "supabase", "migrations");
const FILE = "061_browser_table_authority_hardening.sql";
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

interface Analysis {
  revoked: string[];
  defaults: string[];
  violations: string[];
}

/** Statements outside the post-condition DO block (which only reads the catalog). */
function statements(sql: string): string[] {
  return strip(sql)
    .replace(/DO\s*\$\$[\s\S]*?\$\$\s*;/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function analyse(rawSql: string): Analysis {
  // String literals (RAISE messages) are not SQL; dynamic SQL is forbidden below,
  // so a literal can never smuggle a statement past these checks.
  const sql = strip(rawSql).replace(/'(?:[^']|'')*'/g, "''");
  const revoked: string[] = [];
  const defaults: string[] = [];
  const violations: string[] = [];

  const forbidden: Array<[RegExp, string]> = [
    [/\bGRANT\s+(?!OPTION)/i, "GRANT (061 only removes authority)"],
    [/\bMAINTAIN\b/i, "MAINTAIN keyword (PostgreSQL 17+ only — use REVOKE ALL)"],
    [
      /\bALL\s+(TABLES|SEQUENCES|FUNCTIONS)\s+IN\s+SCHEMA\b/i,
      "ALL ... IN SCHEMA (list relations explicitly)",
    ],
    [
      /\bON\s+(FUNCTION|ALL\s+FUNCTIONS|ROUTINE|PROCEDURE)\b|\bON\s+FUNCTIONS\b/i,
      "function privileges",
    ],
    [/\b(CREATE|ALTER|DROP)\s+POLICY\b|\bROW\s+LEVEL\s+SECURITY\b/i, "RLS change"],
    [/\bON\s+SCHEMA\b/i, "schema privilege"],
    [/\bEXECUTE\b/i, "dynamic SQL / EXECUTE"],
  ];
  for (const [re, label] of forbidden) if (re.test(sql)) violations.push(label);

  for (const stmt of statements(rawSql)) {
    let m = stmt.match(/^REVOKE ALL ON TABLE public\.([a-z_]+) FROM (.+)$/i);
    if (m) {
      const grantees = m[2]!.split(",").map((g) => g.trim());
      if (grantees.join(",") !== "PUBLIC,anon,authenticated") {
        violations.push(
          `${m[1]} revoked from ${m[2]} (must be exactly PUBLIC, anon, authenticated)`,
        );
      }
      if (revoked.includes(m[1]!)) violations.push(`duplicate revoke for ${m[1]}`);
      revoked.push(m[1]!);
      continue;
    }
    m = stmt.match(
      /^ALTER DEFAULT PRIVILEGES FOR ROLE postgres( IN SCHEMA public)? REVOKE ALL ON (TABLES|SEQUENCES) FROM PUBLIC, anon, authenticated$/,
    );
    if (m) {
      defaults.push(`${m[1] ? "public" : "global"} ${m[2]}`);
      continue;
    }
    if (/^DROP TABLE (IF EXISTS )?pg_temp\.apsa_061_service_role_before$/.test(stmt)) continue;
    if (/^CREATE TEMP TABLE apsa_061_service_role_before AS SELECT /.test(stmt)) continue;
    violations.push(`unrecognised statement: ${stmt.slice(0, 70)}`);
  }
  if (
    /\bservice_role\b/.test(
      statements(rawSql)
        .filter((s) => !/^CREATE TEMP TABLE/.test(s))
        .join(";"),
    )
  ) {
    violations.push("service_role named outside the read-only snapshot");
  }
  return { revoked: revoked.sort(), defaults: defaults.sort(), violations };
}

describe("061 static shape", () => {
  const result = analyse(read(FILE));

  it("contains only explicit REVOKEs, default-privilege REVOKEs and the read-only post-conditions", () => {
    expect(result.violations).toEqual([]);
  });

  it("revokes EXACTLY the reviewed relation list — every relation migrations 001–060 create", () => {
    expect(result.revoked).toEqual([...APSA_PUBLIC_RELATIONS].sort());
  });

  it("hardens postgres's defaults for tables and sequences, in public and globally", () => {
    expect(result.defaults).toEqual([
      "global SEQUENCES",
      "global TABLES",
      "public SEQUENCES",
      "public TABLES",
    ]);
  });

  it("asserts its own result and aborts on drift or lost server authority", () => {
    const sql = read(FILE);
    expect(sql).toContain("RAISE EXCEPTION '061: browser roles still hold table privileges on: %");
    expect(sql).toContain(
      "RAISE EXCEPTION '061: browser roles still hold column privileges on: %'",
    );
    expect(sql).toContain("RAISE EXCEPTION '061: default privileges for postgres");
    expect(sql).toContain("RAISE EXCEPTION '061: service_role lost authority");
  });

  it("ships no generic rollback that could re-grant browser authority", () => {
    expect(fs.readdirSync(DIR).filter((f) => /061.*(down|rollback|revert)/i.test(f))).toEqual([]);
  });

  it("no migration after 061 hands a table privilege back to PUBLIC, anon or authenticated", () => {
    const later = fs.readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f > FILE);
    for (const f of later) {
      for (const stmt of statements(read(f))) {
        if (!/^GRANT\b/i.test(stmt) || /\bON (FUNCTION|ROUTINE|PROCEDURE|SCHEMA)\b/i.test(stmt))
          continue;
        expect({
          f,
          stmt,
          browser: /\bTO\b[^;]*\b(PUBLIC|anon|authenticated)\b/i.test(stmt),
        }).toEqual({
          f,
          stmt,
          browser: false,
        });
      }
      expect({
        f,
        defaults:
          /ALTER DEFAULT PRIVILEGES[^;]*\bGRANT\b[^;]*\b(PUBLIC|anon|authenticated)\b/i.test(
            strip(read(f)),
          ),
      }).toEqual({
        f,
        defaults: false,
      });
    }
  });
});

describe("the analyser fails on the regressions it exists to catch", () => {
  const real = read(FILE);

  it("catches a relation dropped from the list", () => {
    const weakened = real.replace(/^REVOKE ALL ON TABLE public\.payments\s.*$/m, "");
    expect(analyse(weakened).revoked).not.toContain("payments");
    expect(analyse(weakened).revoked).not.toEqual([...APSA_PUBLIC_RELATIONS].sort());
  });

  it("catches a grantee dropped from a revoke (authenticated, anon or PUBLIC)", () => {
    for (const kept of ["PUBLIC, anon", "PUBLIC, authenticated", "anon, authenticated"]) {
      const weakened = real.replace(
        "REVOKE ALL ON TABLE public.customers                FROM PUBLIC, anon, authenticated;",
        `REVOKE ALL ON TABLE public.customers FROM ${kept};`,
      );
      expect(analyse(weakened).violations.join()).toContain("customers revoked from");
    }
  });

  it("catches the default-privilege hardening being removed", () => {
    const weakened = real.replace(/ALTER DEFAULT PRIVILEGES[^;]*;/g, "");
    expect(analyse(weakened).defaults).toEqual([]);
  });

  it("catches GRANT, MAINTAIN, blanket statements, function and RLS changes, and service_role", () => {
    for (const bad of [
      "GRANT SELECT ON public.customers TO authenticated;",
      "GRANT ALL ON public.customers TO anon;",
      "REVOKE MAINTAIN ON public.customers FROM anon;",
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;",
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;",
      "REVOKE EXECUTE ON FUNCTION public.accept_invitation(text) FROM authenticated;",
      "ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;",
      "DROP POLICY customers_select_member ON public.customers;",
      "REVOKE ALL ON TABLE public.customers FROM service_role;",
      "DO $$ BEGIN EXECUTE 'GRANT ALL ON public.customers TO anon'; END $$;",
    ]) {
      expect({ bad, ok: analyse(`${real}\n${bad}\n`).violations.length === 0 }).toEqual({
        bad,
        ok: false,
      });
    }
  });
});

describe("061 against a real PostgreSQL (PGlite, every migration in order)", () => {
  it("hardens a permissive and a restricted baseline without touching server authority", () => {
    const result = spawnSync(
      process.execPath,
      ["test", path.resolve("src/tests/browser-table-authority.runtime.ts")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 400000,
        env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
      },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 420000);
});
