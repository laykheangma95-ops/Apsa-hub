/**
 * Fulfillment (packing) domain — shared shapes for the Ready-to-Pack queue and
 * the parcel label. These compose the authoritative Order, Customer, Delivery
 * and Organization facts; they never invent a new order status or a new money
 * value (§11, §16, §18).
 */
import type { Money, Currency } from "@/types";

/** One row in the merchant's Ready-to-Pack work queue. */
export interface ReadyToPackEntry {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  source: string;
  /** Customer display name (not PII-gated); null for a walk-in / no-customer order. */
  customerName: string | null;
  /** Sum of line quantities. */
  itemCount: number;
  currency: Currency;
  total: Money;
  /** Derived from the order's own payment_status — never recomputed in the client. */
  paid: boolean;
  /** Amount to collect on delivery: 0 when paid, the order total otherwise. */
  collect: Money;
  /** Latest delivery status for the order, or null when none is arranged yet. */
  deliveryStatus: string | null;
}

/** One product line as it appears on a parcel label. */
export interface ParcelLabelItem {
  quantity: number;
  productName: string;
  variantName: string | null;
}

/**
 * Everything a 100×150 parcel label prints — and NOTHING more (§14). Contains
 * exactly the fulfillment PII (name, phone, address) and no email, notes,
 * analytics or payment credentials. Money is authoritative integer minor units.
 */
export interface ParcelLabelData {
  merchant: {
    businessName: string;
  };
  customer: {
    name: string | null;
    /** Operational contact only — gated by customers.view_sensitive server-side. */
    phone: string | null;
    /** Single formatted delivery address line, or null when none on file. */
    address: string | null;
  };
  order: {
    id: string;
    orderNumber: string;
    currency: Currency;
    itemCount: number;
    items: ParcelLabelItem[];
  };
  payment: {
    paid: boolean;
    /** null when fully paid; the amount to collect otherwise. */
    collect: Money | null;
  };
  delivery: {
    providerName: string;
    trackingNumber: string | null;
    status: string;
  } | null;
}
