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

export type Channel = "facebook" | "instagram" | "telegram" | "pos" | "other";

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
  | "invited"
  // Production Order domain (src/server/orders/state-machine.ts). Distinct
  // vocabulary from the mock statuses above — see that file for why.
  | "draft"
  | "completed"
  | "unpaid"
  | "pending"
  | "unfulfilled"
  | "processing"
  | "fulfilled"
  // Production Delivery domain (src/server/deliveries/state-machine.ts).
  | "preparing";

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
  /** Empty string when caller lacks customers.view_sensitive (server path). Undefined = mock path (always visible). */
  phone: string;
  identities: SocialIdentity[];
  tags: string[];
  note?: string;
  address?: Address;
  orderCount: number;
  lifetimeSpend: Money;
  lastPurchaseAt?: string;
  companion: CompanionColor;
  /**
   * Server-authoritative: true = caller has customers.view_sensitive; false = sensitive fields
   * are hidden (phone is "", address is absent). Undefined on mock data path — treat as visible.
   */
  sensitiveVisible?: boolean;
}

export interface ProductVariantOption {
  name: string;
  values: string[];
}

export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export interface Product {
  id: string;
  nameKm: string;
  nameEn: string;
  sku: string;
  price: Money;
  /**
   * null when coming from the production server path — inventory is a separate domain.
   * number when coming from the mock data path.
   * UI should call availableStock() rather than reading this directly.
   */
  stock: number | null;
  lowStockThreshold: number;
  options?: ProductVariantOption[];
  companion: CompanionColor;
  /** units held for confirmed-but-unfulfilled orders (mock path only) */
  reserved?: number;
  category?: ProductCategory;
  barcode?: string;
  /** Present on the production path — the DB UUID of the category. */
  categoryId?: string;
  /** Present on the production path — the variant DB UUID. */
  variantId?: string;
  /**
   * Present on the production path ONLY when the product has more than one
   * ACTIVE variant — the full sellable list (POS/order-create must let the
   * merchant choose explicitly rather than defaulting to the first one).
   * A single-variant production product leaves this unset; `variantId`/`sku`/
   * `price` above already describe its one variant.
   */
  productionVariants?: ProductionVariant[];
}

/**
 * One row of the production Product domain's flat variant list
 * (src/server/products/service.ts ProductVariantDetail, PII/cost already
 * stripped). Unlike the mock ProductVariantOption model there is no
 * name/values attribute matrix — a real variant is just a priced, named SKU.
 */
export interface ProductionVariant {
  variantId: string;
  /** Free-text variant name as recorded on the product (e.g. "Red / L"). */
  name: string;
  sku: string;
  price: Money;
}

/** Legacy mock-data category union — kept for backward compatibility. */
export type ProductCategory = "skincare" | "apparel" | "accessories" | "drinks";

/** Production category record returned from the DB. */
export interface ProductCategoryRecord {
  id: string;
  organizationId: string;
  parentId: string | null;
  nameKm: string;
  nameEn: string | null;
  sortOrder: number;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  nameKm: string;
  nameEn: string;
  variant?: string;
  quantity: number;
  unitPrice: Money;
  /** Present on the production path — the variant DB UUID. */
  variantId?: string;
  /** Present on the production path — catalog SKU snapshot at sale time. */
  sku?: string | null;
  /** Present on the production path — server-computed line total. */
  lineTotal?: Money;
}

/**
 * `pending_payment` .. `partially_refunded` are the legacy mock vocabulary.
 * `unpaid` / `pending` are the production Order domain's payment axis
 * (src/server/orders/state-machine.ts) — a different, narrower vocabulary
 * kept alongside the mock one rather than merged into it (see that file for
 * why "pending_payment" was not adopted as-is).
 */
export type PaymentStatus =
  | "pending_payment"
  | "partially_paid"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "unpaid"
  | "pending";

/**
 * `confirmed` .. `returned` are the legacy mock vocabulary (courier-granularity
 * states). `unfulfilled` / `processing` / `fulfilled` are the production
 * Order domain's fulfillment axis — see src/server/orders/state-machine.ts.
 */
export type FulfillmentStatus =
  | "confirmed"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "returned"
  | "unfulfilled"
  | "processing"
  | "fulfilled";

/** The production Order domain's lifecycle axis — absent from the mock model. */
export type OrderLifecycleStatus = "draft" | "confirmed" | "completed" | "cancelled";

/** Where the order came from. POS and manual entry are not social channels. */
export type OrderSource = Channel | "manual";

/** One entry in an order's immutable status-change trail (production path only). */
export interface OrderStatusHistoryEntry {
  id: string;
  axis: "lifecycle" | "payment" | "fulfillment";
  fromStatus: string;
  toStatus: string;
  changedBy: string | null;
  reason: string | null;
  changedAt: string;
}

export interface Order {
  id: string;
  code: string;
  /** null on the production path when the order has no linked customer. */
  customerId: string | null;
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
  /** Present on the production path — the order's lifecycle-axis status. */
  lifecycleStatus?: OrderLifecycleStatus;
  /** Present on the production path — the order's immutable status trail. */
  statusHistory?: OrderStatusHistoryEntry[];
  /** Present on the production path — the DB UUID of the location, if any. */
  locationId?: string | null;
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
  "requested" | "accepted" | "picked_up" | "in_transit" | "delivered" | "failed" | "cancelled";

export type DeliveryFailureReason =
  "customer_unavailable" | "wrong_address" | "customer_rejected" | "courier_issue";

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
  "unread" | "needs_reply" | "follow_up" | "waiting_customer" | "order_created" | "closed";

export interface Conversation {
  id: string;
  /** "" when this conversation has no resolved customer yet (production path). */
  customerId: string;
  /**
   * Non-sensitive display name for the linked customer, from the production
   * server path only (mock path resolves the name locally via getCustomers()).
   * Lets the Inbox list render a name without an N+1 customer lookup per row.
   */
  customerName?: string;
  provider?: string;
  providerConversationId?: string;
  assignedStaffName?: string;
  channel: Channel;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  status: ConversationStatus;
  assignedStaffId?: string;
}

export interface ConversationDetail extends Conversation {
  nextBeforeId?: string | null;
  readThroughMessageId?: string | null;
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
