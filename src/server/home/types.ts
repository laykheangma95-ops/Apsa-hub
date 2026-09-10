import type { Currency } from "@/types";
import type { DeliveryStatus } from "@/server/deliveries/state-machine";
import type {
  OrderFulfillmentStatus,
  OrderLifecycleStatus,
  OrderPaymentStatus,
  OrderRefundStatus,
} from "@/server/orders/state-machine";

export type HomeRange = "today" | "week" | "month";

export interface HomeOrderRow {
  id: string;
  organization_id: string;
  total_minor: number;
  currency: Currency;
  lifecycle_status: OrderLifecycleStatus;
  payment_status: OrderPaymentStatus;
  refund_status: OrderRefundStatus;
  fulfillment_status: OrderFulfillmentStatus;
  created_at: string;
}

export interface HomeSettlementRow {
  order_id: string;
  organization_id: string;
  currency: Currency;
  net_minor: number;
}

export interface HomeStockRow {
  organization_id: string;
  product_id: string;
  variant_id: string;
  quantity_on_hand: number;
}

export interface HomeDeliveryRow {
  id: string;
  organization_id: string;
  order_id: string;
  status: DeliveryStatus;
}

export interface HomeRows {
  periodOrders: HomeOrderRow[];
  activeOrders: HomeOrderRow[];
  settlements: HomeSettlementRow[];
  stock: HomeStockRow[];
  deliveries: HomeDeliveryRow[];
}
