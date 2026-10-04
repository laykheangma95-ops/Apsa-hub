/**
 * Runs the routed Pack regressions (real TanStack Router, real route modules)
 * in an isolated module process: the runtime replaces server-function modules
 * and installs browser-like globals, which must not leak into other tests.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("/app/pack and /app/pack/ render the queue, /app/pack/$orderId renders Pack Order, through the router", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/pack-routing.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65_000);
