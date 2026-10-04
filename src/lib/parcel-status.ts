/**
 * APSA Parcel status — the authoritative domain and its UI representation.
 *
 * The domain is the CHECK constraint on public.parcels.status
 * (supabase/migrations/050_parcels.sql): a parcel is `created` from order
 * confirmation onward and only ever leaves that state by being voided. Packing,
 * shipments and handoff never change it — those are order / delivery states,
 * not parcel identity.
 *
 * The server returns the column as a plain string, so the UI parses it here
 * instead of casting it: a value outside the domain resolves to null and the
 * caller renders a safe "unknown" state rather than crashing the screen.
 */
import type { StatusKey } from "@/types";

export const PARCEL_STATUSES = ["created", "void"] as const;

export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

/**
 * Exhaustive over ParcelStatus: adding a status to the domain without deciding
 * how it is shown is a type error. Parcel statuses reuse the shared StatusChip
 * vocabulary — an active parcel reads "Active", a voided one "Cancelled"
 * (Parcel Investigation also shows a dedicated voided-parcel banner).
 */
const PARCEL_STATUS_CHIP: Record<ParcelStatus, StatusKey> = {
  created: "active",
  void: "cancelled",
};

export function isParcelStatus(value: unknown): value is ParcelStatus {
  return typeof value === "string" && (PARCEL_STATUSES as readonly string[]).includes(value);
}

/** The StatusChip key for a server parcel status, or null when it is not one. */
export function parcelStatusChipKey(status: unknown): StatusKey | null {
  return isParcelStatus(status) ? PARCEL_STATUS_CHIP[status] : null;
}
