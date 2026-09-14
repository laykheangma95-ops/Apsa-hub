/**
 * Core merchant workflow handoffs — the seams between domains.
 *
 * Every other suite in this repo proves one domain is correct on its own. This
 * one proves the merchant can get FROM one to the next: that the money loop
 * closes, that an attention row leads to the screen that owns the work, and
 * that a catalogue variant and its stock know about each other.
 *
 * The rules under test, and why each is here:
 *
 *   1. ORDER -> PAYMENT. record_payment_v1 existed, was permissioned, audited
 *      and reachable by NOTHING in the UI: no caller anywhere imported
 *      recordPaymentFn. Every production order was therefore permanently
 *      unpaid, which also made the whole Payments workspace unreachable in
 *      practice. The test asserts the wiring exists and stays wired.
 *   2. RECORDING IS NOT SETTLEMENT. Cash is not "paid", and COD least of all.
 *      Recording writes a pending claim; only verification settles it.
 *   3. AXES STAY SEPARATE. A refunded order is `paid` + `partial`/`full`, and
 *      the UI mapper must carry the refund axis rather than dropping it.
 *   4. ATTENTION ROWS LEAD SOMEWHERE USEFUL, gated on the permission the
 *      destination's own server functions require.
 *   5. DEEP LINKS EXIST in both directions between Product and Inventory.
 *
 * Where a rule is MIRRORED on the client so a control can be drawn, the test
 * compares the mirror against the server module it mirrors rather than
 * restating it, so the two cannot drift apart silently.
 *
 * Run: bun test src/tests/core-workflow-handoffs.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import {
  PAYMENT_METHODS,
  RECORD_METHOD_PERMISSIONS,
  VERIFICATION_TRANSITION_PERMISSIONS,
  resultingPaymentStatus,
  type PaymentMethod,
} from "@/server/payments/state-machine";
import { UI_PERMISSION_KEYS, isUiPermissionKey } from "@/lib/capabilities";
import {
  attentionDestination,
  attentionRoute,
  attentionRoutePermission,
  type AttentionRoute,
} from "@/lib/home-attention";
import { mapOrderSummaryToUi } from "@/lib/orders";
import type { OrderSummary as ServerOrderSummary } from "@/server/orders/service";
import type { AttentionItem, UiPermissionKey } from "@/types";

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

/**
 * Comments document intent; only real code enforces anything. A doc comment
 * saying "never parseFloat(x) * 100" must not itself trip a check for
 * parseFloat — so every "this code does NOT do X" assertion reads the stripped
 * source.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 1. Order -> Payment: the money loop is closed ─────────────────────────────

describe("W1: recording a payment against an order is reachable", () => {
  /*
   * The regression this exists for: recordPaymentFn was fully built, gated and
   * audited on the server while NO file outside src/api/payments.ts imported
   * it. The server half passing its own tests said nothing about whether a
   * merchant could ever reach it.
   */
  it("a browser-reachable caller wires recordPaymentFn through to a screen", () => {
    const apiClient = read("src/lib/api/index.ts");
    expect(apiClient).toContain("recordPaymentFn");
    expect(apiClient).toContain("export async function recordRealPayment");

    // ...and a real screen calls that wrapper.
    const orderDetail = read("src/routes/app.orders.$id.tsx");
    expect(orderDetail).toContain("recordRealPayment");
    expect(orderDetail).toContain("RecordOrderPaymentSheet");
  });

  it("the record call carries an idempotency key, so a retry cannot double-charge", () => {
    const apiClient = read("src/lib/api/index.ts");
    const wrapper = apiClient.slice(
      apiClient.indexOf("export async function recordRealPayment"),
      apiClient.indexOf("export async function getRealPaymentDetail"),
    );
    // Not optional, and not minted per attempt: the field is required by the
    // input type so a caller cannot omit it.
    expect(wrapper).toContain("idempotencyKey: input.idempotencyKey");

    const sheet = read("src/components/orders/RecordOrderPaymentSheet.tsx");
    // One key per opened sheet, held in a ref — every submit and every retry
    // from that sheet replays onto the same payment.
    expect(sheet).toContain("idempotencyKeyRef");
    expect(sheet).toContain("newIdempotencyKey()");
  });

  it("the order screen never invents a payment amount", () => {
    const sheet = stripComments(read("src/components/orders/RecordOrderPaymentSheet.tsx"));
    // Integer minor units, parsed once. The float trap this forbids is
    // multiplying a parsed float by the minor-unit factor.
    expect(sheet).toContain("parseMinorUnits");
    expect(sheet).not.toMatch(/parseFloat|Number\(\s*amountText\s*\)\s*\*/);
    // No currency picker: the payment inherits the order's currency, so this
    // path cannot express a conversion.
    expect(sheet).not.toContain("usdToKhr");
    expect(sheet).not.toContain("khrToUsd");
  });
});

// ── 2. Recording is a claim, never a settlement ───────────────────────────────

describe("W2: recording a payment never marks anything paid", () => {
  it("every method — cash and COD included — records as pending/unverified", () => {
    /*
     * The authority is record_payment_v1 itself: it inserts status 'pending'
     * with an unverified (or duplicate_suspected) verification state for every
     * method. Read from the migration so a change to the RPC that started
     * settling on record would fail here.
     */
    const rpc = read("supabase/migrations/035_payment_rpc.sql");
    const insert = rpc.slice(rpc.indexOf("INSERT INTO"), rpc.indexOf("INSERT INTO") + 2000);
    expect(insert).toContain("'pending'");
    // No branch in the insert makes cash settle on the spot.
    expect(insert).not.toContain("'paid'");
  });

  it("only a verification state can produce 'paid'", () => {
    // resultingPaymentStatus is the one function that yields 'paid', and it
    // takes a verification state — never a payment METHOD.
    expect(resultingPaymentStatus("unverified")).toBe("pending");
    expect(resultingPaymentStatus("staff_confirmed")).toBe("paid");
    expect(resultingPaymentStatus("manager_verified")).toBe("paid");
    expect(resultingPaymentStatus("bank_verified")).toBe("paid");
  });

  it("the record-payment sheet states the claim is not yet paid", () => {
    const sheet = read("src/components/orders/RecordOrderPaymentSheet.tsx");
    expect(sheet).toContain("order.recordPaymentSheet.pendingNote");
    expect(sheet).toContain("order.recordPaymentSheet.codNote");

    // The English copy must not tell the merchant the money has settled.
    const en = JSON.parse(read("src/locales/en.json")) as {
      order: { recordPaymentSheet: Record<string, string>; paymentRecordedNotice: string };
    };
    const copy = en.order.recordPaymentSheet;
    expect(copy["pendingNote"]!.toLowerCase()).toContain("not counted as paid");
    expect(copy["codNote"]!.toLowerCase()).toContain("not counted as paid");
    // The post-success notice says the same thing.
    expect(en.order.paymentRecordedNotice.toLowerCase()).toContain("confirmed");
  });
});

// ── 3. Permissions: the UI consults exactly what the server enforces ──────────

describe("W3: the record-payment permission map", () => {
  it("covers every payment method exhaustively", () => {
    expect(Object.keys(RECORD_METHOD_PERMISSIONS).sort()).toEqual([...PAYMENT_METHODS].sort());
    for (const method of PAYMENT_METHODS) {
      expect(typeof RECORD_METHOD_PERMISSIONS[method]).toBe("string");
      expect(RECORD_METHOD_PERMISSIONS[method]!.length).toBeGreaterThan(0);
    }
  });

  it("keeps COD on its own grant — it is not the same authority as taking cash", () => {
    expect(RECORD_METHOD_PERMISSIONS["cod"]).toBe("payments.mark_cod");
    for (const method of PAYMENT_METHODS.filter((m) => m !== "cod")) {
      expect(RECORD_METHOD_PERMISSIONS[method as PaymentMethod]).toBe("payments.record");
    }
    // And the two really are different keys, i.e. the distinction is not
    // cosmetic.
    expect(RECORD_METHOD_PERMISSIONS["cod"]).not.toBe(RECORD_METHOD_PERMISSIONS["cash"]);
  });

  it("is what recordPayment actually requires — not a parallel table", () => {
    const service = read("src/server/payments/service.ts");
    expect(service).toContain("ctx.require(RECORD_METHOD_PERMISSIONS[input.method])");
    // The method is validated BEFORE it indexes the table, so an unknown
    // method can never yield an undefined permission to require.
    const recordBody = service.slice(
      service.indexOf("export async function recordPayment"),
      service.indexOf("ctx.require(RECORD_METHOD_PERMISSIONS"),
    );
    expect(recordBody).toContain("PAYMENT_METHODS.includes(input.method)");
  });

  it("every key it names is one the UI is allowed to consult", () => {
    for (const method of PAYMENT_METHODS) {
      const key = RECORD_METHOD_PERMISSIONS[method]!;
      expect({ method, declared: isUiPermissionKey(key) }).toEqual({ method, declared: true });
    }
  });

  it("does not collide with the verification permissions — record is not confirm", () => {
    const recordKeys = new Set(Object.values(RECORD_METHOD_PERMISSIONS));
    const verifyKeys = new Set(Object.values(VERIFICATION_TRANSITION_PERMISSIONS));
    for (const key of recordKeys) {
      expect({ key, alsoVerifies: verifyKeys.has(key) }).toEqual({ key, alsoVerifies: false });
    }
  });

  it("declares payments.record and payments.mark_cod exactly once each", () => {
    for (const key of ["payments.record", "payments.mark_cod"]) {
      expect(UI_PERMISSION_KEYS.filter((declared) => declared === key).length).toBe(1);
    }
  });
});

// ── 4. The refund axis survives the trip to the UI ────────────────────────────

describe("W4: refund state is carried, not collapsed into payment state", () => {
  function serverOrder(overrides: Partial<ServerOrderSummary> = {}): ServerOrderSummary {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      orderNumber: "APSA-0001",
      customerId: null,
      locationId: null,
      source: "POS",
      subtotal: { amount: 10_000, currency: "USD" },
      discount: { amount: 0, currency: "USD" },
      delivery: { amount: 0, currency: "USD" },
      total: { amount: 10_000, currency: "USD" },
      lifecycleStatus: "confirmed",
      paymentStatus: "paid",
      refundStatus: "none",
      fulfillmentStatus: "unfulfilled",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...overrides,
    } as ServerOrderSummary;
  }

  /*
   * CORRECTIONS.md, "Approved financial semantics": a fully paid $100 order
   * refunded by $20 is paid/partial; refunded in full it is paid/full. A
   * refund never rewrites the payment axis. The UI mapper previously dropped
   * refundStatus entirely, so the production Order screen could not show that
   * a refund had happened at all.
   */
  it("a partly refunded order stays paid AND reports partial", () => {
    const ui = mapOrderSummaryToUi(serverOrder({ refundStatus: "partial" }));
    expect(ui.paymentStatus).toBe("paid");
    expect(ui.refundStatus).toBe("partial");
  });

  it("a fully refunded order stays paid AND reports full", () => {
    const ui = mapOrderSummaryToUi(serverOrder({ refundStatus: "full" }));
    expect(ui.paymentStatus).toBe("paid");
    expect(ui.refundStatus).toBe("full");
    // Never remapped to failed or unpaid.
    expect(ui.paymentStatus).not.toBe("failed");
    expect(ui.paymentStatus).not.toBe("unpaid");
  });

  it("an unrefunded order reports none", () => {
    expect(mapOrderSummaryToUi(serverOrder()).refundStatus).toBe("none");
  });

  it("the order screen renders the refund axis beside, not instead of, payment", () => {
    const orderDetail = read("src/routes/app.orders.$id.tsx");
    expect(orderDetail).toContain("order.refundStatus");
    expect(orderDetail).toContain("order.axis.refund");
    // Both axes are drawn; neither replaces the other.
    expect(orderDetail).toContain("order.axis.payment");
  });

  it("every axis a status-history entry can carry has a label", () => {
    // entry.axis is rendered as t(`order.axis.${entry.axis}`), and the refund
    // axis previously had no key — a refund event rendered a raw key.
    const en = JSON.parse(read("src/locales/en.json")) as {
      order: { axis: Record<string, string> };
    };
    const km = JSON.parse(read("src/locales/km.json")) as {
      order: { axis: Record<string, string> };
    };
    for (const axis of ["lifecycle", "payment", "fulfillment", "refund"]) {
      expect({ axis, en: Boolean(en.order.axis[axis]) }).toEqual({ axis, en: true });
      expect({ axis, km: Boolean(km.order.axis[axis]) }).toEqual({ axis, km: true });
    }
  });
});

// ── 5. Home attention rows lead to the screen that owns the work ──────────────

describe("W5: Home attention destinations", () => {
  const ALWAYS = () => true;
  const NEVER = () => false;

  it("payment review goes to Payments, not to the Orders list", () => {
    // Regression: this pointed at /app/orders, where none of confirm, verify
    // or refund can be performed.
    expect(attentionRoute("payments_needing_review")).toBe("/app/payments");
  });

  it("an out-of-stock count is a link, not a dead card", () => {
    // Regression: low_stock had no entry at all, so the row rendered as an
    // unclickable card while /app/inventory was live.
    expect(attentionRoute("low_stock")).toBe("/app/inventory");
  });

  it("keeps the destinations that were already right", () => {
    expect(attentionRoute("unread_conversations")).toBe("/app/inbox");
    expect(attentionRoute("awaiting_payment")).toBe("/app/orders");
    expect(attentionRoute("orders_needing_action")).toBe("/app/orders");
    expect(attentionRoute("awaiting_delivery")).toBe("/app/deliveries");
  });

  it("gates each destination on the permission that destination requires", () => {
    const expected: Record<AttentionRoute, UiPermissionKey> = {
      "/app/inbox": "messages.read",
      "/app/orders": "orders.read",
      // Regression: was keyed to orders.read, offering a member without
      // delivery.read a link the server refuses.
      "/app/deliveries": "delivery.read",
      "/app/payments": "payments.read",
      "/app/inventory": "inventory.read",
    };
    for (const [route, key] of Object.entries(expected) as Array<
      [AttentionRoute, UiPermissionKey]
    >) {
      expect({ route, key: attentionRoutePermission(route) }).toEqual({ route, key });
    }
  });

  it("every declared permission is one the UI may consult", () => {
    const ids: AttentionItem["id"][] = [
      "unread_conversations",
      "awaiting_payment",
      "payments_needing_review",
      "awaiting_delivery",
      "orders_needing_action",
      "low_stock",
    ];
    for (const id of ids) {
      const route = attentionRoute(id);
      if (!route) continue;
      expect({ id, ok: isUiPermissionKey(attentionRoutePermission(route)) }).toEqual({
        id,
        ok: true,
      });
    }
  });

  it("fails closed: no permission means no link, never a link into a refusal", () => {
    expect(attentionDestination("payments_needing_review", NEVER)).toBeNull();
    expect(attentionDestination("low_stock", NEVER)).toBeNull();
    expect(attentionDestination("payments_needing_review", ALWAYS)).toBe("/app/payments");
  });

  it("carries no search-param filter it cannot honour", () => {
    /*
     * Each count is a union the destination cannot express in one server
     * query, so a pre-selected filter would show FEWER rows than the number
     * just tapped. The routes stay bare on purpose.
     */
    for (const id of ["awaiting_payment", "payments_needing_review", "low_stock"] as const) {
      const route = attentionRoute(id);
      expect({ id, route }).toEqual({ id, route: attentionRoute(id) });
      expect(route).not.toContain("?");
    }
  });
});

// ── 6. Product <-> Inventory, both directions ─────────────────────────────────

describe("W6: catalogue and stock link to each other", () => {
  it("a variant on the product screen links to its stock", () => {
    const productDetail = read("src/routes/app.products.$id.tsx");
    expect(productDetail).toContain('to="/app/inventory/$variantId"');
    // Gated on inventory.read — a separate grant from every products.* key.
    expect(productDetail).toContain('capabilities.can("inventory.read")');
    expect(productDetail).toContain("canReadStock");
  });

  it("a stock record links back to its product", () => {
    const inventoryDetail = read("src/routes/app.inventory.$variantId.tsx");
    expect(inventoryDetail).toContain('to="/app/products/$id"');
    // Gated on products.read, which is what the catalogue read requires.
    expect(inventoryDetail).toContain("canReadProducts");
  });
});

// ── 7. The order screen's payment reads stay principal-partitioned ────────────

describe("W7: payment caches on the order screen cannot leak across principals", () => {
  it("keys every payment read by user AND organization", () => {
    const orderDetail = read("src/routes/app.orders.$id.tsx");
    /*
     * The failure this guards: user A signs out on a shared phone, user B
     * signs in, and B's order screen reads back A's cached payment rows. The
     * payments list screen already partitions this way; the order screen's new
     * reads must use the same partition rather than a bare ["payments", id].
     */
    expect(orderDetail).toContain('["payments", userId, routeOrganizationId, "order", id]');
    expect(orderDetail).toContain('["payments", userId, routeOrganizationId, "settlement", id]');
    // Identity comes from the route guard's server-derived context, never the
    // capability snapshot.
    expect(orderDetail).toContain("Route.useRouteContext()");
    expect(orderDetail).toContain("identityOk");
  });

  it("invalidates narrowly after a payment, never with a blanket clear", () => {
    const orderDetail = read("src/routes/app.orders.$id.tsx");
    // Strip first, then locate: indices from the raw source do not line up
    // with the stripped string.
    const stripped = stripComments(orderDetail);
    const fn = stripped.slice(
      stripped.indexOf("function invalidateAfterPayment"),
      stripped.indexOf("const recordPaymentMutation"),
    );
    // Order, payments (this principal's whole root), orders list, Home.
    expect(fn).toContain("queryKey");
    expect(fn).toContain('["payments", userId, routeOrganizationId]');
    expect(fn).toContain('["orders", "real"]');
    expect(fn).toContain("HOME_QUERY_PREFIX");
    // A blanket clear would drop other principals' entries too and is reserved
    // for sign-out.
    expect(fn).not.toContain("queryClient.clear()");
  });
});
