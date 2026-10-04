/**
 * Database row types for the customer domain.
 * Matches the columns in migrations 011–015.
 *
 * These are temporary hand-authored types. After migrations are applied to the live
 * Supabase project, regenerate with:
 *   supabase gen types typescript --local > src/lib/supabase/types.ts
 * and replace these with the generated Database["public"]["Tables"]["customers"]["Row"] paths.
 */

export type CustomerStatus = "active" | "archived";

export interface CustomerRow {
  id: string;
  organization_id: string;
  display_name: string;
  primary_phone: string | null;
  primary_email: string | null;
  status: CustomerStatus;
  language: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export type IdentityProvider =
  | "FACEBOOK"
  | "INSTAGRAM"
  | "TELEGRAM"
  | "TIKTOK"
  | "PHONE"
  | "EMAIL"
  | "APSA_CONSUMER"
  | "MINI_STORE";

export interface CustomerIdentityRow {
  id: string;
  organization_id: string;
  customer_id: string;
  provider: IdentityProvider;
  provider_user_id: string;
  handle: string | null;
  display_name: string | null;
  identity_metadata: Record<string, unknown> | null;
  confidence: number;
  verified_at: string | null;
  created_at: string;
}

export interface CustomerNoteRow {
  id: string;
  organization_id: string;
  customer_id: string;
  author_user_id: string;
  body: string;
  visibility: "team" | "private";
  created_at: string;
  updated_at: string;
}

export interface CustomerAddressRow {
  id: string;
  organization_id: string;
  customer_id: string;
  is_default: boolean;
  label: string | null;
  house_no: string | null;
  street: string | null;
  sangkat: string | null;
  khan: string | null;
  city: string | null;
  province: string | null;
  country: string;
  landmark: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerTagRow {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

/**
 * Raw JSON returned by public.customer_purchase_profile_v1 (migration 060).
 * Counts arrive as JSON numbers; bigint sums are minor units. A section the
 * caller may not see is `null` (it was never read), never zero-filled.
 */
export interface PurchaseProfileRow {
  customer_found: boolean;
  activity?: {
    qualifying_order_count: number;
    confirmed_order_count: number;
    completed_order_count: number;
    cancelled_order_count: number;
    refunded_order_count: number;
    first_order_at: string | null;
    last_order_at: string | null;
    last_order_id: string | null;
    last_order_source: string | null;
    distinct_product_count: number;
    total_units: number;
    conversation_linked_order_count: number;
    source_counts: Record<string, number>;
  };
  top_products?: Array<{
    product_id: string;
    product_label: string;
    top_variant_label: string | null;
    units: number;
    order_count: number;
    variant_count: number;
    last_purchased_at: string;
  }>;
  last_order_products?: string[];
  money?: Array<{
    currency: string;
    order_count: number;
    ordered_minor: number;
    received_minor: number;
    refunded_minor: number;
    net_minor: number;
    outstanding_minor: number;
  }> | null;
  payments?: { method_order_counts: Record<string, number> } | null;
  delivery?: {
    orders_with_delivery: number;
    failed_attempt_count: number;
    current_status_counts: Record<string, number>;
  } | null;
  returns?: {
    return_count: number;
    returned_order_count: number;
    completed_return_count: number;
    completed_returned_units: number;
  } | null;
}
