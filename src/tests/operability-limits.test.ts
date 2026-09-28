import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Auth, order and payment rate limits hold through the real server functions and services", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/operability-limits.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: "", RATE_LIMIT_KEY_SECRET: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 130000);
