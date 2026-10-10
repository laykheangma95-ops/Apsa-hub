/**
 * Spawns src/tests/order-mutation-principal-mounted.runtime.ts in its own
 * process: it registers happy-dom globals and module mocks that must not leak
 * into the rest of the suite, and builds a PGlite database from every
 * migration.
 *
 * Run: bun test src/tests/order-mutation-principal-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Order lifecycle and payment recording run as the principal that started them — or not at all", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/order-mutation-principal-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 300000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 310000);
