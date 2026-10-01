/**
 * Parcel Resolution types — the authoritative result of resolving a parcel
 * identity to its full operational context.
 *
 * Returns identifiers and operational metadata only. Never PII: no names,
 * phones, or addresses cross this boundary — shipping presence is expressed
 * as boolean flags.
 *
 * Consumed by:
 *   - Parcel Investigation page (future)
 *   - Scan-to-Pack workflow (future)
 *   - Courier Handoff (future)
 *   - Returns processing (future)
 *
 * Never import this file from browser-bundled code — use the API layer types.
 */

export interface ParcelReference {
  id: string;
  parcelCode: string;
  status: string;
  createdAt: string;
}

export interface OrderReference {
  id: string;
  orderNumber: string;
  lifecycleStatus: string;
  fulfillmentStatus: string;
  paymentStatus: string;
}

export interface CustomerReference {
  id: string;
}

export interface DeliveryReference {
  id: string;
  status: string;
  providerName: string;
  externalTrackingNumber: string | null;
}

export interface ShippingSnapshotPresence {
  hasName: boolean;
  hasPhone: boolean;
  hasAddress: boolean;
}

export interface ParcelResolutionResult {
  parcel: ParcelReference;
  order: OrderReference;
  customer: CustomerReference | null;
  delivery: DeliveryReference | null;
  shippingSnapshot: ShippingSnapshotPresence;
}
