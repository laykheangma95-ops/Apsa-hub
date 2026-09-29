/**
 * Migration 048: explicit service_role table grants.
 *
 * Migrations 001–036 relied on Supabase's default privileges. A project created
 * under the restricted defaults applies every migration and then fails each
 * server request with 42501 (found in the fresh-database staging rehearsal).
 * 048 makes the grants explicit — and must not re-open the payment ledger that
 * migration 040 closed to direct service_role writes.
 *
 * Static SQL assertions only; the live behaviour is proven by verify:readiness /
 * verify:staging against a staging project.
 *
 * Run: bun test src/tests/service-role-table-grants.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const DIR = path.join(import.meta.dir, "..", "..", "supabase", "migrations");
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

const FILE = "048_service_role_table_grants.sql";
const sql = strip(read(FILE));

describe("048 service_role table grants", () => {
  it("exists and grants to service_role only", () => {
    expect(fs.existsSync(path.join(DIR, FILE))).toBe(true);
    expect(sql).toContain("TO service_role");
    expect(sql).not.toMatch(/\bTO\s+(anon|authenticated|PUBLIC)\b/i);
  });

  it("never grants TRUNCATE, ALL, REFERENCES or TRIGGER, and changes no default privileges", () => {
    expect(sql).not.toMatch(/GRANT\s+ALL/i);
    expect(sql).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it("keeps the payment ledger read-only for service_role (migration 040 invariant)", () => {
    for (const t of ["payments", "payment_events", "payment_evidence"]) {
      expect(sql).toContain(`'${t}'`);
    }
    // The write grant is only reachable in the branch that excludes the ledger.
    const writeGrants = sql.match(/GRANT SELECT, INSERT, UPDATE, DELETE[^;]*/g) ?? [];
    expect(writeGrants.length).toBe(1);
    expect(sql).toMatch(/r\.relkind = 'v' OR r\.relname = ANY \(payment_ledger\)[\s\S]*?GRANT SELECT ON TABLE/);
  });

  it("no migration after 040 hands the payment ledger write privileges back to service_role", () => {
    const later = fs
      .readdirSync(DIR)
      .filter((f) => /^\d{3}_/.test(f) && f > "040" && f !== FILE);
    for (const f of later) {
      const body = strip(read(f));
      expect(body).not.toMatch(
        /GRANT\s+(ALL|[^;]*\b(INSERT|UPDATE|DELETE)\b)[^;]*\bpayment(s|_events|_evidence)\b[^;]*TO\s+service_role/i,
      );
    }
  });
});
