/**
 * Unit tests for src/lib/deliveries.ts — the pure mapping/transition-visibility/
 * error-classification helpers behind the real Delivery detail/create/transition
 * UI (Delivery UI Production Integration phase).
 *
 * Plain-function tests (no React, no server, no network), same spirit as
 * src/tests/orders-ui.test.ts. Structural assertions (which server function a
 * route/component calls, what a payload does and does not contain) live in
 * src/tests/delivery-ui-integration.test.ts.
 *
 * Run: bun test src/tests/deliveries-ui.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  canCancelDelivery,
  canCreateDeliveryForOrder,
  canMarkDeliveryDelivered,
  canMarkDeliveryFailed,
  canMarkDeliveryInTransit,
  canMarkDeliveryReady,
  canStartPreparingDelivery,
  classifyDeliveryError,
  isActiveDeliveryStatus,
  isTerminalDeliveryStatus,
  isValidDeliveryTransition,
  mapDeliveryDetailToUi,
  mapDeliverySummaryToUi,
  type RealDeliveryStatus,
} from "@/lib/deliveries";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_SUMMARY = {
  id: "11111111-0000-0000-0000-000000000001",
  organizationId: "aaaaaaaa-0000-0000-0000-000000000001",
  orderId: "22222222-0000-0000-0000-000000000001",
  locationId: null as string | null,
  providerId: null as string | null,
  providerKey: null as string | null,
  providerName: "J&T Express",
  externalTrackingNumber: null as string | null,
  codAmount: null as { amount: number; currency: "USD" | "KHR" } | null,
  status: "pending" as RealDeliveryStatus,
  createdBy: "user-1",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

// ═══════════════════════════════════════════════════════════════════════════════
// Server → UI mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe("mapDeliverySummaryToUi", () => {
  it("carries every field through unchanged — the server is authoritative", () => {
    const ui = mapDeliverySummaryToUi(BASE_SUMMARY);
    expect(ui.id).toBe(BASE_SUMMARY.id);
    expect(ui.orderId).toBe(BASE_SUMMARY.orderId);
    expect(ui.providerName).toBe("J&T Express");
    expect(ui.status).toBe("pending");
  });

  it("does not carry organizationId onto the UI shape (never needed, never trusted from the client)", () => {
    const ui = mapDeliverySummaryToUi(BASE_SUMMARY);
    expect(Object.prototype.hasOwnProperty.call(ui, "organizationId")).toBe(false);
  });

  it("preserves a null COD amount rather than inventing a zero", () => {
    const ui = mapDeliverySummaryToUi(BASE_SUMMARY);
    expect(ui.codAmount).toBeNull();
  });

  it("carries a COD amount through unchanged when present", () => {
    const ui = mapDeliverySummaryToUi({
      ...BASE_SUMMARY,
      codAmount: { amount: 1500, currency: "USD" },
    });
    expect(ui.codAmount).toEqual({ amount: 1500, currency: "USD" });
  });
});

describe("mapDeliveryDetailToUi", () => {
  const DETAIL = {
    ...BASE_SUMMARY,
    history: [
      {
        id: "hist-1",
        fromStatus: null,
        toStatus: "pending" as RealDeliveryStatus,
        changedBy: "user-1",
        reason: null,
        createdAt: "2026-09-05T00:00:00.000Z",
      },
      {
        id: "hist-2",
        fromStatus: "pending" as RealDeliveryStatus,
        toStatus: "preparing" as RealDeliveryStatus,
        changedBy: "user-1",
        reason: null,
        createdAt: "2026-09-05T01:00:00.000Z",
      },
    ],
  };

  it("maps every history entry and preserves order", () => {
    const detail = mapDeliveryDetailToUi(DETAIL);
    expect(detail.history).toHaveLength(2);
    expect(detail.history[0]!.toStatus).toBe("pending");
    expect(detail.history[1]!.toStatus).toBe("preparing");
  });

  it("attaches the mapped summary fields alongside history", () => {
    const detail = mapDeliveryDetailToUi(DETAIL);
    expect(detail.id).toBe(DETAIL.id);
    expect(detail.status).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Transition-visibility rules (mirrors src/server/deliveries/state-machine.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe("isValidDeliveryTransition mirrors the server state machine exactly", () => {
  it("pending -> preparing|cancelled only", () => {
    expect(isValidDeliveryTransition("pending", "preparing")).toBe(true);
    expect(isValidDeliveryTransition("pending", "cancelled")).toBe(true);
    expect(isValidDeliveryTransition("pending", "ready")).toBe(false);
    expect(isValidDeliveryTransition("pending", "in_transit")).toBe(false);
    expect(isValidDeliveryTransition("pending", "delivered")).toBe(false);
    expect(isValidDeliveryTransition("pending", "failed")).toBe(false);
  });

  it("preparing -> ready|cancelled only", () => {
    expect(isValidDeliveryTransition("preparing", "ready")).toBe(true);
    expect(isValidDeliveryTransition("preparing", "cancelled")).toBe(true);
    expect(isValidDeliveryTransition("preparing", "in_transit")).toBe(false);
  });

  it("ready -> in_transit|cancelled only", () => {
    expect(isValidDeliveryTransition("ready", "in_transit")).toBe(true);
    expect(isValidDeliveryTransition("ready", "cancelled")).toBe(true);
    expect(isValidDeliveryTransition("ready", "delivered")).toBe(false);
  });

  it("in_transit -> delivered|failed only — NOT cancelled", () => {
    expect(isValidDeliveryTransition("in_transit", "delivered")).toBe(true);
    expect(isValidDeliveryTransition("in_transit", "failed")).toBe(true);
    expect(isValidDeliveryTransition("in_transit", "cancelled")).toBe(false);
  });

  it("terminal statuses (delivered/failed/cancelled) allow no further transition", () => {
    for (const terminal of ["delivered", "failed", "cancelled"] as const) {
      for (const to of ["pending", "preparing", "ready", "in_transit", "delivered", "failed", "cancelled"] as const) {
        expect(isValidDeliveryTransition(terminal, to)).toBe(false);
      }
    }
  });
});

describe("isTerminalDeliveryStatus / isActiveDeliveryStatus", () => {
  it("delivered, failed and cancelled are terminal", () => {
    expect(isTerminalDeliveryStatus("delivered")).toBe(true);
    expect(isTerminalDeliveryStatus("failed")).toBe(true);
    expect(isTerminalDeliveryStatus("cancelled")).toBe(true);
  });

  it("pending, preparing, ready and in_transit are not terminal", () => {
    expect(isTerminalDeliveryStatus("pending")).toBe(false);
    expect(isTerminalDeliveryStatus("preparing")).toBe(false);
    expect(isTerminalDeliveryStatus("ready")).toBe(false);
    expect(isTerminalDeliveryStatus("in_transit")).toBe(false);
  });

  it("isActiveDeliveryStatus is exactly the negation of terminal", () => {
    for (const status of ["pending", "preparing", "ready", "in_transit", "delivered", "failed", "cancelled"] as const) {
      expect(isActiveDeliveryStatus(status)).toBe(!isTerminalDeliveryStatus(status));
    }
  });
});

describe("per-transition button-visibility helpers", () => {
  it("canStartPreparingDelivery is true only from pending", () => {
    expect(canStartPreparingDelivery("pending")).toBe(true);
    expect(canStartPreparingDelivery("preparing")).toBe(false);
  });

  it("canMarkDeliveryReady is true only from preparing", () => {
    expect(canMarkDeliveryReady("preparing")).toBe(true);
    expect(canMarkDeliveryReady("pending")).toBe(false);
  });

  it("canMarkDeliveryInTransit is true only from ready", () => {
    expect(canMarkDeliveryInTransit("ready")).toBe(true);
    expect(canMarkDeliveryInTransit("preparing")).toBe(false);
  });

  it("canMarkDeliveryDelivered and canMarkDeliveryFailed are both true only from in_transit", () => {
    expect(canMarkDeliveryDelivered("in_transit")).toBe(true);
    expect(canMarkDeliveryFailed("in_transit")).toBe(true);
    expect(canMarkDeliveryDelivered("ready")).toBe(false);
    expect(canMarkDeliveryFailed("ready")).toBe(false);
  });

  it("canCancelDelivery is true from pending/preparing/ready but not in_transit or terminal", () => {
    expect(canCancelDelivery("pending")).toBe(true);
    expect(canCancelDelivery("preparing")).toBe(true);
    expect(canCancelDelivery("ready")).toBe(true);
    expect(canCancelDelivery("in_transit")).toBe(false);
    expect(canCancelDelivery("delivered")).toBe(false);
    expect(canCancelDelivery("cancelled")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Order eligibility (mirrors createDelivery()'s checks in service.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe("canCreateDeliveryForOrder", () => {
  it("is true for a confirmed order with unfulfilled/processing fulfillment", () => {
    expect(
      canCreateDeliveryForOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "unfulfilled" }),
    ).toBe(true);
    expect(
      canCreateDeliveryForOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "processing" }),
    ).toBe(true);
  });

  it("is false when the order is not confirmed (draft/completed/cancelled lifecycle)", () => {
    expect(canCreateDeliveryForOrder({ lifecycleStatus: "draft", fulfillmentStatus: "unfulfilled" })).toBe(
      false,
    );
    expect(
      canCreateDeliveryForOrder({ lifecycleStatus: "cancelled", fulfillmentStatus: "unfulfilled" }),
    ).toBe(false);
  });

  it("is false when fulfillment is already terminal (fulfilled or cancelled)", () => {
    expect(
      canCreateDeliveryForOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "fulfilled" }),
    ).toBe(false);
    expect(
      canCreateDeliveryForOrder({ lifecycleStatus: "confirmed", fulfillmentStatus: "cancelled" }),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error classification
// ═══════════════════════════════════════════════════════════════════════════════

function withStatusCode(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe("classifyDeliveryError", () => {
  it("classifies by statusCode first", () => {
    expect(classifyDeliveryError(withStatusCode("Not authenticated", 401))).toBe("unauthorized");
    expect(classifyDeliveryError(withStatusCode("Missing permission: delivery.create", 403))).toBe(
      "forbidden",
    );
    expect(classifyDeliveryError(withStatusCode("Delivery not found", 404))).toBe("not_found");
    expect(classifyDeliveryError(withStatusCode("A cancellation reason is required", 400))).toBe(
      "invalid",
    );
  });

  it("a 409 'changed concurrently' message is 'stale', any other 409 is 'invalid'", () => {
    expect(
      classifyDeliveryError(
        withStatusCode("Delivery changed concurrently (now preparing) — re-read and retry", 409),
      ),
    ).toBe("stale");
    expect(classifyDeliveryError(withStatusCode("Delivery is already in that status", 409))).toBe(
      "invalid",
    );
    expect(
      classifyDeliveryError(withStatusCode("Order already has an active delivery", 409)),
    ).toBe("invalid");
  });

  it("falls back to message pattern-matching when statusCode is missing", () => {
    expect(classifyDeliveryError(new Error("No active organization membership"))).toBe(
      "unauthorized",
    );
    expect(classifyDeliveryError(new Error("Missing permission: delivery.update"))).toBe(
      "forbidden",
    );
    expect(classifyDeliveryError(new Error("Delivery not found"))).toBe("not_found");
    expect(
      classifyDeliveryError(new Error("Delivery changed concurrently (now ready) — re-read and retry")),
    ).toBe("stale");
    expect(classifyDeliveryError(new Error("Cannot move delivery from 'pending' to 'ready'"))).toBe(
      "invalid",
    );
  });

  it("an unrecognized error is 'server_error', never leaking raw text through classification", () => {
    expect(classifyDeliveryError(new Error("relation \"deliveries\" does not exist"))).toBe(
      "server_error",
    );
    expect(classifyDeliveryError("not an Error instance")).toBe("server_error");
  });
});
