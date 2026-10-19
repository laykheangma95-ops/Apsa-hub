/**
 * Spawns src/tests/session-principal-boundary.runtime.ts in its own process:
 * it replaces the server-function transport, the session provider and
 * PostgREST process-wide (mock.module) and builds a PGlite database from
 * every migration.
 *
 * Run: bun test src/tests/session-principal-boundary.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("protected mutations derive and compare the principal through the real session → membership → authorization chain", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/session-principal-boundary.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);
