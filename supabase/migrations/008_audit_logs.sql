-- Migration: 008_audit_logs
-- Purpose: Append-only audit log for sensitive actions
-- Tables: audit_logs
-- Classification: tenant-private (scoped to organization_id)
-- Indexes: organization_id+created_at (primary query pattern), actor_user_id, resource
-- Constraints: append-only — no UPDATE or DELETE allowed even for service role via trigger
-- Tenant ownership: organization_id
-- RLS: Only org members with 'org.read' permission can SELECT audit logs.
--      This restricts audit log access to Owner and Manager roles by default.
--      Cashier, Sales, and Customer Service cannot read audit logs.
--      INSERT only via service role (server-side).
-- NOTE: Requires has_audit_access() function from 007_rls_deferred_member_policies.sql
-- Rollback: DROP TABLE public.audit_logs CASCADE;
--           DROP FUNCTION public.prevent_audit_log_modification();

CREATE TABLE public.audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  actor_user_id   UUID NOT NULL REFERENCES public.profiles(id),
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  before_json     JSONB,
  after_json      JSONB,
  reason          TEXT,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition-friendly index: most queries are time-ranged within an org.
CREATE INDEX idx_audit_logs_org_time
  ON public.audit_logs(organization_id, created_at DESC);

CREATE INDEX idx_audit_logs_actor
  ON public.audit_logs(actor_user_id, created_at DESC);

CREATE INDEX idx_audit_logs_resource
  ON public.audit_logs(organization_id, resource_type, resource_id);

-- Prevent any modification or deletion of audit records.
-- Audit logs are append-only by definition.
CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only and cannot be modified or deleted';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_modification();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_modification();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- FIX: Only org members with 'org.read' permission can read audit logs.
-- The old policy allowed ANY active org member to read audit logs, which exposed
-- security-sensitive history to cashiers, sales staff, and customer service.
-- Per PERMISSIONS_MATRIX.md: org.read is granted to OWNER and MANAGER only.
-- Cashier, Sales, and Customer Service do not have org.read and cannot access logs.
-- The has_audit_access() function is defined in 007_rls_deferred_member_policies.sql.
CREATE POLICY "audit_logs_select_org_read_permission"
  ON public.audit_logs FOR SELECT
  USING (public.has_audit_access(organization_id));

-- INSERT is blocked for JWT clients — only service role can write audit logs.
CREATE POLICY "audit_logs_insert_blocked"
  ON public.audit_logs FOR INSERT
  WITH CHECK (false);
