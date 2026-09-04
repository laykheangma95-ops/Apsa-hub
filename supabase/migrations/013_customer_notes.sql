-- Migration: 013_customer_notes
-- Purpose: Staff notes attached to a customer profile.
-- Tables: customer_notes
-- Classification: tenant-private (scoped to organization_id)
-- Notes are append-friendly; the author_user_id links to the APSA profile.
-- Rollback: DROP TABLE public.customer_notes CASCADE;

CREATE TABLE public.customer_notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  author_user_id   UUID NOT NULL REFERENCES public.profiles(id),
  body             TEXT NOT NULL CHECK (length(trim(body)) > 0),
  visibility       TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'private')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_customer_notes_customer_id
  ON public.customer_notes(customer_id, created_at DESC);

CREATE INDEX idx_customer_notes_organization_id
  ON public.customer_notes(organization_id);

CREATE INDEX idx_customer_notes_author
  ON public.customer_notes(author_user_id);

-- ── org consistency trigger ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_customer_note_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = NEW.customer_id
      AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'cross_tenant_violation: customer_id must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_customer_note_org
  BEFORE INSERT ON public.customer_notes
  FOR EACH ROW EXECUTE FUNCTION public.check_customer_note_org_integrity();

CREATE TRIGGER customer_notes_set_updated_at
  BEFORE UPDATE ON public.customer_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_notes_select_member"
  ON public.customer_notes FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "customer_notes_insert_member"
  ON public.customer_notes FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Notes can be edited by their author or a manager (application layer enforces
-- the manager gate; RLS only checks org membership as a floor).
CREATE POLICY "customer_notes_update_author"
  ON public.customer_notes FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "customer_notes_delete_author"
  ON public.customer_notes FOR DELETE
  USING (public.is_active_member_of(organization_id));
