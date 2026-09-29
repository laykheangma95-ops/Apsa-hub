/**
 * Order shipping-destination snapshot — PR #80 final shipping-authority repair.
 *
 * The behavioural guarantees (real PGlite SQL + the production order service)
 * run isolated in order-shipping-snapshot.runtime.ts, because that file mocks
 * @/lib/supabase/server process-globally. This file spawns it, then adds
 * structural assertions over the migration and the wiring that need no DB.
 *
 * Run: bun test src/tests/order-shipping-snapshot.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import en from "../locales/en.json";
import km from "../locales/km.json";

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), "utf-8");

describe("shipping snapshot — behavioural (isolated runtime)", () => {
  it("passes the real SQL + service checks", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/order-shipping-snapshot.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});

describe("migration 047 — additive shipping snapshot + v3 + update RPC", () => {
  const migration = () => read("supabase/migrations/047_order_shipping_snapshot.sql");

  it("only ADDs columns to orders (never drops/rewrites an existing one)", () => {
    const sql = migration();
    expect(sql).toMatch(/ADD COLUMN shipping_name/);
    expect(sql).toMatch(/ADD COLUMN shipping_phone/);
    expect(sql).toMatch(/ADD COLUMN shipping_address/);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    // Historical migrations are never edited; this is a fresh file (> 046).
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "supabase/migrations/046_fulfillment_permissions.sql"),
      ),
    ).toBe(true);
  });

  it("create_order_v3 folds the shipping fields into the request fingerprint", () => {
    const sql = migration();
    // The fingerprint object must carry all three shipping fields, so a
    // different address changes the fingerprint (→ idempotency conflict).
    const fingerprintBlock = sql.slice(sql.indexOf("v_request := jsonb_build_object"));
    expect(fingerprintBlock).toMatch(/'shipping_name',\s+v_ship_name/);
    expect(fingerprintBlock).toMatch(/'shipping_phone',\s+v_ship_phone/);
    expect(fingerprintBlock).toMatch(/'shipping_address',\s+v_ship_address/);
  });

  it("both new SECURITY DEFINER functions are revoked from PUBLIC/JWT roles and granted only to service_role", () => {
    const sql = migration();
    for (const fn of ["create_order_v3", "update_order_shipping_v1"]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?FROM PUBLIC, anon, authenticated`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO service_role`),
      );
    }
  });

  it("update_order_shipping_v1 refuses a terminal lifecycle or fulfillment (destination is not casually rewritten)", () => {
    const sql = migration();
    const fn = sql.slice(sql.indexOf("CREATE FUNCTION public.update_order_shipping_v1"));
    expect(fn).toMatch(/lifecycle_status IN \('completed', 'cancelled'\)/);
    expect(fn).toMatch(/fulfillment_status IN \('fulfilled', 'cancelled'\)/);
    // Returns presence booleans, never raw values, for a PII-safe audit.
    expect(fn).toMatch(/'had_address'/);
    expect(fn).toMatch(/'has_address'/);
  });
});

describe("wiring — the app writes via v3 and the label reads the snapshot", () => {
  it("the order repository calls create_order_v3 with the shipping params", () => {
    const repo = read("src/server/orders/repository.ts");
    expect(repo).toMatch(/db\.rpc\("create_order_v3"/);
    expect(repo).toMatch(/p_shipping_address:/);
    expect(repo).toMatch(/db\.rpc\("update_order_shipping_v1"/);
  });

  it("getParcelLabelData takes the destination from the order snapshot, not the customer default", () => {
    const service = read("src/server/fulfillment/service.ts");
    // The mutable default read is gone; the snapshot address is the source.
    expect(service).not.toMatch(/customerDefaultAddress\(/);
    expect(service).toMatch(/order\.shipping_address/);
    expect(service).toMatch(/addressConfirmed/);
  });
});

describe("i18n parity for the new shipping keys", () => {
  const enShip = (en as { shipping?: Record<string, string> }).shipping ?? {};
  const kmShip = (km as { shipping?: Record<string, string> }).shipping ?? {};

  it("the shipping.* block exists in both locales with the same keys", () => {
    const keys = ["title", "name", "phone", "address", "confirmTitle", "save", "note"];
    for (const k of keys) {
      expect(enShip[k], `en shipping.${k}`).toBeString();
      expect(kmShip[k], `km shipping.${k}`).toBeString();
    }
    expect(Object.keys(enShip).sort()).toEqual(Object.keys(kmShip).sort());
  });

  it("the parcel-label confirm keys exist in both locales", () => {
    const enParcel = (en as { labels: { parcel: Record<string, string> } }).labels.parcel;
    const kmParcel = (km as { labels: { parcel: Record<string, string> } }).labels.parcel;
    for (const k of ["confirmCta", "needsConfirmTitle", "needsConfirmBody", "needsConfirmOne"]) {
      expect(enParcel[k], `en labels.parcel.${k}`).toBeString();
      expect(kmParcel[k], `km labels.parcel.${k}`).toBeString();
    }
  });
});
