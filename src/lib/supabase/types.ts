/**
 * Supabase database type definitions — TEMPORARY SCAFFOLDING.
 *
 * These types are hand-authored to match the current migration schema.
 * They are intended as a stopgap only. Once the migrations are applied to the
 * live APSA Supabase project, replace this file entirely with generated types:
 *
 *   supabase gen types typescript --local > src/lib/supabase/types.ts
 *
 * Do NOT add hand-authored types here indefinitely. Any schema drift between
 * this file and the actual DB schema will cause silent runtime bugs.
 * After running `gen types`, also update the type aliases (MembershipRow, etc.)
 * below to reference the generated Database["public"]["Tables"] paths.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ── Row types (match migration columns exactly) ──────────────────────────────

export interface Profile {
  id: string;
  email: string;
  phone: string | null;
  display_name: string | null;
  avatar_url: string | null;
  locale: string;
  timezone: string;
  status: UserStatusEnum;
  created_at: string;
  updated_at: string;
}

export interface OrganizationRow {
  id: string;
  legal_name: string;
  display_name: string;
  slug: string;
  business_type: string | null;
  default_currency: string;
  country: string;
  timezone: string;
  status: OrganizationStatusEnum;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: string;
  organization_id: string;
  name: string;
  type: WorkspaceTypeEnum;
  status: WorkspaceStatusEnum;
  settings: Json;
  created_at: string;
  updated_at: string;
}

export interface LocationRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  name: string;
  type: LocationTypeEnum;
  phone: string | null;
  timezone: string;
  status: LocationStatusEnum;
  created_at: string;
}

export interface MembershipRow {
  id: string;
  user_id: string;
  organization_id: string;
  role_id: string;
  status: MembershipStatusEnum;
  joined_at: string;
  invited_by: string | null;
}

export interface RoleRow {
  id: string;
  organization_id: string | null;
  name: string;
  system_role: SystemRoleKeyEnum | null;
  created_at: string;
}

export interface PermissionRow {
  id: string;
  key: string;
  description: string;
  risk_level: RiskLevelEnum;
}

export interface RolePermissionRow {
  role_id: string;
  permission_id: string;
}

export interface AuditLogRow {
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
}

// ── Enum types ────────────────────────────────────────────────────────────────

export type OrganizationStatusEnum = "active" | "suspended" | "deleted";
export type WorkspaceTypeEnum = "INBOX" | "BUSINESS";
export type WorkspaceStatusEnum = "active" | "archived";
export type LocationTypeEnum = "branch" | "warehouse" | "virtual";
export type LocationStatusEnum = "active" | "closed";
export type MembershipStatusEnum = "active" | "invited" | "suspended" | "removed";
export type SystemRoleKeyEnum = "OWNER" | "MANAGER" | "CASHIER" | "SALES" | "CUSTOMER_SERVICE";
export type RiskLevelEnum = "low" | "medium" | "high" | "critical";
export type UserStatusEnum = "active" | "suspended" | "deleted";

// ── Database type (Supabase-js compatible format) ─────────────────────────────

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, "created_at" | "updated_at"> & {
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<Profile, "id">>;
        Relationships: [];
      };
      organizations: {
        Row: OrganizationRow;
        Insert: Omit<OrganizationRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<OrganizationRow, "id">>;
        Relationships: [];
      };
      workspaces: {
        Row: WorkspaceRow;
        Insert: Omit<WorkspaceRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<WorkspaceRow, "id">>;
        Relationships: [];
      };
      locations: {
        Row: LocationRow;
        Insert: Omit<LocationRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<LocationRow, "id">>;
        Relationships: [];
      };
      memberships: {
        Row: MembershipRow;
        Insert: Omit<MembershipRow, "id" | "joined_at"> & {
          id?: string;
          joined_at?: string;
        };
        Update: Partial<Omit<MembershipRow, "id">>;
        Relationships: [];
      };
      roles: {
        Row: RoleRow;
        Insert: Omit<RoleRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<RoleRow, "id">>;
        Relationships: [];
      };
      permissions: {
        Row: PermissionRow;
        Insert: PermissionRow;
        Update: Partial<PermissionRow>;
        Relationships: [];
      };
      role_permissions: {
        Row: RolePermissionRow;
        Insert: RolePermissionRow;
        Update: Partial<RolePermissionRow>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLogRow;
        Insert: Omit<AuditLogRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      organization_status: OrganizationStatusEnum;
      workspace_type: WorkspaceTypeEnum;
      workspace_status: WorkspaceStatusEnum;
      location_type: LocationTypeEnum;
      location_status: LocationStatusEnum;
      membership_status: MembershipStatusEnum;
      system_role_key: SystemRoleKeyEnum;
      risk_level: RiskLevelEnum;
      user_status: UserStatusEnum;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
