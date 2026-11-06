/**
 * Spawns src/tests/pos-scan-feedback-mounted.runtime.ts in its own process: it
 * registers happy-dom globals and module mocks that must not leak into the
 * rest of the suite.
 *
 * Run: bun test src/tests/pos-scan-feedback-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("POS scan feedback: mounted accepted/refused scan regressions pass", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/pos-scan-feedback-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);
