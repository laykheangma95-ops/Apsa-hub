/**
 * Spawns src/tests/orders-new-order-money-mounted.runtime.ts in its own
 * process: it registers happy-dom globals and module mocks that must not leak
 * into the rest of the suite, and builds a PGlite database from every
 * migration.
 *
 * Run: bun test src/tests/orders-new-order-money-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Orders → New Order money: mounted sheet agrees with the request and the persisted order", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/orders-new-order-money-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);
