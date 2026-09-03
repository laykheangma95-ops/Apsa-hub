/**
 * APSA domain types. Pure TypeScript — no React, no UI concerns.
 */

// ── Production tenancy types ──────────────────────────────────────────────────

export type OrganizationStatus = "active" | "suspended" | "deleted";
export type WorkspaceType = "INBOX" | "BUSINESS";
export type WorkspaceStatus = "active" | "archived";
export type LocationType = "branch" | "warehouse" | "virtual";
export type LocationStatus = "active" | "closed";
export type MembershipStatus = "active" | "invited" | "suspended" | "removed";
export type SystemRoleKey = "OWNER" | "MANAGER" | "CASHIER" | "SALES" | "CUSTOMER_SERVICE";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type UserStatus = "active" | "suspended" | "deleted";

/** Platform user profile (extends Supabase Auth). */
export interface UserProfile {
  id: string;
  email: string;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

/** Root tenant entity. All business data is scoped to an Organization. */
export interface Organization {
  id: string;
  legalName: string;
  displayName: string;
  slug: string;
  businessType: string | null;
  defaultCurrency: Currency;
  country: string;
  timezone: string;
  status: OrganizationStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Workspace — logical grouping within an Organization.
 * INBOX: social-commerce channels (Facebook, Telegram, etc.)
 * BUSINESS: operational areas (POS, Inventory, etc.)
 */
export interface ProductionWorkspace {
  id: string;
  organizationId: string;
  name: string;
  type: WorkspaceType;
  status: WorkspaceStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Physical or virtual location belonging to a Workspace/Organization. */
export interface Location {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  name: string;
  type: LocationType;
  phone: string | null;
  timezone: string;
  status: LocationStatus;
  createdAt: string;
}

/** User ↔ Organization membership with role assignment. */
export interface Membership {
  id: string;
  userId: string;
  organizationId: string;
  roleId: string;
  status: MembershipStatus;
  joinedAt: string;
  invitedBy: string | null;
}

/** Role template (system) or custom org role. */
export interface Role {
  id: string;
  organizationId: string | null;
  name: string;
  systemRole: SystemRoleKey | null;
  createdAt: string;
}

/** Permission key definition. Naming: domain.action */
export interface Permission {
  id: string;
  key: string;
  description: string;
  riskLevel: RiskLevel;
}

/** Resolved membership context — used in server auth layer. */
export interface MembershipWithRole extends Membership {
  role: Role;
  permissions: string[];
}

// ── Money / Currency ──────────────────────────────────────────────────────────

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
  | "partially_paid"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "requested"
  | "accepted"
  | "picked_up"
  | "confirmed"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned"
  | "low_stock"
  | "out_of_stock"
  | "active"
  | "invited";

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

export type PaymentStatus =
  | "pending_payment"
  | "partially_paid"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded";
export type FulfillmentStatus =
  | "confirmed"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned";

/** Where the order came from. POS and manual entry are not social channels. */
export type OrderSource = Channel | "manual";

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
  source?: OrderSource;
  /** staff member who handled the order */
  staffId?: string;
  /** mock permission flag — some orders are not visible to this role */
  restricted?: boolean;
}

/** Business-language event kinds. Never raw machine names in the UI. */
export type OrderEventKind =
  | "created"
  | "payment_confirmed"
  | "payment_failed"
  | "packing_started"
  | "ready"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned"
  | "refunded"
  | "note";

export interface OrderEvent {
  id: string;
  kind: OrderEventKind;
  at: string;
  actor?: string;
  context?: string;
}

export interface PaymentRecord {
  id: string;
  method: PaymentMethod;
  amount: Money;
  status: PaymentStatus;
  reference?: string;
  /** manual confirmation by a staff member — never a provider verification */
  confirmedManuallyBy?: string;
  at: string;
}

export type DeliveryStatus =
  | "requested"
  | "accepted"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled";

export type DeliveryFailureReason =
  | "customer_unavailable"
  | "wrong_address"
  | "customer_rejected"
  | "courier_issue";

export interface DeliveryEvent {
  id: string;
  status: DeliveryStatus;
  at: string;
  context?: string;
}

export interface Delivery {
  id: string;
  orderId: string;
  orderCode: string;
  customerId: string;
  courierId: string;
  courierName: string;
  trackingNumber: string;
  status: DeliveryStatus;
  fee: Money;
  codAmount?: Money;
  /** courier holds the cash until settlement — delivered never means paid out */
  codCollected?: boolean;
  settlementPending?: boolean;
  address?: Address;
  failureReason?: DeliveryFailureReason;
  events: DeliveryEvent[];
  restricted?: boolean;
}

export interface CustomerNote {
  id: string;
  customerId: string;
  body: string;
  staffName: string;
  at: string;
}

export type CustomerEventKind =
  | "message_received"
  | "conversation_opened"
  | "order_created"
  | "payment_confirmed"
  | "delivery_created"
  | "delivered"
  | "note_added";

export interface CustomerEvent {
  id: string;
  kind: CustomerEventKind;
  at: string;
  context?: string;
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

export type StaffStatus = "active" | "invited";

export interface Staff {
  id: string;
  name: string;
  role: StaffRole;
  companion: CompanionColor;
  status?: StaffStatus;
  phone?: string;
  email?: string;
  shopId?: string;
  invitedAt?: string;
}

/** A business context the signed-in person can operate in. */
export interface WorkspaceSummary {
  id: string;
  nameKm: string;
  nameEn: string;
  city: string;
  type: Workspace;
  role: StaffRole;
  active: boolean;
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
