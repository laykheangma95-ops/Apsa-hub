-- Migration: 014_customer_tags
-- Purpose: Tag taxonomy and customer-tag assignments.
-- Tables: customer_tags, customer_tag_assignments
-- Classification: tenant-private (scoped to organization_id)
-- Tags are org-level vocabulary; assignments link customers to tags.
-- Rollback: DROP TABLE public.customer_tag_assignments CASCADE;
--           DROP TABLE public.customer_tags CASCADE;

-- ── customer_tags ─────────────────────────────────────────────────────────────

CREATE TABLE public.customer_tags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  color            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tag names are unique within an organization.
CREATE UNIQUE INDEX idx_customer_tags_org_name
  ON public.customer_tags(organization_id, lower(name));

CREATE INDEX idx_customer_tags_organization_id
  ON public.customer_tags(organization_id);

-- ── customer_tag_assignments ──────────────────────────────────────────────────

CREATE TABLE public.customer_tag_assignments (
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES public.customer_tags(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, tag_id)
);

CREATE INDEX idx_customer_tag_assignments_tag_id
  ON public.customer_tag_assignments(tag_id);

-- ── RLS: customer_tags ────────────────────────────────────────────────────────

ALTER TABLE public.customer_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_tags_select_member"
  ON public.customer_tags FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "customer_tags_insert_member"
  ON public.customer_tags FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_tags_update_member"
  ON public.customer_tags FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_tags_delete_member"
  ON public.customer_tags FOR DELETE
  USING (public.is_active_member_of(organization_id));

-- ── RLS: customer_tag_assignments ─────────────────────────────────────────────
-- Assignments inherit tenant scope from the customer they reference.

ALTER TABLE public.customer_tag_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_tag_assignments_select_member"
  ON public.customer_tag_assignments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_tag_assignments.customer_id
        AND public.is_active_member_of(c.organization_id)
    )
  );

CREATE POLICY "customer_tag_assignments_insert_member"
  ON public.customer_tag_assignments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_tag_assignments.customer_id
        AND public.is_active_member_of(c.organization_id)
    )
  );

CREATE POLICY "customer_tag_assignments_delete_member"
  ON public.customer_tag_assignments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_tag_assignments.customer_id
        AND public.is_active_member_of(c.organization_id)
    )
  );
