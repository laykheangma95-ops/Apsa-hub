/**
 * Spawns src/tests/financial-rereview-062.runtime.ts in its own process:
 * it replaces createServerFn, the session and the membership lookup with
 * module mocks that must not leak into the rest of the suite, and builds two
 * PGlite databases (every migration; every migration up to 061).
 *
 * Run: bun test src/tests/financial-rereview-062.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("migration 062 re-review: refund intent across a reload, the original payment request, both deployment orders", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/financial-rereview-062.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 310000);
