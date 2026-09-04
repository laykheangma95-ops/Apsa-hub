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
import { couriers, shops, staff, activeShopId, workspaces } from "@/lib/mock/shop";
import {
  customerEvents,
  customerNotes,
  deliveries,
  orderEvents,
  orderPayments,
} from "@/lib/mock/fulfillment";
import type {
  Conversation,
  ConversationDetail,
  ConversationStatus,
  Courier,
  Customer,
  CustomerEvent,
  CustomerNote,
  Delivery,
  DeliveryStatus,
  OrderEvent,
  PaymentRecord,
  StaffRole,
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
  WorkspaceSummary,
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

/* --------------------- Phase 4: order / customer / delivery -------------- */

export interface OrderDetail {
  order: Order;
  customer: Customer | null;
  events: OrderEvent[];
  payments: PaymentRecord[];
  delivery: Delivery | null;
  staffName: string | null;
}

/** Current session role. Mocked; a real app resolves it from auth. */
export const currentRole: StaffRole = "manager";

export async function getOrderDetail(id: string): Promise<OrderDetail> {
  const order = orders.find((o) => o.id === id || o.code === id);
  if (!order) throw new Error(`Order ${id} not found`);
  if (order.restricted) {
    await resolve(null, 140);
    throw new Error(PERMISSION_DENIED);
  }
  const detail: OrderDetail = {
    order,
    customer: customers.find((c) => c.id === order.customerId) ?? null,
    events: [...(orderEvents[order.id] ?? [])].sort((a, b) => b.at.localeCompare(a.at)),
    payments: orderPayments[order.id] ?? [],
    delivery: deliveries.find((d) => d.orderId === order.id) ?? null,
    staffName: staff.find((s) => s.id === order.staffId)?.name ?? null,
  };
  return resolve(detail);
}

export async function getOrders(): Promise<Order[]> {
  return resolve([...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export interface DeliveryDetail {
  delivery: Delivery;
  order: Order | null;
  customer: Customer | null;
}

export async function getDeliveryDetail(id: string): Promise<DeliveryDetail> {
  const delivery = deliveries.find((d) => d.id === id || d.trackingNumber === id);
  if (!delivery) throw new Error(`Delivery ${id} not found`);
  if (delivery.restricted) {
    await resolve(null, 140);
    throw new Error(PERMISSION_DENIED);
  }
  return resolve({
    delivery,
    order: orders.find((o) => o.id === delivery.orderId) ?? null,
    customer: customers.find((c) => c.id === delivery.customerId) ?? null,
  });
}

export interface Customer360 {
  customer: Customer;
  orders: Order[];
  events: CustomerEvent[];
  notes: CustomerNote[];
  activeConversationId: string | null;
}

export async function getCustomer360(id: string): Promise<Customer360> {
  const { getCustomer360Fn } = await import("@/api/customers");
  const result = await getCustomer360Fn({ data: { id } });
  // Cast: service returns the same shape the UI expects (Customer360).
  return result as unknown as Customer360;
}

export async function addCustomerNote(customerId: string, body: string): Promise<CustomerNote> {
  const { addCustomerNoteFn } = await import("@/api/customers");
  const note = await addCustomerNoteFn({ data: { customerId, body } });
  return note as unknown as CustomerNote;
}

export interface RecordPaymentInput {
  orderId: string;
  method: PaymentMethod;
  amount: Money;
  reference?: string;
}

/** Manual confirmation only — APSA never claims a provider verified the money. */
export async function recordPayment(input: RecordPaymentInput): Promise<PaymentRecord> {
  return resolve(
    {
      id: `pay-new-${Date.now()}`,
      method: input.method,
      amount: input.amount,
      status: "paid",
      ...(input.reference ? { reference: input.reference } : {}),
      confirmedManuallyBy: staff[0]?.name ?? "Staff",
      at: new Date().toISOString(),
    },
    240,
  );
}

export interface ReturnInput {
  orderId: string;
  reason: string;
  restock: boolean;
}

/** Return moves goods. It never moves money — refund is a separate decision. */
export async function createReturn(input: ReturnInput): Promise<OrderEvent> {
  return resolve(
    {
      id: `oe-new-${Date.now()}`,
      kind: "returned",
      at: new Date().toISOString(),
      actor: staff[0]?.name ?? "Staff",
      context: input.reason,
    },
    240,
  );
}

export interface RefundInput {
  orderId: string;
  amount: Money;
  method: PaymentMethod;
  reason: string;
}

/** Refund moves money. It never assumes the goods came back. */
export async function createRefund(input: RefundInput): Promise<PaymentRecord> {
  if (input.amount.amount <= 0) throw new Error("invalid_amount");
  return resolve(
    {
      id: `pay-ref-${Date.now()}`,
      method: input.method,
      amount: input.amount,
      status: "refunded",
      confirmedManuallyBy: staff[0]?.name ?? "Staff",
      at: new Date().toISOString(),
    },
    240,
  );
}

export interface ArrangeDeliveryInput {
  orderId: string;
  courierId: string;
}

/** Mock delivery request. No courier API is contacted. */
export async function arrangeDelivery(input: ArrangeDeliveryInput): Promise<Delivery> {
  const order = orders.find((o) => o.id === input.orderId);
  const courier = couriers.find((c) => c.id === input.courierId) ?? couriers[0]!;
  return resolve(
    {
      id: `dlv-new-${Date.now()}`,
      orderId: input.orderId,
      orderCode: order?.code ?? "",
      customerId: order?.customerId ?? "",
      courierId: courier.id,
      courierName: courier.name,
      trackingNumber: `TMP-${Date.now().toString().slice(-6)}`,
      status: "requested",
      fee: courier.fee,
      events: [{ id: `de-new-${Date.now()}`, status: "requested", at: new Date().toISOString() }],
    },
    240,
  );
}

export type DeliveryAction = "retry" | "reschedule" | "return_to_shop" | "mark_delivered";

/** Mock delivery action. Returns the delivery's next status. */
export async function applyDeliveryAction(
  deliveryId: string,
  action: DeliveryAction,
): Promise<DeliveryStatus> {
  const next: DeliveryStatus =
    action === "mark_delivered" ? "delivered" : action === "return_to_shop" ? "cancelled" : "in_transit";
  void deliveryId;
  return resolve(next, 220);
}

/* ---------------------------------------------------------------------------
 * Phase 5 — workspaces, team and mock invitations.
 * All in-memory. No invitation is ever delivered.
 * ------------------------------------------------------------------------- */

let teamMembers: Staff[] = [...staff];
let workspaceList: WorkspaceSummary[] = workspaces.map((w) => ({ ...w }));

export async function getWorkspaces(): Promise<WorkspaceSummary[]> {
  return resolve(workspaceList.map((w) => ({ ...w })));
}

export async function switchWorkspace(id: string): Promise<WorkspaceSummary> {
  workspaceList = workspaceList.map((w) => ({ ...w, active: w.id === id }));
  const next = workspaceList.find((w) => w.id === id) ?? workspaceList[0]!;
  return resolve({ ...next }, 220);
}

export async function getTeam(): Promise<Staff[]> {
  return resolve(teamMembers.map((m) => ({ ...m })));
}

export interface InviteStaffInput {
  name: string;
  contact: string;
  role: StaffRole;
}

/** Mock invite. Owner can never be granted through this flow. */
export async function inviteStaff(input: InviteStaffInput): Promise<Staff> {
  if (input.role === "owner") throw new Error(PERMISSION_DENIED);
  const isEmail = input.contact.includes("@");
  const member: Staff = {
    id: `staff-${Date.now()}`,
    name: input.name,
    role: input.role,
    companion: "minto",
    status: "invited",
    shopId: activeShopId,
    invitedAt: new Date().toISOString(),
    ...(isEmail ? { email: input.contact } : { phone: input.contact }),
  };
  teamMembers = [...teamMembers, member];
  return resolve({ ...member }, 260);
}

function isFinalOwner(id: string): boolean {
  const member = teamMembers.find((m) => m.id === id);
  if (!member || member.role !== "owner") return false;
  return teamMembers.filter((m) => m.role === "owner").length <= 1;
}

export async function changeStaffRole(id: string, role: StaffRole): Promise<Staff> {
  if (isFinalOwner(id) || role === "owner") throw new Error(PERMISSION_DENIED);
  teamMembers = teamMembers.map((m) => (m.id === id ? { ...m, role } : m));
  const member = teamMembers.find((m) => m.id === id)!;
  return resolve({ ...member }, 220);
}

export async function removeStaff(id: string): Promise<string> {
  if (isFinalOwner(id)) throw new Error(PERMISSION_DENIED);
  teamMembers = teamMembers.filter((m) => m.id !== id);
  return resolve(id, 220);
}

export async function resendInvite(id: string): Promise<string> {
  return resolve(id, 200);
}

export async function cancelInvite(id: string): Promise<string> {
  teamMembers = teamMembers.filter((m) => m.id !== id);
  return resolve(id, 200);
}
