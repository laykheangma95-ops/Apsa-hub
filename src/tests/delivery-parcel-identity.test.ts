/**
 * Delivery arrangement → ONE permanent parcel identity → print-ready label.
 *
 * Regression for: a delivery existed (carrier + tracking printed on the label)
 * yet the label still said "Parcel code not assigned yet". Root cause: arranging
 * a delivery never generated the parcel identity — it was minted only lazily,
 * from the label dialog, for members holding fulfillment.create_parcel — and
 * the label read swallowed every parcel-lookup error into "no code".
 *
 * Every service below runs for real against ONE in-memory world shared by the
 * delivery, parcel, order, fulfillment, packing and handoff repositories, so
 * "the same identity everywhere" is asserted across real code paths, not mocks
 * of each other.
 *
 * Run: bun test src/tests/delivery-parcel-identity.test.ts
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
import { ParcelLabel } from "../components/labels/ParcelLabel";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER_A = "aaaaaaaa-1111-4000-8000-000000000001";
const ORDER_A = "aaaaaaaa-2222-4000-8000-000000000001";
const LOCATION_A = "aaaaaaaa-4444-4000-8000-000000000001";
const T = km.labels.parcel;

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

// ── In-memory world ───────────────────────────────────────────────────────────

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 3, 0, 0, clock++)).toISOString();

interface World {
  tables: Tables;
  rpcCalls: string[];
  /** Make the next N parcel inserts fail (simulates a transient write error). */
  failParcelInserts: number;
  /** Make parcel reads fail (simulates the lookup error the label used to swallow). */
  failParcelReads: boolean;
}

function seed(): World {
  return {
    rpcCalls: [],
    failParcelInserts: 0,
    failParcelReads: false,
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
          lifecycle_status: "confirmed",
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
      if (table === "parcels" && world.failParcelReads && insertRow === null) {
        return { data: null, error: { message: "parcels: connection reset" } };
      }
      if (insertRow !== null) {
        const row = insertRow;
        if (table === "parcels") {
          if (world.failParcelInserts > 0) {
            world.failParcelInserts--;
            return { data: null, error: { message: "insertParcel: transient failure" } };
          }
          const clash = (world.tables["parcels"] ?? []).some(
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

  return {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      world.rpcCalls.push(name);
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
        const order = world.tables["orders"]!.find((o) => o["id"] === args["p_order_id"])!;
        order["fulfillment_status"] = "processing";
        return {
          data: { status: "success", delivery_id: id, order_fulfillment: "processing" },
          error: null,
        };
      }
      if (name === "transition_delivery_status_v1") {
        const d = world.tables["deliveries"]!.find((r) => r["id"] === args["p_delivery_id"])!;
        const from = d["status"];
        d["status"] = args["p_to_status"];
        const order = world.tables["orders"]!.find((o) => o["id"] === d["order_id"])!;
        if (d["status"] === "cancelled") order["fulfillment_status"] = "unfulfilled";
        return { data: { status: "success", from, to: d["status"] }, error: null };
      }
      if (name === "order_currently_packed_v1") return { data: false, error: null };
      return { data: { status: "success" }, error: null };
    },
  };
}

let world: World;
const restores: Array<() => void> = [];

beforeEach(async () => {
  // Rendered strings are asserted against the Khmer (default) locale; other
  // suites may have switched the shared i18n instance.
  await i18n.changeLanguage("km");
  world = seed();
  const db = makeDb(world);
  const deliveries = await import("../server/deliveries/repository");
  const parcels = await import("../server/parcels/repository");
  const orders = await import("../server/orders/repository");
  const fulfil = await import("../server/fulfillment/repository");
  restores.push(
    deliveries.setDeliveryRepositoryDbForTests(db),
    parcels.setParcelRepositoryDbForTests(db),
    orders.setOrderRepositoryDbForTests(db),
    fulfil.setFulfillmentRepositoryDbForTests(db),
  );
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

/** A Sales-style member: may arrange delivery but NOT create parcels directly. */
const ARRANGER = ["delivery.create", "delivery.read", "delivery.update"];
const PRINTER = ["orders.read", "fulfillment.print_label", "delivery.read"];

async function arrange(perms = ARRANGER) {
  const { createDelivery } = await import("../server/deliveries/service");
  return createDelivery(ctx(perms), {
    orderId: ORDER_A,
    providerName: "VET Express",
    externalTrackingNumber: "VET-42",
  });
}

async function labelData(perms = PRINTER): Promise<ParcelLabelInput> {
  const { getParcelLabelData } = await import("../server/fulfillment/service");
  return (await getParcelLabelData(ctx(perms), ORDER_A)) as unknown as ParcelLabelInput;
}

const activeParcels = () => world.tables["parcels"]!.filter((p) => p["status"] !== "void");

// ── Arrange Delivery ─────────────────────────────────────────────────────────

describe("Arrange Delivery generates the parcel identity", () => {
  it("creating a delivery immediately creates ONE valid parcel identity and returns it", async () => {
    expect(activeParcels()).toHaveLength(0);
    const created = await arrange();

    expect(created.status).toBe("pending");
    expect(created.providerName).toBe("VET Express");
    expect(created.externalTrackingNumber).toBe("VET-42");
    expect(created.parcelCode).not.toBeNull();
    expect(isValidParcelCode(created.parcelCode!)).toBe(true);

    expect(activeParcels()).toHaveLength(1);
    expect(activeParcels()[0]!["parcel_code"]).toBe(created.parcelCode);
    expect(activeParcels()[0]!["organization_id"]).toBe(ORG_A);
    expect(activeParcels()[0]!["order_id"]).toBe(ORDER_A);
  });

  it("does not require fulfillment.create_parcel — delivery.create authorizes arrangement", async () => {
    const created = await arrange(ARRANGER);
    expect(ARRANGER).not.toContain("fulfillment.create_parcel");
    expect(created.parcelCode).not.toBeNull();
  });

  it("is still refused without delivery.create (no delivery, no identity)", async () => {
    await expect(arrange(["delivery.read"])).rejects.toThrow(/delivery\.create/);
    expect(world.tables["deliveries"]).toHaveLength(0);
    expect(activeParcels()).toHaveLength(0);
  });

  it("an existing identity (label printed earlier) is reused, never duplicated", async () => {
    const { createParcelForOrder } = await import("../server/parcels/service");
    const early = await createParcelForOrder(ctx(["fulfillment.create_parcel"]), ORDER_A);
    const created = await arrange();
    expect(created.parcelCode).toBe(early.parcelCode);
    expect(activeParcels()).toHaveLength(1);
  });

  it("a transient identity write failure is retried once and never fails the arrangement", async () => {
    world.failParcelInserts = 1;
    const created = await arrange();
    expect(created.parcelCode).not.toBeNull();
    expect(activeParcels()).toHaveLength(1);
  });

  it("a persistent identity failure keeps the delivery and reports parcelCode null (label recovers it)", async () => {
    world.failParcelInserts = 5;
    const created = await arrange();
    expect(world.tables["deliveries"]).toHaveLength(1);
    expect(created.parcelCode).toBeNull();
    expect(activeParcels()).toHaveLength(0);
  });

  it("concurrent creation converges on one identity (unique-index loser reads the winner)", async () => {
    const { ensureParcelForOrder } = await import("../server/parcels/service");
    const [a, b] = await Promise.all([
      ensureParcelForOrder(ORG_A, USER_A, ORDER_A),
      ensureParcelForOrder(ORG_A, USER_A, ORDER_A),
    ]);
    expect(a.parcelCode).toBe(b.parcelCode);
    expect(activeParcels()).toHaveLength(1);
  });
});

// ── Label refresh + rendering ─────────────────────────────────────────────────

describe("Parcel label after arrangement", () => {
  it("before arrangement: no identity, not arranged — 'not assigned yet' + 'arrange delivery first'", async () => {
    const data = await labelData();
    expect(data.parcelCode).toBeNull();
    expect(data.deliveryArranged).toBe(false);
    expect(activeParcels()).toHaveLength(0);

    const html = renderToStaticMarkup(createElement(ParcelLabel, { vm: buildParcelLabel(data) }));
    expect(html).toContain(T.codesPending);
    expect(html).toContain(T.arrangeFirst);
    expect(html).not.toContain("<svg");
  });

  it("label refresh: the very next read carries the code, carrier and tracking", async () => {
    const before = await labelData();
    expect(before.parcelCode).toBeNull();

    const created = await arrange();
    const after = await labelData();

    expect(after.deliveryArranged).toBe(true);
    expect(after.parcelCode).toBe(created.parcelCode);
    expect(after.delivery?.providerName).toBe("VET Express");
    expect(after.delivery?.trackingNumber).toBe("VET-42");
  });

  it("QR rendering: the label QR encodes exactly the parcel identity", async () => {
    const created = await arrange();
    const vm = buildParcelLabel(await labelData());
    expect(vm.qr).not.toBeNull();
    expect(vm.qr!.payload).toBe(created.parcelCode!);
    expect(vm.qr!.svg).toContain("<svg");
  });

  it("Code 128 rendering: the barcode encodes the SAME parcel identity", async () => {
    const created = await arrange();
    const vm = buildParcelLabel(await labelData());
    expect(vm.code128).not.toBeNull();
    expect(vm.code128!.payload).toBe(created.parcelCode!);
    expect(vm.code128!.svg).toContain("<svg");
  });

  it("the rendered label shows QR, Code 128, parcel code, carrier and tracking — never 'not assigned yet'", async () => {
    const created = await arrange();
    const html = renderToStaticMarkup(
      createElement(ParcelLabel, { vm: buildParcelLabel(await labelData()) }),
    );
    expect(html).toContain('data-testid="parcel-label-code128"');
    expect(html).toContain(created.parcelCode!);
    expect(html).toContain("VET Express");
    expect(html).toContain("VET-42");
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(T.codesPending);
    expect(html).not.toContain('data-testid="parcel-label-codes-placeholder"');
  });

  it("re-open label: repeated reads return the identical identity and identical code graphics", async () => {
    await arrange();
    const first = buildParcelLabel(await labelData());
    const reopened = buildParcelLabel(await labelData());
    expect(reopened.parcelCode).toBe(first.parcelCode);
    expect(reopened.qr!.svg).toBe(first.qr!.svg);
    expect(reopened.code128!.svg).toBe(first.code128!.svg);
    expect(activeParcels()).toHaveLength(1);
  });

  it("a member without delivery.read: arranged is proven by the identity, without reading deliveries", async () => {
    await arrange();
    const data = await labelData(["orders.read", "fulfillment.print_label"]);
    expect(data.delivery).toBeNull();
    expect(data.deliveryArranged).toBe(true);
    expect(data.parcelCode).not.toBeNull();
  });

  it("a failed parcel lookup fails the label read — never silently 'not assigned yet'", async () => {
    await arrange();
    world.failParcelReads = true;
    await expect(labelData()).rejects.toThrow(/findActiveParcelByOrder/);
  });

  it("another organization never sees the identity", async () => {
    await arrange();
    const { getParcelCodeForOrder } = await import("../server/parcels/service");
    expect(await getParcelCodeForOrder(ORG_B, ORDER_A)).toBeNull();
  });
});

// ── Same identity everywhere ──────────────────────────────────────────────────

describe("One identity reused by Pack Order and Courier Handoff", () => {
  it("Pack Order accepts the arranged identity and rejects any other code", async () => {
    const created = await arrange();
    const { validatePackParcelScan } = await import("../server/packing/service");
    const ok = await validatePackParcelScan(ctx(["orders.read"]), ORDER_A, created.parcelCode!);
    expect(ok).toEqual({ kind: "parcel_accepted", parcelCode: created.parcelCode! });

    const other = "APSA:PCL:v1:AAAAAAAAAAAAAAAAAAAAAA";
    const wrong = await validatePackParcelScan(ctx(["orders.read"]), ORDER_A, other);
    expect(wrong.kind).toBe("wrong_parcel");
  });

  it("Courier Handoff resolves the same identity to this order and its delivery", async () => {
    const created = await arrange();
    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(ctx(["delivery.handoff"]), created.parcelCode!);
    expect(preview).not.toBeNull();
    expect(preview!.parcelCode).toBe(created.parcelCode);
    expect(preview!.orderId).toBe(ORDER_A);
    expect(preview!.providerName).toBe("VET Express");
    expect(preview!.externalTrackingNumber).toBe("VET-42");
  });
});

// ── Cancellation + recreation ─────────────────────────────────────────────────

describe("Delivery recreated after cancellation", () => {
  it("keeps the order's single identity: the recreated delivery reuses it, no duplicate", async () => {
    const { cancelDelivery } = await import("../server/deliveries/service");
    const first = await arrange();
    await cancelDelivery(ctx(ARRANGER), first.id, "Wrong courier");

    // Between cancel and recreate the label is not printable (no arranged delivery).
    const between = await labelData();
    expect(between.deliveryArranged).toBe(false);

    const second = await arrange();
    expect(second.id).not.toBe(first.id);
    expect(second.parcelCode).toBe(first.parcelCode);
    expect(activeParcels()).toHaveLength(1);

    const after = await labelData();
    expect(after.deliveryArranged).toBe(true);
    expect(after.parcelCode).toBe(first.parcelCode);
  });

  it("only a voided identity is ever replaced: a new delivery then mints a fresh code", async () => {
    const first = await arrange();
    const { cancelDelivery } = await import("../server/deliveries/service");
    await cancelDelivery(ctx(ARRANGER), first.id, "Parcel destroyed");
    world.tables["parcels"]!.forEach((p) => (p["status"] = "void"));

    const second = await arrange();
    expect(second.parcelCode).not.toBeNull();
    expect(second.parcelCode).not.toBe(first.parcelCode);
    expect(activeParcels()).toHaveLength(1);
  });
});

// ── UI wiring (source-level, like the other fulfillment wiring tests) ─────────

function source(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

describe("UI refresh + gating wiring", () => {
  it("the label dialog never reopens onto a previous payload and only assigns codes after arrangement", () => {
    const dialog = source("src/components/labels/ParcelLabelDialog.tsx");
    expect(dialog).toMatch(/removeQueries\(\{\s*queryKey: fulfillmentKeys\.parcelLabelsPrefix/);
    expect(dialog).toContain("return !d.parcelCode && isDeliveryArranged(d);");
    expect(dialog).toContain("printable={canPrint && allConfirmed && allArranged && allCoded}");
    expect(dialog).toContain('t("labels.parcel.needsDelivery")');
  });

  it("arranging delivery on the order evicts cached labels and opens the fresh label", () => {
    const route = source("src/routes/app.orders.$id.tsx");
    const onCreated = route.slice(route.indexOf("<CreateDeliverySheet"));
    const block = onCreated.slice(0, onCreated.indexOf("/>"));
    expect(block).toContain("fulfillmentKeys.parcelLabelsPrefix(userId, routeOrganizationId)");
    expect(block).toContain("setParcelLabelOpen(true)");
  });

  it("Print parcel label is disabled with 'Arrange delivery first' until delivery exists", () => {
    const route = source("src/routes/app.orders.$id.tsx");
    expect(route).toContain("disabled={!labelDeliveryArranged}");
    expect(route).toContain('t("order.printLabelNeedsDelivery")');
  });

  it("the order-created screens offer Arrange Delivery Now / Add Delivery Later", () => {
    const choice = source("src/components/delivery/DeliveryArrangementChoice.tsx");
    expect(choice).toContain('search={{ arrange: "delivery" }}');
    expect(choice).toContain('t("order.deliveryChoice.arrangeNow")');
    expect(choice).toContain('t("order.deliveryChoice.later")');
    expect(choice).toContain('t("order.deliveryChoice.awaiting")');
    expect(source("src/components/pos/PosCheckoutSheet.tsx")).toContain(
      "<DeliveryArrangementChoice",
    );
    expect(source("src/components/inbox/PrepareOrderSheet.tsx")).toContain(
      "<DeliveryArrangementChoice",
    );
  });

  it("every new string exists in both Khmer and English", () => {
    const en = JSON.parse(source("src/locales/en.json"));
    const kmJson = JSON.parse(source("src/locales/km.json"));
    for (const loc of [en, kmJson]) {
      for (const k of ["arrangeFirst", "codesAssigning", "needsDelivery"]) {
        expect(typeof loc.labels.parcel[k]).toBe("string");
      }
      expect(typeof loc.order.printLabelNeedsDelivery).toBe("string");
      for (const k of ["title", "body", "arrangeNow", "later", "awaiting", "awaitingBody"]) {
        expect(typeof loc.order.deliveryChoice[k]).toBe("string");
      }
    }
  });
});
