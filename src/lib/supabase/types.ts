/**
 * APSA — Supabase Database Types
 *
 * Generated for the live APSA Supabase project.
 * Project: oelvsbgslkziumbhjzvv (Seoul region)
 *
 * Regenerate with:
 *   supabase gen types typescript --project-id oelvsbgslkziumbhjzvv --schema public > src/lib/supabase/types.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserStatus = "active" | "suspended" | "deleted";
export type OrganizationStatus = "active" | "suspended" | "deleted";
export type WorkspaceType = "INBOX" | "BUSINESS";
export type WorkspaceStatus = "active" | "archived";
export type LocationType = "branch" | "warehouse" | "virtual";
export type LocationStatus = "active" | "closed";
export type MembershipStatus = "active" | "invited" | "suspended" | "removed";
export type SystemRoleKey =
  | "OWNER"
  | "MANAGER"
  | "CASHIER"
  | "SALES"
  | "CUSTOMER_SERVICE";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type CustomerStatus = "active" | "archived";
export type IdentityProvider =
  | "FACEBOOK"
  | "INSTAGRAM"
  | "TELEGRAM"
  | "TIKTOK"
  | "PHONE"
  | "EMAIL"
  | "APSA_CONSUMER"
  | "MINI_STORE";
export type CategoryStatus = "ACTIVE" | "ARCHIVED";
export type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type VariantStatus = "ACTIVE" | "ARCHIVED";
export type InventoryMovementType =
  | "initial"
  | "sale"
  | "return"
  | "manual_adjustment"
  | "restock";
export type OrderLifecycleStatus = "draft" | "confirmed" | "completed" | "cancelled";
export type OrderPaymentStatus = "unpaid" | "pending" | "paid" | "failed";
export type OrderFulfillmentStatus = "unfulfilled" | "processing" | "fulfilled" | "cancelled";
export type OrderSource = "POS" | "FACEBOOK" | "INSTAGRAM" | "TELEGRAM" | "MANUAL";
export type OrderStatusAxis = "lifecycle" | "payment" | "fulfillment";
export type DeliveryStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          phone: string | null;
          display_name: string | null;
          avatar_url: string | null;
          locale: string;
          timezone: string;
          status: UserStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          phone?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          locale?: string;
          timezone?: string;
          status?: UserStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          phone?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          locale?: string;
          timezone?: string;
          status?: UserStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
      organizations: {
        Row: {
          id: string;
          legal_name: string;
          display_name: string;
          slug: string;
          business_type: string | null;
          default_currency: string;
          country: string;
          timezone: string;
          status: OrganizationStatus;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          legal_name: string;
          display_name: string;
          slug: string;
          business_type?: string | null;
          default_currency?: string;
          country?: string;
          timezone?: string;
          status?: OrganizationStatus;
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          legal_name?: string;
          display_name?: string;
          slug?: string;
          business_type?: string | null;
          default_currency?: string;
          country?: string;
          timezone?: string;
          status?: OrganizationStatus;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      roles: {
        Row: {
          id: string;
          organization_id: string | null;
          name: string;
          system_role: SystemRoleKey | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          name: string;
          system_role?: SystemRoleKey | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          name?: string;
          system_role?: SystemRoleKey | null;
          created_at?: string;
        };
      };
      permissions: {
        Row: {
          id: string;
          key: string;
          description: string;
          risk_level: RiskLevel;
        };
        Insert: {
          id?: string;
          key: string;
          description?: string;
          risk_level?: RiskLevel;
        };
        Update: {
          id?: string;
          key?: string;
          description?: string;
          risk_level?: RiskLevel;
        };
      };
      role_permissions: {
        Row: { role_id: string; permission_id: string };
        Insert: { role_id: string; permission_id: string };
        Update: { role_id?: string; permission_id?: string };
      };
      workspaces: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          type: WorkspaceType;
          status: WorkspaceStatus;
          settings: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          type: WorkspaceType;
          status?: WorkspaceStatus;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          type?: WorkspaceType;
          status?: WorkspaceStatus;
          settings?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      locations: {
        Row: {
          id: string;
          organization_id: string;
          workspace_id: string | null;
          name: string;
          type: LocationType;
          phone: string | null;
          timezone: string;
          status: LocationStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          workspace_id?: string | null;
          name: string;
          type?: LocationType;
          phone?: string | null;
          timezone?: string;
          status?: LocationStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          workspace_id?: string | null;
          name?: string;
          type?: LocationType;
          phone?: string | null;
          timezone?: string;
          status?: LocationStatus;
          created_at?: string;
        };
      };
      memberships: {
        Row: {
          id: string;
          user_id: string;
          organization_id: string;
          role_id: string;
          status: MembershipStatus;
          joined_at: string;
          invited_by: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          organization_id: string;
          role_id: string;
          status?: MembershipStatus;
          joined_at?: string;
          invited_by?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          organization_id?: string;
          role_id?: string;
          status?: MembershipStatus;
          joined_at?: string;
          invited_by?: string | null;
        };
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string;
          actor_user_id: string;
          action: string;
          resource_type: string;
          resource_id: string | null;
          before_json: Json | null;
          after_json: Json | null;
          reason: string | null;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          actor_user_id: string;
          action: string;
          resource_type: string;
          resource_id?: string | null;
          before_json?: Json | null;
          after_json?: Json | null;
          reason?: string | null;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          actor_user_id?: string;
          action?: string;
          resource_type?: string;
          resource_id?: string | null;
          before_json?: Json | null;
          after_json?: Json | null;
          reason?: string | null;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
      };
      customers: {
        Row: {
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
        };
        Insert: {
          id?: string;
          organization_id: string;
          display_name: string;
          primary_phone?: string | null;
          primary_email?: string | null;
          status?: CustomerStatus;
          language?: string | null;
          first_seen_at?: string | null;
          last_seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          display_name?: string;
          primary_phone?: string | null;
          primary_email?: string | null;
          status?: CustomerStatus;
          language?: string | null;
          first_seen_at?: string | null;
          last_seen_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      customer_identities: {
        Row: {
          id: string;
          organization_id: string;
          customer_id: string;
          provider: IdentityProvider;
          provider_user_id: string;
          handle: string | null;
          display_name: string | null;
          identity_metadata: Json | null;
          confidence: number;
          verified_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          customer_id: string;
          provider: IdentityProvider;
          provider_user_id: string;
          handle?: string | null;
          display_name?: string | null;
          identity_metadata?: Json | null;
          confidence?: number;
          verified_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          customer_id?: string;
          provider?: IdentityProvider;
          provider_user_id?: string;
          handle?: string | null;
          display_name?: string | null;
          identity_metadata?: Json | null;
          confidence?: number;
          verified_at?: string | null;
          created_at?: string;
        };
      };
      customer_notes: {
        Row: {
          id: string;
          organization_id: string;
          customer_id: string;
          author_user_id: string;
          body: string;
          visibility: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          customer_id: string;
          author_user_id: string;
          body: string;
          visibility?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          customer_id?: string;
          author_user_id?: string;
          body?: string;
          visibility?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      customer_tags: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          color: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          color?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          color?: string | null;
          created_at?: string;
        };
      };
      customer_tag_assignments: {
        Row: {
          customer_id: string;
          tag_id: string;
          assigned_at: string;
        };
        Insert: { customer_id: string; tag_id: string; assigned_at?: string };
        Update: { customer_id?: string; tag_id?: string; assigned_at?: string };
      };
      customer_addresses: {
        Row: {
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
        };
        Insert: {
          id?: string;
          organization_id: string;
          customer_id: string;
          is_default?: boolean;
          label?: string | null;
          house_no?: string | null;
          street?: string | null;
          sangkat?: string | null;
          khan?: string | null;
          city?: string | null;
          province?: string | null;
          country?: string;
          landmark?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          customer_id?: string;
          is_default?: boolean;
          label?: string | null;
          house_no?: string | null;
          street?: string | null;
          sangkat?: string | null;
          khan?: string | null;
          city?: string | null;
          province?: string | null;
          country?: string;
          landmark?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      product_categories: {
        Row: {
          id: string;
          organization_id: string;
          parent_id: string | null;
          name_km: string;
          name_en: string | null;
          sort_order: number;
          status: CategoryStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          parent_id?: string | null;
          name_km: string;
          name_en?: string | null;
          sort_order?: number;
          status?: CategoryStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          parent_id?: string | null;
          name_km?: string;
          name_en?: string | null;
          sort_order?: number;
          status?: CategoryStatus;
          created_at?: string;
        };
      };
      products: {
        Row: {
          id: string;
          organization_id: string;
          workspace_id: string | null;
          name_km: string;
          name_en: string | null;
          description_km: string | null;
          description_en: string | null;
          category_id: string | null;
          status: ProductStatus;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          workspace_id?: string | null;
          name_km: string;
          name_en?: string | null;
          description_km?: string | null;
          description_en?: string | null;
          category_id?: string | null;
          status?: ProductStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          workspace_id?: string | null;
          name_km?: string;
          name_en?: string | null;
          description_km?: string | null;
          description_en?: string | null;
          category_id?: string | null;
          status?: ProductStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      product_variants: {
        Row: {
          id: string;
          organization_id: string;
          product_id: string;
          sku: string | null;
          barcode: string | null;
          name: string;
          price_amount: number;
          price_currency: string;
          cost_amount: number | null;
          cost_currency: string | null;
          weight_grams: number | null;
          status: VariantStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          product_id: string;
          sku?: string | null;
          barcode?: string | null;
          name?: string;
          price_amount: number;
          price_currency: string;
          cost_amount?: number | null;
          cost_currency?: string | null;
          weight_grams?: number | null;
          status?: VariantStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          product_id?: string;
          sku?: string | null;
          barcode?: string | null;
          name?: string;
          price_amount?: number;
          price_currency?: string;
          cost_amount?: number | null;
          cost_currency?: string | null;
          weight_grams?: number | null;
          status?: VariantStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
      inventory_movements: {
        Row: {
          id: string;
          organization_id: string;
          product_id: string;
          variant_id: string;
          location_id: string | null;
          quantity_delta: number;
          movement_type: InventoryMovementType;
          reference_type: string | null;
          reference_id: string | null;
          reason: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          product_id: string;
          variant_id: string;
          location_id?: string | null;
          quantity_delta: number;
          movement_type: InventoryMovementType;
          reference_type?: string | null;
          reference_id?: string | null;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          product_id?: string;
          variant_id?: string;
          location_id?: string | null;
          quantity_delta?: number;
          movement_type?: InventoryMovementType;
          reference_type?: string | null;
          reference_id?: string | null;
          reason?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
      };
      orders: {
        Row: {
          id: string;
          organization_id: string;
          order_number: string;
          customer_id: string | null;
          location_id: string | null;
          source: OrderSource;
          currency: string;
          subtotal_minor: number;
          discount_minor: number;
          delivery_minor: number;
          total_minor: number;
          lifecycle_status: OrderLifecycleStatus;
          payment_status: OrderPaymentStatus;
          fulfillment_status: OrderFulfillmentStatus;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          order_number: string;
          customer_id?: string | null;
          location_id?: string | null;
          source: OrderSource;
          currency: string;
          subtotal_minor: number;
          discount_minor?: number;
          delivery_minor?: number;
          total_minor: number;
          lifecycle_status?: OrderLifecycleStatus;
          payment_status?: OrderPaymentStatus;
          fulfillment_status?: OrderFulfillmentStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          order_number?: string;
          customer_id?: string | null;
          location_id?: string | null;
          source?: OrderSource;
          currency?: string;
          subtotal_minor?: number;
          discount_minor?: number;
          delivery_minor?: number;
          total_minor?: number;
          lifecycle_status?: OrderLifecycleStatus;
          payment_status?: OrderPaymentStatus;
          fulfillment_status?: OrderFulfillmentStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      order_items: {
        Row: {
          id: string;
          organization_id: string;
          order_id: string;
          product_id: string;
          variant_id: string;
          product_name_snapshot: string;
          variant_name_snapshot: string | null;
          sku_snapshot: string | null;
          unit_price_minor: number;
          quantity: number;
          line_total_minor: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          order_id: string;
          product_id: string;
          variant_id: string;
          product_name_snapshot: string;
          variant_name_snapshot?: string | null;
          sku_snapshot?: string | null;
          unit_price_minor: number;
          quantity: number;
          line_total_minor: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          order_id?: string;
          product_id?: string;
          variant_id?: string;
          product_name_snapshot?: string;
          variant_name_snapshot?: string | null;
          sku_snapshot?: string | null;
          unit_price_minor?: number;
          quantity?: number;
          line_total_minor?: number;
          created_at?: string;
        };
      };
      order_status_history: {
        Row: {
          id: string;
          organization_id: string;
          order_id: string;
          axis: OrderStatusAxis;
          from_status: string;
          to_status: string;
          changed_by: string | null;
          reason: string | null;
          changed_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          order_id: string;
          axis: OrderStatusAxis;
          from_status: string;
          to_status: string;
          changed_by?: string | null;
          reason?: string | null;
          changed_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          order_id?: string;
          axis?: OrderStatusAxis;
          from_status?: string;
          to_status?: string;
          changed_by?: string | null;
          reason?: string | null;
          changed_at?: string;
        };
      };
      order_number_sequences: {
        Row: { organization_id: string; year: number; last_number: number };
        Insert: { organization_id: string; year: number; last_number?: number };
        Update: { organization_id?: string; year?: number; last_number?: number };
      };
      delivery_providers: {
        Row: {
          id: string;
          organization_id: string;
          provider_key: string;
          name: string;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          provider_key: string;
          name: string;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider_key?: string;
          name?: string;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      deliveries: {
        Row: {
          id: string;
          organization_id: string;
          order_id: string;
          location_id: string | null;
          provider_id: string | null;
          provider_key: string | null;
          provider_name: string;
          external_tracking_number: string | null;
          cod_amount_minor: number | null;
          cod_currency: string | null;
          status: DeliveryStatus;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          order_id: string;
          location_id?: string | null;
          provider_id?: string | null;
          provider_key?: string | null;
          provider_name: string;
          external_tracking_number?: string | null;
          cod_amount_minor?: number | null;
          cod_currency?: string | null;
          status?: DeliveryStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          order_id?: string;
          location_id?: string | null;
          provider_id?: string | null;
          provider_key?: string | null;
          provider_name?: string;
          external_tracking_number?: string | null;
          cod_amount_minor?: number | null;
          cod_currency?: string | null;
          status?: DeliveryStatus;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      delivery_status_history: {
        Row: {
          id: string;
          organization_id: string;
          delivery_id: string;
          from_status: DeliveryStatus | null;
          to_status: DeliveryStatus;
          changed_by: string | null;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          delivery_id: string;
          from_status?: DeliveryStatus | null;
          to_status: DeliveryStatus;
          changed_by?: string | null;
          reason?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          delivery_id?: string;
          from_status?: DeliveryStatus | null;
          to_status?: DeliveryStatus;
          changed_by?: string | null;
          reason?: string | null;
          created_at?: string;
        };
      };
    };
    Views: {
      inventory_stock: {
        Row: {
          organization_id: string;
          product_id: string;
          variant_id: string;
          location_id: string | null;
          quantity_on_hand: number | null;
          last_movement_at: string | null;
        };
      };
    };
    Functions: {
      allocate_order_number: {
        Args: { p_organization_id: string };
        Returns: string;
      };
      create_delivery_v1: {
        Args: {
          p_organization_id: string;
          p_order_id: string;
          p_created_by?: string | null;
          p_location_id?: string | null;
          p_provider_id?: string | null;
          p_provider_key?: string | null;
          p_provider_name?: string | null;
          p_external_tracking_number?: string | null;
          p_cod_amount_minor?: number | null;
        };
        Returns: Json;
      };
      create_order_v1: {
        Args: {
          p_organization_id: string;
          p_created_by: string;
          p_source: string;
          p_items: Json;
          p_customer_id?: string | null;
          p_location_id?: string | null;
          p_discount_minor?: number;
        };
        Returns: Json;
      };
      create_organization_for_founder: {
        Args: {
          p_legal_name: string;
          p_display_name: string;
          p_slug: string;
          p_business_type?: string | null;
          p_currency?: string;
        };
        Returns: Json;
      };
      has_audit_access: {
        Args: { org_id: string };
        Returns: boolean;
      };
      is_active_member_of: {
        Args: { p_organization_id: string };
        Returns: boolean;
      };
      transition_delivery_status_v1: {
        Args: {
          p_organization_id: string;
          p_delivery_id: string;
          p_expected_from: string;
          p_to: string;
          p_changed_by?: string | null;
          p_reason?: string | null;
        };
        Returns: Json;
      };
      transition_order_status_v1: {
        Args: {
          p_organization_id: string;
          p_order_id: string;
          p_axis: string;
          p_expected_from: string;
          p_to: string;
          p_changed_by?: string | null;
          p_reason?: string | null;
        };
        Returns: Json;
      };
    };
    Enums: {
      user_status: UserStatus;
      organization_status: OrganizationStatus;
      workspace_type: WorkspaceType;
      workspace_status: WorkspaceStatus;
      location_type: LocationType;
      location_status: LocationStatus;
      membership_status: MembershipStatus;
      system_role_key: SystemRoleKey;
      risk_level: RiskLevel;
      customer_status: CustomerStatus;
      identity_provider: IdentityProvider;
      category_status: CategoryStatus;
      product_status: ProductStatus;
      variant_status: VariantStatus;
      inventory_movement_type: InventoryMovementType;
      order_lifecycle_status: OrderLifecycleStatus;
      order_payment_status: OrderPaymentStatus;
      order_fulfillment_status: OrderFulfillmentStatus;
      order_source: OrderSource;
      order_status_axis: OrderStatusAxis;
      delivery_status: DeliveryStatus;
    };
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];

export type Profile = Tables<"profiles">;
export type Organization = Tables<"organizations">;
export type Role = Tables<"roles">;
export type Permission = Tables<"permissions">;
export type RolePermission = Tables<"role_permissions">;
export type Workspace = Tables<"workspaces">;
export type Location = Tables<"locations">;
export type Membership = Tables<"memberships">;
export type AuditLog = Tables<"audit_logs">;
export type Customer = Tables<"customers">;
export type CustomerIdentity = Tables<"customer_identities">;
export type CustomerNote = Tables<"customer_notes">;
export type CustomerTag = Tables<"customer_tags">;
export type CustomerTagAssignment = Tables<"customer_tag_assignments">;
export type CustomerAddress = Tables<"customer_addresses">;
export type ProductCategory = Tables<"product_categories">;
export type Product = Tables<"products">;
export type ProductVariant = Tables<"product_variants">;
export type InventoryMovement = Tables<"inventory_movements">;
export type InventoryStock = Database["public"]["Views"]["inventory_stock"]["Row"];
export type Order = Tables<"orders">;
export type OrderItem = Tables<"order_items">;
export type OrderStatusHistory = Tables<"order_status_history">;
export type OrderNumberSequence = Tables<"order_number_sequences">;
export type DeliveryProvider = Tables<"delivery_providers">;
export type Delivery = Tables<"deliveries">;
export type DeliveryStatusHistory = Tables<"delivery_status_history">;

export type ProfileInsert = TablesInsert<"profiles">;
export type OrganizationInsert = TablesInsert<"organizations">;
export type WorkspaceInsert = TablesInsert<"workspaces">;
export type LocationInsert = TablesInsert<"locations">;
export type MembershipInsert = TablesInsert<"memberships">;
export type AuditLogInsert = TablesInsert<"audit_logs">;

export type MembershipRow = Membership;
export type RoleRow = Role;
export type PermissionRow = Permission;

export const SYSTEM_ROLE_IDS = {
  OWNER: "00000000-0000-0000-0000-000000000001",
  MANAGER: "00000000-0000-0000-0000-000000000002",
  CASHIER: "00000000-0000-0000-0000-000000000003",
  SALES: "00000000-0000-0000-0000-000000000004",
  CUSTOMER_SERVICE: "00000000-0000-0000-0000-000000000005",
} as const;
