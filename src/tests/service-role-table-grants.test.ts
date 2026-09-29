/**
 * Migration 048: explicit, reviewed service_role table grants.
 *
 * Migrations 001–036 relied on Supabase's default privileges. A project created
 * under the restricted defaults applies every migration and then fails each
 * server request with 42501 (found in the fresh-database staging rehearsal).
 * 048 states the grants explicitly — for an allowlist, not for "everything" —
 * and must not re-open what 040 closed.
 *
 * Two layers:
 *   1. STATIC — the migration's GRANT statements must equal the reviewed matrix
 *      (src/tests/helpers/service-role-grant-matrix.ts) exactly, and the file must
 *      contain no blanket, catalog-driven, future-object or non-service_role
 *      construct. The analyser is itself tested against bad fixtures, so these
 *      assertions demonstrably fail when the migration regresses.
 *   2. RUNTIME — service-role-table-grants.runtime.ts applies every migration to
 *      a real PostgreSQL (PGlite) under restricted AND permissive defaults and
 *      checks the resulting privilege catalog. Spawned here so it stays isolated.
 *
 * Limitation: PGlite is real PostgreSQL but not a Supabase project. It proves the
 * migration's effect under the two documented default-privilege regimes; it does
 * not prove a specific hosted project's configuration (verify:readiness does).
 *
 * Run: bun test src/tests/service-role-table-grants.test.ts
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {
  EARLIER_EXPLICIT_GRANTS,
  MIGRATION_048_GRANTS,
  PAYMENT_LEDGER,
} from "./helpers/service-role-grant-matrix";

const DIR = path.join(import.meta.dir, "..", "..", "supabase", "migrations");
const FILE = "048_service_role_table_grants.sql";
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

interface Analysis {
  grants: Record<string, string[]>;
  violations: string[];
}

/** Parse a migration's GRANT statements and report anything outside the allowed shape. */
function analyse(rawSql: string): Analysis {
  const sql = strip(rawSql);
  const grants: Record<string, string[]> = {};
  const violations: string[] = [];

  const forbidden: Array<[RegExp, string]> = [
    [/\bDO\b\s*(\$|')/i, "anonymous DO block"],
    [/\b(LOOP|FOR\s+\w+\s+IN)\b/i, "loop"],
    [
      /\bpg_class\b|\bpg_tables\b|\bpg_namespace\b|\binformation_schema\b|\bpg_catalog\b/i,
      "catalog scan",
    ],
    [/\bALL\s+(TABLES|SEQUENCES|FUNCTIONS)\s+IN\s+SCHEMA\b/i, "ALL ... IN SCHEMA"],
    [/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, "ALTER DEFAULT PRIVILEGES"],
    [/\bON\s+SCHEMA\b/i, "schema-level grant"],
    [/\bGRANT\s+ALL\b/i, "GRANT ALL"],
    [/\b(TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i, "non-DML privilege"],
    [/\bREVOKE\b/i, "REVOKE (048 is grant-only)"],
    [/\bEXECUTE\b/i, "EXECUTE (048 is table privileges only)"],
    [/\bWITH\s+GRANT\s+OPTION\b/i, "GRANT OPTION"],
    [/\bformat\s*\(|\bEXECUTE\s+format\b/i, "dynamic SQL"],
  ];
  for (const [re, label] of forbidden) if (re.test(sql)) violations.push(label);

  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    const m = stmt.match(
      /^GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?public\.([a-z_]+)\s+TO\s+([a-z_, ]+)$/i,
    );
    if (!m) {
      violations.push(`unrecognised statement: ${stmt.slice(0, 60)}`);
      continue;
    }
    const [, privs, rel, grantees] = m;
    if (grantees!.trim().toLowerCase() !== "service_role") {
      violations.push(`grantee is not service_role: ${grantees}`);
    }
    const list = privs!
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
      .sort();
    if (grants[rel!]) violations.push(`duplicate grant statement for ${rel}`);
    grants[rel!] = list;
  }
  return { grants, violations };
}

describe("048 static shape", () => {
  const result = analyse(read(FILE));

  it("contains no blanket, catalog-driven, future-object or non-service_role construct", () => {
    expect(result.violations).toEqual([]);
  });

  it("grants EXACTLY the reviewed allowlist — every object, every privilege", () => {
    const expected: Record<string, string[]> = {};
    for (const [rel, privs] of Object.entries(MIGRATION_048_GRANTS))
      expected[rel] = [...privs].sort();
    expect(result.grants).toEqual(expected);
  });

  it("does not touch objects earlier migrations made explicit (037, 040, 045)", () => {
    for (const rel of Object.keys(EARLIER_EXPLICIT_GRANTS)) {
      expect(result.grants[rel]).toBeUndefined();
    }
  });

  it("keeps the payment ledger read-only (migration 040)", () => {
    for (const t of PAYMENT_LEDGER) expect(result.grants[t]).toEqual(["SELECT"]);
    expect(result.grants.payment_reconciliation_summary).toEqual(["SELECT"]);
  });

  it("never grants webhook_event_receipts or rate_limit_buckets (045 owns them)", () => {
    expect(result.grants.webhook_event_receipts).toBeUndefined();
    expect(result.grants.rate_limit_buckets).toBeUndefined();
    const s045 = strip(read("045_operability_rate_limits_webhooks.sql"));
    expect(s045).toMatch(
      /GRANT SELECT, INSERT, DELETE ON TABLE public\.webhook_event_receipts TO service_role/,
    );
    expect(s045).not.toMatch(/GRANT[^;]*UPDATE[^;]*webhook_event_receipts/i);
  });

  it("no migration after 040 hands the payment ledger write privileges back to service_role", () => {
    const later = fs.readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f > "040");
    for (const f of later) {
      expect(strip(read(f))).not.toMatch(
        /GRANT\s+(ALL|[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE)\b)[^;]*\bpayment(s|_events|_evidence)\b[^;]*TO\s+service_role/i,
      );
    }
  });
});

describe("the analyser fails on the regressions it exists to catch", () => {
  const bad = (sql: string) => analyse(sql);

  it("catches a catalog-loop migration (the original 048)", () => {
    const sql = `DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LOOP EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', r.relname); END LOOP; END $$;`;
    expect(bad(sql).violations.length).toBeGreaterThan(0);
  });

  it("catches GRANT ... ON ALL TABLES and ALTER DEFAULT PRIVILEGES (future-table access)", () => {
    expect(
      bad("GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;").violations,
    ).not.toEqual([]);
    expect(
      bad("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO service_role;")
        .violations,
    ).not.toEqual([]);
  });

  it("catches a grant to anon or authenticated or PUBLIC", () => {
    for (const g of ["anon", "authenticated", "PUBLIC", "service_role, anon"]) {
      expect(bad(`GRANT SELECT ON public.organizations TO ${g};`).violations).not.toEqual([]);
    }
  });

  it("catches payment writes being re-granted", () => {
    const a = bad("GRANT SELECT, INSERT ON public.payments TO service_role;");
    expect(a.grants.payments).toEqual(["INSERT", "SELECT"]);
    expect(a.grants.payments).not.toEqual([...(MIGRATION_048_GRANTS.payments ?? [])]);
    expect(bad("GRANT ALL ON public.payments TO service_role;").violations).not.toEqual([]);
    expect(bad("GRANT TRUNCATE ON public.payments TO service_role;").violations).not.toEqual([]);
  });

  it("catches an UPDATE grant on webhook_event_receipts differing from 045's exact set", () => {
    const a = bad(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_event_receipts TO service_role;",
    );
    expect(a.grants.webhook_event_receipts).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    // 048 must not mention the table at all; the equality test above would fail.
    expect(MIGRATION_048_GRANTS.webhook_event_receipts).toBeUndefined();
  });

  it("catches a removed required grant and an extra unlisted object", () => {
    const real = read(FILE).replace(/^GRANT SELECT\s+ON public\.roles\b.*$/m, "");
    expect(analyse(real).grants.roles).toBeUndefined();
    const extra = read(FILE) + "\nGRANT SELECT ON public.something_new TO service_role;\n";
    expect(Object.keys(analyse(extra).grants)).toContain("something_new");
  });
});

describe("048 against a real PostgreSQL (PGlite, every migration in order)", () => {
  it("holds under restricted and permissive default privileges", () => {
    const result = spawnSync(
      process.execPath,
      ["test", path.resolve("src/tests/service-role-table-grants.runtime.ts")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 240000,
        env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
      },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 250000);
});
