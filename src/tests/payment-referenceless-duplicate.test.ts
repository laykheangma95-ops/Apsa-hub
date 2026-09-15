import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Migration 043 flags reference-less duplicate payments without rejecting or auto-verifying them", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/payment-referenceless-duplicate.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65000);
