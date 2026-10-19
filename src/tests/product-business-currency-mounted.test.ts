/**
 * Spawns src/tests/product-business-currency-mounted.runtime.ts in its own
 * process: it registers happy-dom globals and module mocks that must not leak
 * into the rest of the suite.
 *
 * Run: bun test src/tests/product-business-currency-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Add Product prices only in the confirmed business currency (mounted)", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/product-business-currency-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 130000);
