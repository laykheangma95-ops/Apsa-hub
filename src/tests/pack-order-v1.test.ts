/**
 * Pack Order V1 — the single warehouse action (no separate Picking step).
 *
 * Covers the V1 fulfillment simplification end to end at the domain and
 * service boundary:
 *   - Pack using a product barcode, an APSA variant QR, and a camera-decoded code
 *   - Manual confirmation, and mixed barcode + manual packing
 *   - Wrong product, wrong variant, duplicate scan
 *   - Quantity completion ("2 / 5 packed" … "5 / 5 packed")
 *   - Mark Packed enabled only when complete — on the client AND re-validated
 *     by the server
 *   - Packing never requires a delivery: pack without delivery, pack then
 *     arrange delivery, pack then courier handoff, and the Order detail action
 *     order (print label → pack → arrange delivery → courier handoff)
 *
 * Run: bun test src/tests/pack-order-v1.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createPackSession,
  computePackProgress,
  applyServerProductAccepted,
  resolveAcceptedLine,
  confirmLineManually,
  canMarkPacked,
  buildPackedLines,
  filterPackLines,
  isPackedDeliveryStatus,
  isOrderPackedFromHistory,
  fulfillmentActions,
  packHistoryReasonMessage,
  PACK_ORDER_PACKED_REASON_CODE,
  type PackRequirement,
  type PackSession,
} from "../lib/pack";
import { classifyScan } from "../lib/barcode/scan-router";
import { normalizeScannedCode } from "../lib/barcode/camera-scan";
import { variantQrPayload } from "../lib/barcode/payload";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = "org-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_B = "org-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORDER_ID = "order-1111-1111-1111-111111111111";
const PARCEL_CODE = "APSA:PCL:v1:abcdefghijklmnopqrstuv";

const VAR_SHIRT_L = "11111111-1111-4111-8111-111111111111";
const VAR_SHIRT_M = "22222222-2222-4222-8222-222222222222";
const VAR_MUG = "33333333-3333-4333-8333-333333333333";
const VAR_STRANGER = "44444444-4444-4444-8444-444444444444";

const SHIRT_L_BARCODE = "4006381333931"; // EAN-13
const SHIRT_M_BARCODE = "4006381333948";
const UPC_A_ITEM = "012345678905"; // stored as UPC-A, scanned as EAN-13 by some scanners

function req(overrides: Partial<PackRequirement> = {}): PackRequirement {
  return {
    orderItemId: "item-shirt",
    productId: "prod-shirt",
    variantId: VAR_SHIRT_L,
    productName: "Shirt",
    variantName: "L",
    sku: "SHIRT-L",
    barcode: SHIRT_L_BARCODE,
    quantityRequired: 3,
    siblingBarcodes: [SHIRT_M_BARCODE],
    ...overrides,
  };
}

/** Shirt ×3 (barcoded) + Mug ×2 (no barcode) = 5 units. */
function fiveUnitSession(): PackSession {
  return createPackSession(ORDER_ID, "APSA-2026-000001", PARCEL_CODE, [
    req(),
    req({
      orderItemId: "item-mug",
      productId: "prod-mug",
      variantId: VAR_MUG,
      productName: "Mug",
      variantName: null,
      sku: "MUG",
      barcode: null,
      quantityRequired: 2,
      siblingBarcodes: [],
    }),
  ]);
}

/** Apply a server "accepted" verdict exactly as the Pack Order screen does. */
function applyScanAccepted(session: PackSession, variantId: string): PackSession | "duplicate" {
  const line = resolveAcceptedLine(session, variantId);
  if (line === null) return "duplicate";
  return applyServerProductAccepted(session, { orderItemId: line, variantId });
}

// ── Mocked repositories (service-level tests) ───────────────────────────────

let mockOrders: any[] = [];
let mockParcels: any[] = [];
let mockOrderItems: any[] = [];
let mockVariants: any[] = [];
let mockDeliveries: any[] = [];
let mockOrderHistory: any[] = [];
let mockDeliveryHistory: any[] = [];
let rpcCalls: { fn: string; args: any }[] = [];
let rpcResponder: (fn: string, args: any) => any = () => ({ status: "success" });

function makeChain(rows: any[]) {
  const filters: Record<string, any> = {};
  const neqFilters: Record<string, any> = {};
  const inFilters: Record<string, any[]> = {};
  const filtered = () =>
    rows.filter((row) => {
      for (const [col, val] of Object.entries(filters)) if (row[col] !== val) return false;
      for (const [col, val] of Object.entries(neqFilters)) if (row[col] === val) return false;
      for (const [col, vals] of Object.entries(inFilters))
        if (!vals.includes(row[col])) return false;
      return true;
    });
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
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    maybeSingle() {
      return { data: filtered()[0] ?? null, error: null };
    },
    single() {
      const r = filtered();
      return r.length === 0
        ? { data: null, error: { code: "PGRST116", message: "no row" } }
        : { data: r[0], error: null };
    },
    then(resolve: any) {
      resolve({ data: filtered(), error: null });
    },
  };
  return chain;
}

function makeMockDb() {
  const tables: Record<string, () => any[]> = {
    orders: () => mockOrders,
    parcels: () => mockParcels,
    order_items: () => mockOrderItems,
    product_variants: () => mockVariants,
    deliveries: () => mockDeliveries,
    order_status_history: () => mockOrderHistory,
    delivery_status_history: () => mockDeliveryHistory,
  };
  return {
    from(table: string) {
      return { select: () => makeChain(tables[table]?.() ?? []) };
    },
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      return { data: rpcResponder(fn, args), error: null };
    },
  };
}

function mockCtx(orgId: string, permissions: string[] = ["orders.read", "delivery.handoff"]) {
  const perms = new Set(permissions);
  return {
    organizationId: orgId,
    userId: "user-packer",
    can: (p: string) => perms.has(p),
    require(p: string) {
      if (!perms.has(p)) {
        const err = new Error(`Missing permission: ${p}`);
        (err as any).statusCode = 403;
        throw err;
      }
    },
  } as any;
}

function seedOrder(orgId: string = ORG_A) {
  mockOrders = [
    {
      id: ORDER_ID,
      organization_id: orgId,
      order_number: "APSA-2026-000001",
      lifecycle_status: "confirmed",
      fulfillment_status: "unfulfilled",
    },
  ];
  mockParcels = [
    {
      id: "parcel-1",
      organization_id: orgId,
      order_id: ORDER_ID,
      parcel_code: PARCEL_CODE,
      status: "created",
    },
  ];
  mockOrderItems = [
    {
      id: "item-shirt",
      organization_id: orgId,
      order_id: ORDER_ID,
      product_id: "prod-shirt",
      variant_id: VAR_SHIRT_L,
      product_name_snapshot: "Shirt",
      variant_name_snapshot: "L",
      sku_snapshot: "SHIRT-L",
      quantity: 3,
    },
    {
      id: "item-mug",
      organization_id: orgId,
      order_id: ORDER_ID,
      product_id: "prod-mug",
      variant_id: VAR_MUG,
      product_name_snapshot: "Mug",
      variant_name_snapshot: null,
      sku_snapshot: "MUG",
      quantity: 2,
    },
  ];
  mockVariants = [
    {
      id: VAR_SHIRT_L,
      product_id: "prod-shirt",
      barcode: SHIRT_L_BARCODE,
      organization_id: orgId,
      status: "ACTIVE",
    },
    {
      id: VAR_SHIRT_M,
      product_id: "prod-shirt",
      barcode: SHIRT_M_BARCODE,
      organization_id: orgId,
      status: "ACTIVE",
    },
    {
      id: VAR_MUG,
      product_id: "prod-mug",
      barcode: null,
      organization_id: orgId,
      status: "ACTIVE",
    },
  ];
}

function seedDelivery(status: string, orgId: string = ORG_A) {
  mockDeliveries = [{ id: "delivery-1", organization_id: orgId, order_id: ORDER_ID, status }];
}

const COMPLETE_LINES = [
  { orderItemId: "item-shirt", quantity: 3 },
  { orderItemId: "item-mug", quantity: 2 },
];

const restores: (() => void)[] = [];

beforeEach(async () => {
  mockOrders = [];
  mockParcels = [];
  mockOrderItems = [];
  mockVariants = [];
  mockDeliveries = [];
  mockOrderHistory = [];
  mockDeliveryHistory = [];
  rpcCalls = [];
  rpcResponder = () => ({ status: "success" });
  const db = makeMockDb();
  restores.push(
    (await import("../server/orders/repository")).setOrderRepositoryDbForTests(db),
    (await import("../server/parcels/repository")).setParcelRepositoryDbForTests(db),
    (await import("../server/products/repository")).setProductRepositoryDbForTests(db),
    (await import("../server/deliveries/repository")).setDeliveryRepositoryDbForTests(db),
  );
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

// ── Scan routing (shared APSA scan router) ──────────────────────────────────

describe("Pack Order reuses the APSA scan router", () => {
  it("routes a parcel label, a variant QR and a retail barcode to different handlers", () => {
    expect(classifyScan(PARCEL_CODE).kind).toBe("apsa-parcel");
    expect(classifyScan(variantQrPayload(VAR_SHIRT_L)).kind).toBe("apsa-variant");
    expect(classifyScan(SHIRT_L_BARCODE).kind).toBe("product-barcode");
  });
});

// ── Pack using barcode / QR / camera ────────────────────────────────────────

describe("pack using barcode", () => {
  it("server accepts the ordered variant's barcode", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, SHIRT_L_BARCODE);
    expect(result).toEqual({
      kind: "accepted",
      orderItemId: "item-shirt",
      variantId: VAR_SHIRT_L,
      productName: "Shirt",
    });
  });

  it("matches a UPC-A barcode scanned in its EAN-13 form", async () => {
    seedOrder();
    mockVariants[0].barcode = UPC_A_ITEM;
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, "0" + UPC_A_ITEM);
    expect(result.kind).toBe("accepted");
  });
});

describe("pack using QR code", () => {
  it("server accepts the APSA variant QR of an ordered variant", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      variantQrPayload(VAR_SHIRT_L),
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.orderItemId).toBe("item-shirt");
  });

  it("a QR works for a product that has no barcode at all", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      variantQrPayload(VAR_MUG),
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") expect(result.orderItemId).toBe("item-mug");
  });
});

describe("pack using camera", () => {
  it("a camera-decoded value with scanner artifacts is normalized and accepted", async () => {
    seedOrder();
    const decoded = normalizeScannedCode(`  ${SHIRT_L_BARCODE}\r\n`);
    expect(decoded).toBe(SHIRT_L_BARCODE);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, decoded!);
    expect(result.kind).toBe("accepted");
  });

  it("the server normalizes too, so a raw camera string with a GS separator still matches", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      `\u001d${SHIRT_L_BARCODE} `,
    );
    expect(result.kind).toBe("accepted");
  });
});

// ── Wrong product / wrong variant ───────────────────────────────────────────

describe("wrong product", () => {
  it("rejects a barcode not in the order", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, "9999999999999");
    expect(result.kind).toBe("wrong_product");
  });

  it("rejects a variant QR from an unrelated product", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      variantQrPayload(VAR_STRANGER),
    );
    expect(result.kind).toBe("wrong_product");
  });

  it("an order QR is never counted as a product", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      "apsa:order/55555555-5555-4555-8555-555555555555",
    );
    expect(result.kind).toBe("wrong_product");
  });

  it("another organization's order yields invalid_order, never a match", async () => {
    seedOrder(ORG_B);
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, SHIRT_L_BARCODE);
    expect(result.kind).toBe("invalid_order");
  });
});

describe("wrong variant", () => {
  it("rejects the sibling variant's barcode", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(mockCtx(ORG_A), ORDER_ID, SHIRT_M_BARCODE);
    expect(result.kind).toBe("wrong_variant");
    if (result.kind === "wrong_variant") expect(result.expectedVariantName).toBe("L");
  });

  it("rejects the sibling variant's QR", async () => {
    seedOrder();
    const { validatePackProductScan } = await import("../server/packing/service");
    const result = await validatePackProductScan(
      mockCtx(ORG_A),
      ORDER_ID,
      variantQrPayload(VAR_SHIRT_M),
    );
    expect(result.kind).toBe("wrong_variant");
  });
});

// ── Manual confirmation, mixed, duplicate, completion ───────────────────────

describe("manual confirmation", () => {
  it("confirms one unit of a no-barcode line", () => {
    const { session, result } = confirmLineManually(fiveUnitSession(), "item-mug");
    expect(result.kind).toBe("accepted");
    expect(computePackProgress(session).totalPacked).toBe(1);
    expect(session.packed[0]!.method).toBe("manual");
  });

  it("refuses to exceed the line quantity", () => {
    let s = fiveUnitSession();
    s = confirmLineManually(s, "item-mug").session;
    s = confirmLineManually(s, "item-mug").session;
    const third = confirmLineManually(s, "item-mug");
    expect(third.result.kind).toBe("duplicate_scan");
    expect(third.session).toBe(s);
  });

  it("ignores a line that is not in the order", () => {
    const s = fiveUnitSession();
    const out = confirmLineManually(s, "item-ghost");
    expect(out.result.kind).toBe("unknown_line");
    expect(out.session).toBe(s);
  });
});

describe("mixed barcode / manual", () => {
  it("scanned and manually confirmed units add up to one progress count", () => {
    let s = fiveUnitSession();
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    s = confirmLineManually(s, "item-mug").session;
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    const p = computePackProgress(s);
    expect(p.totalPacked).toBe(3);
    expect(p.totalRequired).toBe(5);
    expect(s.packed.map((x) => x.method)).toEqual(["scan", "manual", "scan"]);
  });
});

describe("duplicate scan", () => {
  it("a scan beyond the line quantity is reported as duplicate and not counted", () => {
    let s = fiveUnitSession();
    for (let i = 0; i < 3; i++) s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    expect(applyScanAccepted(s, VAR_SHIRT_L)).toBe("duplicate");
    expect(computePackProgress(s).totalPacked).toBe(3);
  });

  it("the same variant on two lines fills the second line instead of reporting duplicate", () => {
    let s = createPackSession(ORDER_ID, "N", PARCEL_CODE, [
      req({ orderItemId: "line-a", quantityRequired: 1 }),
      req({ orderItemId: "line-b", quantityRequired: 1 }),
    ]);
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    const lines = computePackProgress(s).lines;
    expect(lines.map((l) => l.quantityPacked)).toEqual([1, 1]);
    expect(applyScanAccepted(s, VAR_SHIRT_L)).toBe("duplicate");
  });
});

describe("quantity completion", () => {
  it("progresses 2/5 → 4/5 → 5/5 and only then enables Mark Packed", () => {
    let s = fiveUnitSession();
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    expect(computePackProgress(s).totalPacked).toBe(2);
    expect(canMarkPacked(s)).toBe(false);

    s = applyScanAccepted(s, VAR_SHIRT_L) as PackSession;
    s = confirmLineManually(s, "item-mug").session;
    expect(computePackProgress(s).totalPacked).toBe(4);
    expect(canMarkPacked(s)).toBe(false);

    s = confirmLineManually(s, "item-mug").session;
    const p = computePackProgress(s);
    expect(p.totalPacked).toBe(5);
    expect(p.isComplete).toBe(true);
    expect(canMarkPacked(s)).toBe(true);
    expect(buildPackedLines(s)).toEqual(COMPLETE_LINES);
  });

  it("an order with no lines can never be marked packed", () => {
    expect(canMarkPacked(createPackSession(ORDER_ID, "N", PARCEL_CODE, []))).toBe(false);
  });
});

describe("manual search", () => {
  it("filters lines by name, SKU or barcode, case-insensitively", () => {
    const lines = computePackProgress(fiveUnitSession()).lines;
    expect(filterPackLines(lines, "mug").map((l) => l.orderItemId)).toEqual(["item-mug"]);
    expect(filterPackLines(lines, "shirt-l").map((l) => l.orderItemId)).toEqual(["item-shirt"]);
    expect(filterPackLines(lines, "333931").map((l) => l.orderItemId)).toEqual(["item-shirt"]);
    expect(filterPackLines(lines, "  ")).toHaveLength(2);
    expect(filterPackLines(lines, "nothing")).toHaveLength(0);
  });
});

// ── Mark Packed (server-authoritative) ──────────────────────────────────────

describe("markOrderPacked — server re-validates completion", () => {
  it("moves a pending delivery to ready via preparing, recording the reason", async () => {
    seedOrder();
    seedDelivery("pending");
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result).toEqual({ kind: "packed", deliveryId: "delivery-1" });
    expect(rpcCalls.map((c) => [c.args.p_expected_from, c.args.p_to])).toEqual([
      ["pending", "preparing"],
      ["preparing", "ready"],
    ]);
    for (const call of rpcCalls) {
      expect(call.fn).toBe("transition_delivery_status_v1");
      expect(call.args.p_organization_id).toBe(ORG_A);
      expect(call.args.p_changed_by).toBe("user-packer");
      expect(call.args.p_reason).toBe(PACK_ORDER_PACKED_REASON_CODE);
    }
  });

  it("moves a preparing delivery straight to ready", async () => {
    seedOrder();
    seedDelivery("preparing");
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result.kind).toBe("packed");
    expect(rpcCalls).toHaveLength(1);
  });

  it("is idempotent once the delivery is ready (no transition attempted)", async () => {
    seedOrder();
    seedDelivery("ready");
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result.kind).toBe("already_packed");
    expect(rpcCalls).toHaveLength(0);
    expect(isPackedDeliveryStatus("ready")).toBe(true);
    expect(isPackedDeliveryStatus("in_transit")).toBe(true);
    expect(isPackedDeliveryStatus("pending")).toBe(false);
  });

  it("a concurrent pack that already reached ready reports already_packed", async () => {
    seedOrder();
    seedDelivery("preparing");
    rpcResponder = () => ({ status: "stale", current: "ready" });
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result.kind).toBe("already_packed");
  });

  it("rejects an incomplete pack — Mark Packed cannot be forced by the client", async () => {
    seedOrder();
    seedDelivery("pending");
    const { markOrderPacked } = await import("../server/packing/service");
    const partial = [
      { orderItemId: "item-shirt", quantity: 3 },
      { orderItemId: "item-mug", quantity: 1 },
    ];
    expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, partial)).kind).toBe("incomplete");
    expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES.slice(0, 1))).kind).toBe(
      "incomplete",
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects over-counted, duplicated or foreign lines", async () => {
    seedOrder();
    seedDelivery("pending");
    const { markOrderPacked } = await import("../server/packing/service");
    const cases = [
      [
        { orderItemId: "item-shirt", quantity: 4 },
        { orderItemId: "item-mug", quantity: 2 },
      ],
      [...COMPLETE_LINES, { orderItemId: "item-shirt", quantity: 3 }],
      [...COMPLETE_LINES, { orderItemId: "item-other-order", quantity: 1 }],
    ];
    for (const lines of cases) {
      expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, lines)).kind).toBe("incomplete");
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("requires the parcel label (parcel identity) to exist", async () => {
    seedOrder();
    seedDelivery("pending");
    mockParcels = [];
    const { markOrderPacked } = await import("../server/packing/service");
    expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES)).kind).toBe(
      "no_parcel",
    );
  });

  it("requires delivery.handoff", async () => {
    seedOrder();
    seedDelivery("pending");
    const { markOrderPacked } = await import("../server/packing/service");
    await expect(
      markOrderPacked(mockCtx(ORG_A, ["orders.read"]), ORDER_ID, COMPLETE_LINES),
    ).rejects.toThrow("delivery.handoff");
    expect(rpcCalls).toHaveLength(0);
  });

  it("cannot mark another organization's order packed", async () => {
    seedOrder(ORG_B);
    seedDelivery("pending", ORG_B);
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result.kind).toBe("invalid_order");
    expect(rpcCalls).toHaveLength(0);
  });

  it("getPackRequirements reports the delivery status so the screen knows it is packed", async () => {
    seedOrder();
    seedDelivery("ready");
    const { getPackRequirements } = await import("../server/packing/service");
    const result = await getPackRequirements(mockCtx(ORG_A), ORDER_ID);
    expect(result?.deliveryStatus).toBe("ready");
    expect(result?.requirements.find((r) => r.orderItemId === "item-mug")?.barcode).toBeNull();
  });
});

// ── V1 workflow: packing never requires a delivery ──────────────────────────

/**
 * Stateful RPC double: applies each transition to the mocked rows and appends
 * the history row the real RPC writes in the same transaction, so a test can
 * walk pack → arrange delivery → courier handoff end to end.
 */
function statefulRpc(fn: string, args: any): any {
  const org = args.p_organization_id;
  if (fn === "transition_order_status_v1") {
    const order = mockOrders.find((o) => o.id === args.p_order_id && o.organization_id === org);
    if (!order) return { status: "not_found" };
    const field = `${args.p_axis}_status`;
    if (order[field] !== args.p_expected_from) return { status: "stale", current: order[field] };
    order[field] = args.p_to;
    mockOrderHistory.push({
      id: `oh-${mockOrderHistory.length + 1}`,
      organization_id: org,
      order_id: order.id,
      axis: args.p_axis,
      from_status: args.p_expected_from,
      to_status: args.p_to,
      changed_by: args.p_changed_by,
      reason: args.p_reason,
      changed_at: new Date().toISOString(),
    });
    return { status: "success" };
  }
  if (fn === "transition_delivery_status_v1") {
    const delivery = mockDeliveries.find(
      (d) => d.id === args.p_delivery_id && d.organization_id === org,
    );
    if (!delivery) return { status: "not_found" };
    if (delivery.status !== args.p_expected_from) {
      return { status: "stale", current: delivery.status };
    }
    delivery.status = args.p_to;
    mockDeliveryHistory.push({
      id: `dh-${mockDeliveryHistory.length + 1}`,
      organization_id: org,
      delivery_id: delivery.id,
      from_status: args.p_expected_from,
      to_status: args.p_to,
      changed_by: args.p_changed_by,
      reason: args.p_reason,
      created_at: new Date().toISOString(),
    });
    const order = mockOrders.find((o) => o.id === delivery.order_id);
    if (order && ["preparing", "ready", "in_transit"].includes(args.p_to)) {
      order.fulfillment_status = "processing";
    }
    return { status: "success", from: args.p_expected_from, to: args.p_to };
  }
  if (fn === "create_delivery_v1") {
    const id = `delivery-${mockDeliveries.length + 1}`;
    mockDeliveries.push({
      id,
      organization_id: org,
      order_id: args.p_order_id,
      location_id: null,
      provider_id: null,
      provider_key: null,
      provider_name: args.p_provider_name,
      external_tracking_number: null,
      cod_amount_minor: null,
      cod_currency: null,
      status: "pending",
      created_by: args.p_created_by,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    mockDeliveryHistory.push({
      id: `dh-${mockDeliveryHistory.length + 1}`,
      organization_id: org,
      delivery_id: id,
      from_status: null,
      to_status: "pending",
      changed_by: args.p_created_by,
      reason: "Delivery created",
      created_at: new Date().toISOString(),
    });
    const order = mockOrders.find((o) => o.id === args.p_order_id);
    if (order?.fulfillment_status === "unfulfilled") order.fulfillment_status = "processing";
    return { status: "success", delivery_id: id };
  }
  return { status: "success" };
}

const HANDOFF_PERMS = ["orders.read", "delivery.handoff", "delivery.create", "delivery.update"];

describe("pack without delivery", () => {
  it("Mark Packed succeeds with no delivery arranged and creates none", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result).toEqual({ kind: "packed", deliveryId: null });
    // Fulfillment state only — no delivery created, assigned, started or handed off.
    expect(mockDeliveries).toHaveLength(0);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["transition_order_status_v1"]);
    expect(rpcCalls[0]!.args).toMatchObject({
      p_organization_id: ORG_A,
      p_axis: "fulfillment",
      p_expected_from: "unfulfilled",
      p_to: "processing",
      p_changed_by: "user-packer",
      p_reason: PACK_ORDER_PACKED_REASON_CODE,
    });
  });

  it("print label → pack → packed, all before any delivery exists", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { getPackRequirements, markOrderPacked, getOrderPackState } =
      await import("../server/packing/service");
    const before = await getPackRequirements(mockCtx(ORG_A), ORDER_ID);
    expect(before?.deliveryStatus).toBeNull();
    expect(before?.packed).toBe(false);

    await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);

    const after = await getPackRequirements(mockCtx(ORG_A), ORDER_ID);
    expect(after?.packed).toBe(true);
    expect(await getOrderPackState(mockCtx(ORG_A), ORDER_ID)).toEqual({
      packed: true,
      parcelCode: PARCEL_CODE,
    });
  });

  it("is idempotent: a second Mark Packed reports already_packed and writes nothing", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { markOrderPacked } = await import("../server/packing/service");
    await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    rpcCalls = [];
    const again = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(again).toEqual({ kind: "already_packed", deliveryId: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it("an order already 'processing' with no delivery still records the packed marker", async () => {
    seedOrder();
    mockOrders[0].fulfillment_status = "processing";
    rpcResponder = statefulRpc;
    const { markOrderPacked, getOrderPackState } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result.kind).toBe("packed");
    expect(mockOrders[0].fulfillment_status).toBe("processing");
    expect(mockOrderHistory.every((h) => h.reason === PACK_ORDER_PACKED_REASON_CODE)).toBe(true);
    expect((await getOrderPackState(mockCtx(ORG_A), ORDER_ID))?.packed).toBe(true);
    expect(mockDeliveries).toHaveLength(0);
  });

  it("a failed order transition is reported, never silently treated as packed", async () => {
    seedOrder();
    rpcResponder = () => ({ status: "stale", current: "cancelled" });
    const { markOrderPacked } = await import("../server/packing/service");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result).toEqual({ kind: "transition_failed", reason: "stale" });
  });

  it("still requires the parcel label and a complete pack", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { markOrderPacked } = await import("../server/packing/service");
    expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES.slice(0, 1))).kind).toBe(
      "incomplete",
    );
    mockParcels = [];
    expect((await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES)).kind).toBe(
      "no_parcel",
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("the packed state of another organization's order is never disclosed", async () => {
    seedOrder(ORG_B);
    rpcResponder = statefulRpc;
    const { getOrderPackState } = await import("../server/packing/service");
    expect(await getOrderPackState(mockCtx(ORG_A), ORDER_ID)).toBeNull();
  });

  it("the parcel code is only returned to members who may hand off", async () => {
    seedOrder();
    const { getOrderPackState } = await import("../server/packing/service");
    const state = await getOrderPackState(mockCtx(ORG_A, ["orders.read"]), ORDER_ID);
    expect(state).toEqual({ packed: false, parcelCode: null });
  });
});

describe("pack then arrange delivery", () => {
  it("arranging delivery for a packed order readies the new delivery for handoff", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { markOrderPacked } = await import("../server/packing/service");
    await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);

    const { createDelivery } = await import("../server/deliveries/service");
    const detail = await createDelivery(mockCtx(ORG_A, HANDOFF_PERMS), {
      orderId: ORDER_ID,
      providerName: "Local courier",
    } as any);

    expect(detail.status).toBe("ready");
    expect(mockDeliveries).toHaveLength(1);
    const packedSteps = mockDeliveryHistory.filter(
      (h) => h.reason === PACK_ORDER_PACKED_REASON_CODE,
    );
    expect(packedSteps.map((h) => [h.from_status, h.to_status])).toEqual([
      ["pending", "preparing"],
      ["preparing", "ready"],
    ]);
  });

  it("arranging delivery for an order that is NOT packed leaves it pending", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { createDelivery } = await import("../server/deliveries/service");
    const detail = await createDelivery(mockCtx(ORG_A, HANDOFF_PERMS), {
      orderId: ORDER_ID,
      providerName: "Local courier",
    } as any);
    expect(detail.status).toBe("pending");
  });

  it("readyPackedOrderDelivery is a no-op without a packed order or a delivery", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { readyPackedOrderDelivery } = await import("../server/packing/service");
    expect(await readyPackedOrderDelivery(ORG_A, "user-packer", ORDER_ID)).toBe("no_delivery");
    seedDelivery("pending");
    expect(await readyPackedOrderDelivery(ORG_A, "user-packer", ORDER_ID)).toBe("not_packed");
    expect(rpcCalls).toHaveLength(0);
  });

  it("Mark Packed again after arranging repairs a delivery left pending", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const { markOrderPacked } = await import("../server/packing/service");
    await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    // Simulate a delivery arranged without the best-effort readying.
    seedDelivery("pending");
    const result = await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    expect(result).toEqual({ kind: "already_packed", deliveryId: "delivery-1" });
    expect(mockDeliveries[0].status).toBe("ready");
  });
});

describe("pack then courier handoff", () => {
  it("pack (no delivery) → arrange delivery → courier handoff → in transit", async () => {
    seedOrder();
    rpcResponder = statefulRpc;
    const ctx = mockCtx(ORG_A, HANDOFF_PERMS);
    const { markOrderPacked } = await import("../server/packing/service");
    const { createDelivery } = await import("../server/deliveries/service");
    const { confirmHandoff } = await import("../server/handoff/service");

    // Courier Handoff still requires a valid delivery.
    expect((await confirmHandoff(ctx, PARCEL_CODE)).kind).toBe("no_active_delivery");

    expect((await markOrderPacked(ctx, ORDER_ID, COMPLETE_LINES)).kind).toBe("packed");
    await createDelivery(ctx, { orderId: ORDER_ID, providerName: "Local courier" } as any);

    const handoff = await confirmHandoff(ctx, PARCEL_CODE);
    expect(handoff.kind).toBe("success");
    expect(mockDeliveries[0].status).toBe("in_transit");
  });

  it("an arranged but unpacked delivery cannot be handed off", async () => {
    seedOrder();
    seedDelivery("pending");
    rpcResponder = statefulRpc;
    const { confirmHandoff } = await import("../server/handoff/service");
    const result = await confirmHandoff(mockCtx(ORG_A, HANDOFF_PERMS), PARCEL_CODE);
    expect(result).toEqual({ kind: "delivery_not_ready", currentStatus: "pending" });
  });

  it("pack with a delivery already arranged readies it, then handoff succeeds", async () => {
    seedOrder();
    seedDelivery("pending");
    rpcResponder = statefulRpc;
    const ctx = mockCtx(ORG_A, HANDOFF_PERMS);
    const { markOrderPacked } = await import("../server/packing/service");
    const { confirmHandoff } = await import("../server/handoff/service");
    expect(await markOrderPacked(ctx, ORDER_ID, COMPLETE_LINES)).toEqual({
      kind: "packed",
      deliveryId: "delivery-1",
    });
    expect((await confirmHandoff(ctx, PARCEL_CODE)).kind).toBe("success");
  });
});

describe("packed state", () => {
  it("is packed by the active delivery status or by the packed history reason", () => {
    expect(isOrderPackedFromHistory({ activeDeliveryStatus: null, historyReasons: [] })).toBe(
      false,
    );
    expect(
      isOrderPackedFromHistory({
        activeDeliveryStatus: null,
        historyReasons: [null, PACK_ORDER_PACKED_REASON_CODE],
      }),
    ).toBe(true);
    expect(isOrderPackedFromHistory({ activeDeliveryStatus: "ready", historyReasons: [] })).toBe(
      true,
    );
    expect(
      isOrderPackedFromHistory({ activeDeliveryStatus: "pending", historyReasons: ["other"] }),
    ).toBe(false);
  });

  it("stays packed when a readied delivery is cancelled before handoff", async () => {
    seedOrder();
    seedDelivery("pending");
    rpcResponder = statefulRpc;
    const { markOrderPacked, getOrderPackState } = await import("../server/packing/service");
    await markOrderPacked(mockCtx(ORG_A), ORDER_ID, COMPLETE_LINES);
    mockDeliveries[0].status = "cancelled";
    mockOrders[0].fulfillment_status = "unfulfilled";
    expect((await getOrderPackState(mockCtx(ORG_A), ORDER_ID))?.packed).toBe(true);
  });

  it("history shows the packed reason as localized text, not the raw code", () => {
    const t = (key: string) => `t:${key}`;
    expect(packHistoryReasonMessage(PACK_ORDER_PACKED_REASON_CODE, t)).toBe(
      "t:packSession.history.packed",
    );
    expect(packHistoryReasonMessage("Delivery created", t)).toBeNull();
    expect(packHistoryReasonMessage(null, t)).toBeNull();
  });
});

describe("Order detail action visibility", () => {
  const base = {
    canPrintLabel: true,
    canPack: true,
    packed: false,
    canArrangeDelivery: true,
    activeDeliveryStatus: null as string | null,
    canHandoff: true,
    parcelCode: PARCEL_CODE as string | null,
  };
  const keys = (input: typeof base) => fulfillmentActions(input).map((a) => a.key);

  it("confirmed, nothing done yet: Print label → Pack → Arrange delivery (no handoff)", () => {
    expect(keys(base)).toEqual(["print_label", "pack", "arrange_delivery"]);
  });

  it("packed with no delivery: Packed status, Arrange delivery still offered, no handoff", () => {
    expect(keys({ ...base, packed: true })).toEqual(["print_label", "packed", "arrange_delivery"]);
  });

  it("packed with a ready delivery: Courier handoff appears last and is enabled", () => {
    const actions = fulfillmentActions({ ...base, packed: true, activeDeliveryStatus: "ready" });
    expect(actions.map((a) => a.key)).toEqual(["print_label", "packed", "handoff"]);
    expect(actions.at(-1)).toEqual({ key: "handoff", disabled: false });
  });

  it("delivery arranged but not packed: handoff shown disabled after Pack", () => {
    const actions = fulfillmentActions({ ...base, activeDeliveryStatus: "pending" });
    expect(actions.map((a) => a.key)).toEqual(["print_label", "pack", "handoff"]);
    expect(actions.at(-1)?.disabled).toBe(true);
  });

  it("handoff is hidden without the grant, without a parcel, or once in transit", () => {
    const ready = { ...base, packed: true, activeDeliveryStatus: "ready" };
    expect(keys({ ...ready, canHandoff: false })).not.toContain("handoff");
    expect(keys({ ...ready, parcelCode: null })).not.toContain("handoff");
    expect(keys({ ...ready, activeDeliveryStatus: "in_transit" })).not.toContain("handoff");
  });

  it("Arrange delivery is hidden while a delivery is active or when not allowed", () => {
    expect(keys({ ...base, activeDeliveryStatus: "pending" })).not.toContain("arrange_delivery");
    expect(keys({ ...base, canArrangeDelivery: false })).not.toContain("arrange_delivery");
  });

  it("nothing is offered for an order that cannot be fulfilled", () => {
    expect(
      keys({ ...base, canPrintLabel: false, canPack: false, canArrangeDelivery: false }),
    ).toEqual([]);
  });

  it("the Order detail screen renders actions from fulfillmentActions", async () => {
    const src = await Bun.file(new URL("../routes/app.orders.$id.tsx", import.meta.url)).text();
    expect(src).toContain("fulfillmentActions({");
    expect(src).toContain('to="/app/handoff/$parcelCode"');
    // The packed state comes from the server, not from the delivery status.
    expect(src).toContain("getOrderPackStateFn");
  });
});

describe("Pack Order screen does not wait for a delivery", () => {
  it("Mark Packed is gated only on completion and permission", async () => {
    const src = await Bun.file(new URL("../routes/app.pack.$orderId.tsx", import.meta.url)).text();
    expect(src).toContain("disabled={!ready || !canMark || markPacked.isPending}");
    expect(src).not.toContain("deliveryStatus === null");
    expect(src).not.toContain("markPacked.noDelivery");
    // Camera, hardware scanner and typed codes all feed the one shared scan path.
    expect(src).toContain("<CameraScanSheet");
    expect(src).toContain("useBarcodeScanner({ enabled: scanActive, onScan: handleScan })");
    expect(src).toContain("classifyScan(code)");
  });
});
