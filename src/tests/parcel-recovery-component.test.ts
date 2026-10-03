/**
 * Order detail "Create APSA Parcel" recovery.
 *
 * Runs the mounted ParcelRecoveryBoundary regressions in an isolated module
 * process (same shape as retry-delivery-ready-component.test.ts): the runtime
 * replaces network modules, which must not leak into other tests, and React
 * Query must see the browser-like globals before it loads.
 *
 * The wiring checks below pin how Order detail uses it: the condition comes
 * from the server's order read (so it survives a refresh), the action replaces
 * the fulfillment actions that need a parcel, it is offered on the same
 * authority as confirmation, and a failed confirmation re-reads the order.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("Create APSA Parcel: authorized action, cache handoff, identity isolation and late responses", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/parcel-recovery-component.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65_000);

describe("Order detail wiring for a confirmed order missing its APSA Parcel", () => {
  const page = readFileSync(path.join(root, "src/routes/app.orders.$id.tsx"), "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("reads the condition from the server's order detail, never from the failed mutation", () => {
    expect(page).toMatch(
      /const parcelMissing = query\.data!\.parcelMissing && order\.lifecycleStatus === "confirmed";/,
    );
  });

  it("offers the recovery in place of the parcel-dependent actions, on the confirmation authority", () => {
    expect(page).toMatch(/const actions = parcelMissing\s*\?\s*\[\]\s*:\s*fulfillmentActions\(/);
    expect(page).toMatch(
      /\{parcelMissing && identityOk \? \([\s\S]*?<ParcelRecoveryBoundary[\s\S]*?userId=\{userId\}[\s\S]*?organizationId=\{routeOrganizationId\}[\s\S]*?orderId=\{id\}[\s\S]*?canRecover=\{capabilities\.can\("orders\.confirm"\)\}/,
    );
    // No pack-state read for an order that has no parcel to pack.
    expect(page).toMatch(/enabled:\s*query\.isSuccess &&\s*!query\.data\.parcelMissing &&/);
  });

  it("never pretends the order is a draft: Confirm stays draft-only", () => {
    const orders = readFileSync(path.join(root, "src/lib/orders.ts"), "utf8");
    expect(orders).toMatch(
      /export function canConfirmOrder\([^)]*\): boolean \{\s*return lifecycleStatus === "draft";/,
    );
  });

  it("a failed confirmation re-reads the order so the recovery appears without a manual refresh", () => {
    const confirm = page.slice(page.indexOf("const confirmMutation = useMutation("));
    const block = confirm.slice(0, confirm.indexOf("const cancelMutation"));
    expect(block).toMatch(/onError: \(\) => \{[\s\S]*?void query\.refetch\(\);/);
  });
});
