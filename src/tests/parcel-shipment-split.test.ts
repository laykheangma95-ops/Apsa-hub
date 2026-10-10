/**
 * CORRECTION-003 — APSA Parcel (internal identity) vs Carrier Shipment.
 *
 *   Confirm order → APSA Parcel generated → internal label → Pack Order →
 *   Mark Packed → Arrange Delivery (shipment attaches to the parcel) →
 *   shipping label → Courier Handoff by APSA Parcel ID.
 *   Cancel shipment A → shipment B attaches to the SAME parcel.
 *
 * Every service below runs for real against ONE in-memory world shared by the
 * order, parcel, packing, delivery, fulfillment and handoff repositories.
 *
 * Run: bun test src/tests/parcel-shipment-split.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "@/lib/i18n";
import km from "@/locales/km.json";
import type { AuthorizationContext } from "../server/auth/authorization";
import { isValidParcelCode } from "../lib/barcode/parcel-code";
import { buildParcelLabel, type ParcelLabelInput } from "../lib/labels/parcel-label";
import { buildInternalParcelLabel } from "../lib/labels/internal-parcel-label";
import { InternalParcelLabel } from "../components/labels/InternalParcelLabel";
import { ParcelLabel } from "../components/labels/ParcelLabel";
import { fulfillmentActions } from "../lib/pack";
import {
  createPrintGuard,
  printIdentity,
  shippingLabelIssues,
  verifyFreshLabels,
} from "../lib/labels/shipping-print-guard";
import { returnLookupFor } from "../lib/returns";
import { principalOf } from "./helpers/refuse-only-principal";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER_A = "aaaaaaaa-1111-4000-8000-000000000001";
const ORDER_A = "aaaaaaaa-2222-4000-8000-000000000001";
const LOCATION_A = "aaaaaaaa-4444-4000-8000-000000000001";
const VARIANT_A = "aaaaaaaa-5555-4000-8000-000000000001";
const PRODUCT_A = "aaaaaaaa-7777-4000-8000-000000000001";
const T = km.labels;

type Row = Record<string, unknown>;

// ── In-memory world ───────────────────────────────────────────────────────────

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 3, 0, 0, clock++)).toISOString();

interface World {
  tables: Record<string, Row[]>;
  rpcCalls: string[];
  packed: boolean;
  /** Make the parcel write inside confirmation fail (rollback path). */
  failParcelOnConfirm?: boolean;
  /**
   * A database that has not applied migration 057: confirmation succeeds but
   * creates no parcel and returns no parcel_id (the hosted state that broke
   * the parcel label right after confirmation).
   */
  pre057?: boolean;
  /**
   * Make the next N parcel writes of recover_order_parcel_v1 fail (the parcel
   * write after a pre-057 confirmation, or a recovery attempt).
   */
  failParcelInserts?: number;
}

function seed(lifecycle: "draft" | "confirmed" = "draft"): World {
  return {
    rpcCalls: [],
    packed: false,
    tables: {
      orders: [
        {
          id: ORDER_A,
          organization_id: ORG_A,
          order_number: "APSA-2026-000777",
          customer_id: null,
          location_id: LOCATION_A,
          source: "FACEBOOK",
          currency: "USD",
          subtotal_minor: 2500,
          discount_minor: 0,
          delivery_minor: 0,
          total_minor: 2500,
          lifecycle_status: lifecycle,
          payment_status: "unpaid",
          refund_status: "none",
          fulfillment_status: "unfulfilled",
          shipping_name: "Sokha",
          shipping_phone: "012 345 678",
          shipping_address: "12 St 240, Phnom Penh",
          created_by: USER_A,
          created_at: tick(),
          updated_at: tick(),
        },
      ],
      order_items: [
        {
          id: "item-1",
          organization_id: ORG_A,
          order_id: ORDER_A,
          variant_id: VARIANT_A,
          product_id: PRODUCT_A,
          quantity: 2,
          product_name_snapshot: "Iced Coffee",
          variant_name_snapshot: null,
          created_at: tick(),
        },
      ],
      organizations: [{ id: ORG_A, display_name: "Dara Coffee" }],
      locations: [
        { id: LOCATION_A, organization_id: ORG_A, phone: "023 999 888", status: "active" },
      ],
      order_payment_totals: [
        {
          organization_id: ORG_A,
          order_id: ORDER_A,
          total_minor: 2500,
          received_minor: 0,
          refunded_minor: 0,
          net_minor: 0,
          currency: "USD",
          payment_status: "unpaid",
          refund_status: "none",
        },
      ],
      payments: [],
      product_variants: [
        {
          id: VARIANT_A,
          organization_id: ORG_A,
          product_id: PRODUCT_A,
          barcode: "8850000000017",
          status: "ACTIVE",
          created_at: tick(),
        },
      ],
      deliveries: [],
      delivery_status_history: [],
      parcels: [],
    },
  };
}

function makeDb(world: World) {
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const orderings: Array<{ col: string; asc: boolean }> = [];
    let max: number | undefined;
    let mode: "many" | "single" | "maybe" = "many";
    let insertRow: Row | null = null;

    const run = () => {
      if (insertRow !== null) {
        const row = insertRow;
        if (table === "parcels") {
          const clash = world.tables["parcels"]!.some(
            (p) =>
              p["organization_id"] === row["organization_id"] &&
              p["order_id"] === row["order_id"] &&
              p["status"] !== "void",
          );
          if (clash) {
            return {
              data: null,
              error: { message: 'duplicate key value violates "uniq_parcels_org_order_active"' },
            };
          }
        }
        const stored = { id: crypto.randomUUID(), created_at: tick(), updated_at: tick(), ...row };
        (world.tables[table] ??= []).push(stored);
        return { data: { ...stored }, error: null };
      }
      let rows = (world.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const { col, asc } of [...orderings].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[col] ?? "");
          const y = String(b[col] ?? "");
          return asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (max !== undefined) rows = rows.slice(0, max);
      rows = rows.map((r) => ({ ...r }));
      if (mode === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      }
      if (mode === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    const q = {
      select: () => q,
      insert: (row: Row) => {
        insertRow = row;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return q;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderings.push({ col, asc: opts?.ascending !== false });
        return q;
      },
      limit: (n: number) => {
        max = n;
        return q;
      },
      range: () => q,
      single: () => {
        mode = "single";
        return q;
      },
      maybeSingle: () => {
        mode = "maybe";
        return q;
      },
      then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(ok, fail),
    };
    return q;
  }

  const order = () => world.tables["orders"]!.find((o) => o["id"] === ORDER_A)!;

  /** The order's active parcel, created once if missing (057 / 059 semantics). */
  function activeOrNewParcel(o: Row, actor: unknown): { parcel: Row; created: boolean } {
    const existing = world.tables["parcels"]!.find(
      (p) => p["order_id"] === o["id"] && p["status"] !== "void",
    );
    if (existing) return { parcel: existing, created: false };
    const parcel = {
      id: crypto.randomUUID(),
      organization_id: o["organization_id"],
      order_id: o["id"],
      parcel_code: `APSA:PCL:v1:${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`,
      status: "created",
      created_by: actor,
      created_at: tick(),
      updated_at: tick(),
    };
    world.tables["parcels"]!.push(parcel);
    return { parcel, created: true };
  }

  return {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      world.rpcCalls.push(name);
      if (name === "transition_order_status_v1") {
        const o = order();
        const col = `${String(args["p_axis"])}_status`;
        if (o[col] !== args["p_expected_from"]) {
          return { data: { status: "stale", current: o[col] }, error: null };
        }
        /*
         * Mirrors migration 057: lifecycle → confirmed creates (or reuses) the
         * order's active parcel in the SAME transaction; a parcel failure
         * raises and nothing — not even the status change — is committed. The
         * real SQL behaviour is proven in atomic-parcel-confirm.runtime.ts.
         */
        if (args["p_axis"] === "lifecycle" && args["p_to"] === "confirmed" && world.pre057) {
          o[col] = args["p_to"];
          return { data: { status: "success", stock_movements: 0 }, error: null };
        }
        if (args["p_axis"] === "lifecycle" && args["p_to"] === "confirmed") {
          if (world.failParcelOnConfirm) {
            return { data: null, error: { message: "parcel write failed (test)" } };
          }
          o[col] = args["p_to"];
          const { parcel } = activeOrNewParcel(o, args["p_changed_by"]);
          return {
            data: {
              status: "success",
              stock_movements: 0,
              parcel_id: parcel["id"],
              parcel_code: parcel["parcel_code"],
            },
            error: null,
          };
        }
        o[col] = args["p_to"];
        return { data: { status: "success", stock_movements: 0 }, error: null };
      }
      /*
       * Mirrors migration 059: under the order lock, re-read lifecycle; refuse
       * (write nothing) unless confirmed; return the active parcel if any;
       * otherwise create exactly one. A parcel-write failure raises. The real
       * locking is proven against PostgreSQL in parcel-recovery-pg.runtime.ts.
       */
      if (name === "recover_order_parcel_v1") {
        const o = world.tables["orders"]!.find(
          (r) =>
            r["id"] === args["p_order_id"] && r["organization_id"] === args["p_organization_id"],
        );
        if (!o) return { data: { status: "not_found" }, error: null };
        if (o["lifecycle_status"] !== "confirmed") {
          return { data: { status: "not_confirmed", current: o["lifecycle_status"] }, error: null };
        }
        const hasParcel = world.tables["parcels"]!.some(
          (p) => p["order_id"] === o["id"] && p["status"] !== "void",
        );
        if (!hasParcel && (world.failParcelInserts ?? 0) > 0) {
          world.failParcelInserts! -= 1;
          return { data: null, error: { message: "parcel insert failed (test)" } };
        }
        const { parcel, created } = activeOrNewParcel(o, args["p_actor"]);
        return {
          data: {
            status: created ? "created" : "exists",
            parcel_id: parcel["id"],
            parcel_code: parcel["parcel_code"],
          },
          error: null,
        };
      }
      if (name === "create_delivery_v1") {
        const id = crypto.randomUUID();
        const at = tick();
        world.tables["deliveries"]!.push({
          id,
          organization_id: args["p_organization_id"],
          order_id: args["p_order_id"],
          location_id: args["p_location_id"],
          provider_id: args["p_provider_id"],
          provider_key: args["p_provider_key"],
          provider_name: args["p_provider_name"],
          external_tracking_number: args["p_external_tracking_number"],
          cod_amount_minor: args["p_cod_amount_minor"],
          cod_currency: args["p_cod_amount_minor"] === null ? null : "USD",
          status: "pending",
          created_by: args["p_created_by"],
          created_at: at,
          updated_at: at,
        });
        order()["fulfillment_status"] = "processing";
        return {
          data: { status: "success", delivery_id: id, order_fulfillment: "processing" },
          error: null,
        };
      }
      if (name === "transition_delivery_status_v1") {
        const d = world.tables["deliveries"]!.find((r) => r["id"] === args["p_delivery_id"])!;
        const from = d["status"];
        d["status"] = args["p_to_status"];
        if (d["status"] === "cancelled") order()["fulfillment_status"] = "unfulfilled";
        return { data: { status: "success", from, to: d["status"] }, error: null };
      }
      if (name === "order_currently_packed_v1") return { data: world.packed, error: null };
      if (name === "ready_packed_delivery_v1") {
        const d = world.tables["deliveries"]!.find(
          (r) => r["order_id"] === args["p_order_id"] && r["status"] === "pending",
        );
        if (d) d["status"] = "ready";
        return { data: { status: "success" }, error: null };
      }
      return { data: { status: "success" }, error: null };
    },
  };
}

let world: World;
const restores: Array<() => void> = [];

async function install(w: World) {
  world = w;
  const db = makeDb(world);
  const repos = await Promise.all([
    import("../server/deliveries/repository"),
    import("../server/parcels/repository"),
    import("../server/orders/repository"),
    import("../server/fulfillment/repository"),
    import("../server/products/repository"),
    import("../server/returns/repository"),
  ]);
  restores.push(
    repos[0].setDeliveryRepositoryDbForTests(db),
    repos[1].setParcelRepositoryDbForTests(db),
    repos[2].setOrderRepositoryDbForTests(db),
    repos[3].setFulfillmentRepositoryDbForTests(db),
    repos[4].setProductRepositoryDbForTests(db),
    repos[5].setReturnsRepositoryDbForTests(db),
  );
}

beforeEach(async () => {
  // Rendered strings are asserted against the Khmer (default) locale.
  await i18n.changeLanguage("km");
  await install(seed("draft"));
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function ctx(permissions: string[], organizationId = ORG_A): AuthorizationContext {
  const set = new Set(permissions);
  return {
    userId: USER_A,
    organizationId,
    can: (k: string) => set.has(k),
    require: (k: string) => {
      if (!set.has(k)) throw Object.assign(new Error(`Missing permission: ${k}`), { status: 403 });
    },
  } as unknown as AuthorizationContext;
}

const STAFF = [
  "orders.read",
  "orders.confirm",
  "fulfillment.print_label",
  "fulfillment.scan_parcel",
  "delivery.read",
  "delivery.create",
  "delivery.update",
  "delivery.handoff",
];
const parcels = () => world.tables["parcels"]!;
const activeParcels = () => parcels().filter((p) => p["status"] !== "void");

async function confirm() {
  const { transitionLifecycleStatus } = await import("../server/orders/service");
  return transitionLifecycleStatus(ctx(STAFF), ORDER_A, "confirmed", null, principalOf(ctx(STAFF)));
}

async function arrange(provider = "VET Express", tracking = "VET-42") {
  const { createDelivery } = await import("../server/deliveries/service");
  return createDelivery(ctx(STAFF), {
    orderId: ORDER_A,
    providerName: provider,
    externalTrackingNumber: tracking,
  });
}

async function internalLabel() {
  const { getInternalParcelLabelData } = await import("../server/fulfillment/service");
  return getInternalParcelLabelData(ctx(STAFF), ORDER_A);
}

async function shippingLabel(): Promise<ParcelLabelInput> {
  const { getParcelLabelData } = await import("../server/fulfillment/service");
  return (await getParcelLabelData(ctx(STAFF), ORDER_A)) as unknown as ParcelLabelInput;
}

// ── 1. APSA Parcel at confirmation ────────────────────────────────────────────

describe("APSA Parcel is generated when the order enters fulfillment", () => {
  it("confirming the order generates ONE APSA Parcel — no delivery involved", async () => {
    expect(parcels()).toHaveLength(0);
    await confirm();
    expect(activeParcels()).toHaveLength(1);
    expect(isValidParcelCode(String(activeParcels()[0]!["parcel_code"]))).toBe(true);
    expect(world.tables["deliveries"]).toHaveLength(0);
  });

  it("a draft order has no parcel and no internal label", async () => {
    await expect(internalLabel()).rejects.toThrow(/confirmed order/);
    expect(parcels()).toHaveLength(0);
  });

  it("parcel generation failure fails the confirmation — the order stays draft, no parcel", async () => {
    world.failParcelOnConfirm = true;
    await expect(confirm()).rejects.toThrow();
    expect(world.tables["orders"]![0]!["lifecycle_status"]).toBe("draft");
    expect(parcels()).toHaveLength(0);
  });

  it("no duplicate parcels: an existing active parcel is reused by confirmation", async () => {
    world.tables["parcels"]!.push({
      id: "pre-existing",
      organization_id: ORG_A,
      order_id: ORDER_A,
      parcel_code: "APSA:PCL:v1:PreexistingParcel_00001",
      status: "created",
      created_at: tick(),
      updated_at: tick(),
    });
    await confirm();
    expect(activeParcels()).toHaveLength(1);
    expect(activeParcels()[0]!["id"]).toBe("pre-existing");
  });

  it("a confirmed order WITHOUT a parcel (not yet backfilled) is refused — never repaired at runtime", async () => {
    restores.splice(0).forEach((r) => r());
    await install(seed("confirmed"));
    await expect(internalLabel()).rejects.toThrow(/no APSA parcel/);
    const { getPackRequirements } = await import("../server/packing/service");
    await expect(getPackRequirements(ctx(STAFF), ORDER_A)).rejects.toThrow(/no APSA parcel/);
    await expect(arrange()).rejects.toThrow(/no APSA parcel/);
    expect(parcels()).toHaveLength(0);
    expect(world.tables["deliveries"]).toHaveLength(0);
  });
});

// ── 1b. Regression: fresh confirmation on a database without migration 057 ────

describe("a freshly confirmed order owns its APSA Parcel even before migration 057", () => {
  it("confirmation creates exactly one parcel and the label prints immediately", async () => {
    world.pre057 = true;
    await confirm();
    expect(activeParcels()).toHaveLength(1);
    // No refresh, no second navigation: the very next label read succeeds.
    const data = await internalLabel();
    expect(data.parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
    expect(isValidParcelCode(data.parcelCode)).toBe(true);
    // The label read itself never created anything.
    expect(activeParcels()).toHaveLength(1);
  });

  const transitions = () => world.rpcCalls.filter((n) => n === "transition_order_status_v1");
  const recoveries = () => world.rpcCalls.filter((n) => n === "recover_order_parcel_v1");

  it("a failed parcel write is recovered by retrying confirmation — exactly one parcel", async () => {
    world.pre057 = true;
    world.failParcelInserts = 1;
    // Injected parcel creation failure: confirmation throws.
    await expect(confirm()).rejects.toThrow(/parcel insert failed/);
    // The order committed as confirmed but has no parcel yet — still recoverable.
    expect(lifecycle()).toBe("confirmed");
    expect(activeParcels()).toHaveLength(0);
    const transitionsBefore = transitions().length;
    // Retry the confirmation as-is: no manual lifecycle reset.
    await confirm();
    expect(lifecycle()).toBe("confirmed");
    // The retry did not re-run the transition (no second stock consumption);
    // it went through the atomic recovery RPC.
    expect(transitions()).toHaveLength(transitionsBefore);
    expect(recoveries().length).toBeGreaterThanOrEqual(2);
    expect(activeParcels()).toHaveLength(1);
    expect(isValidParcelCode(String(activeParcels()[0]!["parcel_code"]))).toBe(true);
    expect((await internalLabel()).parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
  });

  it("confirming again never duplicates the parcel — a parcelled confirmed order is refused", async () => {
    world.pre057 = true;
    await confirm();
    const first = String(activeParcels()[0]!["parcel_code"]);
    await expect(confirm()).rejects.toThrow(/Cannot move order lifecycle/);
    await expect(confirm()).rejects.toThrow(/Cannot move order lifecycle/);
    expect(activeParcels()).toHaveLength(1);
    expect(String(activeParcels()[0]!["parcel_code"])).toBe(first);
  });

  it("printing and Arrange Delivery never create the missing parcel — only recovery does", async () => {
    world.pre057 = true;
    world.failParcelInserts = 1;
    await expect(confirm()).rejects.toThrow();
    await expect(internalLabel()).rejects.toThrow(/no APSA parcel/);
    await shippingLabel().catch(() => undefined);
    await expect(arrange()).rejects.toThrow(/no APSA parcel/);
    expect(parcels()).toHaveLength(0);
    await confirm();
    expect(activeParcels()).toHaveLength(1);
  });

  it("a migrated database is not double-written: the RPC's parcel is the parcel", async () => {
    // Any recovery write would fail: only the confirming RPC may create it here.
    world.failParcelInserts = 99;
    await confirm();
    expect(recoveries()).toHaveLength(0);
    expect(activeParcels()).toHaveLength(1);
    expect((await internalLabel()).parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
  });
});

// ── 1c. Recovery survives a refresh: Order detail offers "Create APSA Parcel" ──

const lifecycle = () => world.tables["orders"]![0]!["lifecycle_status"];

async function readDetail(perms = STAFF, organizationId = ORG_A) {
  const { getOrderById } = await import("../server/orders/service");
  return getOrderById(ctx(perms, organizationId), ORDER_A);
}

async function recover(perms = STAFF, organizationId = ORG_A) {
  const { recoverOrderParcel } = await import("../server/orders/service");
  return recoverOrderParcel(
    ctx(perms, organizationId),
    ORDER_A,
    principalOf(ctx(perms, organizationId)),
  );
}

describe("a confirmed order stranded without its parcel is recoverable after a refresh", () => {
  const transitions = () => world.rpcCalls.filter((n) => n === "transition_order_status_v1");
  const recoveries = () => world.rpcCalls.filter((n) => n === "recover_order_parcel_v1");

  async function strand() {
    world.pre057 = true;
    world.failParcelInserts = 1;
    await expect(confirm()).rejects.toThrow(/parcel insert failed/);
    expect(lifecycle()).toBe("confirmed");
    expect(activeParcels()).toHaveLength(0);
  }

  it("refresh → recovery offered → recover → label, Pack Order and Arrange Delivery work", async () => {
    await strand();
    // "Refresh": a brand-new read of the persisted order, not the failed
    // confirmation's in-memory state. It is confirmed — never a pretend draft.
    const reopened = await readDetail();
    expect(reopened.lifecycleStatus).toBe("confirmed");
    expect(reopened.parcelMissing).toBe(true);
    const { mapOrderDetailToUi } = await import("../lib/orders");
    expect(mapOrderDetailToUi(reopened).parcelMissing).toBe(true);

    const transitionsBefore = transitions().length;
    const recovered = await recover();
    expect(recovered.lifecycleStatus).toBe("confirmed");
    expect(recovered.parcelMissing).toBe(false);
    expect(transitions()).toHaveLength(transitionsBefore); // no lifecycle reset / re-run
    expect(activeParcels()).toHaveLength(1);

    // The recovery action disappears on the next read.
    expect((await readDetail()).parcelMissing).toBe(false);
    // Parcel label available.
    const label = await internalLabel();
    expect(label.parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
    // Pack Order available.
    const { getPackRequirements } = await import("../server/packing/service");
    await expect(getPackRequirements(ctx(STAFF), ORDER_A)).resolves.toBeTruthy();
    // Arrange Delivery continues, attached to the same parcel.
    await arrange();
    expect(world.tables["deliveries"]).toHaveLength(1);
    expect(activeParcels()).toHaveLength(1);
  });

  it("repeated recovery failures write nothing; the next success creates exactly one parcel", async () => {
    await strand();
    world.failParcelInserts = 2;
    await expect(recover()).rejects.toThrow(/parcel insert failed/);
    await expect(recover()).rejects.toThrow(/parcel insert failed/);
    expect(lifecycle()).toBe("confirmed");
    expect(activeParcels()).toHaveLength(0);
    await recover();
    await recover();
    expect(activeParcels()).toHaveLength(1);
  });

  it("an order that already owns its parcel never gets another", async () => {
    await confirm();
    const first = String(activeParcels()[0]!["parcel_code"]);
    expect((await readDetail()).parcelMissing).toBe(false);
    const again = await recover();
    expect(again.parcelMissing).toBe(false);
    expect(activeParcels()).toHaveLength(1);
    expect(String(activeParcels()[0]!["parcel_code"])).toBe(first);
  });

  it("a member without orders.confirm cannot recover — refused before any database call", async () => {
    await strand();
    const before = recoveries().length;
    await expect(recover(STAFF.filter((p) => p !== "orders.confirm"))).rejects.toThrow(
      /Missing permission: orders\.confirm/,
    );
    expect(recoveries()).toHaveLength(before);
    expect(activeParcels()).toHaveLength(0);
  });

  it("another organization cannot recover this order — opaque not-found, nothing written", async () => {
    await strand();
    await expect(recover(STAFF, ORG_B)).rejects.toThrow(/Order not found/);
    expect(activeParcels()).toHaveLength(0);
  });

  it("a cancelled order is refused and gets no parcel", async () => {
    await strand();
    const { transitionLifecycleStatus } = await import("../server/orders/service");
    await transitionLifecycleStatus(
      ctx([...STAFF, "orders.cancel"]),
      ORDER_A,
      "cancelled",
      null,
      principalOf(ctx([...STAFF, "orders.cancel"])),
    );
    expect(lifecycle()).toBe("cancelled");
    expect((await readDetail()).parcelMissing).toBe(false);
    await expect(recover()).rejects.toThrow(/changed concurrently \(now cancelled\)/);
    expect(parcels()).toHaveLength(0);
  });

  it("a draft order cannot use the recovery path", async () => {
    expect(lifecycle()).toBe("draft");
    expect((await readDetail()).parcelMissing).toBe(false);
    await expect(recover()).rejects.toThrow(/changed concurrently \(now draft\)/);
    expect(lifecycle()).toBe("draft");
    expect(parcels()).toHaveLength(0);
  });
});

// ── 2. Internal label always available ────────────────────────────────────────

describe("Internal APSA Parcel label", () => {
  it("exists right after confirmation: QR + Code 128 of the parcel ID, no carrier, no PII", async () => {
    await confirm();
    const data = await internalLabel();
    expect(data.parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
    expect(JSON.stringify(data)).not.toMatch(/Sokha|012 345 678|Phnom Penh|VET/);

    const vm = buildInternalParcelLabel(data);
    expect(vm.qr!.payload).toBe(data.parcelCode);
    expect(vm.code128!.payload).toBe(data.parcelCode);
    const html = renderToStaticMarkup(createElement(InternalParcelLabel, { vm }));
    expect(html).toContain('data-testid="internal-parcel-label-qr"');
    expect(html).toContain('data-testid="internal-parcel-label-code128"');
    expect(html).toContain(data.parcelCode);
    expect(html).toContain(T.internal.notShipping);
    expect(html).not.toMatch(/Sokha|VET/);
  });

  it("stays available — and identical — before delivery, after delivery and after cancellation", async () => {
    await confirm();
    const before = (await internalLabel()).parcelCode;
    const a = await arrange();
    const during = (await internalLabel()).parcelCode;
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");
    const after = (await internalLabel()).parcelCode;
    expect(during).toBe(before);
    expect(after).toBe(before);
  });
});

// ── 3. Pack before delivery ───────────────────────────────────────────────────

describe("Pack Order works before Arrange Delivery", () => {
  it("pack requirements load with the APSA Parcel and no delivery exists", async () => {
    await confirm();
    const { getPackRequirements } = await import("../server/packing/service");
    const req = await getPackRequirements(ctx(STAFF), ORDER_A);
    expect(req).not.toBeNull();
    expect(req!.parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
    expect(world.tables["deliveries"]).toHaveLength(0);
  });

  it("the APSA Parcel scan is accepted by Pack Order", async () => {
    await confirm();
    const code = String(activeParcels()[0]!["parcel_code"]);
    const { validatePackParcelScan } = await import("../server/packing/service");
    expect(await validatePackParcelScan(ctx(STAFF), ORDER_A, code)).toEqual({
      kind: "parcel_accepted",
      parcelCode: code,
    });
  });
});

// ── 4. Shipment attaches; shipping label only after delivery ─────────────────

describe("Arrange Delivery creates a shipment that attaches to the existing parcel", () => {
  it("does NOT create a parcel: the shipment returns the parcel generated at confirmation", async () => {
    await confirm();
    const parcelBefore = activeParcels()[0]!;
    const shipment = await arrange();
    expect(shipment.parcelId).toBe(parcelBefore["id"]);
    expect(shipment.parcelCode).toBe(parcelBefore["parcel_code"]);
    expect(parcels()).toHaveLength(1);
  });

  it("shipping label: no shipment → nothing to print; after Arrange Delivery → carrier + tracking", async () => {
    await confirm();
    const before = await shippingLabel();
    expect(before.delivery).toBeNull();
    const actionsBefore = fulfillmentActions({
      canPrintLabel: true,
      canPack: true,
      packed: false,
      canArrangeDelivery: true,
      activeDeliveryStatus: null,
      canHandoff: true,
      parcelCode: null,
      canPrintShippingLabel: true,
      shipmentArranged: false,
    });
    expect(actionsBefore.find((a) => a.key === "print_shipping_label")?.disabled).toBe(true);
    expect(actionsBefore.find((a) => a.key === "print_label")?.disabled).toBe(false);

    await arrange();
    const after = await shippingLabel();
    expect(after.delivery?.providerName).toBe("VET Express");
    expect(after.delivery?.trackingNumber).toBe("VET-42");
  });

  it("shipping label: tracking Code 128 is primary; a small APSA QR carries the SAME parcel", async () => {
    await confirm();
    await arrange();
    const data = await shippingLabel();
    const vm = buildParcelLabel(data);
    const parcelCode = String(activeParcels()[0]!["parcel_code"]);
    expect(vm.trackingCode128!.payload).toBe("VET-42");
    expect(vm.parcelCode).toBe(parcelCode);
    // The small APSA QR is the very identity Pack Order and Handoff use.
    expect(vm.apsaQr!.payload).toBe(parcelCode);
    const html = renderToStaticMarkup(createElement(ParcelLabel, { vm }));
    expect(html).toContain(parcelCode);
    expect(html).toContain("VET Express");
    expect(html).toContain('data-testid="parcel-label-apsa-qr"');
    expect((html.match(/<svg/g) ?? []).length).toBe(2);
  });

  it("after cancellation the new shipping label keeps the same small APSA QR", async () => {
    await confirm();
    const a = await arrange("VET Express", "VET-42");
    const first = buildParcelLabel(await shippingLabel());
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");
    await arrange("J&T Express", "JT-7");
    const second = buildParcelLabel(await shippingLabel());
    expect(second.trackingCode128!.payload).toBe("JT-7");
    expect(second.apsaQr!.svg).toBe(first.apsaQr!.svg);
  });
});

// ── 5. Cancellation: new shipment only ────────────────────────────────────────

describe("Delivery cancellation creates a new shipment only", () => {
  it("shipment B attaches to the SAME parcel; parcel untouched; new shipping label", async () => {
    await confirm();
    const parcelBefore = { ...activeParcels()[0]! };
    const a = await arrange("VET Express", "VET-42");
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");

    // Between shipments: no shipping label (A's carrier/tracking are void).
    expect((await shippingLabel()).delivery).toBeNull();

    const b = await arrange("J&T Express", "JT-7");
    expect(b.id).not.toBe(a.id);
    expect(b.parcelId).toBe(parcelBefore["id"]);
    expect(b.parcelCode).toBe(parcelBefore["parcel_code"]);
    expect(parcels()).toHaveLength(1);
    expect(parcels()[0]).toEqual(parcelBefore);

    const label = await shippingLabel();
    expect(label.delivery?.providerName).toBe("J&T Express");
    expect(label.delivery?.trackingNumber).toBe("JT-7");
    expect(label.parcelCode).toBe(parcelBefore["parcel_code"]);
  });

  it("no repacking: a packed order's replacement shipment is readied without Pack Order", async () => {
    await confirm();
    const a = await arrange();
    world.packed = true;
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Courier no-show");
    const b = await arrange("J&T Express", "JT-7");
    expect(b.status).toBe("ready");
    expect(b.parcelCode).toBe(a.parcelCode);
  });
});

// ── 6. Courier Handoff + returns reference the APSA Parcel ────────────────────

describe("Courier Handoff and returns use the APSA Parcel ID", () => {
  it("handoff identifies the parcel by its APSA ID and shows the attached shipment", async () => {
    await confirm();
    const a = await arrange();
    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(ctx(STAFF), a.parcelCode);
    expect(preview!.parcelCode).toBe(a.parcelCode);
    expect(preview!.orderId).toBe(ORDER_A);
    expect(preview!.deliveryId).toBe(a.id);
    expect(preview!.externalTrackingNumber).toBe("VET-42");
  });

  it("after cancellation the SAME APSA ID resolves to the replacement shipment", async () => {
    await confirm();
    const a = await arrange();
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");
    const b = await arrange("J&T Express", "JT-7");
    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(ctx(STAFF), a.parcelCode);
    expect(preview!.deliveryId).toBe(b.id);
    expect(preview!.providerName).toBe("J&T Express");
  });

  it("returns reference: the APSA ID still resolves to the order after shipments change", async () => {
    await confirm();
    const a = await arrange();
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");
    await arrange("J&T Express", "JT-7");
    const { resolveParcelCode } = await import("../server/parcels/service");
    const resolved = await resolveParcelCode(ctx(STAFF), a.parcelCode);
    expect(resolved!.orderId).toBe(ORDER_A);
    expect(resolved!.parcelCode).toBe(a.parcelCode);
  });

  it("another organization can never resolve the APSA ID", async () => {
    await confirm();
    const code = String(activeParcels()[0]!["parcel_code"]);
    const { resolveParcelCode } = await import("../server/parcels/service");
    expect(await resolveParcelCode(ctx(STAFF, ORG_B), code)).toBeNull();
  });
});

// ── 7. Shipping label validation (P2) ─────────────────────────────────────────

describe("shipping label: print is refused unless every identifier is present", () => {
  async function ready() {
    await confirm();
    await arrange();
    return shippingLabel();
  }

  it("a complete label has no issues", async () => {
    expect(shippingLabelIssues(await ready())).toEqual([]);
  });

  it("missing parcel → refused (never a placeholder ID)", async () => {
    const data = await ready();
    expect(shippingLabelIssues({ ...data, parcelCode: null })).toEqual(["no_parcel"]);
  });

  it("missing shipment → refused", async () => {
    await confirm();
    expect(shippingLabelIssues(await shippingLabel())).toEqual(["no_shipment"]);
  });

  it("missing tracking → refused", async () => {
    await confirm();
    await arrange("VET Express", "");
    expect(shippingLabelIssues(await shippingLabel())).toEqual(["no_tracking"]);
  });

  it("unsupported carrier barcode (tracking not Code 128 encodable) → refused", async () => {
    await confirm();
    await arrange("VET Express", "ឃ-123");
    expect(shippingLabelIssues(await shippingLabel())).toEqual(["tracking_unrenderable"]);
  });

  it("parcel lookup failure → the label read fails (never 'no parcel' silently)", async () => {
    await confirm();
    await arrange();
    const { setParcelRepositoryDbForTests } = await import("../server/parcels/repository");
    const failing = {
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          neq: () => q,
          limit: async () => ({ data: null, error: { message: "connection reset" } }),
        };
        return q;
      },
    };
    restores.push(setParcelRepositoryDbForTests(failing));
    await expect(shippingLabel()).rejects.toThrow(/findActiveParcelByOrder/);
  });
});

// ── 8. Authoritative pre-print data (P2) ──────────────────────────────────────

describe("pre-print: fresh server data must match what is shown", () => {
  async function shown() {
    await confirm();
    const a = await arrange();
    return { a, data: await shippingLabel() };
  }

  it("unchanged fresh data → ok", async () => {
    const { data } = await shown();
    expect(verifyFreshLabels([data], [await shippingLabel()])).toEqual({ kind: "ok" });
  });

  it("replacement shipment (cancel A, arrange B) → changed, never prints A", async () => {
    const { a, data } = await shown();
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(STAFF), a.id, "Wrong courier");
    await arrange("VET Express", "VET-42"); // even the SAME carrier + tracking
    const fresh = await shippingLabel();
    expect(fresh.delivery?.id).not.toBe(data.delivery?.id);
    expect(verifyFreshLabels([data], [fresh])).toEqual({ kind: "changed" });
  });

  it("payment update (COD → paid) → changed", async () => {
    const { data } = await shown();
    const fresh: ParcelLabelInput = {
      ...data,
      payment: { state: "paid", collect: null, partial: false, checkReason: null },
    };
    expect(verifyFreshLabels([data], [fresh])).toEqual({ kind: "changed" });
  });

  it("COD amount update → changed", async () => {
    const { data } = await shown();
    const fresh: ParcelLabelInput = {
      ...data,
      payment: { ...data.payment, collect: { amount: 1999, currency: "USD" } },
    };
    expect(data.payment.collect?.amount).not.toBe(1999);
    expect(verifyFreshLabels([data], [fresh])).toEqual({ kind: "changed" });
  });

  it("identity switch (user, organization, orders) or closing retires the attempt in flight", () => {
    const guard = createPrintGuard();
    guard.setContext(printIdentity(USER_A, ORG_A, [ORDER_A]), true);
    const live = guard.begin();
    expect(live()).toBe(true);
    guard.setContext(printIdentity("other-user", ORG_A, [ORDER_A]), true);
    expect(live()).toBe(false);

    const live2 = guard.begin();
    guard.setContext(printIdentity("other-user", ORG_B, [ORDER_A]), true);
    expect(live2()).toBe(false);

    const live3 = guard.begin();
    guard.setContext(printIdentity("other-user", ORG_B, ["another-order"]), true);
    expect(live3()).toBe(false);

    const live4 = guard.begin();
    guard.setContext(printIdentity("other-user", ORG_B, ["another-order"]), false);
    expect(live4()).toBe(false);

    guard.setContext(printIdentity("other-user", ORG_B, ["another-order"]), true);
    const live5 = guard.begin();
    guard.retire(); // unmount / navigation
    expect(live5()).toBe(false);
  });

  it("an incomplete fresh label (tracking removed) → invalid", async () => {
    const { data } = await shown();
    const fresh: ParcelLabelInput = {
      ...data,
      delivery: { ...data.delivery!, trackingNumber: null },
    };
    // A tracking change is a change first; with identical shown data it is invalid.
    expect(verifyFreshLabels([fresh], [fresh])).toEqual({ kind: "invalid" });
  });
});

// ── 9. Returns start from the APSA Parcel (P2) ────────────────────────────────

describe("Returns: APSA Parcel → order → authorized returns workflow", () => {
  const RETURNS = ["orders.read", "orders.return"];

  /** Confirm, ship, deliver; the order line's stock left in a 'sale' movement. */
  async function deliveredParcel(replaceShipment = false): Promise<string> {
    await confirm();
    const code = String(activeParcels()[0]!["parcel_code"]);
    let shipment = await arrange();
    if (replaceShipment) {
      const { cancelDelivery } = await import("../server/deliveries/service");
      await cancelDelivery(ctx(STAFF), shipment.id, "Wrong courier");
      shipment = await arrange("J&T Express", "JT-7");
    }
    world.tables["deliveries"]!.find((d) => d["id"] === shipment.id)!["status"] = "delivered";
    (world.tables["inventory_movements"] ??= []).push({
      id: crypto.randomUUID(),
      organization_id: ORG_A,
      movement_type: "sale",
      reference_type: "order_item",
      reference_id: "item-1",
    });
    return code;
  }

  it("a parcel scan starts the Returns flow with the order's returnable lines", async () => {
    const code = await deliveredParcel();
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    const result = await findReturnableOrderByParcel(ctx(RETURNS), code);
    expect(result.kind).toBe("order");
    if (result.kind !== "order") return;
    expect(result.order.orderId).toBe(ORDER_A);
    expect(result.order.lines.map((l) => [l.orderItemId, l.returnableQuantity])).toEqual([
      ["item-1", 2],
    ]);
  });

  it("parcel and order number resolve the same order and lines", async () => {
    const code = await deliveredParcel();
    const svc = await import("../server/returns/service");
    const byParcel = await svc.findReturnableOrderByParcel(ctx(RETURNS), code);
    const byNumber = await svc.findReturnableOrder(ctx(RETURNS), "APSA-2026-000777");
    expect(byParcel).toEqual(byNumber);
  });

  it("shipment replacement does not affect returns: same parcel, same order", async () => {
    const code = await deliveredParcel(true);
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    const result = await findReturnableOrderByParcel(ctx(RETURNS), code);
    expect(result.kind).toBe("order");
    if (result.kind === "order") expect(result.order.orderId).toBe(ORDER_A);
  });

  it("tenant isolation: another organization's parcel reads as unknown", async () => {
    const code = await deliveredParcel();
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    expect(await findReturnableOrderByParcel(ctx(RETURNS, ORG_B), code)).toEqual({
      kind: "order_not_found",
    });
  });

  it("malformed or unknown codes read as unknown", async () => {
    await deliveredParcel();
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    for (const bad of ["APSA:PCL:v1:short", "APSA:PCL:v1:AAAAAAAAAAAAAAAAAAAAAA", "not-a-parcel"]) {
      expect(await findReturnableOrderByParcel(ctx(RETURNS), bad)).toEqual({
        kind: "order_not_found",
      });
    }
  });

  it("permission denial: without orders.return nothing is read", async () => {
    const code = await deliveredParcel();
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    await expect(findReturnableOrderByParcel(ctx(["orders.read"]), code)).rejects.toThrow(
      /orders\.return/,
    );
  });

  it("not yet delivered: the parcel resolves but the order is not returnable", async () => {
    await confirm();
    const code = String(activeParcels()[0]!["parcel_code"]);
    const { findReturnableOrderByParcel } = await import("../server/returns/service");
    expect(await findReturnableOrderByParcel(ctx(RETURNS), code)).toEqual({
      kind: "order_not_delivered",
    });
  });

  it("the returns screen routes a scanned APSA code to the parcel lookup", () => {
    expect(returnLookupFor("  APSA:PCL:v1:AbCdEfGhIjKlMnOpQrStUv ")).toEqual({
      kind: "parcel",
      parcelCode: "APSA:PCL:v1:AbCdEfGhIjKlMnOpQrStUv",
    });
    expect(returnLookupFor("APSA-2026-000777")).toEqual({
      kind: "order",
      orderNumber: "APSA-2026-000777",
    });
    expect(returnLookupFor("   ")).toBeNull();
    const route = source("src/routes/app.returns.new.tsx");
    expect(route).toContain("findReturnableOrderByParcel(lookup.parcelCode)");
  });
});

// ── 10. UI wiring (source-level) ──────────────────────────────────────────────

function source(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

describe("UI wiring", () => {
  it("Ready to Pack prints the internal label; the order page offers both labels", () => {
    expect(source("src/routes/app.pack.tsx")).toContain("<InternalParcelLabelDialog");
    const order = source("src/routes/app.orders.$id.tsx");
    expect(order).toContain("<InternalParcelLabelDialog");
    expect(order).toContain("<ParcelLabelDialog");
    expect(order).toContain('case "print_shipping_label":');
    expect(order).toContain('t("order.shippingLabelNeedsDelivery")');
  });

  it("the shipping dialog never creates a parcel and prints only with a shipment", () => {
    const dialog = source("src/components/labels/ParcelLabelDialog.tsx");
    expect(dialog).not.toContain("createParcel");
    expect(dialog).toContain("printable={canPrint && allConfirmed && allComplete}");
    expect(dialog).toContain("shippingLabelIssues(d)");
    expect(dialog).toContain("verifyFreshLabels(displayed, fresh)");
  });

  it("every new string exists in Khmer and English", () => {
    for (const lang of ["en", "km"]) {
      const j = JSON.parse(source(`src/locales/${lang}.json`));
      for (const k of ["apsaParcelId", "noTracking", "needsDelivery"]) {
        expect(typeof j.labels.parcel[k]).toBe("string");
      }
      for (const k of ["title", "dialogTitle", "bulkTitle", "notShipping", "parcelId", "noCode"]) {
        expect(typeof j.labels.internal[k]).toBe("string");
      }
      expect(typeof j.order.printShippingLabel).toBe("string");
      expect(typeof j.order.shippingLabelNeedsDelivery).toBe("string");
    }
  });
});
