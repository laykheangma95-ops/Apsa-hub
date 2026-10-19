/**
 * Spawns src/tests/financial-mutation-integrity.runtime.ts in its own process:
 * it replaces createServerFn, the session and the membership lookup with
 * module mocks that must not leak into the rest of the suite, and builds a
 * PGlite database from every migration.
 *
 * Run: bun test src/tests/financial-mutation-integrity.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("financial and fulfillment mutations: initiating principal, replay, refund idempotency and audit atomicity", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/financial-mutation-integrity.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 310000);
