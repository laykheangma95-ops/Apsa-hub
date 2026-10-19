/**
 * Spawns src/tests/order-entry-principal-mounted.runtime.ts in its own process:
 * it registers happy-dom globals and module mocks that must not leak into the
 * rest of the suite, and builds a PGlite database from every migration.
 *
 * Run: bun test src/tests/order-entry-principal-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Orders → New Order and Inbox → Prepare Order run as the principal that started them — or not at all", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/order-entry-principal-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);
