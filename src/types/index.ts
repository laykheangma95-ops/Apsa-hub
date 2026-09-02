/**
 * APSA domain types. Pure TypeScript — no React, no UI concerns.
 */

export type Currency = "USD" | "KHR";

/** amount is ALWAYS an integer minor unit. USD = cents. KHR = riel (exponent 0). */
export type Money = { amount: number; currency: Currency };

export type Channel = "facebook" | "instagram" | "telegram" | "pos";

export type Language = "km" | "en";

export type Workspace = "business" | "creator";

export type StatusKey =
  | "unread"
  | "needs_reply"
  | "follow_up"
  | "waiting_customer"
  | "order_created"
  | "closed"
  | "pending_payment"
  | "paid"
  | "failed"
  | "refunded"
  | "confirmed"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned"
  | "low_stock"
  | "out_of_stock";

export type CompanionColor = "nilo" | "minto" | "vela" | "suri" | "luma";

export type SyncState = "online" | "offline" | "syncing" | "synced" | "sync_problem";

export interface Address {
  houseNo: string;
  street: string;
  sangkat: string;
  khan: string;
  city: string;
  landmark?: string;
}

export interface SocialIdentity {
  channel: Channel;
  handle: string;
}

export interface Customer {
  id: string;
  nameKm: string;
  nameEn: string;
  phone: string;
  identities: SocialIdentity[];
  tags: string[];
  note?: string;
  address?: Address;
  orderCount: number;
  lifetimeSpend: Money;
  lastPurchaseAt?: string;
  companion: CompanionColor;
}

export interface ProductVariantOption {
  name: string;
  values: string[];
}

export interface Product {
  id: string;
  nameKm: string;
  nameEn: string;
  sku: string;
  price: Money;
  stock: number;
  lowStockThreshold: number;
  options?: ProductVariantOption[];
  companion: CompanionColor;
  /** units held for confirmed-but-unfulfilled orders */
  reserved?: number;
  category?: ProductCategory;
  barcode?: string;
}

export type ProductCategory = "skincare" | "apparel" | "accessories" | "drinks";

export interface OrderItem {
  productId: string;
  nameKm: string;
  nameEn: string;
  variant?: string;
  quantity: number;
  unitPrice: Money;
}

export type PaymentStatus = "pending_payment" | "paid" | "failed" | "refunded";
export type FulfillmentStatus =
  | "confirmed"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned";

export interface Order {
  id: string;
  code: string;
  customerId: string;
  channel: Channel;
  items: OrderItem[];
  subtotal: Money;
  discount: Money;
  deliveryFee: Money;
  total: Money;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  createdAt: string;
}

export type MessageDirection = "inbound" | "outbound" | "system";
export type DeliveryState = "sending" | "sent" | "delivered" | "read" | "failed";

export interface Message {
  id: string;
  direction: MessageDirection;
  body: string;
  at: string;
  state?: DeliveryState;
}

export type ConversationStatus =
  | "unread"
  | "needs_reply"
  | "follow_up"
  | "waiting_customer"
  | "order_created"
  | "closed";

export interface Conversation {
  id: string;
  customerId: string;
  channel: Channel;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  status: ConversationStatus;
  assignedStaffId?: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export type StaffRole = "owner" | "manager" | "cashier" | "sales" | "customer_service";

export interface Staff {
  id: string;
  name: string;
  role: StaffRole;
  companion: CompanionColor;
}

export type PaymentMethod = "cash" | "khqr" | "bank_transfer" | "cod";

export interface Sale {
  id: string;
  code: string;
  items: OrderItem[];
  subtotal: Money;
  discount: Money;
  total: Money;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  customerId?: string;
  createdAt: string;
}

export interface Courier {
  id: string;
  name: string;
  fee: Money;
  speed: "same_day" | "next_day" | "express" | "instant";
}

export interface Shop {
  id: string;
  nameKm: string;
  nameEn: string;
  city: string;
}

export interface AttentionItem {
  id: "unread_conversations" | "awaiting_payment" | "awaiting_delivery" | "low_stock";
  count: number;
  tone: "info" | "warning" | "danger";
}

export interface MetricPoint {
  label: string;
  value: number;
}

export interface Metric {
  id: string;
  value: string;
  deltaPercent: number;
  series: MetricPoint[];
}

export type MetricRange = "today" | "week" | "month";

export interface HomeSummary {
  greetingName: string;
  revenue: Money;
  revenueDeltaPercent: number;
  revenueSeries: MetricPoint[];
  attention: AttentionItem[];
  metrics: Metric[];
}
