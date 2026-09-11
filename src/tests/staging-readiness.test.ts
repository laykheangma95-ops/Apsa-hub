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
