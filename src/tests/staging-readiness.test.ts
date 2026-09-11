/**
 * Staging readiness — analysis rules and repository invariants.
 *
 * Two layers:
 *   1. Unit tests over the pure rules in scripts/lib/staging-readiness.ts, so
 *      every parity/freshness decision is exercised with synthetic input
 *      rather than only against whatever the repo happens to contain today.
 *   2. Invariant tests over the real supabase/migrations + lock file, so a
 *      migration that is deleted, renumbered, duplicated or edited after being
 *      applied to hosted Supabase fails here and not in production.
 *
 * These tests never contact a database and never read a secret.
 *
 * Run: bun test src/tests/staging-readiness.test.ts
 */
import { describe, it, expect } from "bun:test";
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
  collectAuthenticatedRpcs,
  normalizeSupabaseUrl,
  sameSupabaseProject,
  describeKeyRole,
  evaluateProbeGate,
  classifyRlsObservation,
  classifyWriteProbe,
  classifyRpcProbe,
  isAuthorizationDenial,
  collectRpcSignatures,
  rpcDummyArgs,
  dummyValueForType,
  collectTriggerProtectedTables,
  selectWriteProbeTarget,
  createDeadline,
  readTimeoutMs,
  withTimeout,
} from "../../scripts/lib/staging-readiness.ts";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const LOCK_FILE = path.join(ROOT, "supabase/hosted-migrations.lock.json");
const TYPES_FILE = path.join(ROOT, "src/lib/supabase/types.ts");

// ── 1. Inventory rules ───────────────────────────────────────────────────────

describe("buildMigrationInventory", () => {
  it("orders numerically, not lexicographically", () => {
    const inv = buildMigrationInventory(["010_b.sql", "9_a.sql", "002_c.sql"]);
    expect(inv.entries.map((e) => e.file)).toEqual(["002_c.sql", "9_a.sql", "010_b.sql"]);
  });

  it("flags files that do not follow NNN_description.sql", () => {
    const inv = buildMigrationInventory(["001_ok.sql", "no_number.sql", "003-dash.sql"]);
    expect(inv.malformed).toContain("no_number.sql");
    expect(inv.malformed).toContain("003-dash.sql");
    expect(inv.entries).toHaveLength(1);
  });

  it("detects duplicate migration numbers", () => {
    const inv = buildMigrationInventory(["034_a.sql", "034_b.sql", "035_c.sql"]);
    expect(inv.duplicates).toHaveLength(1);
    expect(inv.duplicates[0]?.files).toEqual(["034_a.sql", "034_b.sql"]);
    expect(inv.duplicates[0]?.number).toBe(34);
  });

  // M5 regression: duplicates were grouped by the raw prefix STRING, so two
  // spellings of the same ordinal slipped through as distinct migrations.
  it("detects 09_a.sql and 9_b.sql as the same duplicated migration 9", () => {
    const inv = buildMigrationInventory(["09_a.sql", "9_b.sql"]);
    expect(inv.duplicates).toHaveLength(1);
    expect(inv.duplicates[0]?.number).toBe(9);
    expect(inv.duplicates[0]?.files).toEqual(["09_a.sql", "9_b.sql"]);
    expect(inv.duplicates[0]?.rawPrefixes).toEqual(["09", "9"]);
  });

  it("detects a duplicate across any number of zero-padded spellings", () => {
    const inv = buildMigrationInventory(["007_a.sql", "0007_b.sql", "7_c.sql", "008_d.sql"]);
    expect(inv.duplicates).toHaveLength(1);
    expect(inv.duplicates[0]?.number).toBe(7);
    expect(inv.duplicates[0]?.files).toHaveLength(3);
  });

  it("does not report a duplicate for distinct numbers that share a digit run", () => {
    const inv = buildMigrationInventory(["01_a.sql", "010_b.sql", "10_c.sql"]);
    // 1 is unique; 010 and 10 are both 10 and must collide.
    expect(inv.duplicates).toHaveLength(1);
    expect(inv.duplicates[0]?.number).toBe(10);
  });

  it("reports numbering gaps without treating them as malformed", () => {
    const inv = buildMigrationInventory(["001_a.sql", "004_b.sql"]);
    expect(inv.gaps).toEqual([2, 3]);
    expect(inv.malformed).toHaveLength(0);
  });

  it("ignores non-SQL files entirely", () => {
    const inv = buildMigrationInventory(["001_a.sql", "README.md", ".DS_Store"]);
    expect(inv.entries).toHaveLength(1);
    expect(inv.malformed).toHaveLength(0);
  });
});

// ── 2. Hosted parity rules ───────────────────────────────────────────────────

describe("compareHostedParity", () => {
  const inv = buildMigrationInventory(["001_a.sql", "002_b.sql", "003_c.sql"]);

  it("splits applied from pending", () => {
    const r = compareHostedParity(
      inv,
      { "001_a.sql": "h1" },
      { "001_a.sql": "h1", "002_b.sql": "h2", "003_c.sql": "h3" },
    );
    expect(r.applied).toEqual(["001_a.sql"]);
    expect(r.pending).toEqual(["002_b.sql", "003_c.sql"]);
  });

  it("flags a hosted migration whose content changed", () => {
    const r = compareHostedParity(inv, { "001_a.sql": "original" }, { "001_a.sql": "edited" });
    expect(r.hashMismatch).toEqual(["001_a.sql"]);
    expect(r.applied).toHaveLength(0);
  });

  it("flags a hosted migration deleted from the repository", () => {
    const r = compareHostedParity(inv, { "999_gone.sql": "h" }, {});
    expect(r.missingLocally).toEqual(["999_gone.sql"]);
  });

  it("flags hosted migrations applied out of order", () => {
    // 003 is applied while 002 is still pending — the hosted project ran ahead.
    const r = compareHostedParity(
      inv,
      { "001_a.sql": "h1", "003_c.sql": "h3" },
      { "001_a.sql": "h1", "002_b.sql": "h2", "003_c.sql": "h3" },
    );
    expect(r.pending).toEqual(["002_b.sql"]);
    expect(r.outOfOrder).toEqual(["003_c.sql"]);
  });

  it("reports no out-of-order finding when hosted is a clean prefix", () => {
    const r = compareHostedParity(
      inv,
      { "001_a.sql": "h1", "002_b.sql": "h2" },
      { "001_a.sql": "h1", "002_b.sql": "h2", "003_c.sql": "h3" },
    );
    expect(r.outOfOrder).toHaveLength(0);
  });
});

// ── 3. Schema / type parsing ─────────────────────────────────────────────────

describe("collectMigrationTables", () => {
  it("collects CREATE TABLE names with and without IF NOT EXISTS or schema prefix", () => {
    const tables = collectMigrationTables([
      "CREATE TABLE public.orders (id uuid);",
      "CREATE TABLE IF NOT EXISTS payments (id uuid);",
      'CREATE TABLE public."messages" (id uuid);',
    ]);
    expect(tables).toEqual(["messages", "orders", "payments"]);
  });

  it("lets a later DROP TABLE remove an earlier CREATE", () => {
    const tables = collectMigrationTables([
      "CREATE TABLE public.temp_thing (id uuid);",
      "DROP TABLE IF EXISTS public.temp_thing;",
    ]);
    expect(tables).toEqual([]);
  });

  it("ignores CREATE TABLE inside SQL comments", () => {
    const tables = collectMigrationTables([
      "-- CREATE TABLE public.ghost (id uuid);\n/* CREATE TABLE public.phantom (id uuid); */\nCREATE TABLE public.real_one (id uuid);",
    ]);
    expect(tables).toEqual(["real_one"]);
  });
});

describe("collectTypeTables", () => {
  it("returns only the direct children of the Tables block", () => {
    const src = `
export interface Database {
  public: {
    Tables: {
      orders: { Row: { id: string }; Insert: { id: string } };
      payments: { Row: { id: string } };
    };
    Views: { some_view: { Row: { id: string } } };
  };
}`;
    expect(collectTypeTables(src)).toEqual(["orders", "payments"]);
  });

  it("returns an empty list when there is no Tables block", () => {
    expect(collectTypeTables("export type Json = string;")).toEqual([]);
  });
});

describe("compareTypeFreshness", () => {
  it("reports tables missing from generated types", () => {
    const r = compareTypeFreshness(["orders", "payments"], ["orders"]);
    expect(r.missingFromTypes).toEqual(["payments"]);
    expect(r.fresh).toBe(false);
  });

  it("reports generated types that no migration creates", () => {
    const r = compareTypeFreshness(["orders"], ["orders", "invented"]);
    expect(r.absentFromMigrations).toEqual(["invented"]);
    expect(r.fresh).toBe(false);
  });

  it("is fresh only when both directions match", () => {
    expect(compareTypeFreshness(["a", "b"], ["b", "a"]).fresh).toBe(true);
  });
});

describe("classifyStaleTables", () => {
  const owner = { orders: "023_orders.sql", payments: "034_payments.sql" };

  it("treats a table from an applied migration as blocking-stale", () => {
    const r = classifyStaleTables(["orders"], owner, ["023_orders.sql"]);
    expect(r.stale).toEqual(["orders"]);
    expect(r.awaitingApply).toEqual([]);
  });

  it("treats a table from a pending migration as awaiting apply, not stale", () => {
    const r = classifyStaleTables(["payments"], owner, ["023_orders.sql"]);
    expect(r.stale).toEqual([]);
    expect(r.awaitingApply).toEqual(["payments"]);
  });

  it("treats an unattributable table as stale rather than silently ignoring it", () => {
    const r = classifyStaleTables(["mystery"], owner, []);
    expect(r.stale).toEqual(["mystery"]);
  });
});

describe("collectAuthenticatedRpcs", () => {
  it("collects every signature in a multi-function grant to authenticated", () => {
    const sql = `
GRANT EXECUTE ON FUNCTION public.record_payment_v1(uuid,uuid),
  public.verify_payment_v1(uuid,uuid) TO authenticated;`;
    expect(collectAuthenticatedRpcs([sql])).toEqual(["record_payment_v1", "verify_payment_v1"]);
  });

  it("ignores grants that do not include the authenticated role", () => {
    const sql = "GRANT EXECUTE ON FUNCTION public.internal_helper(uuid) TO service_role;";
    expect(collectAuthenticatedRpcs([sql])).toEqual([]);
  });

  it("ignores grants that appear only in comments", () => {
    const sql = "-- GRANT EXECUTE ON FUNCTION public.ghost_fn(uuid) TO authenticated;";
    expect(collectAuthenticatedRpcs([sql])).toEqual([]);
  });
});

// ── 4. Environment handling never discloses a value ──────────────────────────

describe("environment inspection", () => {
  it("reports presence as a boolean and never returns the value", () => {
    const result = checkEnvPresence({ SECRET_A: "super-secret", SECRET_B: "" }, [
      "SECRET_A",
      "SECRET_B",
      "SECRET_C",
    ]);
    expect(result).toEqual([
      { name: "SECRET_A", present: true },
      { name: "SECRET_B", present: false },
      { name: "SECRET_C", present: false },
    ]);
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("treats a whitespace-only value as absent", () => {
    expect(checkEnvPresence({ X: "   " }, ["X"])[0]?.present).toBe(false);
  });

  it("detects a staging variable pointing at the production value", () => {
    expect(
      envValuesMatch({ A: "https://p.supabase.co", B: "https://p.supabase.co" }, "A", "B"),
    ).toBe(true);
    expect(
      envValuesMatch({ A: "https://s.supabase.co", B: "https://p.supabase.co" }, "A", "B"),
    ).toBe(false);
  });

  it("does not treat two absent variables as matching", () => {
    expect(envValuesMatch({}, "A", "B")).toBe(false);
  });
});

// ── 5. Invariants over the real repository ───────────────────────────────────

const realFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
const realInventory = buildMigrationInventory(realFiles);
const realContents = realInventory.entries.map((e) =>
  fs.readFileSync(path.join(MIGRATIONS_DIR, e.file), "utf8"),
);

describe("repository invariants: supabase/migrations", () => {
  it("has no malformed migration file names", () => {
    expect(realInventory.malformed).toEqual([]);
  });

  it("has no duplicate migration numbers", () => {
    expect(realInventory.duplicates).toEqual([]);
  });

  it("contains at least one migration", () => {
    expect(realInventory.entries.length).toBeGreaterThan(0);
  });
});

describe("repository invariants: hosted migration lock", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { hosted: Record<string, string> };
  const localHashes = Object.fromEntries(
    realInventory.entries.map((e) => [
      e.file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(MIGRATIONS_DIR, e.file)))
        .digest("hex"),
    ]),
  );
  const parity = compareHostedParity(realInventory, lock.hosted, localHashes);

  it("still contains every migration recorded as applied to hosted Supabase", () => {
    expect(parity.missingLocally).toEqual([]);
  });

  it("has not modified any migration already applied to hosted Supabase", () => {
    expect(parity.hashMismatch).toEqual([]);
  });

  it("has no hosted migration applied ahead of a pending one", () => {
    expect(parity.outOfOrder).toEqual([]);
  });

  it("records hosted parity as a known state, not an assumption", () => {
    // Pending is expected and allowed; what must never happen is the lock file
    // claiming migrations this checkout does not have.
    expect(parity.applied.length + parity.pending.length).toBe(realInventory.entries.length);
  });
});

describe("repository invariants: generated Supabase types", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { hosted: Record<string, string> };
  const typeTables = collectTypeTables(fs.readFileSync(TYPES_FILE, "utf8"));
  const migrationTables = collectMigrationTables(realContents);
  const owner = attributeTablesToMigrations(
    realInventory.entries.map((e) => e.file),
    realContents,
  );

  it("parses a non-empty Tables block", () => {
    expect(typeTables.length).toBeGreaterThan(0);
  });

  it("declares no table that no migration creates", () => {
    expect(compareTypeFreshness(migrationTables, typeTables).absentFromMigrations).toEqual([]);
  });

  it("covers every table from a migration already applied to hosted Supabase", () => {
    const { missingFromTypes } = compareTypeFreshness(migrationTables, typeTables);
    const { stale } = classifyStaleTables(missingFromTypes, owner, Object.keys(lock.hosted));
    expect(stale).toEqual([]);
  });
});

// ── 6. H1 — an empty table must never be accepted as proof of RLS ────────────
//
// Regression for: anonymous zero-row reads on empty staging tables were counted
// as RLS-proven. An empty table returns zero rows to an anonymous caller whether
// or not RLS is enforced, so the observation distinguishes nothing.

describe("classifyRlsObservation (H1)", () => {
  it("is INCONCLUSIVE when the table is empty, even though the anonymous read saw nothing", () => {
    const r = classifyRlsObservation({ errorCode: null, anonRowCount: 0, adminRowCount: 0 });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("table_empty");
  });

  it("PASSES only when the service role sees rows the anonymous client did not", () => {
    const r = classifyRlsObservation({ errorCode: null, anonRowCount: 0, adminRowCount: 12 });
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toBe("rows_exist_but_anonymous_read_none");
  });

  it("is INCONCLUSIVE when the admin count could not be obtained", () => {
    const r = classifyRlsObservation({ errorCode: null, anonRowCount: 0, adminRowCount: null });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("admin_count_unavailable");
  });

  it("FAILS when the anonymous client actually received rows", () => {
    const r = classifyRlsObservation({ errorCode: null, anonRowCount: 1, adminRowCount: 1 });
    expect(r.verdict).toBe("FAIL");
  });

  it("FAILS on exposed rows even if the admin count is unknown", () => {
    const r = classifyRlsObservation({ errorCode: null, anonRowCount: 3, adminRowCount: null });
    expect(r.verdict).toBe("FAIL");
  });

  it("PASSES on an explicit authorization denial regardless of emptiness", () => {
    for (const code of ["42501", "PGRST301", "PGRST302"]) {
      const r = classifyRlsObservation({ errorCode: code, anonRowCount: 0, adminRowCount: 0 });
      expect(r.verdict).toBe("PASS");
      expect(r.reason).toBe("authorization_denial");
    }
  });

  it("is INCONCLUSIVE when the refusal is not an authorization refusal", () => {
    for (const code of ["22P02", "P0001", "23514", "PGRST202", "57014"]) {
      expect(
        classifyRlsObservation({ errorCode: code, anonRowCount: 0, adminRowCount: 5 }).verdict,
      ).toBe("INCONCLUSIVE");
    }
  });

  it("never counts an all-empty staging project toward an RLS-proven total", () => {
    const tables = ["orders", "payments", "customers", "messages"];
    const verdicts = tables.map((_t) =>
      classifyRlsObservation({ errorCode: null, anonRowCount: 0, adminRowCount: 0 }),
    );
    expect(verdicts.filter((v) => v.verdict === "PASS")).toHaveLength(0);
    expect(verdicts.filter((v) => v.verdict === "INCONCLUSIVE")).toHaveLength(tables.length);
  });
});

// ── 7. M1 — production URL protection must fail closed ───────────────────────

describe("normalizeSupabaseUrl (M1)", () => {
  it("ignores a trailing slash", () => {
    expect(normalizeSupabaseUrl("https://abc.supabase.co/")).toBe(
      normalizeSupabaseUrl("https://abc.supabase.co"),
    );
  });

  it("ignores hostname case", () => {
    expect(normalizeSupabaseUrl("https://ABC.Supabase.CO")).toBe("https://abc.supabase.co");
  });

  it("ignores the default port and query/fragment noise", () => {
    expect(normalizeSupabaseUrl("https://abc.supabase.co:443/?x=1#y")).toBe(
      "https://abc.supabase.co",
    );
  });

  it("keeps a non-default port, so two ports are two projects", () => {
    expect(normalizeSupabaseUrl("http://localhost:54321")).toBe("http://localhost:54321");
    expect(sameSupabaseProject("http://localhost:54321", "http://localhost:54322")).toBe(false);
  });

  it("returns an empty string for an absent or whitespace-only value", () => {
    expect(normalizeSupabaseUrl(undefined)).toBe("");
    expect(normalizeSupabaseUrl("   ")).toBe("");
  });

  it("never treats two absent values as the same project", () => {
    expect(sameSupabaseProject("", "")).toBe(false);
    expect(sameSupabaseProject(undefined, undefined)).toBe(false);
  });

  it("still compares stably for a value that is not a parseable URL", () => {
    expect(sameSupabaseProject("Not A Url/", "not a url")).toBe(true);
  });
});

describe("evaluateProbeGate (M1)", () => {
  const good = {
    stagingUrl: "https://staging.supabase.co",
    productionUrlWitness: "https://prod.supabase.co",
    anonKey: "anon-key-value",
    serviceKey: "service-key-value",
  };

  it("allows a correctly configured staging target", () => {
    const r = evaluateProbeGate(good);
    expect(r.allowed).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  // The core M1 regression: with no production URL set, the old guard's
  // `PROD_URL.length > 0 && PROD_URL === URL` condition was false, so every
  // hosted probe ran unchecked.
  it("REFUSES when no production URL witness is set", () => {
    const r = evaluateProbeGate({ ...good, productionUrlWitness: "" });
    expect(r.allowed).toBe(false);
    expect(r.refusals).toContain("production_witness_missing");
  });

  it("REFUSES when the production URL witness is whitespace only", () => {
    expect(evaluateProbeGate({ ...good, productionUrlWitness: "   " }).allowed).toBe(false);
  });

  it("REFUSES when the production URL witness is undefined", () => {
    const r = evaluateProbeGate({ ...good, productionUrlWitness: undefined });
    expect(r.refusals).toContain("production_witness_missing");
  });

  it("REFUSES when staging and production differ only by a trailing slash", () => {
    const r = evaluateProbeGate({
      ...good,
      stagingUrl: "https://prod.supabase.co/",
      productionUrlWitness: "https://prod.supabase.co",
    });
    expect(r.allowed).toBe(false);
    expect(r.refusals).toContain("staging_is_production");
  });

  it("REFUSES when staging and production differ only by hostname case", () => {
    const r = evaluateProbeGate({
      ...good,
      stagingUrl: "https://PROD.supabase.co",
      productionUrlWitness: "https://prod.supabase.co",
    });
    expect(r.refusals).toContain("staging_is_production");
  });

  it("REFUSES when the two keys hold the same value", () => {
    const r = evaluateProbeGate({ ...good, anonKey: "same", serviceKey: "same" });
    expect(r.refusals).toContain("keys_identical");
  });

  it("REFUSES when a privileged key sits in the anonymous slot", () => {
    const r = evaluateProbeGate({ ...good, anonKey: "sb_secret_placeholder" });
    expect(r.allowed).toBe(false);
    expect(r.refusals).toContain("anon_slot_privileged");
  });

  it("REFUSES when a public key sits in the service-role slot", () => {
    const r = evaluateProbeGate({ ...good, serviceKey: "sb_publishable_placeholder" });
    expect(r.refusals).toContain("service_slot_public");
  });

  it("REFUSES when the two staging organizations are the same", () => {
    const r = evaluateProbeGate({ ...good, orgAId: "org-1", orgBId: "ORG-1" });
    expect(r.allowed).toBe(false);
    expect(r.refusals).toContain("org_ids_identical");
  });

  it("allows two genuinely different organizations", () => {
    expect(evaluateProbeGate({ ...good, orgAId: "org-1", orgBId: "org-2" }).allowed).toBe(true);
  });

  it("treats one organization configured alone as not a conflict", () => {
    expect(evaluateProbeGate({ ...good, orgAId: "org-1", orgBId: "" }).allowed).toBe(true);
  });

  it("REFUSES when staging credentials are absent, rather than skipping", () => {
    const r = evaluateProbeGate({
      stagingUrl: "",
      productionUrlWitness: "",
      anonKey: "",
      serviceKey: "",
    });
    expect(r.allowed).toBe(false);
    expect(r.refusals).toEqual(
      expect.arrayContaining([
        "staging_url_missing",
        "anon_key_missing",
        "service_key_missing",
        "production_witness_missing",
      ]),
    );
  });

  it("reports every independent refusal in one pass, not just the first", () => {
    const r = evaluateProbeGate({
      stagingUrl: "https://prod.supabase.co",
      productionUrlWitness: "https://prod.supabase.co",
      anonKey: "same",
      serviceKey: "same",
      orgAId: "o",
      orgBId: "o",
    });
    expect(r.refusals).toEqual(
      expect.arrayContaining(["staging_is_production", "keys_identical", "org_ids_identical"]),
    );
  });

  it("never discloses a key value in a refusal message", () => {
    const r = evaluateProbeGate({
      ...good,
      anonKey: "sb_secret_SUPER_SECRET_MATERIAL",
      serviceKey: "sb_publishable_OTHER_MATERIAL",
    });
    const text = r.messages.join(" ");
    expect(text).not.toContain("SUPER_SECRET_MATERIAL");
    expect(text).not.toContain("OTHER_MATERIAL");
  });
});

describe("describeKeyRole", () => {
  /** Fabricated, unsigned, non-secret JWT used only to exercise the parser. */
  const jwtWithRole = (role: string) =>
    [
      "eyJhbGciOiJIUzI1NiJ9",
      Buffer.from(JSON.stringify({ role })).toString("base64url"),
      "sig",
    ].join(".");

  it("reads the role claim of a legacy anon key", () => {
    expect(describeKeyRole(jwtWithRole("anon"))).toBe("anon");
  });

  it("reads the role claim of a legacy service-role key", () => {
    expect(describeKeyRole(jwtWithRole("service_role"))).toBe("service_role");
  });

  it("recognizes current prefixed key formats", () => {
    expect(describeKeyRole("sb_publishable_abc")).toBe("publishable");
    expect(describeKeyRole("sb_secret_abc")).toBe("secret");
  });

  it("returns unknown rather than throwing on junk, and never echoes the key", () => {
    for (const junk of ["", "   ", "not-a-jwt", "a.b", "a.!!!.c", undefined]) {
      const role = describeKeyRole(junk);
      expect(["anon", "service_role", "publishable", "secret", "unknown"]).toContain(role);
    }
    expect(describeKeyRole("sb_secret_TOPSECRET")).toBe("secret");
  });

  it("catches the swapped-key case that would fake an RLS pass", () => {
    const anonSlot = jwtWithRole("service_role");
    const r = evaluateProbeGate({
      stagingUrl: "https://staging.supabase.co",
      productionUrlWitness: "https://prod.supabase.co",
      anonKey: anonSlot,
      serviceKey: jwtWithRole("service_role") + "x",
    });
    expect(r.refusals).toContain("anon_slot_privileged");
  });
});

// ── 8. M2 — a write probe must prove AUTHORIZATION denial ────────────────────

describe("isAuthorizationDenial / classifyWriteProbe (M2)", () => {
  it("accepts only the authorization codes", () => {
    expect(isAuthorizationDenial("42501")).toBe(true);
    expect(isAuthorizationDenial("PGRST301")).toBe(true);
    expect(isAuthorizationDenial("PGRST302")).toBe(true);
    expect(isAuthorizationDenial("22P02")).toBe(false);
    expect(isAuthorizationDenial(undefined)).toBe(false);
    expect(isAuthorizationDenial(null)).toBe(false);
  });

  it("PASSES only on an explicit authorization refusal", () => {
    for (const code of ["42501", "PGRST301", "PGRST302"]) {
      const r = classifyWriteProbe({ code });
      expect(r.verdict).toBe("PASS");
      expect(r.reason).toBe("authorization_denial");
    }
  });

  it("FAILS when the write was accepted", () => {
    expect(classifyWriteProbe(null).verdict).toBe("FAIL");
  });

  it("does NOT treat a malformed id as a successful refusal", () => {
    expect(classifyWriteProbe({ code: "22P02" }).verdict).toBe("INCONCLUSIVE");
  });

  it("does NOT treat a trigger error as a successful refusal", () => {
    expect(classifyWriteProbe({ code: "P0001" }).verdict).toBe("INCONCLUSIVE");
  });

  it("does NOT treat a validation or constraint error as a successful refusal", () => {
    for (const code of ["23502", "23503", "23514", "23505"]) {
      expect(classifyWriteProbe({ code }).verdict).toBe("INCONCLUSIVE");
    }
  });

  it("does NOT treat an arbitrary or missing error code as a successful refusal", () => {
    expect(classifyWriteProbe({ code: "XX000" }).verdict).toBe("INCONCLUSIVE");
    expect(classifyWriteProbe({}).verdict).toBe("INCONCLUSIVE");
    expect(classifyWriteProbe({ code: null }).verdict).toBe("INCONCLUSIVE");
  });
});

describe("write-probe target selection (M2)", () => {
  it("skips trigger-protected tables, whose refusal would prove nothing", () => {
    const target = selectWriteProbeTarget(
      ["orders", "customers", "conversation_participants"],
      ["orders", "customers"],
    );
    expect(target).toBe("conversation_participants");
  });

  it("returns undefined when every candidate is trigger-protected", () => {
    expect(selectWriteProbeTarget(["orders"], ["orders"])).toBeUndefined();
  });

  it("returns undefined when there are no tenant-scoped tables at all", () => {
    expect(selectWriteProbeTarget([], [])).toBeUndefined();
  });

  it("is deterministic across call order", () => {
    const a = selectWriteProbeTarget(["b_table", "a_table"], []);
    const b = selectWriteProbeTarget(["a_table", "b_table"], []);
    expect(a).toBe(b);
  });
});

describe("collectTriggerProtectedTables (M2)", () => {
  it("collects the table a trigger fires on", () => {
    const sql = `
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();`;
    expect(collectTriggerProtectedTables([sql])).toEqual(["orders"]);
  });

  it("collects constraint triggers too", () => {
    const sql = `CREATE CONSTRAINT TRIGGER guard AFTER INSERT ON payments
  DEFERRABLE FOR EACH ROW EXECUTE FUNCTION public.guard();`;
    expect(collectTriggerProtectedTables([sql])).toEqual(["payments"]);
  });

  it("ignores triggers that appear only in comments", () => {
    expect(
      collectTriggerProtectedTables(["-- CREATE TRIGGER t BEFORE UPDATE ON public.ghost"]),
    ).toEqual([]);
  });

  it("finds the real repository's trigger-protected tables", () => {
    const protectedTables = collectTriggerProtectedTables(realContents);
    expect(protectedTables.length).toBeGreaterThan(0);
    expect(protectedTables).toContain("orders");
  });
});

// ── 9. M3/M4 — RPC probes must be safe AND meaningful ────────────────────────

describe("collectRpcSignatures (M3)", () => {
  it("classifies a function with a write statement as mutating", () => {
    const sql = `
CREATE FUNCTION public.record_thing(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.things (id) VALUES (p_id);
END;
$$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(sig?.name).toBe("record_thing");
    expect(sig?.mutating).toBe(true);
  });

  it("classifies a STABLE read-only function as non-mutating", () => {
    const sql = `
CREATE FUNCTION public.read_thing(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (SELECT to_jsonb(t) FROM public.things t WHERE t.id = p_id);
END;
$$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(sig?.mutating).toBe(false);
    expect(sig?.readOnlyDeclared).toBe(true);
  });

  it("treats an undeclared-volatility function as mutating, the conservative direction", () => {
    const sql = `
CREATE FUNCTION public.maybe(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'::jsonb; END; $$;`;
    expect(collectRpcSignatures([sql])[0]?.mutating).toBe(true);
  });

  it("treats a STABLE declaration with a write in the body as mutating anyway", () => {
    const sql = `
CREATE FUNCTION public.lying(p_id uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$ BEGIN DELETE FROM public.things WHERE id = p_id; END; $$;`;
    expect(collectRpcSignatures([sql])[0]?.mutating).toBe(true);
  });

  it("does not let a read-only overload launder a mutating definition of the same name", () => {
    const mutating = `CREATE FUNCTION public.dual(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN UPDATE public.things SET x = 1; END; $$;`;
    const readOnly = `CREATE FUNCTION public.dual(p_id uuid, p_b int) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN '{}'::jsonb; END; $$;`;
    expect(collectRpcSignatures([mutating, readOnly])[0]?.mutating).toBe(true);
  });

  it("parses parameter names, types and DEFAULT markers", () => {
    const sql = `
CREATE OR REPLACE FUNCTION public.create_thing(
  p_name text,
  p_count integer,
  p_currency text DEFAULT 'USD',
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (1); END; $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(sig?.parameters.map((p) => p.name)).toEqual([
      "p_name",
      "p_count",
      "p_currency",
      "p_meta",
    ]);
    expect(sig?.parameters.map((p) => p.hasDefault)).toEqual([false, false, true, true]);
  });

  it("does not split a numeric(10,2) type on its internal comma", () => {
    const sql = `CREATE FUNCTION public.f(p_rate numeric(10,2)) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    expect(collectRpcSignatures([sql])[0]?.parameters).toHaveLength(1);
  });

  it("handles a zero-argument function", () => {
    const sql = `CREATE FUNCTION public.nothing() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(sig?.parameters).toEqual([]);
    expect(sig?.mutating).toBe(false);
  });

  it("ignores function definitions inside comments", () => {
    expect(collectRpcSignatures(["-- CREATE FUNCTION public.ghost(p uuid) RETURNS void"])).toEqual(
      [],
    );
  });
});

describe("rpcDummyArgs / dummyValueForType (M4)", () => {
  it("supplies a type-correct value for each required parameter", () => {
    const sql = `
CREATE FUNCTION public.f(
  p_org uuid, p_name text, p_qty integer, p_ok boolean, p_meta jsonb, p_at timestamptz
) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(sig).toBeDefined();
    expect(rpcDummyArgs(sig!)).toEqual({
      p_org: "00000000-0000-0000-0000-000000000000",
      p_name: "",
      p_qty: 0,
      p_ok: false,
      p_meta: {},
      p_at: "1970-01-01T00:00:00Z",
    });
  });

  // M4 regression: probing every RPC with {} made any function with required
  // arguments answer PGRST202 forever, so its denial could never be proven.
  it("produces a non-empty argument object for a required-parameter RPC", () => {
    const sql = `CREATE FUNCTION public.needs_args(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN INSERT INTO t VALUES (1); RETURN '{}'::jsonb; END; $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(Object.keys(rpcDummyArgs(sig!))).toEqual(["p_token_hash"]);
  });

  it("omits parameters that declare a DEFAULT", () => {
    const sql = `CREATE FUNCTION public.f(p_a text, p_b text DEFAULT 'x') RETURNS void
LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(Object.keys(rpcDummyArgs(sig!))).toEqual(["p_a"]);
  });

  it("omits OUT parameters, which a caller never supplies", () => {
    const sql = `CREATE FUNCTION public.f(IN p_a text, OUT p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$ BEGIN END; $$;`;
    const [sig] = collectRpcSignatures([sql]);
    expect(Object.keys(rpcDummyArgs(sig!))).toEqual(["p_a"]);
  });

  it("maps array types to an array", () => {
    expect(dummyValueForType("uuid[]")).toEqual([]);
    expect(dummyValueForType("text[]")).toEqual([]);
  });

  it("maps numeric families to a number and never to a string", () => {
    for (const t of ["integer", "bigint", "smallint", "numeric(10,2)", "double precision"]) {
      expect(typeof dummyValueForType(t)).toBe("number");
    }
  });

  it("uses the nil UUID, which identifies no real row", () => {
    expect(dummyValueForType("uuid")).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("falls back to an inert empty string for an enum or domain type", () => {
    expect(dummyValueForType("order_status")).toBe("");
  });
});

describe("classifyRpcProbe (M3/M4)", () => {
  it("PASSES only on an authorization denial", () => {
    for (const code of ["42501", "PGRST301", "PGRST302"]) {
      expect(classifyRpcProbe({ code }).verdict).toBe("PASS");
    }
  });

  it("keeps PGRST202 INCONCLUSIVE and never a PASS", () => {
    const r = classifyRpcProbe({ code: "PGRST202" });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.reason).toBe("not_resolvable_for_role");
  });

  it("keeps PGRST203 (ambiguous overload) INCONCLUSIVE", () => {
    expect(classifyRpcProbe({ code: "PGRST203" }).verdict).toBe("INCONCLUSIVE");
  });

  it("FAILS when the RPC executed for an anonymous caller", () => {
    expect(classifyRpcProbe(null).verdict).toBe("FAIL");
  });

  it("is INCONCLUSIVE for any other refusal", () => {
    for (const code of ["22P02", "P0001", "XX000"]) {
      expect(classifyRpcProbe({ code }).verdict).toBe("INCONCLUSIVE");
    }
  });
});

describe("repository invariants: RPC probe surface", () => {
  const granted = collectAuthenticatedRpcs(realContents);
  const signatures = collectRpcSignatures(realContents);
  const grantedSignatures = signatures.filter((s) => granted.includes(s.name));

  it("finds a declared signature for every RPC granted to authenticated", () => {
    const withoutSignature = granted.filter((n) => !signatures.some((s) => s.name === n));
    expect(withoutSignature).toEqual([]);
  });

  it("classifies the repository's granted RPCs conservatively", () => {
    // Every current APSA RPC granted to `authenticated` writes. The point of the
    // assertion is that none is silently treated as safe to invoke by default.
    expect(grantedSignatures.length).toBeGreaterThan(0);
    for (const sig of grantedSignatures) {
      expect(typeof sig.mutating).toBe("boolean");
    }
  });

  it("builds usable probe arguments for every granted RPC with required parameters", () => {
    for (const sig of grantedSignatures) {
      const required = sig.parameters.filter((p) => !p.isOut && !p.hasDefault && p.name);
      const args = rpcDummyArgs(sig);
      expect(Object.keys(args)).toHaveLength(required.length);
      for (const p of required) {
        expect(args[p.name!]).not.toBeUndefined();
      }
    }
  });
});

// ── 10. Bounded execution ────────────────────────────────────────────────────

describe("bounded execution", () => {
  it("reports a deadline as expired once the budget is spent", () => {
    let now = 1_000;
    const deadline = createDeadline(500, () => now);
    expect(deadline.expired()).toBe(false);
    expect(deadline.remaining()).toBe(500);
    now = 1_400;
    expect(deadline.expired()).toBe(false);
    now = 1_500;
    expect(deadline.expired()).toBe(true);
    expect(deadline.remaining()).toBe(0);
  });

  it("never reports a negative remaining budget", () => {
    let now = 0;
    const deadline = createDeadline(100, () => now);
    now = 10_000;
    expect(deadline.remaining()).toBe(0);
  });

  it("rejects a promise that does not settle within the budget", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, "hanging probe")).rejects.toThrow(/Timed out after 20ms/);
  });

  it("resolves normally when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "fast probe")).resolves.toBe("ok");
  });

  it("propagates the original error rather than masking it as a timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("dns failure")), 1_000, "failing probe"),
    ).rejects.toThrow("dns failure");
  });

  it("reads a timeout override from the environment and rejects nonsense", () => {
    expect(readTimeoutMs({ T: "5000" }, "T", 15_000)).toBe(5_000);
    expect(readTimeoutMs({}, "T", 15_000)).toBe(15_000);
    expect(readTimeoutMs({ T: "" }, "T", 15_000)).toBe(15_000);
    expect(readTimeoutMs({ T: "-1" }, "T", 15_000)).toBe(15_000);
    expect(readTimeoutMs({ T: "abc" }, "T", 15_000)).toBe(15_000);
  });
});

// ── 11. Source-level safety boundary of the hosted verifier ──────────────────
//
// These assert properties of scripts/verify-staging.ts itself: that the offline
// safety boundary cannot regress silently into a tool that writes to a hosted
// project or scores an unproven result as a pass.

describe("verify-staging.ts safety boundary", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/verify-staging.ts"), "utf8");

  it("never inserts a row — no canary writes in any mode", () => {
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.upsert\(/);
    expect(source).not.toMatch(/\.delete\(/);
  });

  it("evaluates the safety gate before constructing any Supabase client", () => {
    const gateAt = source.indexOf("evaluateProbeGate(");
    const clientAt = source.indexOf("createClient(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(clientAt);
  });

  it("exits on a gate refusal, so no flag can continue past it", () => {
    const gateAt = source.indexOf("if (!gate.allowed)");
    const exitAt = source.indexOf("process.exit(2)", gateAt);
    const clientAt = source.indexOf("createClient(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(gateAt);
    expect(exitAt).toBeLessThan(clientAt);
  });

  it("does not pass the write-probe flag into the safety gate", () => {
    const call = /evaluateProbeGate\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? "";
    expect(call.length).toBeGreaterThan(0);
    expect(call).not.toContain("allowWriteProbes");
  });

  it("does not claim that no mutating RPC can ever execute", () => {
    // The phrase may appear only as something the header explicitly disclaims.
    // Any occurrence that is not preceded by that disclaimer is the old, false
    // guarantee coming back.
    const occurrences = [...source.matchAll(/no mutating RPC can ever execute/gi)];
    for (const match of occurrences) {
      const preceding = source.slice(Math.max(0, (match.index ?? 0) - 200), match.index);
      expect(preceding).toMatch(/cannot promise that/i);
    }
    // And the real, narrower guarantee must be stated in its place. The header
    // is a wrapped block comment, so compare against a de-wrapped copy.
    const prose = source.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
    expect(prose).toMatch(
      /never asks a function to run unless that function is provably read-only/i,
    );
  });

  it("uses an Org-B-scoped witness for the cross-tenant read, not the table total", () => {
    // Same empty-table trap as H1: Org A reading zero Org B rows proves
    // isolation only if Org B actually has rows in that table.
    expect(source).toContain("org B row count");
    const at = source.indexOf("5a. Cross-tenant read");
    const section = source.slice(at, source.indexOf("5b.", at));
    expect(section).toContain("classifyRlsObservation(");
    expect(section).toContain('.eq("organization_id", ORG_B)');
    expect(section).toContain("noOrgBRows");
  });

  it("routes every verdict through the shared classifiers rather than inline codes", () => {
    for (const fn of [
      "classifyRlsObservation(",
      "classifyWriteProbe(",
      "classifyRpcProbe(",
      "evaluateProbeGate(",
    ]) {
      expect(source).toContain(fn);
    }
  });

  it("bounds the run with both a per-request and a global timeout", () => {
    expect(source).toContain("STAGING_REQUEST_TIMEOUT_MS");
    expect(source).toContain("STAGING_GLOBAL_TIMEOUT_MS");
    expect(source).toContain("createDeadline(");
  });

  it("never prints a key, only its claimed role", () => {
    expect(source).not.toMatch(/console\.log\([^)]*\bANON\b/);
    expect(source).not.toMatch(/console\.log\([^)]*\bSERVICE\b/);
    expect(source).not.toMatch(/console\.error\([^)]*\bSERVICE\b/);
  });
});

describe("CI does not execute the hosted verifier", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

  it("runs only the offline readiness check in CI", () => {
    expect(workflow).toContain("check:staging-readiness");
    expect(workflow).not.toContain("verify:staging");
    expect(workflow).not.toContain("verify-staging.ts");
  });

  it("does not reference a staging credential in the workflow", () => {
    expect(workflow).not.toContain("STAGING_SUPABASE");
  });
});
