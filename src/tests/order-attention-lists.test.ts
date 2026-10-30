/**
 * Spawns src/tests/order-attention-lists.runtime.ts in its own process: it
 * installs module mocks that must not leak into the rest of the suite, and
 * builds a PGlite database from every migration.
 *
 * Run: bun test src/tests/order-attention-lists.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Orders attention views: real SQL, permissions, tenancy and counts agree with lists", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/order-attention-lists.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 420000 },
  );
  if (result.status !== 0) {
    const lines = `${result.stdout}\n${result.stderr}`.split("\n");
    lines.forEach((line, index) => {
      if (line.includes("(fail)")) {
        console.error(lines.slice(Math.max(0, index - 60), index + 1).join("\n"));
      }
    });
    console.error(lines.slice(-30).join("\n"));
  }
  expect(result.status).toBe(0);
}, 430000);
