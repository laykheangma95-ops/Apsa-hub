-- Migration: 031_conversations
-- Purpose: Production Conversation domain — the Inbox's canonical thread record.
-- Tables: conversations
-- Classification: tenant-private (scoped to organization_id)
--
-- SOURCE OF TRUTH
--   DATA_MODEL.md §23 (Conversation); PERMISSIONS_MATRIX.md §10 (Inbox/Conversations);
--   SECURITY.md (tenant isolation); MVP_ROADMAP.md (Inbox phases).
--
-- NUMBERING NOTE: migrations 028-029 are reserved for the Payment domain (owned
-- by Codex — not touched here). Migration 030 (order_conversation_source) is
-- part of the not-yet-merged "Cambodian intent engine" PR (#27) and is not
-- applied by this migration set. This phase starts at 031 to avoid any
-- collision with either.
--
-- SCOPE OF THIS PHASE (deliberate exclusions):
--   - No ConnectedChannel / OAuth token storage — no real provider (Facebook,
--     Instagram, Telegram) webhook ingestion pipeline exists yet. `provider`
--     is present and provider-agnostic so that pipeline can be added later
--     without a schema change; it only supports the three providers with an
--     existing UI Channel badge today. Add more with ALTER TYPE ... ADD VALUE
--     when their integration actually exists (same pattern as order_source in
--     migration 023).
--   - No ConversationAssignment / ConversationStatusHistory audit tables
--     (DATA_MODEL.md §27-28). Only the current-state columns are built this
--     phase; history tracking is a follow-up once assignment is UI-driven.
--   - No MessageAttachment table — see migration 032's own note.
--   - No SavedReply table — out of this phase's scope.
--
-- TENANT ISOLATION
--   organization_id is NOT NULL and always supplied by the server from a
--   verified membership (see src/api/conversations.ts). customer_id,
--   workspace_id and assigned_user_id are all checked by trigger below to
--   belong to the SAME organization — an FK alone only proves the row exists,
--   not that it is tenant-owned.
--
-- CUSTOMER LINKAGE
--   customer_id is NULLABLE: a conversation may arrive before its sender is
--   resolved to a Customer record. "No resolved customer" is a normal, safe
--   state — never guessed at server or client.

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE public.conversation_provider AS ENUM (
  'FACEBOOK',
  'INSTAGRAM',
  'TELEGRAM'
);

-- Mirrors src/types/index.ts ConversationStatus exactly — no mapping layer
-- needed between the UI contract and the stored value.
CREATE TYPE public.conversation_status AS ENUM (
  'unread',
  'needs_reply',
  'follow_up',
  'waiting_customer',
  'order_created',
  'closed'
);

-- ── conversations ─────────────────────────────────────────────────────────────

CREATE TABLE public.conversations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id              UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  customer_id               UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  provider                  public.conversation_provider NOT NULL,
  provider_conversation_id  TEXT NOT NULL CHECK (length(trim(provider_conversation_id)) > 0),
  status                    public.conversation_status NOT NULL DEFAULT 'needs_reply',
  assigned_user_id          UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  unread_count              INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_preview      TEXT,
  last_message_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One conversation per provider thread per org.
CREATE UNIQUE INDEX idx_conversations_provider_thread
  ON public.conversations(organization_id, provider, provider_conversation_id);

-- ── Indexes for safe pagination ────────────────────────────────────────────────

CREATE INDEX idx_conversations_org_last_message
  ON public.conversations(organization_id, last_message_at DESC, id DESC);
CREATE INDEX idx_conversations_org_status
  ON public.conversations(organization_id, status);
CREATE INDEX idx_conversations_customer
  ON public.conversations(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_conversations_assigned
  ON public.conversations(assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- ── updated_at trigger (function created in migration 011) ────────────────────

CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Cross-tenant integrity ──────────────────────────────────────────────────────
-- FKs only prove the referenced row exists. This trigger proves it belongs to
-- the SAME organization as the conversation — closing the IDOR gap even for a
-- service-role write that skipped application-layer checks.

CREATE OR REPLACE FUNCTION public.check_conversation_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = NEW.customer_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'cross_tenant_violation: conversation customer_id must belong to the same organization';
    END IF;
  END IF;

  IF NEW.workspace_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = NEW.workspace_id AND w.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'cross_tenant_violation: conversation workspace_id must belong to the same organization';
    END IF;
  END IF;

  IF NEW.assigned_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = NEW.assigned_user_id
        AND m.organization_id = NEW.organization_id
        AND m.status = 'active'
    ) THEN
      RAISE EXCEPTION 'cross_tenant_violation: assigned_user_id must be an active member of the organization';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.check_conversation_cross_tenant_refs();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_select_member"
  ON public.conversations FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "conversations_insert_member"
  ON public.conversations FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "conversations_update_member"
  ON public.conversations FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

-- Conversations are never hard-deleted (append-only operational history).
CREATE POLICY "conversations_no_delete"
  ON public.conversations FOR DELETE
  USING (false);
