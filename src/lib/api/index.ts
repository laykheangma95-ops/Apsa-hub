/**
 * The only data boundary. Components call these functions.
 * When a real backend arrives, only the bodies change.
 */
import { usd } from "@/lib/money";
import { conversations, conversationMessages } from "@/lib/mock/conversations";
import { customers } from "@/lib/mock/customers";
import { products } from "@/lib/mock/products";
import { homeSummaries } from "@/lib/mock/home";
import { orders, nextOrderSequence } from "@/lib/mock/orders";
import { couriers, shops, staff, activeShopId } from "@/lib/mock/shop";
import type {
  Conversation,
  ConversationDetail,
  ConversationStatus,
  Courier,
  Customer,
  HomeSummary,
  MetricRange,
  Money,
  Order,
  OrderItem,
  PaymentMethod,
  Sale,
  Product,
  Shop,
  Staff,
} from "@/types";

const LATENCY = 180;

function resolve<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

export interface ConversationFilter {
  status?: ConversationStatus | "all";
  channel?: Conversation["channel"] | "all";
  query?: string;
}

export async function getHomeSummary(range: MetricRange = "today"): Promise<HomeSummary> {
  return resolve(homeSummaries[range]);
}

export async function getConversations(filter?: ConversationFilter): Promise<Conversation[]> {
  let list = [...conversations];
  if (filter?.status && filter.status !== "all") {
    list = list.filter((c) => c.status === filter.status);
  }
  if (filter?.channel && filter.channel !== "all") {
    list = list.filter((c) => c.channel === filter.channel);
  }
  if (filter?.query) {
    const q = filter.query.trim().toLowerCase();
    if (q) {
      const matchingCustomers = new Set(
        customers
          .filter(
            (c) =>
              c.nameKm.toLowerCase().includes(q) ||
              c.nameEn.toLowerCase().includes(q) ||
              c.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")),
          )
          .map((c) => c.id),
      );
      list = list.filter(
        (c) => c.lastMessage.toLowerCase().includes(q) || matchingCustomers.has(c.customerId),
      );
    }
  }
  return resolve(list);
}

/** Counts per status for the inbox filter chips, ignoring the status filter itself. */
export async function getConversationCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = { all: conversations.length };
  for (const conversation of conversations) {
    counts[conversation.status] = (counts[conversation.status] ?? 0) + 1;
  }
  return resolve(counts, 80);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const conversation = conversations.find((c) => c.id === id);
  if (!conversation) throw new Error(`Conversation ${id} not found`);
  return resolve({ ...conversation, messages: conversationMessages[id] ?? [] });
}

export async function getCustomers(): Promise<Customer[]> {
  return resolve(customers);
}

export async function getCustomer(id: string): Promise<Customer> {
  const customer = customers.find((c) => c.id === id);
  if (!customer) throw new Error(`Customer ${id} not found`);
  return resolve(customer);
}

export async function getCustomerOrders(customerId: string): Promise<Order[]> {
  const list = orders
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return resolve(list);
}

export async function getProducts(): Promise<Product[]> {
  return resolve(products);
}

/** Recently sold products, shown first in the product picker. */
export async function getRecentProducts(): Promise<Product[]> {
  const recentIds = ["prd-3", "prd-2", "prd-1"];
  const ranked = [...products].sort(
    (a, b) =>
      (recentIds.indexOf(a.id) === -1 ? 99 : recentIds.indexOf(a.id)) -
      (recentIds.indexOf(b.id) === -1 ? 99 : recentIds.indexOf(b.id)),
  );
  return resolve(ranked);
}

export async function getCouriers(): Promise<Courier[]> {
  return resolve(couriers);
}

export async function getShops(): Promise<Shop[]> {
  return resolve(shops);
}

export async function getActiveShop(): Promise<Shop> {
  const shop = shops.find((s) => s.id === activeShopId) ?? shops[0]!;
  return resolve(shop);
}

export async function getStaff(): Promise<Staff[]> {
  return resolve(staff);
}

export interface CreateOrderInput {
  customerId: string;
  channel: Conversation["channel"];
  items: OrderItem[];
  subtotal: Money;
  discount: Money;
  deliveryFee: Money;
  total: Money;
}

let orderSequence = nextOrderSequence;

/** Staff cannot approve high-value orders; mocked here, not in components. */
export const ORDER_APPROVAL_LIMIT_CENTS = 50_000;
export const PERMISSION_DENIED = "permission_denied";

/** Mock order creation. Returns the created order; nothing is persisted. */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  if (input.total.amount > ORDER_APPROVAL_LIMIT_CENTS) {
    await resolve(null, 160);
    throw new Error(PERMISSION_DENIED);
  }
  const code = `APSA-${String(orderSequence++).padStart(4, "0")}`;
  const order: Order = {
    id: `ord-${code}`,
    code,
    customerId: input.customerId,
    channel: input.channel,
    items: input.items,
    subtotal: input.subtotal,
    discount: input.discount,
    deliveryFee: input.deliveryFee,
    total: input.total,
    paymentStatus: "pending_payment",
    fulfillmentStatus: "confirmed",
    createdAt: new Date().toISOString(),
  };
  return resolve(order, 240);
}

/* ----------------------------- POS (mock only) ---------------------------- */

export async function getPosProducts(): Promise<Product[]> {
  return resolve(products);
}

export async function searchCustomers(query: string): Promise<Customer[]> {
  const q = query.trim().toLowerCase();
  if (!q) return resolve(customers.slice(0, 4), 80);
  const digits = q.replace(/\s/g, "");
  return resolve(
    customers.filter(
      (c) =>
        c.nameKm.toLowerCase().includes(q) ||
        c.nameEn.toLowerCase().includes(q) ||
        c.phone.replace(/\s/g, "").includes(digits),
    ),
    80,
  );
}

export interface QuickCustomerInput {
  name: string;
  phone: string;
}

/** Mock quick-create. Nothing is persisted beyond this session's return value. */
export async function createQuickCustomer(input: QuickCustomerInput): Promise<Customer> {
  const customer: Customer = {
    id: `cus-new-${Date.now()}`,
    nameKm: input.name,
    nameEn: input.name,
    phone: input.phone,
    identities: [{ channel: "pos", handle: input.phone }],
    tags: [],
    orderCount: 0,
    lifetimeSpend: usd(0),
    companion: "nilo",
  };
  return resolve(customer, 200);
}

export interface CreateSaleInput {
  items: OrderItem[];
  subtotal: Money;
  discount: Money;
  total: Money;
  paymentMethod: PaymentMethod;
  customerId?: string;
}

/** Mock sale creation. COD is never financially settled. */
export async function createSale(input: CreateSaleInput): Promise<Sale> {
  const code = `APSA-${String(orderSequence++).padStart(4, "0")}`;
  const sale: Sale = {
    id: `sal-${code}`,
    code,
    items: input.items,
    subtotal: input.subtotal,
    discount: input.discount,
    total: input.total,
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentMethod === "cod" ? "pending_payment" : "paid",
    ...(input.customerId ? { customerId: input.customerId } : {}),
    createdAt: new Date().toISOString(),
  };
  return resolve(sale, 260);
}
