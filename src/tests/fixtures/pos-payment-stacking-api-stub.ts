/**
 * The `@/lib/api` boundary, stubbed for the POS payment-stacking browser
 * fixture ONLY.
 *
 * src/tests/pos-payment-stacking.browser.ts aliases `@/lib/api` to this module
 * when it bundles src/tests/fixtures/pos-payment-stacking-page.tsx, so the
 * fixture mounts the REAL <PosCheckoutSheet> — its real state machine, its real
 * <BottomSheet>s and their real document-level focus traps — while the four
 * server calls it makes resolve locally. Nothing else is replaced: the
 * component under test is the shipped one, byte for byte.
 *
 * This exists because the defect under test is about which focus trap is
 * active while two sheets are up. Reaching that state requires a confirmed,
 * unpaid order, which on the real path means a TanStack server function and a
 * database. Stubbing the network boundary is the only substitution made.
 *
 * It is NOT a demo-mode fallback and never ships: the alias lives in the test
 * file's Bun.build call, so no production bundle can resolve it. The stub
 * asserts nothing about money or payment semantics — it hands back exactly what
 * the server would, so the component's own reading of those fields stays under
 * test.
 */
import type { Money, Order, PaymentStatus } from "@/types";

const usd = (amount: number): Money => ({ amount, currency: "USD" });

/** Mirrors the production regex in src/lib/api/index.ts — not weakened here. */
export function isProductionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

const ORDER_ID = "6f1a6a2e-1f9c-4a6d-9a3b-2c5d7e8f9a01";

/**
 * The order the fixture's sale produces. `paymentStatus` is mutated only by
 * recordRealPayment below — exactly as the server's own axis moves — so the
 * component never infers payment from anything else.
 */
let paymentStatus: PaymentStatus = "unpaid";

function order(lifecycleStatus: "draft" | "confirmed"): Order {
  return {
    id: ORDER_ID,
    code: "APSA-ORD-0042",
    customerId: null,
    channel: "pos",
    items: [],
    subtotal: usd(1200),
    discount: usd(0),
    deliveryFee: usd(0),
    total: usd(1200),
    paymentStatus,
    fulfillmentStatus: "unfulfilled",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "pos",
    lifecycleStatus,
  };
}

export async function createRealOrder(): Promise<{ order: Order; items: [] }> {
  return { order: order("draft"), items: [] };
}

export async function confirmRealOrder(): Promise<{ order: Order; items: [] }> {
  return { order: order("confirmed"), items: [] };
}

export async function getRealOrderDetail(): Promise<{ order: Order; items: [] }> {
  return { order: order("confirmed"), items: [] };
}

/**
 * Records the payment the way the server does: the order's own payment axis
 * moves, and the component is expected to re-read rather than patch it.
 * `window.apsaRecordedPayments` lets the browser test prove the shared Payment
 * path was the one used, idempotency key included.
 */
export async function recordRealPayment(input: {
  orderId: string;
  method: string;
  amountMinor: number;
  reference?: string;
  idempotencyKey: string;
}): Promise<{ id: string }> {
  const sink = (globalThis as Record<string, unknown>)["apsaRecordedPayments"] as
    unknown[] | undefined;
  sink?.push(input);
  paymentStatus = "paid";
  return { id: "pay-1" };
}

/** Prototype-only in production; the fixture never routes a real cart here. */
export async function createSale(): Promise<never> {
  throw new Error("createSale must never be reached from a production cart");
}
