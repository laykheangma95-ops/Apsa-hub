/**
 * Runs the hydration #418 language regressions (real root route SSR, then
 * hydrateRoot in happy-dom) in an isolated module process: the runtime mocks
 * @tanstack/react-start/server and installs DOM globals, which must not leak
 * into other tests.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("SSR and hydration render the same language; concurrent SSR requests stay isolated", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/i18n-hydration.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 90_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 95_000);
