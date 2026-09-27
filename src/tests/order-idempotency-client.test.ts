import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("createRealOrder reuses one key per logical order attempt and parses delivery fees without floats", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/order-idempotency-client.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 70000);

// The key holder is a required input of createRealOrder (typechecked), so this
// only pins that each real entry point keeps ONE holder for its lifetime rather
// than minting one per call — which would silently defeat retry replay.
it("every real order-creation entry point keeps one idempotency holder per flow", () => {
  for (const file of [
    "src/components/pos/PosCheckoutSheet.tsx",
    "src/components/orders/CreateRealOrderSheet.tsx",
    "src/components/inbox/PrepareOrderSheet.tsx",
  ]) {
    const source = readFileSync(resolve(file), "utf8");
    expect(source).toMatch(/const idempotencyKeys = useRef\(createIdempotencyKeyHolder\(\)\)/);
    expect(source).toMatch(/idempotency: idempotencyKeys\.current,/);
    expect(source).not.toMatch(/idempotency: createIdempotencyKeyHolder\(\)/);
  }
});
