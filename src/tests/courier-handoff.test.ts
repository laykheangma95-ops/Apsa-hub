/**
 * Courier Handoff — server service integration tests.
 *
 * Tests the handoff service with mock AuthorizationContext and mock
 * repositories, proving:
 *   - Successful handoff (ready → in_transit)
 *   - Duplicate handoff rejection (already in_transit)
 *   - Wrong parcel (not found / voided)
 *   - Wrong order (not confirmed)
 *   - No active delivery
 *   - Permission denial (missing delivery.handoff)
 *   - Cross-org denial (parcel belongs to different org)
 *   - Lifecycle enforcement (delivery not in 'ready' status)
 *   - Client-side display predicates
 *
 * Run: bun test src/tests/courier-handoff.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  canConfirmHandoff,
  isAlreadyHandedOff,
  handoffErrorMessage,
  type HandoffPreview,
  type HandoffResult,
} from "../lib/handoff";

// ── Mock data ──────────────────────────────────────────────────────────────

const ORG_A = "org-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "org-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORDER_ID = "order-1111-1111-1111-111111111111";
const DELIVERY_ID = "delivery-2222-2222-2222-222222222222";
const PARCEL_CODE = "APSA:PCL:v1:abcdefghijklmnopqrstuv";

let mockOrders: any[] = [];
let mockParcels: any[] = [];
let mockDeliveries: any[] = [];
let transitionResults: any[] = [];

function makeConfirmedOrder(orgId: string = ORG_A) {
  return {
    id: ORDER_ID,
    organization_id: orgId,
    order_number: "APSA-2026-000001",
    lifecycle_status: "confirmed",
    fulfillment_status: "processing",
  };
}

function makeParcel(orgId: string = ORG_A, orderId: string = ORDER_ID) {
  return {
    id: "parcel-1",
    organization_id: orgId,
    order_id: orderId,
    parcel_code: PARCEL_CODE,
    status: "created",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeReadyDelivery(orgId: string = ORG_A, orderId: string = ORDER_ID) {
  return {
    id: DELIVERY_ID,
    organization_id: orgId,
    order_id: orderId,
    location_id: null,
    provider_id: null,
    provider_key: "manual",
    provider_name: "Flash Express",
    external_tracking_number: "TRK-001",
    cod_amount_minor: null,
    cod_currency: null,
    status: "ready",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// ── Mock AuthorizationContext ───────────────────────────────────────────────

function mockCtx(orgId: string, permissions: string[] = ["delivery.handoff"]) {
  const perms = new Set(permissions);
  return {
    organizationId: orgId,
    userId: "user-test",
    can(perm: string) {
      return perms.has(perm);
    },
    require(perm: string) {
      if (!perms.has(perm)) {
        const err = new Error(`Missing permission: ${perm}`);
        (err as any).statusCode = 403;
        (err as any).name = "ForbiddenError";
        throw err;
      }
    },
  } as any;
}

// ── Supabase-style mock query builder ──────────────────────────────────────

function makeChain(rows: any[]) {
  const filters: Record<string, any> = {};
  const neqFilters: Record<string, any> = {};
  const inFilters: Record<string, any[]> = {};

  function filtered() {
    return rows.filter((row) => {
      for (const [col, val] of Object.entries(filters)) {
        if (row[col] !== val) return false;
      }
      for (const [col, val] of Object.entries(neqFilters)) {
        if (row[col] === val) return false;
      }
      for (const [col, vals] of Object.entries(inFilters)) {
        if (!vals.includes(row[col])) return false;
      }
      return true;
    });
  }

  const chain: any = {
    eq(col: string, val: any) {
      filters[col] = val;
      return chain;
    },
    neq(col: string, val: any) {
      neqFilters[col] = val;
      return chain;
    },
    in(col: string, vals: any[]) {
      inFilters[col] = vals;
      return chain;
    },
    limit(_n: number) {
      const result = filtered();
      const limitChain: any = {
        ...chain,
        data: result,
        error: null,
        maybeSingle() {
          return { data: result[0] ?? null, error: null };
        },
        then(resolve: any, reject?: any) {
          try { resolve({ data: result, error: null }); } catch (e) { reject?.(e); }
        },
      };
      return limitChain;
    },
    maybeSingle() {
      const result = filtered();
      return { data: result[0] ?? null, error: null };
    },
    order() {
      return chain;
    },
    single() {
      const result = filtered();
      if (result.length === 0) {
        return { data: null, error: { code: "PGRST116", message: "no row" } };
      }
      return { data: result[0], error: null };
    },
    then(resolve: any, reject?: any) {
      try {
        resolve({ data: filtered(), error: null });
      } catch (e) {
        reject?.(e);
      }
    },
  };
  return chain;
}

function makeMockDb() {
  return {
    from(table: string) {
      return {
        select(_cols?: string) {
          if (table === "orders") return makeChain(mockOrders);
          if (table === "parcels") return makeChain(mockParcels);
          if (table === "deliveries") return makeChain(mockDeliveries);
          return makeChain([]);
        },
      };
    },
    rpc(name: string, _params: any) {
      if (name === "transition_delivery_status_v1") {
        if (transitionResults.length > 0) {
          return { data: transitionResults.shift(), error: null };
        }
        return { data: { status: "success", from: "ready", to: "in_transit" }, error: null };
      }
      return { data: null, error: { message: `unknown rpc: ${name}` } };
    },
  };
}

// ── Setup / teardown ────────────────────────────────────────────────────────

let restoreOrders: () => void;
let restoreParcels: () => void;
let restoreDeliveries: () => void;

beforeEach(async () => {
  mockOrders = [];
  mockParcels = [];
  mockDeliveries = [];
  transitionResults = [];

  const testDb = makeMockDb();

  const ordersRepo = await import("../server/orders/repository");
  restoreOrders = ordersRepo.setOrderRepositoryDbForTests(testDb);

  const parcelsRepo = await import("../server/parcels/repository");
  restoreParcels = parcelsRepo.setParcelRepositoryDbForTests(testDb);

  const deliveriesRepo = await import("../server/deliveries/repository");
  restoreDeliveries = deliveriesRepo.setDeliveryRepositoryDbForTests(testDb);
});

afterEach(() => {
  restoreOrders();
  restoreParcels();
  restoreDeliveries();
});

// ── 1. Successful handoff ────────────────────────────────────────────────────

describe("successful handoff", () => {
  it("transitions delivery from ready to in_transit", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.handoff.parcelCode).toBe(PARCEL_CODE);
      expect(result.handoff.orderNumber).toBe("APSA-2026-000001");
      expect(result.handoff.deliveryId).toBe(DELIVERY_ID);
      expect(result.handoff.providerName).toBe("Flash Express");
      expect(result.handoff.externalTrackingNumber).toBe("TRK-001");
      expect(result.handoff.handedOffAt).toBeDefined();
    }
  });

  it("returns preview with eligible=true when delivery is ready", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(mockCtx(ORG_A), PARCEL_CODE);

    expect(preview).not.toBeNull();
    expect(preview!.eligible).toBe(true);
    expect(preview!.reason).toBeNull();
    expect(preview!.deliveryStatus).toBe("ready");
    expect(preview!.providerName).toBe("Flash Express");
  });
});

// ── 2. Duplicate handoff ─────────────────────────────────────────────────────

describe("duplicate handoff", () => {
  it("rejects when delivery is already in_transit", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [{ ...makeReadyDelivery(), status: "in_transit" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("already_handed_off");
  });

  it("returns already_handed_off when concurrent transition wins", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];
    transitionResults = [{ status: "stale", current: "in_transit" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("already_handed_off");
  });

  it("preview shows already handed off for in_transit delivery", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [{ ...makeReadyDelivery(), status: "in_transit" }];

    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(mockCtx(ORG_A), PARCEL_CODE);

    expect(preview!.eligible).toBe(false);
    expect(preview!.reason).toContain("already been handed off");
  });
});

// ── 3. Wrong parcel ──────────────────────────────────────────────────────────

describe("wrong parcel", () => {
  it("returns parcel_not_found for non-existent parcel code", async () => {
    mockParcels = [];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), "APSA:PCL:v1:nonexistent");

    expect(result.kind).toBe("parcel_not_found");
  });

  it("returns parcel_voided for voided parcel", async () => {
    mockParcels = [{ ...makeParcel(), status: "void" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("parcel_voided");
  });

  it("preview returns null for non-existent parcel", async () => {
    mockParcels = [];

    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(mockCtx(ORG_A), "APSA:PCL:v1:nonexistent");

    expect(preview).toBeNull();
  });
});

// ── 4. Wrong order ───────────────────────────────────────────────────────────

describe("wrong order", () => {
  it("rejects when order is not confirmed (draft)", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), lifecycle_status: "draft" }];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("order_not_confirmed");
  });

  it("rejects when order is cancelled", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), lifecycle_status: "cancelled" }];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("order_not_confirmed");
  });

  it("rejects when order is completed", async () => {
    mockOrders = [{ ...makeConfirmedOrder(), lifecycle_status: "completed" }];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("order_not_confirmed");
  });
});

// ── 5. Permission denial ────────────────────────────────────────────────────

describe("permission denial", () => {
  it("throws ForbiddenError without delivery.handoff", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];

    const { confirmHandoff } = await import("../server/handoff/service");
    await expect(confirmHandoff(mockCtx(ORG_A, []), PARCEL_CODE)).rejects.toThrow(
      "Missing permission: delivery.handoff",
    );
  });

  it("preview throws ForbiddenError without delivery.handoff", async () => {
    const { getHandoffPreview } = await import("../server/handoff/service");
    await expect(getHandoffPreview(mockCtx(ORG_A, []), PARCEL_CODE)).rejects.toThrow(
      "Missing permission: delivery.handoff",
    );
  });

  it("having orders.read alone is not enough — delivery.handoff is required", async () => {
    const { confirmHandoff } = await import("../server/handoff/service");
    await expect(confirmHandoff(mockCtx(ORG_A, ["orders.read"]), PARCEL_CODE)).rejects.toThrow(
      "Missing permission: delivery.handoff",
    );
  });
});

// ── 6. Cross-org denial ──────────────────────────────────────────────────────

describe("cross-org denial", () => {
  it("returns parcel_not_found when parcel belongs to different org", async () => {
    mockParcels = [makeParcel(ORG_B)];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("parcel_not_found");
  });

  it("preview returns null when parcel belongs to different org", async () => {
    mockParcels = [makeParcel(ORG_B)];

    const { getHandoffPreview } = await import("../server/handoff/service");
    const preview = await getHandoffPreview(mockCtx(ORG_A), PARCEL_CODE);

    expect(preview).toBeNull();
  });
});

// ── 7. Lifecycle enforcement ────────────────────────────────────────────────

describe("lifecycle enforcement", () => {
  it("rejects when delivery is pending", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [{ ...makeReadyDelivery(), status: "pending" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("delivery_not_ready");
    if (result.kind === "delivery_not_ready") {
      expect(result.currentStatus).toBe("pending");
    }
  });

  it("rejects when delivery is preparing", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [{ ...makeReadyDelivery(), status: "preparing" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("delivery_not_ready");
    if (result.kind === "delivery_not_ready") {
      expect(result.currentStatus).toBe("preparing");
    }
  });

  it("returns no_active_delivery when no delivery exists", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("no_active_delivery");
  });

  it("returns transition_failed when RPC returns unexpected error", async () => {
    mockOrders = [makeConfirmedOrder()];
    mockParcels = [makeParcel()];
    mockDeliveries = [makeReadyDelivery()];
    transitionResults = [{ status: "order_terminal" }];

    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A), PARCEL_CODE);

    expect(result.kind).toBe("transition_failed");
  });
});

// ── 8. Client-side display predicates ───────────────────────────────────────

describe("client display predicates", () => {
  function preview(overrides: Partial<HandoffPreview> = {}): HandoffPreview {
    return {
      parcelId: "parcel-1",
      parcelCode: PARCEL_CODE,
      orderId: ORDER_ID,
      orderNumber: "APSA-2026-000001",
      deliveryId: DELIVERY_ID,
      deliveryStatus: "ready",
      providerName: "Flash Express",
      externalTrackingNumber: "TRK-001",
      eligible: true,
      reason: null,
      ...overrides,
    };
  }

  it("canConfirmHandoff is true only when eligible and delivery is ready", () => {
    expect(canConfirmHandoff(preview())).toBe(true);
    expect(canConfirmHandoff(preview({ eligible: false }))).toBe(false);
    expect(canConfirmHandoff(preview({ deliveryStatus: "pending" }))).toBe(false);
    expect(canConfirmHandoff(preview({ eligible: true, deliveryStatus: "preparing" }))).toBe(false);
  });

  it("isAlreadyHandedOff detects in_transit and delivered", () => {
    expect(isAlreadyHandedOff(preview({ deliveryStatus: "in_transit" }))).toBe(true);
    expect(isAlreadyHandedOff(preview({ deliveryStatus: "delivered" }))).toBe(true);
    expect(isAlreadyHandedOff(preview({ deliveryStatus: "ready" }))).toBe(false);
    expect(isAlreadyHandedOff(preview({ deliveryStatus: "pending" }))).toBe(false);
  });

  it("handoffErrorMessage returns null for success", () => {
    const result: HandoffResult = {
      kind: "success",
      handoff: {
        parcelId: "p-1",
        parcelCode: PARCEL_CODE,
        orderId: ORDER_ID,
        orderNumber: "APSA-2026-000001",
        deliveryId: DELIVERY_ID,
        providerName: "Flash Express",
        externalTrackingNumber: null,
        handedOffAt: "2026-01-01T00:00:00Z",
      },
    };
    expect(handoffErrorMessage(result)).toBeNull();
  });

  it("handoffErrorMessage returns messages for each failure kind", () => {
    expect(handoffErrorMessage({ kind: "parcel_not_found" })).toContain("not found");
    expect(handoffErrorMessage({ kind: "parcel_voided" })).toContain("voided");
    expect(handoffErrorMessage({ kind: "no_active_delivery" })).toContain("No active delivery");
    expect(handoffErrorMessage({ kind: "already_handed_off" })).toContain("already");
    expect(handoffErrorMessage({ kind: "order_not_confirmed" })).toContain("not in a confirmed");
    expect(
      handoffErrorMessage({ kind: "delivery_not_ready", currentStatus: "pending" }),
    ).toContain("pending");
    expect(handoffErrorMessage({ kind: "transition_failed", reason: "stale" })).toContain("stale");
  });
});

// ── 9. i18n completeness ────────────────────────────────────────────────────

describe("i18n keys for courier handoff", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

  const en = JSON.parse(read("src/locales/en.json")) as Record<string, unknown>;
  const km = JSON.parse(read("src/locales/km.json")) as Record<string, unknown>;

  const lookup = (bundle: Record<string, unknown>, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        bundle,
      );

  const REQUIRED_KEYS = [
    "courierHandoff.title",
    "courierHandoff.subtitle",
    "courierHandoff.parcel",
    "courierHandoff.parcelCode",
    "courierHandoff.order",
    "courierHandoff.orderNumber",
    "courierHandoff.courier",
    "courierHandoff.providerName",
    "courierHandoff.trackingNumber",
    "courierHandoff.deliveryStatus",
    "courierHandoff.handoffTime",
    "courierHandoff.handoffStatus",
    "courierHandoff.eligible",
    "courierHandoff.notEligible",
    "courierHandoff.alreadyHandedOff",
    "courierHandoff.confirm",
    "courierHandoff.confirming",
    "courierHandoff.success.title",
    "courierHandoff.success.body",
    "courierHandoff.notFound.title",
    "courierHandoff.notFound.body",
    "courierHandoff.error.title",
    "courierHandoff.error.body",
    "courierHandoff.denied.title",
    "courierHandoff.denied.body",
    "courierHandoff.voided.title",
    "courierHandoff.voided.body",
    "courierHandoff.noDelivery.title",
    "courierHandoff.noDelivery.body",
    "courierHandoff.deliveryNotReady.title",
    "courierHandoff.deliveryNotReady.body",
    "courierHandoff.orderNotConfirmed.title",
    "courierHandoff.orderNotConfirmed.body",
    "courierHandoff.duplicateHandoff.title",
    "courierHandoff.duplicateHandoff.body",
    "courierHandoff.viewOrder",
    "courierHandoff.viewDelivery",
    "courierHandoff.done",
  ];

  it("every required key exists in English", () => {
    for (const key of REQUIRED_KEYS) {
      expect(`${key}:en=${typeof lookup(en, key)}`).toBe(`${key}:en=string`);
    }
  });

  it("every required key exists in Khmer", () => {
    for (const key of REQUIRED_KEYS) {
      expect(`${key}:km=${typeof lookup(km, key)}`).toBe(`${key}:km=string`);
    }
  });

  it("Khmer keys are not empty strings", () => {
    for (const key of REQUIRED_KEYS) {
      const val = String(lookup(km, key)).trim();
      expect(`${key}:empty=${val === ""}`).toBe(`${key}:empty=false`);
    }
  });
});

// ── 10. UI capability declaration ────────────────────────────────────────────

describe("delivery.handoff is declared in UI capabilities", () => {
  it("is a known UI permission key", async () => {
    const { isUiPermissionKey } = await import("../lib/capabilities");
    expect(isUiPermissionKey("delivery.handoff")).toBe(true);
  });
});

// ── 11. Migration declares the permission ────────────────────────────────────

describe("migration 051 declares delivery.handoff", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const migration = fs.readFileSync(
    path.join(repoRoot, "supabase/migrations/051_courier_handoff_permission.sql"),
    "utf8",
  );

  it("inserts the delivery.handoff permission", () => {
    expect(migration).toContain("'delivery.handoff'");
  });

  it("grants to OWNER, MANAGER, CASHIER, SALES", () => {
    expect(migration).toContain("v_owner_id");
    expect(migration).toContain("v_manager_id");
    expect(migration).toContain("v_cashier_id");
    expect(migration).toContain("v_sales_id");
  });

  it("does not grant to CUSTOMER_SERVICE", () => {
    expect(migration).not.toContain("system_role = 'CUSTOMER_SERVICE'");
  });
});

// ── 12. Server service enforces delivery.handoff, not delivery.update ───────

describe("handoff requires delivery.handoff, not delivery.update", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const source = fs.readFileSync(
    path.join(repoRoot, "src/server/handoff/service.ts"),
    "utf8",
  );

  it("the service requires delivery.handoff", () => {
    expect(source).toContain('ctx.require("delivery.handoff")');
  });

  it("the service does not require delivery.update", () => {
    expect(source).not.toContain('ctx.require("delivery.update")');
  });
});
