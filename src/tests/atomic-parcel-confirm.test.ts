/**
 * APSA Parcel created atomically with confirmation (CORRECTION-003, migrations
 * 057–058). The behavioural guarantees run against REAL SQL in
 * atomic-parcel-confirm.runtime.ts (isolated process, every migration applied);
 * this file spawns it and adds structural checks that need no database.
 *
 * Run: bun test src/tests/atomic-parcel-confirm.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), "utf-8");
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("atomic parcel on confirm — behavioural (isolated runtime)", () => {
  it("passes the real SQL checks", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/atomic-parcel-confirm.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});

describe("migration 057 / 058 — structure", () => {
  const m057 = () => read("supabase/migrations/057_atomic_parcel_on_confirm.sql");
  const m058 = () => read("supabase/migrations/058_backfill_apsa_parcels.sql");

  it("057 locks the order, then creates the parcel inside the confirm branch", () => {
    const sql = m057();
    const branch = sql.slice(sql.indexOf("IF p_axis = 'lifecycle' AND p_to = 'confirmed' THEN"));
    expect(branch).toMatch(/FOR UPDATE;[\s\S]*transition_order_before_payment_authority_v1/);
    expect(branch).toMatch(/INSERT INTO public\.parcels/);
    expect(branch.indexOf("transition_order_before_payment_authority_v1")).toBeLessThan(
      branch.indexOf("INSERT INTO public.parcels"),
    );
  });

  it("both new/re-declared SECURITY DEFINER functions are service_role only", () => {
    const sql = m057();
    for (const fn of [
      "new_apsa_parcel_code_v1()",
      "transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)",
    ]) {
      expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
    }
  });

  it("058 is a separate, idempotent backfill limited to confirmed/completed orders", () => {
    const sql = m058();
    expect(sql).toMatch(/lifecycle_status IN \('confirmed', 'completed'\)/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(m057()).not.toMatch(/INSERT INTO public\.parcels[\s\S]*FROM public\.orders o/);
  });
});

describe("runtime paths never create a parcel outside confirmation", () => {
  it("Arrange Delivery, Pack Order and the internal label only READ the parcel", () => {
    for (const file of [
      "src/server/deliveries/service.ts",
      "src/server/packing/service.ts",
      "src/server/fulfillment/service.ts",
      "src/server/orders/service.ts",
    ]) {
      const source = code(file);
      expect(source).not.toContain("ensureParcelForOrder");
      expect(source).not.toContain("insertParcel");
    }
  });
});
