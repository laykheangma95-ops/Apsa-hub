-- Migration: 007_rls_deferred_member_policies
-- Purpose: Add membership-based SELECT RLS policies to tables created before the memberships
--          table existed. This migration runs after 006_memberships.sql so that the
--          memberships table is available for use in policy USING expressions.
--
-- Tables affected:
--   organizations   — adds SELECT policy requiring active membership
--   workspaces      — adds SELECT policy requiring active membership
--   locations       — adds SELECT policy requiring active membership
--   roles           — adds SELECT policy for org-specific custom roles (requires membership)
--   role_permissions — adds SELECT policy for org-specific mappings (requires membership)
--
-- Also creates:
--   public.has_audit_access(org_id UUID) — SECURITY DEFINER helper for audit log RLS
--
-- This is a pure RLS bootstrap migration — no new tables, no schema changes.
-- Rollback: DROP the specific policies added here; DROP FUNCTION public.has_audit_access;

-- ── organizations: add membership-based SELECT policy ────────────────────────
-- Only active members of the organization can read it.
-- Application layer enforces the full authorization chain; RLS is defense-in-depth.
CREATE POLICY "organizations_select_member"
  ON public.organizations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = organizations.id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- ── workspaces: add membership-based SELECT policy ───────────────────────────
CREATE POLICY "workspaces_select_member"
  ON public.workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = workspaces.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- ── locations: add membership-based SELECT policy ────────────────────────────
CREATE POLICY "locations_select_member"
  ON public.locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = locations.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- ── roles: add org-specific custom role SELECT policy ────────────────────────
-- Org-specific roles (organization_id IS NOT NULL): active members of that org can read.
-- System roles (organization_id IS NULL): already readable by any authenticated user
-- via the "roles_select_system" policy created in migration 003.
CREATE POLICY "roles_select_org_member"
  ON public.roles FOR SELECT
  USING (
    organization_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = roles.organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- ── role_permissions: add org-specific mapping SELECT policy ─────────────────
-- FIX: The old "role_permissions_select_authenticated" policy allowed any authenticated user
-- to read ALL role_permissions globally, leaking custom role mappings across organizations.
-- The system-role-only policy was already added in migration 003.
-- Here we add the org-scoped policy for custom role mappings.
CREATE POLICY "role_permissions_select_org_member"
  ON public.role_permissions FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.roles r
      JOIN public.memberships m ON m.organization_id = r.organization_id
      WHERE r.id = role_permissions.role_id
        AND r.organization_id IS NOT NULL
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );

-- ── Audit access helper function ─────────────────────────────────────────────
-- Used by 008_audit_logs.sql RLS policy to check if the current user has
-- the 'org.read' permission, which gates audit log access.
-- SECURITY DEFINER runs as the function owner, bypassing RLS on the tables
-- it queries — this is intentional and necessary for the RLS policy to work
-- without creating recursive RLS chains. The function only returns a boolean.
CREATE OR REPLACE FUNCTION public.has_audit_access(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.roles r ON r.id = m.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE m.organization_id = org_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND p.key = 'org.read'
  );
$$;
