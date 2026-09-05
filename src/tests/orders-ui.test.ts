/**
 * Unit tests for src/lib/orders.ts — the pure mapping/rules/error-classification
 * helpers behind the real Order list/detail/create/confirm/cancel UI (Real Order
 * UI Integration phase).
 *
 * These are plain-function tests (no React, no server, no network) in the same
 * spirit as src/tests/mobile-nav-config.test.ts and the pure arithmetic in
 * src/lib/order-draft.ts — the parts of the UI layer that can be proven without
 * a rendering harness are proven here; the rest is covered by structural
 * assertions in src/tests/order-ui-integration.test.ts.
 *
 * Run: bun test src/tests/orders-ui.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  canCancelOrder,
  canConfirmOrder,
  channelToSourceDb,
  classifyOrderError,
  isChannelSource,
  mapOrderDetailToUi,
  mapOrderLineToUi,
  mapOrderSummaryToUi,
  sourceDbToOrderSource,
  totalStockUnits,
} from "@/lib/orders";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_SUMMARY = {
  id: "11111111-0000-0000-0000-000000000001",
  organizationId: "aaaaaaaa-0000-0000-0000-000000000001",
  orderNumber: "APSA-2026-000042",
  customerId: "cccccccc-0000-0000-0000-000000000001" as string | null,
  locationId: null as string | null,
  source: "POS" as const,
  currency: "USD" as const,
  subtotal: { amount: 1000, currency: "USD" as const },
  discount: { amount: 0, currency: "USD" as const },
  delivery: { amount: 0, currency: "USD" as const },
  total: { amount: 1000, currency: "USD" as const },
  lifecycleStatus: "draft" as const,
  paymentStatus: "unpaid" as const,
  fulfillmentStatus: "unfulfilled" as const,
  createdBy: "user-1",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

const BASE_LINE = {
  id: "line-1",
  productId: "dddddddd-0000-0000-0000-000000000001",
  variantId: "eeeeeeee-0000-0000-0000-000000000001",
  productName: "សេរ៉ូមវីតាមីន C",
  variantName: null as string | null,
  sku: "SKU-1",
  unitPrice: { amount: 900, currency: "USD" as const },
  quantity: 2,
  lineTotal: { amount: 1800, currency: "USD" as const },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Source / channel mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe("source <-> channel mapping", () => {
  it("maps every OrderSourceDb value to an OrderSource", () => {
    expect(sourceDbToOrderSource("POS")).toBe("pos");
    expect(sourceDbToOrderSource("FACEBOOK")).toBe("facebook");
    expect(sourceDbToOrderSource("INSTAGRAM")).toBe("instagram");
    expect(sourceDbToOrderSource("TELEGRAM")).toBe("telegram");
    expect(sourceDbToOrderSource("MANUAL")).toBe("manual");
  });

  it("maps every Channel back to its OrderSourceDb", () => {
    expect(channelToSourceDb("pos")).toBe("POS");
    expect(channelToSourceDb("facebook")).toBe("FACEBOOK");
    expect(channelToSourceDb("instagram")).toBe("INSTAGRAM");
    expect(channelToSourceDb("telegram")).toBe("TELEGRAM");
  });

  it("only 'manual' is not a renderable ChannelBadge channel", () => {
    expect(isChannelSource("pos")).toBe(true);
    expect(isChannelSource("facebook")).toBe(true);
    expect(isChannelSource("instagram")).toBe(true);
    expect(isChannelSource("telegram")).toBe(true);
    expect(isChannelSource("manual")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Server -> UI mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe("mapOrderSummaryToUi", () => {
  it("carries the order number as the UI's `code`, never inventing one", () => {
    const ui = mapOrderSummaryToUi(BASE_SUMMARY);
    expect(ui.code).toBe("APSA-2026-000042");
    expect(ui.id).toBe(BASE_SUMMARY.id);
  });

  it("carries a null customerId through rather than coercing it", () => {
    const ui = mapOrderSummaryToUi({ ...BASE_SUMMARY, customerId: null });
    expect(ui.customerId).toBeNull();
  });

  it("preserves all three real status axes without renaming them", () => {
    const ui = mapOrderSummaryToUi({
      ...BASE_SUMMARY,
      lifecycleStatus: "confirmed",
      paymentStatus: "pending",
      fulfillmentStatus: "processing",
    });
    expect(ui.lifecycleStatus).toBe("confirmed");
    expect(ui.paymentStatus).toBe("pending");
    expect(ui.fulfillmentStatus).toBe("processing");
  });

  it("carries money fields through unchanged (server is authoritative for totals)", () => {
    const ui = mapOrderSummaryToUi(BASE_SUMMARY);
    expect(ui.total).toEqual({ amount: 1000, currency: "USD" });
    expect(ui.subtotal).toEqual({ amount: 1000, currency: "USD" });
  });

  it("MANUAL source maps to source:'manual' and a channel-badge-safe fallback channel", () => {
    const ui = mapOrderSummaryToUi({ ...BASE_SUMMARY, source: "MANUAL" });
    expect(ui.source).toBe("manual");
    // `channel` is never read for a manual order (callers branch on `source`),
    // but it must still be a valid Channel so the type stays sound.
    expect(["pos", "facebook", "instagram", "telegram"]).toContain(ui.channel);
  });

  it("a social source maps identically to both `source` and `channel`", () => {
    const ui = mapOrderSummaryToUi({ ...BASE_SUMMARY, source: "TELEGRAM" });
    expect(ui.source).toBe("telegram");
    expect(ui.channel).toBe("telegram");
  });
});

describe("mapOrderLineToUi", () => {
  it("snapshots one product name into both nameKm and nameEn (server has only one)", () => {
    const item = mapOrderLineToUi(BASE_LINE);
    expect(item.nameKm).toBe("សេរ៉ូមវីតាមីន C");
    expect(item.nameEn).toBe("សេរ៉ូមវីតាមីន C");
  });

  it("omits `variant` when the server has no variant name, rather than showing an empty label", () => {
    const item = mapOrderLineToUi(BASE_LINE);
    expect(item.variant).toBeUndefined();
  });

  it("includes `variant` when the server snapshot has one", () => {
    const item = mapOrderLineToUi({ ...BASE_LINE, variantName: "Black · M" });
    expect(item.variant).toBe("Black · M");
  });

  it("carries quantity, unitPrice, lineTotal and sku through unchanged", () => {
    const item = mapOrderLineToUi(BASE_LINE);
    expect(item.quantity).toBe(2);
    expect(item.unitPrice).toEqual({ amount: 900, currency: "USD" });
    expect(item.lineTotal).toEqual({ amount: 1800, currency: "USD" });
    expect(item.sku).toBe("SKU-1");
  });
});

describe("mapOrderDetailToUi", () => {
  const DETAIL = {
    ...BASE_SUMMARY,
    items: [BASE_LINE, { ...BASE_LINE, id: "line-2", quantity: 1 }],
    statusHistory: [
      {
        id: "hist-1",
        axis: "lifecycle" as const,
        fromStatus: "draft",
        toStatus: "confirmed",
        changedBy: "user-1",
        reason: null,
        changedAt: "2026-09-05T01:00:00.000Z",
      },
    ],
  };

  it("maps every line and preserves item order", () => {
    const { items } = mapOrderDetailToUi(DETAIL);
    expect(items).toHaveLength(2);
    expect(items[0]!.quantity).toBe(2);
    expect(items[1]!.quantity).toBe(1);
  });

  it("attaches the mapped items and the raw status history onto `order`", () => {
    const { order } = mapOrderDetailToUi(DETAIL);
    expect(order.items).toHaveLength(2);
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory![0]!.toStatus).toBe("confirmed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Lifecycle-transition rules
// ═══════════════════════════════════════════════════════════════════════════════

describe("canConfirmOrder / canCancelOrder — mirrors LIFECYCLE_TRANSITIONS", () => {
  it("draft can confirm or cancel", () => {
    expect(canConfirmOrder("draft")).toBe(true);
    expect(canCancelOrder("draft")).toBe(true);
  });

  it("confirmed can cancel but not confirm again", () => {
    expect(canConfirmOrder("confirmed")).toBe(false);
    expect(canCancelOrder("confirmed")).toBe(true);
  });

  it("completed and cancelled are terminal — neither action is offered", () => {
    for (const status of ["completed", "cancelled"] as const) {
      expect(canConfirmOrder(status)).toBe(false);
      expect(canCancelOrder(status)).toBe(false);
    }
  });

  it("an undefined status (mock orders) offers neither real action", () => {
    expect(canConfirmOrder(undefined)).toBe(false);
    expect(canCancelOrder(undefined)).toBe(false);
  });
});

describe("totalStockUnits", () => {
  it("sums quantity across lines — the exact figure the DB ledger moves", () => {
    expect(totalStockUnits([{ quantity: 2 }, { quantity: 3 }])).toBe(5);
  });

  it("is zero for an order with no lines", () => {
    expect(totalStockUnits([])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error classification
// ═══════════════════════════════════════════════════════════════════════════════

function statusError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe("classifyOrderError", () => {
  it("classifies by statusCode when present", () => {
    expect(classifyOrderError(statusError(401, "Not authenticated"))).toBe("unauthorized");
    expect(classifyOrderError(statusError(403, "Missing permission: orders.confirm"))).toBe(
      "forbidden",
    );
    expect(classifyOrderError(statusError(404, "Order not found"))).toBe("not_found");
    expect(
      classifyOrderError(statusError(400, "Each item quantity must be a positive integer")),
    ).toBe("invalid");
  });

  it("splits 409 into 'stale' (concurrent change) vs 'invalid' (bad transition)", () => {
    expect(
      classifyOrderError(statusError(409, "Order status changed concurrently (now confirmed)")),
    ).toBe("stale");
    expect(
      classifyOrderError(
        statusError(409, "Cannot move order lifecycle from 'cancelled' to 'confirmed'"),
      ),
    ).toBe("invalid");
    expect(classifyOrderError(statusError(409, "Order is already in that status"))).toBe("invalid");
  });

  it("falls back to message pattern-matching when statusCode did not survive", () => {
    expect(classifyOrderError(new Error("Not authenticated"))).toBe("unauthorized");
    expect(classifyOrderError(new Error("Missing permission: orders.cancel"))).toBe("forbidden");
    expect(classifyOrderError(new Error("Order not found"))).toBe("not_found");
    expect(classifyOrderError(new Error("Order status changed concurrently (now cancelled)"))).toBe(
      "stale",
    );
    expect(
      classifyOrderError(new Error("Cannot move order lifecycle from 'draft' to 'completed'")),
    ).toBe("invalid");
  });

  it("never leaks raw SQL/PostgREST text as a classification — unmapped errors fall back to server_error", () => {
    const raw = new Error(
      'insert or update on table "inventory_movements" violates foreign key constraint (cross_tenant_variant)',
    );
    expect(classifyOrderError(raw)).toBe("server_error");
  });

  it("non-Error throwables classify as server_error rather than throwing again", () => {
    expect(classifyOrderError("a plain string")).toBe("server_error");
    expect(classifyOrderError(null)).toBe("server_error");
    expect(classifyOrderError(undefined)).toBe("server_error");
  });
});
