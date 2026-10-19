/**
 * Spawns src/tests/migration-062-authority.runtime.ts in its own process:
 * it builds PGlite databases from every migration under Supabase-default and
 * adverse privilege configurations, which take long enough to isolate.
 *
 * Run: bun test src/tests/migration-062-authority.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("migration 062 fails closed or removes unsafe financial authority under adverse privilege configurations", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/migration-062-authority.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 310000);
