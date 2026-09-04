/**
 * APSA — Supabase Database Types
 *
 * Generated from migrations 001–008 applied to the live APSA Supabase project.
 * Project: oelvsbgslkziumbhjzvv (Seoul region)
 * Generated: 2026-09-03
 *
 * When new migrations are applied, regenerate with:
 *   supabase gen types typescript --project-id oelvsbgslkziumbhjzvv > src/lib/supabase/types.ts
 * or update this file to match the new schema.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ── Enum types ────────────────────────────────────────────────────────────────

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

// ── Table row types ───────────────────────────────────────────────────────────

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
          default_currency: "USD" | "KHR";
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
          default_currency?: "USD" | "KHR";
          country?: string;
          timezone?: string;
          status?: OrganizationStatus;
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          legal_name?: string;
          display_name?: string;
          slug?: string;
          business_type?: string | null;
          default_currency?: "USD" | "KHR";
          country?: string;
          timezone?: string;
          status?: OrganizationStatus;
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
          name?: string;
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
          description?: string;
          risk_level?: RiskLevel;
        };
      };

      role_permissions: {
        Row: {
          role_id: string;
          permission_id: string;
        };
        Insert: {
          role_id: string;
          permission_id: string;
        };
        Update: never;
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
          name?: string;
          type?: WorkspaceType;
          status?: WorkspaceStatus;
          settings?: Json;
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
          workspace_id?: string | null;
          name?: string;
          type?: LocationType;
          phone?: string | null;
          timezone?: string;
          status?: LocationStatus;
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
          role_id?: string;
          status?: MembershipStatus;
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
        Update: never; // audit_logs are append-only
      };
    };

    Views: {
      [_ in never]: never;
    };

    Functions: {
      is_active_member_of: {
        Args: { p_organization_id: string };
        Returns: boolean;
      };
      has_audit_access: {
        Args: { p_organization_id: string };
        Returns: boolean;
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
    };
  };
}

// ── Convenience row types ─────────────────────────────────────────────────────

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Organization = Database["public"]["Tables"]["organizations"]["Row"];
export type Role = Database["public"]["Tables"]["roles"]["Row"];
export type Permission = Database["public"]["Tables"]["permissions"]["Row"];
export type RolePermission =
  Database["public"]["Tables"]["role_permissions"]["Row"];
export type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];
export type Location = Database["public"]["Tables"]["locations"]["Row"];
export type Membership = Database["public"]["Tables"]["memberships"]["Row"];
export type AuditLog = Database["public"]["Tables"]["audit_logs"]["Row"];

// ── Insert types ──────────────────────────────────────────────────────────────

export type ProfileInsert =
  Database["public"]["Tables"]["profiles"]["Insert"];
export type OrganizationInsert =
  Database["public"]["Tables"]["organizations"]["Insert"];
export type WorkspaceInsert =
  Database["public"]["Tables"]["workspaces"]["Insert"];
export type LocationInsert =
  Database["public"]["Tables"]["locations"]["Insert"];
export type MembershipInsert =
  Database["public"]["Tables"]["memberships"]["Insert"];
export type AuditLogInsert =
  Database["public"]["Tables"]["audit_logs"]["Insert"];

// ── Legacy row-type aliases (kept for backwards compatibility) ────────────────

export type MembershipRow = Membership;
export type RoleRow = Role;
export type PermissionRow = Permission;

// ── System role UUIDs (seeded by migration 003) ───────────────────────────────
// These are stable — they are set explicitly in the migration seed and never change.

export const SYSTEM_ROLE_IDS = {
  OWNER: "00000000-0000-0000-0000-000000000001",
  MANAGER: "00000000-0000-0000-0000-000000000002",
  CASHIER: "00000000-0000-0000-0000-000000000003",
  SALES: "00000000-0000-0000-0000-000000000004",
  CUSTOMER_SERVICE: "00000000-0000-0000-0000-000000000005",
} as const;
