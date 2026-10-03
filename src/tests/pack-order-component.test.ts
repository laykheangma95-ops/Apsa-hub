/**
 * Runs the mounted Pack Order identity-isolation regressions in an isolated
 * module process (same shape as courier-handoff-component.test.ts): the runtime
 * replaces router and server-function modules, which must not leak into other
 * tests, and React Query must see the browser-like globals before it loads.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("Pack Order state resets on order, user and organization switch and drops late responses", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/pack-order-component.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65_000);
