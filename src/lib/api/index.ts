/**
 * The only data boundary. Components call these functions.
 * When a real backend arrives, only the bodies change.
 */
import { usd } from "@/lib/money";
import { mapOrderDetailToUi, mapOrderSummaryToUi, type RealOrderDetail } from "@/lib/orders";
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

/**
 * Returns true for RFC-4122 UUID strings (production customer IDs).
 * Non-UUID IDs (e.g. "cus-1") are mock IDs from the Inbox/Orders flows that
 * are not yet productionized. They bypass the server function validator so UUID
 * validation is never weakened — mock IDs simply never reach the server boundary.
 */
export function isProductionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
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

/** Server product shape returned by listProductsFn / getProductDetailFn. */
interface ServerProductItem {
  id: string;
  nameKm: string;
  nameEn: string | null;
  categoryId: string | null;
  stock: null;
  companion: Product["companion"];
  variants: Array<{
    id: string;
    sku: string | null;
    barcode: string | null;
    price: { amount: number; currency: "USD" | "KHR" };
    cost: { amount: number; currency: "USD" | "KHR" } | null;
  }>;
}

const COMPANION_COLORS: Array<Product["companion"]> = ["nilo", "minto", "vela", "suri", "luma"];

/** Map a server ProductDetail to the UI Product type.
 * Uses the first active variant for sku/price/barcode.
 * stock = null because inventory is a separate domain.
 */
function mapServerProductToUi(p: ServerProductItem): Product {
  const firstVariant = p.variants[0];
  const sum = p.id
    .slice(-12)
    .split("")
    .reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
  const companion = COMPANION_COLORS[sum % COMPANION_COLORS.length]!;
  const mapped: Product = {
    id: p.id,
    nameKm: p.nameKm,
    nameEn: p.nameEn ?? p.nameKm,
    sku: firstVariant?.sku ?? "",
    price: firstVariant?.price ?? { amount: 0, currency: "USD" },
    stock: null,
    lowStockThreshold: 0,
    companion,
  };
  if (firstVariant?.barcode) mapped.barcode = firstVariant.barcode;
  if (p.categoryId) mapped.categoryId = p.categoryId;
  if (firstVariant?.id) mapped.variantId = firstVariant.id;
  return mapped;
}

/**
 * Returns true ONLY for errors that are structurally impossible in production:
 *   - TanStack Start runtime not found: server function called outside the HTTP
 *     runtime (e.g. bun test, Storybook). This never occurs in production
 *     because the server function middleware is always active there.
 *
 * UnauthorizedError (no session) is NOT a demo-mode fallback: a real auth or
 * backend outage can produce it in production, so it must propagate as an error
 * rather than be silently hidden behind mock data.
 *
 * All other errors — DB failures, ForbiddenError, UnauthorizedError, 5xx — must
 * propagate so production failures are visible rather than silently hidden
 * behind mock data.
 */
function isDemoModeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // TanStack Start server function called outside its runtime (test / Storybook).
  // This is structurally impossible in production where the middleware is always active.
  if (err.message.includes("No Start context") || err.message.includes("AsyncLocalStorage")) {
    return true;
  }
  return false;
}

export async function getProducts(): Promise<Product[]> {
  try {
    const { listProductsFn } = await import("@/api/products");
    const serverProducts = await listProductsFn({ data: { status: "ACTIVE" } });
    return (serverProducts as ServerProductItem[]).map(mapServerProductToUi);
  } catch (err) {
    if (isDemoModeError(err)) return resolve(products);
    throw err;
  }
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

/* ----------------------------- POS ---------------------------------------- */

export async function getPosProducts(): Promise<Product[]> {
  try {
    const { listProductsFn } = await import("@/api/products");
    const serverProducts = await listProductsFn({ data: { status: "ACTIVE" } });
    return (serverProducts as ServerProductItem[]).map(mapServerProductToUi);
  } catch (err) {
    if (isDemoModeError(err)) return resolve(products);
    throw err;
  }
}

/**
 * Barcode lookup — org-scoped, exact match only.
 * Returns null only for genuine not-found.
 * Auth, permission, DB, and server errors propagate as real errors.
 */
export async function lookupProductByBarcode(barcode: string): Promise<Product | null> {
  const { lookupByBarcodeFn } = await import("@/api/products");
  const result = await lookupByBarcodeFn({ data: { barcode } });
  if (!result) return null;
  return mapServerProductToUi(result.product as ServerProductItem);
}

/**
 * SKU lookup — org-scoped, exact match only.
 * Returns null only for genuine not-found.
 * Auth, permission, DB, and server errors propagate as real errors.
 */
export async function lookupProductBySku(sku: string): Promise<Product | null> {
  const { lookupBySkuFn } = await import("@/api/products");
  const result = await lookupBySkuFn({ data: { sku } });
  if (!result) return null;
  return mapServerProductToUi(result.product as ServerProductItem);
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

/* --------------- Real Order UI Integration (production Order domain) ------
 *
 * These four functions are the ONLY way UI code reaches the production Order
 * domain. Each is a thin wrapper: call the TanStack server function, map the
 * result with src/lib/orders.ts, return it. No try/catch, no demo-mode
 * fallback — unlike getProducts()/getPosProducts() above, a real order id is
 * never allowed to fall back to mock data (there is no legitimate reason a
 * UUID order lookup fails except "it really doesn't exist/isn't yours",
 * which the server already reports as a clean 404).
 *
 * organizationId/userId are never parameters here — the server functions
 * derive both from the session, exactly as src/api/orders.ts requires.
 */

/** Production Order list — src/routes/app.orders.tsx. Newest first, org-scoped by the server. */
export async function listRealOrders(): Promise<Order[]> {
  const { listOrdersFn } = await import("@/api/orders");
  const rows = await listOrdersFn({ data: {} });
  return rows.map(mapOrderSummaryToUi);
}

/** Production Order detail — src/routes/app.orders.$id.tsx (real-UUID branch). */
export async function getRealOrderDetail(orderId: string): Promise<RealOrderDetail> {
  const { getOrderByIdFn } = await import("@/api/orders");
  const detail = await getOrderByIdFn({ data: { orderId } });
  return mapOrderDetailToUi(detail);
}

export interface CreateRealOrderInput {
  source: "POS" | "FACEBOOK" | "INSTAGRAM" | "TELEGRAM" | "MANUAL";
  items: Array<{ variantId: string; quantity: number; productId?: string }>;
  customerId?: string | null;
  /** Integer minor units in the org's currency — bounded and priced server-side. */
  discountMinor?: number;
}

/**
 * Create a new order. The server derives every price from the catalog; this
 * function's input has no field for a price, subtotal or total (see
 * src/api/orders.ts's own comment on why one must never be added).
 */
export async function createRealOrder(input: CreateRealOrderInput): Promise<RealOrderDetail> {
  const { createOrderFn } = await import("@/api/orders");
  const detail = await createOrderFn({ data: input });
  return mapOrderDetailToUi(detail);
}

/** Confirm flow (requirement 4): draft -> confirmed. Consumes stock server-side (migration 026). */
export async function confirmRealOrder(orderId: string): Promise<RealOrderDetail> {
  const { transitionOrderLifecycleFn } = await import("@/api/orders");
  const detail = await transitionOrderLifecycleFn({ data: { orderId, to: "confirmed" } });
  return mapOrderDetailToUi(detail);
}

/** Cancel flow (requirement 5): draft|confirmed -> cancelled. Restores stock server-side when it applies. */
export async function cancelRealOrder(orderId: string, reason?: string): Promise<RealOrderDetail> {
  const { transitionOrderLifecycleFn } = await import("@/api/orders");
  const detail = await transitionOrderLifecycleFn({
    data: { orderId, to: "cancelled", ...(reason ? { reason } : {}) },
  });
  return mapOrderDetailToUi(detail);
}

/**
 * Row shape for the create-order flow's optional customer picker.
 *
 * Deliberately NOT the full mock `Customer` type (identities/tags/orderCount/
 * lifetimeSpend/companion do not exist for a production list read and have no
 * honest value to fill in here) — a small, explicit, typed server->UI shape
 * instead of a cast. `phone` is already PII-gated server-side by
 * listCustomers() (src/server/customers/service.ts): "" means either no
 * phone on file or the caller lacks customers.view_sensitive — the UI cannot
 * tell which and must not guess, and never decides this itself.
 */
export interface OrderCustomerOption {
  id: string;
  nameKm: string;
  nameEn: string;
  phone: string;
  sensitiveVisible: boolean;
}

/** Lightweight customer list for the create-order flow's optional customer picker. */
export async function listRealCustomers(): Promise<OrderCustomerOption[]> {
  const { listCustomersFn } = await import("@/api/customers");
  return listCustomersFn({ data: { limit: 100, status: "active" } });
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
  if (!isProductionId(id)) {
    // Non-UUID mock ID (e.g. "cus-1") — use in-memory mock data.
    // The server function UUID validator is not weakened; mock IDs never reach it.
    // This bridge exists until Inbox/Orders are productionized and emit real UUIDs.
    const customer = customers.find((c) => c.id === id);
    if (!customer) throw new Error(`Customer ${id} not found`);
    return resolve({
      customer,
      orders: orders
        .filter((o) => o.customerId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      events: customerEvents[id] ?? [],
      notes: customerNotes.filter((n) => n.customerId === id),
      activeConversationId: null,
    });
  }
  const { getCustomer360Fn } = await import("@/api/customers");
  const result = await getCustomer360Fn({ data: { id } });
  return result as unknown as Customer360;
}

export async function addCustomerNote(customerId: string, body: string): Promise<CustomerNote> {
  if (!isProductionId(customerId)) {
    // Non-UUID mock ID — return an in-memory note; not persisted.
    return resolve(
      {
        id: `cn-${Date.now()}`,
        customerId,
        body,
        staffName: "Staff",
        at: new Date().toISOString(),
      },
      200,
    );
  }
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
    action === "mark_delivered"
      ? "delivered"
      : action === "return_to_shop"
        ? "cancelled"
        : "in_transit";
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
