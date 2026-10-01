/**
 * Parcel Resolution — comprehensive tests.
 *
 * Validates the server-authoritative resolution of a parcel identity to its
 * full operational context: Parcel → Order → Customer → Delivery → Shipping
 * Snapshot. Uses in-memory stores simulating the service's behaviour, matching
 * the pattern established by scan-identity-router.test.ts.
 *
 * Coverage:
 *   ✓ valid parcel (active)
 *   ✓ void parcel (historically resolvable)
 *   ✓ unknown parcel (no match in org)
 *   ✓ malformed parcel (rejected before lookup)
 *   ✓ cross-org denial (tenant isolation)
 *   ✓ customer linkage (present and absent)
 *   ✓ order linkage (lifecycle/fulfillment/payment status)
 *   ✓ delivery linkage (present, absent, terminal)
 *   ✓ shipping snapshot linkage (all combinations)
 *   ✓ tenant isolation (opaque not-found)
 *   ✓ permission enforcement (missing fulfillment.scan_parcel)
 *
 * Run: bun test src/tests/parcel-resolution.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { PARCEL_CODE_PREFIX, isValidParcelCode } from "../lib/barcode/parcel-code";

// ── In-memory data model ───────────────────────────────────────────────────

interface SimParcel {
  id: string;
  parcelCode: string;
  orderId: string;
  status: string;
  createdAt: string;
  orgId: string;
}

interface SimOrder {
  id: string;
  orderNumber: string;
  lifecycleStatus: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  customerId: string | null;
  shippingName: string | null;
  shippingPhone: string | null;
  shippingAddress: string | null;
  orgId: string;
}

interface SimDelivery {
  id: string;
  orderId: string;
  status: string;
  providerName: string;
  externalTrackingNumber: string | null;
  createdAt: string;
  orgId: string;
}

interface SimCtx {
  orgId: string;
  permissions: Set<string>;
}

interface ParcelResolutionResult {
  parcel: {
    id: string;
    parcelCode: string;
    status: string;
    createdAt: string;
  };
  order: {
    id: string;
    orderNumber: string;
    lifecycleStatus: string;
    fulfillmentStatus: string;
    paymentStatus: string;
  };
  customer: { id: string } | null;
  delivery: {
    id: string;
    status: string;
    providerName: string;
    externalTrackingNumber: string | null;
  } | null;
  shippingSnapshot: {
    hasName: boolean;
    hasPhone: boolean;
    hasAddress: boolean;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

const ORG_A = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeParcelCode(): string {
  return `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
}

// ── Test fixtures ──────────────────────────────────────────────────────────

const CUSTOMER_A_ID = "cust0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const PARCEL_ACTIVE: SimParcel = {
  id: "pcl00001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-28T10:00:00Z",
  orgId: ORG_A,
};

const PARCEL_VOID: SimParcel = {
  id: "pcl00002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "void",
  createdAt: "2026-09-15T08:00:00Z",
  orgId: ORG_A,
};

const PARCEL_NO_CUSTOMER: SimParcel = {
  id: "pcl00003-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00003-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-29T14:00:00Z",
  orgId: ORG_A,
};

const PARCEL_NO_DELIVERY: SimParcel = {
  id: "pcl00004-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00004-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-30T09:00:00Z",
  orgId: ORG_A,
};

const PARCEL_NO_SHIPPING: SimParcel = {
  id: "pcl00005-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00005-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-30T11:00:00Z",
  orgId: ORG_A,
};

const PARCEL_PARTIAL_SHIPPING: SimParcel = {
  id: "pcl00006-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00006-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-30T12:00:00Z",
  orgId: ORG_A,
};

const PARCEL_DELIVERED: SimParcel = {
  id: "pcl00007-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parcelCode: makeParcelCode(),
  orderId: "ord00007-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "created",
  createdAt: "2026-09-25T10:00:00Z",
  orgId: ORG_A,
};

const PARCEL_ORG_B: SimParcel = {
  id: "pcl00010-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  parcelCode: makeParcelCode(),
  orderId: "ord00010-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "created",
  createdAt: "2026-09-28T10:00:00Z",
  orgId: ORG_B,
};

const ORDER_ACTIVE: SimOrder = {
  id: PARCEL_ACTIVE.orderId,
  orderNumber: "APSA-2026-001048",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "processing",
  paymentStatus: "paid",
  customerId: CUSTOMER_A_ID,
  shippingName: "Customer Name",
  shippingPhone: "012345678",
  shippingAddress: "Phnom Penh, Cambodia",
  orgId: ORG_A,
};

const ORDER_VOID: SimOrder = {
  id: PARCEL_VOID.orderId,
  orderNumber: "APSA-2026-000500",
  lifecycleStatus: "cancelled",
  fulfillmentStatus: "cancelled",
  paymentStatus: "refunded",
  customerId: CUSTOMER_A_ID,
  shippingName: "Old Name",
  shippingPhone: "098765432",
  shippingAddress: "Siem Reap, Cambodia",
  orgId: ORG_A,
};

const ORDER_NO_CUSTOMER: SimOrder = {
  id: PARCEL_NO_CUSTOMER.orderId,
  orderNumber: "APSA-2026-001100",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "unfulfilled",
  paymentStatus: "unpaid",
  customerId: null,
  shippingName: "Walk-in",
  shippingPhone: null,
  shippingAddress: null,
  orgId: ORG_A,
};

const ORDER_NO_DELIVERY: SimOrder = {
  id: PARCEL_NO_DELIVERY.orderId,
  orderNumber: "APSA-2026-001200",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "unfulfilled",
  paymentStatus: "paid",
  customerId: CUSTOMER_A_ID,
  shippingName: "Delivery Name",
  shippingPhone: "011223344",
  shippingAddress: "Battambang",
  orgId: ORG_A,
};

const ORDER_NO_SHIPPING: SimOrder = {
  id: PARCEL_NO_SHIPPING.orderId,
  orderNumber: "APSA-2026-001300",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "unfulfilled",
  paymentStatus: "paid",
  customerId: CUSTOMER_A_ID,
  shippingName: null,
  shippingPhone: null,
  shippingAddress: null,
  orgId: ORG_A,
};

const ORDER_PARTIAL_SHIPPING: SimOrder = {
  id: PARCEL_PARTIAL_SHIPPING.orderId,
  orderNumber: "APSA-2026-001400",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "unfulfilled",
  paymentStatus: "paid",
  customerId: CUSTOMER_A_ID,
  shippingName: "Partial Name",
  shippingPhone: null,
  shippingAddress: "",
  orgId: ORG_A,
};

const ORDER_DELIVERED: SimOrder = {
  id: PARCEL_DELIVERED.orderId,
  orderNumber: "APSA-2026-000800",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "fulfilled",
  paymentStatus: "paid",
  customerId: CUSTOMER_A_ID,
  shippingName: "Delivered Name",
  shippingPhone: "099887766",
  shippingAddress: "Phnom Penh",
  orgId: ORG_A,
};

const ORDER_ORG_B: SimOrder = {
  id: PARCEL_ORG_B.orderId,
  orderNumber: "APSA-2026-B00001",
  lifecycleStatus: "confirmed",
  fulfillmentStatus: "processing",
  paymentStatus: "paid",
  customerId: "cust0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  shippingName: "B Customer",
  shippingPhone: "055667788",
  shippingAddress: "Kampot",
  orgId: ORG_B,
};

const DELIVERY_ACTIVE: SimDelivery = {
  id: "del00001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orderId: PARCEL_ACTIVE.orderId,
  status: "in_transit",
  providerName: "J&T Express",
  externalTrackingNumber: "JT123456789",
  createdAt: "2026-09-28T12:00:00Z",
  orgId: ORG_A,
};

const DELIVERY_VOID_ORDER: SimDelivery = {
  id: "del00002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orderId: PARCEL_VOID.orderId,
  status: "cancelled",
  providerName: "Cambodia Post",
  externalTrackingNumber: null,
  createdAt: "2026-09-15T10:00:00Z",
  orgId: ORG_A,
};

const DELIVERY_TERMINAL: SimDelivery = {
  id: "del00007-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orderId: PARCEL_DELIVERED.orderId,
  status: "delivered",
  providerName: "Flash Express",
  externalTrackingNumber: "FE987654321",
  createdAt: "2026-09-26T10:00:00Z",
  orgId: ORG_A,
};

const DELIVERY_ORG_B: SimDelivery = {
  id: "del00010-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  orderId: PARCEL_ORG_B.orderId,
  status: "pending",
  providerName: "Nham24",
  externalTrackingNumber: null,
  createdAt: "2026-09-28T11:00:00Z",
  orgId: ORG_B,
};

// ── In-memory stores ───────────────────────────────────────────────────────

const parcels: SimParcel[] = [
  PARCEL_ACTIVE,
  PARCEL_VOID,
  PARCEL_NO_CUSTOMER,
  PARCEL_NO_DELIVERY,
  PARCEL_NO_SHIPPING,
  PARCEL_PARTIAL_SHIPPING,
  PARCEL_DELIVERED,
  PARCEL_ORG_B,
];

const orders: SimOrder[] = [
  ORDER_ACTIVE,
  ORDER_VOID,
  ORDER_NO_CUSTOMER,
  ORDER_NO_DELIVERY,
  ORDER_NO_SHIPPING,
  ORDER_PARTIAL_SHIPPING,
  ORDER_DELIVERED,
  ORDER_ORG_B,
];

const deliveries: SimDelivery[] = [
  DELIVERY_ACTIVE,
  DELIVERY_VOID_ORDER,
  DELIVERY_TERMINAL,
  DELIVERY_ORG_B,
];

// ── Simulated resolution service ───────────────────────────────────────────

function simulateResolveParcelIdentity(
  ctx: SimCtx,
  parcelCode: string,
): ParcelResolutionResult | null {
  if (!ctx.permissions.has("fulfillment.scan_parcel")) {
    throw new Error("Missing permission: fulfillment.scan_parcel");
  }

  if (!isValidParcelCode(parcelCode)) return null;

  const parcel = parcels.find((p) => p.parcelCode === parcelCode && p.orgId === ctx.orgId);
  if (!parcel) return null;

  const order = orders.find((o) => o.id === parcel.orderId && o.orgId === ctx.orgId);
  if (!order) return null;

  const latestDelivery =
    deliveries
      .filter((d) => d.orderId === parcel.orderId && d.orgId === ctx.orgId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  return {
    parcel: {
      id: parcel.id,
      parcelCode: parcel.parcelCode,
      status: parcel.status,
      createdAt: parcel.createdAt,
    },
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      lifecycleStatus: order.lifecycleStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentStatus: order.paymentStatus,
    },
    customer: order.customerId ? { id: order.customerId } : null,
    delivery: latestDelivery
      ? {
          id: latestDelivery.id,
          status: latestDelivery.status,
          providerName: latestDelivery.providerName,
          externalTrackingNumber: latestDelivery.externalTrackingNumber,
        }
      : null,
    shippingSnapshot: {
      hasName: order.shippingName !== null && order.shippingName !== "",
      hasPhone: order.shippingPhone !== null && order.shippingPhone !== "",
      hasAddress: order.shippingAddress !== null && order.shippingAddress !== "",
    },
  };
}

// ── Contexts ───────────────────────────────────────────────────────────────

const CTX_A: SimCtx = {
  orgId: ORG_A,
  permissions: new Set(["fulfillment.scan_parcel"]),
};

const CTX_B: SimCtx = {
  orgId: ORG_B,
  permissions: new Set(["fulfillment.scan_parcel"]),
};

const CTX_NO_PERMS: SimCtx = {
  orgId: ORG_A,
  permissions: new Set(),
};

// ═══════════════════════════════════════════════════════════════════════════
// VALID PARCEL RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

describe("valid parcel resolution", () => {
  it("resolves an active parcel with full operational context", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.parcel.id).toBe(PARCEL_ACTIVE.id);
    expect(result!.parcel.parcelCode).toBe(PARCEL_ACTIVE.parcelCode);
    expect(result!.parcel.status).toBe("created");
    expect(result!.parcel.createdAt).toBe(PARCEL_ACTIVE.createdAt);
  });

  it("includes order reference with all status axes", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.order.id).toBe(ORDER_ACTIVE.id);
    expect(result!.order.orderNumber).toBe("APSA-2026-001048");
    expect(result!.order.lifecycleStatus).toBe("confirmed");
    expect(result!.order.fulfillmentStatus).toBe("processing");
    expect(result!.order.paymentStatus).toBe("paid");
  });

  it("includes customer id when order has a customer", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.customer).not.toBeNull();
    expect(result!.customer!.id).toBe(CUSTOMER_A_ID);
  });

  it("includes delivery reference when delivery exists", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).not.toBeNull();
    expect(result!.delivery!.id).toBe(DELIVERY_ACTIVE.id);
    expect(result!.delivery!.status).toBe("in_transit");
    expect(result!.delivery!.providerName).toBe("J&T Express");
    expect(result!.delivery!.externalTrackingNumber).toBe("JT123456789");
  });

  it("includes shipping snapshot presence flags", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.shippingSnapshot.hasName).toBe(true);
    expect(result!.shippingSnapshot.hasPhone).toBe(true);
    expect(result!.shippingSnapshot.hasAddress).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VOID PARCEL
// ═══════════════════════════════════════════════════════════════════════════

describe("void parcel resolution", () => {
  it("resolves a voided parcel with status 'void'", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.parcel.status).toBe("void");
  });

  it("includes historical order reference for voided parcel", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.order.orderNumber).toBe("APSA-2026-000500");
    expect(result!.order.lifecycleStatus).toBe("cancelled");
    expect(result!.order.fulfillmentStatus).toBe("cancelled");
    expect(result!.order.paymentStatus).toBe("refunded");
  });

  it("includes historical delivery reference for voided parcel", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).not.toBeNull();
    expect(result!.delivery!.status).toBe("cancelled");
    expect(result!.delivery!.providerName).toBe("Cambodia Post");
  });

  it("preserves shipping snapshot for voided parcel", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.shippingSnapshot.hasName).toBe(true);
    expect(result!.shippingSnapshot.hasPhone).toBe(true);
    expect(result!.shippingSnapshot.hasAddress).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UNKNOWN PARCEL
// ═══════════════════════════════════════════════════════════════════════════

describe("unknown parcel", () => {
  it("returns null for a structurally valid but non-existent parcel code", () => {
    const unknownCode = makeParcelCode();
    const result = simulateResolveParcelIdentity(CTX_A, unknownCode);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MALFORMED PARCEL
// ═══════════════════════════════════════════════════════════════════════════

describe("malformed parcel", () => {
  it("returns null for empty string", () => {
    expect(simulateResolveParcelIdentity(CTX_A, "")).toBeNull();
  });

  it("returns null for random gibberish", () => {
    expect(simulateResolveParcelIdentity(CTX_A, "not-a-parcel")).toBeNull();
  });

  it("returns null for truncated parcel code", () => {
    expect(simulateResolveParcelIdentity(CTX_A, `${PARCEL_CODE_PREFIX}short`)).toBeNull();
  });

  it("returns null for parcel code with invalid characters", () => {
    expect(
      simulateResolveParcelIdentity(CTX_A, `${PARCEL_CODE_PREFIX}!!!invalid-chars!!!!!`),
    ).toBeNull();
  });

  it("returns null for parcel code with wrong prefix", () => {
    expect(simulateResolveParcelIdentity(CTX_A, "WRONG:PCL:v1:kB7xR2mN9pQ4wF5yL3hJ")).toBeNull();
  });

  it("returns null for parcel code that is too long", () => {
    const tooLong = `${PARCEL_CODE_PREFIX}${"A".repeat(30)}`;
    expect(simulateResolveParcelIdentity(CTX_A, tooLong)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-ORG DENIAL (TENANT ISOLATION)
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-org denial", () => {
  it("Org A parcel does NOT resolve in Org B", () => {
    const result = simulateResolveParcelIdentity(CTX_B, PARCEL_ACTIVE.parcelCode);
    expect(result).toBeNull();
  });

  it("Org B parcel does NOT resolve in Org A", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ORG_B.parcelCode);
    expect(result).toBeNull();
  });

  it("Org B parcel resolves correctly in Org B", () => {
    const result = simulateResolveParcelIdentity(CTX_B, PARCEL_ORG_B.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.parcel.id).toBe(PARCEL_ORG_B.id);
    expect(result!.order.orderNumber).toBe("APSA-2026-B00001");
  });

  it("cross-org unknown is indistinguishable from non-existent", () => {
    const crossOrg = simulateResolveParcelIdentity(CTX_B, PARCEL_ACTIVE.parcelCode);
    const nonExistent = simulateResolveParcelIdentity(CTX_A, makeParcelCode());
    expect(crossOrg).toBeNull();
    expect(nonExistent).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER LINKAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("customer linkage", () => {
  it("returns customer id when order has a customer", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.customer).toEqual({ id: CUSTOMER_A_ID });
  });

  it("returns null customer when order has no customer", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_NO_CUSTOMER.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.customer).toBeNull();
  });

  it("never returns customer PII — only the id", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    const customer = result!.customer;
    expect(customer).not.toBeNull();
    const keys = Object.keys(customer!);
    expect(keys).toEqual(["id"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER LINKAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("order linkage", () => {
  it("returns all three status axes", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.order.lifecycleStatus).toBe("confirmed");
    expect(result!.order.fulfillmentStatus).toBe("processing");
    expect(result!.order.paymentStatus).toBe("paid");
  });

  it("returns cancelled order status for voided parcel", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.order.lifecycleStatus).toBe("cancelled");
  });

  it("returns fulfilled status for completed delivery", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_DELIVERED.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.order.fulfillmentStatus).toBe("fulfilled");
  });

  it("never returns order PII (shipping values)", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    const orderKeys = Object.keys(result!.order);
    expect(orderKeys).not.toContain("shippingName");
    expect(orderKeys).not.toContain("shippingPhone");
    expect(orderKeys).not.toContain("shippingAddress");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY LINKAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("delivery linkage", () => {
  it("returns active delivery reference", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).not.toBeNull();
    expect(result!.delivery!.status).toBe("in_transit");
    expect(result!.delivery!.providerName).toBe("J&T Express");
    expect(result!.delivery!.externalTrackingNumber).toBe("JT123456789");
  });

  it("returns null delivery when no delivery exists", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_NO_DELIVERY.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).toBeNull();
  });

  it("returns terminal delivery reference (delivered)", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_DELIVERED.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).not.toBeNull();
    expect(result!.delivery!.status).toBe("delivered");
    expect(result!.delivery!.providerName).toBe("Flash Express");
  });

  it("returns cancelled delivery for voided parcel", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery).not.toBeNull();
    expect(result!.delivery!.status).toBe("cancelled");
  });

  it("handles null tracking number", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_VOID.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.delivery!.externalTrackingNumber).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SHIPPING SNAPSHOT LINKAGE
// ═══════════════════════════════════════════════════════════════════════════

describe("shipping snapshot linkage", () => {
  it("all fields present → all true", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.shippingSnapshot).toEqual({
      hasName: true,
      hasPhone: true,
      hasAddress: true,
    });
  });

  it("all fields null (pickup order) → all false", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_NO_SHIPPING.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.shippingSnapshot).toEqual({
      hasName: false,
      hasPhone: false,
      hasAddress: false,
    });
  });

  it("partial shipping (name only) → mixed flags", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_PARTIAL_SHIPPING.parcelCode);
    expect(result).not.toBeNull();
    expect(result!.shippingSnapshot.hasName).toBe(true);
    expect(result!.shippingSnapshot.hasPhone).toBe(false);
    expect(result!.shippingSnapshot.hasAddress).toBe(false);
  });

  it("empty string shipping fields treated as absent", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_PARTIAL_SHIPPING.parcelCode);
    expect(result).not.toBeNull();
    // shippingAddress is "" in the fixture
    expect(result!.shippingSnapshot.hasAddress).toBe(false);
  });

  it("shipping snapshot never leaks actual PII values", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    const snapshotKeys = Object.keys(result!.shippingSnapshot);
    expect(snapshotKeys.sort()).toEqual(["hasAddress", "hasName", "hasPhone"].sort());
    for (const val of Object.values(result!.shippingSnapshot)) {
      expect(typeof val).toBe("boolean");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

describe("tenant isolation", () => {
  it("each org sees only its own parcels", () => {
    const resultA = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    const resultB = simulateResolveParcelIdentity(CTX_B, PARCEL_ORG_B.parcelCode);
    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA!.parcel.id).not.toBe(resultB!.parcel.id);
  });

  it("Org A cannot access Org B delivery data through parcel resolution", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ORG_B.parcelCode);
    expect(result).toBeNull();
  });

  it("Org B cannot access Org A customer data through parcel resolution", () => {
    const result = simulateResolveParcelIdentity(CTX_B, PARCEL_ACTIVE.parcelCode);
    expect(result).toBeNull();
  });

  it("parcel code is the only input — no org override possible", () => {
    // The resolution function takes (ctx, parcelCode). The org comes from ctx,
    // which is server-derived. There is no org parameter to manipulate.
    const resultA = simulateResolveParcelIdentity(CTX_A, PARCEL_ORG_B.parcelCode);
    expect(resultA).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PERMISSION ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe("permission enforcement", () => {
  it("throws when caller lacks fulfillment.scan_parcel", () => {
    expect(() => simulateResolveParcelIdentity(CTX_NO_PERMS, PARCEL_ACTIVE.parcelCode)).toThrow(
      "Missing permission: fulfillment.scan_parcel",
    );
  });

  it("does not throw when caller has the required permission", () => {
    expect(() => simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESULT SHAPE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe("result shape", () => {
  it("returns only identifiers and operational metadata, never PII", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();

    // Parcel: id, code, status, createdAt
    expect(Object.keys(result!.parcel).sort()).toEqual(
      ["createdAt", "id", "parcelCode", "status"].sort(),
    );

    // Order: id, number, three status axes
    expect(Object.keys(result!.order).sort()).toEqual(
      ["fulfillmentStatus", "id", "lifecycleStatus", "orderNumber", "paymentStatus"].sort(),
    );

    // Customer: id only
    expect(Object.keys(result!.customer!)).toEqual(["id"]);

    // Delivery: id, status, providerName, trackingNumber
    expect(Object.keys(result!.delivery!).sort()).toEqual(
      ["externalTrackingNumber", "id", "providerName", "status"].sort(),
    );

    // Shipping: boolean presence flags only
    expect(Object.keys(result!.shippingSnapshot).sort()).toEqual(
      ["hasAddress", "hasName", "hasPhone"].sort(),
    );
  });

  it("result is JSON-serializable", () => {
    const result = simulateResolveParcelIdentity(CTX_A, PARCEL_ACTIVE.parcelCode);
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toEqual(result);
  });
});
