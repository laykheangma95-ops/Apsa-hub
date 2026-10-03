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
        o[col] = args["p_to"];
        return { data: { status: "success", stock_movements: 0 }, error: null };
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
  ]);
  restores.push(
    repos[0].setDeliveryRepositoryDbForTests(db),
    repos[1].setParcelRepositoryDbForTests(db),
    repos[2].setOrderRepositoryDbForTests(db),
    repos[3].setFulfillmentRepositoryDbForTests(db),
    repos[4].setProductRepositoryDbForTests(db),
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
  return transitionLifecycleStatus(ctx(STAFF), ORDER_A, "confirmed");
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

  it("an order confirmed before this change gets its parcel on first use (backfill, idempotent)", async () => {
    restores.splice(0).forEach((r) => r());
    await install(seed("confirmed"));
    const first = await internalLabel();
    const again = await internalLabel();
    expect(first.parcelCode).toBe(again.parcelCode);
    expect(activeParcels()).toHaveLength(1);
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

  it("the shipping label's barcode is the tracking number; the APSA Parcel ID is text only", async () => {
    await confirm();
    await arrange();
    const data = await shippingLabel();
    const vm = buildParcelLabel(data);
    expect(vm.trackingCode128!.payload).toBe("VET-42");
    expect(vm.parcelCode).toBe(String(activeParcels()[0]!["parcel_code"]));
    const html = renderToStaticMarkup(createElement(ParcelLabel, { vm }));
    expect(html).toContain(vm.parcelCode!);
    expect(html).toContain("VET Express");
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
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

// ── 7. UI wiring (source-level) ───────────────────────────────────────────────

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
    expect(dialog).toContain("printable={canPrint && allConfirmed && allShipped}");
    expect(dialog).toContain('t("labels.parcel.needsDelivery")');
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
