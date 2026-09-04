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
