/**
 * Permission vocabulary migration unit tests.
 *
 * Verifies that migration 010 correctly defines the canonical permission keys
 * per PERMISSIONS_MATRIX.md and that old keys are removed.
 *
 * These are SQL content checks — no live DB connection needed.
 *
 * Run: bun test src/tests/permission-vocabulary.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const migrationSql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/010_permission_vocabulary.sql"),
  "utf-8",
);

// ── U1: Canonical keys are inserted ──────────────────────────────────────────

describe("U1: Canonical permission keys defined in migration 010", () => {
  // messages.* (replaces inbox.*)
  it("inserts messages.read", () => expect(migrationSql).toContain("messages.read"));
  it("inserts messages.reply", () => expect(migrationSql).toContain("messages.reply"));
  it("inserts messages.assign", () => expect(migrationSql).toContain("messages.assign"));

  // delivery.* (replaces deliveries.*)
  it("inserts delivery.read", () => expect(migrationSql).toContain("delivery.read"));
  it("inserts delivery.create", () => expect(migrationSql).toContain("delivery.create"));
  it("inserts delivery.update", () => expect(migrationSql).toContain("delivery.update"));

  // organization.* (replaces org.*)
  it("inserts organization.read", () => expect(migrationSql).toContain("organization.read"));
  it("inserts organization.update", () => expect(migrationSql).toContain("organization.update"));
});

// ── U2: Old keys are removed ──────────────────────────────────────────────────

describe("U2: Old (non-canonical) permission keys are deleted", () => {
  it("deletes inbox.read", () => expect(migrationSql).toMatch(/DELETE.*inbox\.read/s));
  it("deletes inbox.reply", () => expect(migrationSql).toMatch(/DELETE.*inbox\.reply/s));
  it("deletes inbox.assign", () => expect(migrationSql).toMatch(/DELETE.*inbox\.assign/s));
  it("deletes deliveries.read", () => expect(migrationSql).toMatch(/DELETE.*deliveries\.read/s));
  it("deletes deliveries.create", () => expect(migrationSql).toMatch(/DELETE.*deliveries\.create/s));
  it("deletes deliveries.update", () => expect(migrationSql).toMatch(/DELETE.*deliveries\.update/s));
  it("deletes org.read", () => expect(migrationSql).toMatch(/DELETE.*org\.read/s));
  it("deletes org.update", () => expect(migrationSql).toMatch(/DELETE.*org\.update/s));
});

// ── U3: Role_permissions are copied before deletion ───────────────────────────

describe("U3: Migration copies role_permissions before deleting old keys", () => {
  it("uses INSERT INTO role_permissions to copy mappings", () => {
    expect(migrationSql).toMatch(/INSERT INTO public\.role_permissions/);
  });

  it("copies happen before DELETE (DO $$ block precedes DELETE)", () => {
    const doBlockIdx = migrationSql.indexOf("DO $$");
    const deleteIdx = migrationSql.indexOf("DELETE FROM public.permissions");
    expect(doBlockIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(doBlockIdx);
  });
});

// ── U4: ON CONFLICT safety ────────────────────────────────────────────────────

describe("U4: Migration is re-run safe", () => {
  it("INSERT for canonical keys uses ON CONFLICT DO NOTHING", () => {
    expect(migrationSql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
  });

  it("role_permissions INSERT uses ON CONFLICT DO NOTHING", () => {
    expect(migrationSql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

// ── U5: Rename map is complete ────────────────────────────────────────────────

describe("U5: All rename pairs present in DO block", () => {
  it("inbox.read → messages.read pair", () => {
    expect(migrationSql).toMatch(/inbox\.read.*messages\.read/s);
  });

  it("deliveries.read → delivery.read pair", () => {
    expect(migrationSql).toMatch(/deliveries\.read.*delivery\.read/s);
  });

  it("org.read → organization.read pair", () => {
    expect(migrationSql).toMatch(/org\.read.*organization\.read/s);
  });
});
