import type { Customer, Order, Product, StatusKey } from "@/types";
import type { UiPayment } from "@/lib/payments";

/**
 * What Apsi is, precisely: a router with a search box.
 *
 * Apsi finds things the merchant already has — an order, a customer, a
 * product, a payment — and takes them there. It does not summarise, it does
 * not estimate, and it never answers with a number it computed itself. Every
 * row below is one record that exists, or one screen that exists; if neither
 * is true, Apsi says it found nothing rather than inventing something helpful.
 *
 * Pure functions over data the caller already loaded. No fetching, no
 * permissions, no i18n — the sheet supplies all three.
 */

export type ApsiEntityKind = "order" | "customer" | "product" | "payment";

export interface ApsiEntityResult {
  kind: ApsiEntityKind;
  id: string;
  /** The merchant's own text — an order code, a person's name. Never translated. */
  primary: string;
  /** Quiet second line: raw when it is data, empty when there is nothing to add. */
  secondary: string;
  /** Rendered through the shared status language, never as bare colour. */
  statuses: readonly StatusKey[];
  href: string;
}

export type ApsiCommandId =
  "unpaid-orders" | "payments-to-review" | "low-stock" | "recent-order" | "recent-customer";

export interface ApsiCommand {
  id: ApsiCommandId;
  /** Display label, already localized by the caller. */
  label: string;
  /** Lower-cased trigger words for this language, from the locale file. */
  keywords: readonly string[];
  href: string;
  /** A real count from real data, or undefined. Never a guess. */
  count?: number | undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Order codes get typed with or without a leading #; both must match. */
function normalizeCode(value: string): string {
  return normalize(value).replace(/^#/, "");
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function searchOrders(orders: readonly Order[], query: string): ApsiEntityResult[] {
  const q = normalizeCode(query);
  if (!q) return [];
  return orders
    .filter((order) => normalizeCode(order.code).includes(q))
    .map((order) => ({
      kind: "order" as const,
      id: order.id,
      primary: order.code,
      secondary: "",
      statuses: [
        ...(order.lifecycleStatus ? [order.lifecycleStatus] : []),
        order.paymentStatus,
      ] as StatusKey[],
      href: `/app/orders/${order.id}`,
    }));
}

export function searchCustomerRecords(
  customers: readonly Customer[],
  query: string,
): ApsiEntityResult[] {
  const q = normalize(query);
  if (!q) return [];
  const digits = digitsOf(q);
  return customers
    .filter((customer) => {
      if (normalize(customer.nameKm).includes(q)) return true;
      if (normalize(customer.nameEn).includes(q)) return true;
      return digits.length >= 3 && digitsOf(customer.phone).includes(digits);
    })
    .map((customer) => ({
      kind: "customer" as const,
      id: customer.id,
      primary: customer.nameKm || customer.nameEn,
      // The phone is already on screen for this member — Apsi adds no
      // disclosure of its own, it only repeats what the list read returned.
      secondary: customer.phone,
      statuses: [],
      href: `/app/customers/${customer.id}`,
    }));
}

export function searchProducts(products: readonly Product[], query: string): ApsiEntityResult[] {
  const q = normalize(query);
  if (!q) return [];
  return products
    .filter((product) => {
      if (normalize(product.nameKm).includes(q)) return true;
      if (normalize(product.nameEn).includes(q)) return true;
      if (normalize(product.sku).includes(q)) return true;
      return product.barcode ? normalize(product.barcode).includes(q) : false;
    })
    .map((product) => ({
      kind: "product" as const,
      id: product.id,
      primary: product.nameKm || product.nameEn,
      secondary: product.sku,
      statuses: [],
      href: `/app/products/${product.id}`,
    }));
}

export function searchPayments(payments: readonly UiPayment[], query: string): ApsiEntityResult[] {
  const q = normalize(query);
  if (!q) return [];
  return payments
    .filter((payment) => {
      // `reference` is null whenever the server withheld it. A withheld value
      // is not searchable here either — the browser never gets to match on
      // something it was deliberately not told.
      if (payment.reference && normalize(payment.reference).includes(q)) return true;
      return normalize(payment.id).startsWith(q);
    })
    .map((payment) => ({
      kind: "payment" as const,
      id: payment.id,
      primary: payment.reference ?? payment.id,
      secondary: "",
      statuses: [payment.status] as StatusKey[],
      href: `/app/payments/${payment.id}`,
    }));
}

export function matchCommands(commands: readonly ApsiCommand[], query: string): ApsiCommand[] {
  const q = normalize(query);
  if (!q) return [];
  return commands.filter(
    (command) =>
      normalize(command.label).includes(q) ||
      command.keywords.some((keyword) => keyword.includes(q) || q.includes(keyword)),
  );
}

export interface ApsiResults {
  commands: ApsiCommand[];
  entities: ApsiEntityResult[];
}

export interface ApsiSearchInput {
  query: string;
  commands: readonly ApsiCommand[];
  orders: readonly Order[];
  customers: readonly Customer[];
  products: readonly Product[];
  payments: readonly UiPayment[];
  /** Per kind, so one chatty domain cannot bury the other four. */
  perKindLimit?: number;
}

/**
 * Everything Apsi can offer for one query, ordered the way a merchant reads.
 *
 * Commands first: "show me the unpaid ones" is a whole task, and it is what
 * somebody typing three letters usually meant. Then orders, because an order
 * code is the most common thing anyone types into a box like this, then the
 * people, the things, and the money.
 */
export function runApsiSearch(input: ApsiSearchInput): ApsiResults {
  const limit = input.perKindLimit ?? 5;
  const entities = [
    ...searchOrders(input.orders, input.query).slice(0, limit),
    ...searchCustomerRecords(input.customers, input.query).slice(0, limit),
    ...searchProducts(input.products, input.query).slice(0, limit),
    ...searchPayments(input.payments, input.query).slice(0, limit),
  ];
  return { commands: matchCommands(input.commands, input.query), entities };
}
