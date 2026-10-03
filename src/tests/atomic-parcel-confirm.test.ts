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
    ]) {
      const source = code(file);
      expect(source).not.toContain("recoverOrderParcel");
      expect(source).not.toContain("recover_order_parcel_v1");
      expect(source).not.toMatch(/from\("parcels"\)[\s\S]{0,80}\.insert\(/);
    }
  });

  it("no service-role parcel insert exists: every parcel write is a locked RPC (057 / 059)", () => {
    for (const file of [
      "src/server/orders/repository.ts",
      "src/server/orders/service.ts",
      "src/server/parcels/repository.ts",
      "src/server/parcels/service.ts",
    ]) {
      const source = code(file);
      expect(source).not.toContain("insertParcel");
      expect(source).not.toContain("ensureParcelForOrder");
      expect(source).not.toMatch(/from\("parcels"\)[\s\S]{0,80}\.insert\(/);
    }
    expect(code("src/server/orders/repository.ts")).toContain('rpc("recover_order_parcel_v1"');
  });

  it("orders service recovers the parcel only through the atomic RPC, inside confirmation or recovery", () => {
    const source = code("src/server/orders/service.ts");
    // One private helper is the only caller of the repository RPC, and it
    // surfaces failure rather than swallowing it.
    expect(source.split("repo.recoverOrderParcel(").length - 1).toBe(1);
    const helperAt = source.indexOf("async function recoverParcelAtomically(");
    expect(helperAt).toBeGreaterThan(-1);
    const helper = source.slice(helperAt, source.indexOf("\n}\n", helperAt));
    expect(helper).toContain("repo.recoverOrderParcel(");
    expect(helper).toMatch(/orders\.parcel_generation_failed[\s\S]*throw err;/);
    // Called from: the confirmation retry, the pre-057 path, and the explicit
    // recovery action (which requires the confirmation permission).
    expect(source.split("recoverParcelAtomically(ctx").length - 1).toBe(3);
    const fn = source.slice(source.indexOf("export async function transitionLifecycleStatus"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body).toMatch(
      /if \(to === "confirmed" && from === "confirmed"\) \{\s*const recovered = await recoverParcelAtomically\(/,
    );
    expect(body).toMatch(
      /if \(to === "confirmed" && !result\.parcel_id\) \{\s*const recovered = await recoverParcelAtomically\(/,
    );
    const rec = source.slice(source.indexOf("export async function recoverOrderParcel("));
    expect(rec.slice(0, rec.indexOf("\n}\n"))).toMatch(
      /ctx\.require\("orders\.confirm"\);\s*const result = await recoverParcelAtomically\(/,
    );
  });
});

describe("migration 059 — recovery is one locked decision", () => {
  const m059 = () => code("supabase/migrations/059_recover_order_parcel.sql");

  it("locks the order row, then re-reads lifecycle, then checks/creates the parcel", () => {
    const sql = m059();
    const lock = sql.search(
      /FROM public\.orders\s+WHERE id = p_order_id AND organization_id = p_organization_id\s+FOR UPDATE;/,
    );
    const gate = sql.indexOf("IF v_lifecycle <> 'confirmed' THEN");
    const check = sql.indexOf("FROM public.parcels");
    const insert = sql.indexOf("INSERT INTO public.parcels");
    expect(lock).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(gate);
    expect(insert).toBeGreaterThan(check);
  });

  it("is service_role only and writes no lifecycle, stock or history", () => {
    const sql = m059();
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.recover_order_parcel_v1\(UUID, UUID, UUID\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.recover_order_parcel_v1\(UUID, UUID, UUID\) TO service_role;/,
    );
    const body = sql.slice(sql.indexOf("AS $$"), sql.lastIndexOf("$$;"));
    expect(body).not.toMatch(/UPDATE public\.orders|inventory_movements|order_status_history/);
  });
});
