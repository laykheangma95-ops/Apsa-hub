/**
 * Spawns src/tests/telegram-reply-mounted.runtime.ts in its own process: it
 * registers happy-dom globals and module mocks that must not leak into the
 * rest of the suite.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Telegram reply + connect: mounted lifecycle, scope and copy regressions pass", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/telegram-reply-mounted.runtime.ts")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000 },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);
