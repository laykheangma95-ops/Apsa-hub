/**
 * Orders attention views — the per-row facts behind "Payment due", "Needs
 * preparation", "Packed · Needs delivery" and "Packed · Waiting for pickup"
 * (src/lib/order-list-filters.ts).
 *
 * Read-only. Nothing here writes an order, a payment, a delivery or stock, and
 * no status is derived here: each fact below is a stored row. Which view an
 * order is in (packed or not) is decided by the database, not here.
 *
 * Every read is scoped to the organization the server resolved for the caller
 * AND to the ids of one page of that organization's own orders, so nothing
 * here can reach another tenant. Each fact is returned only to a member who
 * may read it — the same grant its own screen requires:
 *   customer name   customers.read   (otherwise "a customer is linked")
 *   received so far payments.read
 *   delivery facts  delivery.read
 *
 * There is no staff assignment in the data model (no column, no table), so
 * `assignedStaff` is always null and the screen says so rather than inventing
 * one.
 *
 * Never import this file from browser-bundled code.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import {
  DELIVERY_STATUSES,
  isTerminalDeliveryStatus,
  type DeliveryStatus,
} from "@/server/deliveries/state-machine";
import type { OrderAttentionFilter } from "@/lib/order-list-filters";
import type { Currency, Money } from "@/types";
import * as repo from "./repository";
import type { OrderRow } from "./types";

export type OrderAttentionCustomer =
  { kind: "none" } | { kind: "hidden" } | { kind: "named"; name: string };

export interface OrderAttentionDelivery {
  /** The non-terminal delivery's status, else the newest delivery's; null when none. */
  status: DeliveryStatus | null;
  /** When the active delivery last became `ready`; null when not ready or unrecorded. */
  readySince: string | null;
  /** The active (or newest) delivery carries a cash-on-delivery amount. */
  cod: boolean;
}

export interface OrderAttentionDetail {
  customer: OrderAttentionCustomer;
  /**
   * Gross received on the Payment ledger (Payment due only); null when the
   * member may not read payments, or the ledger row could not be read.
   */
  received: Money | null;
  /** null when the member may not read deliveries. */
  delivery: OrderAttentionDelivery | null;
  /** Not tracked by APSA yet — always null. */
  assignedStaff: null;
}

function parseDeliveryStatus(value: string): DeliveryStatus | null {
  return (DELIVERY_STATUSES as readonly string[]).includes(value)
    ? (value as DeliveryStatus)
    : null;
}

export async function buildOrderAttention(
  ctx: AuthorizationContext,
  filter: OrderAttentionFilter,
  rows: readonly OrderRow[],
): Promise<Record<string, OrderAttentionDetail>> {
  const organizationId = ctx.organizationId;
  const orderIds = rows.map((row) => row.id);
  if (orderIds.length === 0) return {};

  const canCustomers = ctx.can("customers.read");
  const canPayments = ctx.can("payments.read");
  const canDeliveries = ctx.can("delivery.read");
  const customerIds = [
    ...new Set(rows.flatMap((row) => (row.customer_id ? [row.customer_id] : []))),
  ];

  const [customers, totals, deliveries] = await Promise.all([
    canCustomers ? repo.listCustomerNamesForOrg(organizationId, customerIds) : [],
    canPayments && filter === "awaiting_payment"
      ? repo.listPaymentTotalsForOrders(organizationId, orderIds)
      : [],
    canDeliveries ? repo.listDeliveriesForOrders(organizationId, orderIds) : [],
  ]);

  const nameById = new Map(customers.map((row) => [row.id, row.display_name]));
  const receivedByOrder = new Map(
    totals.map((row) => [row.order_id, { amount: row.received_minor, currency: row.currency }]),
  );

  // Newest first (the repository's order): the first non-terminal delivery is
  // the active one (at most one per order), the first of any kind the latest.
  const activeByOrder = new Map<string, repo.AttentionDeliveryRow>();
  const latestByOrder = new Map<string, repo.AttentionDeliveryRow>();
  for (const delivery of deliveries) {
    if (!latestByOrder.has(delivery.order_id)) latestByOrder.set(delivery.order_id, delivery);
    const status = parseDeliveryStatus(delivery.status);
    if (status && !isTerminalDeliveryStatus(status) && !activeByOrder.has(delivery.order_id)) {
      activeByOrder.set(delivery.order_id, delivery);
    }
  }

  const readyIds = canDeliveries
    ? [...activeByOrder.values()].filter((d) => d.status === "ready").map((d) => d.id)
    : [];
  const readyEvents = await repo.listReadyEventsForDeliveries(organizationId, readyIds);
  const readySince = new Map<string, string>();
  for (const event of readyEvents) {
    const previous = readySince.get(event.delivery_id);
    if (!previous || Date.parse(event.created_at) > Date.parse(previous)) {
      readySince.set(event.delivery_id, event.created_at);
    }
  }

  const result: Record<string, OrderAttentionDetail> = {};
  for (const row of rows) {
    const name = row.customer_id ? nameById.get(row.customer_id) : undefined;
    const received = receivedByOrder.get(row.id);
    const shown = activeByOrder.get(row.id) ?? latestByOrder.get(row.id) ?? null;
    result[row.id] = {
      customer: !row.customer_id
        ? { kind: "none" }
        : name !== undefined
          ? { kind: "named", name }
          : { kind: "hidden" },
      // The ledger view holds one row per order; a missing row is shown as
      // unknown (null), never as "nothing received".
      received: received
        ? { amount: received.amount, currency: received.currency as Currency }
        : null,
      delivery: canDeliveries
        ? {
            status: shown ? parseDeliveryStatus(shown.status) : null,
            readySince:
              shown && shown.status === "ready" ? (readySince.get(shown.id) ?? null) : null,
            cod: shown ? (shown.cod_amount_minor ?? 0) > 0 : false,
          }
        : null,
      assignedStaff: null,
    };
  }
  return result;
}
