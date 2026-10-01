/**
 * Parcel Investigation page — unit tests.
 *
 * Validates the read-only investigation page that appears after scanning a
 * parcel. Uses the same in-memory simulation pattern as parcel-resolution
 * tests, verifying the page's logic layer (data mapping, error classification,
 * navigation targets) rather than rendering (no DOM/React dependency).
 *
 * Coverage:
 *   ✓ valid parcel → full operational summary
 *   ✓ unknown parcel → not-found result
 *   ✓ void parcel → resolved with void status
 *   ✓ missing delivery → delivery section absent
 *   ✓ missing customer → customer section absent
 *   ✓ permission denied → forbidden error
 *   ✓ cross-org denial → opaque not-found
 *   ✓ navigation targets → correct route params
 *
 * Run: bun test src/tests/parcel-investigation.test.ts
 */
import { describe, it, expect } from "bun:test";
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

interface SimConversation {
  id: string;
  customerId: string;
  lastMessageAt: string;
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

// ── Simulated resolution (mirrors server behaviour) ────────────────────────

class SimStore {
  parcels: SimParcel[] = [];
  orders: SimOrder[] = [];
  deliveries: SimDelivery[] = [];
  conversations: SimConversation[] = [];
}

function resolveParcel(
  store: SimStore,
  ctx: SimCtx,
  parcelCode: string,
): ParcelResolutionResult | null {
  if (!ctx.permissions.has("fulfillment.scan_parcel")) return null;
  if (!isValidParcelCode(parcelCode)) return null;

  const parcel = store.parcels.find((p) => p.parcelCode === parcelCode && p.orgId === ctx.orgId);
  if (!parcel) return null;

  const order = store.orders.find((o) => o.id === parcel.orderId && o.orgId === ctx.orgId);
  if (!order) return null;

  const delivery =
    store.deliveries
      .filter((d) => d.orderId === parcel.orderId && d.orgId === ctx.orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

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
    delivery: delivery
      ? {
          id: delivery.id,
          status: delivery.status,
          providerName: delivery.providerName,
          externalTrackingNumber: delivery.externalTrackingNumber,
        }
      : null,
    shippingSnapshot: {
      hasName: order.shippingName !== null && order.shippingName !== "",
      hasPhone: order.shippingPhone !== null && order.shippingPhone !== "",
      hasAddress: order.shippingAddress !== null && order.shippingAddress !== "",
    },
  };
}

// ── Conversation lookup (mirrors server repository logic) ────────────────

function findActiveConversationId(
  store: SimStore,
  orgId: string,
  customerId: string | null,
  permissions: Set<string>,
): string | null {
  if (!customerId) return null;
  if (!permissions.has("messages.read") || !permissions.has("customers.read")) return null;

  const conversations = store.conversations
    .filter((c) => c.customerId === customerId && c.orgId === orgId)
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

  return conversations[0]?.id ?? null;
}

// ── Navigation target derivation (mirrors page component logic) ────────────

interface NavigationTarget {
  to: string;
  params: Record<string, string>;
  enabled: boolean;
}

function deriveNavigationTargets(
  result: ParcelResolutionResult,
  activeConversationId: string | null = null,
): NavigationTarget[] {
  const targets: NavigationTarget[] = [
    {
      to: "/app/orders/$id",
      params: { id: result.order.id },
      enabled: true,
    },
  ];

  if (result.customer) {
    targets.push({
      to: "/app/customers/$id",
      params: { id: result.customer.id },
      enabled: true,
    });
  }

  if (result.delivery) {
    targets.push({
      to: "/app/deliveries/$id",
      params: { id: result.delivery.id },
      enabled: true,
    });
  }

  if (activeConversationId) {
    targets.push({
      to: "/app/inbox/$id",
      params: { id: activeConversationId },
      enabled: true,
    });
  } else if (result.customer) {
    targets.push({ to: "conversation", params: {}, enabled: false });
  }

  // Payment placeholder (always present, never enabled)
  targets.push({ to: "payment", params: {}, enabled: false });

  return targets;
}

// ── Error classification (mirrors page component logic) ────────────────────

type InvestigationErrorKind = "denied" | "not_found" | "error";

function classifyInvestigationError(
  error: Error | null,
  result: ParcelResolutionResult | null | undefined,
): InvestigationErrorKind | null {
  if (error) {
    const msg = error.message ?? "";
    if (
      msg.includes("Not authenticated") ||
      msg.includes("Forbidden") ||
      msg.includes("No active organization")
    ) {
      return "denied";
    }
    return "error";
  }
  if (result === null) return "not_found";
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function makeParcelCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let token = "";
  for (let i = 0; i < 22; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${PARCEL_CODE_PREFIX}${token}`;
}

function makeStore(): SimStore {
  return new SimStore();
}

function makeCtx(orgId: string, permissions = ["fulfillment.scan_parcel"]): SimCtx {
  return { orgId, permissions: new Set(permissions) };
}

function seedFullParcel(
  store: SimStore,
  orgId: string,
  overrides: {
    parcelStatus?: string;
    customerId?: string | null;
    shippingName?: string | null;
    shippingPhone?: string | null;
    shippingAddress?: string | null;
    withDelivery?: boolean;
    deliveryStatus?: string;
    deliveryProvider?: string;
    deliveryTracking?: string | null;
    lifecycleStatus?: string;
    fulfillmentStatus?: string;
    paymentStatus?: string;
  } = {},
) {
  const parcelId = uuid();
  const orderId = uuid();
  const parcelCode = makeParcelCode();
  const customerId = overrides.customerId !== undefined ? overrides.customerId : uuid();

  store.parcels.push({
    id: parcelId,
    parcelCode,
    orderId,
    status: overrides.parcelStatus ?? "active",
    createdAt: new Date().toISOString(),
    orgId,
  });

  store.orders.push({
    id: orderId,
    orderNumber: `ORD-${Date.now()}`,
    lifecycleStatus: overrides.lifecycleStatus ?? "confirmed",
    fulfillmentStatus: overrides.fulfillmentStatus ?? "unfulfilled",
    paymentStatus: overrides.paymentStatus ?? "unpaid",
    customerId,
    shippingName: overrides.shippingName !== undefined ? overrides.shippingName : "Test Recipient",
    shippingPhone: overrides.shippingPhone !== undefined ? overrides.shippingPhone : "012345678",
    shippingAddress:
      overrides.shippingAddress !== undefined
        ? overrides.shippingAddress
        : "123 Test Street, Phnom Penh",
    orgId,
  });

  if (overrides.withDelivery !== false) {
    store.deliveries.push({
      id: uuid(),
      orderId,
      status: overrides.deliveryStatus ?? "in_transit",
      providerName: overrides.deliveryProvider ?? "J&T Express",
      externalTrackingNumber:
        overrides.deliveryTracking !== undefined ? overrides.deliveryTracking : "JT123456789",
      createdAt: new Date().toISOString(),
      orgId,
    });
  }

  return { parcelId, orderId, parcelCode, customerId };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Parcel Investigation", () => {
  describe("valid parcel → full operational summary", () => {
    it("resolves a valid active parcel with all sections populated", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode, orderId } = seedFullParcel(store, orgId);

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result).not.toBeNull();
      expect(result!.parcel.parcelCode).toBe(parcelCode);
      expect(result!.parcel.status).toBe("active");
      expect(result!.order.id).toBe(orderId);
      expect(result!.order.lifecycleStatus).toBe("confirmed");
      expect(result!.order.fulfillmentStatus).toBe("unfulfilled");
      expect(result!.order.paymentStatus).toBe("unpaid");
      expect(result!.customer).not.toBeNull();
      expect(result!.delivery).not.toBeNull();
      expect(result!.delivery!.providerName).toBe("J&T Express");
      expect(result!.shippingSnapshot.hasName).toBe(true);
      expect(result!.shippingSnapshot.hasPhone).toBe(true);
      expect(result!.shippingSnapshot.hasAddress).toBe(true);
    });

    it("includes all order status axes", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        lifecycleStatus: "completed",
        fulfillmentStatus: "fulfilled",
        paymentStatus: "paid",
      });

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result!.order.lifecycleStatus).toBe("completed");
      expect(result!.order.fulfillmentStatus).toBe("fulfilled");
      expect(result!.order.paymentStatus).toBe("paid");
    });
  });

  describe("unknown parcel → not-found", () => {
    it("returns null for a code that does not exist", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const fakeCode = makeParcelCode();

      const result = resolveParcel(store, ctx, fakeCode);

      expect(result).toBeNull();
    });

    it("returns null for a malformed parcel code", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);

      const result = resolveParcel(store, ctx, "not-a-parcel-code");

      expect(result).toBeNull();
    });

    it("classifies null result as not_found", () => {
      const kind = classifyInvestigationError(null, null);
      expect(kind).toBe("not_found");
    });
  });

  describe("void parcel → resolved with void status", () => {
    it("resolves void parcels with historical references intact", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        parcelStatus: "void",
      });

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result).not.toBeNull();
      expect(result!.parcel.status).toBe("void");
      expect(result!.order).toBeDefined();
      expect(result!.delivery).not.toBeNull();
    });

    it("void parcel still has customer and shipping data", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode, customerId } = seedFullParcel(store, orgId, {
        parcelStatus: "void",
      });

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result!.customer).not.toBeNull();
      expect(result!.customer!.id).toBe(customerId);
      expect(result!.shippingSnapshot.hasName).toBe(true);
    });
  });

  describe("missing delivery → delivery section absent", () => {
    it("returns null delivery when no delivery exists", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        withDelivery: false,
      });

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result).not.toBeNull();
      expect(result!.delivery).toBeNull();
      expect(result!.order).toBeDefined();
    });

    it("navigation targets exclude delivery link when no delivery", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        withDelivery: false,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result);

      const deliveryTarget = targets.find((t) => t.to === "/app/deliveries/$id");
      expect(deliveryTarget).toBeUndefined();
    });
  });

  describe("missing customer → customer section absent", () => {
    it("returns null customer when order has no linked customer", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        customerId: null,
      });

      const result = resolveParcel(store, ctx, parcelCode);

      expect(result).not.toBeNull();
      expect(result!.customer).toBeNull();
    });

    it("navigation targets exclude customer link when no customer", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        customerId: null,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result);

      const customerTarget = targets.find((t) => t.to === "/app/customers/$id");
      expect(customerTarget).toBeUndefined();
    });
  });

  describe("permission denied → forbidden error", () => {
    it("returns null when user lacks fulfillment.scan_parcel permission", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId, []);
      seedFullParcel(store, orgId);

      const result = resolveParcel(store, ctx, store.parcels[0]!.parcelCode);

      expect(result).toBeNull();
    });

    it("classifies auth errors as denied", () => {
      expect(classifyInvestigationError(new Error("Not authenticated"), undefined)).toBe("denied");

      expect(classifyInvestigationError(new Error("Forbidden"), undefined)).toBe("denied");

      expect(
        classifyInvestigationError(new Error("No active organization membership"), undefined),
      ).toBe("denied");
    });

    it("classifies generic errors as error", () => {
      expect(classifyInvestigationError(new Error("Network failure"), undefined)).toBe("error");
    });
  });

  describe("cross-org denial → opaque not-found", () => {
    it("returns null when parcel belongs to a different organization", () => {
      const store = makeStore();
      const orgA = uuid();
      const orgB = uuid();
      const ctxB = makeCtx(orgB);
      const { parcelCode } = seedFullParcel(store, orgA);

      const result = resolveParcel(store, ctxB, parcelCode);

      expect(result).toBeNull();
    });

    it("is indistinguishable from a genuinely missing parcel", () => {
      const store = makeStore();
      const orgA = uuid();
      const orgB = uuid();
      const ctxB = makeCtx(orgB);
      const { parcelCode } = seedFullParcel(store, orgA);

      const crossOrgResult = resolveParcel(store, ctxB, parcelCode);
      const missingResult = resolveParcel(store, ctxB, makeParcelCode());

      expect(crossOrgResult).toBeNull();
      expect(missingResult).toBeNull();
      expect(crossOrgResult).toEqual(missingResult);
    });
  });

  describe("navigation targets → correct route params", () => {
    it("derives all navigation targets for a fully populated parcel without conversation", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode, orderId, customerId } = seedFullParcel(store, orgId);

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result);

      const orderTarget = targets.find((t) => t.to === "/app/orders/$id");
      expect(orderTarget).toBeDefined();
      expect(orderTarget!.params.id).toBe(orderId);
      expect(orderTarget!.enabled).toBe(true);

      const customerTarget = targets.find((t) => t.to === "/app/customers/$id");
      expect(customerTarget).toBeDefined();
      expect(customerTarget!.params.id).toBe(customerId);
      expect(customerTarget!.enabled).toBe(true);

      const deliveryTarget = targets.find((t) => t.to === "/app/deliveries/$id");
      expect(deliveryTarget).toBeDefined();
      expect(deliveryTarget!.enabled).toBe(true);

      const conversationTarget = targets.find((t) => t.to === "conversation");
      expect(conversationTarget).toBeDefined();
      expect(conversationTarget!.enabled).toBe(false);

      const paymentTarget = targets.find((t) => t.to === "payment");
      expect(paymentTarget).toBeDefined();
      expect(paymentTarget!.enabled).toBe(false);
    });

    it("derives conversation navigation when customer has a conversation", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId, ["fulfillment.scan_parcel", "messages.read", "customers.read"]);
      const { parcelCode, customerId } = seedFullParcel(store, orgId);

      const conversationId = uuid();
      store.conversations.push({
        id: conversationId,
        customerId: customerId!,
        lastMessageAt: new Date().toISOString(),
        orgId,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const activeConvId = findActiveConversationId(store, orgId, customerId, ctx.permissions);
      const targets = deriveNavigationTargets(result, activeConvId);

      const inboxTarget = targets.find((t) => t.to === "/app/inbox/$id");
      expect(inboxTarget).toBeDefined();
      expect(inboxTarget!.params.id).toBe(conversationId);
      expect(inboxTarget!.enabled).toBe(true);

      const placeholderConv = targets.find((t) => t.to === "conversation");
      expect(placeholderConv).toBeUndefined();
    });

    it("order target is always present", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        customerId: null,
        withDelivery: false,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result);

      const orderTarget = targets.find((t) => t.to === "/app/orders/$id");
      expect(orderTarget).toBeDefined();
      expect(orderTarget!.enabled).toBe(true);
    });

    it("payment placeholder is always present but disabled", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId);

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result);

      const paymentTarget = targets.find((t) => t.to === "payment");
      expect(paymentTarget).toBeDefined();
      expect(paymentTarget!.enabled).toBe(false);
    });

    it("conversation placeholder shown when customer exists but has no conversation", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId);

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result, null);

      const placeholderConv = targets.find((t) => t.to === "conversation");
      expect(placeholderConv).toBeDefined();
      expect(placeholderConv!.enabled).toBe(false);
    });

    it("conversation placeholder absent when no customer", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, { customerId: null });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const targets = deriveNavigationTargets(result, null);

      const conversationTargets = targets.filter(
        (t) => t.to === "conversation" || t.to === "/app/inbox/$id",
      );
      expect(conversationTargets.length).toBe(0);
    });
  });

  describe("shipping snapshot edge cases", () => {
    it("reports all missing when shipping fields are null", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        shippingName: null,
        shippingPhone: null,
        shippingAddress: null,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;

      expect(result.shippingSnapshot.hasName).toBe(false);
      expect(result.shippingSnapshot.hasPhone).toBe(false);
      expect(result.shippingSnapshot.hasAddress).toBe(false);
    });

    it("reports missing for empty strings", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        shippingName: "",
        shippingPhone: "",
        shippingAddress: "",
      });

      const result = resolveParcel(store, ctx, parcelCode)!;

      expect(result.shippingSnapshot.hasName).toBe(false);
      expect(result.shippingSnapshot.hasPhone).toBe(false);
      expect(result.shippingSnapshot.hasAddress).toBe(false);
    });

    it("reports present for non-empty fields", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        shippingName: "Recipient",
        shippingPhone: "012345",
        shippingAddress: "123 Street",
      });

      const result = resolveParcel(store, ctx, parcelCode)!;

      expect(result.shippingSnapshot.hasName).toBe(true);
      expect(result.shippingSnapshot.hasPhone).toBe(true);
      expect(result.shippingSnapshot.hasAddress).toBe(true);
    });

    it("reports partial presence correctly", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId);
      const { parcelCode } = seedFullParcel(store, orgId, {
        shippingName: "Recipient",
        shippingPhone: null,
        shippingAddress: "",
      });

      const result = resolveParcel(store, ctx, parcelCode)!;

      expect(result.shippingSnapshot.hasName).toBe(true);
      expect(result.shippingSnapshot.hasPhone).toBe(false);
      expect(result.shippingSnapshot.hasAddress).toBe(false);
    });
  });

  describe("error classification", () => {
    it("returns null for a successful result", () => {
      const result = {} as ParcelResolutionResult;
      expect(classifyInvestigationError(null, result)).toBeNull();
    });

    it("classifies null result (no error) as not_found", () => {
      expect(classifyInvestigationError(null, null)).toBe("not_found");
    });

    it("classifies undefined result (no error) as null (still loading)", () => {
      expect(classifyInvestigationError(null, undefined)).toBeNull();
    });
  });

  describe("customer ↔ conversation linkage", () => {
    it("finds active conversation for a customer with conversations", () => {
      const store = makeStore();
      const orgId = uuid();
      const customerId = uuid();
      const conversationId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read", "customers.read"]);

      store.conversations.push({
        id: conversationId,
        customerId,
        lastMessageAt: new Date().toISOString(),
        orgId,
      });

      const result = findActiveConversationId(store, orgId, customerId, permissions);
      expect(result).toBe(conversationId);
    });

    it("returns null for a customer without conversations", () => {
      const store = makeStore();
      const orgId = uuid();
      const customerId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read", "customers.read"]);

      const result = findActiveConversationId(store, orgId, customerId, permissions);
      expect(result).toBeNull();
    });

    it("returns the most recent conversation when multiple exist", () => {
      const store = makeStore();
      const orgId = uuid();
      const customerId = uuid();
      const olderConvId = uuid();
      const newerConvId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read", "customers.read"]);

      store.conversations.push({
        id: olderConvId,
        customerId,
        lastMessageAt: "2024-01-01T00:00:00.000Z",
        orgId,
      });
      store.conversations.push({
        id: newerConvId,
        customerId,
        lastMessageAt: "2024-06-01T00:00:00.000Z",
        orgId,
      });

      const result = findActiveConversationId(store, orgId, customerId, permissions);
      expect(result).toBe(newerConvId);
    });

    it("denies cross-org conversation access", () => {
      const store = makeStore();
      const orgA = uuid();
      const orgB = uuid();
      const customerId = uuid();
      const conversationId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read", "customers.read"]);

      store.conversations.push({
        id: conversationId,
        customerId,
        lastMessageAt: new Date().toISOString(),
        orgId: orgA,
      });

      const result = findActiveConversationId(store, orgB, customerId, permissions);
      expect(result).toBeNull();
    });

    it("returns null when customer ID is null", () => {
      const store = makeStore();
      const orgId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read", "customers.read"]);

      const result = findActiveConversationId(store, orgId, null, permissions);
      expect(result).toBeNull();
    });

    it("returns null when missing messages.read permission", () => {
      const store = makeStore();
      const orgId = uuid();
      const customerId = uuid();
      const conversationId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "customers.read"]);

      store.conversations.push({
        id: conversationId,
        customerId,
        lastMessageAt: new Date().toISOString(),
        orgId,
      });

      const result = findActiveConversationId(store, orgId, customerId, permissions);
      expect(result).toBeNull();
    });

    it("returns null when missing customers.read permission", () => {
      const store = makeStore();
      const orgId = uuid();
      const customerId = uuid();
      const conversationId = uuid();
      const permissions = new Set(["fulfillment.scan_parcel", "messages.read"]);

      store.conversations.push({
        id: conversationId,
        customerId,
        lastMessageAt: new Date().toISOString(),
        orgId,
      });

      const result = findActiveConversationId(store, orgId, customerId, permissions);
      expect(result).toBeNull();
    });

    it("integrates with navigation targets: conversation link replaces placeholder", () => {
      const store = makeStore();
      const orgId = uuid();
      const ctx = makeCtx(orgId, ["fulfillment.scan_parcel", "messages.read", "customers.read"]);
      const { parcelCode, customerId } = seedFullParcel(store, orgId);

      const conversationId = uuid();
      store.conversations.push({
        id: conversationId,
        customerId: customerId!,
        lastMessageAt: new Date().toISOString(),
        orgId,
      });

      const result = resolveParcel(store, ctx, parcelCode)!;
      const activeConvId = findActiveConversationId(store, orgId, customerId, ctx.permissions);
      const targets = deriveNavigationTargets(result, activeConvId);

      const enabledTargets = targets.filter((t) => t.enabled);
      expect(enabledTargets.length).toBe(4);

      const inboxTarget = enabledTargets.find((t) => t.to === "/app/inbox/$id");
      expect(inboxTarget).toBeDefined();
      expect(inboxTarget!.params.id).toBe(conversationId);
    });
  });
});
