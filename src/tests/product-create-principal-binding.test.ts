/**
 * Spawns src/tests/product-create-principal-binding.runtime.ts in its own
 * process: it replaces modules process-globally.
 *
 * Run: bun test src/tests/product-create-principal-binding.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("product create is bound to the initiating principal (server)", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/product-create-principal-binding.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 130000);
