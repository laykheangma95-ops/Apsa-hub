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
  /** True when nothing is left to collect (outstanding balance is zero). */
  paid: boolean;
  /**
   * Amount to collect on delivery — the authoritative OUTSTANDING balance
   * (order total minus net settled, from the Payment ledger), not the full
   * total. Zero when the order is settled. Never recomputed in the client.
   */
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
    /** Operational contact only — gated server-side (see getParcelLabelData). */
    phone: string | null;
    /**
     * The order's authoritative shipping destination address (a single
     * formatted line from orders.shipping_address, migration 047), or null when
     * the order has no confirmed destination snapshot yet. The mutable customer
     * default is NEVER substituted here (§13) — an unconfirmed order shows no
     * address and the UI blocks its first-time print until a human confirms one.
     */
    address: string | null;
    /**
     * Whether `address` is the order's own authoritative destination snapshot.
     * True once orders.shipping_address is set (at creation or via an explicit
     * confirm/edit); false for a pickup order or one created before the snapshot
     * existed. When false the label is NOT printable as-is: the destination must
     * be confirmed first (§9, §13).
     */
    addressConfirmed: boolean;
  };
  order: {
    id: string;
    orderNumber: string;
    currency: Currency;
    itemCount: number;
    items: ParcelLabelItem[];
  };
  /**
   * True when packing has already advanced (processing/fulfilled) so this is a
   * re-issue, not a first packing label (§19). The label says REPRINT vs PRINT.
   */
  reprint: boolean;
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
